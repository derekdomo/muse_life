// F-ARCH-001 synthetic calculation contract (see F-ARCH-001-SPEC.md).
// Pure functions over SYNTHETIC fixtures only — no real accounts, no
// production data, no writes. Defines: mixed-freshness net worth,
// single-stream spend (lifecycle-normalized, posted/pending split, two
// definitional exclusions, traceable refund offsets, unified as-of
// cutoff, explicit coverage contract), FIRE fixed 12-month grid
// gating, and the anomaly v0 candidate rule over real daily facts.

// ---------- Coverage contract (COV-1) ----------
// One contract shared by spend, FIRE and anomaly: a month's source
// coverage is "complete" ONLY when coverageByMonth[month] === true
// (explicit, with the caller's date/account/window evidence behind
// it). false is "incomplete"; a missing key, null, or any other value
// is "unknown". Unknown is never silently treated as complete, and
// amounts under non-complete coverage are stored subtotals, never a
// proven real zero.
export function monthCoverage(coverageByMonth, month) {
  const v = coverageByMonth ? coverageByMonth[month] : undefined;
  if (v === true) return { status: "complete", reason: null };
  if (v === false) return { status: "incomplete", reason: "来源覆盖标记为不完整" };
  return { status: "unknown", reason: "覆盖未知（无明确完整标记）" };
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
// principal. Lifecycle normalization happens BEFORE any summing and
// is input-order independent:
//   - exact duplicate rows (same id + full tuple) dedupe;
//   - a posted row supersedes a pending twin of the same id with the
//     same amount/kind/date (the transaction matured) — either order;
//   - any other same-id disagreement is a CONFLICT: listed, counted
//     as nothing, and the month is incomplete (never pick one side).
// Refunds offset only an original that is actually in the spend
// stream (kind "spend", counted, inside the as-of cutoff); the offset
// lands in the ORIGINAL transaction's month, traceable via `offsets`.
// A refund whose original is missing from the sample, excluded, of a
// non-spend kind, or beyond the cutoff is listed in
// `unappliedRefunds` and makes the month incomplete — it never
// silently vanishes and never drives spend negative on its own.
// opts.asOf ("YYYY-MM-DD") is a unified cutoff: transactions AND
// refunds dated after it are excluded entirely, not just relabeled.
// opts.coverageByMonth feeds the shared coverage contract above;
// `complete` requires classification-complete AND no conflicts AND
// no unapplied refunds AND coverage explicitly complete. Pure: the
// input rows are never mutated.
export function summarizeSpendMonth(txns, month, opts = {}) {
  const asOf = opts.asOf ?? null;
  const coverage = monthCoverage(opts.coverageByMonth, month);
  const inMonth = (d) => d.startsWith(month);
  const withinCutoff = (d) => asOf === null || d <= asOf;

  // Lifecycle normalization: group by id, dedupe exact tuples,
  // resolve posted-over-pending, flag the rest as conflicts.
  const groups = new Map();
  for (const t of txns) {
    if (!groups.has(t.id)) groups.set(t.id, []);
    groups.get(t.id).push(t);
  }
  const normalized = new Map(); // id -> the one authoritative row
  const conflicts = [];
  for (const [id, rows] of groups) {
    const seenTuples = new Set();
    const unique = [];
    for (const r of rows) {
      const tuple = JSON.stringify([r.date, r.amount, r.status, r.kind, r.refundOf ?? null]);
      if (seenTuples.has(tuple)) continue;
      seenTuples.add(tuple);
      unique.push(r);
    }
    if (unique.length === 1) { normalized.set(id, unique[0]); continue; }
    if (unique.length === 2) {
      const posted = unique.find((r) => r.status === "posted");
      const pending = unique.find((r) => r.status === "pending");
      if (posted && pending && posted.amount === pending.amount && posted.kind === pending.kind && posted.date === pending.date) {
        normalized.set(id, posted);
        continue;
      }
    }
    conflicts.push(id);
  }

  let postedSpend = 0;
  let pendingSpend = 0;
  const unclassified = [];
  const offsets = [];
  const unappliedRefunds = [];

  for (const t of normalized.values()) {
    if (t.kind === "refund") {
      if (!withinCutoff(t.date)) continue; // beyond the as-of view entirely
      const orig = normalized.get(t.refundOf);
      if (!orig) { unappliedRefunds.push(t.id); continue; } // original not in the sample (or conflicted away)
      if (orig.date.slice(0, 7) !== month) continue; // judged in the original month's own summary
      if (orig.kind !== "spend" || !withinCutoff(orig.date)) { unappliedRefunds.push(t.id); continue; }
      if (t.status === "posted" && orig.status === "posted") {
        postedSpend -= Math.abs(t.amount);
        offsets.push({ refundId: t.id, of: t.refundOf, amount: Math.abs(t.amount), month });
      }
      continue;
    }
    if (!inMonth(t.date)) continue;
    if (!withinCutoff(t.date)) continue;
    if (t.kind === "transfer" || t.kind === "loan_principal") continue; // the two exclusions
    if (t.kind === "loan_mixed" || t.kind === "unmatched_transfer") { unclassified.push(t.id); continue; }
    if (t.kind === "spend") {
      if (t.status === "pending") pendingSpend += Math.abs(t.amount);
      else postedSpend += Math.abs(t.amount);
    }
  }
  const classificationComplete = unclassified.length === 0;
  const complete = classificationComplete && conflicts.length === 0 && unappliedRefunds.length === 0 && coverage.status === "complete";
  return {
    month,
    postedSpend,
    pendingSpend,
    unclassified,
    offsets,
    unappliedRefunds,
    conflicts,
    classificationComplete,
    coverageStatus: coverage.status,
    coverageReason: coverage.reason,
    amountBasis: coverage.status === "complete" ? "complete" : "stored-subtotal",
    complete,
  };
}

// ---------- FIRE fixed 12-month grid (CAL-1) ----------
// The grid is the 12 natural months immediately before throughMonth
// (throughMonth itself is the current, partial month and is never in
// the grid). Earlier months can NEVER backfill a gap. Summaries are
// normalized by month: duplicate rows with the same completeness
// collapse; conflicting duplicates mark the month as a conflict.
// Every grid month is accounted for: eligible, or listed in `missing`
// with a reason (missing-row / incomplete / conflict /
// coverage-incomplete / coverage-unknown). complete12 is true only
// when all 12 unique grid months are eligible.
function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

export function fireEligibleMonths(monthSummaries, coverageByMonth, throughMonth) {
  const grid = [];
  for (let i = 12; i >= 1; i--) grid.push(shiftMonth(throughMonth, -i));
  const byMonth = new Map();
  const conflicted = new Set();
  for (const s of monthSummaries ?? []) {
    if (!byMonth.has(s.month)) { byMonth.set(s.month, s); continue; }
    if (byMonth.get(s.month).complete !== s.complete) conflicted.add(s.month);
  }
  const eligible = [];
  const missing = [];
  const missingDetail = [];
  for (const m of grid) {
    const coverage = monthCoverage(coverageByMonth, m);
    let reason = null;
    if (conflicted.has(m)) reason = "conflict";
    else if (!byMonth.has(m)) reason = "missing-row";
    else if (!byMonth.get(m).complete) reason = "incomplete";
    else if (coverage.status === "incomplete") reason = "coverage-incomplete";
    else if (coverage.status !== "complete") reason = "coverage-unknown";
    if (reason) { missing.push(m); missingDetail.push({ month: m, reason }); }
    else eligible.push(m);
  }
  return { eligible, complete12: eligible.length === 12, missing, missingDetail, grid };
}

// ---------- Anomaly v0 (candidate thresholds, NOT adopted) (ANOM-1) ----------
// Facts, not estimates: baseline months and the current month arrive
// as DAILY spend arrays (index 0 = day 1; a real zero day is 0; a
// missing day is null/absent and is NOT a zero). The current month is
// compared against the SAME elapsed-days window of the last 3
// comparable complete baseline months; the absolute floor uses the
// median of the baselines' real daily values (zero days included).
// Month-end is decided by the month's actual day count: only an
// as-of date on the month's last day is a month-end comparison.
// Uniform spreading (monthly total / days) is never used as a fact.
// Insufficient evidence — fewer than 3 comparable months, a missing
// day inside any compared window, non-complete coverage, or a zero
// baseline — yields "insufficient" with a reason, never a verdict.
function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// A daily array covers a window of `elapsed` days only when every one
// of those days is a real number (zero allowed, gaps are not).
function windowSum(daily, elapsed) {
  if (!Array.isArray(daily) || daily.length < elapsed) return null;
  let sum = 0;
  for (let i = 0; i < elapsed; i++) {
    if (typeof daily[i] !== "number" || Number.isNaN(daily[i])) return null;
    sum += daily[i];
  }
  return sum;
}

export function anomalyV0({ month, asOfDate, baselineDaily, currentDaily, coverageStatus }) {
  const dim = daysInMonth(month);
  const elapsed = Number(asOfDate.slice(8, 10));
  const comparisonKind = elapsed >= dim ? "month-end" : "mid-month-progress";
  if (coverageStatus !== "complete") return { verdict: "insufficient", reason: "覆盖未完整", comparisonKind };
  const currentWindow = windowSum(currentDaily, elapsed);
  if (currentWindow === null) return { verdict: "insufficient", reason: "当前月逐日事实缺日", comparisonKind };
  const comparable = [];
  const sortedBaseline = [...(baselineDaily ?? [])].sort((a, b) => b.month.localeCompare(a.month));
  for (const b of sortedBaseline) {
    if (comparable.length >= 3) break;
    if (b.coverage !== "complete" && b.coverageStatus !== "complete") continue;
    // A comparable month must carry its full month of daily facts so
    // the daily median is a fact too, and its same-window sum must be
    // computable without gaps.
    if (!Array.isArray(b.daily) || b.daily.length < daysInMonth(b.month)) continue;
    if (b.daily.some((v) => typeof v !== "number" || Number.isNaN(v))) continue;
    const w = windowSum(b.daily, elapsed);
    if (w === null) continue;
    comparable.push({ month: b.month, window: w, daily: b.daily });
  }
  if (comparable.length < 3) return { verdict: "insufficient", reason: "可比完整月少于 3 个", comparisonKind };
  const baselineWindow = medianOf(comparable.map((c) => c.window));
  if (baselineWindow === 0) return { verdict: "insufficient", reason: "基准为 0", comparisonKind };
  const dailyMedian = medianOf(comparable.flatMap((c) => c.daily.slice(0, elapsed)));
  const absDev = Math.abs(currentWindow - baselineWindow);
  const relDev = absDev / baselineWindow;
  const fires = relDev > 0.30 && absDev > dailyMedian * 7;
  return {
    verdict: fires ? "anomaly" : "normal",
    comparisonKind,
    comparableMonths: comparable.map((c) => c.month),
    baselineWindow,
    currentWindow,
    dailyMedian,
    absDev,
    relDev,
    thresholds: { rel: 0.30, absFloor: dailyMedian * 7 },
  };
}

// ---------- Synthetic preview: the first-slice card model ----------
// Composes the contracts above into exactly the card model the
// 2026-10-25 calculation/presentation slice will render, over purely
// synthetic input. This is a preview contract, not production data:
// no account is read and nothing is written anywhere.
// input: { accounts, txns, currentMonth, asOfDate, monthSummaries,
//   coverageByMonth, baselineDaily, currentDaily }
export function buildArchPreview(input) {
  const netWorth = summarizeNetWorth(input.accounts);
  const spend = summarizeSpendMonth(input.txns, input.currentMonth, { asOf: input.asOfDate, coverageByMonth: input.coverageByMonth });
  const fire = fireEligibleMonths(input.monthSummaries, input.coverageByMonth, input.currentMonth);
  const anomaly = anomalyV0({
    month: input.currentMonth,
    asOfDate: input.asOfDate,
    baselineDaily: input.baselineDaily,
    currentDaily: input.currentDaily,
    coverageStatus: monthCoverage(input.coverageByMonth, input.currentMonth).status,
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
    // line names its completeness basis explicitly: fully covered,
    // partially covered, or unknown — a stored subtotal is visually
    // distinct from a proven real zero.
    spendCard: {
      title: `本月花销（截至 ${input.asOfDate}）`,
      lines: [
        { key: "posted", label: "已发生 spend", amount: spend.postedSpend, amountBasis: spend.amountBasis },
        { key: "pending", label: "待入账交易（未计入已发生）", amount: spend.pendingSpend },
        { key: "gap", label: "覆盖缺口", amount: null, unclassified: spend.unclassified, unappliedRefunds: spend.unappliedRefunds, conflicts: spend.conflicts, coverageStatus: spend.coverageStatus, complete: spend.complete },
      ],
      offsets: spend.offsets,
    },
    fireCard: {
      eligibleMonths: fire.eligible,
      complete12: fire.complete12,
      missingMonths: fire.missing,
      missingDetail: fire.missingDetail,
      grid: fire.grid,
      note: fire.complete12 ? "近 12 个完整月同口径" : "完整月不足 12 个，缺月如实列出、不补数",
    },
    anomalyCard: anomaly,
  };
}
