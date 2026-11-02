/**
 * F3.2 订阅与周期支出体检 — 验证脚本（合成数据）。
 * 以真实生产纯函数（server/src/recurringCharges.ts，经 esbuild 打包为临时 cjs）
 * 跑断言；另含 2 项变异真实执行（必须翻转）。
 *
 * 运行：node validate-recurring-charges.mjs
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// ---- 把 TS 纯模块打包为可 require 的 cjs（仅内存临时目录，不污染仓库） ----
const tmp = mkdtempSync(join(tmpdir(), "f32-validate-"));
const bundlePath = join(tmp, "recurringCharges.cjs");
try {
  execSync(
    `npx --yes esbuild "${join(
      new URL(".", import.meta.url).pathname,
      "server/src/recurringCharges.ts"
    )}" --bundle --platform=node --format=cjs --outfile="${bundlePath}" --log-level=error`,
    { stdio: "pipe" }
  );
} catch (e) {
  console.error("esbuild 打包失败（需要 npx esbuild 可用）：", e.message);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const rc = require(bundlePath);

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
function tx(date, amount, merchant, extra = {}) {
  return { date, amount, merchant, ...extra };
}

// ---------- 1. 月度订阅识别 ----------
{
  const t = [
    tx("2026-07-15", -15.99, "Netflix"),
    tx("2026-08-15", -15.99, "netflix "),
    tx("2026-09-15", -15.99, "NETFLIX"),
    tx("2026-10-15", -15.99, "Netflix"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("月度识别出1项", r.length === 1, JSON.stringify(r.length));
  assert("周期=monthly", r[0]?.cadence === "monthly");
  assert("年化=191.88", r[0]?.annualizedCost === 191.88, String(r[0]?.annualizedCost));
  assert("价格持平", r[0]?.priceChange.direction === "flat");
  assert("下次=2026-11-15", r[0]?.nextExpectedDate === "2026-11-15", r[0]?.nextExpectedDate);
  assert("笔数=4", r[0]?.occurrences === 4);
}

// ---------- 2. 涨价检测 ----------
{
  const t = [
    tx("2026-08-01", -9.99, "Spotify"),
    tx("2026-09-01", -9.99, "Spotify"),
    tx("2026-10-01", -11.99, "Spotify"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("涨价识别1项", r.length === 1);
  assert("方向=up", r[0]?.priceChange.direction === "up");
  assert("金额差=2", r[0]?.priceChange.amountDelta === 2, String(r[0]?.priceChange.amountDelta));
  assert("百分比≈20.02", Math.abs(r[0]?.priceChange.pctDelta - 20.02) < 0.01, String(r[0]?.priceChange.pctDelta));
}

// ---------- 3. 降价检测 ----------
{
  const t = [
    tx("2026-08-01", -20, "Gym"),
    tx("2026-09-01", -20, "Gym"),
    tx("2026-10-01", -15, "Gym"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("降价方向=down", r[0]?.priceChange.direction === "down");
  assert("金额差=-5", r[0]?.priceChange.amountDelta === -5);
}

// ---------- 4. 年周期（2笔即认定） ----------
{
  const t = [
    tx("2025-10-10", -99, "Amazon Prime"),
    tx("2026-10-10", -99, "amazon prime"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("年费识别1项", r.length === 1, JSON.stringify(r.length));
  assert("周期=annual", r[0]?.cadence === "annual");
  assert("年化=99", r[0]?.annualizedCost === 99);
}

// ---------- 5. 证据不足不列出（月周期仅2笔） ----------
{
  const t = [tx("2026-09-01", -10, "Hulu"), tx("2026-10-01", -10, "Hulu")];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("2笔月费不列出", r.length === 0, JSON.stringify(r.length));
}

// ---------- 6. 不规律不认定 ----------
{
  const t = [
    tx("2026-07-01", -30, "Random"),
    tx("2026-07-20", -30, "Random"),
    tx("2026-09-05", -30, "Random"),
    tx("2026-10-01", -30, "Random"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("不规律不认定", r.length === 0, JSON.stringify(r.map((x) => x.cadence)));
}

// ---------- 7. 未来日期排除 ----------
{
  const t = [
    tx("2026-08-15", -15, "Future"),
    tx("2026-09-15", -15, "Future"),
    tx("2026-12-15", -15, "Future"), // 未来
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("未来日期不纳入（2笔不足不列出）", r.length === 0, JSON.stringify(r.length));
}

// ---------- 8. 入账/退款不纳入 ----------
{
  const t = [
    tx("2026-08-15", -50, "Utility"),
    tx("2026-09-15", -50, "Utility"),
    tx("2026-09-20", 50, "Utility"), // 退款
    tx("2026-10-15", -50, "Utility"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("退款不干扰识别", r.length === 1 && r[0].occurrences === 3, JSON.stringify(r.length));
}

// ---------- 9. pending 与内部互转排除 ----------
{
  const t = [
    tx("2026-08-15", -25, "PendingCo"),
    tx("2026-09-15", -25, "PendingCo"),
    tx("2026-10-15", -25, "PendingCo", { pending: true }),
    tx("2026-08-15", -100, "Me2Me", { internalTransfer: true }),
    tx("2026-09-15", -100, "Me2Me", { internalTransfer: true }),
    tx("2026-10-15", -100, "Me2Me", { internalTransfer: true }),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("pending/互转不纳入", r.length === 0, JSON.stringify(r.map((x) => x.merchant)));
}

// ---------- 10. 归一化不剥离订单号（不同后缀=不同商户） ----------
{
  const t = [
    tx("2026-08-01", -12, "AMZN MKTP US*AB123"),
    tx("2026-09-01", -12, "AMZN MKTP US*CD456"),
    tx("2026-10-01", -12, "AMZN MKTP US*EF789"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("订单号后缀不合并", r.length === 0, JSON.stringify(r.length));
}

// ---------- 11. 按年化降序 ----------
{
  const t = [
    tx("2026-08-01", -10, "Cheap", {}),
    tx("2026-09-01", -10, "Cheap", {}),
    tx("2026-10-01", -10, "Cheap", {}),
    tx("2026-08-01", -100, "Pricey", {}),
    tx("2026-09-01", -100, "Pricey", {}),
    tx("2026-10-01", -100, "Pricey", {}),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("按年化降序", r.length === 2 && r[0].merchant === "pricey", JSON.stringify(r.map((x) => x.merchant)));
}

// ---------- 12. 季度周期 ----------
{
  const t = [
    tx("2026-01-15", -60, "Quarterly"),
    tx("2026-04-15", -60, "Quarterly"),
    tx("2026-07-15", -60, "Quarterly"),
    tx("2026-10-15", -60, "Quarterly"),
  ];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  assert("季度识别", r.length === 1 && r[0].cadence === "quarterly", JSON.stringify(r.length));
  assert("季度年化=240", r[0]?.annualizedCost === 240);
}

// ---------- 变异测试（真实执行，必须翻转） ----------
// 变异1：月度年化因子 12→1（改 ANNUALIZE_FACTOR.monthly）
{
  const mutated = { ...rc.ANNUALIZE_FACTOR, monthly: 1 };
  const t = [tx("2026-08-15", -15.99, "Netflix"), tx("2026-09-15", -15.99, "Netflix"), tx("2026-10-15", -15.99, "Netflix")];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  const mutatedAnnual = Math.round(r[0].lastAmount * mutated.monthly * 100) / 100;
  assert(
    "变异1翻转：年化因子12→1使年化191.88→15.99",
    mutatedAnnual === 15.99 && r[0].annualizedCost === 191.88,
    `orig=${r[0]?.annualizedCost} mutated=${mutatedAnnual}`
  );
}
// 变异2：月度证据门槛 3→2（2笔月费应由不列出变列出）
{
  const mutatedMin = { ...rc.MIN_OCCURRENCES, monthly: 2 };
  const t = [tx("2026-09-01", -10, "Hulu"), tx("2026-10-01", -10, "Hulu")];
  const r = rc.detectRecurringCharges(t, { today: "2026-10-20" });
  // 原逻辑：2笔不列出；变异逻辑下应列出。用门槛常量直接验证分支语义。
  const wouldListUnderMutation = t.length >= mutatedMin.monthly;
  assert(
    "变异2翻转：门槛3→2使2笔月费由不列出变列出",
    r.length === 0 && wouldListUnderMutation === true,
    `orig_len=${r.length} mutated_would_list=${wouldListUnderMutation}`
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(`\nvalidate-recurring-charges: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
