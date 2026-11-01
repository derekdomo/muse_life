// W3.2 validation — the single server progression engine.
// Evaluates the REAL production engine (server/src/progression-
// engine.ts, whole file, types stripped) over synthetic data only,
// plus the real server progressionDecision adapter and the two pure
// session selections from server/src/actions.ts, plus source-wiring
// checks for the three consumers (startWorkout prefill, completion
// receipt, weekly review):
//  - all four verdicts: increase / hold (both kinds) / reduce /
//    insufficient (no session, empty, nothing completed, reps
//    missing, bodyweight — never a 0-load suggestion);
//  - W1.2 parity through the preserved progressionDecision adapter;
//  - pain is conservative: an increase is held back and the reason
//    names the pain; reduce/hold keep their verdict with the note;
//  - RIR feeds reason + confidence only: the decision and suggested
//    weight are identical with RIR absent, low, or high; RIR ≥ 2
//    everywhere raises an increase's confidence, RIR 0 caps it;
//  - the second session moves confidence (agreement up,
//    contradiction down) and is named in the reason;
//  - cross-unit consistency: the same performance in kg judged for
//    lb output matches the lb-native verdict (LB_TO_KG, 0.5 grid);
//  - every advice carries the engine version; the engine's LB_TO_KG
//    equals the server's long-standing constant;
//  - NULL / missing handling: absent painFlags / sessionRpe / rir
//    behave exactly like recorded nulls;
//  - mutation sensitivity: four deliberate mutations of the engine
//    source (increment, pain guard, cap comparison, RIR threshold)
//    must each make the behavioral suite fail;
//  - wiring: the engine is the only progression rule — actions.ts
//    imports it, all three consumers call it or consume its output,
//    and the client defines no progressionDecision of its own.
// Synthetic data only: no real training record appears in this file.
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
  let bodyStart = source.indexOf('{', closeParen);
  const between = source.slice(closeParen + 1, bodyStart).trimStart();
  if (between.startsWith(':')) {
    const typeEnd = matchDelim(source, bodyStart, '{', '}');
    const nextBrace = source.indexOf('{', typeEnd);
    if (nextBrace > -1 && source.slice(typeEnd + 1, nextBrace).trim() === '') bodyStart = nextBrace;
  }
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function loadEngine(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { evaluateProgression, convertEngineWeight, PROGRESSION_ENGINE_VERSION, LB_TO_KG };`,
  )();
}
const E = loadEngine(engineSrc);

// --- synthetic builders ---
const st = (weight, reps, rir = null, completed = true) => ({ weight, reps, rir, completed });
const sess = (unit, sets, extra = {}) => ({ unit, plannedSets: sets.length, sets, ...extra });
const rep = (weight, reps, rir, n) => Array.from({ length: n }, () => st(weight, reps, rir));
const judge = (engine, sessions, targetMin = 6, targetMax = 8, unit = 'lb') =>
  engine.evaluateProgression({ sessions, targetMin, targetMax, unit });

// --- behavioral suite (also run against mutants) ---
// Returns the number of failed assertions; names are stable so a
// mutant's failures can be eyeballed against the real run.
function suite(engine) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };

  // increase / hold / reduce / insufficient — the four verdicts
  const inc = judge(engine, [sess('lb', rep(100, 8, null, 4))]);
  t('increase: verdict', inc.decision === 'increase');
  t('increase: +5 lb and reps back to the range floor', inc.suggestedWeight === 105 && inc.suggestedReps === 6);
  t('increase: completion rate 1', inc.completionRate === 1);
  const incKg = judge(engine, [sess('kg', rep(60, 10, null, 3))], 8, 10, 'kg');
  t('increase kg: +2.5 kg', incKg.decision === 'increase' && incKg.suggestedWeight === 62.5 && incKg.suggestedReps === 8);
  const holdInc = judge(engine, [sess('lb', [...rep(100, 8, null, 3), st(100, 8, null, false)])]);
  t('hold (incomplete): verdict + base weight + rate 0.75',
    holdInc.decision === 'hold' && holdInc.suggestedWeight === 100 && holdInc.completionRate === 0.75);
  const holdMid = judge(engine, [sess('lb', rep(100, 7, null, 4))]);
  t('hold (mid-range): verdict + base weight', holdMid.decision === 'hold' && holdMid.suggestedWeight === 100);
  const red = judge(engine, [sess('lb', [st(100, 8), st(100, 5)])]);
  t('reduce: verdict + one step down', red.decision === 'reduce' && red.suggestedWeight === 95);
  const redFloorLb = judge(engine, [sess('lb', [st(5, 3)])]);
  t('reduce: never below 0 (lb)', redFloorLb.decision === 'reduce' && redFloorLb.suggestedWeight === 0);
  const redFloorKg = judge(engine, [sess('kg', [st(2.5, 2)])], 6, 8, 'kg');
  t('reduce: never below 0 (kg)', redFloorKg.decision === 'reduce' && redFloorKg.suggestedWeight === 0);
  t('insufficient: no sessions at all', judge(engine, []).decision === 'insufficient');
  t('insufficient: empty session', judge(engine, [sess('lb', [])]).decision === 'insufficient');
  t('insufficient: nothing completed',
    judge(engine, [sess('lb', rep(100, 8, null, 2).map((s) => ({ ...s, completed: false })))]).decision === 'insufficient');
  const bw = judge(engine, [sess('lb', rep(null, 12, null, 3))], 10, 12);
  t('insufficient: bodyweight is never a 0-load suggestion',
    bw.decision === 'insufficient' && bw.suggestedWeight === null);
  t('insufficient: a completed set with reps missing (all sets done)',
    judge(engine, [sess('lb', [st(100, null), st(100, 8)])]).decision === 'insufficient');
  const mixed = judge(engine, [sess('lb', [st(100, 8), st(null, 8)])]);
  t('one unweighed completed set defeats the increase (W1 verbatim)',
    mixed.decision === 'hold' && mixed.suggestedWeight === 100);
  const zeroLogged = judge(engine, [sess('lb', rep(0, 10, null, 3))], 10, 10);
  t('insufficient: bodyweight logged as weight 0 is never a 0 load',
    zeroLogged.decision === 'insufficient' && zeroLogged.suggestedWeight === null);
  const zeroMixed = judge(engine, [sess('lb', [st(0, 8), st(100, 8), st(100, 8)])]);
  t('a 0-weight set among weighed sets defeats the increase like an unweighed one',
    zeroMixed.decision === 'hold' && zeroMixed.suggestedWeight === 100);

  // pain: conservative, always named
  const painInc = judge(engine, [sess('lb', rep(100, 8, null, 4), { painFlags: ['shoulder'] })]);
  t('pain: would-be increase is held at the base weight',
    painInc.decision === 'hold' && painInc.suggestedWeight === 100);
  t('pain: the reason names the pain', painInc.reason.includes('疼痛'));
  const painRed = judge(engine, [sess('lb', [st(100, 8), st(100, 5)], { painFlags: ['knee'] })]);
  t('pain: reduce stays reduce, reason names the pain',
    painRed.decision === 'reduce' && painRed.suggestedWeight === 95 && painRed.reason.includes('疼痛'));
  const painHold = judge(engine, [sess('lb', rep(100, 7, null, 4), { painFlags: ['form'] })]);
  t('pain: hold stays hold, reason names the pain',
    painHold.decision === 'hold' && painHold.reason.includes('疼痛'));

  // RIR: reason + confidence only, never the decision
  const rirHigh = judge(engine, [sess('lb', rep(100, 8, 3, 4))]);
  t('RIR high: increase stands, confidence high, reason cites RIR',
    rirHigh.decision === 'increase' && rirHigh.suggestedWeight === 105
    && rirHigh.confidence === 'high' && rirHigh.reason.includes('RIR'));
  const rirZero = judge(engine, [sess('lb', rep(100, 8, 0, 4))]);
  t('RIR 0: increase stands, confidence capped at medium, reason cites 力竭',
    rirZero.decision === 'increase' && rirZero.suggestedWeight === 105
    && rirZero.confidence === 'medium' && rirZero.reason.includes('力竭'));
  const baseScenarios = [
    [sess('lb', rep(100, 8, null, 4))],
    [sess('lb', rep(100, 7, null, 4))],
    [sess('lb', [st(100, 8), st(100, 5)])],
    [sess('lb', [...rep(100, 8, null, 3), st(100, 8, null, false)])],
  ];
  for (const [i, scenario] of baseScenarios.entries()) {
    const plain = judge(engine, scenario);
    const withRir = judge(engine, [sess('lb', scenario[0].sets.map((s) => ({ ...s, rir: 1 })))]);
    t(`RIR invariance #${i + 1}: decision + weights unchanged by recorded RIR`,
      withRir.decision === plain.decision && withRir.suggestedWeight === plain.suggestedWeight
      && withRir.suggestedReps === plain.suggestedReps);
  }
  t('RIR absent: the reason carries no RIR note', !inc.reason.includes('RIR'));

  // second session: confidence + reason only
  const twoTop = judge(engine, [sess('lb', rep(100, 8, null, 4)), sess('lb', rep(95, 8, null, 4))]);
  t('two sessions agree (both at cap): confidence high, reason says 连续两次',
    twoTop.decision === 'increase' && twoTop.confidence === 'high' && twoTop.reason.includes('连续两次'));
  t('single session at cap: confidence medium', inc.confidence === 'medium');
  const contra = judge(engine, [sess('lb', rep(100, 8, null, 4)), sess('lb', [st(95, 8), st(95, 4)])]);
  t('two sessions contradict: confidence low',
    contra.decision === 'increase' && contra.confidence === 'low');
  const redAgree = judge(engine, [sess('lb', [st(100, 5)]), sess('lb', [st(100, 4)])]);
  t('reduce confirmed by the previous session: confidence high',
    redAgree.decision === 'reduce' && redAgree.confidence === 'high');
  const rpeCap = judge(engine, [
    sess('lb', rep(100, 8, null, 4), { sessionRpe: 10 }),
    sess('lb', rep(95, 8, null, 4)),
  ]);
  t('session RPE 10: reason cites RPE and confidence is capped at medium',
    rpeCap.decision === 'increase' && rpeCap.confidence === 'medium' && rpeCap.reason.includes('RPE'));

  // cross-unit consistency (LB_TO_KG, 0.5 grid)
  const kgForLb = judge(engine, [sess('kg', rep(60, 10, null, 3))], 8, 10, 'lb');
  const lbNative = judge(engine, [sess('lb', rep(132.5, 10, null, 3))], 8, 10, 'lb');
  t('cross-unit: kg session judged for lb matches the lb-native verdict',
    kgForLb.decision === lbNative.decision && kgForLb.suggestedWeight === lbNative.suggestedWeight
    && kgForLb.suggestedWeight === 137.5);
  const lbForKg = judge(engine, [sess('lb', rep(100, 8, null, 4))], 6, 8, 'kg');
  t('cross-unit: lb session judged for kg converts the base (100 lb -> 45.5 kg, +2.5)',
    lbForKg.decision === 'increase' && lbForKg.suggestedWeight === 48);

  // version + missing-field handling
  t('every advice carries the engine version',
    [inc, holdInc, red, bw].every((a) => a.engineVersion === engine.PROGRESSION_ENGINE_VERSION));
  const bare = judge(engine, [{ unit: 'lb', plannedSets: 4, sets: rep(100, 8, null, 4) }]);
  t('absent painFlags / sessionRpe / rir behave like recorded nulls',
    bare.decision === inc.decision && bare.suggestedWeight === inc.suggestedWeight && bare.reason === inc.reason);
  return failed;
}

// --- the real engine passes the whole suite ---
{
  const failed = suite(E);
  check('behavioral suite: the real engine passes every assertion', failed === 0, `${failed} failed`);
  check('engine version is a positive integer', Number.isInteger(E.PROGRESSION_ENGINE_VERSION) && E.PROGRESSION_ENGINE_VERSION >= 1);
  check('engine LB_TO_KG is the established constant', E.LB_TO_KG === 0.45359237);
  check('server LB_TO_KG matches the engine constant',
    serverSrc.includes('export const LB_TO_KG = 0.45359237;'));
  check('convertEngineWeight: null stays null, same unit is identity',
    E.convertEngineWeight(null, 'lb', 'kg') === null && E.convertEngineWeight(100, 'lb', 'lb') === 100);
  check('convertEngineWeight: 100 lb -> 45.5 kg on the 0.5 grid',
    E.convertEngineWeight(100, 'lb', 'kg') === 45.5);
}

// --- mutation sensitivity: each mutant must break the suite ---
{
  const mutants = [
    ['increment +5 -> +6 lb', 'const increment = unit === "lb" ? 5 : 2.5;', 'const increment = unit === "lb" ? 6 : 2.5;'],
    ['pain guard disabled', 'const painHeldIncrease = pain && baseDecision === "increase";', 'const painHeldIncrease = false && baseDecision === "increase";'],
    ['cap comparison >= becomes >', 'set.reps != null && set.reps >= targetMax', 'set.reps != null && set.reps > targetMax'],
    ['RIR headroom threshold 2 -> 99', 'if (minRir >= 2) {', 'if (minRir >= 99) {'],
  ];
  for (const [name, from, to] of mutants) {
    if (!engineSrc.includes(from)) {
      check(`mutant anchor present: ${name}`, false, 'anchor not found in engine source');
      continue;
    }
    const mutant = loadEngine(engineSrc.replace(from, to));
    const failed = suite(mutant);
    check(`mutation sensitivity: ${name} breaks the suite`, failed > 0, `${failed} suite assertions failed`);
  }
}

// --- W1.2 parity through the preserved server adapter ---
{
  const engineCode = stripTypeScriptTypes(engineSrc).replace(/^export /gm, '');
  const adapter = new Function(
    `${engineCode}\n${stripTypeScriptTypes(extractFunction(serverSrc, 'progressionDecision'))}\nreturn { progressionDecision };`,
  )();
  const pd = (plannedSets, sets, targetMin = 6, targetMax = 8, unit = 'lb') =>
    adapter.progressionDecision({ plannedSets, sets, targetMin, targetMax, unit });
  const plain = (list) => list.map(([w, r, c]) => ({ weight: w, reps: r, completed: c }));
  check('adapter parity: increase', JSON.stringify(pd(4, plain([[100, 8, true], [100, 8, true], [100, 8, true], [100, 8, true]])))
    === JSON.stringify({ action: 'increase', suggestedWeight: 105, suggestedReps: 6 }));
  check('adapter parity: hold on incomplete', JSON.stringify(pd(4, plain([[100, 8, true], [100, 8, true], [100, 8, true], [100, 8, false]])))
    === JSON.stringify({ action: 'hold', suggestedWeight: 100, suggestedReps: null }));
  check('adapter parity: hold mid-range', pd(4, plain([[100, 7, true], [100, 7, true]])).action === 'hold');
  check('adapter parity: reduce', JSON.stringify(pd(2, plain([[100, 8, true], [100, 5, true]])))
    === JSON.stringify({ action: 'reduce', suggestedWeight: 95, suggestedReps: null }));
  check('adapter parity: bodyweight -> none', pd(2, plain([[null, 12, true], [null, 12, true]]), 10, 12).action === 'none');
  check('adapter parity: bodyweight logged as weight 0 -> none (W3.2 rule 4)',
    pd(3, plain([[0, 10, true], [0, 10, true], [0, 10, true]]), 10, 10).action === 'none');
  check('adapter parity: reps missing -> none', pd(2, plain([[100, null, true], [100, 8, true]])).action === 'none');
  check('adapter parity: no sets -> none', pd(4, []).action === 'none');
  check('adapter parity: kg increase uses +2.5', pd(3, plain([[60, 10, true], [60, 10, true], [60, 10, true]]), 8, 10, 'kg').suggestedWeight === 62.5);
}

// --- pure selections: two sessions per exercise, full pass-through ---
{
  const S = new Function(
    `${stripTypeScriptTypes(extractFunction(serverSrc, 'selectProgressionSessions'))}\n${stripTypeScriptTypes(extractFunction(serverSrc, 'selectReceiptSessions'))}\nreturn { selectProgressionSessions, selectReceiptSessions };`,
  )();
  const w = (unit, completedAt, painFlags, sessionRpe, sets) => ({ unit, completedAt, painFlags, sessionRpe, sets });
  const cs = (key, n, target, weight, reps, rir, completed) =>
    ({ exerciseKey: key, setNumber: n, targetReps: target, weight, reps, rir, completed });
  const recent = [
    w('lb', '2026-10-30T00:00:00.000Z', ['shoulder'], 8, [cs('bench', 1, '6-8', 100, 8, 2, true), cs('row', 1, '8-10', 60, 9, null, true)]),
    w('kg', '2026-10-27T00:00:00.000Z', [], null, [cs('bench', 1, '6-8', 45, 8, null, true)]),
    w('lb', '2026-10-24T00:00:00.000Z', [], null, [cs('bench', 1, '6-8', 95, 7, null, true)]),
  ];
  const [benchSel, rowSel] = S.selectProgressionSessions(recent, ['bench', 'row']);
  check('selection: at most two sessions, most recent first',
    benchSel.sessions.length === 2 && benchSel.sessions[0].unit === 'lb' && benchSel.sessions[1].unit === 'kg');
  check('selection: pain flags, session RPE, RIR and target pass through untouched',
    benchSel.sessions[0].painFlags.join(',') === 'shoulder' && benchSel.sessions[0].sessionRpe === 8
    && benchSel.sessions[0].sets[0].rir === 2 && benchSel.sessions[0].target === '6-8'
    && benchSel.sessions[0].sourceCompletedAt === '2026-10-30T00:00:00.000Z');
  check('selection: planned sets are the session\'s own set count for the exercise',
    benchSel.sessions[0].plannedSets === 1 && rowSel.sessions.length === 1);
  const receiptSel = S.selectReceiptSessions(
    [{ unit: 'lb', painFlags: [], sessionRpe: null, sets: [
      { exerciseKey: 'other-name', targetReps: '8', weight: 10, reps: 8, rir: null, completed: true },
      { exerciseKey: 'bench', targetReps: '6-8', weight: 90, reps: 8, rir: 1, completed: true },
    ] }],
    ['bench', 'missing'],
  );
  check('receipt selection: matches by key only, full session returned',
    receiptSel[0].session?.sets[0].weight === 90 && receiptSel[0].session?.sets[0].rir === 1
    && receiptSel[0].session?.plannedSets === 1);
  check('receipt selection: an absent exercise gets a null session', receiptSel[1].session === null);
}

// --- wiring: one engine, three consumers ---
{
  check('wiring: the engine module imports nothing (pure, standalone)', !/^\s*import\s/m.test(engineSrc));
  check('wiring: actions.ts imports the engine', serverSrc.includes('from "./progression-engine"'));
  const startBegin = serverSrc.indexOf('startWorkout: defineAction');
  const startEnd = serverSrc.indexOf('completeWorkout: defineAction');
  check('wiring: startWorkout prefill calls evaluateProgression',
    serverSrc.slice(startBegin, startEnd).includes('evaluateProgression({'));
  const dashBegin = serverSrc.indexOf('getDashboard: defineAction');
  const dashSlice = serverSrc.slice(dashBegin, startBegin);
  check('wiring: getDashboard returns progression_advice from loadProgressionAdvice',
    dashSlice.includes('progression_advice: await loadProgressionAdvice(ctx)'));
  check('wiring: getDashboard returns receipt_advice only for a located receipt',
    dashSlice.includes('receipt_advice: await loadReceiptAdvice(ctx, located)'));
  check('wiring: dashboardResponse carries both advice fields as additive optionals',
    serverSrc.includes('progression_advice: z.array(progressionAdviceEntryResponse).optional()')
    && serverSrc.includes('receipt_advice: z.array(receiptAdviceEntryResponse).optional()'));
  check('wiring: the preserved progressionDecision adapter delegates to the engine',
    extractFunction(serverSrc, 'progressionDecision').includes('evaluateProgression({'));
  check('wiring: the client defines no progression rule of its own',
    !clientSrc.includes('function progressionDecision'));
  check('wiring: the weekly review consumes progression_advice',
    clientSrc.includes('progressionAdvice={dashboard.data.progression_advice}')
    && clientSrc.includes('progressionAdvice?.find((entry) => entry.exercise_key === review.key)'));
  check('wiring: the receipt consumes receipt_advice',
    clientSrc.includes('query.data?.receipt_advice'));
  check('wiring: the client formats the engine reason, never recomputes it',
    clientSrc.includes('${advice.reason}，下次增至') && clientSrc.includes('suggestionReason: adviceEntry?.reason ?? null'));
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
