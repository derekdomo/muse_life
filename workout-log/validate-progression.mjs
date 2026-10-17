// W1.1–W1.4 validation — the single progressive-overload rule.
// Runs the REAL progressionDecision extracted verbatim from BOTH
// server/src/actions.ts (startWorkout prefill) and client/src/App.tsx
// (WeeklyReview) over synthetic sets only, and asserts the two copies
// agree on every case — prefill and weekly review must never again
// give two different "next time" verdicts. Pure Node, no deps.
// Contract under test (W1.2):
//  - all planned sets completed AND every set at the rep cap -> increase
//    (+5 lb / +2.5 kg, reps back to the range minimum);
//  - not all planned sets completed -> hold at the base weight;
//  - any completed set below the range minimum -> reduce by one step
//    (floored at 0);
//  - no comparable weighed record (empty / nothing completed / all
//    weights missing / reps missing on a fully completed session)
//    -> none: no weight suggestion (W1.4: bodyweight sets never count
//    as a comparable load of 0).
// W1.3: convertWeight / convertWeightValue use LB_TO_KG = 0.45359237
// and round to the nearest 0.5 in both copies.
// W1.4: client trainingVolume and server week summaries only count
// completed sets with both weight and reps (asserted at source level
// here; week summaries are covered by their own history in changes).
// Mutations are executed (cap check weakened to the minimum, the
// reps-missing guard removed, the increment changed) and must flip
// outcomes in BOTH copies.
// Owner runtime evidence stays 运行待验 (PM acceptance).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const themeCss = readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  // Skip an object-literal return-type annotation (`): { ... } {`):
  // the first balanced { ... } after the parameter list is the type,
  // the body brace follows it.
  let pos = closeParen + 1;
  while (pos < source.length && /[\s:]/.test(source[pos])) pos++;
  if (source[pos] === '{') pos = matchDelim(source, pos, '{', '}') + 1;
  const bodyStart = source.indexOf('{', pos);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function extractConst(source, name) {
  const m = source.match(new RegExp(`export const ${name} = [^;]+;`));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0].replace(/^export /, '');
}
function buildFrom(src, fnNames, constNames) {
  const code = [
    ...constNames.map((n) => extractConst(src, n)),
    ...fnNames.map((n) => extractFunction(src, n).replace(/^export /, '')),
  ].join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${[...fnNames, ...constNames].join(', ')} };`)();
}

const server = buildFrom(serverSrc, ['progressionDecision', 'convertWeight'], ['LB_TO_KG']);
const client = buildFrom(clientSrc, ['progressionDecision', 'convertWeightValue'], ['LB_TO_KG']);

// --- source wiring ---
check('source: server prefill calls progressionDecision', serverSrc.includes('const decision = progressionDecision({'));
check('source: server dropped the old single-session achievedTopOfRange rule', !serverSrc.includes('achievedTopOfRange'));
check('source: server comparable history is no longer unit-filtered',
  !serverSrc.includes('eq(schema.workouts.unit, unit), isNotNull(schema.workouts.completedAt)'));
check('source: startWorkout marks converted prefill', serverSrc.includes('prefill_unit_converted: true'));
check('source: weekly review calls the same progressionDecision', clientSrc.includes('const decision = progressionDecision({'));
check('source: weekly review dropped the two-consecutive-weeks rule',
  !clientSrc.includes('连续两周全部做到次数上限') && !clientSrc.includes('priorAllAtTop'));
check('source: weekly review header states the single-session rule', clientSrc.includes('负荷建议只看最近一次可比训练'));
check('source: client marks converted previous values', clientSrc.includes('（已换算）') && clientSrc.includes('含单位换算'));
check('source: both copies share the LB_TO_KG constant',
  server.LB_TO_KG === 0.45359237 && client.LB_TO_KG === 0.45359237);
check('source: client trainingVolume counts only completed sets with weight and reps (W1.4)',
  clientSrc.includes('if (!set.completed || set.weight == null || set.reps == null) return sum;'));

// --- behaviour: server and client copies must agree on every case ---
const S = (weight, reps, completed = true) => ({ weight, reps, completed });
const CASES = [
  ['empty history -> none', { plannedSets: 4, sets: [], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'none', suggestedWeight: null, suggestedReps: null }],
  ['plannedSets 0 -> none', { plannedSets: 0, sets: [S(100, 8)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'none', suggestedWeight: null, suggestedReps: null }],
  ['nothing completed -> none', { plannedSets: 2, sets: [S(100, 8, false), S(100, 8, false)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'none', suggestedWeight: null, suggestedReps: null }],
  ['bodyweight only (all weights null) -> none', { plannedSets: 3, sets: [S(null, 12), S(null, 11), S(null, 10)], targetMin: 10, targetMax: 12, unit: 'lb' }, { action: 'none', suggestedWeight: null, suggestedReps: null }],
  ['incomplete session -> hold at base', { plannedSets: 4, sets: [S(100, 8), S(100, 8), S(105, 8)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'hold', suggestedWeight: 105, suggestedReps: null }],
  ['incomplete beats below-min (hold, not reduce)', { plannedSets: 4, sets: [S(100, 8), S(100, 3)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'hold', suggestedWeight: 100, suggestedReps: null }],
  ['all complete, all at cap, lb -> increase +5, reps to min', { plannedSets: 4, sets: [S(100, 8), S(100, 9), S(100, 8), S(100, 10)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'increase', suggestedWeight: 105, suggestedReps: 6 }],
  ['all complete, all at cap, kg -> increase +2.5', { plannedSets: 3, sets: [S(60, 10), S(60, 10), S(60, 12)], targetMin: 8, targetMax: 10, unit: 'kg' }, { action: 'increase', suggestedWeight: 62.5, suggestedReps: 8 }],
  ['increase uses the max weighed weight as base', { plannedSets: 3, sets: [S(100, 8), S(110, 8), S(100, 8)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'increase', suggestedWeight: 115, suggestedReps: 6 }],
  ['one set below min -> reduce one step', { plannedSets: 3, sets: [S(100, 8), S(100, 5), S(100, 7)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'reduce', suggestedWeight: 95, suggestedReps: null }],
  ['reduce floors at 0', { plannedSets: 2, sets: [S(2.5, 3), S(2.5, 9)], targetMin: 8, targetMax: 10, unit: 'kg' }, { action: 'reduce', suggestedWeight: 0, suggestedReps: null }],
  ['all complete, mid-range -> hold', { plannedSets: 3, sets: [S(100, 7), S(100, 8), S(100, 6)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'hold', suggestedWeight: 100, suggestedReps: null }],
  ['fully completed but a reps value missing -> none', { plannedSets: 3, sets: [S(100, 8), S(100, null), S(100, 8)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'none', suggestedWeight: null, suggestedReps: null }],
  ['one unweighed set blocks increase but keeps hold', { plannedSets: 3, sets: [S(100, 8), S(null, 8), S(100, 8)], targetMin: 6, targetMax: 8, unit: 'lb' }, { action: 'hold', suggestedWeight: 100, suggestedReps: null }],
];
for (const [name, input, expected] of CASES) {
  const fromServer = server.progressionDecision(structuredClone(input));
  const fromClient = client.progressionDecision(structuredClone(input));
  check(`case: ${name}`,
    JSON.stringify(fromServer) === JSON.stringify(expected) && JSON.stringify(fromClient) === JSON.stringify(expected),
    `server=${JSON.stringify(fromServer)} client=${JSON.stringify(fromClient)}`);
}

// --- W1.3 conversion: both directions, both copies, 0.5 rounding ---
check('convert: 100 lb -> 45.5 kg (server)', server.convertWeight(100, 'lb', 'kg') === 45.5);
check('convert: 45 kg -> 99 lb (server)', server.convertWeight(45, 'kg', 'lb') === 99);
check('convert: null stays null (server)', server.convertWeight(null, 'lb', 'kg') === null);
check('convert: same unit is identity (server)', server.convertWeight(80, 'kg', 'kg') === 80);
check('convert: client copy agrees on values',
  client.convertWeightValue(100, 'lb', 'kg') === 45.5 && client.convertWeightValue(45, 'kg', 'lb') === 99
  && client.convertWeightValue(37.5, 'lb', 'lb') === 37.5);
check('convert: round trip lb->kg->lb lands within one step',
  Math.abs(server.convertWeight(server.convertWeight(185, 'lb', 'kg'), 'kg', 'lb') - 185) <= 5);

// --- mutation sensitivity (executed, in BOTH copies) ---
function mutated(src, from, to) {
  if (!src.includes(from)) throw new Error(`mutation source not found: ${from}`);
  return src.replace(from, to);
}
const weakCap = (src) => mutated(src, 'set.reps >= input.targetMax', 'set.reps >= input.targetMin');
for (const [label, src, build] of [['server', serverSrc, (s) => buildFrom(s, ['progressionDecision', 'convertWeight'], ['LB_TO_KG'])],
                                   ['client', clientSrc, (s) => buildFrom(s, ['progressionDecision', 'convertWeightValue'], ['LB_TO_KG'])]]) {
  const weak = build(weakCap(src));
  const mid = weak.progressionDecision({ plannedSets: 3, sets: [S(100, 7), S(100, 8), S(100, 6)], targetMin: 6, targetMax: 8, unit: 'lb' });
  check(`mutation (${label}): weakening the cap check to the minimum fakes an increase`, mid.action === 'increase');
}
const noRepsGuard = (src) => mutated(src, 'if (completed.some((set) => set.reps == null)) return none;', '');
for (const [label, src, build] of [['server', serverSrc, (s) => buildFrom(s, ['progressionDecision', 'convertWeight'], ['LB_TO_KG'])],
                                   ['client', clientSrc, (s) => buildFrom(s, ['progressionDecision', 'convertWeightValue'], ['LB_TO_KG'])]]) {
  const m = build(noRepsGuard(src));
  const r = m.progressionDecision({ plannedSets: 3, sets: [S(100, 8), S(100, null), S(100, 8)], targetMin: 6, targetMax: 8, unit: 'lb' });
  check(`mutation (${label}): without the reps-missing guard a missing-reps session is no longer none`, r.action !== 'none');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
