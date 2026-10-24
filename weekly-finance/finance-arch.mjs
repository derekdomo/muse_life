// F-ARCH-001 synthetic calculation contract (see F-ARCH-001-SPEC.md).
// Pure functions over SYNTHETIC fixtures only — no real accounts, no
// production data, no writes. Defines: mixed-freshness net worth,
// single-stream spend (posted/pending split, two definitional
// exclusions, traceable refund offsets), FIRE complete-month gating,
// and the anomaly v0 candidate rule.
//
// PM 2026-10-23 22:06 fixes (CAL-1 / COV-1 / TXN-1 / ANOM-1):
// - FIRE eligibility is evaluated on a FIXED grid of the 12 ended
//   natural months before throughMonth; earlier months never backfill.
// - Coverage is one shared contract: only an explicit `true` counts as
//   complete; `false` (incomplete) and a missing/null key (unknown)
//   are recorded as different reasons everywhere (spend / FIRE /
//   anomaly all go through monthCoverage).
// - Spend first normalizes the transaction lifecycle by stable ID
//   (posted supersedes pending regardless of input order, identical
//   duplicates dedupe, conflicting duplicates are listed, never
//   silently picked), applies one asOf cutoff to spends AND refunds,
//   and only lets a refund offset an original that was actually
//   counted as spend; every other refund is listed, never dropped.
// - Anomaly compares REAL daily facts over the same day-of-month
//   window of the last 3 comparable complete months, with a daily
//   median computed from real daily values (real zero days count,
//   missing days are not zeros). There is no uniform-spreading
//   estimate path: without daily evidence the verdict is
//   "insufficient".

// ---------- Small date helpers (string months, no Date mutation) ----
function parseMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  return { y, m };
}
function formatMonth(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}
export function daysInMonth(year, month1to12) {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month1to12 === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return lengths[month1to12 - 1];
}
// The fixed 12-month grid: the 12 ended natural months immediately
// before throughMonth ("YYYY-MM"), ascending.
export function targetMonths12(throughMonth) {
  const { y, m } = parseMonth(throughMonth);
  const out = [];
  for (let back = 12; back >= 1; back--) {
    let mm = m - back;
    let yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    out.push(formatMonth(yy, mm));
  }
  return out;
}
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------- Coverage contract (COV-1) ----------
// Only coverageByMonth[month] === true is complete coverage. `false`
// means a source is known to be incomplete; a missing key / null /
// anything else means coverage is UNKNOWN. The three states are never
// conflated, and spend / FIRE / anomaly all use this one function.
export function monthCoverage(coverageByMonth, month) {
  if (!coverageByMonth || typeof coverageByMonth !== "object") return "unknown";
  const v = coverageByMonth[month];
  if (v === true) return "complete";
  if (v === false) return "incomplete";
  return "unknown";
}
function coverageStatusFromOptions(options, month) {
  if (options && typeof options.coverageStatus === "string") return options.coverageStatus;
  if (options && options.coverageByMonth !== undefined) return monthCoverage(options.coverageByMonth, month);
  if (options && options.coverage !== undefined) {
    return options.coverage === true ? "complete" : options.coverage === false ? "incomplete" : "unknown";
  }
  if (options && options.coverageOk !== undefined) {
    return options.coverageOk === true ? "complete" : options.coverageOk === false ? "incomplete" : "unknown";
  }
  return "unknown";
}

// ---------- Net worth: mixed-freshness latest-known total ----------
// accounts: [{ id, balance (signed; liabilities negative or flagged),
//   kind: "asset"|"liability", coverage: "plaid"|"snapshot"|"missing",
//   asOf: "YYYY-MM-DD"|null, readAt: iso|null }]
// Missing/unknown balances are NEVER counted as 0: they are listed in
// `missing` and excluded from the total, which is then flagged partial.
export function summarizeNetWorth(accounts) {
  const rows = [];
  const missing = [];
  let total = 0;
  for (const a of accounts) {
    if (a.coverage === "missing" || a.balance === null || a.balance === undefined) {
      missing.push(a.id);
      rows.push({ id: a.id, included: false, signed: null, asOf: a.asOf ?? null, readAt: a.readAt ?? null, coverage: a.coverage });
      continue;
    }
    const signed = a.kind === "liability" ? -Math.abs(a.balance) : a.balance;
    total += signed;
    rows.push({ id: a.id, included: true, signed, asOf: a.asOf ?? null, readAt: a.readAt ?? null, coverage: a.coverage });
  }
  const layerRange = (coverage) => {
    const dates = rows.filter((r) => r.included && r.coverage === coverage && r.asOf).map((r) => r.asOf).sort();
    return dates.length ? { oldest: dates[0], newest: dates[dates.length - 1] } : null;
  };
  return {
    label: "混合日期的最新已知净资产",
    total,
    partial: missing.length > 0,
    missing,
    plaidRange: layerRange("plaid"),
    snapshotRange: layerRange("snapshot"),
    rows,
  };
}

// ---------- Single spend stream (TXN-1 + COV-1) ----------
// txns: [{ id, date "YYYY-MM-DD", amount (signed, outflow negative),
//   status: "posted"|"pending",
//   kind: "spend"|"transfer"|"loan_principal"|"refund"|"loan_mixed"|"unmatched_transfer",
//   refundOf?: txnId (for kind "refund") }]
// Only two definitional exclusions: own-account transfers and loan
// principal. Refunds offset in the ORIGINAL transaction's month via a
// traceable pair, never by deleting the original spend. Unclassifiable
// rows stay visible in `unclassified` and make the month incomplete.
//
// options: { asOf?: "YYYY-MM-DD", coverageByMonth?, coverage?,
//   coverageStatus? }
// - asOf: rows (spends AND refunds) dated after asOf are not counted
//   at all — and do not count as unclassified either.
// - The function is pure: inputs are never mutated.
export function summarizeSpendMonth(txns, month, options = {}) {
  if (typeof options === "string") options = { asOf: options };
  options = options ?? {};
  const asOf = options.asOf ?? options.asOfDate ?? null;
  const afterAsOf = (row) => asOf !== null && row.date > asOf;
  const coverageStatus = coverageStatusFromOptions(options, month);

  // Lifecycle normalization by stable ID, before anything is counted:
  // identical duplicates dedupe; a posted row supersedes a pending
  // row for the same ID regardless of input order; distinct rows with
  // the same ID AND the same status but different amount/kind/date
  // are a conflict — listed in `conflicts`, excluded from every sum
  // (never resolved by picking one), and the month is incomplete.
  const groups = new Map();
  for (const t of txns) {
    if (!groups.has(t.id)) groups.set(t.id, []);
    groups.get(t.id).push(t);
  }
  const canonical = new Map();
  const conflicts = [];
  for (const [id, rows] of groups) {
    const seenKeys = new Set();
    const uniq = [];
    for (const r of rows) {
      const key = JSON.stringify([r.date, r.amount, r.status, r.kind, r.refundOf ?? null]);
      if (!seenKeys.has(key)) { seenKeys.add(key); uniq.push(r); }
    }
    const byStatus = new Map();
    for (const r of uniq) {
      if (!byStatus.has(r.status)) byStatus.set(r.status, []);
      byStatus.get(r.status).push(r);
    }
    let hasConflict = false;
    for (const sameStatus of byStatus.values()) if (sameStatus.length > 1) hasConflict = true;
    if (hasConflict) {
      conflicts.push({ id, reason: "conflicting-duplicates" });
      continue;
    }
    canonical.set(id, byStatus.get("posted")?.[0] ?? byStatus.get("pending")?.[0] ?? uniq[0]);
  }
  const conflictIds = new Set(conflicts.map((c) => c.id));

  let postedSpend = 0;
  let pendingSpend = 0;
  const unclassified = [];
  const countedSpend = new Map(); // id -> remaining refundable amount
  for (const [id, row] of canonical) {
    if (row.kind === "refund") continue;
    if (afterAsOf(row)) continue;
    if (!row.date.startsWith(month)) continue;
    if (row.kind === "transfer" || row.kind === "loan_principal") continue; // the two exclusions
    if (row.kind === "spend") {
      const amt = Math.abs(row.amount);
      if (row.status === "pending") pendingSpend += amt;
      else { postedSpend += amt; countedSpend.set(id, amt); }
    } else {
      // loan_mixed / unmatched_transfer / any unknown kind: visible,
      // never silently excluded.
      unclassified.push(id);
    }
  }

  // Refunds: a refund belongs to its ORIGINAL transaction's month.
  // It offsets only when the original exists, was counted above as
  // posted spend (kind "spend", in this month, not excluded, not
  // conflicted, not after asOf), and the refund itself is posted and
  // not after asOf. Anything else that belongs to this month is
  // listed in `unappliedRefunds` and makes the month incomplete —
  // it never silently disappears and never drives spend negative.
  // Multiple partial refunds pair per original in date order and the
  // applied chain is preserved in `offsets`; any excess over the
  // original amount is listed as unapplied, not over-offset.
  const refundRows = [...canonical.values()]
    .filter((r) => r.kind === "refund")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offsets = [];
  const unappliedRefunds = [];
  for (const r of refundRows) {
    if (afterAsOf(r)) continue; // future refund: not counted at all
    const orig = r.refundOf != null ? canonical.get(r.refundOf) : undefined;
    const belongingMonth = orig ? orig.date.slice(0, 7) : r.date.slice(0, 7);
    if (belongingMonth !== month) continue; // judged in the original's month
    const amt = Math.abs(r.amount);
    if (r.status !== "posted") continue; // pending refund has not landed yet
    if (!orig) { unappliedRefunds.push({ refundId: r.id, of: r.refundOf ?? null, amount: amt, reason: "original-missing" }); continue; }
    if (conflictIds.has(orig.id)) { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-conflicted" }); continue; }
    if (orig.kind !== "spend") { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-not-spend" }); continue; }
    if (afterAsOf(orig)) { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-after-asof" }); continue; }
    if (orig.status !== "posted") { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-pending" }); continue; }
    const remaining = countedSpend.get(orig.id);
    if (remaining === undefined) { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-not-counted" }); continue; }
    const applied = Math.min(amt, remaining);
    if (applied > 0) {
      postedSpend -= applied;
      countedSpend.set(orig.id, remaining - applied);
      offsets.push({ refundId: r.id, of: orig.id, amount: applied, month });
    }
    if (amt > applied) {
      unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt - applied, reason: "exceeds-original" });
    }
  }

  // Completeness has two separately reported dimensions; the legacy
  // `complete` field is exactly their AND.
  // - classificationComplete: no unclassified rows, no conflicting
  //   duplicates, no unapplied refunds in this month.
  // - coverage: monthCoverage(...) === "complete". When coverage is
  //   not complete the amounts are only a stored subtotal, never a
  //   proven real zero / full total.
  const classificationComplete = unclassified.length === 0 && conflicts.length === 0 && unappliedRefunds.length === 0;
  const coverageComplete = coverageStatus === "complete";
  return {
    month,
    postedSpend,
    pendingSpend,
    unclassified,
    offsets,
    conflicts,
    unappliedRefunds,
    classificationComplete,
    coverageStatus,
    coverageComplete,
    amountBasis: coverageComplete ? "actual" : "stored-subtotal",
    complete: classificationComplete && coverageComplete,
  };
}

// ---------- FIRE eligibility (CAL-1) ----------
// Evaluated on the FIXED grid of the 12 ended natural months before
// throughMonth. Summaries are normalized by month: duplicate rows for
// the same month with identical values dedupe; duplicate rows with
// conflicting values mark that grid cell as a conflict (never picked
// arbitrarily). Months outside the grid — earlier months, the current
// partial month, future months — never enter eligible or missing and
// never backfill a gap. `missing` stays a plain month list (legacy
// shape); `missingDetails` gives the per-cell reasons: missing-row /
// incomplete / conflict / coverage-incomplete / coverage-unknown.
export function fireEligibleMonths(monthSummaries, coverageByMonth, throughMonth) {
  const targets = targetMonths12(throughMonth);
  const targetSet = new Set(targets);
  const byMonth = new Map();
  for (const s of monthSummaries ?? []) {
    if (!targetSet.has(s.month)) continue;
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }
  const eligible = [];
  const missing = [];
  const missingDetails = [];
  for (const m of targets) {
    const cov = monthCoverage(coverageByMonth, m);
    const covReasons = cov === "incomplete" ? ["coverage-incomplete"] : cov === "unknown" ? ["coverage-unknown"] : [];
    const rows = byMonth.get(m) ?? [];
    if (rows.length === 0) {
      missing.push(m);
      missingDetails.push({ month: m, reasons: ["missing-row", ...covReasons] });
      continue;
    }
    const signatures = new Set(rows.map((r) => JSON.stringify([
      r.complete ?? null, r.classificationComplete ?? null, r.spend ?? null, r.postedSpend ?? null,
    ])));
    if (signatures.size > 1) {
      missing.push(m);
      missingDetails.push({ month: m, reasons: ["conflict", ...covReasons] });
      continue;
    }
    const r = rows[0];
    const summaryComplete = r.complete === true && (r.classificationComplete === undefined || r.classificationComplete === true);
    const reasons = [...(summaryComplete ? [] : ["incomplete"]), ...covReasons];
    if (reasons.length > 0) {
      missing.push(m);
      missingDetails.push({ month: m, reasons });
    } else {
      eligible.push(m);
    }
  }
  eligible.sort();
  return { eligible, complete12: eligible.length === 12, missing, missingDetails, targetMonths: targets };
}

// ---------- Anomaly v0 (candidate thresholds, NOT adopted) ----------
// Signature (ANOM-1): anomalyV0({ baselineDaily, currentDaily, month,
//   asOfDate, coverageStatus })
// - baselineDaily: [{ month, daily: [day1, day2, ...], complete?,
//     coverageStatus? }] or a { "YYYY-MM": [daily...] } record. A
//     daily entry is a number (a real 0 counts) or null/undefined for
//     a MISSING day — missing is not zero and makes that month
//     non-comparable for any window covering the gap.
// - currentDaily: [day1, ...] (or { daily: [...] }).
// - comparisonKind comes from the REAL number of days in the asOf
//   month: "month-end" only when asOfDate is that month's last day
//   (28/29/30/31 handled), otherwise "mid-month-progress".
// - Baseline: the most recent 3 comparable complete months. Each
//   contributes the cumulative spend of its own same-day window
//   (days 1..asOf day-of-month; for a month-end reading, its full
//   month). The baseline figure is the median of those 3 window
//   sums; the daily median is the median of the pooled REAL daily
//   values inside those windows.
// - No daily evidence, fewer than 3 comparable months, a zero
//   baseline, a missing day in the current window, or coverage that
//   is not "complete" -> verdict "insufficient" with a reason. There
//   is deliberately NO uniform-spreading path (no median*(days/30),
//   no median/30): estimates are never dressed up as daily facts.
// - Candidate rule (thresholds NOT adopted, kept for discussion
//   only): fires when relative deviation > 30% AND absolute
//   deviation > dailyMedian * 7.
// Legacy callers that pass only monthly totals ({ baselineMonths:
// [{ spend }], currentToDate, currentElapsedDays, coverageOk }) are
// still accepted at the boundary, but monthly totals carry no daily
// evidence, so they now return "insufficient" (缺逐日证据) instead
// of the old spread estimate. buildArchPreview and the validation
// script have been migrated to the daily signature.
function normalizeDaily(daily) {
  if (!Array.isArray(daily)) return null;
  return daily.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "object") {
      const n = v.spend ?? v.amount ?? null;
      return typeof n === "number" && Number.isFinite(n) ? n : null;
    }
    return null;
  });
}
function normalizeBaselineDaily(input) {
  const raw = input.baselineDaily ?? input.dailyByMonth ?? null;
  if (Array.isArray(raw)) {
    return raw.map((e) => ({
      month: e.month ?? null,
      daily: normalizeDaily(e.daily ?? e.days ?? e.values),
      complete: e.complete,
      coverageStatus: e.coverageStatus,
    }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([month, daily]) => ({
      month,
      daily: normalizeDaily(Array.isArray(daily) ? daily : daily?.daily),
      complete: undefined,
      coverageStatus: undefined,
    }));
  }
  if (Array.isArray(input.baselineMonths)) {
    // Legacy monthly-total entries only become daily entries when
    // they actually carry daily data.
    return input.baselineMonths
      .filter((e) => e && (e.daily || e.days || e.values))
      .map((e) => ({
        month: e.month ?? null,
        daily: normalizeDaily(e.daily ?? e.days ?? e.values),
        complete: e.complete,
        coverageStatus: e.coverageStatus,
      }));
  }
  return [];
}
function windowSum(daily, requiredDays) {
  if (!daily || daily.length < requiredDays) return null;
  let sum = 0;
  const values = [];
  for (let i = 0; i < requiredDays; i++) {
    if (daily[i] === null || daily[i] === undefined) return null;
    sum += daily[i];
    values.push(daily[i]);
  }
  return { sum, values };
}
export function anomalyV0(input) {
  const month = input.month ?? (input.asOfDate ? input.asOfDate.slice(0, 7) : null);
  const asOfDate = input.asOfDate ?? null;
  let asOfDay = null;
  let dim = null;
  if (asOfDate) {
    const [y, m, d] = asOfDate.split("-").map(Number);
    asOfDay = d;
    dim = daysInMonth(y, m);
  } else if (month) {
    const { y, m } = parseMonth(month);
    dim = daysInMonth(y, m);
    asOfDay = typeof input.currentElapsedDays === "number" ? input.currentElapsedDays : dim;
  }
  const comparisonKind = dim !== null && asOfDay === dim ? "month-end" : "mid-month-progress";
  const insufficient = (reason) => ({ verdict: "insufficient", reason, comparisonKind });

  // Coverage: one shared contract. An explicit coverageStatus wins;
  // legacy coverageOk true/false maps onto complete/incomplete; no
  // coverage information at all is unknown — and anything that is
  // not "complete" forbids a verdict.
  let coverageStatus = input.coverageStatus ?? null;
  if (coverageStatus === null && input.coverageByMonth !== undefined && month) {
    coverageStatus = monthCoverage(input.coverageByMonth, month);
  }
  if (coverageStatus === null && input.coverageOk !== undefined) {
    coverageStatus = input.coverageOk === true ? "complete" : input.coverageOk === false ? "incomplete" : "unknown";
  }
  if (coverageStatus === null && input.coverage !== undefined) {
    coverageStatus = input.coverage === true ? "complete" : input.coverage === false ? "incomplete" : "unknown";
  }
  if (coverageStatus !== "complete") {
    return insufficient(coverageStatus === "incomplete" ? "coverage 不完整" : "coverage 未知");
  }
  if (asOfDay === null || dim === null) return insufficient("缺 asOf 日期，无法确定同日窗");

  // Current month daily facts.
  const currentDaily = normalizeDaily(
    Array.isArray(input.currentDaily) ? input.currentDaily : input.currentDaily?.daily,
  );
  if (!currentDaily) return insufficient("缺逐日证据（当前月）");
  const currentWindow = windowSum(currentDaily, asOfDay);
  if (!currentWindow) return insufficient("当前月同日窗内有缺日");
  const currentToDate = currentWindow.sum;

  // Baseline: most recent 3 comparable complete months.
  const entries = normalizeBaselineDaily(input)
    .filter((e) => e.daily && e.complete !== false && e.coverageStatus !== "incomplete" && e.coverageStatus !== "unknown")
    .sort((a, b) => (String(b.month ?? "")).localeCompare(String(a.month ?? "")));
  const comparable = [];
  for (const e of entries) {
    if (comparable.length >= 3) break;
    let required = asOfDay;
    if (comparisonKind === "month-end" && e.month) {
      const { y, m } = parseMonth(e.month);
      required = daysInMonth(y, m);
    }
    const w = windowSum(e.daily, required);
    if (!w) continue; // missing day / truncated month: not comparable
    comparable.push({ month: e.month, window: w });
  }
  if (comparable.length < 3) return insufficient("可比完整月少于 3 个（缺逐日证据或同日窗内有缺日）");
  const baselineWindow = medianOf(comparable.map((c) => c.window.sum));
  if (baselineWindow === 0) return insufficient("基准为 0");
  const dailyMedian = medianOf(comparable.flatMap((c) => c.window.values));
  const absDev = Math.abs(currentToDate - baselineWindow);
  const relDev = absDev / baselineWindow;
  const fires = relDev > 0.30 && absDev > dailyMedian * 7;
  return {
    verdict: fires ? "anomaly" : "normal",
    comparisonKind,
    median: baselineWindow,
    baselineWindow,
    dailyMedian,
    medianDaily: dailyMedian,
    currentToDate,
    comparableMonths: comparable.map((c) => c.month),
    absDev,
    relDev,
    thresholds: { rel: 0.30, absFloor: dailyMedian * 7 },
  };
}

// ---------- Synthetic preview: the first-slice card model ----------
// Composes the three contracts above into exactly the card model the
// 2026-10-25 calculation/presentation slice will render, over purely
// synthetic input. This is a preview contract, not production data:
// no account is read and nothing is written anywhere.
// input: { accounts, txns, currentMonth, asOfDate, monthSummaries,
//   coverageByMonth, baselineDaily, currentDaily }
// (baselineDaily / currentDaily are the逐日事实 the anomaly contract
// consumes; without them the anomaly card is "insufficient".)
export function buildArchPreview(input) {
  const netWorth = summarizeNetWorth(input.accounts);
  const spend = summarizeSpendMonth(input.txns, input.currentMonth, {
    asOf: input.asOfDate,
    coverageByMonth: input.coverageByMonth,
  });
  const fire = fireEligibleMonths(input.monthSummaries, input.coverageByMonth, input.currentMonth);
  const covStatus = monthCoverage(input.coverageByMonth, input.currentMonth);
  const anomaly = anomalyV0({
    baselineDaily: input.baselineDaily,
    currentDaily: input.currentDaily,
    month: input.currentMonth,
    asOfDate: input.asOfDate,
    // The anomaly verdict needs source coverage AND a fully
    // classified spend stream; a classification gap downgrades the
    // shared coverage status to incomplete for this card.
    coverageStatus: covStatus !== "complete" ? covStatus : spend.classificationComplete ? "complete" : "incomplete",
  });
  return {
    // Main card: mixed-date latest-known total, two freshness layers
    // and the missing list stay separate — never one "live" number.
    netWorthCard: {
      label: netWorth.label,
      total: netWorth.total,
      partial: netWorth.partial,
      missing: netWorth.missing,
      plaidRange: netWorth.plaidRange,
      snapshotRange: netWorth.snapshotRange,
      rows: netWorth.rows,
    },
    // Daily spend replaces any fixed/flexible pair with three lines:
    // posted so far / pending not yet counted / coverage gaps. The gap
    // line reports classification and coverage as separate dimensions.
    spendCard: {
      title: `本月花销（截至 ${input.asOfDate}）`,
      lines: [
        { key: "posted", label: "已发生 spend", amount: spend.postedSpend, amountBasis: spend.amountBasis },
        { key: "pending", label: "待入账交易（未计入已发生）", amount: spend.pendingSpend },
        {
          key: "gap", label: "覆盖缺口", amount: null,
          unclassified: spend.unclassified, complete: spend.complete,
          classificationComplete: spend.classificationComplete, coverageStatus: spend.coverageStatus,
        },
      ],
      offsets: spend.offsets,
      conflicts: spend.conflicts,
      unappliedRefunds: spend.unappliedRefunds,
      coverageStatus: spend.coverageStatus,
      classificationComplete: spend.classificationComplete,
    },
    fireCard: {
      eligibleMonths: fire.eligible,
      complete12: fire.complete12,
      missingMonths: fire.missing,
      missingDetails: fire.missingDetails,
      note: fire.complete12 ? "近 12 个完整月同口径" : "完整月不足 12 个，缺月如实列出、不补数",
    },
    anomalyCard: anomaly,
  };
}
