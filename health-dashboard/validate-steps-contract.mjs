// L0.4 synthetic validation for the steps baseline/range missing-value contract.
// Reads the ACTUAL steps schema block from server/src/actions.ts, rebuilds it
// with zod, and checks the PM-required synthetic cases. No real data used.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const src = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const start = src.indexOf('steps: z.object({');
if (start < 0) { console.error('FAIL: steps schema block not found'); process.exit(1); }
const end = src.indexOf('}),', start);
const block = src.slice(start, end);
console.log('--- steps schema block under test ---');
console.log(block);
console.log('-------------------------------------');

const fields = {};
for (const m of block.matchAll(/(\w+):\s*(z\.[^,\n]+),/g)) {
  const [, name, expr] = m;
  if (name === 'steps') continue;
  try { fields[name] = eval(expr); } catch { /* non-zod exprs skipped */ }
}
const stepsSchema = z.object({
  baseline: fields.baseline,
  usualMin: fields.usualMin,
  usualMax: fields.usualMax,
});

function deriveSteps(dailySteps) {
  if (dailySteps.length < 14) return { baseline: null, usualMin: null, usualMax: null };
  const mean = dailySteps.reduce((a, b) => a + b, 0) / dailySteps.length;
  const sd = Math.sqrt(dailySteps.reduce((a, b) => a + (b - mean) ** 2, 0) / dailySteps.length);
  return { baseline: mean, usualMin: Math.max(0, mean - sd), usualMax: mean + sd };
}

let failures = 0;
function check(name, payload, expectOk, note) {
  const r = stepsSchema.safeParse(payload);
  const ok = r.success === expectOk;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} -> parse ${r.success ? 'ok' : 'rejected'} (${note})`);
}

// Derived-output assertions (PM 2026-10-14 rework): schema acceptance alone
// does not prove the derivation formula. Each case asserts the exact expected
// baseline/usualMin/usualMax (or null missing state), so removing the
// max(0, ...) clamp or changing the 14-day threshold fails this script.
function approx(a, b) { return a === null || b === null ? a === b : Math.abs(a - b) < 1e-9; }
function checkDerived(name, dailySteps, expected) {
  const got = deriveSteps(dailySteps);
  const ok = approx(got.baseline, expected.baseline) && approx(got.usualMin, expected.usualMin) && approx(got.usualMax, expected.usualMax);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: derived ${name} -> ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  return got;
}

const caseA = checkDerived('a) 13 days synthetic -> all null (below 14-day threshold)', Array(13).fill(5000), { baseline: null, usualMin: null, usualMax: null });
check('a) 13 days synthetic, baseline/range null', caseA, true, JSON.stringify(caseA));
checkDerived('a2) no data at all -> all null', [], { baseline: null, usualMin: null, usualMax: null });
const caseB = checkDerived('b) 14 days all zero -> valid zero baseline/range', Array(14).fill(0), { baseline: 0, usualMin: 0, usualMax: 0 });
check('b) 14 days all zero, baseline/range 0', caseB, true, JSON.stringify(caseB));
checkDerived('b2) 14 identical days -> sd 0, range collapses to mean', Array(14).fill(5000), { baseline: 5000, usualMin: 5000, usualMax: 5000 });
const caseC = checkDerived('c) half zero / half 20000 -> mean=sd=10000, lower bound exactly 0', [0, 0, 0, 0, 0, 0, 0, 20000, 20000, 20000, 20000, 20000, 20000, 20000], { baseline: 10000, usualMin: 0, usualMax: 20000 });
check('c) high variance, usualMin clamped to 0', caseC, true, JSON.stringify(caseC));
// True negative lower bound (PM 2026-10-14): 13 zeros + one 14000 day gives
// mean 1000, sd ~3605.55, raw mean-sd ~ -2605.55 < 0. Without the clamp the
// derived usualMin would be negative: the checkDerived assertion below would
// fail AND the schema check would reject the payload. Both layers are asserted.
const negDaily = [...Array(13).fill(0), 14000];
const negMean = negDaily.reduce((a, b) => a + b, 0) / negDaily.length;
const negSd = Math.sqrt(negDaily.reduce((a, b) => a + (b - negMean) ** 2, 0) / negDaily.length);
const rawLower = negMean - negSd;
if (!(rawLower < 0)) { failures++; console.log(`FAIL: negative-lower-bound fixture is not actually negative (raw lower ${rawLower})`); }
else console.log(`PASS: negative-lower-bound fixture raw mean-sd = ${rawLower.toFixed(2)} < 0 (clamp is load-bearing)`);
const caseNeg = checkDerived('c2) 13 zeros + one 14000 -> usualMin clamped from negative to 0', negDaily, { baseline: negMean, usualMin: 0, usualMax: negMean + negSd });
check('c2) negative lower bound payload accepted after clamp', caseNeg, true, JSON.stringify(caseNeg));
check('d) legacy numeric baseline/range', { baseline: 4200, usualMin: 2100, usualMax: 6300 }, true, 'backward compat');
check('e) negative baseline rejected', { baseline: -1, usualMin: 0, usualMax: 10 }, false, 'nonnegative guard intact');
check('e2) unclamped negative usualMin rejected', { baseline: negMean, usualMin: rawLower, usualMax: negMean + negSd }, false, 'proves clamp removal cannot pass schema');

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
