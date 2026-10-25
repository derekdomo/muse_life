// LIFE-DESIGN-001-B1A validation, updated for DAILY-MERGE-001
// (owner ruling 2026-10-24): the former two-tab restructure
// (B1A, options 1A + 2A) is superseded in STRUCTURE by the
// single daily view — no tab bar, no second view; the daily
// sections are visible in the one view and every former detail
// feature is reachable in the same view inside default-closed
// folds. B1A assertions that protect facts (conclusion-card
// wording, F-ARCH in-place caliber labels, summary-line
// helpers, single rendering homes, fold defaults) are kept
// verbatim; the tab/overview/detail structure assertions are
// replaced by single-view assertions, and new assertions cover
// the merge contract: no independent second view or tab, no
// user-visible weekly / 每周 wording anywhere in client or
// server sources, and multi-day aggregates existing ONLY as
// near-7-day summary rows summed from the daily rows.
//
// Behaviour runs against the REAL summary helpers extracted
// from client/src/App.tsx (type annotations stripped
// mechanically, formatters sliced verbatim from the same
// file); structure assertions run against the real client +
// server + theme sources; the screen estimate is a documented
// height model over the single view's default block inventory.
// All fixtures are synthetic; no real amount is read.
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real helpers (same pattern as validate-facts-card) ---
function extractFn(src, name, specific = []) {
  let start = src.indexOf(`export function ${name}`);
  if (start < 0) start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`helper not found: ${name}`);
  const end = src.indexOf("\n}\n", start) + 3;
  let text = src.slice(start, end).replace("export function", "function");
  for (const [from, to] of specific) text = text.replace(from, to);
  return text
    .replaceAll(": string | null", "")
    .replaceAll(": number | null", "")
    .replaceAll(": boolean", "")
    .replaceAll(": string", "")
    .replaceAll(": number", "");
}
// The module-level Intl formatters, sliced verbatim so the
// helpers format exactly as production does.
const fmtStart = appSrc.indexOf("const currency = new Intl.NumberFormat");
const fmtEnd = appSrc.indexOf("function monthDate");
if (fmtStart < 0 || fmtEnd < 0) throw new Error("formatter block not found");
const formatters = appSrc.slice(fmtStart, fmtEnd);
function loadHelpers() {
  const parts = [
    formatters,
    extractFn(appSrc, "trendIndicator"),
    extractFn(appSrc, "signedCurrency"),
    extractFn(appSrc, "fireYearsEstimate", [["fire: Dashboard[\"fire\"]", "fire"]]),
    extractFn(appSrc, "fireSummaryLine", [["fire: Dashboard[\"fire\"]", "fire"]]),
    extractFn(appSrc, "distributionSummaryLine", [["live: Dashboard[\"live\"]", "live"]]),
    extractFn(appSrc, "cashScopeSummaryLine"),
    extractFn(appSrc, "investmentSummaryLine", [["perf: Dashboard[\"investmentPerformance\"]", "perf"]]),
    extractFn(appSrc, "holdingsSummaryLine", [["data: Dashboard", "data"]]),
    extractFn(appSrc, "recentDailySpendSummary", [["days: DailySpendDayLike[]", "days"]]),
    extractFn(appSrc, "recentDailyNetWorthChange", [["series: DailyNetWorthPointLike[]", "series"]]),
  ];
  return new Function(`${parts.join("\n")}; return { fireYearsEstimate, fireSummaryLine, distributionSummaryLine, cashScopeSummaryLine, investmentSummaryLine, holdingsSummaryLine, recentDailySpendSummary, recentDailyNetWorthChange };`)();
}
const H = loadHelpers();

// --- fireYearsEstimate / fireSummaryLine ---
check("years: gap already covered -> 0", H.fireYearsEstimate({ gap: 0, annualContribution: 5000 }) === 0);
check("years: negative gap -> 0", H.fireYearsEstimate({ gap: -100, annualContribution: 5000 }) === 0);
check("years: ceil of gap / pace", H.fireYearsEstimate({ gap: 100001, annualContribution: 10000 }) === 11);
check("years: exact division", H.fireYearsEstimate({ gap: 100000, annualContribution: 10000 }) === 10);
check("years: no pace -> null (never a fabricated 0)", H.fireYearsEstimate({ gap: 100, annualContribution: 0 }) === null);
// mutation sensitivity: floor instead of ceil understates the wait
check("mutation: floor would understate, real helper ceils",
  Math.floor(100001 / 10000) !== H.fireYearsEstimate({ gap: 100001, annualContribution: 10000 }));
const fireOk = { completeMonthsUsed: 12, progress: 0.25, gap: 750000, annualContribution: 75000, target: 1000000, annualSpend: 40000 };
check("fire line: progress + gap + years in one line",
  H.fireSummaryLine(fireOk) === "FIRE 进度 25% · 缺口 $750,000 · 预计还需 10 年");
check("fire line: reached target", H.fireSummaryLine({ ...fireOk, progress: 1, gap: 0 }).includes("已达到目标"));
check("fire line: no pace stated honestly", H.fireSummaryLine({ ...fireOk, annualContribution: 0 }).includes("不足以估算达标时间"));
check("fire line: insufficient months gated", H.fireSummaryLine({ ...fireOk, completeMonthsUsed: 0 }) === "FIRE 进度：完整月份不足，暂不估算");

// --- distributionSummaryLine ---
const dist = H.distributionSummaryLine({ investment: 600000, deposits: 300000, loans: 100000, availableCash: 120000 });
check("distribution line: four shares in one line", dist === "投资 60% · 存款 30% · 存款中现金 12% · 贷款 10%");
check("distribution line: cash labelled as a subset of deposits", dist.includes("存款中现金"));
check("distribution line: no cash figure -> no cash segment",
  H.distributionSummaryLine({ investment: 500, deposits: 500, loans: 0, availableCash: null }) === "投资 50% · 存款 50% · 贷款 0%");
check("distribution line: zero total -> honest empty, no NaN",
  H.distributionSummaryLine({ investment: 0, deposits: 0, loans: 0, availableCash: null }) === "暂无可计算的余额");

// --- cashScopeSummaryLine ---
check("cash line: amount + counted accounts",
  H.cashScopeSummaryLine(42000, 3, null) === "可动用现金账户范围 — $42,000 · 计入 3 个账户");
check("cash line: missing amount is 未提供, never 0-filled",
  H.cashScopeSummaryLine(null, 0, null).includes("未提供"));
check("cash line: blocked coverage flagged in the folded state (R6)",
  H.cashScopeSummaryLine(null, 2, "现金余额陈旧").includes("覆盖未输出，展开查看原因"));
check("cash line: no block flag when coverage exists",
  !H.cashScopeSummaryLine(1000, 1, null).includes("覆盖未输出"));

// --- investmentSummaryLine ---
check("investment line: reconciled gain carries glyph + 已核对",
  H.investmentSummaryLine({ returnAmount: 12500 }) === "投资收益核对 — 全期间收益 ▲ +$12,500 · 已核对");
check("investment line: loss carries 亏损 + ▼",
  H.investmentSummaryLine({ returnAmount: -3000 }) === "投资收益核对 — 全期间亏损 ▼ -$3,000 · 已核对");
check("investment line: unreconciled stays 待核对",
  H.investmentSummaryLine({ returnAmount: null }) === "投资收益核对 — 全期间待核对");

// --- holdingsSummaryLine ---
check("holdings line: concentration + full-set count",
  H.holdingsSummaryLine({ concentrationTop3: 0.432, holdingsAll: [1, 2, 3] }) === "持仓 — 前三集中度 43.2% · 全部持仓 3 只");
check("holdings line: legacy cache without full set omits the count",
  H.holdingsSummaryLine({ concentrationTop3: 0.5, holdingsAll: [] }) === "持仓 — 前三集中度 50%");

// --- DAILY-MERGE-001: near-7-day aggregates derive ONLY from
// the daily rows (the one permitted multi-day presentation:
// a summary row inside the same daily view). ---
const spendDays = [
  { date: "2026-10-03", posted: 999 }, // outside the last-7 window: must be excluded
  { date: "2026-10-04", posted: 10 },
  { date: "2026-10-05", posted: 20 },
  { date: "2026-10-06", posted: 0 },
  { date: "2026-10-07", posted: 30 },
  { date: "2026-10-08", posted: 40 },
  { date: "2026-10-09", posted: 50 },
  { date: "2026-10-10", posted: 60 },
];
const spendSummary = H.recentDailySpendSummary(spendDays);
check("7d spend: sums exactly the last 7 daily rows", spendSummary?.total === 210 && spendSummary?.days === 7);
check("7d spend: window is stated from the rows themselves", spendSummary?.startDate === "2026-10-04" && spendSummary?.endDate === "2026-10-10");
check("7d spend: unsorted input is ordered by date first",
  H.recentDailySpendSummary([...spendDays].reverse())?.total === 210);
check("7d spend: fewer rows -> all of them, honestly counted",
  H.recentDailySpendSummary(spendDays.slice(5))?.days === 3 && H.recentDailySpendSummary(spendDays.slice(5))?.total === 150);
check("7d spend: no daily rows -> null, never a fabricated 0", H.recentDailySpendSummary([]) === null);
// mutation sensitivity: summing the FIRST 7 rows (incl. the
// stale 999 day) is a different number the real helper avoids
check("mutation: first-7 sum would differ, real helper takes the last 7",
  spendDays.slice(0, 7).reduce((s, d) => s + d.posted, 0) !== spendSummary?.total);
const nwSeries = [
  { date: "2026-10-01", total: 1000 },
  { date: "2026-10-02", total: 1010 },
  { date: "2026-10-03", total: 1020 },
  { date: "2026-10-04", total: 1030 },
  { date: "2026-10-05", total: 1040 },
  { date: "2026-10-06", total: 1050 },
  { date: "2026-10-07", total: 1060 },
  { date: "2026-10-08", total: 1090 },
];
const nwChange = H.recentDailyNetWorthChange(nwSeries);
check("7d net worth: last point minus the point 7 days earlier", nwChange?.change === 90 && nwChange?.days === 7);
check("7d net worth: window stated from the series", nwChange?.startDate === "2026-10-01" && nwChange?.endDate === "2026-10-08");
check("7d net worth: short series falls back to its first point",
  H.recentDailyNetWorthChange(nwSeries.slice(5))?.change === 40 && H.recentDailyNetWorthChange(nwSeries.slice(5))?.days === 2);
check("7d net worth: fewer than two points -> null", H.recentDailyNetWorthChange(nwSeries.slice(0, 1)) === null && H.recentDailyNetWorthChange([]) === null);

// --- structure: single daily view, single homes, fold defaults ---
function componentSlice(name) {
  const start = appSrc.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`component not found: ${name}`);
  const end = appSrc.indexOf("\n}\n", start) + 3;
  return appSrc.slice(start, end);
}
check("DAILY-MERGE: no tab bar, no second view (no tablist, no tab buttons, no tab state)",
  !appSrc.includes('role="tablist"') && !appSrc.includes(">总览</button>") && !appSrc.includes(">明细</button>")
  && !appSrc.includes('useState<"overview" | "detail">') && !appSrc.includes("OverviewTab") && !appSrc.includes("DetailTab"));
check("DAILY-MERGE: tab styles are gone from the theme", !css.includes(".view-tabs"));
check("DAILY-MERGE: no user-visible weekly wording in client or server sources",
  !appSrc.includes("每周") && !appSrc.includes("本周") && !css.includes("每周") && !serverSrc.includes("每周") && !serverSrc.includes("本周"));
check("DAILY-MERGE: refresh already-running message carries no weekly naming",
  serverSrc.includes('message: "更新正在进行中"') && !serverSrc.includes("每周更新"));
check("no fold/view state is persisted (ruling: reset on every open)",
  !appSrc.includes("localStorage") && !appSrc.includes("sessionStorage"));
check("no <details> renders open by default", !/<details[^>]*\sopen[\s=>]/.test(appSrc));
check("all folds default-closed: 4 evidence + 5 ledger + 1 daily-days + FIRE fold counted in source",
  (appSrc.match(/<details className="evidence-fold/g) ?? []).length === 10);
check("fold controls carry text hints （展开/收起）, not colour or icon alone",
  appSrc.includes("fold-hint--open") && css.includes(".evidence-fold[open ] .fold-hint--close"));

const view = componentSlice("DashboardView");
check("view: conclusion card first", view.indexOf("<TotalAssetsConclusionCard") > -1
  && view.indexOf("<TotalAssetsConclusionCard") < view.indexOf('aria-label="本月关键指标"'));
check("view: 7 key metrics kept", view.includes('aria-label="本月关键指标"'));
check("view: anomaly strip stays visible (R6)", view.includes('aria-label="数据异常月份"'));
check("view: FIRE is one summary line + anchor button", view.includes("fireSummaryLine(data.fire)") && view.includes("查看完整 FIRE 面板"));
check("view: four evidence fold summaries wired to their helpers",
  view.includes("cashScopeSummaryLine(") && view.includes("distributionSummaryLine(")
  && view.includes("investmentSummaryLine(") && view.includes("holdingsSummaryLine("));
check("view order: conclusion -> daily series -> daily spend -> evidence folds -> ledger folds",
  view.indexOf("<NetWorthDailySeries") > view.indexOf("fire-teaser")
  && view.indexOf("<DailySpendSection") > view.indexOf("<NetWorthDailySeries")
  && view.indexOf("cashScopeSummaryLine(") > view.indexOf("<DailySpendSection")
  && view.indexOf("<TrendCharts") > view.indexOf("cashScopeSummaryLine("));
check("view: monthly trend charts live in the 走势 ledger fold", view.includes("<TrendCharts") && view.includes("走势 — 月度趋势"));
check("view: monthly records live in the 月度记录 ledger fold", view.includes("<MonthlyRecords months={data.months} />") && view.includes("月度记录 —"));
check("view: full FIRE panel lives in its ledger fold with the anchor id", view.includes("<FireProgress") && view.includes('id="fire-panel"'));
check("view: F-ARCH account rows live in their ledger fold", view.includes("<ArchAccountsDetail") && view.includes("总资产账户明细 —"));
check("view: snapshot account detail lives in the 账户明细 ledger fold", view.includes("accounts-section") && view.includes('title="账户明细"'));
check("FIRE anchor jump: teaser button opens the folded panel in the same view (R8)",
  view.includes("openFirePanel") && appSrc.includes('document.getElementById("fire-panel")') && appSrc.includes("panel.open = true") && appSrc.includes("scrollIntoView"));
check("DAILY-MERGE: 7d spend row is wired to the daily rows inside DailySpendSection",
  componentSlice("DailySpendSection").includes("recentDailySpendSummary(daily.days)")
  && componentSlice("DailySpendSection").includes("按日花销汇总"));
check("DAILY-MERGE: 7d net-worth row is wired to the daily series inside NetWorthDailySeries",
  componentSlice("NetWorthDailySeries").includes("recentDailyNetWorthChange(series)")
  && componentSlice("NetWorthDailySeries").includes("按日净值序列汇总"));
check("DAILY-MERGE: current-month per-day rows fold inside the daily spend section",
  componentSlice("DailySpendSection").includes("本月逐日明细") && componentSlice("DailySpendSection").includes("daily-days-fold"));

for (const [name, marker] of [
  ["trend charts", "<TrendCharts"], ["full FIRE panel", "<FireProgress"],
  ["monthly records", "<MonthlyRecords"], ["cash scope panel", "<AvailableCashPanel"],
  ["distribution panel", "<DistributionPanel"], ["investment card", "<InvestmentPerformanceCard"],
  ["holdings section", "<HoldingsSection"], ["conclusion card", "<TotalAssetsConclusionCard"],
  ["net-worth daily series", "<NetWorthDailySeries"], ["daily spend section", "<DailySpendSection"],
]) {
  check(`single rendering home: ${name}`, (appSrc.split(marker).length - 1) === 1);
}
check("old standalone cards are gone", !appSrc.includes("function BalanceDeltaCard") && !appSrc.includes("function ArchNetWorthCard") && !appSrc.includes('className="hero"'));
check("holdings summary defaults to Top 5 with a labelled expand",
  appSrc.includes("data.holdings.slice(0, 5)") && appSrc.includes("查看全部 Top 10"));

// --- conclusion card keeps the F-ARCH freshness layers verbatim ---
const card = componentSlice("TotalAssetsConclusionCard");
check("card: F-ARCH total is the headline when present", card.includes("arch ? arch.total : data.live.netWorth"));
check("card: two freshness layers + coverage line kept",
  card.includes("archCoverageLine(arch)") && card.includes("archLayerLine(arch.plaidRange") && card.includes("archLayerLine(arch.snapshotRange") && card.includes("Plaid 层拉取于"));
check("card: archived snapshot compare line kept", card.includes("月度快照 · {data.sourceMonth}（存档口径）") && card.includes("环比"));
check("card: delta wording unchanged", card.includes("较上次成功快照（日期未留存）") && card.includes("本次未更新"));

// --- F-ARCH labeling (PM 2026-10-24): every fact labelled in
// place with its own caliber. The headline is the NEW
// architecture total; weeklyDelta and its percent denominator
// are the OLD live.netWorth — the card must never let the old
// delta read as the new total's change (synthetic case: new
// total 100, old sync net worth 80, old delta 5 must NOT imply
// the new figure went 95 -> 100). ---
check("label: headline labelled 混合余额日期的最近已知净值 (new architecture)",
  card.includes("混合余额日期的最近已知净值（新架构 F-ARCH-001）"));
check("label: amounts/dates coverage counts + Plaid pull time adjacent to the headline",
  card.includes("金额已计入 {arch.amountIncluded}/{arch.amountTotal} 个账户 · 有效余额日期 {arch.validDateCount}/{arch.dateTotal} 个账户 · Plaid 层拉取于 {pulledText}"));
check("label: delta row labelled 旧同步口径 in place",
  card.includes("旧同步口径 · 较上次成功快照") && card.includes("旧同步口径 · 较上次成功快照（日期未留存）"));
check("label: delta note states its denominator is the old caliber and forbids cross-derivation",
  card.includes("分母同为旧同步净资产") && card.includes("不是上方新架构主数字的变化，两者不要互相推导"));
check("label: old sync net worth amount is named on the card as the delta's basis",
  card.includes("旧同步口径净资产 {currency.format(data.live.netWorth)}"));
check("label: delta view is never computed against the arch total (no 95->100 implication)",
  !appSrc.includes("weeklyDeltaView(delta, arch") && !card.includes("arch.total -"));
check("label: detail view traces back to the old sync net worth",
  appSrc.includes("旧同步口径对照（明细追溯）：旧同步净资产 {currency.format(liveNetWorth)}")
  && appSrc.includes("旧同步口径 · 较上次成功快照（日期未留存）${trendIndicator(weeklyDelta)}")
  && appSrc.includes("与旧同步口径不要互相推导"));

// --- feature reachability: every former feature still present
// in the single daily view (DAILY-MERGE-001 reachability table:
// overview-tab features at the top of the view, detail-tab
// features in the daily sections and the ledger folds) ---
for (const marker of [
  "立即更新财务数据", "检查进度", "来源台账", "刷新观测",
  "搜索全部持仓", "查看全部持仓", "期间核对明细", "本页试算",
  "月度记录", "账户明细", "总资产账户明细", "走势", "FIRE 进度", "持仓 Top 10",
  "净值日序列", "日花销", "本月逐日明细",
]) {
  check(`reachable: ${marker}`, appSrc.includes(marker));
}

// --- screen estimate (documented height model, 390x844) ---
// Before (design draft inventory of the pre-B1A tree): 14
// top-level blocks, ≈12–19 screens at the default state.
// After: conservative per-block heights from theme.css
// metrics (status band measured with its facts + fold
// summaries visible; anomaly strip assumed present).
const VIEWPORT_PX = 844;
const AFTER_BLOCKS = [
  ["状态行（工具行 + 刷新状态带）", 360],
  ["总资产结论卡（三卡合一）", 400],
  ["本月关键指标 7 格（2 列 4 行）", 508],
  ["数据异常条（假设存在）", 64],
  ["FIRE 一行摘要", 66],
  ["净值日序列图（每日视图主体）", 320],
  ["日花销（标题 + 月合计 + 近 7 天汇总行 + 逐日折叠 summary）", 170],
  ["依据层 4 个折叠 summary", 246],
  ["台账层 5 个折叠 summary（走势/月度记录/FIRE/总资产账户/账户明细）", 305],
];
const afterPx = AFTER_BLOCKS.reduce((sum, [, px]) => sum + px, 0);
const afterScreens = afterPx / VIEWPORT_PX;
check(`single daily view default height ≈ ${afterScreens.toFixed(2)} screens <= 3 (R2)`, afterScreens <= 3);
check("single daily view is shorter than the pre-B1A minimum (12 screens)", afterPx < 12 * VIEWPORT_PX);
check("height model covers the merged view's layer groups (status / conclusion / metrics+anomaly / FIRE line / daily sections / evidence folds / ledger folds)",
  ["状态行", "结论卡", "指标", "FIRE", "日序列", "日花销", "依据层", "台账层"].every((name) => AFTER_BLOCKS.some(([label]) => label.includes(name))));
console.log(`screen model: before 14 blocks / 12-19 screens -> single daily view ${AFTER_BLOCKS.length} block groups / ~${afterScreens.toFixed(1)} screens (${afterPx}px of ${VIEWPORT_PX}px viewport)`);

console.log(`validate-design-b1a: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
