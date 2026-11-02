// F3.4 validation: the FIRE tab's 「目标情景试算 What-if」 panel.
// Behaviour runs against the REAL production helpers extracted
// from client/src/App.tsx (type annotations stripped
// mechanically, same pattern as validate-design-b1a); wiring
// assertions run against the real client + theme sources.
// All fixtures are synthetic round numbers — no real amount is
// read, app.db is never touched, and the panel itself is pure
// UI state (no action call, no storage) by construction.
//
// Calibers under test (existing formulas, not new ones):
// - emergency coverage = available cash ÷ monthly spend
//   (F1.1), target shortfall filled linearly per month;
// - FIRE years = the F1.3 fireYearsEstimate expression (ceil
//   of gap ÷ annual contribution, annual = monthly × 12) —
//   asserted EQUAL to the extracted fireYearsEstimate over a
//   synthetic matrix;
// - down payment = target ÷ monthly contribution from zero.
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

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
function loadFns(extra = {}) {
  const parts = [
    extractFn(appSrc, "fireYearsEstimate", [["fire: Dashboard[\"fire\"]", "fire"]]),
    extractFn(appSrc, "whatIfMonthsForShortfall"),
    extra.whatIfEstimates ?? extractFn(appSrc, "whatIfEstimates", [["facts: WhatIfFacts", "facts"], ["inputs: WhatIfInputs", "inputs"], [": WhatIfEstimates", ""]]),
    extractFn(appSrc, "whatIfDateLabel", [["now: Date", "now"], ["estimate: WhatIfGoalEstimate", "estimate"]]),
    extra.whatIfDeltaLabel ?? extractFn(appSrc, "whatIfDeltaLabel"),
    extractFn(appSrc, "parseWhatIfInput"),
  ];
  return new Function(`${parts.join("\n")}; return { fireYearsEstimate, whatIfMonthsForShortfall, whatIfEstimates, whatIfDateLabel, whatIfDeltaLabel, parseWhatIfInput };`)();
}
const H = loadFns();

// --- parseWhatIfInput: blank / junk / negative is "not set" ---
check("parse: blank -> null (never coerced to 0)", H.parseWhatIfInput("") === null && H.parseWhatIfInput("   ") === null);
check("parse: non-numeric -> null", H.parseWhatIfInput("abc") === null);
check("parse: negative -> null", H.parseWhatIfInput("-1") === null);
check("parse: thousands comma accepted", H.parseWhatIfInput("1,200") === 1200);
check("parse: true zero stays 0", H.parseWhatIfInput("0") === 0);
check("parse: decimal kept", H.parseWhatIfInput("250.5") === 250.5);

// --- whatIfMonthsForShortfall: linear ceil pace ---
check("shortfall: covered or negative -> 0", H.whatIfMonthsForShortfall(0, 100) === 0 && H.whatIfMonthsForShortfall(-5, 100) === 0);
check("shortfall: exact division", H.whatIfMonthsForShortfall(300, 100) === 3);
check("shortfall: ceil rounds up", H.whatIfMonthsForShortfall(101, 100) === 2);
check("shortfall: zero pace -> null (no fabricated figure)", H.whatIfMonthsForShortfall(100, 0) === null);
check("shortfall: unknown pace -> null", H.whatIfMonthsForShortfall(100, null) === null);

// --- compute: synthetic baseline vs adjusted ---
const facts = { availableCash: 30000, firePrincipal: 250000 };
const baseInputs = { monthlySpend: 5000, monthlyContribution: 10000, emergencyTarget: 60000, fireTarget: 1000000, downPaymentTarget: 240000 };
const base = H.whatIfEstimates(facts, baseInputs);
check("emergency: coverage = cash / spend (F1.1)", base.emergency.coverageMonths === 6);
check("emergency: months = ceil(shortfall / monthly pace)", base.emergency.months === 3 && base.emergency.reached === false && base.emergency.blockedReason === null);
check("fire: years = ceil(gap / (monthly x 12))", base.fire.years === 7 && base.fire.months === 84);
check("down payment: months = ceil(target / monthly pace) from zero", base.downPayment.months === 24);

const adjusted = H.whatIfEstimates(facts, { ...baseInputs, monthlySpend: 4000, monthlyContribution: 20000 });
check("adjusted emergency: lower spend raises coverage months", adjusted.emergency.coverageMonths === 7.5);
check("adjusted emergency: higher pace shortens months", adjusted.emergency.months === 2);
check("adjusted fire: higher pace shortens years", adjusted.fire.years === 4 && adjusted.fire.months === 48);
check("adjusted down payment: higher pace shortens months", adjusted.downPayment.months === 12);

// --- FIRE caliber equivalence with the real F1.3 estimator ---
for (const [gap, annual] of [[750000, 120000], [100001, 12000], [120000, 60000], [1, 12000], [60000, 60000]]) {
  const viaPanel = H.whatIfEstimates({ availableCash: null, firePrincipal: 0 }, { monthlySpend: null, monthlyContribution: annual / 12, emergencyTarget: null, fireTarget: gap, downPaymentTarget: null });
  check(`fire caliber == fireYearsEstimate (gap ${gap}, annual ${annual})`,
    viaPanel.fire.years === H.fireYearsEstimate({ gap, annualContribution: annual }));
}
check("fire caliber: gap behind principal -> reached, like fireYearsEstimate gap <= 0",
  H.whatIfEstimates({ availableCash: null, firePrincipal: 100 }, { monthlySpend: null, monthlyContribution: 1000, emergencyTarget: null, fireTarget: 50, downPaymentTarget: null }).fire.years === 0
  && H.fireYearsEstimate({ gap: -50, annualContribution: 12000 }) === 0);
check("fire caliber: zero pace -> null, like fireYearsEstimate",
  H.whatIfEstimates({ availableCash: null, firePrincipal: 0 }, { monthlySpend: null, monthlyContribution: 0, emergencyTarget: null, fireTarget: 100, downPaymentTarget: null }).fire.years === null
  && H.fireYearsEstimate({ gap: 100, annualContribution: 0 }) === null);

// --- reached / blocked honesty ---
const rich = H.whatIfEstimates({ availableCash: 80000, firePrincipal: 250000 }, baseInputs);
check("emergency: cash above target -> reached at 0 months", rich.emergency.reached === true && rich.emergency.months === 0);
check("emergency: missing cash blocks with the F1.1 reason, never 0-filled",
  H.whatIfEstimates({ availableCash: null, firePrincipal: 0 }, baseInputs).emergency.months === null
  && H.whatIfEstimates({ availableCash: null, firePrincipal: 0 }, baseInputs).emergency.blockedReason.includes("可动用现金未提供"));
check("emergency: zero spend -> coverage null, months still paced",
  H.whatIfEstimates(facts, { ...baseInputs, monthlySpend: 0 }).emergency.coverageMonths === null
  && H.whatIfEstimates(facts, { ...baseInputs, monthlySpend: 0 }).emergency.months === 3);
check("unset targets block by name, each goal separately",
  H.whatIfEstimates(facts, { ...baseInputs, emergencyTarget: null }).emergency.blockedReason === "未设定应急金目标金额"
  && H.whatIfEstimates(facts, { ...baseInputs, fireTarget: null }).fire.blockedReason === "未设定 FIRE 目标金额"
  && H.whatIfEstimates(facts, { ...baseInputs, downPaymentTarget: null }).downPayment.blockedReason === "未设定购房首付目标金额");
check("zero pace blocks all three paced goals with a stated reason",
  (() => { const r = H.whatIfEstimates(facts, { ...baseInputs, monthlyContribution: 0 }); return r.emergency.months === null && r.fire.months === null && r.downPayment.months === null && r.fire.blockedReason != null; })());

// --- date labels (counted from the as-of month) ---
const now = new Date(2026, 10, 2); // 2026-11-02 local
check("date: 3 months out", H.whatIfDateLabel(now, base.emergency) === "2027 年 2 月");
check("date: fire 84 months out", H.whatIfDateLabel(now, base.fire) === "2033 年 11 月");
check("date: year rollover", H.whatIfDateLabel(new Date(2026, 11, 15), { months: 2, reached: false, blockedReason: null }) === "2027 年 2 月");
check("date: reached reads 已达标", H.whatIfDateLabel(now, rich.emergency) === "已达标");
check("date: unestimable reads 无法估算 (no fabricated date)",
  H.whatIfDateLabel(now, { months: null, reached: false, blockedReason: "x" }) === "无法估算");

// --- delta labels: glyph + word + number, never colour alone ---
check("delta: earlier -> ▲ 提前 N 个月", H.whatIfDeltaLabel(3, 2) === "▲ 提前 1 个月" && H.whatIfDeltaLabel(84, 48) === "▲ 提前 36 个月");
check("delta: later -> ▼ 延后 N 个月", H.whatIfDeltaLabel(4, 10) === "▼ 延后 6 个月");
check("delta: equal -> ● 无变化 with the 0 count", H.whatIfDeltaLabel(10, 10) === "● 无变化（相差 0 个月）");
check("delta: either side unestimable -> — 无法比较", H.whatIfDeltaLabel(null, 5).startsWith("—") && H.whatIfDeltaLabel(5, null).includes("无法比较"));

// --- mutation sensitivity: each mutation must flip a real
// assertion above (the mutated source is re-evaluated and its
// output compared against the production function's). ---
const monthsSrc = extractFn(appSrc, "whatIfMonthsForShortfall");
check("mutation M1 present in production source (Math.ceil pace)", monthsSrc.includes("Math.ceil(shortfall / monthlyContribution)"));
const floorMonths = new Function(`${monthsSrc.replace("Math.ceil", "Math.floor")}; return whatIfMonthsForShortfall;`)();
check("mutation M1: floor instead of ceil flips the ceil assertion",
  floorMonths(101, 100) === 1 && floorMonths(101, 100) !== H.whatIfMonthsForShortfall(101, 100));
const deltaSrc = extractFn(appSrc, "whatIfDeltaLabel");
const swappedDelta = new Function(`${deltaSrc.replaceAll("▲", "§").replaceAll("▼", "▲").replaceAll("§", "▼")}; return whatIfDeltaLabel;`)();
check("mutation M2: swapped ▲/▼ glyphs flip the delta assertions",
  swappedDelta(3, 2) === "▼ 提前 1 个月" && swappedDelta(3, 2) !== H.whatIfDeltaLabel(3, 2)
  && swappedDelta(4, 10) === "▲ 延后 6 个月");
const estimatesSrc = extractFn(appSrc, "whatIfEstimates", [["facts: WhatIfFacts", "facts"], ["inputs: WhatIfInputs", "inputs"], [": WhatIfEstimates", ""]]);
check("mutation M3 present in production source (annual = monthly x 12)", estimatesSrc.includes("inputs.monthlyContribution * 12"));
const noAnnual = loadFns({ whatIfEstimates: estimatesSrc.replace("(inputs.monthlyContribution * 12)", "inputs.monthlyContribution") });
check("mutation M3: dropping the x12 annualisation flips the FIRE years assertion",
  noAnnual.whatIfEstimates(facts, baseInputs).fire.years === 75 && noAnnual.whatIfEstimates(facts, baseInputs).fire.years !== base.fire.years);

// --- wiring: panel placement, purity, labels, touch targets ---
function sliceFn(name, next) {
  const start = appSrc.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`component not found: ${name}`);
  const end = appSrc.indexOf(`function ${next}`, start);
  return appSrc.slice(start, end < 0 ? undefined : end);
}
const fireTab = sliceFn("FireTab", "ArchDemoPreviewSection");
check("wiring: panel renders inside the FIRE tab, tab structure untouched",
  fireTab.includes("<WhatIfPanel") && fireTab.includes('id="fire-panel"') && !fireTab.includes("<details")
  && appSrc.includes('useState<"overview" | "fire" | "detail" | "trading">("overview")'));
const panel = sliceFn("WhatIfPanel", "FireProgress");
check("wiring: panel is pure UI state — no action call, no storage, no persistence",
  !panel.includes("api.") && !panel.includes("localStorage") && !panel.includes("sessionStorage") && panel.includes("useState"));
const goalBlock = sliceFn("WhatIfGoalBlock", "WhatIfPanel");
check("wiring: assumptions printed next to the results (F1.1 / F1.3 calibers + linear label)",
  panel.includes("F1.1 口径") && panel.includes("F1.3 口径一致") && panel.includes("线性估算，不含投资回报")
  && goalBlock.includes("whatif-assumption") && panel.includes("未在目标之间分配"));
check("wiring: panel outputs dates/months only — no advice wording anywhere in it",
  !panel.includes("建议") && !panel.includes("推荐") && !panel.includes("应该"));
check("wiring: five labelled inputs + reset, all five field keys present",
  ["monthlySpend", "monthlyContribution", "emergencyTarget", "fireTarget", "downPaymentTarget"].every((k) => appSrc.includes(`key: "${k}"`))
  && panel.includes("WHATIF_FIELDS.map") && panel.includes("恢复当前值") && panel.includes("目标情景试算（What-if）"));
const whatifCss = css.slice(css.indexOf(".whatif {"));
check("wiring: touch targets >= 44px for the what-if inputs and reset button",
  whatifCss.includes(".whatif-field input") && whatifCss.includes(".whatif-reset")
  && (whatifCss.match(/min-height: 44px/g) ?? []).length >= 2);
check("wiring: no server/schema surface added for F3.4 (client-only feature)",
  !readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8").includes("WhatIf"));

console.log(`validate-whatif: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
