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
//
// PM 2026-10-24 01:07 fixes (TXN-1 asOf/scope remainder, ANOM-1
// baseline identity/coverage remainder):
// - Spend determines the candidate set from asOf FIRST and only then
//   arbitrates the lifecycle: a row dated after asOf does not yet
//   exist in that view, so a future posted row cannot erase a
//   pending row that was the latest known state at the cutoff, and
//   a future same-status twin cannot turn a settled past row into
//   a conflict. Conflicts are scoped: a conflict group is reported
//   for a month only when its rows belong to that month or a refund
//   dated in that month depends on the conflicted ID; an unrelated
//   month's conflict never makes this month incomplete. Views are
//   honestly labelled as transaction-date cutoffs: with no source
//   observation timestamps the function does NOT claim to rebuild
//   what a source knew at the cutoff, only what is dated by it.
// - Anomaly baselines are normalized by month identity before any
//   picking: identical duplicate months dedupe to one, conflicting
//   duplicates disqualify that month, only months strictly before
//   the asOf month are eligible, and each eligible month needs its
//   OWN explicit complete coverage (per-entry fields or the
//   coverageByMonth entry for that month; conflicting explicit
//   signals disqualify the month) — the current month's coverage
//   never substitutes for a baseline month's. The result names the
//   adopted baseline months with their coverage, and an
//   "insufficient" verdict names why months were rejected.
//
// PM 2026-10-24 07:05 fix (TXN-1 refund-diagnosis scope remainder):
// - The unapplied-refund diagnosis follows the same candidate scope:
//   when the original has ANY asOf candidate rows, the refund is
//   judged in the CANDIDATE month(s) only — a future row's month in
//   the full-set index can no longer pull a past month's refund
//   diagnosis into the cutoff month. The full-set index is used only
//   when the original has no candidate at all (truly absent, or
//   dated entirely after asOf) for that honest diagnosis.
//
// PM 2026-10-24 04:01 fixes (TXN-1 future-metadata scope, ANOM-1
// coverage transmission):
// - Conflict attribution uses ONLY the asOf candidate set's months
//   (plus real in-cutoff refund dependencies). The full-set index
//   survives solely as a diagnosis aid for refunds whose original
//   row has no candidate; a future row's month in that index can
//   no longer pull an unrelated past conflict into this month.
// - Anomaly coverage is end-to-end: normalization preserves the
//   entry `coverage` field, buildArchPreview forwards the per-month
//   coverage map into anomalyV0, and a baseline month with NO
//   coverage signal of its own is "unknown" — the call-level /
//   current month's complete status is never inherited. An entry's
//   own explicit signal is sufficient evidence on its own (a map
//   key that is merely absent/null adds no signal and does not
//   contradict it); an explicit map `false` does contradict an
//   entry `complete: true` and disqualifies the month.

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

  // Candidate set FIRST, lifecycle arbitration SECOND (TXN-1 01:07):
  // rows dated after asOf are not candidates at all — at the cutoff
  // they do not exist yet, so they can neither supersede a pending
  // row that was the latest dated state nor conflict with a settled
  // past row. Within the candidate set: identical duplicates dedupe;
  // a posted row supersedes a pending row for the same ID regardless
  // of input order; distinct rows with the same ID AND the same
  // status but different amount/kind/date are a conflict — excluded
  // from every sum (never resolved by picking one). A conflict is
  // REPORTED for this month (and makes it incomplete) only when it
  // is in scope: its rows belong to this month, or a refund dated in
  // this month depends on the conflicted ID. The full (unfiltered)
  // grouping is kept only to judge refunds whose original row is a
  // future or conflicted row.
  const groups = new Map();
  for (const t of txns) {
    if (afterAsOf(t)) continue;
    if (!groups.has(t.id)) groups.set(t.id, []);
    groups.get(t.id).push(t);
  }
  const allMonthsById = new Map(); // id -> Set of row months (all rows; diagnosis only)
  for (const t of txns) {
    if (!allMonthsById.has(t.id)) allMonthsById.set(t.id, new Set());
    allMonthsById.get(t.id).add(t.date.slice(0, 7));
  }
  const candidateMonthsById = new Map(); // id -> Set of row months (asOf candidates only)
  for (const t of txns) {
    if (afterAsOf(t)) continue;
    if (!candidateMonthsById.has(t.id)) candidateMonthsById.set(t.id, new Set());
    candidateMonthsById.get(t.id).add(t.date.slice(0, 7));
  }
  const refundMonthsByOriginal = new Map(); // original id -> Set of refund months (candidate refunds)
  for (const t of txns) {
    if (t.kind !== "refund" || t.refundOf == null || afterAsOf(t)) continue;
    if (!refundMonthsByOriginal.has(t.refundOf)) refundMonthsByOriginal.set(t.refundOf, new Set());
    refundMonthsByOriginal.get(t.refundOf).add(t.date.slice(0, 7));
  }
  const canonical = new Map();
  const allConflicts = [];
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
      allConflicts.push({ id, reason: "conflicting-duplicates" });
      continue;
    }
    canonical.set(id, byStatus.get("posted")?.[0] ?? byStatus.get("pending")?.[0] ?? uniq[0]);
  }
  const conflicts = allConflicts.filter((c) =>
    (candidateMonthsById.get(c.id)?.has(month) ?? false) ||
    (refundMonthsByOriginal.get(c.id)?.has(month) ?? false));
  const conflictIds = new Set(allConflicts.map((c) => c.id));

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
    const amt = Math.abs(r.amount);
    if (r.status !== "posted") continue; // pending refund has not landed yet
    if (!orig) {
      // The original has no canonical candidate row: it is either
      // conflicted, dated entirely after asOf, or truly absent. The
      // refund is judged in the ORIGINAL's month(s); a refund whose
      // original belongs to another month is not this month's gap.
      // Scope (TXN-1 07:05): when the original has candidate rows,
      // ONLY their months judge the refund — the full-set index
      // (which includes future rows) must not attribute this refund
      // to a future row's month. The full-set index is consulted
      // only when there is no candidate at all.
      const candidateMonths = r.refundOf != null ? candidateMonthsById.get(r.refundOf) : undefined;
      if (candidateMonths && candidateMonths.size > 0) {
        if (!candidateMonths.has(month)) continue;
        unappliedRefunds.push({ refundId: r.id, of: r.refundOf ?? null, amount: amt, reason: "original-conflicted" });
        continue;
      }
      const origMonths = r.refundOf != null ? allMonthsById.get(r.refundOf) : undefined;
      if (origMonths && !origMonths.has(month)) continue;
      if (!origMonths && r.date.slice(0, 7) !== month) continue;
      const reason = origMonths ? "original-after-asof" : "original-missing";
      unappliedRefunds.push({ refundId: r.id, of: r.refundOf ?? null, amount: amt, reason });
      continue;
    }
    const belongingMonth = orig.date.slice(0, 7);
    if (belongingMonth !== month) continue; // judged in the original's month
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

// ---------- Daily spend stream (F-ARCH-001 daily granularity) --
// The SAME ledger caliber as summarizeSpendMonth, aggregated per
// DAY: identical asOf candidate set, identical lifecycle
// arbitration (identical duplicates dedupe on the same key —
// category is presentation metadata and never splits a duplicate;
// a posted row supersedes a pending row; conflicting duplicates
// are excluded and listed), the identical two definitional
// exclusions, and the identical refund rule — a posted refund
// offsets its ORIGINAL transaction, here on the original's DAY
// and in the original's category, with the traceable pair kept in
// `offsets`; every other refund lands in `unappliedRefunds` with
// a reason, never silently dropped and never driving a day
// negative. Rows may carry `category` (a source category key);
// absent means "UNCATEGORIZED".
// options: { asOf?, fromDate?, toDate? }
// - asOf: rows dated after it are not candidates at all (same
//   cutoff semantics as the monthly contract).
// - fromDate + toDate: when BOTH are given, every date in the
//   closed range is emitted, including dates with no counted
//   rows (posted 0). A zero inside the range is a REAL zero for
//   the pulled window — the caller asserts the window was fully
//   pulled; dates outside the range are absent, never invented
//   by this function, and days before the source's history are
//   the caller's coverage problem, not a zero.
// - totals describe the passed ledger (all candidate rows),
//   whether or not a display range was requested.
export function nextDateKey(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function summarizeSpendDaily(txns, options = {}) {
  if (typeof options === "string") options = { asOf: options };
  options = options ?? {};
  const asOf = options.asOf ?? options.asOfDate ?? null;
  const fromDate = options.fromDate ?? null;
  const toDate = options.toDate ?? null;
  const afterAsOf = (row) => asOf !== null && row.date > asOf;

  // Candidate set first, lifecycle arbitration second — the same
  // order, dedupe key and rules as summarizeSpendMonth (TXN-1).
  const groups = new Map();
  for (const t of txns) {
    if (afterAsOf(t)) continue;
    if (!groups.has(t.id)) groups.set(t.id, []);
    groups.get(t.id).push(t);
  }
  const allDatesById = new Map(); // id -> Set of dates over ALL rows (diagnosis only)
  for (const t of txns) {
    if (!allDatesById.has(t.id)) allDatesById.set(t.id, new Set());
    allDatesById.get(t.id).add(t.date);
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

  const dayMap = new Map();
  const emptyDay = (date) => ({
    date, posted: 0, pending: 0, categories: new Map(), spendCount: 0, pendingCount: 0, unclassified: [],
  });
  const dayFor = (date) => {
    if (!dayMap.has(date)) dayMap.set(date, emptyDay(date));
    return dayMap.get(date);
  };
  const addCategory = (day, key, delta) => {
    day.categories.set(key, (day.categories.get(key) ?? 0) + delta);
  };

  const countedSpend = new Map(); // id -> remaining refundable amount
  const originOf = new Map(); // id -> { date, category } of the counted original
  const unclassified = [];
  const excludedCounts = { transfer: 0, loanPrincipal: 0 };
  let totalPosted = 0;
  let totalPending = 0;
  for (const [id, row] of canonical) {
    if (row.kind === "refund") continue;
    if (row.kind === "transfer") { excludedCounts.transfer += 1; continue; }
    if (row.kind === "loan_principal") { excludedCounts.loanPrincipal += 1; continue; }
    if (row.kind === "spend") {
      const amt = Math.abs(row.amount);
      const category = typeof row.category === "string" && row.category ? row.category : "UNCATEGORIZED";
      if (row.status === "pending") {
        const day = dayFor(row.date);
        day.pending += amt;
        day.pendingCount += 1;
        totalPending += amt;
      } else {
        const day = dayFor(row.date);
        day.posted += amt;
        day.spendCount += 1;
        addCategory(day, category, amt);
        totalPosted += amt;
        countedSpend.set(id, amt);
        originOf.set(id, { date: row.date, category });
      }
    } else {
      // loan_mixed / unmatched_transfer / unknown kinds: visible
      // on their own day and in the dataset list, never silently
      // excluded (same rule as the monthly contract).
      unclassified.push({ id, date: row.date, kind: row.kind });
      dayFor(row.date).unclassified.push(id);
    }
  }

  // Refunds: judged globally (no month scope at day granularity),
  // applied to the ORIGINAL's day and category. Same reason
  // taxonomy as the monthly contract.
  const refundRows = [...canonical.values()]
    .filter((r) => r.kind === "refund")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offsets = [];
  const unappliedRefunds = [];
  for (const r of refundRows) {
    if (r.status !== "posted") continue; // a pending refund has not landed yet
    const amt = Math.abs(r.amount);
    const orig = r.refundOf != null ? canonical.get(r.refundOf) : undefined;
    if (!orig) {
      let reason = "original-missing";
      if (r.refundOf != null && conflictIds.has(r.refundOf)) reason = "original-conflicted";
      else if (r.refundOf != null && (allDatesById.get(r.refundOf)?.size ?? 0) > 0) reason = "original-after-asof";
      unappliedRefunds.push({ refundId: r.id, of: r.refundOf ?? null, amount: amt, reason, date: r.date });
      continue;
    }
    if (orig.kind !== "spend") { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-not-spend", date: r.date }); continue; }
    if (orig.status !== "posted") { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-pending", date: r.date }); continue; }
    const remaining = countedSpend.get(orig.id);
    if (remaining === undefined) { unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt, reason: "original-not-counted", date: r.date }); continue; }
    const applied = Math.min(amt, remaining);
    if (applied > 0) {
      const origin = originOf.get(orig.id);
      const day = dayFor(origin.date);
      day.posted -= applied;
      addCategory(day, origin.category, -applied);
      totalPosted -= applied;
      countedSpend.set(orig.id, remaining - applied);
      offsets.push({ refundId: r.id, of: orig.id, amount: applied, date: origin.date, refundDate: r.date });
    }
    if (amt > applied) {
      unappliedRefunds.push({ refundId: r.id, of: orig.id, amount: amt - applied, reason: "exceeds-original", date: r.date });
    }
  }

  // Coverage honesty (daily backfill): rows may carry `account`
  // (an opaque source-account key). An account GATES coverage
  // when it has at least one counted posted spend row; its data
  // starts at its earliest candidate row date (any kind/status).
  // A day earlier than some gating account's start is `partial`:
  // that account's spend cannot be in it, so the day must not be
  // read as a complete day — it is still emitted with its real
  // subtotal (never dropped, never upgraded to complete).
  // fullCoverageStart is the first date from which every gating
  // account's data has started (null when nothing gates).
  const accountStart = new Map();
  for (const t of txns) {
    if (afterAsOf(t) || typeof t.account !== "string" || !t.account) continue;
    if (!accountStart.has(t.account) || t.date < accountStart.get(t.account)) {
      accountStart.set(t.account, t.date);
    }
  }
  const gatingStarts = [];
  {
    const gatingAccounts = new Set();
    for (const [id, row] of canonical) {
      if (row.kind === "spend" && row.status === "posted" && typeof row.account === "string" && row.account) {
        gatingAccounts.add(row.account);
      }
    }
    for (const account of gatingAccounts) {
      if (accountStart.has(account)) gatingStarts.push(accountStart.get(account));
    }
  }
  const fullCoverageStart = gatingStarts.length ? gatingStarts.reduce((a, b) => (a > b ? a : b)) : null;

  let dates;
  if (fromDate && toDate && fromDate <= toDate) {
    dates = [];
    for (let cur = fromDate; ; cur = nextDateKey(cur)) {
      dates.push(cur);
      if (cur === toDate) break;
    }
  } else {
    dates = [...dayMap.keys()].sort();
  }
  const days = dates.map((date) => {
    const day = dayMap.get(date) ?? emptyDay(date);
    const categories = [...day.categories.entries()]
      .map(([key, amount]) => ({ key, amount }))
      .filter((c) => Math.abs(c.amount) > 1e-9)
      .sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      date,
      posted: day.posted,
      pending: day.pending,
      categories,
      spendCount: day.spendCount,
      pendingCount: day.pendingCount,
      unclassified: day.unclassified,
      partial: fullCoverageStart !== null && date < fullCoverageStart,
    };
  });
  return {
    days,
    totals: { posted: totalPosted, pending: totalPending },
    offsets,
    conflicts,
    unappliedRefunds,
    unclassified,
    excludedCounts,
    accountStarts: Object.fromEntries([...accountStart.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    fullCoverageStart,
    classificationComplete: unclassified.length === 0 && conflicts.length === 0 && unappliedRefunds.length === 0,
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
      coverage: e.coverage,
      coverageOk: e.coverageOk,
    }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([month, daily]) => ({
      month,
      daily: normalizeDaily(Array.isArray(daily) ? daily : daily?.daily),
      complete: Array.isArray(daily) ? undefined : daily?.complete,
      coverageStatus: Array.isArray(daily) ? undefined : daily?.coverageStatus,
      coverage: Array.isArray(daily) ? undefined : daily?.coverage,
      coverageOk: Array.isArray(daily) ? undefined : daily?.coverageOk,
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
        coverage: e.coverage,
        coverageOk: e.coverageOk,
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

  // Baseline (ANOM-1 01:07, tightened 04:01): normalize by month
  // identity first. Only months strictly before the asOf month are
  // eligible; rows for the same month must agree (identical
  // duplicates dedupe, conflicting versions disqualify the month);
  // each month needs its OWN explicit complete coverage — an
  // entry's coverageStatus / coverage / coverageOk / complete
  // fields or that month's explicit coverageByMonth entry, with
  // conflicting signals disqualifying the month. A month with NO
  // signal of its own is "unknown": the call-level / current
  // month's coverageStatus is never inherited. A coverageByMonth
  // key that is absent or null adds no signal (it does not
  // contradict an entry's own explicit signal); an explicit
  // `false` in the map does contradict it.
  const coverageSignal = (e) => {
    const signals = [];
    if (typeof e.coverageStatus === "string") signals.push(e.coverageStatus);
    if (e.coverage !== undefined) signals.push(e.coverage === true ? "complete" : e.coverage === false ? "incomplete" : "unknown");
    if (e.coverageOk !== undefined) signals.push(e.coverageOk === true ? "complete" : e.coverageOk === false ? "incomplete" : "unknown");
    if (e.complete !== undefined) signals.push(e.complete === true ? "complete" : "incomplete");
    if (input.coverageByMonth !== undefined && e.month) {
      const mv = input.coverageByMonth[e.month];
      if (mv === true) signals.push("complete");
      else if (mv === false) signals.push("incomplete");
    }
    if (signals.length === 0) return "unknown";
    const uniq = [...new Set(signals)];
    return uniq.length > 1 ? "conflict" : uniq[0];
  };
  const rejectedMonths = [];
  const byMonthMap = new Map();
  for (const e of normalizeBaselineDaily(input)) {
    if (!e.daily) continue;
    if (!e.month) { rejectedMonths.push({ month: null, reason: "缺月份标识" }); continue; }
    if (month && e.month >= month) {
      rejectedMonths.push({ month: e.month, reason: e.month === month ? "当月不作基准" : "未来月不作基准" });
      continue;
    }
    if (!byMonthMap.has(e.month)) byMonthMap.set(e.month, []);
    byMonthMap.get(e.month).push(e);
  }
  const eligibleEntries = [];
  for (const [m, rows] of byMonthMap) {
    if (new Set(rows.map((r) => JSON.stringify(r.daily))).size > 1) {
      rejectedMonths.push({ month: m, reason: "同月冲突版本，无权威版本不任挑" });
      continue;
    }
    const cov = coverageSignal(rows[0]);
    const covs = new Set(rows.map((r) => coverageSignal(r)));
    if (covs.size > 1) { rejectedMonths.push({ month: m, reason: "覆盖信号冲突" }); continue; }
    if (cov !== "complete") { rejectedMonths.push({ month: m, reason: `覆盖${cov}` }); continue; }
    eligibleEntries.push({ month: m, daily: rows[0].daily, coverageStatus: "complete" });
  }
  eligibleEntries.sort((a, b) => b.month.localeCompare(a.month));
  const comparable = [];
  for (const e of eligibleEntries) {
    if (comparable.length >= 3) break;
    let required = asOfDay;
    if (comparisonKind === "month-end") {
      const { y, m } = parseMonth(e.month);
      required = daysInMonth(y, m);
    }
    const w = windowSum(e.daily, required);
    if (!w) { rejectedMonths.push({ month: e.month, reason: "同日窗内有缺日" }); continue; }
    comparable.push({ month: e.month, window: w, coverageStatus: "complete" });
  }
  const adoptedBaseline = comparable.map((c) => ({ month: c.month, coverageStatus: c.coverageStatus }));
  if (comparable.length < 3) {
    return {
      ...insufficient(`可比完整月少于 3 个（合格 ${comparable.length} 个：须为截至月之前的唯一月份、逐月覆盖明确 complete、同日窗无缺日）`),
      baselineMonths: adoptedBaseline,
      rejectedMonths,
    };
  }
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
    baselineMonths: adoptedBaseline,
    rejectedMonths,
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
    coverageByMonth: input.coverageByMonth,
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
