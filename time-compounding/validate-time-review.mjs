#!/usr/bin/env node
// validate-time-review.mjs — CMP-TIME-001 本周回顾增量验证。
//
// 两部分：
//  A. 口径断言：独立复算洛杉矶周窗 / 区间并集 / 重叠 / 未覆盖与尚未到来 /
//     三种覆盖状态分类（零记录 / 部分覆盖 / 完整覆盖），含 DST 切换周
//     （167h / 169h）与跨周区间裁剪。算法与 server/src/actions.ts 同定义，
//     本脚本独立实现、独立断言，不 import 生产代码。
//  B. 呈现断言：扫描 client/src/App.tsx，确认三种状态的必需文案、过滤
//     标注与回到全部入口存在，且没有跨 app「总分」类文案。
//
// 用法：node validate-time-review.mjs（或 bun validate-time-review.mjs）
// 退出码 0 = 全部通过；1 = 有失败。只读，不写任何数据。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
  }
}
function eq(name, actual, expected) {
  check(`${name} (got ${actual}, want ${expected})`, actual === expected);
}
function approx(name, actual, expected, tol = 1e-6) {
  check(
    `${name} (got ${actual}, want ~${expected})`,
    Math.abs(actual - expected) <= tol,
  );
}

// ------------------------------------------------------------ LA week math
const laDtf = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function laParts(ms) {
  const p = {};
  for (const part of laDtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour),
    mm: Number(p.minute),
    ss: Number(p.second),
  };
}
function laMidnightMs(y, m, d) {
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = laParts(guess);
    guess += Date.UTC(y, m - 1, d, 0, 0, 0) - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  }
  return guess;
}
function fmtDate(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function weekWindowContaining(ms) {
  const p = laParts(ms);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  const back = (dow + 6) % 7;
  const mon = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  const sy = mon.getUTCFullYear();
  const sm = mon.getUTCMonth() + 1;
  const sd = mon.getUTCDate();
  const startMs = laMidnightMs(sy, sm, sd);
  const next = new Date(Date.UTC(sy, sm - 1, sd + 7));
  const endMs = laMidnightMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  const sun = new Date(Date.UTC(sy, sm - 1, sd + 6));
  return {
    startMs,
    endMs,
    totalHours: (endMs - startMs) / 3_600_000,
    startLabel: fmtDate(sy, sm, sd),
    endLabel: fmtDate(sun.getUTCFullYear(), sun.getUTCMonth() + 1, sun.getUTCDate()),
  };
}
function clip(iv, lo, hi) {
  const startMs = Math.max(iv.startMs, lo);
  const endMs = Math.min(iv.endMs, hi);
  return endMs > startMs ? { startMs, endMs } : null;
}
function unionMinutes(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let curStart = sorted[0].startMs;
  let curEnd = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.startMs <= curEnd) curEnd = Math.max(curEnd, iv.endMs);
    else {
      total += curEnd - curStart;
      curStart = iv.startMs;
      curEnd = iv.endMs;
    }
  }
  total += curEnd - curStart;
  return total / 60_000;
}
// Mirror of the client's coverageStateOf.
function coverageStateOf(hasRecords, uncoveredElapsedMinutes) {
  if (!hasRecords) return "zero";
  if (uncoveredElapsedMinutes != null && uncoveredElapsedMinutes <= 1 / 60) return "full";
  return "partial";
}
// Full detail-week computation mirroring getDashboard's detail math.
function detailFor(win, entries, nowMs) {
  const clipped = [];
  const perCat = new Map();
  let categorySum = 0;
  for (const e of entries) {
    const c = clip(e, win.startMs, win.endMs);
    if (!c) continue;
    clipped.push(c);
    const mins = (c.endMs - c.startMs) / 60_000;
    perCat.set(e.category, (perCat.get(e.category) ?? 0) + mins);
    categorySum += mins;
  }
  const coverage = unionMinutes(clipped);
  const elapsedEnd = Math.min(nowMs, win.endMs);
  const elapsedStarted = nowMs >= win.startMs;
  const uncoveredElapsedMinutes = elapsedStarted
    ? Math.max(
        0,
        (elapsedEnd - win.startMs) / 60_000 -
          unionMinutes(
            entries
              .map((e) => clip(e, win.startMs, elapsedEnd))
              .filter((c) => c !== null),
          ),
      )
    : null;
  const notYetMinutes = Math.max(
    0,
    (win.endMs - Math.max(nowMs, win.startMs)) / 60_000,
  );
  return {
    coverageMinutes: coverage,
    categorySumMinutes: categorySum,
    overlapMinutes: Math.max(0, categorySum - coverage),
    byCategory: perCat,
    hasRecords: clipped.length > 0,
    uncoveredElapsedMinutes,
    notYetMinutes,
    state: coverageStateOf(clipped.length > 0, uncoveredElapsedMinutes),
  };
}

// ------------------------------------------------------------ A. 口径断言
const H = 3_600_000;

// A1. 普通周：2026-10-21（周三）所在周 = 10月19日–25日，168 小时。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  eq("A1 普通周 startLabel", win.startLabel, "2026-10-19");
  eq("A1 普通周 endLabel", win.endLabel, "2026-10-25");
  eq("A1 普通周 totalHours", win.totalHours, 168);
}
// A2. 春季 DST 周：2026-03-08 凌晨拨快，3月2日–8日这一周 = 167 小时。
{
  const win = weekWindowContaining(Date.UTC(2026, 2, 4, 12));
  eq("A2 春季DST周 startLabel", win.startLabel, "2026-03-02");
  eq("A2 春季DST周 endLabel", win.endLabel, "2026-03-08");
  eq("A2 春季DST周 totalHours", win.totalHours, 167);
}
// A3. 秋季 DST 周：2026-11-01 凌晨拨慢，10月26日–11月1日这一周 = 169 小时。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 28, 12));
  eq("A3 秋季DST周 startLabel", win.startLabel, "2026-10-26");
  eq("A3 秋季DST周 endLabel", win.endLabel, "2026-11-01");
  eq("A3 秋季DST周 totalHours", win.totalHours, 169);
}
// A4. 零记录：状态 zero、无记录、占比无分母（categorySum = 0）。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const now = win.startMs + 50 * H;
  const d = detailFor(win, [], now);
  eq("A4 零记录 state", d.state, "zero");
  eq("A4 零记录 hasRecords", d.hasRecords, false);
  eq("A4 零记录 coverage", d.coverageMinutes, 0);
  eq("A4 零记录 categorySum", d.categorySumMinutes, 0);
  approx("A4 零记录 uncovered = 已过时长", d.uncoveredElapsedMinutes, 50 * 60);
  approx("A4 零记录 notYet", d.notYetMinutes, (168 - 50) * 60);
}
// A5. 部分覆盖：一笔 2 小时记录，未覆盖与尚未到来同屏两值都在。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const now = win.startMs + 50 * H;
  const entries = [
    { category: "工作", startMs: win.startMs + 10 * H, endMs: win.startMs + 12 * H },
  ];
  const d = detailFor(win, entries, now);
  eq("A5 部分覆盖 state", d.state, "partial");
  approx("A5 部分覆盖 coverage", d.coverageMinutes, 120);
  approx("A5 部分覆盖 uncovered", d.uncoveredElapsedMinutes, (50 - 2) * 60);
  approx("A5 部分覆盖 notYet", d.notYetMinutes, (168 - 50) * 60);
  eq("A5 部分覆盖 overlap", d.overlapMinutes, 0);
  // 占比分母 = 已记录分类总和（120），不是整周（168*60）。
  const share = (d.byCategory.get("工作") ?? 0) / d.categorySumMinutes;
  approx("A5 占比以已记录为分母", share, 1);
}
// A6. 重叠：两笔跨分类重叠 1 小时 → 并集 180、分类和 240、重叠 60，
//     占比仍以分类和（已记录）为分母。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const now = win.startMs + 50 * H;
  const entries = [
    { category: "工作", startMs: win.startMs + 10 * H, endMs: win.startMs + 12 * H },
    { category: "学习", startMs: win.startMs + 11 * H, endMs: win.startMs + 13 * H },
  ];
  const d = detailFor(win, entries, now);
  approx("A6 重叠 coverage(并集)", d.coverageMinutes, 180);
  approx("A6 重叠 categorySum", d.categorySumMinutes, 240);
  approx("A6 重叠 overlapMinutes", d.overlapMinutes, 60);
  approx("A6 重叠 工作占比", (d.byCategory.get("工作") ?? 0) / d.categorySumMinutes, 0.5);
  eq("A6 重叠 state", d.state, "partial");
}
// A7. 完整覆盖：记录覆盖截至当前已过去的全部时间 → full，未覆盖 = 0，
//     尚未到来仍独立存在（不算未记录）。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const now = win.startMs + 30 * H;
  const entries = [
    { category: "休息睡眠", startMs: win.startMs, endMs: win.startMs + 30 * H },
  ];
  const d = detailFor(win, entries, now);
  eq("A7 完整覆盖 state", d.state, "full");
  approx("A7 完整覆盖 uncovered", d.uncoveredElapsedMinutes, 0);
  approx("A7 完整覆盖 notYet 仍在", d.notYetMinutes, (168 - 30) * 60);
}
// A8. 已结束的整周全覆盖 → full；差 1 分钟 → partial（边界）。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 14, 12)); // 上一周
  const after = win.endMs + 24 * H;
  const full = detailFor(
    win,
    [{ category: "工作", startMs: win.startMs, endMs: win.endMs }],
    after,
  );
  eq("A8 整周全覆盖 state", full.state, "full");
  approx("A8 整周全覆盖 notYet", full.notYetMinutes, 0);
  const almost = detailFor(
    win,
    [{ category: "工作", startMs: win.startMs, endMs: win.endMs - 60_000 }],
    after,
  );
  eq("A8 差1分钟 state", almost.state, "partial");
  approx("A8 差1分钟 uncovered", almost.uncoveredElapsedMinutes, 1);
}
// A9. 跨周区间：一笔从上周日 22:00 到本周一 02:00（LA）的记录，两周各裁 2 小时。
{
  const thisWin = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const prevWin = weekWindowContaining(thisWin.startMs - 1);
  const entry = {
    category: "休息睡眠",
    startMs: thisWin.startMs - 2 * H,
    endMs: thisWin.startMs + 2 * H,
  };
  const dThis = detailFor(thisWin, [entry], thisWin.startMs + 50 * H);
  const dPrev = detailFor(prevWin, [entry], prevWin.endMs + H);
  approx("A9 跨周 本周裁剪", dThis.coverageMinutes, 120);
  approx("A9 跨周 上周裁剪", dPrev.coverageMinutes, 120);
}
// A10. 跨 DST 的区间时长按真实时钟算：春季拨快日 01:00–04:00（LA）= 2 小时真实时长。
{
  // 2026-03-08 02:00 跳到 03:00。01:00 PST = 09:00Z，04:00 PDT = 11:00Z。
  const start = Date.UTC(2026, 2, 8, 9);
  const end = Date.UTC(2026, 2, 8, 11);
  eq("A10 DST区间真实时长(分钟)", unionMinutes([{ startMs: start, endMs: end }]), 120);
}
// A11. 未来周（尚未开始）：未覆盖为 null（未知，不是 0），状态按无记录走 zero。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const futureWin = weekWindowContaining(win.endMs + 7 * 24 * H);
  const d = detailFor(futureWin, [], win.startMs + 10 * H);
  eq("A11 未来周 uncovered 为 null", d.uncoveredElapsedMinutes, null);
  approx("A11 未来周 notYet = 整周", d.notYetMinutes, futureWin.totalHours * 60);
}
// A12. 分类过滤只是呈现层：过滤不改变 coverage / categorySum / overlap。
{
  const win = weekWindowContaining(Date.UTC(2026, 9, 21, 12));
  const now = win.startMs + 50 * H;
  const entries = [
    { category: "工作", startMs: win.startMs + 1 * H, endMs: win.startMs + 3 * H },
    { category: "学习", startMs: win.startMs + 5 * H, endMs: win.startMs + 6 * H },
  ];
  const d = detailFor(win, entries, now);
  const filteredList = entries.filter((e) => e.category === "工作");
  eq("A12 过滤后列表条数", filteredList.length, 1);
  approx("A12 过滤不改 coverage", d.coverageMinutes, 180);
  approx("A12 过滤不改 categorySum", d.categorySumMinutes, 180);
}

// ------------------------------------------------------------ B. 呈现断言
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, "client/src/App.tsx"), "utf8");

const MUST_CONTAIN = [
  ["B1 零记录首屏文案", "本周还没有时间记录"],
  ["B2 零记录不等于没训练/没陪伴", "不等于没有训练、没有陪伴"],
  ["B3 零记录分类占比文案", "暂无可计算记录"],
  ["B4 主按钮 补记一段", "补记一段"],
  ["B5 部分覆盖标签", "部分覆盖"],
  ["B6 覆盖大数字为已记录时长唯一文字之家（B3D 口径）", "{fmtHours(summary.coverageMinutes)}"],
  ["B7 占比标注 占已记录时间", "占已记录时间"],
  ["B8 完整覆盖标签", "已完整覆盖"],
  ["B9 过滤中标注", "过滤中"],
  ["B10 一键回到全部", "回到全部"],
  ["B11 下一步 检查未覆盖时段", "检查未覆盖时段"],
  ["B12 下一步 查看本周记录", "查看本周记录"],
  ["B13 自述重点标题", "我本周想重视什么"],
  ["B14 时区标注 America/Los_Angeles", "America/Los_Angeles"],
  ["B15 状态符号 ○/◐/● 并用", "◐ 部分覆盖"],
  ["B16 未覆盖区块锚点", 'id="uncovered-block"'],
  ["B17 记录列表锚点", 'id="week-entries"'],
  ["B18 录入表单锚点（复用现有录入）", 'id="entry-form"'],
];
for (const [name, needle] of MUST_CONTAIN) {
  check(name, appSrc.includes(needle));
}
const MUST_NOT_CONTAIN = [
  ["B25 副行不得重复已记录时长（B3D 去重）", "已记录 {fmtHours(summary.coverageMinutes)}"],
  ["B19 无跨 app 本周表现总分", "表现总分"],
  ["B20 无自动同步训练/陪伴进账本的文案", "自动同步"],
  ["B21 无财务评语引用", "财务"],
];
for (const [name, needle] of MUST_NOT_CONTAIN) {
  check(name, !appSrc.includes(needle));
}
// B22: 补记草稿锚定所选周（draftForWeek 存在且被调用），且不整天预填：
// 草稿窗口恒为 1 小时（3_600_000），源码里不得出现 24 小时整天草稿。
check("B22 补记草稿锚定所选周", appSrc.includes("draftForWeek"));
check(
  "B23 草稿不预填整天",
  !/startMs \+ 24 \* 3_600_000/.test(appSrc) && !/24 \* 3_600_000/.test(appSrc),
);
check(
  "B24 分类过滤只作用于 entries 列表",
  appSrc.includes("detail.entries.filter((e) => e.category === categoryFilter)"),
);

// ------------------------------------------------------------ report
const total = passed + failed;
console.log(`validate-time-review: ${passed}/${total} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
