// F-ARCH-001 synthetic validation: runs finance-arch.mjs over purely
// synthetic fixtures (high/low/zero months, missing month, cross-month
// refund offset, duplicate IDs, transfer/principal exclusions, mixed
// loan payment unclassified, pending split, unknown account not zero,
// two-layer freshness ranges, anomaly v0 fire/no-fire boundaries).
import { summarizeNetWorth, summarizeSpendMonth, fireEligibleMonths, anomalyV0, buildArchPreview } from "./finance-arch.mjs";

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; } else { failed++; console.log("FAIL:", name); } };
const eq = (a, b) => Math.abs(a - b) < 1e-9;

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
const oct = summarizeSpendMonth(txns, "2026-10");
check("oct posted spend deduped + exclusions", eq(oct.postedSpend, 120 + 60 - 25));
check("oct pending separate", eq(oct.pendingSpend, 45.5));
check("oct complete (no unclassified)", oct.complete === true);
check("oct refund offset traced to october original only", oct.offsets.length === 1 && oct.offsets[0].of === "t7");
const sep = summarizeSpendMonth(txns, "2026-09");
check("sep spend carries cross-month refund offset", eq(sep.postedSpend, 80 - 30) && sep.offsets.length === 1 && sep.offsets[0].refundId === "t6");

// --- Spend: unclassified stays visible, month incomplete
const mixed = summarizeSpendMonth([
  { id: "m1", date: "2026-10-02", amount: -1500, status: "posted", kind: "loan_mixed" },
  { id: "m2", date: "2026-10-03", amount: -100, status: "posted", kind: "spend" },
  { id: "m3", date: "2026-10-04", amount: -700, status: "posted", kind: "unmatched_transfer" },
], "2026-10");
check("mixed loan payment not silently excluded", mixed.unclassified.join() === "m1,m3" && eq(mixed.postedSpend, 100) && mixed.complete === false);

// --- Zero month
const zero = summarizeSpendMonth([], "2026-08");
check("zero month", zero.postedSpend === 0 && zero.complete === true);

// --- FIRE: only ended, complete, covered months; never backfilled
const months = [
  { month: "2026-06", complete: true }, { month: "2026-07", complete: true },
  { month: "2026-08", complete: false }, { month: "2026-09", complete: true },
  { month: "2026-10", complete: true },
];
const fire = fireEligibleMonths(months, { "2026-06": true, "2026-07": true, "2026-08": true, "2026-09": true, "2026-10": true }, "2026-10");
check("fire excludes incomplete + current partial month", fire.eligible.join() === "2026-06,2026-07,2026-09" && fire.complete12 === false && fire.missing.join() === "2026-08");

// --- Anomaly v0 boundaries
const base = [{ spend: 3000 }, { spend: 3200 }, { spend: 3100 }];
const fire1 = anomalyV0({ baselineMonths: base, currentToDate: 2600, currentElapsedDays: 15, coverageOk: true });
check("anomaly fires when rel>30% and abs>7d median", fire1.verdict === "anomaly");
const relOnly = anomalyV0({ baselineMonths: [{ spend: 300 }, { spend: 300 }, { spend: 300 }], currentToDate: 200, currentElapsedDays: 15, coverageOk: true });
check("relative-only deviation does not fire (abs floor)", relOnly.verdict === "normal");
const few = anomalyV0({ baselineMonths: [{ spend: 3000 }, { spend: 3100 }], currentToDate: 9000, currentElapsedDays: 15, coverageOk: true });
check("fewer than 3 comparable months -> insufficient", few.verdict === "insufficient");
const zeroBase = anomalyV0({ baselineMonths: [{ spend: 0 }, { spend: 0 }, { spend: 0 }], currentToDate: 500, currentElapsedDays: 15, coverageOk: true });
check("zero baseline -> insufficient", zeroBase.verdict === "insufficient");
const noCov = anomalyV0({ baselineMonths: base, currentToDate: 9000, currentElapsedDays: 15, coverageOk: false });
check("missing coverage -> insufficient", noCov.verdict === "insufficient");
const calm = anomalyV0({ baselineMonths: base, currentToDate: 1580, currentElapsedDays: 15, coverageOk: true });
check("in-band month -> normal", calm.verdict === "normal");

// --- Anomaly comparison kind: mid-month progress vs month-end total
check("mid-month comparison kind", fire1.comparisonKind === "mid-month-progress");
const monthEnd = anomalyV0({ baselineMonths: base, currentToDate: 3100, currentElapsedDays: 30, coverageOk: true });
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
  coverageByMonth: { "2026-06": true, "2026-07": true, "2026-08": true, "2026-09": true, "2026-10": true },
  baselineMonths: base,
  currentElapsedDays: 23,
});
check("preview net worth card keeps layers + missing", eq(preview.netWorthCard.total, 60000) && preview.netWorthCard.partial && preview.netWorthCard.snapshotRange.newest === "2026-09-30");
check("preview spend card title carries as-of date", preview.spendCard.title.includes("2026-10-23"));
check("preview spend three lines posted/pending/gap", preview.spendCard.lines.map((l) => l.key).join() === "posted,pending,gap" && eq(preview.spendCard.lines[0].amount, 155) && eq(preview.spendCard.lines[1].amount, 45.5) && preview.spendCard.lines[2].complete === true);
check("preview has no fixed/flexible line", !JSON.stringify(preview.spendCard).includes("fixed") && !JSON.stringify(preview.spendCard).includes("flexible"));
check("preview fire card lists missing month, no backfill", preview.fireCard.complete12 === false && preview.fireCard.missingMonths.join() === "2026-08");
check("preview anomaly is mid-month progress", preview.anomalyCard.comparisonKind === "mid-month-progress");

console.log(`validate-finance-arch: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
