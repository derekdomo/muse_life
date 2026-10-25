// LIFE-DESIGN-001-B1A validation, updated for the
// DAILY-MERGE-001 CORRECTION (owner correction 2026-10-24
// 21:16 PT): the "merge" is a DATA-CALIBER merge only — the
// page organisation returns to ruling 1: two tabs, 「总览」
// (overview, default) and 「明细」 (detail), tab state kept in
// mount-time component state only. Daily spend in the detail
// tab is a TRUE Calendar month grid (weekday header, aligned
// date cells, text amounts) built by the exported pure helpers
// buildSpendCalendarMonth / spendCalendarMonthSummary /
// buildSpendDayDetail — the old per-day LIST fold is gone.
// Assertions that protect facts (conclusion-card wording,
// F-ARCH in-place caliber labels, summary-line helpers, fold
// defaults, no persistence, no weekly wording in client or
// server sources, near-7-day aggregates summed only from the
// daily rows) are kept; the previous single-view assertions
// (no tablist etc.) were products of the misreading and are
// replaced by two-tab + Calendar assertions.
//
// Behaviour runs against the REAL helpers extracted from
// client/src/App.tsx (type annotations stripped mechanically,
// formatters sliced verbatim from the same file); structure
// assertions run against the real client + server + theme
// sources. All fixtures are synthetic; no real amount is read,
// and app.db is never touched.
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
// The category label table, sliced verbatim for the drill-down helper.
const labelsStart = appSrc.indexOf("export const dailyCategoryLabels");
const labelsEnd = appSrc.indexOf("export function dailyCategoryLabel");
if (labelsStart < 0 || labelsEnd < 0) throw new Error("category labels not found");
const categoryLabels = appSrc.slice(labelsStart, labelsEnd)
  .replace("export const", "const")
  .replace(": Record<string, string>", "");
function loadHelpers() {
  const parts = [
    formatters,
    categoryLabels,
    extractFn(appSrc, "dailyCategoryLabel"),
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
    extractFn(appSrc, "buildSpendCalendarMonth", [["days: SpendCalendarDayLike[]", "days"], ["cells: SpendCalendarCell[]", "cells"], ["weeks: SpendCalendarCell[][]", "weeks"]]),
    extractFn(appSrc, "spendCalendarMonthSummary", [["days: SpendCalendarDayLike[]", "days"]]),
    extractFn(appSrc, "spendCalendarMonthBounds"),
    extractFn(appSrc, "shiftSpendCalendarMonth"),
    extractFn(appSrc, "buildSpendDayDetail", [[": SpendDayDetail", ""], ["day: SpendCalendarDayLike | null", "day"]]),
  ];
  return new Function(`${parts.join("\n")}; return { fireYearsEstimate, fireSummaryLine, distributionSummaryLine, cashScopeSummaryLine, investmentSummaryLine, holdingsSummaryLine, recentDailySpendSummary, recentDailyNetWorthChange, buildSpendCalendarMonth, spendCalendarMonthSummary, spendCalendarMonthBounds, shiftSpendCalendarMonth, buildSpendDayDetail };`)();
}
const H = loadHelpers();

// --- fireYearsEstimate / fireSummaryLine ---
check("years: gap already covered -> 0", H.fireYearsEstimate({ gap: 0, annualContribution: 5000 }) === 0);
check("years: negative gap -> 0", H.fireYearsEstimate({ gap: -100, annualContribution: 5000 }) === 0);
check("years: ceil of gap / pace", H.fireYearsEstimate({ gap: 100001, annualContribution: 10000 }) === 11);
check("years: exact division", H.fireYearsEstimate({ gap: 100000, annualContribution: 10000 }) === 10);
check("years: no pace -> null (never a fabricated 0)", H.fireYearsEstimate({ gap: 100, annualContribution: 0 }) === null);
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

// --- near-7-day aggregates derive ONLY from the daily rows ---
const spendDays = [
  { date: "2026-10-03", posted: 999 },
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

// --- Calendar helpers: real month-grid behaviour ---
// Synthetic fixture: October 2026 (Oct 1 2026 is a Thursday, so
// the Monday-start offset is 3). One zero-spend day, one partial
// day, one missing day (Oct 3), today = Oct 24, Oct 25+ future.
const calDays = [
  { date: "2026-10-01", posted: 100, pending: 0, pendingCount: 0, spendCount: 2, partial: false, categories: [{ key: "FOOD_AND_DRINK", amount: 100 }], unclassified: [] },
  { date: "2026-10-02", posted: 0, pending: 0, pendingCount: 0, spendCount: 0, partial: false, categories: [], unclassified: [] },
  { date: "2026-10-05", posted: 50, pending: 20, pendingCount: 1, spendCount: 1, partial: true, categories: [{ key: "TRAVEL", amount: 30 }, { key: "FOOD_AND_DRINK", amount: 20 }], unclassified: ["txn-x"] },
  { date: "2026-10-24", posted: 10, pending: 0, pendingCount: 0, spendCount: 1, partial: false, categories: [{ key: "TRANSPORTATION", amount: 10 }], unclassified: [] },
];
const cal = H.buildSpendCalendarMonth(calDays, "2026-10", "2026-10-24");
check("calendar: month identity + length", cal.year === 2026 && cal.month === 10 && cal.daysInMonth === 31);
check("calendar: Monday-start offset for Oct 2026 (Thu 1st) is 3", cal.firstOffset === 3);
check("calendar: weeks are 5 rows of exactly 7 cells", cal.weeks.length === 5 && cal.weeks.every((w) => w.length === 7) && cal.cells.length === 35);
check("calendar: leading blanks pad the first week", cal.cells.slice(0, 3).every((c) => c.isBlank && c.date === null && c.day === null));
check("calendar: Oct 1 lands in the Thursday column (index 3)", cal.cells[3]?.date === "2026-10-01" && cal.cells[3]?.day === 1 && cal.weeks[0]?.[3]?.date === "2026-10-01");
check("calendar: weekday alignment holds all month (Oct 31 is Saturday, index 33)",
  cal.cells[33]?.date === "2026-10-31" && cal.cells[34]?.isBlank === true);
check("calendar: data day carries its amount", cal.cells[3]?.hasData === true && cal.cells[3]?.amount === 100);
check("calendar: zero-spend day is data with amount 0, not missing",
  cal.cells.find((c) => c.date === "2026-10-02")?.hasData === true && cal.cells.find((c) => c.date === "2026-10-02")?.amount === 0);
check("calendar: missing day (Oct 3) has no data and null amount",
  cal.cells.find((c) => c.date === "2026-10-03")?.hasData === false && cal.cells.find((c) => c.date === "2026-10-03")?.amount === null);
check("calendar: partial day is flagged on the cell model",
  cal.cells.find((c) => c.date === "2026-10-05")?.partial === true && cal.cells.find((c) => c.date === "2026-10-01")?.partial === false);
check("calendar: today cell is flagged (Oct 24)",
  cal.cells.find((c) => c.date === "2026-10-24")?.isToday === true && cal.cells.find((c) => c.date === "2026-10-23")?.isToday === false);
check("calendar: future days are flagged, today is not future",
  cal.cells.find((c) => c.date === "2026-10-25")?.isFuture === true && cal.cells.find((c) => c.date === "2026-10-24")?.isFuture === false
  && cal.cells.find((c) => c.date === "2026-10-01")?.isFuture === false);
check("mutation: a Sunday-start offset (4) would misalign Oct 2026, real helper uses Monday-start (3)",
  ((new Date(2026, 9, 1).getDay()) % 7) === 4 && cal.firstOffset === 3);
const feb = H.buildSpendCalendarMonth([], "2026-02", "2026-10-24");
check("calendar: Feb 2026 (Sun 1st) offset is 6 with 28 days / 35 cells",
  feb.firstOffset === 6 && feb.daysInMonth === 28 && feb.cells.length === 35 && feb.cells[6]?.date === "2026-02-01" && feb.cells[33]?.date === "2026-02-28");
const calSummary = H.spendCalendarMonthSummary(calDays, "2026-10", "2026-10-23");
check("calendar summary: total sums only that month's posted rows", calSummary.total === 160 && calSummary.count === 4);
check("calendar summary: daily average is total / days-with-data", calSummary.average === 40);
check("calendar summary: max day carries amount + date", calSummary.maxAmount === 100 && calSummary.maxDate === "2026-10-01");
check("calendar summary: through-month is recognised and dated",
  calSummary.isThroughMonth === true && calSummary.throughDate === "2026-10-23");
check("calendar summary: other months are not labelled through-months",
  H.spendCalendarMonthSummary(calDays, "2026-09", "2026-10-23").isThroughMonth === false
  && H.spendCalendarMonthSummary(calDays, "2026-09", "2026-10-23").total === 0
  && H.spendCalendarMonthSummary(calDays, "2026-09", "2026-10-23").average === null
  && H.spendCalendarMonthSummary(calDays, "2026-09", "2026-10-23").maxAmount === null);
check("calendar bounds: min is the coverage-start month, max is today's month",
  H.spendCalendarMonthBounds("2024-10-25", "2026-10-24").minMonth === "2024-10"
  && H.spendCalendarMonthBounds("2024-10-25", "2026-10-24").maxMonth === "2026-10");
check("calendar shift: forward / backward / across year boundary",
  H.shiftSpendCalendarMonth("2026-10", 1) === "2026-11"
  && H.shiftSpendCalendarMonth("2026-10", -1) === "2026-09"
  && H.shiftSpendCalendarMonth("2026-01", -1) === "2025-12"
  && H.shiftSpendCalendarMonth("2025-12", 1) === "2026-01");
const detailWithNw = H.buildSpendDayDetail(calDays[2], 12345);
check("drill-down: identity + precise posted + counts assembled",
  detailWithNw.hasData === true && detailWithNw.date === "2026-10-05" && detailWithNw.posted === 50
  && detailWithNw.pending === 20 && detailWithNw.pendingCount === 1 && detailWithNw.spendCount === 1);
check("drill-down: categories sorted by amount desc with Chinese labels",
  detailWithNw.categories.length === 2 && detailWithNw.categories[0]?.key === "TRAVEL"
  && detailWithNw.categories[0]?.label === "旅行" && detailWithNw.categories[1]?.label === "餐饮");
check("drill-down: partial + unclassified counts carried",
  detailWithNw.partial === true && detailWithNw.unclassifiedCount === 1);
check("drill-down: same-day net worth attached when the series has that date",
  detailWithNw.hasNetWorth === true && detailWithNw.netWorth === 12345);
check("drill-down: no net-worth point that day -> explicit no-record state",
  H.buildSpendDayDetail(calDays[0], null).hasNetWorth === false && H.buildSpendDayDetail(calDays[0], null).netWorth === null);
check("drill-down: missing day -> hasData false, nothing fabricated",
  H.buildSpendDayDetail(null, null).hasData === false && H.buildSpendDayDetail(null, 500).posted === null
  && H.buildSpendDayDetail(null, 500).hasNetWorth === true);

// --- structure: two tabs restored, single homes, fold defaults ---
function componentSlice(name) {
  const start = appSrc.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`component not found: ${name}`);
  const end = appSrc.indexOf("\n}\n", start) + 3;
  return appSrc.slice(start, end);
}
check("tabs: tablist with two labelled tabs exists",
  appSrc.includes('role="tablist"') && appSrc.includes('role="tab"') && appSrc.includes(">总览</button>") && appSrc.includes(">明细</button>"));
check("tabs: tab state is mount-time state in DashboardView, default overview",
  appSrc.includes('useState<"overview" | "detail">("overview")')
  && componentSlice("DashboardView").includes('useState<"overview" | "detail">("overview")'));
check("tabs: OverviewTab and DetailTab components exist and render once each",
  appSrc.includes("function OverviewTab") && appSrc.includes("function DetailTab")
  && (appSrc.split("<OverviewTab").length - 1) === 1 && (appSrc.split("<DetailTab").length - 1) === 1);
check("tabs: theme carries the .view-tabs styles", css.includes(".view-tabs") && css.includes(".view-tab.active"));
check("no weekly wording in client or server sources",
  !appSrc.includes("每周") && !appSrc.includes("本周") && !css.includes("每周") && !serverSrc.includes("每周") && !serverSrc.includes("本周"));
check("refresh already-running message carries no weekly naming",
  serverSrc.includes('message: "更新正在进行中"') && !serverSrc.includes("每周更新"));
check("no fold/view/tab state is persisted (ruling: reset on every open)",
  !appSrc.includes("localStorage") && !appSrc.includes("sessionStorage"));
check("no <details> renders open by default", !/<details[^>]*\sopen[\s=>]/.test(appSrc));
check("all folds default-closed: 4 evidence + 5 ledger = 9 folds (the daily LIST fold is gone)",
  (appSrc.match(/<details className="evidence-fold/g) ?? []).length === 9);
check("the rejected per-day LIST is gone (no list fold, no DailySpendSection)",
  !appSrc.includes("本月逐日明细") && !appSrc.includes("daily-days-fold") && !appSrc.includes("function DailySpendSection"));
check("fold controls carry text hints （展开/收起）, not colour or icon alone",
  appSrc.includes("fold-hint--open") && css.includes(".evidence-fold[open ] .fold-hint--close"));
check("shared state stays in the parent: cash trial + trend range declared exactly once, in DashboardView",
  (appSrc.split("useState<ReadonlySet<string>>(new Set())").length - 1) === 1
  && componentSlice("DashboardView").includes("useState<ReadonlySet<string>>(new Set())")
  && componentSlice("DashboardView").includes('useState<Range>("12m")'));

const overview = componentSlice("OverviewTab");
check("overview order: conclusion -> 7 metrics -> anomaly strip -> FIRE line -> daily series -> spend strip",
  overview.indexOf("<TotalAssetsConclusionCard") > -1
  && overview.indexOf("<TotalAssetsConclusionCard") < overview.indexOf('aria-label="本月关键指标"')
  && overview.indexOf('aria-label="本月关键指标"') < overview.indexOf('aria-label="数据异常月份"')
  && overview.indexOf('aria-label="数据异常月份"') < overview.indexOf("fire-teaser")
  && overview.indexOf("fire-teaser") < overview.indexOf("<NetWorthDailySeries")
  && overview.indexOf("<NetWorthDailySeries") < overview.indexOf("<DailySpendSummaryStrip"));
check("overview: 7 key metrics kept", overview.includes('aria-label="本月关键指标"'));
check("overview: anomaly strip stays visible, never folded (R6)", overview.includes('aria-label="数据异常月份"'));
check("overview: FIRE is one summary line + anchor button", overview.includes("fireSummaryLine(data.fire)") && overview.includes("查看完整 FIRE 面板"));
check("overview: daily series keeps its near-7-day change row",
  componentSlice("NetWorthDailySeries").includes("recentDailyNetWorthChange(series)")
  && componentSlice("NetWorthDailySeries").includes("按日净值序列汇总"));
const strip = componentSlice("DailySpendSummaryStrip");
check("overview spend strip: only the near-7-day row from the daily rows + the calendar jump",
  strip.includes("recentDailySpendSummary(daily.days)") && strip.includes("按日花销汇总")
  && strip.includes("查看日历明细") && strip.includes("onViewCalendar"));
check("overview spend strip: the current-month total moved to the Calendar (not duplicated here)",
  !strip.includes("本月已发生合计"));

const detailTab = componentSlice("DetailTab");
check("detail order: Calendar -> 4 evidence folds -> ledger folds",
  detailTab.indexOf("<SpendCalendar") > -1
  && detailTab.indexOf("<SpendCalendar") < detailTab.indexOf("cashScopeSummaryLine(")
  && detailTab.indexOf("cashScopeSummaryLine(") < detailTab.indexOf("<TrendCharts"));
check("detail: four evidence fold summaries wired to their helpers",
  detailTab.includes("cashScopeSummaryLine(") && detailTab.includes("distributionSummaryLine(")
  && detailTab.includes("investmentSummaryLine(") && detailTab.includes("holdingsSummaryLine("));
check("detail: monthly trend charts live in the 走势 ledger fold", detailTab.includes("<TrendCharts") && detailTab.includes("走势 — 月度趋势"));
check("detail: monthly records live in the 月度记录 ledger fold", detailTab.includes("<MonthlyRecords months={data.months} />") && detailTab.includes("月度记录 —"));
check("detail: full FIRE panel lives in its ledger fold with the anchor id", detailTab.includes("<FireProgress") && detailTab.includes('id="fire-panel"'));
check("detail: F-ARCH account rows live in their ledger fold", detailTab.includes("<ArchAccountsDetail") && detailTab.includes("总资产账户明细 —"));
check("detail: snapshot account detail lives in the 账户明细 ledger fold", detailTab.includes("accounts-section") && detailTab.includes('title="账户明细"'));
const view = componentSlice("DashboardView");
check("FIRE cross-tab wiring: overview button switches tab, opens fire-panel and scrolls",
  view.includes("openFirePanel") && view.includes('setActiveTab("detail")')
  && appSrc.includes('document.getElementById("fire-panel")') && appSrc.includes("panel.open = true") && appSrc.includes("scrollIntoView"));
check("calendar cross-tab wiring: strip button switches tab and scrolls to the calendar",
  view.includes("viewCalendar") && view.includes('document.getElementById("spend-calendar")'));

// --- Calendar component source wiring ---
const calSrc = componentSlice("SpendCalendar");
check("calendar: renders from the production helpers",
  calSrc.includes("buildSpendCalendarMonth(daily.days, monthKey, todayKey)")
  && calSrc.includes("spendCalendarMonthSummary(daily.days, monthKey, daily.throughDate)")
  && calSrc.includes("buildSpendDayDetail("));
check("calendar: default month is the throughDate month",
  calSrc.includes("daily.throughDate.slice(0, 7)"));
check("calendar: month title + prev/next + back-to-current-month controls",
  calSrc.includes("年 {model.month} 月") && calSrc.includes('aria-label="前月"')
  && calSrc.includes('aria-label="后月"') && calSrc.includes('aria-label="回到本月"') && calSrc.includes("回到本月"));
check("calendar: navigation bounds disable at coverage start / current month",
  calSrc.includes("spendCalendarMonthBounds(daily.coverageStart, todayKey)")
  && calSrc.includes("monthKey > bounds.minMonth") && calSrc.includes("monthKey < bounds.maxMonth")
  && calSrc.includes("disabled={!canPrev}") && calSrc.includes("disabled={!canNext}"));
check("calendar: weekday header is one Mon-Sun row of 7",
  calSrc.includes('["一", "二", "三", "四", "五", "六", "日"]') && css.includes(".spend-cal__weekdays") && css.includes("repeat(7"));
check("calendar: grid cells render the amount as text (compact) and missing days as a dash",
  calSrc.includes("compactCurrency.format(cell.amount ?? 0)") && calSrc.includes(': "—"'));
check("calendar: future days render no amount (blank, weakened)",
  calSrc.includes('cell.isFuture ? ""') && css.includes(".spend-cal__cell--future"));
check("calendar: today / selected / partial ride on text + border, not colour alone",
  calSrc.includes("今天") && calSrc.includes("已选") && calSrc.includes("◑ 部分")
  && css.includes(".spend-cal__cell--today") && css.includes(".spend-cal__cell--selected"));
check("calendar: tapping a day toggles the drill-down (same day closes)",
  calSrc.includes('previous === cell.date ? null : cell.date') && calSrc.includes("aria-pressed={isSelected}"));
check("calendar: monthly summary row carries the moved current-month total + average + max day",
  calSrc.includes("本月已发生合计") && calSrc.includes("日均") && calSrc.includes("最高单日") && calSrc.includes("截至"));
check("calendar: partial-coverage period is labelled next to the month",
  calSrc.includes("部分覆盖期间 · 全覆盖自"));
check("calendar: drill-down states the day's net worth or its honest absence",
  calSrc.includes("当日净值") && calSrc.includes("当日净值暂无记录") && calSrc.includes("archNetWorthSeries.find"));
check("calendar: theme carries the calendar styles", css.includes(".spend-cal__grid") && css.includes(".spend-cal__cell") && css.includes(".spend-cal__detail"));

for (const [name, marker] of [
  ["trend charts", "<TrendCharts"], ["full FIRE panel", "<FireProgress"],
  ["monthly records", "<MonthlyRecords"], ["cash scope panel", "<AvailableCashPanel"],
  ["distribution panel", "<DistributionPanel"], ["investment card", "<InvestmentPerformanceCard"],
  ["holdings section", "<HoldingsSection"], ["conclusion card", "<TotalAssetsConclusionCard"],
  ["net-worth daily series", "<NetWorthDailySeries"], ["daily spend calendar", "<SpendCalendar"],
  ["daily spend summary strip", "<DailySpendSummaryStrip"],
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
// place with its own caliber. ---
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

// --- feature reachability under the two-tab organisation ---
for (const marker of [
  "立即更新财务数据", "检查进度", "来源台账", "刷新观测",
  "搜索全部持仓", "查看全部持仓", "期间核对明细", "本页试算",
  "月度记录", "账户明细", "总资产账户明细", "走势", "FIRE 进度", "持仓 Top 10",
  "净值日序列", "日花销", "日花销日历", "查看日历明细", "回到本月", "本月已发生合计",
]) {
  check(`reachable: ${marker}`, appSrc.includes(marker));
}

// --- screen estimate (documented height model, 390x844,
// TWO-TAB model): the page no longer stacks everything in one
// scroll. Overview default = status band + tab bar + conclusion
// + metrics + anomaly + FIRE line + daily series + spend strip
// (target <= 3 screens). Detail default = status band + tab
// bar + the Calendar + the 9 closed fold summaries. ---
const VIEWPORT_PX = 844;
const OVERVIEW_BLOCKS = [
  ["状态行（工具行 + 刷新状态带）", 360],
  ["页签条", 52],
  ["总资产结论卡（三卡合一）", 400],
  ["本月关键指标 7 格（2 列 4 行）", 508],
  ["数据异常条（假设存在）", 64],
  ["FIRE 一行摘要", 66],
  ["净值日序列图", 320],
  ["日花销摘要条（近 7 天行 + 覆盖 meta + 日历按钮）", 150],
];
const overviewPx = OVERVIEW_BLOCKS.reduce((sum, [, px]) => sum + px, 0);
const overviewScreens = overviewPx / VIEWPORT_PX;
check(`overview tab default height ≈ ${overviewScreens.toFixed(2)} screens <= 3 (R2)`, overviewScreens <= 3);
const DETAIL_BLOCKS = [
  ["状态行（工具行 + 刷新状态带）", 360],
  ["页签条", 52],
  ["日花销 Calendar（导航 + 汇总行 + 星期行 + 5 行格子 + 口径注）", 560],
  ["依据层 4 个折叠 summary", 246],
  ["台账层 5 个折叠 summary（走势/月度记录/FIRE/总资产账户/账户明细）", 305],
];
const detailPx = DETAIL_BLOCKS.reduce((sum, [, px]) => sum + px, 0);
const detailScreens = detailPx / VIEWPORT_PX;
check(`detail tab default height ≈ ${detailScreens.toFixed(2)} screens <= 3`, detailScreens <= 3);
check("height model is a two-tab model (tab bar + Calendar named)",
  OVERVIEW_BLOCKS.some(([label]) => label.includes("页签")) && DETAIL_BLOCKS.some(([label]) => label.includes("Calendar")));
console.log(`screen model (two-tab): overview ~${overviewScreens.toFixed(1)} screens (${overviewPx}px), detail ~${detailScreens.toFixed(1)} screens (${detailPx}px) of ${VIEWPORT_PX}px viewport`);

console.log(`validate-design-b1a: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
