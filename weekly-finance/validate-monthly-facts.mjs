// F0.3 / F0.4 validation: monthly facts are unique per calendar month,
// dates are strict real calendar dates, same-day conflicts are input
// problems (never silently resolved), integrity is partial / complete
// (with a coverage basis) / unknown, and FIRE consumes only valid
// complete months. Behaviour runs against the real pure functions
// extracted from server/src/actions.ts (type annotations stripped
// mechanically); wiring assertions run against the real source text.
// All fixtures are synthetic.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real server pipeline functions ---
// F0.6: extraction now goes through the TypeScript transpiler's AST
// (per-function source -> transpile) instead of string replacement,
// so new type annotations in the cashflow pipeline cannot silently
// break the harness.
import ts from "typescript";
const sourceFile = ts.createSourceFile("actions.ts", src, ts.ScriptTarget.ES2022, true);
function extractFn(name) {
  for (const node of sourceFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      return ts.transpileModule(node.getText(sourceFile), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
    }
  }
  throw new Error(`function not found: ${name}`);
}
const NAMES = [
  "isRealDateKey", "entriesSignature", "normalizeRawMonths", "resolveContribution",
  "cashflowRoleForEntry", "snapshotCaliber", "isConsecutiveMonth",
  "monthEnd", "amountMatches", "transactionSpendForMonth",
  "aggregateMonths", "average", "normalizedFireSpend", "validCompleteMonths",
  "computeFire", "recomputeInvestmentReturns", "computeInvestmentPerformance",
  "normalizeStoredIntegrity", "normalizeFireMetrics",
];
const bundle = NAMES.map(extractFn).join("\n");
const api = new Function(`${bundle}; return { ${NAMES.join(", ")} };`)();
const { isRealDateKey, normalizeRawMonths, aggregateMonths, computeFire, normalizeFireMetrics } = api;

// --- fixtures (synthetic) ---
const E = (financeSource, type, number) => ({ financeSource, type, number });
const snap = (key, saving, extra = []) => ({
  key,
  entries: [
    E("bank_1234", "account", saving),
    E("salary", "income", 5000),
    E("rent", "fixed_spend", 2000),
    ...extra,
  ],
});
const AS_OF = "2026-10-17T12:00:00-07:00";

// --- strict calendar dates ---
check("leap day 2024-02-29 is real", isRealDateKey("2024-02-29") === true);
check("2026-02-29 is not real (non-leap year)", isRealDateKey("2026-02-29") === false);
check("2026-02-30 is not real and must not roll into March", isRealDateKey("2026-02-30") === false);
check("2026-04-31 is not real", isRealDateKey("2026-04-31") === false);
check("2026-13-01 is not real", isRealDateKey("2026-13-01") === false);
check("2026-12-31 is real", isRealDateKey("2026-12-31") === true);
check("non-padded date rejected", isRealDateKey("2026-1-1") === false);
// mutation sensitivity: Date.UTC rolls Feb 30 into March, so a
// rollover-based check accepts it; the strict check must not.
const rolled = new Date(Date.UTC(2026, 1, 30));
check("mutation: Date.UTC rollover lands in March (the old failure mode)", rolled.getUTCMonth() === 2 && isRealDateKey("2026-02-30") === false);

// --- normalization: ordering, same-month collapse, superseded count ---
const unordered = normalizeRawMonths([snap("2026-09-30", 900), snap("2026-08-15", 700), snap("2026-08-31", 800)]);
check("normalize: out-of-order input ok", unordered.ok === true);
check("normalize: one point per month, ascending snapshot dates",
  unordered.ok && unordered.months.map((m) => m.key).join(",") === "2026-08-31,2026-09-30");
check("normalize: same-month earlier snapshot counted as superseded",
  unordered.ok && unordered.months[0].supersededSnapshots === 1 && unordered.months[1].supersededSnapshots === 0);
const crossYear = normalizeRawMonths([snap("2026-01-31", 100), snap("2025-12-31", 90), snap("2026-01-15", 95)]);
check("normalize: cross-month/cross-year grouping keeps latest per month",
  crossYear.ok && crossYear.months.map((m) => m.key).join(",") === "2025-12-31,2026-01-31"
  && crossYear.months[1].supersededSnapshots === 1);

// --- normalization: invalid dates are input problems ---
const badDate = normalizeRawMonths([snap("2026-08-31", 800), snap("2026-02-30", 1)]);
check("normalize: invalid date rejected", badDate.ok === false);
check("normalize: issue names the date and the category only",
  badDate.ok === false && badDate.issue.includes("2026-02-30") && badDate.issue.includes("不是真实日历日期"));
check("normalize: issue never echoes entry values",
  badDate.ok === false && !badDate.issue.includes("800") && !badDate.issue.includes("bank"));
const badLeap = normalizeRawMonths([snap("2025-02-29", 1)]);
check("normalize: 2025-02-29 rejected", badLeap.ok === false);
const goodLeap = normalizeRawMonths([snap("2024-02-29", 1)]);
check("normalize: 2024-02-29 accepted", goodLeap.ok === true && goodLeap.months[0].key === "2024-02-29");

// --- normalization: same-day duplicates ---
const reordered = {
  key: "2026-08-31",
  entries: [E("rent", "fixed_spend", 2000), E("salary", "income", 5000), E("bank_1234", "account", 800)],
};
const deduped = normalizeRawMonths([snap("2026-08-31", 800), reordered]);
check("normalize: identical same-day snapshots dedupe (entry order irrelevant)",
  deduped.ok === true && deduped.months.length === 1 && deduped.months[0].supersededSnapshots === 0);
const conflict = normalizeRawMonths([snap("2026-08-31", 800), snap("2026-08-31", 801)]);
check("normalize: conflicting same-day snapshots rejected, not picked or summed", conflict.ok === false);
check("normalize: conflict issue names date + category",
  conflict.ok === false && conflict.issue.includes("2026-08-31") && conflict.issue.includes("不一致"));

// --- aggregation: one point per month, integrity stamping ---
const normalized = normalizeRawMonths([
  snap("2026-08-31", 800), snap("2026-09-15", 900), snap("2026-10-05", 950),
]);
check("aggregate precondition: normalization ok", normalized.ok === true);
const months = aggregateMonths(normalized.months, [], null, AS_OF);
check("aggregate: exactly one point per month", months.length === 3 && months.map((m) => m.key).join(",") === "2026-08-31,2026-09-15,2026-10-05");
check("aggregate: snapshotDate is the chosen snapshot date", months[1].snapshotDate === "2026-09-15");
check("integrity: current month is always partial", months[2].integrity === "partial");
check("integrity: month-end snapshot alone is NOT complete (date proves no coverage)",
  months[0].integrity === "unknown" && (months[0].integrityBasis ?? "").includes("缺少支出依据"));
check("integrity: finished month without coverage basis is unknown, not auto-complete",
  months[1].integrity === "unknown" && months[1].spendProven === false);
const covered = aggregateMonths(
  normalizeRawMonths([snap("2026-08-31", 800), snap("2026-09-15", 900)]).months,
  [],
  { start: "2026-09-01", end: "2026-09-30", complete: true },
  AS_OF,
);
check("integrity: full transaction coverage alone is NOT complete for a mid-month snapshot",
  covered[1].integrity === "unknown" && covered[1].spendProven === false);
const coveredMonthEnd = aggregateMonths(
  normalizeRawMonths([snap("2026-08-31", 800), snap("2026-09-30", 900)]).months,
  [],
  { start: "2026-09-01", end: "2026-09-30", complete: true },
  AS_OF,
);
check("integrity: month-end + coverage + income but NO contribution entry is NOT complete",
  coveredMonthEnd[1].integrity === "unknown"
  && coveredMonthEnd[1].spendProven === true
  && coveredMonthEnd[1].incomeProven === true
  && coveredMonthEnd[1].contributionProven === false
  && (coveredMonthEnd[1].integrityBasis ?? "").includes("缺少投入依据"));
const fullMonth = aggregateMonths(
  normalizeRawMonths([
    snap("2026-08-31", 800),
    snap("2026-09-30", 900, [E("broker", "investment_contribution", 1500)]),
  ]).months,
  [],
  { start: "2026-09-01", end: "2026-09-30", complete: true },
  AS_OF,
);
check("integrity: month-end + full coverage + income + contribution entries is complete",
  fullMonth[1].integrity === "complete"
  && fullMonth[1].spendProven === true && fullMonth[1].incomeProven === true && fullMonth[1].contributionProven === true
  && (fullMonth[1].integrityBasis ?? "").includes("月末快照")
  && (fullMonth[1].integrityBasis ?? "").includes("含收入条目")
  && (fullMonth[1].integrityBasis ?? "").includes("含投入条目"));
// PM 21:00 repro: balance-only snapshots (a single account entry, no
// income / contribution entries at all) at month-end WITH full
// transaction coverage must not be promoted to complete — missing flows
// are 未提供, never proven zeros entering FIRE as contribution 0.
const balanceOnly = aggregateMonths(
  normalizeRawMonths([
    { key: "2026-06-30", entries: [E("bank_1234", "account", 5000)] },
    { key: "2026-07-31", entries: [E("bank_1234", "account", 6000)] },
    { key: "2026-08-31", entries: [E("bank_1234", "account", 7000)] },
    snap("2026-10-05", 950),
  ]).months,
  [],
  { start: "2026-06-01", end: "2026-08-31", complete: true },
  AS_OF,
);
check("integrity (PM 21:00 repro): balance-only month-end months stay unknown",
  balanceOnly.slice(0, 3).every((m) => m.integrity === "unknown"));
check("provenance (PM 21:00 repro): spend proven, income/contribution unproven for balance-only months",
  balanceOnly.slice(0, 3).every((m) => m.spendProven === true && m.incomeProven === false && m.contributionProven === false));
const balanceOnlyFire = computeFire(balanceOnly.slice(0, 3), 750000);
check("FIRE (PM 21:00 repro): balance-only months never enter the denominator as 0 contribution",
  balanceOnlyFire.completeMonthsUsed === 0 && balanceOnlyFire.annualContribution === 0 && balanceOnlyFire.target === 0);
const emptyMonths = aggregateMonths(
  normalizeRawMonths([
    { key: "2026-06-30", entries: [] },
    { key: "2026-07-31", entries: [] },
    { key: "2026-08-31", entries: [] },
    snap("2026-10-05", 950),
  ]).months,
  [],
  null,
  AS_OF,
);
check("integrity (PM repro): empty month-end snapshots without coverage stay unknown",
  emptyMonths.slice(0, 3).every((m) => m.integrity === "unknown"));
const emptyFire = computeFire(emptyMonths.slice(0, 3), 750000);
check("FIRE (PM repro): no-basis months never enter the denominator",
  emptyFire.completeMonthsUsed === 0 && emptyFire.target === 0 && emptyFire.progress === null);
const partialCoverage = aggregateMonths(
  normalizeRawMonths([snap("2026-08-31", 800), snap("2026-09-15", 900)]).months,
  [],
  { start: "2026-09-01", end: "2026-09-30", complete: false },
  AS_OF,
);
check("integrity: incomplete coverage flag does not prove completeness", partialCoverage[1].integrity === "unknown");

// --- FIRE denominator: only valid complete months ---
// F0.4: a legitimate complete fixture month carries all three
// provenance flags true — the stamp alone no longer qualifies.
const fm = (integrity, anomaly, contributionValue, fixed, flexible = 0) => ({
  integrity, flexibleSpendAnomaly: anomaly, contribution: contributionValue,
  fixedSpend: fixed, flexibleSpend: flexible,
  spendProven: true, incomeProven: true, contributionProven: true,
});
const fireMonths = [
  fm("complete", false, 1000, 3000),
  fm("complete", true, 9000, 9000),
  fm("unknown", false, 9000, 9000),
  fm("partial", false, 9000, 9000),
  fm("complete", false, 2000, 5000),
  fm("complete", false, 3000, 7000),
];
const fire = computeFire(fireMonths, 750000);
check("FIRE: denominator counts valid complete months only", fire.completeMonthsUsed === 3);
check("FIRE: annual contribution averaged over valid complete months", fire.annualContribution === 24000);
check("FIRE: annual spend averaged over valid complete months", fire.annualSpend === 60000);
check("FIRE: target = annual spend / 4%", fire.target === 1500000);
check("FIRE: progress and gap derive from the same denominator", fire.progress === 0.5 && fire.gap === 750000);
const fireNone = computeFire([fm("unknown", false, 1000, 3000), fm("partial", false, 1000, 3000)], 750000);
check("FIRE: no valid months -> no target, progress null (never 0-filled)",
  fireNone.completeMonthsUsed === 0 && fireNone.target === 0 && fireNone.progress === null && fireNone.annualSpend === 0);
const fireMany = computeFire(Array.from({ length: 13 }, () => fm("complete", false, 100, 100)), 0);
check("FIRE: trailing window caps at 12 valid complete months", fireMany.completeMonthsUsed === 12);

// --- F0.4 legacy payload: "complete" stamp without provenance ---
// An older writer stamped these months complete while all three
// provenance flags are false (the old schema default). They must
// neither enter the FIRE denominator nor keep the complete stamp
// on the read path.
const unproven = (overrides = {}) => ({
  integrity: "complete", flexibleSpendAnomaly: false, contribution: 1000,
  fixedSpend: 3000, flexibleSpend: 0,
  spendProven: false, incomeProven: false, contributionProven: false,
  ...overrides,
});
const fireUnproven = computeFire([
  unproven(), unproven(), unproven(),
], 750000);
check("FIRE: legacy complete stamp with all flags false never enters the denominator",
  fireUnproven.completeMonthsUsed === 0 && fireUnproven.target === 0 && fireUnproven.progress === null);
const firePartiallyProven = computeFire([
  unproven({ spendProven: true, incomeProven: true }),
  unproven({ spendProven: true, contributionProven: true }),
  unproven({ incomeProven: true, contributionProven: true }),
], 750000);
check("FIRE: complete stamp with any one flag missing is still not a valid month",
  firePartiallyProven.completeMonthsUsed === 0);
const flagless = { integrity: "complete", flexibleSpendAnomaly: false, contribution: 1000, fixedSpend: 3000, flexibleSpend: 0 };
check("FIRE: complete stamp with flags absent entirely is not a valid month",
  computeFire([flagless], 750000).completeMonthsUsed === 0);
const fireMixedProvenance = computeFire([
  unproven(),
  fm("complete", false, 2000, 5000),
], 750000);
check("FIRE: proven and unproven complete stamps are separated (only proven counts)",
  fireMixedProvenance.completeMonthsUsed === 1 && fireMixedProvenance.annualContribution === 24000);

// --- read path: normalizeFireMetrics downgrades unproven stamps ---
const storedMonth = (key, overrides = {}) => ({
  key,
  investment: 100000, deposits: 50000, loans: 0, netWorth: 150000,
  income: 5000, fixedSpend: 3000, flexibleSpend: 2000,
  flexibleSpendSource: "recorded", flexibleSpendAnomaly: false,
  totalSpend: 5000, contribution: 1500, contributionSource: "standard",
  investmentExternalAdjustment: 0, cashCreditNet: 0, entryMeta: [],
  snapshotDate: key, supersededSnapshots: 0, anomalyReason: null,
  cashflowDifference: null, cashflowNote: null,
  investmentReturn: null, investmentNetFlow: null, investmentReturnReason: null,
  integrity: "complete",
  integrityBasis: "支出：月末快照＋交易全覆盖；收入：含收入条目；投入：含投入条目",
  spendProven: false, incomeProven: false, contributionProven: false,
  ...overrides,
});
const flagsAbsent = storedMonth("2026-07-31", { income: 6000, contribution: 2500 });
delete flagsAbsent.spendProven;
delete flagsAbsent.incomeProven;
delete flagsAbsent.contributionProven;
const legacyDashboard = {
  months: [
    storedMonth("2026-06-30"),
    flagsAbsent,
    storedMonth("2026-08-31", { spendProven: true, incomeProven: true }),
    storedMonth("2026-09-30", {
      spendProven: true, incomeProven: true, contributionProven: true,
    }),
    storedMonth("2026-10-31", { integrity: "partial", integrityBasis: "当月尚未结束，快照截至 2026-10-31" }),
    storedMonth("2026-11-30", { integrity: "unknown", integrityBasis: "缺少支出依据" }),
  ],
  live: { netWorth: 750000, investment: 375000 },
};
const readBack = normalizeFireMetrics(legacyDashboard);
check("read path: complete stamp with all flags false downgrades to unknown",
  readBack.months[0].integrity === "unknown");
check("read path: downgrade basis names every missing basis and the 未提供 treatment",
  (readBack.months[0].integrityBasis ?? "").includes("旧存档完整标记缺少支出依据、收入依据、投入依据")
  && (readBack.months[0].integrityBasis ?? "").includes("按完整性未提供处理"));
check("read path: complete stamp with flags absent entirely downgrades to unknown",
  readBack.months[1].integrity === "unknown"
  && (readBack.months[1].integrityBasis ?? "").includes("缺少支出依据、收入依据、投入依据"));
check("read path: downgrade basis names only the bases actually missing",
  readBack.months[2].integrity === "unknown"
  && (readBack.months[2].integrityBasis ?? "").includes("缺少投入依据")
  && !(readBack.months[2].integrityBasis ?? "").includes("支出依据")
  && !(readBack.months[2].integrityBasis ?? "").includes("收入依据"));
check("read path: fully proven complete month keeps its stamp and original basis",
  readBack.months[3].integrity === "complete"
  && (readBack.months[3].integrityBasis ?? "").includes("月末快照"));
check("read path: partial and unknown months pass through unchanged",
  readBack.months[4].integrity === "partial" && readBack.months[4].integrityBasis === "当月尚未结束，快照截至 2026-10-31"
  && readBack.months[5].integrity === "unknown" && readBack.months[5].integrityBasis === "缺少支出依据");
check("read path: downgrade preserves the month's numeric facts exactly",
  readBack.months[0].income === 5000 && readBack.months[0].fixedSpend === 3000
  && readBack.months[0].flexibleSpend === 2000 && readBack.months[0].contribution === 1500
  && readBack.months[0].investment === 100000 && readBack.months[0].netWorth === 150000
  && readBack.months[1].income === 6000 && readBack.months[1].contribution === 2500);
check("read path: FIRE denominator counts only the fully proven complete month",
  readBack.fire.completeMonthsUsed === 1 && readBack.fire.annualContribution === 18000
  && readBack.fire.annualSpend === 60000);
check("read path (F1.6 rework): FIRE progress uses live.investment as principal (375000 / 1500000 = 0.25), not net worth",
  readBack.fire.progress === 0.25 && readBack.fire.gap === 1125000);
const readBackNetWorthMoved = normalizeFireMetrics({ ...legacyDashboard, live: { netWorth: 999999, investment: 375000 } });
check("read path (F1.6 rework): moving net worth alone never moves FIRE progress",
  readBackNetWorthMoved.fire.progress === readBack.fire.progress
  && readBackNetWorthMoved.fire.gap === readBack.fire.gap);

// --- wiring: ingest gate, shared selection, additive schema ---
check("ingest normalizes before building", src.includes("const normalization = normalizeRawMonths(args.months);"));
check("ingest gates on normalization failure", src.includes("if (!normalization.ok)"));
check("gate preserves prior data and says so", src.includes("已保留上次成功数据，修正后可重新更新"));
check("gate returns the typed issue", src.includes("issue: normalization.issue"));
check("ingest failure branch returns issue:null", src.includes('return { ok: false, savedMonths: 0, issue: null };'));
check("buildDashboard latestRaw is the normalized latest month", src.includes("const latestRaw = normalizedMonths.at(-1);"));
check("buildDashboard no longer re-sorts raw months for latestRaw", !src.includes("const latestRaw = [...rawMonths]"));
check("aggregateMonths consumes the normalized selection", src.includes("function aggregateMonths(\n  normalizedMonths: NormalizedMonth[],"));
check("FIRE computed by the shared computeFire in both paths (F1.6 rework: investment principal, not net worth)",
  src.includes("fire: computeFire(months, liveInvestment)") && src.includes("fire: computeFire(reconciled, dashboard.live.investment)"));
check("old completeFireMonths selector is gone", !src.includes("function completeFireMonths"));
check("FIRE guard: validCompleteMonths requires all three provenance flags, not the stamp alone",
  src.includes("month.spendProven === true") && src.includes("month.incomeProven === true")
  && src.includes("month.contributionProven === true"));
check("read path: stored-integrity normalization runs inside normalizeFireMetrics",
  src.includes("const month = normalizeStoredIntegrity(storedMonth);"));
check("schema: integrity additive with honest unknown default",
  src.includes('integrity: z.enum(["partial", "complete", "unknown"]).default("unknown")'));
check("schema: supersededSnapshots additive default 0",
  src.includes("supersededSnapshots: z.number().int().nonnegative().default(0)"));
check("schema: snapshotDate additive default empty",
  src.includes('snapshotDate: z.string().default("")'));
check("schema: fire.completeMonthsUsed additive default 0",
  src.includes("completeMonthsUsed: z.number().int().nonnegative().default(0)"));
check("schema: ingest issue is additive and nullable",
  src.includes("issue: z.string().nullable().default(null)"));

console.log(`validate-monthly-facts: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
