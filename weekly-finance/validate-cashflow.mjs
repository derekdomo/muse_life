// F0.6 validation: Life cashflow reconciliation aligned with the
// current Firance cashflow rules.
// - the standard investment_contribution field wins by existence:
//   an explicit 0 never falls back to the legacy transfer alias,
//   matching values are never summed, conflicts degrade.
// - flexible spend: recorded values win as-is (true 0 and negative
//   net refunds preserved); full-coverage transactions come next;
//   otherwise only the cash + credit balance identity may estimate
//   it (loan principal, HSA and bond valuation changes excluded).
// - every ineligible back-calculation is null with a named reason
//   (and the preserved difference for a negative result) — never
//   clamped to 0, and a balance date never proves coverage.
// Behaviour runs against the REAL production functions extracted
// from server/src/actions.ts via the TypeScript AST (transpiled
// per function); wiring assertions run against the real source
// text of the server and the client. All fixtures are synthetic.
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

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
  "computeFire", "normalizeStoredIntegrity", "normalizeFireMetrics",
  "recomputeInvestmentReturns", "computeInvestmentPerformance",
];
const bundle = NAMES.map(extractFn).join("\n");
const api = new Function(`${bundle}; return { ${NAMES.join(", ")} };`)();
const {
  normalizeRawMonths, resolveContribution, cashflowRoleForEntry,
  aggregateMonths, normalizeFireMetrics,
} = api;

// --- fixtures (synthetic) ---
const E = (financeSource, type, number, extraFields = {}) => ({ financeSource, type, number, ...extraFields });
const AS_OF = "2026-10-17T12:00:00-07:00";
function agg(rawMonths, transactions = [], coverage = null) {
  const normalized = normalizeRawMonths(rawMonths);
  if (!normalized.ok) throw new Error(`fixture failed to normalize: ${normalized.issue}`);
  return aggregateMonths(normalized.months, transactions, coverage, AS_OF);
}
const cashPair = (augCash, sepCash, sepExtra = [], augExtra = []) => ([
  { key: "2026-08-31", entries: [E("bank_1234", "account", augCash), ...augExtra] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_1234", "account", sepCash),
      E("salary", "income", 1000),
      E("rent", "fixed_spend", 300),
      ...sepExtra,
    ],
  },
]);

// --- contribution resolution: existence, not truthiness ---
check("contribution: standard only", resolveContribution([E("b", "investment_contribution", 250)]).value === 250
  && resolveContribution([E("b", "investment_contribution", 250)]).source === "standard");
const explicitZero = resolveContribution([E("b", "investment_contribution", 0), E("t", "transfer", 100)]);
check("contribution: explicit standard 0 never falls back to transfer 100 (value stays 0, degraded)",
  explicitZero.value === 0 && explicitZero.source === "conflict");
const matchingPair = resolveContribution([E("b", "investment_contribution", 100), E("t", "transfer", 100)]);
check("contribution: matching standard + alias used once, never summed",
  matchingPair.value === 100 && matchingPair.source === "standard");
const conflictingPair = resolveContribution([E("b", "investment_contribution", 100), E("t", "transfer", 999)]);
check("contribution: conflicting standard + alias degrades to conflict (standard kept)",
  conflictingPair.value === 100 && conflictingPair.source === "conflict");
check("contribution: alias only resolves as alias", resolveContribution([E("t", "transfer", 100)]).source === "alias");
check("contribution: neither field is missing, not a proven 0",
  resolveContribution([E("s", "income", 5)]).source === "missing");

// --- classification: loan principal / HSA / bonds stay out ---
check("role: explicit cashflow_role wins", cashflowRoleForEntry(E("anything", "account", 5, { cashflowRole: "credit" })) === "credit");
check("role: HSA is non_cash", cashflowRoleForEntry(E("fidelity_hsa_1234", "account", 5000)) === "non_cash");
check("role: bonds are non_cash", cashflowRoleForEntry(E("bonds", "account", 8000)) === "non_cash");
check("role: mortgage is debt", cashflowRoleForEntry(E("mortgage_9999", "account", -10000)) === "debt");
check("role: credit card is credit", cashflowRoleForEntry(E("usbank_cc", "account", -500)) === "credit");
check("role: positive bank account is cash", cashflowRoleForEntry(E("bank_1234", "account", 1000)) === "cash");
check("role: non-account entries carry no inferred role", cashflowRoleForEntry(E("salary", "income", 1000)) === null);

// --- the fixed verification case from the plan ---
// cash 1000 -> 1200, loan -10000 -> -9500, income 1000, fixed 300,
// contribution 100. The old all-account identity gives -100; the
// cash-only identity must give 400.
const fixedCase = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000), E("mortgage_9999", "account", -10000)] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_1234", "account", 1200), E("mortgage_9999", "account", -9500),
      E("salary", "income", 1000), E("rent", "fixed_spend", 300),
      E("broker", "investment_contribution", 100),
    ],
  },
]);
const oldAllAccount = 1000 - 100 - 300 - ((1200 - 9500) - (1000 - 10000));
check("fixed case: old all-account identity indeed gives -100 (the bug)", oldAllAccount === -100);
check("fixed case: cash-only identity gives 400", fixedCase[1].flexibleSpend === 400);
check("fixed case: source is estimated with the formula recorded",
  fixedCase[1].flexibleSpendSource === "estimated" && (fixedCase[1].cashflowNote ?? "").includes("现金/信用卡净余额变化 200"));
check("fixed case: loan principal change (500) not counted as spend",
  fixedCase[1].cashCreditNet === 1200 && fixedCase[1].flexibleSpendAnomaly === false);
check("fixed case: first month has no back-calculation (null + reason, not 0)",
  fixedCase[0].flexibleSpend === null && fixedCase[0].flexibleSpendSource === "missing"
  && (fixedCase[0].anomalyReason ?? "").includes("缺少上月快照"));

// --- explicit 0 contribution flows through the whole pipeline ---
const zeroContribution = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 0), E("old", "transfer", 100)]));
check("pipeline: explicit 0 + legacy transfer 100 -> contribution 0 used (no fallback)",
  zeroContribution[1].contribution === 0 && zeroContribution[1].contributionSource === "conflict");
check("pipeline: flexible reflects contribution 0 (1000-0-300-200=500)", zeroContribution[1].flexibleSpend === 500);
const conflictMonth = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 100), E("old", "transfer", 999)]));
check("pipeline: conflict degrades provenance, standard value governs, note flags 待核对",
  conflictMonth[1].contribution === 100 && conflictMonth[1].contributionSource === "conflict"
  && conflictMonth[1].flexibleSpend === 400 && conflictMonth[1].contributionProven === false
  && (conflictMonth[1].cashflowNote ?? "").includes("冲突"));

// --- recorded flexible spend wins, true 0 and net refunds kept ---
const recordedZero = agg([{ key: "2026-09-30", entries: [E("flex", "flexible_spend", 0), E("rent", "fixed_spend", 300)] }]);
check("recorded: true 0 kept as a real 0, not missing",
  recordedZero[0].flexibleSpend === 0 && recordedZero[0].flexibleSpendSource === "recorded"
  && recordedZero[0].flexibleSpendAnomaly === false && recordedZero[0].totalSpend === 300);
const recordedRefund = agg([{ key: "2026-09-30", entries: [E("flex", "flexible_spend", -150), E("rent", "fixed_spend", 300)] }]);
check("recorded: net refund (-150) preserved, never clamped",
  recordedRefund[0].flexibleSpend === -150 && recordedRefund[0].totalSpend === 150
  && recordedRefund[0].flexibleSpendAnomaly === false);
const recordedBeatsEstimate = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 100), E("flex", "flexible_spend", 777)]));
check("recorded: recorded value beats the back-calculation", recordedBeatsEstimate[1].flexibleSpend === 777);

// --- credit card spend counts; repayment / internal transfer does not ---
const cardSpend = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000), E("bank_cc", "account", -500)] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_1234", "account", 1000), E("bank_cc", "account", -700),
      E("salary", "income", 1000), E("rent", "fixed_spend", 300),
      E("broker", "investment_contribution", 100),
    ],
  },
]);
check("credit: card balance drop (-200 net) counts as spend (flexible 800)", cardSpend[1].flexibleSpend === 800);
const repayment = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 2000), E("bank_cc", "account", -1000)] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_1234", "account", 1500), E("bank_cc", "account", -500),
      E("salary", "income", 1000), E("rent", "fixed_spend", 300),
      E("broker", "investment_contribution", 100),
    ],
  },
]);
check("credit: repayment moves cash->card with net change 0, creating no spend by itself",
  repayment[1].cashCreditNet === 1000 && repayment[0].cashCreditNet === 1000 && repayment[1].flexibleSpend === 600);

// --- HSA / external adjustments never enter the spend identity ---
const hsaCase = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000), E("fidelity_hsa_1234", "account", 5000)] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_1234", "account", 1200), E("fidelity_hsa_1234", "account", 5500),
      E("salary", "income", 1000), E("rent", "fixed_spend", 300),
      E("broker", "investment_contribution", 100),
      E("rsu", "investment_external_adjustment", 5000),
      E("refund", "cashflow_adjustment", 0),
    ],
  },
]);
check("HSA: +500 valuation change excluded from spend (flexible still 400)", hsaCase[1].flexibleSpend === 400);
check("external adjustment: preserved on the month, not counted as cash contribution",
  hsaCase[1].investmentExternalAdjustment === 5000 && hsaCase[1].contribution === 100);
const adjustmentCase = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 100), E("refund", "cashflow_adjustment", 200)]));
check("cashflow_adjustment: other net inflow enters the identity (1000+200-100-300-200=600)",
  adjustmentCase[1].flexibleSpend === 600);

// --- ineligible back-calculations: null + reason, never 0 ---
const gapCase = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000)] },
  {
    key: "2026-10-31",
    entries: [
      E("bank_1234", "account", 1200), E("salary", "income", 1000),
      E("rent", "fixed_spend", 300), E("broker", "investment_contribution", 100),
    ],
  },
]);
check("gap: missing month -> null with 缺月 reason",
  gapCase[1].flexibleSpend === null && (gapCase[1].anomalyReason ?? "").includes("缺月"));
const renamedCase = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000)] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_9999", "account", 1200), E("salary", "income", 1000),
      E("rent", "fixed_spend", 300), E("broker", "investment_contribution", 100),
    ],
  },
]);
check("scope: renamed cash source -> null with 范围变化 reason",
  renamedCase[1].flexibleSpend === null && (renamedCase[1].anomalyReason ?? "").includes("范围变化"));
const staleCase = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 100)],
  []).map((m, i) => i === 0 ? m : {
    ...m,
    entries: m.entries.map((e) => e.type === "account" ? { ...e, balanceDate: "2026-08-31" } : e),
  }));
check("stale: carried-over balance_date -> null with 沿用旧余额日期 reason",
  staleCase[1].flexibleSpend === null && (staleCase[1].anomalyReason ?? "").includes("沿用旧余额日期"));
const negativeCase = agg(cashPair(1000, 1000, [E("broker", "investment_contribution", 100)]).map((m, i) => i === 0 ? m : {
  ...m,
  entries: m.entries.map((e) => e.type === "income" ? { ...e, number: 100 } : e),
}));
check("negative: back-calculation -300 -> null, difference preserved, not clamped",
  negativeCase[1].flexibleSpend === null && negativeCase[1].cashflowDifference === -300
  && (negativeCase[1].anomalyReason ?? "").includes("负数"));
const invalidCase = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 100)]).map((m, i) => i === 0 ? m : {
  ...m,
  entries: [...m.entries, E("bad", "cashflow_adjustment", Number.NaN)],
}));
check("invalid: non-finite amount -> null with 无效金额 reason",
  invalidCase[1].flexibleSpend === null && (invalidCase[1].anomalyReason ?? "").includes("无效金额"));
const noIncome = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000)] },
  {
    key: "2026-09-30",
    entries: [E("bank_1234", "account", 1200), E("rent", "fixed_spend", 300), E("broker", "investment_contribution", 100)],
  },
]);
check("incomplete: missing income entry -> null （收支不齐）",
  noIncome[1].flexibleSpend === null && (noIncome[1].anomalyReason ?? "").includes("缺少收入记录"));

// --- snapshot caliber: YYYY-MM keys, first-day boundary ---
const monthOnly = normalizeRawMonths([{ key: "2026-08", entries: [E("bank_1234", "account", 1000)] }]);
check("caliber: YYYY-MM key normalizes to the month-end date",
  monthOnly.ok === true && monthOnly.months[0].key === "2026-08-31" && monthOnly.months[0].snapshotCaliber === "month_end");
const monthOnlyDedupe = normalizeRawMonths([
  { key: "2026-08", entries: [E("bank_1234", "account", 1000)] },
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000)] },
]);
check("caliber: YYYY-MM and identical YYYY-MM-31 snapshots dedupe to one",
  monthOnlyDedupe.ok === true && monthOnlyDedupe.months.length === 1);
const monthOnlyConflict = normalizeRawMonths([
  { key: "2026-08", entries: [E("bank_1234", "account", 1000)] },
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1001)] },
]);
check("caliber: YYYY-MM vs different month-end snapshot is a conflict, not a pick",
  monthOnlyConflict.ok === false);
const firstDay = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000)] },
  {
    key: "2026-09-01",
    entries: [
      E("bank_1234", "account", 1200), E("salary", "income", 1000),
      E("rent", "fixed_spend", 300), E("broker", "investment_contribution", 100),
    ],
  },
]);
check("caliber: first-day (month_start) snapshot cannot back-calculate against month-end",
  firstDay[1].flexibleSpend === null && (firstDay[1].anomalyReason ?? "").includes("口径不一致"));
const badMonthKey = normalizeRawMonths([{ key: "2026-13", entries: [] }]);
check("caliber: YYYY-13 rejected as not a real calendar month", badMonthKey.ok === false);

// --- extended fields survive ingest -> aggregate, and metadata is identity ---
const extended = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000, { cashflowRole: "cash", balanceDate: "2026-08-31" })] },
  {
    key: "2026-09-30",
    entries: [
      E("bank_1234", "account", 1200, { cashflowRole: "cash", balanceDate: "2026-09-30", status: "同步读取", verified: true }),
      E("salary", "income", 1000), E("rent", "fixed_spend", 300),
      E("broker", "investment_contribution", 100, { periodStart: "2026-09-01", periodEnd: "2026-09-30", verified: true, status: "已核实" }),
    ],
  },
]);
const sepMeta = Object.fromEntries(extended[1].entryMeta.map((m) => [m.financeSource, m]));
check("extended: classification + balance date preserved on the month",
  sepMeta.bank_1234.cashflowRole === "cash" && sepMeta.bank_1234.balanceDate === "2026-09-30" && sepMeta.bank_1234.status === "同步读取");
check("extended: contribution period + verification metadata preserved",
  sepMeta.broker.periodStart === "2026-09-01" && sepMeta.broker.periodEnd === "2026-09-30" && sepMeta.broker.verified === true);
const metaConflict = normalizeRawMonths([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000, { balanceDate: "2026-08-31" })] },
  { key: "2026-08-31", entries: [E("bank_1234", "account", 1000, { balanceDate: "2026-08-30" })] },
]);
check("extended: same-day snapshots differing only in metadata conflict (not deduped)",
  metaConflict.ok === false);

// --- transaction path still outranks the estimate, recorded outranks both ---
const txCase = agg(
  cashPair(1000, 5000, [E("broker", "investment_contribution", 100)]),
  [{ date: "2026-09-10", amount: 900, name: "store", pending: false, internalTransfer: false, transferLike: false }],
  { start: "2026-09-01", end: "2026-09-30", complete: true },
);
check("transactions: full-coverage actuals beat the balance identity (900-300=600)",
  txCase[1].flexibleSpend === 600 && txCase[1].flexibleSpendSource === "recorded");
check("transactions: full coverage + month-end + entries still proves the month (F0.4 gate intact)",
  txCase[1].integrity === "complete" && txCase[1].contributionProven === true);
const estimateNotComplete = agg(cashPair(1000, 1200, [E("broker", "investment_contribution", 100)]));
check("integrity: an estimated month is NOT promoted to complete （实录/估算不绕过完整性）",
  estimateNotComplete[1].flexibleSpendSource === "estimated" && estimateNotComplete[1].integrity === "unknown"
  && estimateNotComplete[1].spendProven === false);

// --- read-path compatibility for stored payloads ---
const legacyDashboard = {
  months: [
    { key: "2026-08-31", fixedSpend: 300, flexibleSpend: 250, flexibleSpendAnomaly: false, flexibleSpendSource: "estimated", totalSpend: 550, integrity: "unknown", contribution: 0 },
    { key: "2026-09-30", fixedSpend: 300, flexibleSpend: -150, flexibleSpendAnomaly: false, flexibleSpendSource: "recorded", totalSpend: 150, integrity: "unknown", contribution: 0 },
    { key: "2026-10-31", fixedSpend: 300, flexibleSpend: null, flexibleSpendAnomaly: false, flexibleSpendSource: "missing", totalSpend: null, integrity: "unknown", contribution: 0 },
  ],
  live: { netWorth: 0 },
};
const readBack = normalizeFireMetrics(legacyDashboard);
check("compat: legacy numeric month reads back unchanged", readBack.months[0].flexibleSpend === 250 && readBack.months[0].totalSpend === 550);
check("compat: recorded net refund survives the read path", readBack.months[1].flexibleSpend === -150 && readBack.months[1].totalSpend === 150);
check("compat: null month stays null + anomalous on read (never 0-filled)",
  readBack.months[2].flexibleSpend === null && readBack.months[2].totalSpend === null && readBack.months[2].flexibleSpendAnomaly === true);

// --- wiring: schema, prompt and UI ---
check("schema: new Firance types accepted", src.includes('"flexible_spend"') && src.includes('"cashflow_adjustment"') && src.includes('"investment_external_adjustment"'));
check("schema: extended entry fields preserved", src.includes("cashflowRole: cashflowRoleSchema") && src.includes("balanceDate:") && src.includes("periodStart:") && src.includes("verified:"));
check("schema: month key accepts YYYY-MM", src.includes("^\\d{4}-\\d{2}(-\\d{2})?$"));
check("schema: flexibleSpend nullable with recorded/estimated/missing source",
  src.includes("flexibleSpend: z.number().nullable()") && src.includes('z.enum(["recorded", "estimated", "missing"])'));
check("schema: old contribution fallback expression is gone", !src.includes("investmentContribution || month.transfer"));
check("prompt: reader parses by key, extended rows mapped, no 3-line assumption",
  src.includes("不得假定恰好三行") && src.includes("cashflow_role→cashflowRole") && src.includes("YYYY-MM 归一为该月月末估值"));
check("prompt: reader never backfills verification for history", src.includes("不得为历史记录补造核实标记"));
check("UI: source labels distinguish 已记录/估算/待核对",
  appSrc.includes('if (source === "recorded") return "已记录"') && appSrc.includes('if (source === "estimated") return "估算"') && appSrc.includes('return "待核对"'));
check("UI: reconciliation shows formula + issues + preserved metadata",
  appSrc.includes("month.cashflowNote") && appSrc.includes("month.anomalyReason") && appSrc.includes("entry.balanceDate") && appSrc.includes("cashflowRoleLabel"));
check("UI: missing spend renders as — / 待核对， never a formatted 0",
  appSrc.includes('current.totalSpend == null ? "—"') && appSrc.includes("灵活支出待核对"));
check("UI: chart keeps missing months as null breakpoints (no 0 fill)",
  appSrc.includes("month.totalSpend == null ? null : month.income - month.totalSpend"));

console.log(`validate-cashflow: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
