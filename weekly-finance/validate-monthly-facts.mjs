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
function extractFn(name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`function not found: ${name}`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end)
    .replace("new Map<string, NormalizedMonth[]>()", "new Map()")
    .replace("new Map<string, RawMonth>()", "new Map()")
    .replace(': { investmentContribution: number; transfer: number }', "")
    .replace(': "partial" | "complete" | "unknown"', "")
    .replace(/: Dashboard\["months"\]\[number\]/g, "")
    .replace(/: Dashboard\["months"\]/g, "")
    .replace(/: Dashboard\["fire"\]/g, "")
    .replace(/: MonthNormalization/g, "")
    .replace(/: NormalizedMonth\[\]/g, "")
    .replace(/: NormalizedMonth/g, "")
    .replace(/: RawMonth\[\]/g, "")
    .replace(/: RawMonth/g, "")
    .replace(/: SourceEntry\[\]/g, "")
    .replace(/: PlaidTransaction\[\]/g, "")
    .replace(/: TransactionCoverage/g, "")
    .replace(/: string \| null/g, "")
    .replace(/: number\[\]/g, "")
    .replace(/: boolean/g, "")
    .replace(/: string/g, "")
    .replace(/: number/g, "");
}
const NAMES = [
  "isRealDateKey", "entriesSignature", "normalizeRawMonths", "contribution",
  "monthEnd", "subtractDays", "amountMatches", "transactionSpendForMonth",
  "aggregateMonths", "average", "normalizedFireSpend", "validCompleteMonths",
  "computeFire",
];
const bundle = NAMES.map(extractFn).join("\n");
const api = new Function(`${bundle}; return { ${NAMES.join(", ")} };`)();
const { isRealDateKey, normalizeRawMonths, aggregateMonths, computeFire } = api;

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
check("integrity: finished month with month-end snapshot is complete",
  months[0].integrity === "complete" && (months[0].integrityBasis ?? "").includes("月末快照"));
check("integrity: finished month without coverage basis is unknown, not auto-complete",
  months[1].integrity === "unknown" && months[1].integrityBasis === null);
const covered = aggregateMonths(
  normalizeRawMonths([snap("2026-08-31", 800), snap("2026-09-15", 900)]).months,
  [],
  { start: "2026-09-01", end: "2026-09-30", complete: true },
  AS_OF,
);
check("integrity: full transaction coverage makes a finished month complete",
  covered[1].integrity === "complete" && (covered[1].integrityBasis ?? "").includes("交易覆盖"));
const partialCoverage = aggregateMonths(
  normalizeRawMonths([snap("2026-08-31", 800), snap("2026-09-15", 900)]).months,
  [],
  { start: "2026-09-01", end: "2026-09-30", complete: false },
  AS_OF,
);
check("integrity: incomplete coverage flag does not prove completeness", partialCoverage[1].integrity === "unknown");

// --- FIRE denominator: only valid complete months ---
const fm = (integrity, anomaly, contributionValue, fixed, flexible = 0) => ({
  integrity, flexibleSpendAnomaly: anomaly, contribution: contributionValue,
  fixedSpend: fixed, flexibleSpend: flexible,
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

// --- wiring: ingest gate, shared selection, additive schema ---
check("ingest normalizes before building", src.includes("const normalization = normalizeRawMonths(args.months);"));
check("ingest gates on normalization failure", src.includes("if (!normalization.ok)"));
check("gate preserves prior data and says so", src.includes("已保留上次成功数据，修正后可重新更新"));
check("gate returns the typed issue", src.includes("issue: normalization.issue"));
check("ingest failure branch returns issue:null", src.includes('return { ok: false, savedMonths: 0, issue: null };'));
check("buildDashboard latestRaw is the normalized latest month", src.includes("const latestRaw = normalizedMonths.at(-1);"));
check("buildDashboard no longer re-sorts raw months for latestRaw", !src.includes("const latestRaw = [...rawMonths]"));
check("aggregateMonths consumes the normalized selection", src.includes("function aggregateMonths(\n  normalizedMonths: NormalizedMonth[],"));
check("FIRE computed by the shared computeFire in both paths",
  src.includes("fire: computeFire(months, liveNetWorth)") && src.includes("fire: computeFire(months, dashboard.live.netWorth)"));
check("old completeFireMonths selector is gone", !src.includes("function completeFireMonths"));
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
