// L0.4 synthetic validation for the steps display/status boundary (client).
// Extracts the ACTUAL stepsBaselineIncomplete / stepSummary / stepStatus
// expressions from client/src/App.tsx and evaluates them against synthetic
// snapshot inputs, asserting the expected homepage summary text and KPI chip.
// Pure Node, no dependencies, no real data. PM 2026-10-14 rework: a present
// step value with a missing baseline must never render as "in usual range",
// "low/high", or "not recorded"; a valid zero baseline must render normally.
// 2026-10-14 L0.4 rework (PM review of 7d848b7): App.tsx renamed
// stepsBaselineMissing -> stepsBaselineIncomplete and widened it to also
// treat a present value whose server status is "数据缺失" as incomplete;
// this script follows the rename and covers that widened case.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
function grab(name) {
  const m = src.match(new RegExp(`const ${name}(?:: [^=]+)? = ([^;]+);`));
  if (!m) { console.error(`FAIL: expression not found: ${name}`); process.exit(1); }
  return m[1];
}
const baselineExpr = grab('stepsBaselineIncomplete');
const summaryExpr = grab('stepSummary');
const statusExpr = grab('stepStatus');

function evaluate(steps) {
  const snapshot = { steps };
  const stepsBaselineIncomplete = eval(baselineExpr);
  const stepSummary = eval(summaryExpr);
  const stepStatus = eval(statusExpr);
  return { stepSummary, stepStatus };
}

const cases = [
  // [synthetic steps, expected summary, expected KPI chip]
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '正常' }, '基线不足，无法比较', '基线不足'],
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '数据缺失' }, '基线不足，无法比较', '基线不足'],
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '偏低' }, '基线不足，无法比较', '基线不足'],
  // Widened stepsBaselineIncomplete: complete baseline but server status
  // still "数据缺失" with a present value -> treated as incomplete.
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '数据缺失' }, '基线不足，无法比较', '基线不足'],
  [{ value: null, baseline: null, usualMin: null, usualMax: null, status: '数据缺失' }, '步数未记录', '数据缺失'],
  [{ value: 0, baseline: 0, usualMin: 0, usualMax: 0, status: '正常' }, '步数在常见范围', '正常'],
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '偏低' }, '步数偏低', '偏低'],
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '正常' }, '步数在常见范围', '正常'],
];

let failures = 0;
for (const [steps, wantSummary, wantStatus] of cases) {
  const got = evaluate(steps);
  try {
    assert.strictEqual(got.stepSummary, wantSummary);
    assert.strictEqual(got.stepStatus, wantStatus);
    console.log(`PASS: value=${steps.value} baseline=${steps.baseline} status=${steps.status} -> "${got.stepSummary}" / chip "${got.stepStatus}"`);
  } catch {
    failures++;
    console.log(`FAIL: value=${steps.value} baseline=${steps.baseline} status=${steps.status} -> "${got.stepSummary}" / chip "${got.stepStatus}" (expected "${wantSummary}" / "${wantStatus}")`);
  }
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
