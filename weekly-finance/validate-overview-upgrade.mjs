// F-DASH-P0-4 总览升级 validation: drives the REAL production
// pure module (server/src/overviewUpgrade.ts — zero imports,
// every export exercised below) over fully synthetic fixtures:
// dual net-worth caliber + difference breakdown identity,
// action-bar urgency order + 5-item cap + wash-sale window
// edges, TWR chain-linking against hand-computed cases, MWR
// (XIRR) anchors, the three-factor reconciliation (balanced
// and with a stated gap), and the freshness default state.
// Wiring assertions cover the getDashboard additive field,
// the overview-tab blocks and the CSS. Three source mutations
// are really executed and must flip behaviour. No real
// financial data: every figure below is a synthetic round
// number; app.db is never touched.
// Run: bun weekly-finance/validate-overview-upgrade.mjs
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const mod = await import(join(ROOT, "server/src/overviewUpgrade.ts"));
const {
  buildDualNetWorth,
  buildOverviewActions,
  buildReturnMetrics,
  computeTimeWeightedReturn,
  computeMoneyWeightedReturn,
  buildReturnFactors,
  buildFreshness,
  buildOverviewUpgrade,
  OVERVIEW_ACTION_LIMIT,
} = mod;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const approx = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

// ---------- dual net worth ----------
const dual = buildDualNetWorth({
  investable: 800000, deposits: 200000, loans: 50000, totalNetWorth: 950000, homeValue: 120000,
});
check("dual: investable is the vol_panel caliber figure, large side available",
  dual.investable === 800000 && dual.investableAvailable && dual.investableNote === "含 401k/HSA，不含银行存款与自住房");
check("dual: total net worth with its note",
  dual.total === 950000 && dual.totalAvailable && dual.totalNote === "含自住房估值与银行存款");
check("dual: difference = total − investable, breakdown identity bank + home − loans = difference",
  dual.difference === 150000 && dual.bankDeposits === 80000 && dual.homeValue === 120000 && dual.loans === 50000
  && dual.bankDeposits + dual.homeValue - dual.loans === dual.difference);
const dualNoHome = buildDualNetWorth({
  investable: 800000, deposits: 200000, loans: 50000, totalNetWorth: 950000, homeValue: null,
});
check("dual: no separately recorded home value -> bank deposits keep the whole deposits fact, identity still holds",
  dualNoHome.bankDeposits === 200000 && dualNoHome.homeValue === null
  && dualNoHome.bankDeposits + 0 - dualNoHome.loans === dualNoHome.difference);
const dualMissing = buildDualNetWorth({
  investable: null, deposits: null, loans: null, totalNetWorth: null, homeValue: null,
});
check("dual: every component missing -> both sides unavailable, nothing filled in",
  dualMissing.investable === null && !dualMissing.investableAvailable
  && dualMissing.total === null && !dualMissing.totalAvailable && dualMissing.difference === null);
const dualHalf = buildDualNetWorth({
  investable: 800000, deposits: null, loans: 50000, totalNetWorth: 950000, homeValue: null,
});
check("dual: deposits missing -> total side unavailable even though a total figure was passed",
  dualHalf.investableAvailable && !dualHalf.totalAvailable && dualHalf.total === null && dualHalf.difference === null);

// ---------- action bar ----------
const AS_OF = "2026-11-14";
const richActions = buildOverviewActions({
  asOf: AS_OF,
  openPositions: [
    { ticker: "ACME", kindLabel: "CSP 现金担保看跌", exp: "2026-12-19", daysToExpiry: 35 },
    { ticker: "BETA", kindLabel: "CSP 现金担保看跌", exp: "2026-11-21", daysToExpiry: 7 },
    { ticker: "GONE", kindLabel: "CC 备兑看涨", exp: "2026-11-01", daysToExpiry: -13 },
  ],
  gates: [
    { ticker: "ACME", state: "blocked", spreadPp: -3.2 },
    { ticker: "BETA", state: "met", spreadPp: 4.1 },
    { ticker: "CORP", state: "blocked", spreadPp: -0.5 },
    { ticker: "DYNE", state: "unknown", spreadPp: null },
  ],
  earnings: [
    { ticker: "ACME", date: "2026-11-20", daysUntil: 6, locked: true },
    { ticker: "BETA", date: "2026-11-25", daysUntil: 11, locked: true },
    { ticker: "FARL", date: "2026-12-30", daysUntil: 46, locked: false },
  ],
  reviewPendingTotal: 7,
  closedTrades: [
    { kind: "stock", ticker: "WASH", closed: "2026-11-01", pnl: -500 },
    { kind: "stock", ticker: "EDGE", closed: "2026-10-15", pnl: -100 },
    { kind: "stock", ticker: "OLDW", closed: "2026-10-14", pnl: -100 },
    { kind: "stock", ticker: "GAIN", closed: "2026-11-10", pnl: 300 },
    { kind: "stock", ticker: "UNKN", closed: "2026-11-10", pnl: null },
  ],
});
check("actions: capped at the limit of 5", richActions.length === OVERVIEW_ACTION_LIMIT && OVERVIEW_ACTION_LIMIT === 5);
check("actions: urgency order expiry -> gate -> earnings, expired contract skipped",
  richActions.map((item) => item.kind).join(",") === "expiry,gate,gate,earnings,earnings");
check("actions: nearest expiry is the 7-day BETA contract, days stated",
  richActions[0].text.includes("BETA") && richActions[0].text.includes("2026-11-21") && richActions[0].text.includes("剩余 7 天"));
check("actions: blocked gates named with the spread, met/unknown gates silent",
  richActions[1].text.includes("ACME") && richActions[1].text.includes("IV−RV 为负") && richActions[1].text.includes("-3.2")
  && richActions[2].text.includes("CORP") && !richActions.some((item) => item.text.includes("DYNE")));
check("actions: earnings locks carry the date and the lock wording, unlocked earnings silent",
  richActions[3].text === "ACME 财报日 2026-11-20，窗口内不开新 CSP" && !richActions.some((item) => item.text.includes("FARL")));
const leanActions = buildOverviewActions({
  asOf: AS_OF,
  openPositions: [],
  gates: [],
  earnings: [],
  reviewPendingTotal: 7,
  closedTrades: [
    { kind: "stock", ticker: "WASH", closed: "2026-11-01", pnl: -500 },
    { kind: "stock", ticker: "EDGE", closed: "2026-10-15", pnl: -100 },
    { kind: "stock", ticker: "OLDW", closed: "2026-10-14", pnl: -100 },
    { kind: "stock", ticker: "GAIN", closed: "2026-11-10", pnl: 300 },
    { kind: "stock", ticker: "UNKN", closed: "2026-11-10", pnl: null },
  ],
});
check("actions: review count stated as a fact",
  leanActions.some((item) => item.kind === "review" && item.text === "待复核交易 7 笔"));
check("actions: wash window includes day 30 (EDGE 2026-10-15) and excludes day 31 (OLDW), gains and unknown pnl excluded",
  leanActions.some((item) => item.kind === "wash" && item.text.includes("WASH") && item.text.includes("窗口至 2026-12-01"))
  && leanActions.some((item) => item.kind === "wash" && item.text.includes("EDGE"))
  && !leanActions.some((item) => item.text.includes("OLDW"))
  && !leanActions.some((item) => item.text.includes("GAIN"))
  && !leanActions.some((item) => item.text.includes("UNKN")));
check("actions: wash text is the mandated rule statement",
  leanActions.find((item) => item.kind === "wash" && item.text.includes("WASH"))?.text
    === "WASH 于 2026-11-01 亏损卖出，30 天内 IRA 不买同名（窗口至 2026-12-01）");
check("actions: nothing qualifies -> empty array (the bar hides, no placeholder)",
  buildOverviewActions({ asOf: AS_OF, openPositions: [], gates: [], earnings: [], reviewPendingTotal: 0, closedTrades: [] }).length === 0
  && buildOverviewActions({ asOf: AS_OF, openPositions: [], gates: [], earnings: [], reviewPendingTotal: null, closedTrades: [] }).length === 0);
check("actions: every item carries symbol + text (meaning never on colour alone)",
  [...richActions, ...leanActions].every((item) => item.symbol !== "" && item.text !== ""));

// ---------- TWR ----------
const twrPoints = [
  { date: "2026-01-01", value: 100000, flow: 0 },
  { date: "2026-01-02", value: 110000, flow: 10000 },
  { date: "2026-01-03", value: 121000, flow: 0 },
];
check("twr: deposit day contributes no return, +10% day chain-links to +10.00%",
  approx(computeTimeWeightedReturn(twrPoints), 0.1, 1e-9));
check("twr: withdrawal day — value 90000 after −20000 flow on a 100000 base is +10%",
  approx(computeTimeWeightedReturn([
    { date: "2026-01-01", value: 100000, flow: 0 },
    { date: "2026-01-02", value: 90000, flow: -20000 },
  ]), 0.1, 1e-9));
check("twr: fewer than two points -> null （暂无可比）",
  computeTimeWeightedReturn([{ date: "2026-01-01", value: 100000, flow: 0 }]) === null
  && computeTimeWeightedReturn([]) === null);
check("twr: a non-positive base day voids the chain instead of fabricating",
  computeTimeWeightedReturn([
    { date: "2026-01-01", value: 0, flow: 0 },
    { date: "2026-01-02", value: 100, flow: 0 },
  ]) === null);

// ---------- MWR ----------
check("mwr: no flows, 100000 -> 110000 over exactly 365 days is +10.00% per year",
  approx(computeMoneyWeightedReturn([
    { date: "2025-01-01", value: 100000, flow: 0 },
    { date: "2026-01-01", value: 110000, flow: 0 },
  ]), 0.1, 0.001));
const mwrDeposit = computeMoneyWeightedReturn([
  { date: "2025-01-01", value: 100000, flow: 0 },
  { date: "2025-07-02", value: 150000, flow: 50000 },
  { date: "2026-01-01", value: 165000, flow: 0 },
]);
check("mwr: mid-year deposit case solves inside the hand bracket (11%..13%; gain 15000 on ~125000 time-weighted capital)",
  mwrDeposit != null && mwrDeposit > 0.11 && mwrDeposit < 0.13);
check("mwr: total loss to zero is −100%, single point is null",
  computeMoneyWeightedReturn([
    { date: "2025-01-01", value: 100000, flow: 0 },
    { date: "2026-01-01", value: 0, flow: 0 },
  ]) === -1
  && computeMoneyWeightedReturn([{ date: "2025-01-01", value: 100000, flow: 0 }]) === null);
const metrics = buildReturnMetrics([
  { date: "2025-01-01", value: 100000, flow: 0 },
  { date: "2026-01-01", value: 110000, flow: 0 },
]);
check("returns: pair carries both calibers, the interval and both caliber notes",
  approx(metrics.twr, 0.1, 1e-9) && approx(metrics.mwr, 0.1, 0.001) && metrics.startDate === "2025-01-01" && metrics.endDate === "2026-01-01"
  && metrics.days === 365 && metrics.twrNote === "TWR 剔除资金进出影响" && metrics.mwrNote === "MWR 反映实际资金时间价值");
check("returns: a 2-day +10% move has a TWR but its per-year MWR lies beyond the solve bracket -> null, not fabricated",
  buildReturnMetrics(twrPoints).twr != null && buildReturnMetrics(twrPoints).mwr === null);

// ---------- three-factor split ----------
const factorPoints = [
  { date: "2025-01-01", value: 100000, flow: 0 },
  { date: "2025-07-02", value: 150000, flow: 50000 },
  { date: "2026-01-01", value: 165000, flow: 0 },
];
const factors = buildReturnFactors(factorPoints, {
  stockPriceChange: 9000, optionPremium: 4000, dividendsInterest: 1000,
});
check("factors: interval total return = end − start − net flow = 15000",
  factors.totalReturn === 15000);
check("factors: amounts, shares and the premium label/note ride together",
  factors.factors[0].amount === 9000 && approx(factors.factors[0].share, 0.6, 1e-9)
  && factors.factors[1].label === "期权权利金" && factors.factors[1].note === "已实现权利金（未计税费）"
  && factors.factors[1].amount === 4000 && approx(factors.factors[1].share, 4000 / 15000, 1e-4)
  && factors.factors[2].amount === 1000);
check("factors: a non-zero gap is stated with its reason, never forced to balance",
  factors.knownSum === 14000 && factors.difference === 1000 && factors.differenceReason === "含未实现浮盈亏等未单列项");
const factorsBalanced = buildReturnFactors(factorPoints, {
  stockPriceChange: 10000, optionPremium: 4000, dividendsInterest: 1000,
});
check("factors: an exactly reconciling split reports difference 0 and no reason",
  factorsBalanced.difference === 0 && factorsBalanced.differenceReason === null);
const factorsMissing = buildReturnFactors(factorPoints, {
  stockPriceChange: null, optionPremium: 4000, dividendsInterest: 1000,
});
check("factors: a missing factor leaves the gap uncomputed, not zero-filled",
  factorsMissing.knownSum === null && factorsMissing.difference === null && factorsMissing.factors[0].amount === null);
check("factors: no daily series -> no total return and no shares",
  (() => { const f = buildReturnFactors([], { stockPriceChange: 1, optionPremium: 2, dividendsInterest: 3 }); return f.totalReturn === null && f.factors.every((row) => row.share === null); })());

// ---------- freshness ----------
const fresh = buildFreshness({
  priceDateMin: "2026-11-06", priceDateMax: "2026-11-09",
  generatedAt: "2026-11-14T05:30:00.000Z", volPanelAsOf: "2026-11-13",
});
check("freshness: all three fields present -> verified, range kept verbatim",
  fresh.verified && fresh.priceDateMin === "2026-11-06" && fresh.priceDateMax === "2026-11-09" && fresh.volPanelAsOf === "2026-11-13");
const freshMissing = buildFreshness({
  priceDateMin: "2026-11-06", priceDateMax: "2026-11-09",
  generatedAt: "2026-11-14T05:30:00.000Z", volPanelAsOf: null,
});
check("freshness: any field missing -> unverified with the mandated text, present fields still shown",
  !freshMissing.verified && freshMissing.unverifiedText === "新鲜度未核实" && freshMissing.priceDateMax === "2026-11-09");
check("freshness: an impossible calendar date is not evidence",
  buildFreshness({ priceDateMin: "2026-02-30", priceDateMax: "2026-11-09", generatedAt: "2026-11-14T05:30:00.000Z", volPanelAsOf: "2026-11-13" }).priceDateMin === null);
check("freshness: nothing present -> all null and unverified",
  (() => { const f = buildFreshness({ priceDateMin: null, priceDateMax: null, generatedAt: null, volPanelAsOf: null }); return !f.verified && f.generatedAt === null && f.volPanelAsOf === null; })());

// ---------- assembly ----------
const assembled = buildOverviewUpgrade({
  dualNetWorth: { investable: 800000, deposits: 200000, loans: 50000, totalNetWorth: 950000, homeValue: 120000 },
  actions: { asOf: AS_OF, openPositions: [], gates: [], earnings: [], reviewPendingTotal: 3, closedTrades: [] },
  dailyPoints: twrPoints,
  factors: { stockPriceChange: 9000, optionPremium: 4000, dividendsInterest: 1000 },
  freshness: { priceDateMin: "2026-11-06", priceDateMax: "2026-11-09", generatedAt: "2026-11-14T05:30:00.000Z", volPanelAsOf: "2026-11-13" },
});
check("assembly: one call returns all five blocks wired from the same inputs",
  assembled.dualNetWorth.difference === 150000 && assembled.actions.length === 1
  && approx(assembled.returns.twr, 0.1, 1e-9) && assembled.freshness.verified);

// ---------- mutations (really executed, must flip) ----------
const moduleSource = readFileSync(join(ROOT, "server/src/overviewUpgrade.ts"), "utf8");
async function mutatedModule(replacements) {
  let src = moduleSource;
  for (const [anchor, replacement] of replacements) {
    if (!src.includes(anchor)) throw new Error(`mutation anchor missing: ${anchor}`);
    src = src.replace(anchor, replacement);
  }
  if (src === moduleSource) throw new Error("mutation did not change the source");
  const dir = mkdtempSync(join(tmpdir(), "overview-upgrade-mut-"));
  const file = join(dir, "overviewUpgrade.ts");
  writeFileSync(file, src);
  try {
    return await import(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const m1 = await mutatedModule([["const grown = current.value - current.flow;", "const grown = current.value + current.flow;"]]);
check("mutation M1 (TWR flow sign flipped) flips: +10.00% -> +32.00%",
  approx(m1.computeTimeWeightedReturn(twrPoints), 0.32, 1e-9)
  && !approx(m1.computeTimeWeightedReturn(twrPoints), 0.1, 1e-9));
const m2 = await mutatedModule([["export const OVERVIEW_ACTION_LIMIT = 5;", "export const OVERVIEW_ACTION_LIMIT = 2;"]]);
check("mutation M2 (action cap 5 -> 2) flips: the rich fixture drops to 2 items",
  m2.buildOverviewActions({
    asOf: AS_OF,
    openPositions: [{ ticker: "BETA", kindLabel: "CSP 现金担保看跌", exp: "2026-11-21", daysToExpiry: 7 }],
    gates: [{ ticker: "ACME", state: "blocked", spreadPp: -3.2 }, { ticker: "CORP", state: "blocked", spreadPp: -0.5 }],
    earnings: [], reviewPendingTotal: 7, closedTrades: [],
  }).length === 2);
const m3 = await mutatedModule([["? round2(total - investable) : null;", "? round2(total + investable) : null;"]]);
check("mutation M3 (difference sign flipped) flips: 150000 -> 1750000",
  m3.buildDualNetWorth({ investable: 800000, deposits: 200000, loans: 50000, totalNetWorth: 950000, homeValue: 120000 }).difference === 1750000);

// ---------- wiring ----------
const actionsSrc = readFileSync(join(ROOT, "server/src/actions.ts"), "utf8");
const appSrc = readFileSync(join(ROOT, "client/src/App.tsx"), "utf8");
const css = readFileSync(join(ROOT, "client/src/theme.css"), "utf8");
check("module: zero imports (pure, validator-gradeable)",
  !moduleSource.split("\n").some((line) => line.startsWith("import ")));
check("module: does not touch the drift-frozen modules",
  !moduleSource.includes("recurringCharges") && !moduleSource.includes("cashFlowForecast"));
check("wiring: getDashboard gains the additive overviewUpgrade field (schema + guest null + adapter)",
  actionsSrc.includes("overviewUpgrade: overviewUpgradeSchema.nullable().optional()")
  && actionsSrc.includes("buildOverviewUpgradeViewFromDashboard")
  && actionsSrc.includes("overviewUpgrade: null,"));
check("wiring: overview tab renders freshness, hero, action bar and return section above/inside the kept structure",
  appSrc.includes("OverviewFreshnessLine") && appSrc.includes("DualNetWorthHero")
  && appSrc.includes("OverviewActionBar") && appSrc.includes("ReturnMetricsSection")
  && appSrc.includes("overviewUpgrade={overviewUpgrade}"));
check("wiring: hero copy carries both caliber notes and the honest empty texts",
  appSrc.includes("暂无可比数据") && appSrc.includes("暂无可比")
  && moduleSource.includes("含 401k/HSA，不含银行存款与自住房") && moduleSource.includes("含自住房估值与银行存款"));
check("wiring: CSS keeps 44px action/factor rows and the dual-hero grid",
  css.includes(".overview-action {") && css.includes("min-height: 44px")
  && css.includes(".dual-hero {") && css.includes(".return-factor {"));
check("wiring: no new migration beyond 0010 (additive field only)",
  readdirSync(join(ROOT, "drizzle")).filter((f) => f.endsWith(".sql")).every((f) => f.slice(0, 4) <= "0010"));

// ---------- wording scan ----------
// The brief mandates two factual strings that contain a
// scanned word as part of a rule statement, not as advice:
// the wash-sale window line （亏损卖出…IRA 不买同名） is the
// brief's own item (5) wording, and the premium factor's
// 已实现权利金 is a fact label. Only those exact templates
// are allowlisted; everything else must be clean.
const ALLOWLIST = ["亏损卖出，30 天内 IRA 不买同名（窗口至"];
function wordingHits(src) {
  let cleaned = src;
  for (const allowed of ALLOWLIST) cleaned = cleaned.split(allowed).join("");
  const hits = [];
  for (const word of ["建议", "推荐", "应当", "买入", "卖出"]) {
    if (cleaned.includes(word)) hits.push(word);
  }
  return hits;
}
check("wording: overviewUpgrade.ts carries no advice language outside the mandated wash-sale template",
  wordingHits(moduleSource).length === 0);
const overviewBlockStart = appSrc.indexOf("// F-DASH-P0-4 overview upgrade");
const overviewBlock = overviewBlockStart >= 0 ? appSrc.slice(overviewBlockStart, appSrc.indexOf("function OverviewTab", overviewBlockStart)) : "";
check("wording: the new client blocks carry no advice language",
  overviewBlock !== "" && wordingHits(overviewBlock).length === 0);
check("wording: no META example anywhere in the new sources",
  !moduleSource.includes("META") && !overviewBlock.includes("META"));

console.log(`validate-overview-upgrade: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
