// F2.1 validation: the overview tab's top summary strip —
// at most three fact cards （净资产变化 / 现金覆盖变化 /
// 当月支出进度）, each with its comparison interval and its
// source completeness stated as text, each judging its own
// comparability independently (no fabricated delta, no
// 0-filled comparison, no advice wording).
//
// Behaviour runs against the REAL pure builders extracted
// from client/src/App.tsx (netWorthSummaryCard /
// cashCoverageSummaryCard / monthSpendProgressCard, plus the
// production helpers they compose: weeklyDeltaView,
// balanceSourceSummary, trendIndicator, signedCurrency,
// integrityLabel and the real Intl formatters sliced
// verbatim). Wiring assertions run against the real client +
// theme sources. All fixtures are synthetic; no real amount
// is read, and app.db is never touched.
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real formatters + helpers from App.tsx ---
function extractConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`const not found: ${name}`);
  const end = src.indexOf("});", start) + 3;
  return src.slice(start, end);
}
function extractFn(src, name, specific = []) {
  let start = src.indexOf(`export function ${name}`);
  if (start < 0) start = src.indexOf(`\nfunction ${name}`);
  if (start < 0) throw new Error(`helper not found: ${name}`);
  const end = src.indexOf("\n}\n", start) + 3;
  let text = src.slice(start, end).replace("export function", "function");
  for (const [from, to] of specific) text = text.replaceAll(from, to);
  return text
    .replaceAll(": number | null", "")
    .replaceAll(": string | null", "")
    .replaceAll(": SummaryCardView", "")
    .replaceAll(": WeeklyDeltaView", "")
    .replaceAll(": boolean", "")
    .replaceAll(": string[]", "")
    .replaceAll(": string", "")
    .replaceAll(": number", "");
}
const ACCOUNTS_PARAM = ["accounts: Array<{ type: string; live: boolean }>", "accounts"];
const INTEGRITY_PARAM = ['integrity: Month["integrity"]', "integrity"];
function bundleSrc(overrides = {}) {
  const parts = [
    extractConst(appSrc, "currency"),
    extractConst(appSrc, "percent"),
    extractConst(appSrc, "number"),
    extractConst(appSrc, "dateLabel"),
    extractFn(appSrc, "signedCurrency"),
    extractFn(appSrc, "trendIndicator"),
    extractFn(appSrc, "weeklyDeltaView"),
    extractFn(appSrc, "balanceSourceSummary", [ACCOUNTS_PARAM]),
    extractFn(appSrc, "integrityLabel", [INTEGRITY_PARAM]),
    extractFn(appSrc, "netWorthSummaryCard", [ACCOUNTS_PARAM]),
    extractFn(appSrc, "cashCoverageSummaryCard"),
    extractFn(appSrc, "monthSpendProgressCard", [INTEGRITY_PARAM]),
  ];
  let text = parts.join("\n");
  for (const [from, to] of Object.entries(overrides)) {
    if (!text.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}
function loadBuilders(overrides) {
  const src = bundleSrc(overrides);
  return new Function(`${src}; return { netWorthSummaryCard, cashCoverageSummaryCard, monthSpendProgressCard };`)();
}
const { netWorthSummaryCard, cashCoverageSummaryCard, monthSpendProgressCard } = loadBuilders();

const KEYS = ["2026-07", "2026-08", "2026-09"];
const MIXED_ACCOUNTS = [
  { type: "account", live: true },
  { type: "investment", live: false },
  { type: "income", live: true },
];

// --- card 1: 净资产变化 (weeklyDeltaView caliber) ---
const nwUp = netWorthSummaryCard(5000, 105000, "2026-10-24", MIXED_ACCOUNTS);
check("card1 complete: comparable with direction 增加", nwUp.comparable === true && nwUp.direction === "增加");
check("card1 complete: glyph + signed amount + percent ride together", nwUp.directionGlyph === "▲" && nwUp.valueLine.includes("+") && nwUp.valueLine.includes("$5,000") && nwUp.valueLine.includes("5%"));
check("card1 complete: comparison interval names the previous successful snapshot, date honestly unretained",
  nwUp.compareLine.includes("较上次成功快照") && nwUp.compareLine.includes("日期未留存"));
check("card1 complete: source completeness = asOf date + balance-source composition (facts-card caliber)",
  nwUp.sourceLine.includes("数据日期") && !nwUp.sourceLine.includes("数据日期 未提供") && nwUp.sourceLine.includes("余额来源："));
check("card1 complete: composition counts balance rows only (income row excluded)",
  nwUp.sourceLine.includes("1 个余额账户为同步读取值，1 个余额账户沿用月度快照值"));
const nwDown = netWorthSummaryCard(-2000, 98000, "2026-10-24", MIXED_ACCOUNTS);
check("card1 decrease: direction 减少 + ▼ + signed amount", nwDown.direction === "减少" && nwDown.directionGlyph === "▼" && nwDown.valueLine.includes("-$2,000") || nwDown.valueLine.includes("-") && nwDown.valueLine.includes("2,000"));
const nwFlat = netWorthSummaryCard(0, 100000, "2026-10-24", MIXED_ACCOUNTS);
check("card1 flat: direction 持平 with the flat glyph (never up/down)", nwFlat.comparable === true && nwFlat.direction === "持平" && nwFlat.directionGlyph === "—");
const nwNone = netWorthSummaryCard(null, 100000, "2026-10-24", MIXED_ACCOUNTS);
check("card1 no comparable snapshot: honest 暂无可比快照 state, no fabricated amount",
  nwNone.comparable === false && nwNone.direction === "无法比较" && nwNone.valueLine === "暂无可比快照" && !nwNone.valueLine.includes("$"));
check("card1 no comparable snapshot: source completeness still stated", nwNone.sourceLine.includes("余额来源："));
const nwSnapOnly = netWorthSummaryCard(100, 100100, "2026-10-24", [{ type: "account", live: false }, { type: "account", live: false }]);
check("card1 all-snapshot sources: composition says so verbatim", nwSnapOnly.sourceLine.includes("全部 2 个余额账户沿用月度快照值"));

// --- card 2: 现金覆盖变化 (F1.1 caliber) ---
const ccUp = cashCoverageSummaryCard(6.5, 5.0, 19500, 3000, KEYS, null, false);
check("card2 complete: comparable, direction 增加 + ▲ + signed month diff",
  ccUp.comparable === true && ccUp.direction === "增加" && ccUp.directionGlyph === "▲" && ccUp.valueLine.includes("+1.5 个月"));
check("card2 complete: current and previous figures both named", ccUp.valueLine.includes("当前 6.5 个月") && ccUp.valueLine.includes("上次 5 个月"));
check("card2 complete: source completeness names cash, average spend, basis months and the F1.1 caliber",
  ccUp.sourceLine.includes("$19,500") && ccUp.sourceLine.includes("$3,000") && ccUp.sourceLine.includes("2026-07、2026-08、2026-09") && ccUp.sourceLine.includes("F1.1 口径"));
const ccDown = cashCoverageSummaryCard(4, 5, 12000, 3000, KEYS, null, false);
check("card2 decrease: direction 减少 + ▼ + signed diff", ccDown.direction === "减少" && ccDown.directionGlyph === "▼" && ccDown.valueLine.includes("-1 个月"));
const ccFlat = cashCoverageSummaryCard(5, 5, 15000, 3000, KEYS, null, false);
check("card2 flat: direction 持平 with the flat glyph", ccFlat.comparable === true && ccFlat.direction === "持平" && ccFlat.directionGlyph === "—");
const ccNoPrev = cashCoverageSummaryCard(6.5, null, 19500, 3000, KEYS, null, false);
check("card2 no previous fact (the production case): change honestly 暂无可比， current figure still shown",
  ccNoPrev.comparable === false && ccNoPrev.direction === "无法比较" && ccNoPrev.compareLine.includes("暂无可比") && ccNoPrev.valueLine === "当前覆盖 6.5 个月");
check("card2 no previous fact: no fabricated previous figure or delta anywhere",
  !ccNoPrev.valueLine.includes("上次") && !ccNoPrev.compareLine.includes("个月）") && !ccNoPrev.valueLine.includes("+") && !ccNoPrev.valueLine.includes("-"));
const ccBlocked = cashCoverageSummaryCard(null, null, 9000, null, [], "完整有效月不足：已有 2 个，缺 1 个", false);
check("card2 coverage not produced: no figure, no change, the blocking reason is the source line",
  ccBlocked.comparable === false && ccBlocked.valueLine === "覆盖未输出" && ccBlocked.sourceLine.includes("缺 1 个") && !ccBlocked.valueLine.includes("个月"));
const ccTrial = cashCoverageSummaryCard(6.5, null, 19500, 3000, KEYS, null, true);
check("card2 trial scope: the on-page trial is labelled on the source line", ccTrial.sourceLine.includes("本页试算"));

// --- card 3: 当月支出进度 (completeSpendBasis caliber) ---
const spOk = monthSpendProgressCard(1800, "2026-10-24", "partial", 3000, 3, 0, KEYS);
check("card3 complete: progress = spent ÷ 3-month average, as a percent fact",
  spOk.comparable === true && spOk.valueLine.includes("$1,800") && spOk.valueLine.includes("进度 60%"));
check("card3 complete: a ratio carries no change-direction word", spOk.direction === null && spOk.directionGlyph === null);
check("card3 complete: comparison basis names the average and its months",
  spOk.compareLine.includes("近 3 个有效完整月平均支出") && spOk.compareLine.includes("$3,000") && spOk.compareLine.includes("2026-07、2026-08、2026-09"));
check("card3 complete: source completeness = as-of date + F0.4 integrity (partial)",
  spOk.sourceLine.includes("截至 2026-10-24") && spOk.sourceLine.includes("完整性 部分") && spOk.sourceLine.includes("F0.4"));
const spComplete = monthSpendProgressCard(3000, "2026-09-30", "complete", 3000, 3, 0, KEYS);
check("card3 integrity complete: labelled 完整， progress 100%", spComplete.sourceLine.includes("完整性 完整") && spComplete.valueLine.includes("进度 100%"));
const spUnknown = monthSpendProgressCard(100, "2026-10-24", "unknown", 3000, 3, 0, KEYS);
check("card3 integrity unknown: labelled 完整性未提供 (never upgraded to complete)", spUnknown.sourceLine.includes("完整性未提供"));
const spShort = monthSpendProgressCard(1800, "2026-10-24", "partial", 3000, 1, 2, ["2026-09"]);
check("card3 short sample: missing-month count named, NO progress figure output",
  spShort.comparable === false && spShort.compareLine.includes("缺 2 个") && !spShort.valueLine.includes("%") && spShort.valueLine.includes("$1,800"));
const spNull = monthSpendProgressCard(null, "2026-10-24", "partial", 3000, 3, 0, KEYS);
check("card3 spend unproven: no progress, no amount, direction 无法比较",
  spNull.comparable === false && spNull.direction === "无法比较" && !spNull.valueLine.includes("%") && !spNull.valueLine.includes("$"));
const spZeroAvg = monthSpendProgressCard(100, "2026-10-24", "complete", 0, 3, 0, KEYS);
check("card3 zero average: no division-by-zero progress is fabricated",
  spZeroAvg.comparable === false && spZeroAvg.compareLine.includes("平均支出为 0") && !spZeroAvg.valueLine.includes("%"));

// --- independent comparability: cards never borrow each
// other's facts (one comparable + two not, all still render) ---
check("independence: card1 comparable while card2/card3 are not (no cross-card filling)",
  nwUp.comparable === true && ccNoPrev.comparable === false && spShort.comparable === false);

// --- mutation sensitivity: real flips of production logic ---
const mutantGlyph = loadBuilders({ 'return value > 0 ? "▲" : "▼";': 'return value > 0 ? "▼" : "▲";' });
check("mutation M1: flipping trendIndicator's glyphs flips card 1's glyph (assertion would fail)",
  mutantGlyph.netWorthSummaryCard(5000, 105000, "2026-10-24", MIXED_ACCOUNTS).directionGlyph === "▼");
const mutantProgress = loadBuilders({ "const progress = spent / averageMonthlySpend;": "const progress = averageMonthlySpend / spent;" });
check("mutation M2: inverting the progress ratio flips card 3's percent (60% assertion would fail)",
  !mutantProgress.monthSpendProgressCard(1800, "2026-10-24", "partial", 3000, 3, 0, KEYS).valueLine.includes("进度 60%"));
const mutantGate = loadBuilders({ "if (previousMonths == null) {": "if (previousMonths != null) {" });
check("mutation M3: flipping the previous-coverage gate makes the no-previous case falsely comparable (assertion would fail)",
  mutantGate.cashCoverageSummaryCard(6.5, null, 19500, 3000, KEYS, null, false).comparable === true);

// --- wiring (real sources) ---
check("wiring: all three builders are exported from App.tsx",
  appSrc.includes("export function netWorthSummaryCard") && appSrc.includes("export function cashCoverageSummaryCard") && appSrc.includes("export function monthSpendProgressCard"));
check("wiring: card 1 reuses weeklyDeltaView on the live fields (no second caliber)",
  appSrc.includes("netWorthSummaryCard(data.live.weeklyDelta, data.live.netWorth, data.asOf, data.accounts)")
  && extractFn(appSrc, "netWorthSummaryCard", [ACCOUNTS_PARAM]).includes("weeklyDeltaView(delta, netWorth)"));
check("wiring: card 2's previous coverage is null by construction (payload carries no such fact)",
  appSrc.includes("cashCoverageSummaryCard(coverage.months, null,"));
check("wiring: card 3 derives from the current month + the shared completeSpendBasis result",
  appSrc.includes("monthSpendProgressCard(current.totalSpend, current.snapshotDate || current.key, current.integrity, spendBasis.averageMonthlySpend"));
const overviewStart = appSrc.indexOf("function OverviewTab");
const overviewSrc = appSrc.slice(overviewStart, appSrc.indexOf("\nfunction ", overviewStart + 10));
check("wiring: the strip renders at the TOP of the overview tab, before the conclusion card",
  overviewSrc.indexOf("<TopSummaryCards") > -1 && overviewSrc.indexOf("<TopSummaryCards") < overviewSrc.indexOf("<TotalAssetsConclusionCard"));
check("wiring: exactly one strip rendering home", (appSrc.split("<TopSummaryCards").length - 1) === 1);
check("wiring: the FIRE one-liner and its 线性估算 line are untouched",
  appSrc.includes("fireSummaryLine(data.fire)") && appSrc.includes("线性估算，不含投资回报"));
check("wiring: no advice wording in the F2.1 builders",
  !extractFn(appSrc, "netWorthSummaryCard", [ACCOUNTS_PARAM]).includes("建议")
  && !extractFn(appSrc, "cashCoverageSummaryCard").includes("建议")
  && !extractFn(appSrc, "monthSpendProgressCard", [INTEGRITY_PARAM]).includes("建议"));
const stripStart = appSrc.indexOf("function TopSummaryCards");
const f21Src = [
  extractFn(appSrc, "netWorthSummaryCard", [ACCOUNTS_PARAM]),
  extractFn(appSrc, "cashCoverageSummaryCard"),
  extractFn(appSrc, "monthSpendProgressCard", [INTEGRITY_PARAM]),
  appSrc.slice(stripStart, appSrc.indexOf("\nfunction ", stripStart + 10)),
].join("\n");
check("wiring: drift red line — F2.1 code never references the two frozen modules' fields",
  !f21Src.includes("recurringCharges") && !f21Src.includes("cashFlowForecast"));
check("wiring: theme carries the strip styles with a 44px heading row (touch rhythm)",
  css.includes(".summary-cards") && css.includes(".summary-card__direction")
  && css.slice(css.indexOf(".summary-card__heading"), css.indexOf(".summary-card__heading") + 200).includes("min-height: 44px"));

console.log(`validate-summary-cards: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
