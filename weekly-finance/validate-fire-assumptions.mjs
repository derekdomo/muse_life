// F1.3 P1 validation: the FIRE tab's 「FIRE 假设情景（保守 / 中性）」 panel.
// Behaviour runs against the REAL production helpers extracted
// from client/src/App.tsx (type annotations stripped
// mechanically, same pattern as validate-design-b1a /
// validate-whatif); wiring assertions run against the real
// client + theme sources. All fixtures are synthetic round
// numbers — no real amount is read, app.db is never touched,
// and the panel itself is pure UI state (no action call, no
// storage) by construction.
//
// Caliber under test (existing formula, not a new one):
// - FIRE years = the F1.3 fireYearsEstimate expression (ceil of
//   gap ÷ assumed annual contribution), asserted EQUAL to the
//   extracted fireYearsEstimate over a synthetic matrix;
// - assumed annual = round(current annual × editable
//   coefficient, cents); neutral defaults to 1.00, conservative
//   to 0.80;
// - honest blocks: blank coefficient / zero pace / no complete
//   months never fabricate a figure.
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
    extractFn(appSrc, "parseWhatIfInput"),
    extractFn(appSrc, "whatIfDateLabel", [["now: Date", "now"], ["estimate: WhatIfGoalEstimate", "estimate"]]),
    extractFn(appSrc, "fireAssumptionDefault", [["key: FireAssumptionKey", "key"]]),
    extractFn(appSrc, "fireAssumptionLabel", [["key: FireAssumptionKey", "key"]]),
    extra.fireAssumptionScenarios ?? extractFn(appSrc, "fireAssumptionScenarios", [
      ["fire: Dashboard[\"fire\"]", "fire"],
      ["coefficients: Record<FireAssumptionKey, number | null>", "coefficients"],
      ["): Array<FireAssumptionScenario>", ")"],
      ["const order: Array<FireAssumptionKey>", "const order"],
    ]),
  ];
  return new Function(`${parts.join("\n")}; return { fireYearsEstimate, parseWhatIfInput, whatIfDateLabel, fireAssumptionDefault, fireAssumptionLabel, fireAssumptionScenarios };`)();
}
const H = loadFns();

// --- defaults & labels ---
check("default: neutral = 1.00", H.fireAssumptionDefault("neutral") === 1);
check("default: conservative = 0.80", H.fireAssumptionDefault("conservative") === 0.8);
check("label: 中性假设 / 保守假设", H.fireAssumptionLabel("neutral") === "中性假设" && H.fireAssumptionLabel("conservative") === "保守假设");

// --- caliber equivalence matrix: scenarios run the verbatim F1.3 expression ---
const matrix = [
  { gap: 1000000, annual: 100000, months: 12 },
  { gap: 0, annual: 100000, months: 12 },        // already reached
  { gap: 500000, annual: 0, months: 12 },        // zero pace -> null, never fabricated
  { gap: 999999, annual: 333333, months: 5 },
  { gap: 7700, annual: 11000, months: 12 },      // fp-dust guard fixture (see M3)
];
for (const m of matrix) {
  const fire = { gap: m.gap, annualContribution: m.annual, completeMonthsUsed: m.months };
  const [neutral, conservative] = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: 0.8 });
  const assumedN = Math.round(m.annual * 1 * 100) / 100;
  const assumedC = Math.round(m.annual * 0.8 * 100) / 100;
  check(`matrix gap=${m.gap} annual=${m.annual}: neutral === fireYearsEstimate(assumed ${assumedN})`,
    neutral.years === H.fireYearsEstimate({ ...fire, annualContribution: assumedN }));
  check(`matrix gap=${m.gap} annual=${m.annual}: conservative === fireYearsEstimate(assumed ${assumedC})`,
    conservative.years === H.fireYearsEstimate({ ...fire, annualContribution: assumedC }));
}

// --- neutral default reproduces the panel's own F1.3 figure ---
{
  const fire = { gap: 1000000, annualContribution: 100000, completeMonthsUsed: 12 };
  const [neutral] = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: null });
  check("neutral(1.00) reproduces the panel's own fireYearsEstimate", neutral.years === H.fireYearsEstimate(fire) && neutral.years === 10);
}

// --- conservative default shortens the pace honestly ---
{
  const fire = { gap: 1000000, annualContribution: 100000, completeMonthsUsed: 12 };
  const [, conservative] = H.fireAssumptionScenarios(fire, { neutral: null, conservative: 0.8 });
  check("conservative(0.80): assumed annual = 80000", conservative.assumedAnnual === 80000);
  check("conservative(0.80): years = ceil(1000000/80000) = 13", conservative.years === 13);
  check("conservative: no blocked reason when estimable", conservative.blockedReason === null);
}

// --- floating-point dust guard: exact division boundary stays exact ---
{
  const fire = { gap: 7700, annualContribution: 11000, completeMonthsUsed: 12 };
  const [neutral] = H.fireAssumptionScenarios(fire, { neutral: 0.7, conservative: null });
  check("fp guard: assumed annual rounds to exactly 7700", neutral.assumedAnnual === 7700);
  check("fp guard: years = 1 (raw 7699.999999999999 would give 2)", neutral.years === 1);
}

// --- honest blocks: nothing fabricated ---
{
  const fire = { gap: 1000000, annualContribution: 100000, completeMonthsUsed: 12 };
  const [neutral] = H.fireAssumptionScenarios(fire, { neutral: null, conservative: 0.8 });
  check("blank coefficient -> years null, assumed null", neutral.years === null && neutral.assumedAnnual === null);
  check("blank coefficient -> blocked reason 假设系数未填写", neutral.blockedReason === "假设系数未填写");
}
{
  const fire = { gap: 1000000, annualContribution: 100000, completeMonthsUsed: 0 };
  const [neutral] = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: 0.8 });
  check("no complete months -> 完整月份不足，暂不估算", neutral.blockedReason === "完整月份不足，暂不估算" && neutral.years === null);
}
{
  const fire = { gap: 1000000, annualContribution: 0, completeMonthsUsed: 12 };
  const [neutral] = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: 0.8 });
  check("zero pace -> 按该假设的投入节奏不足以估算达标时间", neutral.blockedReason === "按该假设的投入节奏不足以估算达标时间" && neutral.years === null);
}
{
  const fire = { gap: 0, annualContribution: 100000, completeMonthsUsed: 12 };
  const [neutral] = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: 0.8 });
  check("gap <= 0 -> years 0, no blocked reason", neutral.years === 0 && neutral.blockedReason === null);
}

// --- scenario order: neutral first, conservative second ---
{
  const fire = { gap: 1000000, annualContribution: 100000, completeMonthsUsed: 12 };
  const scenarios = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: 0.8 });
  check("order: [neutral, conservative]", scenarios[0].key === "neutral" && scenarios[1].key === "conservative");
}

// --- date label reuse (years -> months -> target date) ---
{
  const now = new Date(2026, 10, 3);
  check("date: 120 months from 2026-11 -> 2036 年 11 月",
    H.whatIfDateLabel(now, { months: 120, reached: false, blockedReason: null }) === "2036 年 11 月");
  check("date: reached -> 已达标",
    H.whatIfDateLabel(now, { months: 0, reached: true, blockedReason: null }) === "已达标");
  check("date: unestimable -> 无法估算",
    H.whatIfDateLabel(now, { months: null, reached: false, blockedReason: "x" }) === "无法估算");
}

// --- input parsing reuse: blank/junk/negative is "not set", never 0 ---
check("parse: blank -> null", H.parseWhatIfInput("") === null);
check("parse: negative -> null (never a negative pace)", H.parseWhatIfInput("-0.5") === null);
check("parse: 0.8 kept", H.parseWhatIfInput("0.8") === 0.8);

// --- mutations: real executions, flipped outputs recorded ---
{
  // M1: ceil -> floor in the F1.3 expression must flip a non-exact division
  const fire = { gap: 1000001, annualContribution: 100000, completeMonthsUsed: 12 };
  const before = H.fireAssumptionScenarios(fire, { neutral: 1, conservative: null })[0].years;
  const floorEstimate = new Function(
    `${extractFn(appSrc, "fireYearsEstimate", [["fire: Dashboard[\"fire\"]", "fire"]]).replace("export function", "function").replace("Math.ceil", "Math.floor")}; return fireYearsEstimate;`
  )();
  const after = floorEstimate({ ...fire, annualContribution: 100000 });
  console.log(`MUT M1 (ceil->floor in fireYearsEstimate): gap=1000001 annual=100000 -> before=${before} after=${after}`);
  check("M1: ceil->floor flips 11 -> 10", before === 11 && after === 10);
}
{
  // M2: conservative default 0.8 -> 1.2 must shrink the years
  const fire = { gap: 1000000, annualContribution: 100000, completeMonthsUsed: 12 };
  const before = H.fireAssumptionScenarios(fire, { neutral: null, conservative: 0.8 })[1].years;
  const mutatedDefault = new Function(
    `${extractFn(appSrc, "fireAssumptionDefault", [["key: FireAssumptionKey", "key"]]).replace("export function", "function").replace("0.8", "1.2")}; return fireAssumptionDefault;`
  )();
  const mutatedCoeff = mutatedDefault("conservative");
  const after = H.fireYearsEstimate({ ...fire, annualContribution: Math.round(fire.annualContribution * mutatedCoeff * 100) / 100 });
  console.log(`MUT M2 (conservative default 0.8->1.2): gap=1000000 annual=100000 -> before=${before} after=${after}`);
  check("M2: default 0.8->1.2 flips 13 -> 9", before === 13 && after === 9);
}
{
  // M3: removing the cents rounding must flip the fp-dust boundary case
  const fire = { gap: 7700, annualContribution: 11000, completeMonthsUsed: 12 };
  const before = H.fireAssumptionScenarios(fire, { neutral: 0.7, conservative: null })[0].years;
  const mutatedScenarios = new Function(
    `${extractFn(appSrc, "fireYearsEstimate", [["fire: Dashboard[\"fire\"]", "fire"]]).replace("export function", "function")}\n` +
    `${extractFn(appSrc, "fireAssumptionLabel", [["key: FireAssumptionKey", "key"]]).replace("export function", "function")}\n` +
    `${extractFn(appSrc, "fireAssumptionScenarios", [
      ["fire: Dashboard[\"fire\"]", "fire"],
      ["coefficients: Record<FireAssumptionKey, number | null>", "coefficients"],
      ["): Array<FireAssumptionScenario>", ")"],
      ["const order: Array<FireAssumptionKey>", "const order"],
    ]).replace("export function", "function").replace("Math.round(fire.annualContribution * coefficient * 100) / 100", "fire.annualContribution * coefficient")}; return fireAssumptionScenarios;`
  )();
  const after = mutatedScenarios(fire, { neutral: 0.7, conservative: null })[0].years;
  console.log(`MUT M3 (rounding removed): annual=11000 coeff=0.7 gap=7700 -> before=${before} after=${after}`);
  check("M3: rounding removal flips 1 -> 2 on the fp-dust boundary", before === 1 && after === 2);
}

// --- wiring: the panel exists, is mounted in the FIRE tab, copy + classes check out ---
check("wiring: FireAssumptionsPanel defined", appSrc.includes("function FireAssumptionsPanel"));
{
  const fireTabStart = appSrc.indexOf("function FireTab");
  const fireTabEnd = appSrc.indexOf("\n}\n", fireTabStart);
  const fireTab = appSrc.slice(fireTabStart, fireTabEnd);
  const iProgress = fireTab.indexOf("<FireProgress data={data} />");
  const iAssump = fireTab.indexOf("<FireAssumptionsPanel data={data} />");
  const iWhatIf = fireTab.indexOf("<WhatIfPanel data={data} spendBasis={spendBasis} />");
  check("wiring: mounted in FireTab directly under FireProgress, above WhatIfPanel",
    iProgress >= 0 && iAssump > iProgress && iWhatIf > iAssump);
}
{
  const panelStart = appSrc.indexOf("function FireAssumptionsPanel");
  const panelEnd = appSrc.indexOf("\n}\n", panelStart);
  const panel = appSrc.slice(panelStart, panelEnd);
  check("wiring: section aria-label FIRE 假设情景", panel.includes('aria-label="FIRE 假设情景"'));
  check("wiring: heading FIRE 假设情景（保守 / 中性）", panel.includes("FIRE 假设情景（保守 / 中性）"));
  check("wiring: every scenario carries 线性估算，不含投资回报", (panel.match(/线性估算，不含投资回报/g) || []).length >= 2);
  check("wiring: no advice wording （建议/推荐/应当/买入/卖出） in new code",
    !/建议|推荐|应当|买入|卖出/.test(panel + appSrc.slice(appSrc.indexOf("F1.3 P1: conservative"), appSrc.indexOf("// F3.4"))));
  check("wiring: pure UI state (useState, no localStorage/app.db/schema/action)",
    panel.includes("useState") && !/localStorage|app\.db|invoke_action|schema\./.test(panel));
  check("wiring: honest empty states never fabricate", panel.includes("假设系数未填写") || appSrc.includes("假设系数未填写"));
}
for (const cls of ["whatif", "whatif-note", "whatif-inputs", "whatif-field", "whatif-reset", "whatif-goals", "whatif-goal", "whatif-rows", "whatif-assumption"]) {
  check(`wiring: theme.css defines .${cls}`, css.includes(`.${cls}`));
}
check("wiring: 44px touch target on inputs (.whatif-field input)", /\.whatif-field input[^}]*min-height:\s*44px/.test(css));
check("wiring: 44px touch target on reset (.whatif-reset)", /\.whatif-reset[^}]*min-height:\s*44px/.test(css));

console.log(`\nvalidate-fire-assumptions: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
