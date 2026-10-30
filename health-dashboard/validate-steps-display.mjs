// L0.4 synthetic validation for the steps display/status boundary (client).
// Extracts the ACTUAL stepsBaselineIncomplete / stepStatus expressions and
// the steps Kpi's `detail` prop expression from client/src/App.tsx and
// evaluates them against synthetic snapshot inputs, asserting the expected
// KPI detail text and chip. Pure Node, no dependencies, no real data.
// PM 2026-10-14 rework: a present step value with a missing baseline must
// never render as "in usual range", "low/high", or "not recorded"; a valid
// zero baseline must render normally.
// 2026-10-14 L0.4 rework (PM review of 7d848b7): App.tsx renamed
// stepsBaselineMissing -> stepsBaselineIncomplete and widened it to also
// treat a present value whose server status is "数据缺失" as incomplete;
// this script follows the rename and covers that widened case.
// H-UI-002 (2026-10-23, changes.md 2026-10-23 21:13 round): the standalone
// 昨日概览 verdict section and its `stepSummary` text expression were
// deleted; the KPI board is now the sole rendering of yesterday's metrics.
// This script follows the migration: it asserts `stepSummary` is gone and
// evaluates the steps Kpi's `detail` prop expression instead.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { stripTypeScriptTypes } from 'node:module';

const src = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

// Guard: the old summary expression must not silently reappear — the KPI
// board is the sole rendering of yesterday's steps.
assert.ok(!src.match(/const stepSummary\s*=/), 'stepSummary should not exist in source');

function grab(name) {
  const m = src.match(new RegExp(`const ${name}(?:: [^=]+)? = ([^;]+);`));
  if (!m) { console.error(`FAIL: expression not found: ${name}`); process.exit(1); }
  return m[1];
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function grabKpiDetail() {
  const kpi = src.indexOf('<Kpi label="步数"');
  if (kpi < 0) { console.error('FAIL: steps Kpi not found'); process.exit(1); }
  const d = src.indexOf('detail={', kpi);
  if (d < 0) { console.error('FAIL: steps Kpi detail prop not found'); process.exit(1); }
  const open = src.indexOf('{', d);
  const close = matchDelim(src, open, '{', '}');
  if (src.indexOf('status={stepStatus}', kpi) < 0 || src.indexOf('status={stepStatus}', kpi) > kpi + 2000) {
    console.error('FAIL: steps Kpi not wired to stepStatus'); process.exit(1);
  }
  return src.slice(open + 1, close);
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) { console.error(`FAIL: function not found: ${name}`); process.exit(1); }
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

const baselineExpr = grab('stepsBaselineIncomplete');
const detailExpr = grabKpiDetail();
const statusExpr = grab('stepStatus');
// The detail expression calls numberLabel: bring the real function along.
const numberLabelCode = stripTypeScriptTypes(extractFunction(src, 'numberLabel'));
const detailFn = new Function('snapshot', `${numberLabelCode}\nreturn (${detailExpr});`);

function evaluate(steps) {
  const snapshot = { steps };
  const stepsBaselineIncomplete = eval(baselineExpr);
  const stepDetail = detailFn(snapshot);
  const stepStatus = eval(statusExpr);
  return { stepDetail, stepStatus };
}

const cases = [
  // [synthetic steps, expected KPI detail, expected KPI chip]
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '正常' }, '基线数据不足 · — km', '基线不足'],
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '数据缺失' }, '基线数据不足 · — km', '基线不足'],
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '偏低' }, '基线数据不足 · — km', '基线不足'],
  // Widened stepsBaselineIncomplete: complete baseline but server status
  // still "数据缺失" with a present value -> treated as incomplete.
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '数据缺失' }, '基线约 4,200 · — km', '基线不足'],
  [{ value: null, baseline: null, usualMin: null, usualMax: null, status: '数据缺失' }, '基线数据不足 · — km', '数据缺失'],
  [{ value: 0, baseline: 0, usualMin: 0, usualMax: 0, status: '正常' }, '基线约 0 · — km', '正常'],
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '偏低' }, '基线约 4,200 · — km', '偏低'],
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '正常' }, '基线约 4,200 · — km', '正常'],
  // distanceKm interpolation on both detail branches.
  [{ value: 5000, baseline: null, usualMin: null, usualMax: null, status: '正常', distanceKm: 3.75 }, '基线数据不足 · 3.75 km', '基线不足'],
  [{ value: 5000, baseline: 4200, usualMin: 2100, usualMax: 6300, status: '正常', distanceKm: 3.75 }, '基线约 4,200 · 3.75 km', '正常'],
];

let failures = 0;
for (const [steps, wantDetail, wantStatus] of cases) {
  const got = evaluate(steps);
  try {
    assert.strictEqual(got.stepDetail, wantDetail);
    assert.strictEqual(got.stepStatus, wantStatus);
    console.log(`PASS: value=${steps.value} baseline=${steps.baseline} status=${steps.status} -> "${got.stepDetail}" / chip "${got.stepStatus}"`);
  } catch {
    failures++;
    console.log(`FAIL: value=${steps.value} baseline=${steps.baseline} status=${steps.status} -> "${got.stepDetail}" / chip "${got.stepStatus}" (expected "${wantDetail}" / "${wantStatus}")`);
  }
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
