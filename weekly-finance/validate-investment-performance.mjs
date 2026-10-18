// F1.6 validation: investment return independently reconciled.
// Period return = ending balance of ALL investment accounts
// − starting balance over the SAME scope − the WHOLE interval's
// external net flow (resolved cash contribution + non-bank direct
// investment such as RSU / employer contributions; withdrawals
// negative). First period, unverified, cross-month gaps, stale
// balances, scope changes and missing/conflicting flows all
// degrade to null with a named reason — never a fabricated figure.
// Holdings detail never substitutes for account balances, and the
// net-worth balance difference is never re-labelled market return.
// Behaviour runs against the REAL production functions extracted
// from server/src/actions.ts via the TypeScript AST; wiring
// assertions run against the real server and client source text.
// All fixtures are synthetic.
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
const { normalizeRawMonths, aggregateMonths, computeInvestmentPerformance, normalizeFireMetrics } = api;

// --- fixtures (synthetic) ---
const E = (financeSource, type, number, extraFields = {}) => ({ financeSource, type, number, ...extraFields });
const AS_OF = "2026-10-17T12:00:00-07:00";
function agg(rawMonths) {
  const normalized = normalizeRawMonths(rawMonths);
  if (!normalized.ok) throw new Error(`fixture failed to normalize: ${normalized.issue}`);
  return aggregateMonths(normalized.months, [], null, AS_OF);
}
const invSnap = (key, balance, extra = [], source = "broker_1234", balanceFields = {}) => ({
  key,
  entries: [E(source, "investment", balance, balanceFields), ...extra],
});

// --- fixed case 1: cash contribution only ---
// 100000 -> 115000 with 10000 cash in: return 5000.
const cashOnly = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("fixed: first snapshot is the starting point, not a return",
  cashOnly[0].investmentReturn === null && (cashOnly[0].investmentReturnReason ?? "").includes("首期"));
check("fixed: 115000 - 100000 - 10000 = 5000",
  cashOnly[1].investmentReturn === 5000 && cashOnly[1].investmentNetFlow === 10000
  && cashOnly[1].investmentReturnReason === null);
const cashPeriod = computeInvestmentPerformance(cashOnly);
check("fixed: period figure equals the single interval (5000, 1 interval)",
  cashPeriod.returnAmount === 5000 && cashPeriod.netFlow === 10000
  && cashPeriod.startBalance === 100000 && cashPeriod.endBalance === 115000
  && cashPeriod.monthsCovered === 1 && cashPeriod.reason === null);

// --- fixed case 2: non-bank direct investment is a flow, not return ---
// Same balances, plus RSU/employer direct 3000: return 2000. The
// old formula (balance diff - cash contribution) would say 5000.
const withRsu = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000),
    E("employer_rsu", "investment_external_adjustment", 3000),
  ]),
]);
check("RSU: net flow includes non-bank direct investment (13000)",
  withRsu[1].investmentNetFlow === 13000);
check("RSU: return is 2000, not the 5000 the cash-only formula gives",
  withRsu[1].investmentReturn === 2000 && computeInvestmentPerformance(withRsu).returnAmount === 2000);

// --- withdrawals and negative returns keep their signs ---
const withdrawal = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 103000, [E("broker_1234", "investment_contribution", -4000)]),
]);
check("withdrawal: negative flow preserved, return 103000-100000-(-4000)=7000",
  withdrawal[1].investmentNetFlow === -4000 && withdrawal[1].investmentReturn === 7000);
const negativeReturn = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 90000, [E("broker_1234", "investment_contribution", 0)]),
]);
check("negative: explicit 0 contribution is proven, return -10000 kept (never clamped)",
  negativeReturn[1].contributionSource === "standard" && negativeReturn[1].investmentReturn === -10000);

// --- missing / conflicting flows degrade to null with a reason ---
const missingFlow = agg([invSnap("2026-08-31", 100000), invSnap("2026-09-30", 115000)]);
check("missing: no contribution record -> return null + reason, net flow unknown",
  missingFlow[1].investmentReturn === null && missingFlow[1].investmentNetFlow === null
  && (missingFlow[1].investmentReturnReason ?? "").includes("缺少投资投入记录"));
check("missing: period return also null, balances still shown as facts",
  computeInvestmentPerformance(missingFlow).returnAmount === null
  && computeInvestmentPerformance(missingFlow).endBalance === 115000);
const conflictFlow = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000),
    E("legacy", "transfer", 9999),
  ]),
]);
check("conflict: standard/alias conflict -> return null + conflict reason",
  conflictFlow[1].investmentReturn === null && conflictFlow[1].investmentNetFlow === null
  && (conflictFlow[1].investmentReturnReason ?? "").includes("冲突"));
const aliasFlow = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("legacy", "transfer", 10000)]),
]);
check("alias: legacy transfer alone still reconciles (5000)",
  aliasFlow[1].contributionSource === "alias" && aliasFlow[1].investmentReturn === 5000);

// --- unverified and stale balances degrade ---
const unverifiedBalance = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)], "broker_1234", { verified: false }),
]);
check("unverified: balance marked 未核实 -> return null + reason",
  unverifiedBalance[1].investmentReturn === null
  && (unverifiedBalance[1].investmentReturnReason ?? "").includes("未核实"));
const unverifiedFlow = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000, { verified: false })]),
]);
check("unverified: flow marked 未核实 -> return null + reason",
  unverifiedFlow[1].investmentReturn === null
  && (unverifiedFlow[1].investmentReturnReason ?? "").includes("未核实"));
const verifiedOk = agg([
  invSnap("2026-08-31", 100000, [], "broker_1234", { verified: true }),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000, { verified: true })], "broker_1234", { verified: true }),
]);
check("verified: explicitly verified entries reconcile normally (5000)",
  verifiedOk[1].investmentReturn === 5000);
const staleBalance = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)], "broker_1234", { balanceDate: "2026-08-31" }),
]);
check("stale: carried-over balance date -> return null + 沿用旧余额 reason",
  staleBalance[1].investmentReturn === null
  && (staleBalance[1].investmentReturnReason ?? "").includes("沿用旧余额日期"));

// --- cross-month gap: whole-interval difference, not a monthly return ---
const gap = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-10-31", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("gap: month after a gap has no monthly return, reason names the whole interval",
  gap[1].investmentReturn === null
  && (gap[1].investmentReturnReason ?? "").includes("相隔不止一个月")
  && (gap[1].investmentReturnReason ?? "").includes("不作为单月收益"));
check("gap: period return null too (missing month's flows unknown, never 0-filled)",
  computeInvestmentPerformance(gap).returnAmount === null
  && (computeInvestmentPerformance(gap).reason ?? "").includes("2026-10"));

// --- scope changes degrade ---
const scopeAdded = agg([
  invSnap("2026-08-31", 100000),
  {
    key: "2026-09-30",
    entries: [
      E("broker_1234", "investment", 90000),
      E("new_ira_5678", "investment", 25000),
      E("broker_1234", "investment_contribution", 10000),
    ],
  },
]);
check("scope: added investment account -> return null + 范围 reason",
  scopeAdded[1].investmentReturn === null
  && (scopeAdded[1].investmentReturnReason ?? "").includes("范围"));
const scopeRemoved = agg([
  {
    key: "2026-08-31",
    entries: [E("broker_1234", "investment", 60000), E("old_ira_5678", "investment", 40000)],
  },
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("scope: removed investment account -> return null + 范围 reason",
  scopeRemoved[1].investmentReturn === null
  && (scopeRemoved[1].investmentReturnReason ?? "").includes("范围"));

// --- cross-two-month period coverage ---
const twoIntervals = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 108000, [E("broker_1234", "investment_contribution", 5000)]),
  invSnap("2026-10-31", 115000, [E("broker_1234", "investment_contribution", 5000)]),
]);
check("period: monthly returns 3000 and 2000 across two intervals",
  twoIntervals[1].investmentReturn === 3000 && twoIntervals[2].investmentReturn === 2000);
const twoPeriod = computeInvestmentPerformance(twoIntervals);
check("period: whole-period return = 115000 - 100000 - (5000+5000) = 5000",
  twoPeriod.returnAmount === 5000 && twoPeriod.netFlow === 10000 && twoPeriod.monthsCovered === 2);
const blockedMidway = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 108000, [E("broker_1234", "investment_contribution", 5000)]),
  invSnap("2026-11-30", 115000, [E("broker_1234", "investment_contribution", 5000)]),
]);
check("period: a later gap breaks accumulation (no bridging over the hole)",
  blockedMidway[1].investmentReturn === 3000
  && computeInvestmentPerformance(blockedMidway).returnAmount === null
  && (computeInvestmentPerformance(blockedMidway).reason ?? "").includes("2026-11"));

// --- single snapshot / no investment scope ---
const single = agg([invSnap("2026-08-31", 100000)]);
check("single: one snapshot -> period null with a starting-point reason",
  computeInvestmentPerformance(single).returnAmount === null
  && computeInvestmentPerformance(single).monthsCovered === 0);
const noInvestments = agg([
  { key: "2026-08-31", entries: [E("bank_1234", "account", 5000), E("b", "investment_contribution", 0)] },
  { key: "2026-09-30", entries: [E("bank_1234", "account", 6000), E("b", "investment_contribution", 0)] },
]);
check("empty scope: no investment accounts on either side reconciles to 0, not missing",
  noInvestments[1].investmentReturn === 0);

// --- read path: legacy stored months are re-derived, never trusted ---
const legacyMonth = (key, investment, oldReturn, extra = {}) => ({
  key, investment, fixedSpend: 0, flexibleSpend: 0, flexibleSpendAnomaly: false,
  flexibleSpendSource: "estimated", totalSpend: 0, integrity: "unknown",
  contribution: 10000, contributionSource: "standard", investmentExternalAdjustment: 3000,
  investmentReturn: oldReturn, entryMeta: [
    { financeSource: "broker_1234", type: "investment", cashflowRole: null, balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: null },
  ],
  ...extra,
});
const legacyDashboard = {
  months: [
    legacyMonth("2026-08-31", 100000, null, { contribution: 0, investmentExternalAdjustment: 0 }),
    // legacy stored figure used the old cash-only formula: 5000.
    legacyMonth("2026-09-30", 115000, 5000),
  ],
  live: { netWorth: 0 },
};
const readBack = normalizeFireMetrics(legacyDashboard);
check("compat: read path re-derives the legacy 5000 into the RSU-aware 2000",
  readBack.months[1].investmentReturn === 2000 && readBack.months[1].investmentNetFlow === 13000);
check("compat: read path derives the period figure from the same months",
  readBack.investmentPerformance.returnAmount === 2000 && readBack.investmentPerformance.monthsCovered === 1);
const scopeUnknownDashboard = {
  months: [
    legacyMonth("2026-08-31", 100000, null, { entryMeta: [] }),
    legacyMonth("2026-09-30", 115000, 5000, { entryMeta: [] }),
  ],
  live: { netWorth: 0 },
};
const scopeUnknownRead = normalizeFireMetrics(scopeUnknownDashboard);
check("compat: pre-metadata payload degrades to null + 范围记录 reason (legacy figure not trusted)",
  scopeUnknownRead.months[1].investmentReturn === null
  && (scopeUnknownRead.months[1].investmentReturnReason ?? "").includes("范围记录"));

// --- wiring: schema, derivation boundary and UI ---
check("schema: month carries additive net-flow + reason fields with legacy defaults",
  src.includes("investmentNetFlow: z.number().nullable().default(null)")
  && src.includes("investmentReturnReason: z.string().nullable().default(null)"));
check("schema: dashboard carries the period performance with a legacy default",
  src.includes("investmentPerformance: investmentPerformanceSchema.default({"));
check("boundary: period performance derives from months only (buildDashboard wiring)",
  src.includes("investmentPerformance: computeInvestmentPerformance(months)"));
check("boundary: holdings never feed the reconciliation (no holdings reference in either function)",
  !extractFn("recomputeInvestmentReturns").includes("holding")
  && !extractFn("computeInvestmentPerformance").includes("holding"));
check("boundary: old un-gated inline formula is gone",
  !src.includes("month.investment - previous.investment - monthContribution"));
check("UI: period card states the formula scope and separates it from the net-worth fact card",
  appSrc.includes("投资收益核对") && appSrc.includes("整个期间外部净投入")
  && appSrc.includes("持仓明细不替代账户余额") && appSrc.includes("不是投资收益"));
check("UI: balance-difference fact card keeps its own non-return wording",
  appSrc.includes("与上次成功快照的净资产之差"));
check("UI: monthly record shows the return label, value/reason and net-flow breakdown",
  appSrc.includes("investmentReturnLabel(month)") && appSrc.includes("month.investmentReturnReason")
  && appSrc.includes("month.investmentNetFlow") && appSrc.includes("非银行直接投入"));

console.log(`validate-investment-performance: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
