// W3.2 validation — the single server progression engine is the ONLY rule.
// Successor of the W1.1–W1.4 dual-copy script: the client's own
// progressionDecision / self-computing reviewRecommendation no longer
// exist. This script runs the REAL engine
// (server/src/progression-engine.ts, whole file, types stripped) and the
// REAL server progressionDecision adapter (server/src/actions.ts) over
// synthetic data only and asserts:
//  - architecture: the client defines no progression rule of its own
//    (reviewRecommendation only formats the server's progression_advice);
//    the server adapter delegates to evaluateProgression; the three
//    consumers (startWorkout prefill, completion receipt, weekly review)
//    call the engine; the engine's LB_TO_KG equals the server's
//    long-standing constant; every advice carries the engine version;
//  - parity: over the historical W1.2 input domain the adapter's
//    verdicts match the engine's with the documented mapping
//    (insufficient -> none), including the deliberate W3.2 weight-0
//    reclassification (a recorded 0 is bodyweight, never a 0 load);
//  - W1.2 semantics through the adapter: increase +5 lb / +2.5 kg with
//    reps back to the range floor, reduce one step floored at 0;
//  - mutation sensitivity, actually executed.
// Pure Node, no deps. Synthetic data only: no real training record.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const engineSrc = readFileSync(new URL('./server/src/progression-engine.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

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
  // Skip an object-literal return-type annotation (`): { ... } {`).
  let pos = closeParen + 1;
  let sawColon = false;
  while (pos < source.length && /[\s:]/.test(source[pos])) {
    if (source[pos] === ':') sawColon = true;
    pos++;
  }
  if (sawColon && source[pos] === '{') pos = matchDelim(source, pos, '{', '}') + 1;
  const bodyStart = source.indexOf('{', pos);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function extractConst(source, name) {
  const m = source.match(new RegExp(`export const ${name} = [^;]+;`));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0].replace(/^export /, '');
}
function buildEngine(src) {
  const code = stripTypeScriptTypes(src).replace(/^export /gm, '');
  return new Function(`${code}\nreturn { evaluateProgression, PROGRESSION_ENGINE_VERSION, LB_TO_KG };`)();
}
function buildAdapter(src, evaluateProgression) {
  const fn = extractFunction(src, 'progressionDecision').replace(/^export /, '');
  return new Function('evaluateProgression', `${stripTypeScriptTypes(fn)}\nreturn progressionDecision;`)(evaluateProgression);
}

const ENG = buildEngine(engineSrc);
const serverLbToKg = new Function(`${extractConst(serverSrc, 'LB_TO_KG')}\nreturn LB_TO_KG;`)();
const adapter = buildAdapter(serverSrc, ENG.evaluateProgression);

// --- architecture: one engine, no client rule ---
check('arch: client defines no progressionDecision of its own',
  !clientSrc.includes('function progressionDecision'));
check('arch: client reviewRecommendation only formats the server advice (looks up progression_advice, no verdict computation)',
  clientSrc.includes('progressionAdvice?.find') && !clientSrc.includes('recommendationFromCandidate'));
check('arch: server adapter delegates to evaluateProgression',
  extractFunction(serverSrc, 'progressionDecision').includes('evaluateProgression({'));
check('arch: actions.ts imports the engine module',
  serverSrc.includes('from "./progression-engine"'));
check('arch: engine LB_TO_KG equals the server long-standing constant',
  ENG.LB_TO_KG === serverLbToKg, String(ENG.LB_TO_KG));
{
  const calls = (serverSrc.match(/evaluateProgression\(\{/g) || []).length;
  check('arch: adapter + three consumers call evaluateProgression (prefill, receipt, weekly review)',
    calls >= 4, `${calls} call sites`);
}

// --- behavioral parity: adapter vs engine over the historical W1.2 domain ---
const S = (weight, reps, completed = true) => ({ weight, reps, completed });
const toEngineInput = (input) => ({
  sessions: [{
    unit: input.unit,
    plannedSets: input.plannedSets,
    sets: input.sets.map((s) => ({ weight: s.weight, reps: s.reps, rir: null, completed: s.completed })),
    painFlags: [],
    sessionRpe: null,
  }],
  targetMin: input.targetMin,
  targetMax: input.targetMax,
  unit: input.unit,
});
const cases = [
  ['increase lb', { plannedSets: 3, sets: [S(100, 12), S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['hold (incomplete)', { plannedSets: 3, sets: [S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['hold (all done, not all top)', { plannedSets: 3, sets: [S(100, 12), S(100, 10), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['reduce', { plannedSets: 3, sets: [S(100, 6), S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['none (empty)', { plannedSets: 3, sets: [], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['none (nothing completed)', { plannedSets: 3, sets: [S(100, 12, false), S(100, 12, false)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['none (reps missing)', { plannedSets: 3, sets: [S(100, null), S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['none (weight 0 = bodyweight, W3.2 reclassification)', { plannedSets: 3, sets: [S(0, 12), S(0, 12), S(0, 12)], targetMin: 8, targetMax: 12, unit: 'lb' }],
  ['increase kg', { plannedSets: 3, sets: [S(45, 12), S(45, 12), S(45, 12)], targetMin: 8, targetMax: 12, unit: 'kg' }],
  ['reduce floor 0', { plannedSets: 2, sets: [S(2.5, 5), S(2.5, 5)], targetMin: 8, targetMax: 12, unit: 'kg' }],
];
for (const [label, input] of cases) {
  const a = adapter(input);
  const e = ENG.evaluateProgression(toEngineInput(input));
  const mapped = e.decision === 'insufficient' ? 'none' : e.decision;
  check(`parity ${label}: adapter action matches engine decision (${mapped})`, a.action === mapped, `adapter=${a.action} engine=${e.decision}`);
  const weightOk = mapped === 'none'
    ? (a.suggestedWeight === null && e.suggestedWeight === null)
    : a.suggestedWeight === e.suggestedWeight;
  const repsOk = mapped === 'none'
    ? (a.suggestedReps === null && e.suggestedReps === null)
    : a.suggestedReps === e.suggestedReps;
  check(`parity ${label}: suggested weight/reps agree`, weightOk && repsOk, `w=${a.suggestedWeight}/${e.suggestedWeight} r=${a.suggestedReps}/${e.suggestedReps}`);
  check(`parity ${label}: advice carries engine version`, e.engineVersion === ENG.PROGRESSION_ENGINE_VERSION, `v${e.engineVersion}`);
}

// --- W1.2 semantics through the adapter (exact numbers) ---
{
  const inc = adapter({ plannedSets: 3, sets: [S(100, 12), S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' });
  check('semantics: increase is +5 lb with reps back to the range floor',
    inc.action === 'increase' && inc.suggestedWeight === 105 && inc.suggestedReps === 8, JSON.stringify(inc));
  const incKg = adapter({ plannedSets: 3, sets: [S(45, 12), S(45, 12), S(45, 12)], targetMin: 8, targetMax: 12, unit: 'kg' });
  check('semantics: increase is +2.5 kg with reps back to the range floor',
    incKg.action === 'increase' && incKg.suggestedWeight === 47.5 && incKg.suggestedReps === 8, JSON.stringify(incKg));
  const red = adapter({ plannedSets: 3, sets: [S(100, 6), S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' });
  check('semantics: reduce is one step down', red.action === 'reduce' && red.suggestedWeight === 95, JSON.stringify(red));
  const redFloor = adapter({ plannedSets: 2, sets: [S(2.5, 5), S(2.5, 5)], targetMin: 8, targetMax: 12, unit: 'kg' });
  check('semantics: reduce never goes below 0', redFloor.action === 'reduce' && redFloor.suggestedWeight === 0, JSON.stringify(redFloor));
  const hold = adapter({ plannedSets: 3, sets: [S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' });
  check('semantics: hold keeps the base weight', hold.action === 'hold' && hold.suggestedWeight === 100, JSON.stringify(hold));
}

// --- mutation sensitivity (actually executed) ---
function mutated(src, from, to) {
  if (!src.includes(from)) throw new Error(`mutation source not found: ${from}`);
  return src.replace(from, to);
}
{
  // M1: engine increment changed -> the exact +5 lb semantic must break.
  const mutEng = buildEngine(mutated(engineSrc, 'unit === "lb" ? 5 : 2.5', 'unit === "lb" ? 6 : 2.5'));
  const mutAdapter = buildAdapter(serverSrc, mutEng.evaluateProgression);
  const r = mutAdapter({ plannedSets: 3, sets: [S(100, 12), S(100, 12), S(100, 12)], targetMin: 8, targetMax: 12, unit: 'lb' });
  check('mutation: changing the engine increment breaks the +5 lb semantic', r.suggestedWeight !== 105, `got ${r.suggestedWeight}`);
}
{
  // M2: adapter loses the insufficient->none mapping -> parity breaks.
  const mutSrc = mutated(serverSrc,
    'if (advice.decision === "insufficient") {\n    return { action: "none", suggestedWeight: null, suggestedReps: null };\n  }',
    '');
  const mutAdapter = buildAdapter(mutSrc, ENG.evaluateProgression);
  const r = mutAdapter({ plannedSets: 3, sets: [], targetMin: 8, targetMax: 12, unit: 'lb' });
  check('mutation: dropping the insufficient->none mapping breaks parity', r.action !== 'none', `got ${r.action}`);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
