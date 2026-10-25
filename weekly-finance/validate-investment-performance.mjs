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
  "monthEnd", "normalizeBalanceDate", "isUnverifiedStatus", "entryUnverified", "effectiveFlowPeriod", "nativeDateString", "nativeBool", "amountMatches", "transactionSpendForMonth",
  "aggregateMonths", "average", "normalizedFireSpend", "validCompleteMonths",
  "computeFire", "normalizeStoredIntegrity", "normalizeFireMetrics",
  "recomputeInvestmentReturns", "computeInvestmentPerformance",
  "displayLabel", "sourceCanUseLive", "normalizedLiveValue", "findPlaidAccount",
  "mergeLatestEntries", "cleanSecurityName", "normalizeHoldings",
  "summarizeAvailableCash", "ensureAvailableCash", "buildDashboard",
];
// the one module-level constant the extracted server functions read
const excludedDecl = src.slice(src.indexOf("const excludedLiveSources"), src.indexOf("]);", src.indexOf("const excludedLiveSources")) + 3);
const bundle = NAMES.map(extractFn).join("\n");
const api = new Function(`${excludedDecl}\n${bundle}; return { ${NAMES.join(", ")} };`)();
const { normalizeRawMonths, aggregateMonths, computeInvestmentPerformance, normalizeFireMetrics, buildDashboard } = api;

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
// 100000 -> 115000 with 10000 cash in: return 5000. The normal
// controls carry a complete period covering the interval — that
// period proof is what marks the segment reconciled (see the
// period-proof section below for records without one).
const SEP = { periodStart: "2026-09-01", periodEnd: "2026-09-30" };
const OCT = { periodStart: "2026-10-01", periodEnd: "2026-10-31" };
const cashOnly = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000, SEP)]),
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
    E("broker_1234", "investment_contribution", 10000, SEP),
    E("employer_rsu", "investment_external_adjustment", 3000, SEP),
  ]),
]);
check("RSU: net flow includes non-bank direct investment (13000)",
  withRsu[1].investmentNetFlow === 13000);
check("RSU: return is 2000, not the 5000 the cash-only formula gives",
  withRsu[1].investmentReturn === 2000 && computeInvestmentPerformance(withRsu).returnAmount === 2000);

// --- withdrawals and negative returns keep their signs ---
const withdrawal = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 103000, [E("broker_1234", "investment_contribution", -4000, SEP)]),
]);
check("withdrawal: negative flow preserved, return 103000-100000-(-4000)=7000",
  withdrawal[1].investmentNetFlow === -4000 && withdrawal[1].investmentReturn === 7000);
const trueZeroReturn = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 110000, [E("broker_1234", "investment_contribution", 10000, SEP)]),
]);
check("true zero: balance growth exactly equal to flows is a real 0 return, not missing",
  trueZeroReturn[1].investmentReturn === 0 && trueZeroReturn[1].investmentReturnReason === null
  && computeInvestmentPerformance(trueZeroReturn).returnAmount === 0);
const negativeReturn = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 90000, [E("broker_1234", "investment_contribution", 0, SEP)]),
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
  invSnap("2026-09-30", 115000, [E("legacy", "transfer", 10000, SEP)]),
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
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { verified: true, periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
  ], "broker_1234", { verified: true }),
]);
check("verified: explicitly verified entries with a covering period reconcile normally (5000)",
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
  invSnap("2026-09-30", 108000, [E("broker_1234", "investment_contribution", 5000, SEP)]),
  invSnap("2026-10-31", 115000, [E("broker_1234", "investment_contribution", 5000, OCT)]),
]);
check("period: monthly returns 3000 and 2000 across two intervals",
  twoIntervals[1].investmentReturn === 3000 && twoIntervals[2].investmentReturn === 2000);
const twoPeriod = computeInvestmentPerformance(twoIntervals);
check("period: whole-period return = 115000 - 100000 - (5000+5000) = 5000",
  twoPeriod.returnAmount === 5000 && twoPeriod.netFlow === 10000 && twoPeriod.monthsCovered === 2);
const blockedMidway = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 108000, [E("broker_1234", "investment_contribution", 5000, SEP)]),
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
  { key: "2026-09-30", entries: [E("bank_1234", "account", 6000), E("b", "investment_contribution", 0, SEP)] },
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

// --- F1.6 rework PM counterexamples: the START endpoint is bound ---
// Same balances/flows as the passing fixed case (would-be return
// 5000); only the starting snapshot is defective. The old code
// checked the ending month only and still produced 5000.
const startUnverified = agg([
  invSnap("2026-08-31", 100000, [], "broker_1234", { verified: false }),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("PM counterexample: start balance unverified -> null (not 5000), reason names 期初 + 未核实",
  startUnverified[1].investmentReturn === null
  && (startUnverified[1].investmentReturnReason ?? "").includes("期初")
  && (startUnverified[1].investmentReturnReason ?? "").includes("未核实"));
check("PM counterexample: blocked start also nulls the period figure, balances stay facts",
  computeInvestmentPerformance(startUnverified).returnAmount === null
  && computeInvestmentPerformance(startUnverified).startBalance === 100000);
const startStaleEarly = agg([
  invSnap("2026-08-31", 100000, [], "broker_1234", { balanceDate: "2026-07-31" }),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("PM counterexample: start balance date a month early -> null (not 5000), reason names 期初 + 沿用旧余额日期",
  startStaleEarly[1].investmentReturn === null
  && (startStaleEarly[1].investmentReturnReason ?? "").includes("期初")
  && (startStaleEarly[1].investmentReturnReason ?? "").includes("沿用旧余额日期"));
// sensitivity pair: repairing ONLY the start endpoint restores 5000
const startRepaired = agg([
  invSnap("2026-08-31", 100000, [], "broker_1234", { balanceDate: "2026-08-31", verified: true }),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000, SEP)]),
]);
check("sensitivity: fresh + verified start endpoint restores the 5000 return",
  startRepaired[1].investmentReturn === 5000);

// --- F1.6 rework PM counterexamples: flow-period coverage ---
const periodPrevMonthOnly = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-08-01", periodEnd: "2026-08-31" }),
  ]),
]);
check("PM counterexample: flow period entirely in the previous month -> amount not mixed into this segment, null (not 5000)",
  periodPrevMonthOnly[1].investmentReturn === null && periodPrevMonthOnly[1].investmentNetFlow === null
  && (periodPrevMonthOnly[1].investmentReturnReason ?? "").includes("完全在本区间")
  && (periodPrevMonthOnly[1].investmentReturnReason ?? "").includes("整笔金额不计入本段净投入")
  && (periodPrevMonthOnly[1].investmentReturnReason ?? "").includes("2026-09-01 至 2026-09-30"));
const twoMonthSpanPartial = agg([
  invSnap("2026-08-15", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
  ]),
]);
check("PM counterexample: actual interval spans two months, flows dated for one -> null (not 5000)",
  twoMonthSpanPartial[1].investmentReturn === null
  && (twoMonthSpanPartial[1].investmentReturnReason ?? "").includes("未覆盖本区间 2026-08-16 至 2026-09-30"));
const periodCovered = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
  ]),
]);
check("coverage: flow period covering the whole interval reconciles (5000)",
  periodCovered[1].investmentReturn === 5000);
const periodSplit = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 5000, { periodStart: "2026-09-01", periodEnd: "2026-09-15" }),
    E("broker_1234", "investment_contribution", 5000, { periodStart: "2026-09-16", periodEnd: "2026-09-30" }),
  ]),
]);
check("coverage: two flow periods that together cover the interval reconcile (5000)",
  periodSplit[1].investmentReturn === 5000 && periodSplit[1].investmentNetFlow === 10000);
const periodPartialRecord = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 6000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
    E("employer_rsu", "investment_external_adjustment", 4000),
  ]),
]);
check("coverage: one undated flow record beside a dated one -> null （部分记录无法证明覆盖）",
  periodPartialRecord[1].investmentReturn === null
  && (periodPartialRecord[1].investmentReturnReason ?? "").includes("未提供期间"));
const periodRsuCovered = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
    E("employer_rsu", "investment_external_adjustment", 3000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
  ]),
]);
check("coverage: dated RSU flow counts as flow, return stays 2000",
  periodRsuCovered[1].investmentReturn === 2000 && periodRsuCovered[1].investmentNetFlow === 13000);

// --- F1.6 rework: Firance-native flow fields (extra -> entryMeta) ---
// The native keys ride in the record's extra verbatim and are
// promoted to their own entryMeta fields at ingest; the generic
// fields are untouched by them.
const nativeExtra = (fields) => ({ extra: fields });
const nativeOnly = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, nativeExtra({
      investment_period_start: "2026-09-01", investment_period_end: "2026-09-30", investment_flow_verified: true,
    })),
  ]),
]);
const nativeMeta = nativeOnly[1].entryMeta.find((m) => m.type === "investment_contribution");
check("native: extra keys promoted verbatim to nativePeriodStart/End + nativeFlowVerified",
  nativeMeta.nativePeriodStart === "2026-09-01" && nativeMeta.nativePeriodEnd === "2026-09-30"
  && nativeMeta.nativeFlowVerified === true);
check("native: promotion never touches the generic fields (they stay absent)",
  nativeMeta.periodStart === null && nativeMeta.periodEnd === null && nativeMeta.verified === null);
check("native: a native-only period covers the interval and reconciles (5000)",
  nativeOnly[1].investmentReturn === 5000 && nativeOnly[1].investmentNetFlow === 10000);
const nativeShort = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, nativeExtra({
      investment_period_start: "2026-09-01", investment_period_end: "2026-09-15",
    })),
  ]),
]);
check("native: a native period covering only part of the interval degrades (not 5000)",
  nativeShort[1].investmentReturn === null
  && (nativeShort[1].investmentReturnReason ?? "").includes("未覆盖本区间"));
const nativeUnverified = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, nativeExtra({ investment_flow_verified: false })),
  ]),
]);
check("native: investment_flow_verified=false degrades as 未核实",
  nativeUnverified[1].investmentReturn === null
  && (nativeUnverified[1].investmentReturnReason ?? "").includes("未核实"));
const nativeConflictVerified = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { verified: true, ...nativeExtra({ investment_flow_verified: false }) }),
  ]),
]);
check("native: generic verified=true contradicting native false degrades as a named 冲突",
  nativeConflictVerified[1].investmentReturn === null
  && (nativeConflictVerified[1].investmentReturnReason ?? "").includes("冲突"));
const periodConflictNative = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, {
      periodStart: "2026-09-01", periodEnd: "2026-09-30",
      ...nativeExtra({ investment_period_start: "2026-08-01", investment_period_end: "2026-09-30" }),
    }),
  ]),
]);
check("native: generic and native periods both present but different degrade as 期间冲突 (named)",
  periodConflictNative[1].investmentReturn === null
  && (periodConflictNative[1].investmentReturnReason ?? "").includes("期间冲突")
  && (periodConflictNative[1].investmentReturnReason ?? "").includes("broker_1234"));
const periodAgreeNative = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, {
      periodStart: "2026-09-01", periodEnd: "2026-09-30", verified: true,
      ...nativeExtra({ investment_period_start: "2026-09-01", investment_period_end: "2026-09-30", investment_flow_verified: true }),
    }),
  ]),
]);
check("native sensitivity: agreeing generic + native period/verification reconcile (5000)",
  periodAgreeNative[1].investmentReturn === 5000);
const startCarriedStatus = agg([
  invSnap("2026-08-31", 100000, [], "broker_1234", { status: "carried_forward_unverified" }),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("native: start balance status=carried_forward_unverified counts as unverified （期初 named)",
  startCarriedStatus[1].investmentReturn === null
  && (startCarriedStatus[1].investmentReturnReason ?? "").includes("期初")
  && (startCarriedStatus[1].investmentReturnReason ?? "").includes("未核实"));

// --- F1.6 rework: investment balance dates bind EXACTLY ---
const endSameMonthOlder = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)], "broker_1234", { balanceDate: "2026-09-15" }),
]);
check("exact-date: end balance dated 09-15 against the 09-30 snapshot degrades (not just older months)",
  endSameMonthOlder[1].investmentReturn === null
  && (endSameMonthOlder[1].investmentReturnReason ?? "").includes("沿用旧余额日期"));
const endFutureDate = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)], "broker_1234", { balanceDate: "2026-10-02" }),
]);
check("exact-date: a future end balance date degrades too",
  endFutureDate[1].investmentReturn === null
  && (endFutureDate[1].investmentReturnReason ?? "").includes("沿用旧余额日期"));
const monthFormBalance = agg([
  invSnap("2026-08-31", 100000, [], "broker_1234", { balanceDate: "2026-08" }),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000, SEP)], "broker_1234", { balanceDate: "2026-09" }),
]);
check("exact-date sensitivity: YYYY-MM balance dates equal their month-end snapshots (5000)",
  monthFormBalance[1].investmentReturn === 5000);

// --- F1.6 rework: period coverage is bound PER CHANNEL ---
const cashUndatedRsuDated = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000),
    E("employer_rsu", "investment_external_adjustment", 3000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
  ]),
]);
check("channels: the RSU channel's coverage never substitutes for the undated cash channel",
  cashUndatedRsuDated[1].investmentReturn === null
  && (cashUndatedRsuDated[1].investmentReturnReason ?? "").includes("现金投入")
  && (cashUndatedRsuDated[1].investmentReturnReason ?? "").includes("未提供期间"));
const cashCrossing = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-08-15", periodEnd: "2026-09-30" }),
  ]),
]);
check("channels: a cash period reaching outside the interval makes the amount unattributable （跨出本区间， whole record out)",
  cashCrossing[1].investmentReturn === null
  && (cashCrossing[1].investmentReturnReason ?? "").includes("跨出本区间")
  && (cashCrossing[1].investmentReturnReason ?? "").includes("整笔不计"));
const rsuCrossing = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
    E("employer_rsu", "investment_external_adjustment", 3000, { periodStart: "2026-09-01", periodEnd: "2026-10-05" }),
  ]),
]);
check("channels: an RSU period crossing the interval end degrades even with the cash channel proven",
  rsuCrossing[1].investmentReturn === null
  && (rsuCrossing[1].investmentReturnReason ?? "").includes("跨出本区间"));
const markedNoPeriod = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, nativeExtra({ investment_flow_verified: true })),
  ]),
]);
check("channels: a channel carrying the native verification mark but no period at all degrades",
  markedNoPeriod[1].investmentReturn === null
  && (markedNoPeriod[1].investmentReturnReason ?? "").includes("未提供期间"));
// --- PM counterexample C: ANY verification mark + no period degrades ---
// A channel counts as marked when any record carries any
// verification mark — generic verified, native flow verified, or
// an explicit status. Under the period-proof rule a mark never
// substitutes for a period: only a complete legal period proves
// attribution (the dated normal controls above reconcile).
const genericMarkedNoPeriod = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { verified: true }),
  ]),
]);
check("PM counterexample C: generic verified=true, native mark absent, no period -> return AND net flow null, 未提供期间 named",
  genericMarkedNoPeriod[1].investmentReturn === null
  && genericMarkedNoPeriod[1].investmentNetFlow === null
  && (genericMarkedNoPeriod[1].investmentReturnReason ?? "").includes("未提供期间"));
const statusMarkedNoPeriod = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { status: "verified" }),
  ]),
]);
check("PM counterexample C (status): an explicit status mark with no period degrades the same way",
  statusMarkedNoPeriod[1].investmentReturn === null
  && statusMarkedNoPeriod[1].investmentNetFlow === null
  && (statusMarkedNoPeriod[1].investmentReturnReason ?? "").includes("未提供期间"));
// --- period proof: a pure legacy record (no period, no mark)
// is never marked reconciled. The recorded facts stay readable
// (the month still shows the recorded contribution and the
// balances); only the reconciled return and net flow are null
// and the period card shows 待核对 for the segment.
const pureLegacy = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [E("broker_1234", "investment_contribution", 10000)]),
]);
check("period proof: pure legacy channel (no period, no mark) -> return AND net flow null, 未提供期间 named",
  pureLegacy[1].investmentReturn === null && pureLegacy[1].investmentNetFlow === null
  && (pureLegacy[1].investmentReturnReason ?? "").includes("未提供期间"));
check("period proof: the pure legacy segment's facts stay recorded (contribution + balances untouched)",
  pureLegacy[1].contribution === 10000 && pureLegacy[1].investment === 115000
  && computeInvestmentPerformance(pureLegacy).returnAmount === null
  && computeInvestmentPerformance(pureLegacy).endBalance === 115000);

// --- F1.6 rework (e): failed flow proof nulls the net flow too ---
check("net-flow: a coverage-blocked month reports investmentNetFlow null, not just a null return",
  periodPartialRecord[1].investmentNetFlow === null
  && computeInvestmentPerformance(periodPartialRecord).netFlow === null);
const mixedPeriod = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 108000, [E("broker_1234", "investment_contribution", 5000, SEP)]),
  invSnap("2026-10-31", 115000, [E("broker_1234", "investment_contribution", 5000, { verified: false })]),
]);
check("net-flow: one unproven interval nulls the WHOLE period net flow; the proven interval's return stays readable",
  mixedPeriod[1].investmentReturn === 3000 && mixedPeriod[1].investmentNetFlow === 5000
  && mixedPeriod[2].investmentNetFlow === null
  && computeInvestmentPerformance(mixedPeriod).netFlow === null
  && computeInvestmentPerformance(mixedPeriod).returnAmount === null);

// --- F1.6 rework: FIRE principal is the investment balance ---
// End-to-end through buildDashboard: two complete months; the
// FIRE target comes from the Sep complete month (annual spend
// (300 fixed + 600 flexible) * 12 = 10800 -> target 270000) and
// the principal must be the live investment balance (110000),
// never net worth.
function fireBuild(extraSepEntries, holdings = []) {
  const normalized = normalizeRawMonths([
    {
      key: "2026-08-31",
      entries: [
        E("bank_1234", "account", 10000), E("broker_1234", "investment", 100000),
        E("salary", "income", 5000), E("rent", "fixed_spend", 300),
        E("broker_1234", "investment_contribution", 1000),
      ],
    },
    {
      key: "2026-09-30",
      entries: [
        E("bank_1234", "account", 10000), E("broker_1234", "investment", 110000),
        E("salary", "income", 5000), E("rent", "fixed_spend", 300),
        E("broker_1234", "investment_contribution", 1000, SEP),
        ...extraSepEntries,
      ],
    },
  ]);
  if (!normalized.ok) throw new Error(`fixture failed to normalize: ${normalized.issue}`);
  return buildDashboard(
    AS_OF, normalized.months, [], holdings,
    [{ date: "2026-09-10", amount: 900, name: "store", pending: false, internalTransfer: false, transferLike: false }],
    { start: "2026-08-01", end: "2026-09-30", complete: true },
    null,
  );
}
const fireBase = fireBuild([]);
check("FIRE principal: progress uses the investment balance (110000 / 270000)",
  fireBase.fire.target === 270000 && Math.abs(fireBase.fire.progress - 110000 / 270000) < 1e-12
  && fireBase.fire.gap === 270000 - 110000 && fireBase.live.netWorth === 120000);
const fireWithHsa = fireBuild([E("fidelity_hsa_1234", "account", 50000)]);
check("PM counterexample: adding an HSA balance moves net worth (+50000) but NOT FIRE progress",
  fireWithHsa.live.netWorth === 170000 && fireWithHsa.fire.progress === fireBase.fire.progress
  && fireWithHsa.fire.gap === fireBase.fire.gap);
const fireWithLiability = fireBuild([E("mortgage_9999", "account", -80000)]);
check("FIRE principal: adding a liability moves net worth but NOT FIRE progress",
  fireWithLiability.live.netWorth === 40000 && fireWithLiability.fire.progress === fireBase.fire.progress);
const fireWithHoldings = fireBuild([], [{ ticker: "VOO", name: "Vanguard S&P 500 ETF", value: 999999, currency: "USD", institution: "Fidelity" }]);
check("FIRE principal: holdings detail changes neither FIRE progress nor the period return",
  fireWithHoldings.fire.progress === fireBase.fire.progress
  && fireWithHoldings.investmentPerformance.returnAmount === fireBase.investmentPerformance.returnAmount
  && fireBase.investmentPerformance.returnAmount === 9000);

// --- period proof: per-SOURCE coverage (no splicing) ---
// Source A covers the first half, source B the second half of
// the SAME channel: the two sources' periods must not splice
// into one proof — the channel is unproven.
const spliceAcrossSources = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_a", "investment_contribution", 5000, { periodStart: "2026-09-01", periodEnd: "2026-09-15" }),
    E("broker_b", "investment_contribution", 5000, { periodStart: "2026-09-16", periodEnd: "2026-09-30" }),
  ]),
]);
check("per-source: A first half + B second half does NOT splice into a proof (return + net flow null)",
  spliceAcrossSources[1].investmentReturn === null && spliceAcrossSources[1].investmentNetFlow === null
  && (spliceAcrossSources[1].investmentReturnReason ?? "").includes("不能拼接")
  && (spliceAcrossSources[1].investmentReturnReason ?? "").includes("broker_a"));
// Sensitivity: each source covering the whole interval on its
// own reconciles, with both amounts in the net flow.
const bothSourcesFull = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_a", "investment_contribution", 6000, SEP),
    E("broker_b", "investment_contribution", 4000, SEP),
  ]),
]);
check("per-source sensitivity: two sources each fully covering reconcile (net flow 10000, return 5000)",
  bothSourcesFull[1].investmentReturn === 5000 && bothSourcesFull[1].investmentNetFlow === 10000);
// Same-source splicing stays legal (periodSplit above): the two
// records of ONE source join into that source's own proof.

// --- period proof: legal, complete periods only ---
const illegalDayStart = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-00", periodEnd: "2026-09-30" }),
  ]),
]);
check("legal period: periodStart 2026-09-00 is an illegal date, rejected as proof (not compared as text)",
  illegalDayStart[1].investmentReturn === null && illegalDayStart[1].investmentNetFlow === null
  && (illegalDayStart[1].investmentReturnReason ?? "").includes("日期非法"));
const illegalDayEnd = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-01", periodEnd: "2026-09-31" }),
  ]),
]);
check("legal period: periodEnd 2026-09-31 (September has 30 days) is rejected the same way",
  illegalDayEnd[1].investmentReturn === null
  && (illegalDayEnd[1].investmentReturnReason ?? "").includes("日期非法"));
const reversedPeriod = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-30", periodEnd: "2026-09-01" }),
  ]),
]);
check("legal period: a start after its end is not a complete period",
  reversedPeriod[1].investmentReturn === null
  && (reversedPeriod[1].investmentReturnReason ?? "").includes("不完整或日期非法"));
const startOnlyPeriod = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, { periodStart: "2026-09-01" }),
  ]),
]);
check("legal period: periodStart without periodEnd (and no other proof) -> not reconciled, facts stay",
  startOnlyPeriod[1].investmentReturn === null && startOnlyPeriod[1].investmentNetFlow === null
  && startOnlyPeriod[1].contribution === 10000
  && (startOnlyPeriod[1].investmentReturnReason ?? "").includes("不完整或日期非法"));
const nativeStartOnly = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115000, [
    E("broker_1234", "investment_contribution", 10000, nativeExtra({ investment_period_start: "2026-09-01" })),
  ]),
]);
check("legal period: a native period_start without its end is equally incomplete",
  nativeStartOnly[1].investmentReturn === null
  && (nativeStartOnly[1].investmentReturnReason ?? "").includes("不完整或日期非法"));

// --- period proof: an entirely-outside amount never mixes in ---
// A fully proven 10000 record beside a 700 record dated entirely
// in the NEXT month: the 700 must not be absorbed into this
// segment's net flow — the segment degrades instead of silently
// summing it (entryMeta carries no per-entry amounts on the read
// path, so there is no honest partial sum to show).
const outsideBesideProven = agg([
  invSnap("2026-08-31", 100000),
  invSnap("2026-09-30", 115700, [
    E("broker_1234", "investment_contribution", 10000, SEP),
    E("broker_1234", "investment_contribution", 700, { periodStart: "2026-10-01", periodEnd: "2026-10-31" }),
  ]),
]);
check("outside amount: a record dated entirely outside the interval is excluded whole (segment not reconciled, no silent 10700 net flow)",
  outsideBesideProven[1].investmentReturn === null && outsideBesideProven[1].investmentNetFlow === null
  && (outsideBesideProven[1].investmentReturnReason ?? "").includes("完全在本区间")
  && (outsideBesideProven[1].investmentReturnReason ?? "").includes("整笔金额不计入本段净投入"));

// --- period proof: client card consumes the same verdicts ---
// The card's per-record coverage label is judged by the same
// rules: illegal dates are not proof, an entirely-outside period
// is 不在本区间内, a start-only record is 未提供期间.
function extractClientFns(names) {
  const clientFile = ts.createSourceFile("App.tsx", appSrc, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found = new Map();
  for (const node of clientFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      found.set(node.name.text, ts.transpileModule(node.getText(clientFile), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve },
      }).outputText);
    }
  }
  for (const name of names) if (!found.has(name)) throw new Error(`client function not found: ${name}`);
  return names.map((name) => found.get(name)).join("\n");
}
const CLIENT_PERIOD_NAMES = ["isRealDateText", "nextDateText", "effectivePeriodOf", "flowPeriodCoverageLabel"];
const clientPeriodApi = new Function(
  `const exports = {};\n${extractClientFns(CLIENT_PERIOD_NAMES)}; return { ${CLIENT_PERIOD_NAMES.join(", ")} };`,
)();
const { flowPeriodCoverageLabel } = clientPeriodApi;
const labelEntry = (fields) => ({ periodStart: null, periodEnd: null, nativePeriodStart: null, nativePeriodEnd: null, ...fields });
check("client label: a covering legal period reads 覆盖本区间",
  flowPeriodCoverageLabel(labelEntry({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }), "2026-08-31", "2026-09-30") === "覆盖本区间");
check("client label: illegal date 2026-09-00 reads 期间不完整或日期非法 (same verdict as the server)",
  flowPeriodCoverageLabel(labelEntry({ periodStart: "2026-09-00", periodEnd: "2026-09-30" }), "2026-08-31", "2026-09-30").includes("日期非法"));
check("client label: an entirely-outside period reads 不在本区间内",
  flowPeriodCoverageLabel(labelEntry({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }), "2026-08-31", "2026-09-30") === "不在本区间内");
check("client label: a start-only record reads 未提供期间",
  flowPeriodCoverageLabel(labelEntry({ periodStart: "2026-09-01" }), "2026-08-31", "2026-09-30") === "未提供期间");

// --- wiring: schema, derivation boundary and UI ---
check("schema: month carries additive net-flow + reason fields with legacy defaults",
  src.includes("investmentNetFlow: z.number().nullable().default(null)")
  && src.includes("investmentReturnReason: z.string().nullable().default(null)"));
check("schema: entryMeta carries the native fields additively (null defaults, legacy readable)",
  src.includes("nativePeriodStart: z.string().nullable().default(null)")
  && src.includes("nativePeriodEnd: z.string().nullable().default(null)")
  && src.includes("nativeFlowVerified: z.boolean().nullable().default(null)"));
check("ingest: native keys promoted verbatim from extra via the native readers, generic fields untouched",
  src.includes('nativeDateString(entry.extra, "investment_period_start")')
  && src.includes('nativeDateString(entry.extra, "investment_period_end")')
  && src.includes('nativeBool(entry.extra, "investment_flow_verified")'));
check("helpers: the exact-date / unverified / effective-period verdicts exist as shared named functions",
  src.includes("function normalizeBalanceDate(") && src.includes("function isUnverifiedStatus(")
  && src.includes("function entryUnverified(") && src.includes("function effectiveFlowPeriod(")
  && src.includes("function nativeDateString(") && src.includes("function nativeBool("));
check("helpers: the effective period validates real calendar dates (illegal days rejected, never text-compared)",
  extractFn("effectiveFlowPeriod").includes("isRealDateKey(start)") && extractFn("effectiveFlowPeriod").includes("isRealDateKey(end)")
  && extractFn("effectiveFlowPeriod").includes("start > end"));
check("helpers: coverage is judged per source inside each channel (no cross-source splicing)",
  extractFn("recomputeInvestmentReturns").includes("bySource")
  && extractFn("recomputeInvestmentReturns").includes("不能拼接")
  && extractFn("recomputeInvestmentReturns").includes("完全在本区间"));
check("helpers: both gates consume them (cashflow endpoints + investment reconciliation)",
  extractFn("aggregateMonths").includes("normalizeBalanceDate(entry.balanceDate) !== snapshotKey")
  && extractFn("aggregateMonths").includes("entryUnverified(entry)")
  && extractFn("recomputeInvestmentReturns").includes("normalizeBalanceDate(entry.balanceDate) !== previous.key")
  && extractFn("recomputeInvestmentReturns").includes("normalizeBalanceDate(entry.balanceDate) !== month.key")
  && extractFn("recomputeInvestmentReturns").includes("effectiveFlowPeriod(entry)")
  && extractFn("recomputeInvestmentReturns").includes("entryUnverified(entry)"));
check("prompt: native keys stay under their original keys in extra, status returned verbatim",
  src.includes("是 Firance 原生 key") && src.includes("不得与通用 periodStart/periodEnd/verified 合并或互相覆盖")
  && src.includes("status 的值必须原样返回"));
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
check("FIRE wiring: both paths pass the investment principal, never net worth",
  src.includes("fire: computeFire(months, liveInvestment)")
  && src.includes("fire: computeFire(reconciled, dashboard.live.investment)")
  && !src.includes("computeFire(months, liveNetWorth)")
  && !src.includes("computeFire(reconciled, dashboard.live.netWorth)"));
check("UI: period card first line shows the real interval + 已核对/待核对 status as text",
  appSrc.includes('${reconciled ? "已核对" : "待核对"}') && appSrc.includes("${perf.startKey} → ${perf.endKey}"));
check("UI: unreconcilable period return renders — with the specific reason nearby (no generic 数据不足）",
  appSrc.includes('<strong className="fact-card__none">—</strong>') && appSrc.includes("待核对：{perf.reason}")
  && !appSrc.includes("数据不足"));
check("UI: card expansion reuses entryMeta per row (endpoints, flow periods, per-interval coverage verdict)",
  appSrc.includes("期间核对明细（双端余额与投入期间）") && appSrc.includes("flowPeriodCoverageLabel(entry, previousMonth?.key ?? null, month.key)")
  && appSrc.includes("覆盖本区间") && appSrc.includes("未提供期间")
  && appSrc.includes("verificationText(entry.verified)"));
check("UI: intervals are listed one row per real endpoint pair with recorded amounts and the reconcilable net flow",
  appSrc.includes("现金投入已记录") && appSrc.includes("非银行直接投入已记录")
  && appSrc.includes("本段可用于核对的净投入") && appSrc.includes('month.investmentNetFlow == null ? "—"'));
check("UI: a null period net flow is stated 未知 with the per-interval pointer (never a partial sum as the period total)",
  appSrc.includes("未知（任一区间未核实时不给整个期间合计，各区间已记录金额见下方明细）"));
check("UI: flow rows show the effective period (generic ?? native) and the native verification state as text",
  appSrc.includes("entry.periodStart ?? entry.nativePeriodStart") && appSrc.includes("原生核实状态：")
  && appSrc.includes("（原生期间）") && appSrc.includes("期间 {effectivePeriodText(entry)}")
  && appSrc.includes("export function effectivePeriodText"));
check("UI: monthly record period display uses the effective period too",
  appSrc.includes("entry.periodStart ?? entry.nativePeriodStart ?? null"));
check("UI: established intervals stay readable when the period total is blocked",
  appSrc.includes("已成立区间的月度收益仍可在下方「月度记录」中查看") && appSrc.includes("区间 {month.key}"));

// --- date-validation fix (PM 2026-10-19): an illegal YYYY-MM
// balance month must NOT roll into a legal balance date ---
// The shared normalizeBalanceDate used to roll "2025-13" to
// 2026-01-31, so an investment endpoint carrying the bad value
// compared EQUAL to a January snapshot and the interval
// reconciled on a date that never existed. Fixed in the shared
// normalization: the return (and the period figure) is null and
// the reason names the stale/illegal balance date. Balances stay
// recorded facts; nothing is repaired or backfilled. Synthetic
// values only.
const JAN26 = { periodStart: "2026-01-01", periodEnd: "2026-01-31" };
const endRolledInv = agg([
  invSnap("2025-12-31", 100000),
  invSnap("2026-01-31", 115000, [E("broker_1234", "investment_contribution", 10000, JAN26)], "broker_1234", { balanceDate: "2025-13" }),
]);
check("illegal month (end): balanceDate 2025-13 does not roll into the 2026-01-31 snapshot — return null, date problem named",
  endRolledInv[1].investmentReturn === null
  && (endRolledInv[1].investmentReturnReason ?? "").includes("沿用旧余额日期"));
check("illegal month (end): the period figure is withheld too; balances remain readable facts",
  computeInvestmentPerformance(endRolledInv).returnAmount === null
  && computeInvestmentPerformance(endRolledInv).endBalance === 115000
  && computeInvestmentPerformance(endRolledInv).startBalance === 100000);
const endLegalInv = agg([
  invSnap("2025-12-31", 100000),
  invSnap("2026-01-31", 115000, [E("broker_1234", "investment_contribution", 10000, JAN26)], "broker_1234", { balanceDate: "2026-01" }),
]);
check("illegal month sensitivity (end): the legal YYYY-MM form 2026-01 still equals the January snapshot — return reconciles (5000)",
  endLegalInv[1].investmentReturn === 5000 && endLegalInv[1].investmentReturnReason === null);
const MAR26 = { periodStart: "2026-03-01", periodEnd: "2026-03-31" };
const startRolledInv = agg([
  invSnap("2026-02-28", 100000, [], "broker_1234", { balanceDate: "2025-14" }),
  invSnap("2026-03-31", 115000, [E("broker_1234", "investment_contribution", 10000, MAR26)]),
]);
check("illegal month (start): balanceDate 2025-14 does not roll into the 2026-02-28 snapshot — return null, 期初 named",
  startRolledInv[1].investmentReturn === null
  && (startRolledInv[1].investmentReturnReason ?? "").includes("期初投资账户沿用旧余额日期"));
const startLegalInv = agg([
  invSnap("2026-02-28", 100000, [], "broker_1234", { balanceDate: "2026-02" }),
  invSnap("2026-03-31", 115000, [E("broker_1234", "investment_contribution", 10000, MAR26)]),
]);
check("illegal month sensitivity (start): the legal YYYY-MM form 2026-02 still equals the non-leap February snapshot — return reconciles (5000)",
  startLegalInv[1].investmentReturn === 5000);
check("illegal month: other illegal forms at the end endpoint (2025-00 / garbage) degrade the same way",
  agg([
    invSnap("2025-12-31", 100000),
    invSnap("2026-01-31", 115000, [E("broker_1234", "investment_contribution", 10000, JAN26)], "broker_1234", { balanceDate: "2025-00" }),
  ])[1].investmentReturn === null
  && agg([
    invSnap("2025-12-31", 100000),
    invSnap("2026-01-31", 115000, [E("broker_1234", "investment_contribution", 10000, JAN26)], "broker_1234", { balanceDate: "nonsense" }),
  ])[1].investmentReturn === null);

console.log(`validate-investment-performance: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
