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

const caseA = deriveSteps(Array(13).fill(5000));
check('a) 13 days synthetic, baseline/range null', caseA, true, JSON.stringify(caseA));
const caseB = deriveSteps(Array(14).fill(0));
check('b) 14 days all zero, baseline/range 0', caseB, true, JSON.stringify(caseB));
const caseC = deriveSteps([0, 0, 0, 0, 0, 0, 0, 20000, 20000, 20000, 20000, 20000, 20000, 20000]);
check('c) high variance, usualMin clamped to 0', caseC, true, JSON.stringify(caseC));
check('d) legacy numeric baseline/range', { baseline: 4200, usualMin: 2100, usualMax: 6300 }, true, 'backward compat');
check('e) negative baseline rejected', { baseline: -1, usualMin: 0, usualMax: 10 }, false, 'nonnegative guard intact');

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
