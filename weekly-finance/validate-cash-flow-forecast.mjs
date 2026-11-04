/**
 * F3.3 未来现金流日历预测 — 验证脚本（合成数据）。
 * 以真实生产纯函数（server/src/cashFlowForecast.ts，经 esbuild 打包为临时 cjs，
 * 其 import 的 ./recurringCharges 由打包自动纳入本仓双端适配版）跑断言；
 * 另含 2 项变异真实执行（改源码副本、重打包、必须翻转）。
 *
 * 运行：node validate-cash-flow-forecast.mjs
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const here = new URL(".", import.meta.url).pathname;
const srcDir = join(here, "server", "src");

// ---- 把 TS 纯模块打包为可 require 的 cjs（仅内存临时目录，不污染仓库） ----
const tmp = mkdtempSync(join(tmpdir(), "f33-validate-"));
function bundle(entryAbs, outName) {
  const out = join(tmp, outName);
  try {
    execSync(
      `npx --yes esbuild "${entryAbs}" --bundle --platform=node --format=cjs --outfile="${out}" --log-level=error`,
      { stdio: "pipe" }
    );
  } catch (e) {
    console.error("esbuild 打包失败（需要 npx esbuild 可用）：", e.message);
    process.exit(2);
  }
  return out;
}
const require = createRequire(import.meta.url);
const fc = require(bundle(join(srcDir, "cashFlowForecast.ts"), "cashFlowForecast.cjs"));
const rc = require(bundle(join(srcDir, "recurringCharges.ts"), "recurringCharges.cjs"));

let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? " — " + detail : ""}`);
  }
}
// 在线契约行（Plaid 口径：流出为正、入账为负；商户字段 name）
function otx(date, amount, name, extra = {}) {
  return { date, amount, name, ...extra };
}

// ---------- 1. forecastCadenceLabel ----------
assert("标签 weekly=按周", fc.forecastCadenceLabel("weekly") === "按周");
assert("标签 monthly=按月", fc.forecastCadenceLabel("monthly") === "按月");
assert("标签 quarterly=按季", fc.forecastCadenceLabel("quarterly") === "按季");
assert("标签 yearly=按年", fc.forecastCadenceLabel("yearly") === "按年");

// ---------- 2. formatIntervalDays / forecastBasisText ----------
assert("整天显示30", fc.formatIntervalDays(30) === "30");
assert("半天显示30.5", fc.formatIntervalDays(30.5) === "30.5");
assert(
  "依据文案",
  fc.forecastBasisText(4, 30) === "基于 4 笔历史记录、中位间隔 30 天推断",
  fc.forecastBasisText(4, 30)
);
assert(
  "依据文案小数",
  fc.forecastBasisText(3, 30.5) === "基于 3 笔历史记录、中位间隔 30.5 天推断",
  fc.forecastBasisText(3, 30.5)
);

// ---------- 3. isOutflowTransaction（Plaid 口径：流出为正） ----------
{
  const T = "2026-10-20";
  assert("流出行合法", fc.isOutflowTransaction(otx("2026-10-15", 15.99, "Netflix"), T) === true);
  assert("入账非流出", fc.isOutflowTransaction(otx("2026-10-15", -15.99, "Netflix"), T) === false);
  assert("零金额非流出", fc.isOutflowTransaction(otx("2026-10-15", 0, "Netflix"), T) === false);
  assert("未来日期排除", fc.isOutflowTransaction(otx("2026-10-25", 15.99, "Netflix"), T) === false);
  assert("pending排除", fc.isOutflowTransaction(otx("2026-10-15", 15.99, "Netflix", { pending: true }), T) === false);
  assert("内部互转排除", fc.isOutflowTransaction(otx("2026-10-15", 15.99, "Netflix", { internalTransfer: true }), T) === false);
  assert('direction in排除', fc.isOutflowTransaction(otx("2026-10-15", 15.99, "Netflix", { direction: "in" }), T) === false);
  assert("空商户排除", fc.isOutflowTransaction(otx("2026-10-15", 15.99, "  "), T) === false);
  assert("非法日期排除", fc.isOutflowTransaction(otx("2026-13-01", 15.99, "Netflix"), T) === false);
  assert("NaN金额排除", fc.isOutflowTransaction(otx("2026-10-15", NaN, "Netflix"), T) === false);
}

// ---------- 4. isIncomeTransaction（Plaid 口径：入账为负） ----------
{
  const T = "2026-10-20";
  assert("入账行合法", fc.isIncomeTransaction(otx("2026-10-15", -5000, "Acme Corp"), T) === true);
  assert("流出非入账", fc.isIncomeTransaction(otx("2026-10-15", 5000, "Acme Corp"), T) === false);
  assert("零金额非入账", fc.isIncomeTransaction(otx("2026-10-15", 0, "Acme Corp"), T) === false);
  assert('direction out排除', fc.isIncomeTransaction(otx("2026-10-15", -5000, "Acme Corp", { direction: "out" }), T) === false);
  assert("pending排除", fc.isIncomeTransaction(otx("2026-10-15", -5000, "Acme Corp", { pending: true }), T) === false);
  assert("未来日期排除", fc.isIncomeTransaction(otx("2026-10-25", -5000, "Acme Corp"), T) === false);
}

// ---------- 5. detectRecurringIncome ----------
{
  const T = "2026-10-20";
  const salary = [
    otx("2026-08-15", -5000, "Acme Corp"),
    otx("2026-09-15", -5000, "Acme Corp"),
    otx("2026-10-15", -5000, "Acme Corp"),
  ];
  const r = fc.detectRecurringIncome(salary, { today: T });
  assert("工资识别1项", r.length === 1, JSON.stringify(r.length));
  assert("收入商户名", r[0]?.merchant === "Acme Corp", r[0]?.merchant);
  assert("收入周期monthly", r[0]?.cadence === "monthly", r[0]?.cadence);
  assert("收入金额取绝对值5000", r[0]?.latestAmount === 5000, String(r[0]?.latestAmount));
  assert("收入笔数3", r[0]?.occurrences === 3);
  assert("收入下次=2026-11-15", r[0]?.nextExpectedDate === "2026-11-15", r[0]?.nextExpectedDate);
}
{
  // 扣费商户的入账按退款排除
  const T = "2026-10-20";
  const t = [
    otx("2026-08-15", 15.99, "Netflix"), otx("2026-09-15", 15.99, "Netflix"), otx("2026-10-15", 15.99, "Netflix"),
    otx("2026-08-16", -15.99, "Netflix"), otx("2026-09-16", -15.99, "Netflix"), otx("2026-10-16", -15.99, "Netflix"),
  ];
  const r = fc.detectRecurringIncome(t, { today: T });
  assert("扣费商户入账被排除", r.length === 0, JSON.stringify(r.length));
}
{
  // 证据不足：2笔月收入不列出
  const T = "2026-10-20";
  const t = [otx("2026-09-15", -5000, "Acme Corp"), otx("2026-10-15", -5000, "Acme Corp")];
  const r = fc.detectRecurringIncome(t, { today: T });
  assert("2笔月收入不列出", r.length === 0, JSON.stringify(r.length));
}
{
  // 年收入：2笔365天即认定，枚举为 yearly
  const T = "2026-10-20";
  const t = [otx("2025-10-10", -1200, "Bonus"), otx("2026-10-10", -1200, "Bonus")];
  const r = fc.detectRecurringIncome(t, { today: T });
  assert("年收入识别", r.length === 1 && r[0].cadence === "yearly", JSON.stringify(r.map((x) => x.cadence)));
}

// ---------- 6. detectRecurringChargesOnline（双端契约适配） ----------
{
  const T = "2026-10-20";
  const t = [
    otx("2026-08-15", 15.99, "Netflix"),
    otx("2026-09-15", 15.99, "netflix "),
    otx("2026-10-15", 15.99, "NETFLIX"),
  ];
  const r = rc.detectRecurringChargesOnline(t, { today: T });
  assert("在线契约识别1项", r.length === 1, JSON.stringify(r.length));
  assert("输出merchant取最新name.trim", r[0]?.merchant === "NETFLIX", r[0]?.merchant);
  assert("normalizedMerchant归一", r[0]?.normalizedMerchant === "netflix", r[0]?.normalizedMerchant);
  assert("周期monthly", r[0]?.cadence === "monthly", r[0]?.cadence);
  assert("latestAmount=15.99", r[0]?.latestAmount === 15.99, String(r[0]?.latestAmount));
  assert("笔数3", r[0]?.occurrences === 3);
  assert("下次=2026-11-15", r[0]?.nextExpectedDate === "2026-11-15", r[0]?.nextExpectedDate);
  assert("中位间隔30.5", r[0]?.medianIntervalDays === 30.5, String(r[0]?.medianIntervalDays));
}
{
  // annual专项：365天×2笔 → yearly（枚举单点转换）
  const T = "2026-10-20";
  const t = [otx("2025-10-10", 99, "Amazon Prime"), otx("2026-10-10", 99, "Amazon Prime")];
  const r = rc.detectRecurringChargesOnline(t, { today: T });
  assert("年费识别且枚举=yearly", r.length === 1 && r[0].cadence === "yearly", JSON.stringify(r.map((x) => x.cadence)));
  assert("年费下次=2027-10-10", r[0]?.nextExpectedDate === "2027-10-10", r[0]?.nextExpectedDate);
}
{
  // 2笔月费不列出（门槛）
  const T = "2026-10-20";
  const t = [otx("2026-09-15", 10, "Hulu"), otx("2026-10-15", 10, "Hulu")];
  const r = rc.detectRecurringChargesOnline(t, { today: T });
  assert("2笔月费不列出", r.length === 0, JSON.stringify(r.length));
}
{
  // 本仓 detectRecurringCharges 接受 name 别名（流出为负口径）
  const t = [
    { date: "2026-08-15", amount: -15.99, name: "Netflix" },
    { date: "2026-09-15", amount: -15.99, name: "Netflix" },
    { date: "2026-10-15", amount: -15.99, name: "Netflix" },
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("name别名可分组识别", r.length === 1 && r[0].cadence === "monthly", JSON.stringify(r.length));
}

// ---------- 7. 双端枚举/工具适配 ----------
assert("annual→yearly", rc.toOnlineCadence("annual") === "yearly");
assert("monthly恒等", rc.toOnlineCadence("monthly") === "monthly");
assert("yearly→annual", rc.toWarehouseCadence("yearly") === "annual");
{
  const rule = rc.classifyCadence(365, 2);
  assert("classify年周期", rule && rule.cadence === "yearly" && rule.annualizedFactor === 1, JSON.stringify(rule));
  assert("classify月周期", rc.classifyCadence(30, 3)?.cadence === "monthly");
  assert("classify笔数不足null", rc.classifyCadence(30, 2) === null);
  assert("classify窗外null", rc.classifyCadence(10, 5) === null);
}
assert("isValidDateKey合法", rc.isValidDateKey("2026-10-20") === true);
assert("isValidDateKey非法", rc.isValidDateKey("2026-13-01") === false);
assert("addDays跨月", rc.addDaysToDateKey("2026-10-15", 31) === "2026-11-15");
assert("daysBetween", rc.daysBetweenDateKeys("2026-08-15", "2026-09-15") === 31);
assert("medianNumber空=null", rc.medianNumber([]) === null);
assert("roundMoney", rc.roundMoney(15.995) === 16 && rc.roundMoney(-15.99) === -15.99);
assert("normalizeMerchantName", rc.normalizeMerchantName("  NetFlix  ") === "netflix");

// ---------- 8. recurringLandingDates ----------
{
  const d = fc.recurringLandingDates("2026-11-15", 30.5, "2026-10-20", "2027-01-17");
  assert(
    "落点三处",
    JSON.stringify(d) === JSON.stringify(["2026-11-15", "2026-12-16", "2027-01-16"]),
    JSON.stringify(d)
  );
  const d2 = fc.recurringLandingDates("2026-11-15", 30.5, "2026-12-01", "2027-01-17");
  assert("落点早于起点被步进跳过", JSON.stringify(d2) === JSON.stringify(["2026-12-16", "2027-01-16"]), JSON.stringify(d2));
  const d3 = fc.recurringLandingDates("2026-10-20", 0, "2026-10-20", "2026-10-22");
  assert("退化间隔不死循环", JSON.stringify(d3) === JSON.stringify(["2026-10-20", "2026-10-21", "2026-10-22"]), JSON.stringify(d3));
}

// ---------- 9. forecastCashFlow 端到端 ----------
const E2E_TODAY = "2026-10-20";
function e2eFixture() {
  return [
    otx("2026-08-15", 15.99, "Netflix"),
    otx("2026-09-15", 15.99, "Netflix"),
    otx("2026-10-15", 15.99, "Netflix"),
    otx("2026-08-15", -5000, "Acme Corp"),
    otx("2026-09-15", -5000, "Acme Corp"),
    otx("2026-10-15", -5000, "Acme Corp"),
  ];
}
{
  const f = fc.forecastCashFlow({ transactions: e2eFixture(), depositsBalance: 10000, today: E2E_TODAY, horizonDays: 90 });
  assert("startDate", f.startDate === E2E_TODAY, f.startDate);
  assert("horizonDays=90", f.horizonDays === 90);
  assert("startBalance=10000", f.startBalance === 10000);
  assert("days长度90", f.days.length === 90, String(f.days.length));
  assert("day1余额=10000", f.days[0].balance === 10000 && f.days[0].date === E2E_TODAY);
  const byDate = new Map(f.days.map((d) => [d.date, d]));
  assert("11-15 delta=4984.01", byDate.get("2026-11-15")?.delta === 4984.01, String(byDate.get("2026-11-15")?.delta));
  assert("11-15 balance=14984.01", byDate.get("2026-11-15")?.balance === 14984.01, String(byDate.get("2026-11-15")?.balance));
  assert("12-16 balance=19968.02", byDate.get("2026-12-16")?.balance === 19968.02, String(byDate.get("2026-12-16")?.balance));
  assert("01-16 balance=24952.03", byDate.get("2027-01-16")?.balance === 24952.03, String(byDate.get("2027-01-16")?.balance));
  assert("11-15两项明细", byDate.get("2026-11-15")?.items.length === 2);
  assert("低点=起点", f.lowPoint.date === E2E_TODAY && f.lowPoint.balance === 10000, JSON.stringify(f.lowPoint));
  assert("假设2条", f.assumptions.length === 2, String(f.assumptions.length));
  const [inc, exp] = f.assumptions;
  assert("假设排序收入在前", inc.kind === "income" && exp.kind === "expense");
  assert("收入假设商户", inc.merchant === "Acme Corp", inc.merchant);
  assert("收入假设金额5000", inc.amount === 5000, String(inc.amount));
  assert("收入假设周期monthly", inc.cadence === "monthly" && inc.cadenceLabel === "按月");
  assert("支出假设金额-15.99", exp.amount === -15.99, String(exp.amount));
  assert("支出假设商户", exp.merchant === "Netflix", exp.merchant);
  assert(
    "依据文案",
    inc.basisText === "基于 3 笔历史记录、中位间隔 30.5 天推断",
    inc.basisText
  );
}
{
  // horizon钳制
  const f1 = fc.forecastCashFlow({ transactions: [], depositsBalance: 100, today: E2E_TODAY, horizonDays: 500 });
  assert("horizon上限366", f1.horizonDays === 366 && f1.days.length === 366);
  const f2 = fc.forecastCashFlow({ transactions: [], depositsBalance: 100, today: E2E_TODAY, horizonDays: 0 });
  assert("horizon下限1", f2.horizonDays === 1 && f2.days.length === 1);
  const f3 = fc.forecastCashFlow({ transactions: [], depositsBalance: NaN, today: E2E_TODAY });
  assert("非法余额归零", f3.startBalance === 0);
  assert("空交易低点=起点", f3.lowPoint.date === E2E_TODAY && f3.lowPoint.balance === 0);
}
{
  // 低点真正下跌的情形：只有支出
  const f = fc.forecastCashFlow({
    transactions: [otx("2026-08-15", 200, "Rent"), otx("2026-09-15", 200, "Rent"), otx("2026-10-15", 200, "Rent")],
    depositsBalance: 1000,
    today: E2E_TODAY,
    horizonDays: 90,
  });
  assert("纯支出低点在末次落点", f.lowPoint.date === "2027-01-16" && f.lowPoint.balance === 400, JSON.stringify(f.lowPoint));
}

// ---------- 10. 变异测试（真实执行：改源码副本、重打包、必须翻转） ----------
function bundleMutated(mutator, label) {
  const mdir = mkdtempSync(join(tmpdir(), "f33-mut-"));
  copyFileSync(join(srcDir, "cashFlowForecast.ts"), join(mdir, "cashFlowForecast.ts"));
  copyFileSync(join(srcDir, "recurringCharges.ts"), join(mdir, "recurringCharges.ts"));
  const src = readFileSync(join(mdir, "cashFlowForecast.ts"), "utf8");
  const mutatedSrc = mutator(src);
  if (mutatedSrc === src) {
    console.error(`变异 ${label} 未命中目标代码`);
    process.exit(2);
  }
  writeFileSync(join(mdir, "cashFlowForecast.ts"), mutatedSrc);
  const out = join(mdir, "mut.cjs");
  execSync(
    `npx --yes esbuild "${join(mdir, "cashFlowForecast.ts")}" --bundle --platform=node --format=cjs --outfile="${out}" --log-level=error`,
    { stdio: "pipe" }
  );
  const m = require(out);
  rmSync(mdir, { recursive: true, force: true });
  return m;
}
// 变异1：删除收入识别（incomes恒为空）→ 终值应由24952.03变为9952.03，假设只剩1条
{
  const m = bundleMutated(
    (s) => s.replace(
      "const incomes = detectRecurringIncome(transactions, { today: todayKey });",
      "const incomes: RecurringIncome[] = [];"
    ),
    "M1"
  );
  const f = m.forecastCashFlow({ transactions: e2eFixture(), depositsBalance: 10000, today: E2E_TODAY, horizonDays: 90 });
  const lastBalance = f.days[f.days.length - 1].balance;
  assert(
    "变异1翻转：删收入识别使终值24952.03→9952.03且假设剩1条",
    lastBalance === 9952.03 && f.assumptions.length === 1,
    `mut_last=${lastBalance} mut_assumptions=${f.assumptions.length}`
  );
}
// 变异2：反转低点比较（<改>）→ 低点应由起点变为最高点
{
  const m = bundleMutated(
    (s) => s.replace(
      "if (balance < lowPoint.balance) lowPoint = { date, balance };",
      "if (balance > lowPoint.balance) lowPoint = { date, balance };"
    ),
    "M2"
  );
  const f = m.forecastCashFlow({ transactions: e2eFixture(), depositsBalance: 10000, today: E2E_TODAY, horizonDays: 90 });
  assert(
    "变异2翻转：反转低点比较使低点离开起点",
    !(f.lowPoint.date === E2E_TODAY && f.lowPoint.balance === 10000) && f.lowPoint.balance === 24952.03,
    `mut_low=${JSON.stringify(f.lowPoint)}`
  );
}

rmSync(tmp, { recursive: true, force: true });

// ---------- 11. 接线断言（F3.3 仓库接线轮次新增；源码文本＋真实函数输出形状） ----------
{
  const actionsSrc = readFileSync(join(srcDir, "actions.ts"), "utf8");
  const appSrc = readFileSync(join(here, "client", "src", "App.tsx"), "utf8");
  const cssSrc = readFileSync(join(here, "client", "src", "theme.css"), "utf8");

  // 服务端：import / schema / buildDashboard 默认值 / ingest 回填
  assert("接线 import forecastCashFlow", actionsSrc.includes('import { forecastCashFlow } from "./cashFlowForecast"'));
  assert("接线 cashFlowForecastSchema 定义", actionsSrc.includes("const cashFlowForecastSchema = z.object({"));
  assert("接线 schema 枚举用 yearly（在线契约）", actionsSrc.includes('cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"])'));
  assert("接线 dashboardSchema 字段", actionsSrc.includes("cashFlowForecast: cashFlowForecastSchema.nullable().default(null),"));
  assert("接线 buildDashboard 默认 null", actionsSrc.includes("cashFlowForecast: null,"));
  assert("接线 ingest 回填调用", actionsSrc.includes("dashboard.cashFlowForecast = forecastCashFlow({"));
  assert("接线 transactions 原样透传", actionsSrc.includes("transactions: args.plaidTransactions,"));
  assert("接线 depositsBalance 取 live.deposits", actionsSrc.includes("depositsBalance: dashboard.live.deposits ?? 0,"));
  assert("接线 today 取 asOf 日历日", actionsSrc.includes("today: args.asOf.slice(0, 10),"));

  // 客户端：面板定义＋导出 helpers＋挂载顺序（RecurringCharges 后、TxReviewQueue 前）
  assert("接线 CashFlowForecastPanel 定义", appSrc.includes("function CashFlowForecastPanel({ forecast }"));
  assert("接线 forecastVisibleLowPoint 导出", appSrc.includes("export function forecastVisibleLowPoint("));
  assert("接线 forecastChartPoints 导出", appSrc.includes("export function forecastChartPoints("));
  assert("接线面板挂载", appSrc.includes("<CashFlowForecastPanel forecast={data.cashFlowForecast} />"));
  const iRec = appSrc.indexOf("<RecurringChargesPanel charges={data.recurringCharges} />");
  const iFc = appSrc.indexOf("<CashFlowForecastPanel forecast={data.cashFlowForecast} />");
  const iTx = appSrc.indexOf("<TxReviewQueuePanel queue={txReviewQueue} />");
  assert("接线挂载顺序 Recurring→Forecast→TxReview", iRec > 0 && iFc > iRec && iTx > iFc, `idx=${iRec}/${iFc}/${iTx}`);
  assert("接线面板只渲染服务端结果（无重算）", !/function CashFlowForecastPanel[\s\S]{0,4000}forecastCashFlow\(/.test(appSrc));

  // 样式：forecast-* 规则块存在，范围按钮 44px
  assert("接线 CSS .forecast-panel", cssSrc.includes(".forecast-panel {"));
  assert("接线 CSS .forecast-disclaimer", cssSrc.includes(".forecast-disclaimer {"));
  assert("接线 CSS 范围按钮 44px", /\.forecast-range button \{[^}]*min-height: 44px/.test(cssSrc));

  // 真实函数输出与手写 schema 形状兼容（枚举必须是在线 yearly，仓库 annual 应被拒绝）
  const ONLINE_CADENCES = ["weekly", "monthly", "quarterly", "yearly"];
  function shapeMatchesOnlineSchema(f) {
    if (!f || typeof f.startDate !== "string") return false;
    if (!Number.isInteger(f.horizonDays) || f.horizonDays <= 0) return false;
    if (typeof f.startBalance !== "number") return false;
    if (!Array.isArray(f.days) || f.days.length === 0) return false;
    for (const d of f.days) {
      if (typeof d.date !== "string" || typeof d.delta !== "number" || typeof d.balance !== "number") return false;
      if (!Array.isArray(d.items)) return false;
      for (const it of d.items) {
        if (typeof it.merchant !== "string" || typeof it.amount !== "number") return false;
        if (it.kind !== "income" && it.kind !== "expense") return false;
      }
    }
    if (!f.lowPoint || typeof f.lowPoint.date !== "string" || typeof f.lowPoint.balance !== "number") return false;
    if (!Array.isArray(f.assumptions)) return false;
    for (const a of f.assumptions) {
      if (typeof a.merchant !== "string" || typeof a.cadenceLabel !== "string") return false;
      if (a.kind !== "income" && a.kind !== "expense") return false;
      if (!ONLINE_CADENCES.includes(a.cadence)) return false;
      if (typeof a.amount !== "number" || !Number.isInteger(a.occurrences) || a.occurrences < 0) return false;
      if (typeof a.medianIntervalDays !== "number" || typeof a.nextExpectedDate !== "string" || typeof a.basisText !== "string") return false;
    }
    return true;
  }
  const wireFixture = [
    otx("2025-11-05", 899, "Netflix"),
    otx("2026-11-04", 899, "Netflix"),
    otx("2026-08-15", -5200, "Acme Payroll"),
    otx("2026-09-15", -5200, "Acme Payroll"),
    otx("2026-10-15", -5200, "Acme Payroll"),
  ];
  const wf = fc.forecastCashFlow({ transactions: wireFixture, depositsBalance: 20000, today: "2026-11-04" });
  assert("接线真实输出符合在线 schema 形状", shapeMatchesOnlineSchema(wf));
  assert("接线真实输出含 yearly 假设", wf.assumptions.some((a) => a.cadence === "yearly"));
  // 负向：仓库枚举 annual 不应通过在线形状检查（双端契约映射的必要性）
  const broken = JSON.parse(JSON.stringify(wf));
  if (broken.assumptions.length > 0) broken.assumptions[0].cadence = "annual";
  assert("接线 annual 枚举被在线形状拒绝", !shapeMatchesOnlineSchema(broken));
}

console.log(`\nvalidate-cash-flow-forecast: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
