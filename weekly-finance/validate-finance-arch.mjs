// F-ARCH-001 synthetic validation: runs finance-arch.mjs over purely
// synthetic fixtures (high/low/zero months, missing month, cross-month
// refund offset, duplicate IDs, transfer/principal exclusions, mixed
// loan payment unclassified, pending split, unknown account not zero,
// two-layer freshness ranges, anomaly v0 fire/no-fire boundaries).
// The original 28 assertions are all retained (fixtures adjusted only
// where the CAL-1/COV-1/TXN-1/ANOM-1 contracts upgraded the semantics:
// explicit coverage, fixed 12-month grid, daily-fact anomaly input).
// Four PM criteria matrices (CAL / COV / TXN / ANOM) follow them.
import {
  summarizeNetWorth, summarizeSpendMonth, fireEligibleMonths, anomalyV0, buildArchPreview,
  monthCoverage, targetMonths12, daysInMonth,
} from "./finance-arch.mjs";

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; } else { failed++; console.log("FAIL:", name); } };
const eq = (a, b) => Math.abs(a - b) < 1e-9;
const COV = (m) => ({ coverageByMonth: { [m]: true } });

// Daily-fact helpers for the anomaly contract: full-month daily arrays
// of a constant, or zeros with spend placed on specific days.
const constDaily = (month, perDay) => {
  const [y, m] = month.split("-").map(Number);
  return { month, daily: Array(daysInMonth(y, m)).fill(perDay) };
};
const daysDaily = (month, byDay) => {
  const [y, m] = month.split("-").map(Number);
  const daily = Array(daysInMonth(y, m)).fill(0);
  for (const [d, amt] of Object.entries(byDay)) daily[Number(d) - 1] = amt;
  return { month, daily };
};
const dailyRange = (total, days) => { const a = Array(days).fill(0); a[0] = total; return a; };

// --- Net worth: mixed freshness, missing not zero, liability deducted
const nw = summarizeNetWorth([
  { id: "plaid_checking", balance: 10000, kind: "asset", coverage: "plaid", asOf: "2026-10-23", readAt: "2026-10-23T15:00:00Z" },
  { id: "plaid_cc", balance: 2500, kind: "liability", coverage: "plaid", asOf: "2026-10-22", readAt: "2026-10-23T15:00:00Z" },
  { id: "snap_broker", balance: 50000, kind: "asset", coverage: "snapshot", asOf: "2026-09-30", readAt: null },
  { id: "snap_unknown", balance: null, kind: "asset", coverage: "missing", asOf: null, readAt: null },
]);
check("nw total excludes missing, deducts liability", eq(nw.total, 57500));
check("nw partial + missing listed", nw.partial && nw.missing.join() === "snap_unknown");
check("nw plaid range", nw.plaidRange.oldest === "2026-10-22" && nw.plaidRange.newest === "2026-10-23");
check("nw snapshot range", nw.snapshotRange.oldest === "2026-09-30" && nw.snapshotRange.newest === "2026-09-30");
check("nw label is mixed-date wording", nw.label.includes("混合日期") && !nw.label.includes("实时"));

// --- Spend: dedupe, exclusions, pending split
const txns = [
  { id: "t1", date: "2026-10-03", amount: -120, status: "posted", kind: "spend" },
  { id: "t1", date: "2026-10-03", amount: -120, status: "posted", kind: "spend" }, // duplicate ID
  { id: "t2", date: "2026-10-05", amount: -45.5, status: "pending", kind: "spend" },
  { id: "t3", date: "2026-10-06", amount: -2000, status: "posted", kind: "transfer" },
  { id: "t4", date: "2026-10-07", amount: -900, status: "posted", kind: "loan_principal" },
  { id: "t5", date: "2026-09-20", amount: -80, status: "posted", kind: "spend" },
  { id: "t6", date: "2026-10-10", amount: 30, status: "posted", kind: "refund", refundOf: "t5" }, // refund of a SEPTEMBER spend
  { id: "t7", date: "2026-10-11", amount: -60, status: "posted", kind: "spend" },
  { id: "t8", date: "2026-10-12", amount: 25, status: "posted", kind: "refund", refundOf: "t7" },
];
const oct = summarizeSpendMonth(txns, "2026-10", COV("2026-10"));
check("oct posted spend deduped + exclusions", eq(oct.postedSpend, 120 + 60 - 25));
check("oct pending separate", eq(oct.pendingSpend, 45.5));
check("oct complete (no unclassified)", oct.complete === true);
check("oct refund offset traced to october original only", oct.offsets.length === 1 && oct.offsets[0].of === "t7");
const sep = summarizeSpendMonth(txns, "2026-09", COV("2026-09"));
check("sep spend carries cross-month refund offset", eq(sep.postedSpend, 80 - 30) && sep.offsets.length === 1 && sep.offsets[0].refundId === "t6");

// --- Spend: unclassified stays visible, month incomplete
const mixed = summarizeSpendMonth([
  { id: "m1", date: "2026-10-02", amount: -1500, status: "posted", kind: "loan_mixed" },
  { id: "m2", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "m3", date: "2026-10-04", amount: -700, status: "posted", kind: "unmatched_transfer" },
], "2026-10", COV("2026-10"));
check("mixed loan payment not silently excluded", mixed.unclassified.join() === "m1,m3" && eq(mixed.postedSpend, 100) && mixed.complete === false);

// --- Zero month (explicitly fully covered: a real, proven zero)
const zero = summarizeSpendMonth([], "2026-08", COV("2026-08"));
check("zero month", zero.postedSpend === 0 && zero.complete === true);

// --- FIRE: only ended, complete, covered months; never backfilled.
// Fixture upgraded to the fixed grid: all 12 target months of
// throughMonth 2026-10 are present, 2026-08 incomplete.
const gridTargets = targetMonths12("2026-10");
const months = gridTargets.map((m) => ({ month: m, complete: m !== "2026-08" }));
const covAll = Object.fromEntries(gridTargets.map((m) => [m, true]));
const fire = fireEligibleMonths(months, covAll, "2026-10");
check(
  "fire excludes incomplete + current partial month",
  fire.eligible.join() === gridTargets.filter((m) => m !== "2026-08").join() && fire.complete12 === false && fire.missing.join() === "2026-08",
);

// --- Anomaly v0 boundaries (daily-fact signature)
// Baseline: Jul/Aug/Sep at 100/day. Day-15 window = 1500 per month,
// pooled daily median = 100, absolute floor = 700.
const baseDaily = [constDaily("2026-07", 100), constDaily("2026-08", 100), constDaily("2026-09", 100)];
const anom = (over) => anomalyV0({
  baselineDaily: baseDaily, currentDaily: dailyRange(1500, 15),
  month: "2026-10", asOfDate: "2026-10-15", coverageStatus: "complete", ...over,
});
const fire1 = anom({ currentDaily: dailyRange(2600, 15) });
check("anomaly fires when rel>30% and abs>7d median", fire1.verdict === "anomaly");
const relOnlyBase = [constDaily("2026-07", 10), constDaily("2026-08", 10), constDaily("2026-09", 10)];
const relOnly = anom({ baselineDaily: relOnlyBase, currentDaily: dailyRange(200, 15) });
check("relative-only deviation does not fire (abs floor)", relOnly.verdict === "normal");
const few = anom({ baselineDaily: baseDaily.slice(0, 2) });
check("fewer than 3 comparable months -> insufficient", few.verdict === "insufficient");
const zeroBase = anom({ baselineDaily: [constDaily("2026-07", 0), constDaily("2026-08", 0), constDaily("2026-09", 0)], currentDaily: dailyRange(500, 15) });
check("zero baseline -> insufficient", zeroBase.verdict === "insufficient");
const noCov = anom({ coverageStatus: "incomplete", currentDaily: dailyRange(9000, 15) });
check("missing coverage -> insufficient", noCov.verdict === "insufficient");
const calm = anom({ currentDaily: dailyRange(1580, 15) });
check("in-band month -> normal", calm.verdict === "normal");

// --- Anomaly comparison kind: mid-month progress vs month-end total
check("mid-month comparison kind", fire1.comparisonKind === "mid-month-progress");
const monthEnd = anomalyV0({
  baselineDaily: baseDaily, currentDaily: dailyRange(3100, 31),
  month: "2026-10", asOfDate: "2026-10-31", coverageStatus: "complete",
});
check("month-end comparison kind", monthEnd.comparisonKind === "month-end" && monthEnd.verdict === "normal");
check("insufficient keeps comparison kind", few.comparisonKind === "mid-month-progress");

// --- Preview: the first-slice card model over one synthetic fixture
const preview = buildArchPreview({
  accounts: [
    { id: "plaid_checking", balance: 10000, kind: "asset", coverage: "plaid", asOf: "2026-10-23", readAt: "2026-10-23T15:00:00Z" },
    { id: "snap_broker", balance: 50000, kind: "asset", coverage: "snapshot", asOf: "2026-09-30", readAt: null },
    { id: "snap_unknown", balance: null, kind: "asset", coverage: "missing", asOf: null, readAt: null },
  ],
  txns,
  currentMonth: "2026-10",
  asOfDate: "2026-10-23",
  monthSummaries: months,
  coverageByMonth: { ...covAll, "2026-10": true },
  baselineDaily: baseDaily,
  currentDaily: dailyRange(155, 23),
});
check("preview net worth card keeps layers + missing", eq(preview.netWorthCard.total, 60000) && preview.netWorthCard.partial && preview.netWorthCard.snapshotRange.newest === "2026-09-30");
check("preview spend card title carries as-of date", preview.spendCard.title.includes("2026-10-23"));
check("preview spend three lines posted/pending/gap", preview.spendCard.lines.map((l) => l.key).join() === "posted,pending,gap" && eq(preview.spendCard.lines[0].amount, 155) && eq(preview.spendCard.lines[1].amount, 45.5) && preview.spendCard.lines[2].complete === true);
check("preview has no fixed/flexible line", !JSON.stringify(preview.spendCard).includes("fixed") && !JSON.stringify(preview.spendCard).includes("flexible"));
check("preview fire card lists missing month, no backfill", preview.fireCard.complete12 === false && preview.fireCard.missingMonths.join() === "2026-08");
check("preview anomaly is mid-month progress", preview.anomalyCard.comparisonKind === "mid-month-progress");

// =====================================================================
// CAL-1 matrix: fixed 12-month grid before throughMonth
// =====================================================================
const calSummaries = (list, complete = true) => list.map((m) => ({ month: m, complete }));
const calCov = (list) => Object.fromEntries(list.map((m) => [m, true]));
const T25 = targetMonths12("2026-01"); // 2025-01 .. 2025-12 (cross-year)
const calCross = fireEligibleMonths(calSummaries(T25), calCov(T25), "2026-01");
check("CAL cross-year grid complete12", calCross.complete12 === true && calCross.eligible.length === 12 && calCross.eligible[0] === "2025-01" && calCross.eligible[11] === "2025-12");
check("CAL grid includes Feb of leap span", targetMonths12("2025-03").join().includes("2025-02") && targetMonths12("2025-03").length === 12);
const T = targetMonths12("2026-10"); // 2025-10 .. 2026-09
const without = (m) => T.filter((x) => x !== m);
check("CAL missing head listed", (() => { const f = fireEligibleMonths(calSummaries(without(T[0])), calCov(T), "2026-10"); return !f.complete12 && f.missing.join() === T[0]; })());
check("CAL missing middle listed", (() => { const f = fireEligibleMonths(calSummaries(without("2026-03")), calCov(T), "2026-10"); return !f.complete12 && f.missing.join() === "2026-03"; })());
check("CAL missing tail listed", (() => { const f = fireEligibleMonths(calSummaries(without("2026-09")), calCov(T), "2026-10"); return !f.complete12 && f.missing.join() === "2026-09"; })());
check("CAL empty input -> all 12 missing", (() => { const f = fireEligibleMonths([], {}, "2026-10"); return f.eligible.length === 0 && !f.complete12 && f.missing.join() === T.join(); })());
check("CAL unsorted input -> eligible sorted", (() => { const f = fireEligibleMonths(calSummaries([...T].reverse()), calCov(T), "2026-10"); return f.complete12 && f.eligible.join() === T.join(); })());
check("CAL duplicate same value dedupes", (() => { const f = fireEligibleMonths(calSummaries([...T, ...T]), calCov(T), "2026-10"); return f.complete12 && f.eligible.length === 12; })());
check("CAL duplicate conflict listed, not picked", (() => {
  const rows = [...calSummaries(T), { month: "2026-05", complete: false }];
  const f = fireEligibleMonths(rows, calCov(T), "2026-10");
  return !f.complete12 && f.missing.join() === "2026-05" && f.missingDetails[0].reasons.includes("conflict");
})());
check("CAL earlier month never backfills (PM counterexample)", (() => {
  const rows = calSummaries([...without("2026-05"), "2025-09"]); // 2025-09 is BEFORE the grid
  const f = fireEligibleMonths(rows, { ...calCov(T), "2025-09": true }, "2026-10");
  return !f.complete12 && f.missing.join() === "2026-05" && !f.eligible.includes("2025-09");
})());
check("CAL current + future months ignored", (() => {
  const rows = calSummaries([...T, "2026-10", "2026-11"]);
  const f = fireEligibleMonths(rows, { ...calCov(T), "2026-10": true, "2026-11": true }, "2026-10");
  return f.complete12 && !f.eligible.includes("2026-10") && !f.eligible.includes("2026-11");
})());
check("CAL coverage unknown reason per cell", (() => {
  const cov = calCov(T); delete cov["2026-04"];
  const f = fireEligibleMonths(calSummaries(T), cov, "2026-10");
  return f.missing.join() === "2026-04" && f.missingDetails[0].reasons.includes("coverage-unknown");
})());
check("CAL coverage false reason per cell", (() => {
  const f = fireEligibleMonths(calSummaries(T), { ...calCov(T), "2026-04": false }, "2026-10");
  return f.missing.join() === "2026-04" && f.missingDetails[0].reasons.includes("coverage-incomplete");
})());
check("CAL incomplete summary reason per cell", (() => {
  const rows = T.map((m) => ({ month: m, complete: m !== "2026-04" }));
  const f = fireEligibleMonths(rows, calCov(T), "2026-10");
  return f.missing.join() === "2026-04" && f.missingDetails[0].reasons.includes("incomplete");
})());

// =====================================================================
// COV-1 matrix: one coverage contract, classification kept separate
// =====================================================================
check("COV true -> complete", monthCoverage({ "2026-10": true }, "2026-10") === "complete");
check("COV false -> incomplete", monthCoverage({ "2026-10": false }, "2026-10") === "incomplete");
check("COV missing key -> unknown", monthCoverage({}, "2026-10") === "unknown");
check("COV null -> unknown", monthCoverage({ "2026-10": null }, "2026-10") === "unknown");
check("COV empty + covered = real zero", (() => { const s = summarizeSpendMonth([], "2026-10", COV("2026-10")); return s.postedSpend === 0 && s.complete && s.amountBasis === "actual" && s.classificationComplete; })());
check("COV empty + coverage {} = unknown, not complete", (() => { const s = summarizeSpendMonth([], "2026-10", { coverageByMonth: {} }); return s.postedSpend === 0 && !s.complete && s.coverageStatus === "unknown" && s.classificationComplete && s.amountBasis === "stored-subtotal"; })());
check("COV empty + coverage false = incomplete", (() => { const s = summarizeSpendMonth([], "2026-10", { coverageByMonth: { "2026-10": false } }); return !s.complete && s.coverageStatus === "incomplete"; })());
check("COV partial coverage keeps stored subtotal only", (() => {
  const s = summarizeSpendMonth([{ id: "p1", date: "2026-10-03", amount: -70, status: "posted", kind: "spend" }], "2026-10", { coverageByMonth: { "2026-10": false } });
  return eq(s.postedSpend, 70) && !s.complete && s.classificationComplete && s.amountBasis === "stored-subtotal";
})());
check("COV unclassified + covered: classification dimension fails alone", (() => {
  const s = summarizeSpendMonth([{ id: "u1", date: "2026-10-03", amount: -70, status: "posted", kind: "loan_mixed" }], "2026-10", COV("2026-10"));
  return !s.complete && !s.classificationComplete && s.coverageStatus === "complete";
})());
check("COV unclassified + uncovered: both dimensions fail", (() => {
  const s = summarizeSpendMonth([{ id: "u1", date: "2026-10-03", amount: -70, status: "posted", kind: "loan_mixed" }], "2026-10", { coverageByMonth: {} });
  return !s.complete && !s.classificationComplete && s.coverageStatus === "unknown";
})());
check("COV pending does not break completeness when covered", (() => {
  const s = summarizeSpendMonth([{ id: "p1", date: "2026-10-03", amount: -70, status: "pending", kind: "spend" }], "2026-10", COV("2026-10"));
  return s.complete && eq(s.pendingSpend, 70) && s.postedSpend === 0;
})());
check("COV one contract across spend/fire/anomaly", (() => {
  const s = summarizeSpendMonth([], "2026-10", { coverageByMonth: {} });
  const f = fireEligibleMonths(calSummaries(T), {}, "2026-10");
  const a = anomalyV0({ baselineDaily: baseDaily, currentDaily: dailyRange(100, 15), month: "2026-10", asOfDate: "2026-10-15", coverageByMonth: {} });
  return !s.complete && f.eligible.length === 0 && a.verdict === "insufficient";
})());

// =====================================================================
// TXN-1 matrix: lifecycle normalization, refunds, asOf, purity
// =====================================================================
const S = (list, over = {}) => summarizeSpendMonth(list, "2026-10", { ...COV("2026-10"), ...over });
const spendRow = (id, amount, over = {}) => ({ id, date: "2026-10-05", amount, status: "posted", kind: "spend", ...over });
check("TXN identical duplicates: both orders same result", (() => {
  const a = S([spendRow("d1", -100), spendRow("d1", -100), spendRow("d2", -50)]);
  const b = S([spendRow("d2", -50), spendRow("d1", -100), spendRow("d1", -100)]);
  return eq(a.postedSpend, 150) && eq(b.postedSpend, 150) && a.complete && b.complete;
})());
check("TXN pending->posted: both orders, posted wins", (() => {
  const pend = spendRow("x1", -100, { status: "pending" });
  const post = spendRow("x1", -100, { status: "posted", date: "2026-10-06" });
  const a = S([pend, post]); const b = S([post, pend]);
  return eq(a.postedSpend, 100) && a.pendingSpend === 0 && eq(b.postedSpend, 100) && b.pendingSpend === 0;
})());
check("TXN conflicting duplicates listed, never picked, both orders", (() => {
  const rows = [spendRow("c1", -100), spendRow("c1", -80), spendRow("c2", -50)];
  const a = S(rows); const b = S([...rows].reverse());
  return a.conflicts.length === 1 && a.conflicts[0].id === "c1" && eq(a.postedSpend, 50) && !a.complete
    && b.conflicts.length === 1 && eq(b.postedSpend, 50);
})());
check("TXN multiple partial refunds keep offsets chain", (() => {
  const s = S([
    spendRow("o1", -100),
    { id: "r1", date: "2026-10-08", amount: 30, status: "posted", kind: "refund", refundOf: "o1" },
    { id: "r2", date: "2026-10-09", amount: 20, status: "posted", kind: "refund", refundOf: "o1" },
  ]);
  return eq(s.postedSpend, 50) && s.offsets.map((o) => o.amount).join() === "30,20" && s.complete;
})());
check("TXN cross-month refund judged in original month only", (() => {
  const rows = [
    { id: "o1", date: "2026-09-20", amount: -80, status: "posted", kind: "spend" },
    { id: "r1", date: "2026-10-04", amount: 30, status: "posted", kind: "refund", refundOf: "o1" },
  ];
  const octS = S(rows);
  const sepS = summarizeSpendMonth(rows, "2026-09", COV("2026-09"));
  return octS.postedSpend === 0 && octS.unappliedRefunds.length === 0 && eq(sepS.postedSpend, 50) && sepS.offsets.length === 1;
})());
check("TXN orphan refund listed, no negative spend", (() => {
  const s = S([{ id: "r1", date: "2026-10-04", amount: 40, status: "posted", kind: "refund", refundOf: "ghost" }]);
  return s.postedSpend === 0 && s.unappliedRefunds.length === 1 && !s.complete;
})());
check("TXN refund of excluded transfer listed, no negative spend", (() => {
  const s = S([
    { id: "t1", date: "2026-10-03", amount: -200, status: "posted", kind: "transfer" },
    { id: "r1", date: "2026-10-04", amount: 40, status: "posted", kind: "refund", refundOf: "t1" },
  ]);
  return s.postedSpend === 0 && s.unappliedRefunds.length === 1 && s.unappliedRefunds[0].reason === "original-not-spend" && !s.complete;
})());
check("TXN future spend excluded by asOf and not unclassified", (() => {
  const s = S([
    spendRow("f1", -100, { date: "2026-10-28" }),
    { id: "f2", date: "2026-10-28", amount: -500, status: "posted", kind: "loan_mixed" },
    spendRow("f3", -25, { date: "2026-10-23" }),
  ], { asOf: "2026-10-23" });
  return eq(s.postedSpend, 25) && s.unclassified.length === 0;
})());
check("TXN future refund not applied and not unapplied", (() => {
  const s = S([
    spendRow("o1", -100, { date: "2026-10-10" }),
    { id: "r1", date: "2026-10-28", amount: 40, status: "posted", kind: "refund", refundOf: "o1" },
  ], { asOf: "2026-10-23" });
  return eq(s.postedSpend, 100) && s.offsets.length === 0 && s.unappliedRefunds.length === 0;
})());
check("TXN refund exceeding original: excess listed, spend floors at 0", (() => {
  const s = S([
    spendRow("o1", -50),
    { id: "r1", date: "2026-10-08", amount: 80, status: "posted", kind: "refund", refundOf: "o1" },
  ]);
  return s.postedSpend === 0 && s.offsets.length === 1 && eq(s.offsets[0].amount, 50)
    && s.unappliedRefunds.length === 1 && eq(s.unappliedRefunds[0].amount, 30) && !s.complete;
})());
check("TXN refund of pending original is unapplied", (() => {
  const s = S([
    spendRow("o1", -100, { status: "pending" }),
    { id: "r1", date: "2026-10-08", amount: 30, status: "posted", kind: "refund", refundOf: "o1" },
  ]);
  return eq(s.pendingSpend, 100) && s.postedSpend === 0 && s.unappliedRefunds.length === 1 && !s.complete;
})());
check("TXN pure + idempotent: input untouched, repeat calls identical", (() => {
  const rows = [spendRow("i1", -100), spendRow("i1", -100, { status: "pending", date: "2026-10-04" }), spendRow("i2", -50)];
  const snapshot = JSON.stringify(rows);
  const a = S(rows); const b = S(rows);
  return JSON.stringify(rows) === snapshot && JSON.stringify(a) === JSON.stringify(b) && eq(a.postedSpend, 150);
})());

// =====================================================================
// ANOM-1 matrix: real month lengths, same-day windows, daily median
// =====================================================================
for (const [asOf, kind] of [
  ["2026-02-28", "month-end"], ["2026-02-27", "mid-month-progress"],
  ["2024-02-29", "month-end"], ["2024-02-28", "mid-month-progress"],
  ["2026-04-30", "month-end"], ["2026-04-29", "mid-month-progress"],
  ["2026-10-31", "month-end"], ["2026-10-30", "mid-month-progress"],
  ["2026-01-31", "month-end"], ["2026-01-30", "mid-month-progress"],
]) {
  const r = anomalyV0({ month: asOf.slice(0, 7), asOfDate: asOf, coverageStatus: "complete" });
  check(`ANOM comparison kind ${asOf} -> ${kind}`, r.comparisonKind === kind);
}
check("ANOM front-loaded baseline months do not false-fire", (() => {
  // Each baseline month spends 3000 entirely in its first 15 days;
  // the current month has spent the same 3000 by day 15. The old
  // uniform-spread path compared against 1500 and fired.
  const front = (m) => daysDaily(m, Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i + 1, 200])));
  const r = anomalyV0({
    baselineDaily: [front("2026-07"), front("2026-08"), front("2026-09")],
    currentDaily: Array(15).fill(200),
    month: "2026-10", asOfDate: "2026-10-15", coverageStatus: "complete",
  });
  return r.verdict === "normal" && eq(r.baselineWindow, 3000);
})());
check("ANOM unknown coverage -> insufficient", anom({ coverageStatus: "unknown" }).verdict === "insufficient");
check("ANOM missing day in a baseline month makes it non-comparable", (() => {
  const broken = constDaily("2026-09", 100); broken.daily[5] = null;
  const r = anom({ baselineDaily: [constDaily("2026-07", 100), constDaily("2026-08", 100), broken] });
  return r.verdict === "insufficient";
})());
check("ANOM missing day in current window -> insufficient", (() => {
  const cur = dailyRange(1500, 15); cur[3] = null;
  return anom({ currentDaily: cur }).verdict === "insufficient";
})());
check("ANOM real zero days count toward the daily median", (() => {
  // Window days: ten real 0 days + five 300 days per baseline month.
  // Pooled median is 0 only if the zeros are real values, not gaps.
  const sparse = (m) => daysDaily(m, { 11: 300, 12: 300, 13: 300, 14: 300, 15: 300 });
  const r = anomalyV0({
    baselineDaily: [sparse("2026-07"), sparse("2026-08"), sparse("2026-09")],
    currentDaily: dailyRange(1500, 15),
    month: "2026-10", asOfDate: "2026-10-15", coverageStatus: "complete",
  });
  return eq(r.baselineWindow, 1500) && eq(r.dailyMedian, 0);
})());
check("ANOM most recent 3 comparable months win over older extras, unsorted ok", (() => {
  const r = anom({
    baselineDaily: [constDaily("2026-01", 10000), constDaily("2026-09", 100), constDaily("2026-07", 100), constDaily("2026-08", 100)],
  });
  return r.verdict === "normal" && [...r.comparableMonths].sort().join() === "2026-07,2026-08,2026-09";
})());
check("ANOM relative boundary: exactly +30% does not fire", (() => {
  // Day-27 window, 100/day baselines: window 2700, daily median 100,
  // abs floor 700. Current 3510 = exactly +30% (abs dev 810 > floor),
  // so only the strict > on the relative leg keeps it normal.
  const r = anomalyV0({
    baselineDaily: [constDaily("2026-11", 100), constDaily("2026-12", 100), constDaily("2027-01", 100)],
    currentDaily: Array(27).fill(130),
    month: "2027-02", asOfDate: "2027-02-27", coverageStatus: "complete",
  });
  return r.verdict === "normal" && eq(r.relDev, 0.30);
})());
check("ANOM absolute boundary: exactly dailyMedian*7 does not fire", (() => {
  const r = anomalyV0({
    baselineDaily: baseDaily, currentDaily: Array(10).fill(170),
    month: "2026-10", asOfDate: "2026-10-10", coverageStatus: "complete",
  });
  return r.verdict === "normal" && eq(r.absDev, 700) && eq(r.thresholds.absFloor, 700);
})());
check("ANOM just past both thresholds fires", (() => {
  const cur = Array(10).fill(170); cur[9] = 171;
  const r = anomalyV0({
    baselineDaily: baseDaily, currentDaily: cur,
    month: "2026-10", asOfDate: "2026-10-10", coverageStatus: "complete",
  });
  return r.verdict === "anomaly";
})());
check("ANOM legacy monthly totals carry no daily evidence -> insufficient", (() => {
  const r = anomalyV0({ baselineMonths: [{ spend: 3000 }, { spend: 3100 }, { spend: 3200 }], currentToDate: 9000, currentElapsedDays: 15, coverageOk: true, month: "2026-10", asOfDate: "2026-10-15" });
  return r.verdict === "insufficient";
})());

console.log(`validate-finance-arch: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
