// F-ARCH-001 synthetic validation: runs finance-arch.mjs over purely
// synthetic fixtures (mixed freshness, lifecycle normalization in
// both input orders, conflicts, refund application rules, as-of
// cutoff, the shared coverage contract, the FIRE fixed 12-month grid,
// and anomaly v0 over real daily facts incl. month-length edges).
import { summarizeNetWorth, summarizeSpendMonth, fireEligibleMonths, anomalyV0, buildArchPreview, monthCoverage } from "./finance-arch.mjs";

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; } else { failed++; console.log("FAIL:", name); } };
const eq = (a, b) => Math.abs(a - b) < 1e-9;
const cov = (months) => Object.fromEntries(months.map((m) => [m, true]));

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

// --- Spend: dedupe, exclusions, pending split (coverage explicit)
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
const oct = summarizeSpendMonth(txns, "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("oct posted spend deduped + exclusions", eq(oct.postedSpend, 120 + 60 - 25));
check("oct pending separate", eq(oct.pendingSpend, 45.5));
check("oct complete (classified + covered)", oct.complete === true && oct.coverageStatus === "complete" && oct.amountBasis === "complete");
check("oct refund offset traced to october original only", oct.offsets.length === 1 && oct.offsets[0].of === "t7");
const sep = summarizeSpendMonth(txns, "2026-09", { coverageByMonth: cov(["2026-09"]) });
check("sep spend carries cross-month refund offset", eq(sep.postedSpend, 80 - 30) && sep.offsets.length === 1 && sep.offsets[0].refundId === "t6");

// --- Spend: unclassified stays visible, month incomplete
const mixed = summarizeSpendMonth([
  { id: "m1", date: "2026-10-02", amount: -1500, status: "posted", kind: "loan_mixed" },
  { id: "m2", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "m3", date: "2026-10-04", amount: -700, status: "posted", kind: "unmatched_transfer" },
], "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("mixed loan payment not silently excluded", mixed.unclassified.join() === "m1,m3" && eq(mixed.postedSpend, 100) && mixed.complete === false && mixed.classificationComplete === false);

// --- COV-1: coverage contract
check("coverage true -> complete", monthCoverage({ "2026-10": true }, "2026-10").status === "complete");
check("coverage false -> incomplete", monthCoverage({ "2026-10": false }, "2026-10").status === "incomplete");
check("coverage missing key -> unknown", monthCoverage({}, "2026-10").status === "unknown");
check("coverage null -> unknown", monthCoverage({ "2026-10": null }, "2026-10").status === "unknown");
const zeroKnown = summarizeSpendMonth([], "2026-08", { coverageByMonth: cov(["2026-08"]) });
check("empty month with proven coverage is a real zero", zeroKnown.postedSpend === 0 && zeroKnown.complete === true && zeroKnown.amountBasis === "complete");
const zeroUnknown = summarizeSpendMonth([], "2026-08", { coverageByMonth: {} });
check("empty month with unknown coverage is NOT complete", zeroUnknown.complete === false && zeroUnknown.coverageStatus === "unknown" && zeroUnknown.amountBasis === "stored-subtotal");
const covFalse = summarizeSpendMonth(txns, "2026-10", { coverageByMonth: { "2026-10": false } });
check("coverage false -> gap line incomplete, subtotal kept", covFalse.complete === false && covFalse.coverageStatus === "incomplete" && eq(covFalse.postedSpend, 155));

// --- TXN-1: lifecycle normalization is order-independent
const pendFirst = [
  { id: "x1", date: "2026-10-03", amount: -100, status: "pending", kind: "spend" },
  { id: "x1", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
];
const postFirst = [...pendFirst].reverse();
const lp = summarizeSpendMonth(pendFirst, "2026-10", { coverageByMonth: cov(["2026-10"]) });
const lq = summarizeSpendMonth(postFirst, "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("pending->posted (pending first): posted wins", eq(lp.postedSpend, 100) && eq(lp.pendingSpend, 0) && lp.conflicts.length === 0);
check("pending->posted (posted first): identical result", eq(lq.postedSpend, 100) && eq(lq.pendingSpend, 0) && lq.conflicts.length === 0);
const conflicted = summarizeSpendMonth([
  { id: "c1", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "c1", date: "2026-10-03", amount: -120, status: "posted", kind: "spend" },
  { id: "c2", date: "2026-10-04", amount: -50, status: "posted", kind: "spend" },
], "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("conflicting duplicate listed, counted as nothing", conflicted.conflicts.join() === "c1" && eq(conflicted.postedSpend, 50) && conflicted.complete === false);

// --- TXN-1: refund application rules
const refundTransfer = summarizeSpendMonth([
  { id: "r1", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "r2", date: "2026-10-04", amount: -2000, status: "posted", kind: "transfer" },
  { id: "r3", date: "2026-10-05", amount: 40, status: "posted", kind: "refund", refundOf: "r2" },
], "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("refund of an excluded transfer never offsets", eq(refundTransfer.postedSpend, 100) && refundTransfer.unappliedRefunds.join() === "r3" && refundTransfer.complete === false);
const orphanRefund = summarizeSpendMonth([
  { id: "o1", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "o2", date: "2026-10-05", amount: 30, status: "posted", kind: "refund", refundOf: "ghost" },
], "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("orphan refund listed unapplied, spend untouched", eq(orphanRefund.postedSpend, 100) && orphanRefund.unappliedRefunds.join() === "o2" && orphanRefund.complete === false);
const partialRefunds = summarizeSpendMonth([
  { id: "p1", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "p2", date: "2026-10-05", amount: 30, status: "posted", kind: "refund", refundOf: "p1" },
  { id: "p3", date: "2026-10-06", amount: 20, status: "posted", kind: "refund", refundOf: "p1" },
], "2026-10", { coverageByMonth: cov(["2026-10"]) });
check("multiple partial refunds chain onto the original", eq(partialRefunds.postedSpend, 50) && partialRefunds.offsets.length === 2 && partialRefunds.complete === true);

// --- TXN-1: unified as-of cutoff + purity/idempotence
const futureTxns = [
  { id: "f1", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "f2", date: "2026-10-28", amount: -999, status: "posted", kind: "spend" },
  { id: "f3", date: "2026-10-28", amount: 50, status: "posted", kind: "refund", refundOf: "f1" },
];
const asOfView = summarizeSpendMonth(futureTxns, "2026-10", { asOf: "2026-10-23", coverageByMonth: cov(["2026-10"]) });
check("as-of excludes future spend AND future refund", eq(asOfView.postedSpend, 100) && asOfView.offsets.length === 0 && asOfView.unappliedRefunds.length === 0);
const frozen = JSON.stringify(futureTxns);
const again = summarizeSpendMonth(futureTxns, "2026-10", { asOf: "2026-10-23", coverageByMonth: cov(["2026-10"]) });
check("summarize is pure + idempotent", JSON.stringify(futureTxns) === frozen && JSON.stringify(again) === JSON.stringify(asOfView));

// --- CAL-1: FIRE fixed 12-month grid
const gridMonths = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const fullSummaries = gridMonths.map((m) => ({ month: m, complete: true }));
const fullFire = fireEligibleMonths(fullSummaries, cov(gridMonths), "2026-10");
check("fire full grid: complete12, sorted eligible", fullFire.complete12 === true && fullFire.eligible.join() === gridMonths.join() && fullFire.missing.length === 0);
const pmCase = fireEligibleMonths(
  ["2025-09", ...gridMonths.filter((m) => m !== "2026-05")].map((m) => ({ month: m, complete: true })),
  cov(["2025-09", ...gridMonths]), "2026-10");
check("fire PM case: earlier month never backfills the missing grid month", pmCase.complete12 === false && pmCase.missing.join() === "2026-05" && !pmCase.eligible.includes("2025-09"));
const dupMonth = fireEligibleMonths([...fullSummaries, { month: "2026-09", complete: true }, { month: "2026-09", complete: true }], cov(gridMonths), "2026-10");
check("fire duplicate same-value rows still 12 unique months", dupMonth.complete12 === true && dupMonth.eligible.length === 12);
const dupConflict = fireEligibleMonths([...fullSummaries, { month: "2026-09", complete: false }], cov(gridMonths), "2026-10");
check("fire conflicting duplicate marks the month missing/conflict", dupConflict.complete12 === false && dupConflict.missingDetail.some((d) => d.month === "2026-09" && d.reason === "conflict"));
const emptyFire = fireEligibleMonths([], {}, "2026-10");
check("fire empty input: all 12 grid months missing, none invented", emptyFire.complete12 === false && emptyFire.missing.join() === gridMonths.join() && emptyFire.eligible.length === 0);
const shuffled = fireEligibleMonths([...fullSummaries].reverse(), cov(gridMonths), "2026-10");
check("fire shuffled input order still complete12", shuffled.complete12 === true && shuffled.eligible.join() === gridMonths.join());
const partialHeads = fireEligibleMonths(fullSummaries.filter((s) => !["2025-10", "2026-03", "2026-09"].includes(s.month)), cov(gridMonths), "2026-10");
check("fire missing head/middle/tail each listed", partialHeads.missing.join() === "2025-10,2026-03,2026-09" && partialHeads.complete12 === false);
const covGap = fireEligibleMonths(fullSummaries, cov(gridMonths.filter((m) => m !== "2026-04")), "2026-10");
check("fire coverage-unknown month is missing, not eligible", covGap.complete12 === false && covGap.missingDetail.some((d) => d.month === "2026-04" && d.reason === "coverage-unknown"));
const legacy = fireEligibleMonths(
  [{ month: "2026-06", complete: true }, { month: "2026-07", complete: true }, { month: "2026-08", complete: false }, { month: "2026-09", complete: true }, { month: "2026-10", complete: true }],
  cov(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]), "2026-10");
check("fire legacy fixture under grid rules", legacy.eligible.join() === "2026-06,2026-07,2026-09" && legacy.complete12 === false && legacy.missing.includes("2026-08") && !legacy.eligible.includes("2026-10"));

// --- ANOM-1: daily facts, real month lengths, same-window comparison
const dailyUniform = (month, days, perDay) => ({ month, daily: Array.from({ length: days }, () => perDay), coverage: "complete" });
const dailyFrontLoaded = (month, days, firstDays, perDay) => ({ month, daily: Array.from({ length: days }, (_, i) => (i < firstDays ? perDay : 0)), coverage: "complete" });
const baseUniform = [dailyUniform("2026-07", 31, 100), dailyUniform("2026-08", 31, 100), dailyUniform("2026-09", 30, 100)];
const calmDaily = Array.from({ length: 31 }, (_, i) => (i < 15 ? 100 : 0));
const calm = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: baseUniform, currentDaily: calmDaily, coverageStatus: "complete" });
check("anomaly in-band same-window month -> normal", calm.verdict === "normal" && eq(calm.baselineWindow, 1500) && eq(calm.currentWindow, 1500));
const frontBase = [dailyFrontLoaded("2026-07", 31, 15, 200), dailyFrontLoaded("2026-08", 31, 15, 200), dailyFrontLoaded("2026-09", 30, 15, 200)];
const frontCurrent = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: frontBase, currentDaily: calmDaily.map((v) => v * 2), coverageStatus: "complete" });
check("front-loaded months at day 15 do NOT false-fire (old /30 bug)", frontCurrent.verdict === "normal" && eq(frontCurrent.baselineWindow, 3000) && eq(frontCurrent.currentWindow, 3000));
const firedDaily = Array.from({ length: 31 }, (_, i) => (i < 15 ? 300 : 0));
const fired = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: baseUniform, currentDaily: firedDaily, coverageStatus: "complete" });
check("anomaly fires on real daily deviation", fired.verdict === "anomaly" && eq(fired.dailyMedian, 100));
const fewDaily = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: baseUniform.slice(0, 2), currentDaily: calmDaily, coverageStatus: "complete" });
check("fewer than 3 comparable months -> insufficient", fewDaily.verdict === "insufficient");
const gapBase = [dailyUniform("2026-07", 31, 100), dailyUniform("2026-08", 31, 100), { month: "2026-09", daily: [...Array(29).fill(100), null], coverage: "complete" }];
const gapCase = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: gapBase, currentDaily: calmDaily, coverageStatus: "complete" });
check("a missing day (not a zero) disqualifies the baseline month", gapCase.verdict === "insufficient");
const zeroBase = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: [dailyUniform("2026-07", 31, 0), dailyUniform("2026-08", 31, 0), dailyUniform("2026-09", 30, 0)], currentDaily: calmDaily, coverageStatus: "complete" });
check("zero baseline -> insufficient", zeroBase.verdict === "insufficient");
const noCov = anomalyV0({ month: "2026-10", asOfDate: "2026-10-15", baselineDaily: baseUniform, currentDaily: calmDaily, coverageStatus: "unknown" });
check("non-complete coverage -> insufficient", noCov.verdict === "insufficient");
// Month-end by actual month length: Feb 28d, leap Feb 29d, 30d, 31d + day-before controls
const kindOf = (month, asOfDate) => anomalyV0({ month, asOfDate, baselineDaily: baseUniform, currentDaily: Array(31).fill(0), coverageStatus: "complete" }).comparisonKind;
check("Feb 2026-02-28 is month-end (28d)", kindOf("2026-02", "2026-02-28") === "month-end");
check("Feb 2026-02-27 is mid-month", kindOf("2026-02", "2026-02-27") === "mid-month-progress");
check("leap Feb 2024-02-29 is month-end (29d)", kindOf("2024-02", "2024-02-29") === "month-end");
check("Apr 2026-04-30 is month-end (30d), 04-29 is not", kindOf("2026-04", "2026-04-30") === "month-end" && kindOf("2026-04", "2026-04-29") === "mid-month-progress");
check("Oct 2026-10-30 is mid-month, 10-31 is month-end (31d)", kindOf("2026-10", "2026-10-30") === "mid-month-progress" && kindOf("2026-10", "2026-10-31") === "month-end");
// Relative-threshold boundary: window daily median 0 -> abs floor 0, so only the rel gate decides
const spikeBase = (month, days) => ({ month, daily: Array.from({ length: days }, (_, i) => (i === 0 ? 1000 : 0)), coverage: "complete" });
const boundaryBase = [spikeBase("2026-07", 31), spikeBase("2026-08", 31), spikeBase("2026-09", 30)];
const atBoundary = anomalyV0({ month: "2026-10", asOfDate: "2026-10-10", baselineDaily: boundaryBase, currentDaily: Array.from({ length: 31 }, (_, i) => (i === 0 ? 1300 : 0)), coverageStatus: "complete" });
check("rel deviation exactly 30% does not fire", atBoundary.verdict === "normal" && eq(atBoundary.relDev, 0.3));
const pastBoundary = anomalyV0({ month: "2026-10", asOfDate: "2026-10-10", baselineDaily: boundaryBase, currentDaily: Array.from({ length: 31 }, (_, i) => (i === 0 ? 1310 : 0)), coverageStatus: "complete" });
check("rel deviation 31% fires when abs floor is 0", pastBoundary.verdict === "anomaly");

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
  monthSummaries: gridMonths.map((m) => ({ month: m, complete: m !== "2026-08" })),
  coverageByMonth: cov([...gridMonths, "2026-10"]),
  baselineDaily: baseUniform,
  currentDaily: Array.from({ length: 31 }, (_, i) => (i < 23 ? 100 : 0)),
});
check("preview net worth card keeps layers + missing", eq(preview.netWorthCard.total, 60000) && preview.netWorthCard.partial && preview.netWorthCard.snapshotRange.newest === "2026-09-30");
check("preview spend card title carries as-of date", preview.spendCard.title.includes("2026-10-23"));
check("preview spend three lines posted/pending/gap", preview.spendCard.lines.map((l) => l.key).join() === "posted,pending,gap" && eq(preview.spendCard.lines[0].amount, 155) && eq(preview.spendCard.lines[1].amount, 45.5) && preview.spendCard.lines[2].complete === true && preview.spendCard.lines[2].coverageStatus === "complete");
check("preview has no fixed/flexible line", !JSON.stringify(preview.spendCard).includes("fixed") && !JSON.stringify(preview.spendCard).includes("flexible"));
check("preview fire card lists missing month, no backfill", preview.fireCard.complete12 === false && preview.fireCard.missingMonths.join() === "2026-08" && preview.fireCard.grid.length === 12);
check("preview anomaly is mid-month progress over daily facts", preview.anomalyCard.comparisonKind === "mid-month-progress" && preview.anomalyCard.verdict === "normal");

console.log(`validate-finance-arch: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
