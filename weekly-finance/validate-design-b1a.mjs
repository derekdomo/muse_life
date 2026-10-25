// LIFE-DESIGN-001-B1A validation, updated for the
// DAILY-MERGE-001 CORRECTION (owner correction 2026-10-24
// 21:16 PT): the "merge" is a DATA-CALIBER merge only — the
// page organisation returns to ruling 1: tabs, 「总览」
// (overview, default) and 「明细」 (detail), tab state kept in
// mount-time component state only. Daily spend in the detail
// tab is a TRUE Calendar month grid (weekday header, aligned
// date cells, text amounts) built by the exported pure helpers
// buildSpendCalendarMonth / spendCalendarMonthSummary /
// buildSpendDayDetail — the old per-day LIST fold is gone.
// Assertions that protect facts (conclusion-card wording,
// F-ARCH caliber labels, summary-line helpers, fold
// defaults, no persistence, no weekly wording in client or
// server sources, near-7-day aggregates summed only from the
// daily rows) are kept; the previous single-view assertions
// (no tablist etc.) were products of the misreading and are
// replaced by tab + Calendar assertions.
//
// OVERVIEW-TRIM-001 + NW-TREND-SEAM-001 (owner feedback
// 2026-10-25 00:10 PT): the overview keeps only numbers,
// short labels, status symbols and ONE conclusion sentence —
// the card's caliber / freshness-layer / source paragraphs
// moved, wording preserved, into the detail tab's
// 「口径与来源说明」 fold (ConclusionCaliberDetail), and the
// metric explanatory notes moved with them; the overview
// text-budget / whitelist assertions live below. The overview
// net-worth chart's history segment is filled with the SAME
// months rows the detail tab renders (one point per monthly
// snapshot, at its snapshot date, its total — no second
// computation, no interpolation), joined at the seam (the
// first daily point) to the arch daily points; the seam is
// annotated in text and the segments differ by line style +
// markers, never colour alone (buildNetWorthTrend /
// filterNetWorthTrend behaviour asserted below).
// FIRE-TAB-001 (owner ruling 2026-10-25 00:16 PT): three
// tabs — 总览 / FIRE / 明细 — the full FIRE panel expanded
// as the FIRE tab's main content; the overview one-liner's
// button just switches tab.
// CAL-METRICS-001 (owner ruling 2026-10-25 00:17 PT): the
// Calendar gains the 入账 and 投资收益·损失 metrics next to
// 花销 (buildInvestMonthView behaviour asserted below:
// pre-era months are monthly-only and never split into
// days; gains/losses carry glyph + sign + digits).
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
// The income source label table, sliced verbatim for its helper.
const incomeLabelsStart = appSrc.indexOf("export const incomeSourceLabels");
const incomeLabelsEnd = appSrc.indexOf("export function incomeSourceLabel");
if (incomeLabelsStart < 0 || incomeLabelsEnd < 0) throw new Error("income labels not found");
const incomeLabels = appSrc.slice(incomeLabelsStart, incomeLabelsEnd)
  .replace("export const", "const")
  .replace(": Record<string, string>", "");
function loadHelpers() {
  const parts = [
    formatters,
    categoryLabels,
    incomeLabels,
    extractFn(appSrc, "dailyCategoryLabel"),
    extractFn(appSrc, "incomeSourceLabel"),
    extractFn(appSrc, "trendIndicator"),
    extractFn(appSrc, "signedCurrency"),
    extractFn(appSrc, "weeklyDeltaView", [["delta: number | null", "delta"], ["netWorth: number", "netWorth"], [": WeeklyDeltaView", ""]]),
    extractFn(appSrc, "conclusionOneLiner", [["view: WeeklyDeltaView", "view"], ["hasArch: boolean", "hasArch"]]),
    extractFn(appSrc, "signedCompactCurrency"),
    extractFn(appSrc, "signedPreciseCurrency"),
    extractFn(appSrc, "buildNetWorthTrend", [["months: NetWorthTrendMonthLike[]", "months"], ["daily: DailyNetWorthPointLike[]", "daily"], [": NetWorthTrendModel", ""], ["dailyPoints: NetWorthTrendPoint[]", "dailyPoints"], ["monthlyPoints: NetWorthTrendPoint[]", "monthlyPoints"], ["points: NetWorthTrendPoint[]", "points"]]),
    extractFn(appSrc, "netWorthTrendRangeStart", [["range: Range", "range"]]),
    extractFn(appSrc, "filterNetWorthTrend", [["model: NetWorthTrendModel", "model"], ["range: Range", "range"], [": NetWorthTrendView", ""]]),
    extractFn(appSrc, "buildInvestMonthView", [["investDays: InvestDayLike[]", "investDays"], ["monthlyReturns: MonthlyReturnLike[]", "monthlyReturns"], [": InvestMonthView", ""], ["cells: InvestMonthCell[]", "cells"], ["chain: InvestInterval[]", "chain"]]),
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
  return new Function(`${parts.join("\n")}; return { fireYearsEstimate, fireSummaryLine, distributionSummaryLine, cashScopeSummaryLine, investmentSummaryLine, holdingsSummaryLine, recentDailySpendSummary, recentDailyNetWorthChange, buildSpendCalendarMonth, spendCalendarMonthSummary, spendCalendarMonthBounds, shiftSpendCalendarMonth, buildSpendDayDetail, weeklyDeltaView, conclusionOneLiner, incomeSourceLabel, signedCompactCurrency, signedPreciseCurrency, buildNetWorthTrend, netWorthTrendRangeStart, filterNetWorthTrend, buildInvestMonthView };`)();
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
  H.fireSummaryLine(fireOk) === "FIRE 进度 25% · 缺口 $750,000 · 预计还需 10 年（线性估算，不含投资回报）");
check("fire line: reached target", H.fireSummaryLine({ ...fireOk, progress: 1, gap: 0 }).includes("已达到目标"));
check("fire line: no pace stated honestly", H.fireSummaryLine({ ...fireOk, annualContribution: 0 }).includes("不足以估算达标时间"));
check("fire line: insufficient months gated", H.fireSummaryLine({ ...fireOk, completeMonthsUsed: 0 }) === "FIRE 进度：完整月份不足，暂不估算");
check("fire line: years estimate carries the linear-estimate label",
  H.fireSummaryLine(fireOk).includes("线性估算，不含投资回报"));
check("fire line: no label when target reached (no years estimate)",
  !H.fireSummaryLine({ ...fireOk, progress: 1, gap: 0 }).includes("线性估算，不含投资回报"));
check("fire line: no label when months are insufficient (no years estimate)",
  !H.fireSummaryLine({ ...fireOk, completeMonthsUsed: 0 }).includes("线性估算，不含投资回报"));
check("fire line: no label when pace cannot estimate (no years estimate)",
  !H.fireSummaryLine({ ...fireOk, annualContribution: 0 }).includes("线性估算，不含投资回报"));
check("fire panel: years note carries the linear-estimate label",
  appSrc.includes("线性估算，不含投资回报；按近"));

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

// --- OVERVIEW-TRIM-001: the one-line conclusion ---
const viewUp = H.weeklyDeltaView(5000, 105000);
check("one-liner: comparable + arch -> 结论 sentence with caliber label, glyph, direction, signed amount",
  H.conclusionOneLiner(5000, viewUp, true).startsWith("结论：旧同步口径 · 较上次成功快照（日期未留存）增加 ▲ +$5,000"));
check("one-liner: percent rides in the same sentence", H.conclusionOneLiner(5000, viewUp, true).includes("（+5%）"));
check("one-liner: no arch -> no old-caliber label", !H.conclusionOneLiner(5000, viewUp, false).includes("旧同步口径"));
const viewDown = H.weeklyDeltaView(-2500, 100000);
check("one-liner: decrease carries ▼ + direction word", H.conclusionOneLiner(-2500, viewDown, true).includes("减少 ▼ -$2,500"));
check("one-liner: flat delta reads 持平", H.conclusionOneLiner(0, H.weeklyDeltaView(0, 100000), true).includes("持平"));
check("one-liner: no comparable snapshot -> honest 暂无可比快照, never a fabricated 0 change",
  H.conclusionOneLiner(null, H.weeklyDeltaView(null, 100000), true) === "暂无可比快照");

// --- NW-TREND-SEAM-001: monthly history from the SAME months
// rows + arch daily points, seam at the first daily date ---
const trendMonths = [
  { key: "2024-10-31", total: 900000 },
  { key: "2024-11-30", total: 950000 },
  { key: "2025-01-31", total: 990000 },
  { key: "2026-09-30", total: 1200000 },
  { key: "2026-10-15", total: 1250000 },
  { key: "2026-10-26", total: 1300000 },
];
const trendDaily = [
  { date: "2026-10-25", total: 1285000 },
  { date: "2026-10-24", total: 1280000 },
];
const trend = H.buildNetWorthTrend(trendMonths, trendDaily);
check("trend: seam is the first daily point's date", trend.seamDate === "2026-10-24");
check("trend: monthly points are exactly the pre-seam snapshots, one per month, at their snapshot dates",
  JSON.stringify(trend.monthlyPoints.map((p) => p.date)) === JSON.stringify(["2024-10-31", "2024-11-30", "2025-01-31", "2026-09-30", "2026-10-15"]));
check("trend: monthly point values EQUAL the months rows' totals (same source as 月度记录, never recomputed)",
  trend.monthlyPoints.every((p) => trendMonths.find((m) => m.key === p.date)?.total === p.total));
check("trend: a snapshot dated on/after the seam is excluded from the monthly segment (daily owns that range)",
  !trend.monthlyPoints.some((p) => p.date === "2026-10-26"));
check("trend: total points = monthly count + daily count exactly (no interpolation, no split, no smoothing points)",
  trend.points.length === trend.monthlyPoints.length + trend.dailyPoints.length && trend.points.length === 7);
check("trend: daily points are sorted ascending even when the input is not",
  trend.dailyPoints[0]?.date === "2026-10-24" && trend.dailyPoints[1]?.date === "2026-10-25");
check("trend: no daily points -> no seam, every month stays a monthly point",
  H.buildNetWorthTrend(trendMonths, []).seamDate === null && H.buildNetWorthTrend(trendMonths, []).monthlyPoints.length === 6);
check("mutation: an interpolating builder would invent points between months — the real one has none between 2024-11-30 and 2025-01-31",
  !trend.points.some((p) => p.date > "2024-11-30" && p.date < "2025-01-31"));
check("trend range start: all -> null, year -> Jan 1, 6m/12m counted back from the last point",
  H.netWorthTrendRangeStart("all", "2026-10-25") === null
  && H.netWorthTrendRangeStart("year", "2026-10-25") === "2026-01-01"
  && H.netWorthTrendRangeStart("6m", "2026-10-25") === "2026-04-25"
  && H.netWorthTrendRangeStart("12m", "2026-10-25") === "2025-10-25");
const trendAll = H.filterNetWorthTrend(trend, "all");
check("trend view (all): one row per real point date — 5 monthly + seam + 1 daily = 7 rows",
  trendAll.rows.length === 7 && trendAll.monthlyCount === 5 && trendAll.dailyCount === 2);
check("trend view (all): the seam row bridges both segments with the daily point's OWN value (no invented value)",
  trendAll.rows.find((r) => r.date === "2026-10-24")?.monthly === 1280000
  && trendAll.rows.find((r) => r.date === "2026-10-24")?.daily === 1280000);
check("trend view (all): monthly rows carry no daily value and daily rows carry no monthly value",
  trendAll.rows.find((r) => r.date === "2026-10-15")?.daily === null
  && trendAll.rows.find((r) => r.date === "2026-10-25")?.monthly === null);
check("trend view (all): seam is visible when both segments are in range", trendAll.seamVisible === true);
const trend6m = H.filterNetWorthTrend(trend, "6m");
check("trend view (6m): window trims old monthly points, seam stays visible",
  trend6m.monthlyCount === 2 && trend6m.dailyCount === 2 && trend6m.seamVisible === true);
const trendOldOnly = H.buildNetWorthTrend([{ key: "2024-10-31", total: 900000 }], trendDaily);
check("trend view (6m, history outside window): no monthly segment, no seam marker",
  H.filterNetWorthTrend(trendOldOnly, "6m").monthlyCount === 0 && H.filterNetWorthTrend(trendOldOnly, "6m").seamVisible === false);

// --- CAL-METRICS-001: income source labels ---
check("income label: refunds labelled 退款", H.incomeSourceLabel("REFUND") === "退款");
check("income label: unknown source keys pass through as-is (never relabelled)", H.incomeSourceLabel("EMPLOYER_ACME") === "EMPLOYER_ACME");

// --- CAL-METRICS-001: investment month view — daily only
// from the era, monthly never split into days ---
const investDays = [
  { date: "2026-10-24", pnl: 1200 },
  { date: "2026-10-25", pnl: -300 },
];
const monthlyReturns = [
  { key: "2025-02-28", investmentReturn: 900 },
  { key: "2025-03-31", investmentReturn: -4200 },
  { key: "2026-09-30", investmentReturn: 8100 },
  { key: "2026-10-31", investmentReturn: null, investmentReturnReason: "期间外部净投入未知" },
];
const marView = H.buildInvestMonthView(investDays, monthlyReturns, "2025-03", "2026-10-25", "2026-10-24");
check("invest: a pre-era month whose interval spans month-end -> month-end is monthly mode with the figure as its total",
  marView.mode === "monthly" && marView.total === -4200 && marView.dailyCount === 0 && marView.monthlyTotal === -4200);
check("invest: the proven full-month interval carries both ends (2025-02-28 -> 2025-03-31)",
  marView.monthlyInterval?.startKey === "2025-02-28" && marView.monthlyInterval?.endKey === "2025-03-31"
  && marView.monthlyInterval?.fullMonth === true && marView.intervals.length === 1);
check("invest: pre-era cells are monthly-only and carry NO amount (the monthly value is never split into days)",
  marView.cells.every((c) => c.mode !== "daily") && marView.cells.every((c) => c.pnl === null)
  && marView.cells.find((c) => c.date === "2025-03-15")?.mode === "monthly-only");
check("invest: weekday alignment matches the spend grid (Mar 1 2025 is a Saturday -> offset 5)",
  marView.cells[5]?.date === "2025-03-01");
const octView = H.buildInvestMonthView(investDays, monthlyReturns, "2026-10", "2026-10-25", "2026-10-24");
check("invest: the era month sums its real daily points (total / average / max day)",
  octView.mode === "daily" && octView.total === 900 && octView.dailyCount === 2 && octView.average === 450
  && octView.maxAmount === 1200 && octView.maxDate === "2026-10-24");
check("invest: daily cells carry their signed pnl", octView.cells.find((c) => c.date === "2026-10-25")?.pnl === -300
  && octView.cells.find((c) => c.date === "2026-10-24")?.mode === "daily");
check("invest: daily mode reports the recorded coverage (first / last recorded day)",
  octView.dailyFirstDate === "2026-10-24" && octView.dailyLastDate === "2026-10-25");
check("invest: a pre-era day inside the era month is NOT monthly-only when the month's figure is unproven (null)",
  octView.cells.find((c) => c.date === "2026-10-23")?.mode === "none");
check("invest: future days are future, never data", octView.cells.find((c) => c.date === "2026-10-26")?.mode === "future");
const sepView = H.buildInvestMonthView(investDays, monthlyReturns, "2026-09", "2026-10-25", "2026-10-24");
check("invest: an interval ending in Sep 2026 but starting Mar 2025 is NOT the September return (interval mode, no monthly total, no monthly-only cells)",
  sepView.mode === "interval" && sepView.monthlyTotal === null && sepView.total === 8100
  && sepView.intervals.length === 1 && sepView.intervals[0]?.startKey === "2025-03-31" && sepView.intervals[0]?.endKey === "2026-09-30"
  && sepView.intervals[0]?.fullMonth === false
  && sepView.cells.find((c) => c.date === "2026-09-15")?.mode === "none");
const junView = H.buildInvestMonthView(investDays, monthlyReturns, "2025-06", "2026-10-25", "2026-10-24");
check("invest: a month with neither daily points nor a figure is an honest none",
  junView.mode === "none" && junView.total === null && junView.cells.find((c) => c.date === "2025-06-10")?.mode === "none");
check("mutation: splitting the March monthly figure across its 31 days would fabricate daily values — every March cell pnl stays null",
  marView.cells.filter((c) => c.date != null).every((c) => c.pnl === null) && marView.dailyCount === 0);

// --- CAL-METRICS-001 fix: interval attribution acceptance matrix ---
// ① full month-end -> month-end intervals: true zero / negative /
// positive are all the named natural month's return.
const febZero = H.buildInvestMonthView([], [
  { key: "2025-01-31", investmentReturn: 100 },
  { key: "2025-02-28", investmentReturn: 0 },
], "2025-02", "2026-10-25", "2026-10-24");
check("invest attribution: a true 0 full-month return is monthly mode with total 0 (not missing)",
  febZero.mode === "monthly" && febZero.monthlyTotal === 0 && febZero.total === 0);
const aprPos = H.buildInvestMonthView([], [
  { key: "2025-03-31", investmentReturn: -50 },
  { key: "2025-04-30", investmentReturn: 2750 },
], "2025-04", "2026-10-25", "2026-10-24");
check("invest attribution: a positive full-month return is monthly mode",
  aprPos.mode === "monthly" && aprPos.monthlyTotal === 2750 && aprPos.monthlyInterval?.startKey === "2025-03-31");
// ② non-month-aligned intervals keep both ends and their amount —
// never renamed as a whole month, never averaged into days.
const mayFirst = H.buildInvestMonthView([], [
  { key: "2025-04-01", investmentReturn: 10 },
  { key: "2025-05-01", investmentReturn: 640 },
], "2025-05", "2026-10-25", "2026-10-24");
check("invest attribution: month-start -> next-month-start is an interval, not May's return",
  mayFirst.mode === "interval" && mayFirst.monthlyTotal === null && mayFirst.total === 640
  && mayFirst.intervals[0]?.startKey === "2025-04-01" && mayFirst.intervals[0]?.endKey === "2025-05-01");
const mayMid = H.buildInvestMonthView([], [
  { key: "2025-04-15", investmentReturn: 10 },
  { key: "2025-05-15", investmentReturn: -125 },
], "2025-05", "2026-10-25", "2026-10-24");
check("invest attribution: mid-month -> mid-month keeps both ends and the signed amount",
  mayMid.mode === "interval" && mayMid.intervals[0]?.startKey === "2025-04-15" && mayMid.intervals[0]?.endKey === "2025-05-15"
  && mayMid.intervals[0]?.amount === -125 && mayMid.monthlyTotal === null);
const crossMonths = H.buildInvestMonthView([], [
  { key: "2025-01-31", investmentReturn: 10 },
  { key: "2025-04-30", investmentReturn: 4321 },
], "2025-04", "2026-10-25", "2026-10-24");
check("invest attribution: a multi-month span ending at a month end is still not that month's return",
  crossMonths.mode === "interval" && crossMonths.monthlyTotal === null
  && crossMonths.intervals[0]?.startKey === "2025-01-31" && crossMonths.intervals[0]?.endKey === "2025-04-30");
// ② pending candidates keep their server reason + both ends.
const firstEver = H.buildInvestMonthView([], [
  { key: "2025-03-31", investmentReturn: null, investmentReturnReason: "首期快照是期间起点，只作期初余额，不产生收益" },
], "2025-03", "2026-10-25", "2026-10-24");
check("invest attribution: the first-ever snapshot is pending with a null start and its reason preserved",
  firstEver.mode === "pending" && firstEver.monthlyTotal === null && firstEver.intervals.length === 1
  && firstEver.intervals[0]?.startKey === null && firstEver.intervals[0]?.endKey === "2025-03-31"
  && firstEver.intervals[0]?.reason === "首期快照是期间起点，只作期初余额，不产生收益");
const missingFlow = H.buildInvestMonthView([], [
  { key: "2025-02-28", investmentReturn: 10 },
  { key: "2025-03-31", investmentReturn: null, investmentReturnReason: "期间外部净投入未知" },
], "2025-03", "2026-10-25", "2026-10-24");
check("invest attribution: a full-month-shaped interval with unknown flow stays pending (shape alone proves nothing without a value)",
  missingFlow.mode === "pending" && missingFlow.monthlyTotal === null
  && missingFlow.intervals[0]?.fullMonth === true && missingFlow.intervals[0]?.reason === "期间外部净投入未知"
  && missingFlow.cells.find((c) => c.date === "2025-03-15")?.mode === "none");
// ③ several snapshots inside one month, shuffled input, duplicate
// and conflicting end keys: nothing is picked first, nothing doubles.
const multiSnap = H.buildInvestMonthView([], [
  { key: "2025-03-31", investmentReturn: 700 },
  { key: "2025-02-28", investmentReturn: 100 },
  { key: "2025-03-15", investmentReturn: 300 },
], "2025-03", "2026-10-25", "2026-10-24");
check("invest attribution: shuffled input + two snapshots in March -> two intervals, no monthly total, no first-pick",
  multiSnap.mode === "interval" && multiSnap.monthlyTotal === null && multiSnap.total === null && multiSnap.intervals.length === 2
  && multiSnap.intervals[0]?.startKey === "2025-02-28" && multiSnap.intervals[0]?.endKey === "2025-03-15" && multiSnap.intervals[0]?.amount === 300
  && multiSnap.intervals[1]?.startKey === "2025-03-15" && multiSnap.intervals[1]?.endKey === "2025-03-31" && multiSnap.intervals[1]?.amount === 700);
const dupSame = H.buildInvestMonthView([], [
  { key: "2025-02-28", investmentReturn: 100 },
  { key: "2025-03-31", investmentReturn: 700 },
  { key: "2025-03-31", investmentReturn: 700 },
], "2025-03", "2026-10-25", "2026-10-24");
check("invest attribution: a same-value duplicate end key counts once and the month stays provable",
  dupSame.mode === "monthly" && dupSame.monthlyTotal === 700 && dupSame.intervals.length === 1 && dupSame.intervals[0]?.conflict === false);
const dupConflict = H.buildInvestMonthView([], [
  { key: "2025-02-28", investmentReturn: 100 },
  { key: "2025-03-31", investmentReturn: 700 },
  { key: "2025-03-31", investmentReturn: 701 },
], "2025-03", "2026-10-25", "2026-10-24");
check("invest attribution: a conflicting duplicate end key takes NEITHER value and is flagged conflict / pending",
  dupConflict.mode === "pending" && dupConflict.monthlyTotal === null && dupConflict.intervals.length === 1
  && dupConflict.intervals[0]?.conflict === true && dupConflict.intervals[0]?.amount === null);
// "YYYY-MM" keys normalise to the month's last day before comparing.
const ymKeys = H.buildInvestMonthView([], [
  { key: "2025-02", investmentReturn: 100 },
  { key: "2025-03", investmentReturn: 260 },
], "2025-03", "2026-10-25", "2026-10-24");
check("invest attribution: YYYY-MM keys normalise to month ends, so the full month is still provable",
  ymKeys.mode === "monthly" && ymKeys.monthlyTotal === 260
  && ymKeys.monthlyInterval?.startKey === "2025-02-28" && ymKeys.monthlyInterval?.endKey === "2025-03-31");
// ④ era boundaries: a single recorded daily, a gap day, an explicit
// 0 / negative daily; monthly and daily never stack.
const eraCross = H.buildInvestMonthView(
  [{ date: "2026-10-24", pnl: 0 }, { date: "2026-10-26", pnl: -88 }],
  [
    { key: "2026-09-30", investmentReturn: 100 },
    { key: "2026-10-31", investmentReturn: 5000 },
  ],
  "2026-10", "2026-10-26", "2026-10-24");
check("invest attribution: era month with daily points stays daily; the proven monthly figure is reported but NEVER added to the daily subtotal",
  eraCross.mode === "daily" && eraCross.total === -88 && eraCross.monthlyTotal === 5000 && eraCross.dailyCount === 2
  && eraCross.dailyFirstDate === "2026-10-24" && eraCross.dailyLastDate === "2026-10-26");
check("invest attribution: an explicit 0 daily is a daily cell; a missing day between recorded days is none, not a fabricated value",
  eraCross.cells.find((c) => c.date === "2026-10-24")?.mode === "daily" && eraCross.cells.find((c) => c.date === "2026-10-24")?.pnl === 0
  && eraCross.cells.find((c) => c.date === "2026-10-25")?.mode === "none");
check("invest attribution: pre-era days of an era month with a PROVEN full-month figure are monthly-only (no amount on the cell)",
  eraCross.cells.find((c) => c.date === "2026-10-10")?.mode === "monthly-only" && eraCross.cells.find((c) => c.date === "2026-10-10")?.pnl === null);
const singleDaily = H.buildInvestMonthView(
  [{ date: "2026-10-24", pnl: 42 }], [], "2026-10", "2026-10-25", "2026-10-24");
check("invest attribution: a single recorded daily -> daily mode with first == last recorded day and no intervals",
  singleDaily.mode === "daily" && singleDaily.total === 42 && singleDaily.average === 42
  && singleDaily.dailyFirstDate === "2026-10-24" && singleDaily.dailyLastDate === "2026-10-24" && singleDaily.intervals.length === 0);
const emptyInvest = H.buildInvestMonthView([], [], "2025-06", "2026-10-25", "2026-10-24");
check("invest attribution: empty daily + empty monthly data is an honest none with no intervals",
  emptyInvest.mode === "none" && emptyInvest.total === null && emptyInvest.intervals.length === 0 && emptyInvest.monthlyInterval === null);

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

// --- structure: three tabs, single homes, fold defaults ---
function componentSlice(name) {
  const start = appSrc.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`component not found: ${name}`);
  const end = appSrc.indexOf("\n}\n", start) + 3;
  return appSrc.slice(start, end);
}
check("tabs: tablist with three labelled tabs exists",
  appSrc.includes('role="tablist"') && appSrc.includes('role="tab"') && appSrc.includes(">总览</button>") && appSrc.includes(">FIRE</button>") && appSrc.includes(">明细</button>"));
check("tabs: order is 总览 / FIRE / 明细 (FIRE-TAB-001)",
  appSrc.indexOf(">总览</button>") > -1
  && appSrc.indexOf(">总览</button>") < appSrc.indexOf(">FIRE</button>")
  && appSrc.indexOf(">FIRE</button>") < appSrc.indexOf(">明细</button>"));
check("tabs: tab state is mount-time state in DashboardView, default overview",
  appSrc.includes('useState<"overview" | "fire" | "detail" | "trading">("overview")')
  && componentSlice("DashboardView").includes('useState<"overview" | "fire" | "detail" | "trading">("overview")'));
check("tabs: OverviewTab, FireTab and DetailTab components exist and render once each",
  appSrc.includes("function OverviewTab") && appSrc.includes("function FireTab") && appSrc.includes("function DetailTab")
  && (appSrc.split("<OverviewTab").length - 1) === 1 && (appSrc.split("<FireTab").length - 1) === 1 && (appSrc.split("<DetailTab").length - 1) === 1);
check("tabs: theme carries the .view-tabs styles", css.includes(".view-tabs") && css.includes(".view-tab.active"));
check("no weekly wording in client or server sources",
  !appSrc.includes("每周") && !appSrc.includes("本周") && !css.includes("每周") && !serverSrc.includes("每周") && !serverSrc.includes("本周"));
check("refresh already-running message carries no weekly naming",
  serverSrc.includes('message: "更新正在进行中"') && !serverSrc.includes("每周更新"));
check("no fold/view/tab state is persisted (ruling: reset on every open)",
  !appSrc.includes("localStorage") && !appSrc.includes("sessionStorage"));
check("no <details> renders open by default", !/<details[^>]*\sopen[\s=>]/.test(appSrc));
check("all folds default-closed: 4 evidence + 1 synthetic demo (ARCH-DEMO-001) + 5 ledger = 10 folds in the detail tab (LIST fold gone; FIRE fold moved to its tab; caliber fold added)",
  (appSrc.match(/<details className="evidence-fold/g) ?? []).length === 10);
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
check("detail order: Calendar -> demo fold -> 4 evidence folds -> ledger folds",
  detailTab.indexOf("<SpendCalendar") > -1
  && detailTab.indexOf("<SpendCalendar") < detailTab.indexOf("<ArchDemoPreviewSection")
  && detailTab.indexOf("<ArchDemoPreviewSection") < detailTab.indexOf("cashScopeSummaryLine(")
  && detailTab.indexOf("cashScopeSummaryLine(") < detailTab.indexOf("<TrendCharts"));
// ARCH-DEMO-001 (F-ARCH-001 synthetic spend preview): the demo
// fold is a member of the fold system with its own stable
// marker. Detection anchors on the fold's own data marker and
// the pure model — never on the Calendar component — so the
// demo stays decoupled from SpendCalendar.
const demoFoldStart = appSrc.indexOf('data-arch-demo="spend-preview"');
check("demo fold (ARCH-DEMO-001): exists in the detail tab, anchored on its own data marker",
  demoFoldStart > -1 && detailTab.includes("<ArchDemoPreviewSection")
  && (appSrc.match(/data-arch-demo="spend-preview"/g) ?? []).length === 1);
check("demo fold (ARCH-DEMO-001): exact title + synthetic badge in its summary",
  appSrc.includes("合成预览 · 花销演示（F-ARCH-001）") && appSrc.includes("合成数据 · 非生产")
  && appSrc.indexOf("合成预览 · 花销演示（F-ARCH-001）") > demoFoldStart);
check("demo fold (ARCH-DEMO-001): default-closed (its own <details> tag carries no open attribute)",
  demoFoldStart > -1 && !/\sopen[\s=>]/.test(appSrc.slice(appSrc.lastIndexOf("<details", demoFoldStart), demoFoldStart)));
check("demo fold (ARCH-DEMO-001): renders only the pure synthetic model, decoupled from the Calendar",
  componentSlice("ArchDemoPreviewSection").includes("buildArchDemoPreview(scenario, asOfDate)")
  && !componentSlice("ArchDemoPreviewSection").includes("SpendCalendar")
  && !componentSlice("ArchDemoPreviewSection").includes("data.arch"));
check("detail: four evidence fold summaries wired to their helpers",
  detailTab.includes("cashScopeSummaryLine(") && detailTab.includes("distributionSummaryLine(")
  && detailTab.includes("investmentSummaryLine(") && detailTab.includes("holdingsSummaryLine("));
check("detail: monthly trend charts live in the 走势 ledger fold", detailTab.includes("<TrendCharts") && detailTab.includes("走势 — 月度趋势"));
check("detail: monthly records live in the 月度记录 ledger fold", detailTab.includes("<MonthlyRecords months={data.months} />") && detailTab.includes("月度记录 —"));
check("detail: NO FIRE fold remains in the detail tab (FIRE-TAB-001)", !detailTab.includes("fire-panel") && !detailTab.includes("<FireProgress"));
check("detail: caliber fold carries the moved conclusion-card paragraphs", detailTab.includes("口径与来源说明") && detailTab.includes("<ConclusionCaliberDetail"));
const fireTab = componentSlice("FireTab");
check("FIRE tab: the full panel is the tab's main content, expanded (no fold), id kept on the panel root",
  fireTab.includes("<FireProgress") && fireTab.includes('id="fire-panel"') && !fireTab.includes("<details") && fireTab.includes('title="FIRE 进度"'));
check("detail: F-ARCH account rows live in their ledger fold", detailTab.includes("<ArchAccountsDetail") && detailTab.includes("总资产账户明细 —"));
check("detail: snapshot account detail lives in the 账户明细 ledger fold", detailTab.includes("accounts-section") && detailTab.includes('title="账户明细"'));
const view = componentSlice("DashboardView");
check("FIRE cross-tab wiring: overview button simply switches to the FIRE tab (no fold-opening, no scroll)",
  view.includes("openFireTab") && view.includes('setActiveTab("fire")')
  && overview.includes("onOpenFireTab") && !appSrc.includes("panel.open = true"));
check("calendar cross-tab wiring: strip button switches tab and scrolls to the calendar",
  view.includes("viewCalendar") && view.includes('document.getElementById("spend-calendar")'));

// --- Calendar component source wiring ---
const calSrc = componentSlice("SpendCalendar");
check("calendar: renders from the production helpers",
  calSrc.includes("buildSpendCalendarMonth(flowDays, monthKey, todayKey)")
  && calSrc.includes("spendCalendarMonthSummary(flowDays, monthKey")
  && calSrc.includes("buildSpendDayDetail("));
check("calendar: default month is the throughDate month",
  calSrc.includes("daily.throughDate.slice(0, 7)"));
check("calendar: month title + prev/next + back-to-current-month controls",
  calSrc.includes("年 {viewMonth} 月") && calSrc.includes('aria-label="前月"')
  && calSrc.includes('aria-label="后月"') && calSrc.includes('aria-label="回到本月"') && calSrc.includes("回到本月"));
check("calendar: navigation bounds disable at coverage start / current month",
  calSrc.includes("spendCalendarMonthBounds(daily.coverageStart, todayKey)")
  && calSrc.includes("monthKey > bounds.minMonth") && calSrc.includes("monthKey < bounds.maxMonth")
  && calSrc.includes("disabled={!canPrev}") && calSrc.includes("disabled={!canNext}"));
check("calendar metrics: three-way switch with text labels + pressed state (CAL-METRICS-001)",
  calSrc.includes('aria-label="日历指标切换"') && calSrc.includes('useState<CalendarMetric>("spend")')
  && calSrc.includes('"花销"') && calSrc.includes('"入账"') && calSrc.includes('"投资收益·损失"')
  && calSrc.includes("aria-pressed={metric === key}") && calSrc.includes("switchMetric"));
check("calendar metrics: income reuses the flow grid via the day-shape adapter + its own drill-down",
  calSrc.includes("posted: day.total") && calSrc.includes("categories: day.sources") && calSrc.includes("入账详情") && calSrc.includes("incomeSourceLabel(src.key)"));
check("calendar metrics: invest renders from buildInvestMonthView with signed text amounts",
  calSrc.includes("buildInvestMonthView(investData?.days ?? [], data.months, monthKey, todayKey, INVEST_DAILY_ERA_START_CLIENT)")
  && calSrc.includes("signedCompactCurrency(cell.pnl ?? 0)") && calSrc.includes('"仅月度"'));
check("calendar metrics: invest summary separates recorded-daily subtotal / proven full month / interval / pending (CAL-METRICS-001 fix)",
  calSrc.includes("已记录日收益·损失小计") && calSrc.includes("日均（按已记录 {investView.dailyCount} 天）")
  && calSrc.includes("本月收益·损失") && calSrc.includes("完整自然月")
  && calSrc.includes("区间收益·损失") && calSrc.includes("非完整自然月")
  && calSrc.includes("该月收益待核对") && !calSrc.includes("本月收益·损失合计"));
check("calendar metrics: income summary carries its own total label", calSrc.includes("本月入账合计"));
check("calendar metrics: one-line caliber notes live in the detail tab, per metric",
  calSrc.includes("入账口径：外部流入（收入＋退款），排除账户间转移与贷款相关流")
  && calSrc.includes("投资收益·损失口径：当日投资价值变化 − 当日净投入") && calSrc.includes("不摊分到日"));
check("calendar metrics: invest drill-down shows the value-change / net-flow / pnl composition",
  calSrc.includes("当日价值变化") && calSrc.includes("当日净投入") && calSrc.includes("收益·损失 {signedPreciseCurrency(selectedInvestDay.pnl)}"));
check("calendar metrics: invest drill-down names a proven month with its interval ends, else lists each candidate interval (CAL-METRICS-001 fix)",
  calSrc.includes("本月收益·损失（月度）") && calSrc.includes("investIntervalRange(investView.monthlyInterval)")
  && calSrc.includes("investView.intervals.map") && calSrc.includes("区间收益待核对"));
check("calendar metrics: server gates exist for both new figures (chunked income + era-floored invest)",
  serverSrc.includes("ingestArchDailyIncome") && serverSrc.includes("ingestArchDailyInvest")
  && serverSrc.includes("arch_daily_income") && serverSrc.includes("arch_daily_invest") && serverSrc.includes("INVEST_DAILY_ERA_START"));
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

// --- OVERVIEW-TRIM-001: the conclusion card carries only
// numbers, short labels, status symbols and ONE conclusion
// sentence; every caliber paragraph moved, wording
// preserved, into the detail tab's ConclusionCaliberDetail. ---
const card = componentSlice("TotalAssetsConclusionCard");
const caliber = componentSlice("ConclusionCaliberDetail");
check("card: F-ARCH total is the headline when present", card.includes("arch ? arch.total : data.live.netWorth"));
check("card: the delta is exactly one conclusion sentence (conclusionOneLiner), no delta paragraph remains",
  card.includes("conclusionOneLiner(delta, view, arch != null)") && card.includes("本次未更新"));
check("card: archived snapshot compare line kept (numbers + 环比 only)", card.includes("月度快照 · {data.sourceMonth}（存档口径）") && card.includes("环比"));
check("card text budget: at most 5 paragraphs (eyebrow / conclusion / coverage / partial / stale)",
  (card.match(/<p/g) ?? []).length <= 5);
check("card whitelist: no caliber / freshness-layer / source paragraph stays on the overview card",
  !card.includes("主数字口径") && !card.includes("archCoverageLine(") && !card.includes("archLayerLine(")
  && !card.includes("余额来源：") && !card.includes("旧同步口径净资产") && !card.includes("两次快照的间隔不固定")
  && !card.includes("● Plaid 同步层") && !card.includes("● 快照层") && !card.includes("不要互相推导"));
check("caliber fold: the moved paragraphs are preserved verbatim in the detail tab",
  caliber.includes("主数字口径：混合余额日期的最近已知净值（新架构 F-ARCH-001）")
  && caliber.includes("archCoverageLine(arch)") && caliber.includes("archLayerLine(arch.plaidRange") && caliber.includes("archLayerLine(arch.snapshotRange")
  && caliber.includes("● Plaid 同步层") && caliber.includes("● 快照层（Firance 月度快照沿用）"));
check("caliber fold: metric caliber notes moved here too （储蓄率 / 应急金 / 投资 / 贷款 / 现金）",
  caliber.includes("{savingsRateNote}") && caliber.includes("{emergencyNote}")
  && caliber.includes("已融合实时余额") && caliber.includes("按未偿余额显示") && caliber.includes("不含 HSA/债券/退休/信用卡/贷款"));
check("overview whitelist: metric explanatory notes are gone from the overview tab",
  !overview.includes("已融合实时余额") && !overview.includes("按未偿余额显示")
  && !overview.includes("（收入 − 支出）÷ 收入") && !overview.includes("所用月份") && !overview.includes("不含 HSA"));
check("overview short forms kept: cash metric note is count-only, emergency note is the short form, anomaly strip is label + months + one short clause",
  overview.includes("现金账户 ${coverage.selectedCount} 个") && overview.includes("emergencyShortNote")
  && overview.includes("不计入 FIRE 年支出") && !overview.includes("仍保留在月度记录中"));

// --- F-ARCH labeling (PM 2026-10-24, locations updated by
// OVERVIEW-TRIM-001): every fact keeps its caliber label —
// the headline's caliber statement and the delta's full
// explanation now live in the caliber fold; the overview
// keeps the short labels in place. ---
check("label: headline calibre statement preserved in the caliber fold",
  caliber.includes("混合余额日期的最近已知净值（新架构 F-ARCH-001）"));
check("label: amounts/dates coverage counts + Plaid pull time adjacent to the headline (short numeric line stays)",
  card.includes("金额已计入 {arch.amountIncluded}/{arch.amountTotal} 个账户 · 有效余额日期 {arch.validDateCount}/{arch.dateTotal} 个账户 · Plaid 层拉取于 {pulledText}"));
check("label: the one-line conclusion carries the 旧同步口径 short label in place",
  appSrc.includes('const caliber = hasArch ? "旧同步口径 · " : "";') && card.includes("conclusionOneLiner(delta, view, arch != null)"));
check("label: delta explanation states its denominator is the old caliber and forbids cross-derivation (caliber fold)",
  caliber.includes("分母同为旧同步净资产") && caliber.includes("不是上方新架构主数字的变化，两者不要互相推导"));
check("label: old sync net worth amount is named in the caliber fold as the delta's basis",
  caliber.includes("旧同步口径净资产 {currency.format(data.live.netWorth)}"));
check("label: delta view is never computed against the arch total (no 95->100 implication)",
  !appSrc.includes("weeklyDeltaView(delta, arch") && !card.includes("arch.total -"));
check("label: detail view traces back to the old sync net worth",
  appSrc.includes("旧同步口径对照（明细追溯）：旧同步净资产 {currency.format(liveNetWorth)}")
  && appSrc.includes("旧同步口径 · 较上次成功快照（日期未留存）${trendIndicator(weeklyDelta)}")
  && appSrc.includes("与旧同步口径不要互相推导"));

// --- NW-TREND-SEAM-001 structure: seam annotation, line
// styles, range control, same-source monthly points ---
const seriesSrc = componentSlice("NetWorthDailySeries");
check("trend structure: chart built by the production helpers from the SAME months + the daily series",
  seriesSrc.includes("buildNetWorthTrend(months, series)") && seriesSrc.includes("filterNetWorthTrend(model, range)")
  && overview.includes("months={data.months}") && overview.includes("series={data.archNetWorthSeries}"));
check("trend structure: seam annotation replaces the old note （此前为月度快照； the 不回造 wording is gone)",
  seriesSrc.includes("起为日粒度；此前为月度快照") && !appSrc.includes("不回造日数据"));
check("trend structure: segments differ by line style + markers + text legend, never colour alone",
  seriesSrc.includes('dataKey="monthly"') && seriesSrc.includes('strokeDasharray="6 4"') && seriesSrc.includes("dot={{ r: 3")
  && seriesSrc.includes('dataKey="daily"') && seriesSrc.includes("月度快照：虚线＋圆点 · 日净值：实线"));
check("trend structure: seam marked on the chart itself (dashed ReferenceLine + 接缝 label)",
  seriesSrc.includes("ReferenceLine") && seriesSrc.includes('value: "接缝"') && seriesSrc.includes("view.seamVisible"));
check("trend structure: range switching lives on the overview chart, default 全部 (full seam visible)",
  seriesSrc.includes('aria-label="净值趋势时间范围"') && seriesSrc.includes('useState<Range>("all")'));

// --- feature reachability under the three-tab organisation ---
for (const marker of [
  "立即更新财务数据", "检查进度", "来源台账", "刷新观测",
  "搜索全部持仓", "查看全部持仓", "期间核对明细", "本页试算",
  "月度记录", "账户明细", "总资产账户明细", "走势", "FIRE 进度", "持仓 Top 10",
  "净值日序列", "日花销", "查看日历明细", "回到本月", "本月已发生合计",
  "日历指标切换", "入账", "投资收益·损失", "口径与来源说明", "仅月度",
]) {
  check(`reachable: ${marker}`, appSrc.includes(marker));
}

// --- screen estimate (documented height model, 390x844,
// THREE-TAB model): the page no longer stacks everything in
// one scroll. Overview default = status band + tab bar +
// conclusion + metrics + anomaly + FIRE line + trend chart +
// spend strip (target <= 3 screens). FIRE tab = status band +
// tab bar + the expanded panel. Detail default = status
// band + tab bar + the Calendar + the 10 closed fold
// summaries (ARCH-DEMO-001 added the synthetic demo fold).
// OVERVIEW-TRIM-001 shrinks the conclusion card
// (paragraphs moved to the caliber fold). ---
const VIEWPORT_PX = 844;
const OVERVIEW_BLOCKS = [
  ["状态行（工具行 + 刷新状态带）", 360],
  ["页签条", 52],
  ["总资产结论卡（TRIM 后：大数字 + 一句结论 + 覆盖行 + 快照对比）", 290],
  ["本月关键指标 7 格（2 列 4 行）", 508],
  ["数据异常条（假设存在）", 64],
  ["FIRE 一行摘要", 66],
  ["净值趋势图（月度段 + 日段 + 接缝注）", 356],
  ["日花销摘要条（近 7 天行 + 覆盖 meta + 日历按钮）", 150],
];
const overviewPx = OVERVIEW_BLOCKS.reduce((sum, [, px]) => sum + px, 0);
const overviewScreens = overviewPx / VIEWPORT_PX;
check(`overview tab default height ≈ ${overviewScreens.toFixed(2)} screens <= 3 (R2)`, overviewScreens <= 3);
const FIRE_BLOCKS = [
  ["状态行（工具行 + 刷新状态带）", 360],
  ["页签条", 52],
  ["FIRE 完整面板（展开呈现：环 + 历史图 + 统计 + 规则行）", 760],
];
const firePx = FIRE_BLOCKS.reduce((sum, [, px]) => sum + px, 0);
const fireScreens = firePx / VIEWPORT_PX;
check(`FIRE tab default height ≈ ${fireScreens.toFixed(2)} screens <= 3`, fireScreens <= 3);
const DETAIL_BLOCKS = [
  ["状态行（工具行 + 刷新状态带）", 360],
  ["页签条", 52],
  ["日历 Calendar（指标切换 + 导航 + 汇总行 + 星期行 + 5 行格子 + 口径注）", 604],
  ["合成预览演示折叠 summary（ARCH-DEMO-001，默认关闭）", 61],
  ["依据层 4 个折叠 summary", 246],
  ["台账层 5 个折叠 summary（口径/走势/月度记录/总资产账户/账户明细）", 305],
];
const detailPx = DETAIL_BLOCKS.reduce((sum, [, px]) => sum + px, 0);
const detailScreens = detailPx / VIEWPORT_PX;
check(`detail tab default height ≈ ${detailScreens.toFixed(2)} screens <= 3`, detailScreens <= 3);
check("height model is a three-tab model (tab bar + Calendar + FIRE panel named)",
  OVERVIEW_BLOCKS.some(([label]) => label.includes("页签")) && DETAIL_BLOCKS.some(([label]) => label.includes("Calendar"))
  && FIRE_BLOCKS.some(([label]) => label.includes("FIRE")));
console.log(`screen model (three-tab): overview ~${overviewScreens.toFixed(1)} screens (${overviewPx}px), FIRE ~${fireScreens.toFixed(1)} screens (${firePx}px), detail ~${detailScreens.toFixed(1)} screens (${detailPx}px) of ${VIEWPORT_PX}px viewport`);

console.log(`validate-design-b1a: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
