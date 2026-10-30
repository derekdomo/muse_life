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
// W1-CONSISTENCY-001 (2026-10-17): the comparable history itself is
// selected PER EXERCISE — the server's selectPreviousSetsByExercise
// (extracted verbatim) walks the routine's 20 most recent completed
// workouts and, for each exercise, takes the most recent workout
// containing it; the client's reviewRecommendation (also extracted
// verbatim) does the same walk over recent_workouts (the same
// 20-workout window). The PM counterexample — bench press present in
// an older push but absent from the newest push — must yield the
// SAME non-null verdict on both ends, as must the extra-uncompleted-
// set, cross-unit, and beyond-20-window cases.
// W1-CONSISTENCY-001 cross-window fix (2026-10-17, second rework):
// the two windows were never the same set — the server selects per
// ROUTINE (20 most recent completed workouts of that routine) while
// getDashboard's recent_workouts is a GLOBAL 20 across routines. A
// comparable record ranked 21st globally but inside its routine's 20
// was adopted by the prefill yet invisible to the review, which
// reported "no comparable record". The fix is a single raw selection
// (server selectComparableHistory): startWorkout's prefill derives
// from it via selectPreviousSetsByExercise, and getDashboard ships it
// as comparable_history, which the client's reviewRecommendation
// prefers over its recent_workouts scan (the scan remains only as a
// fallback for older servers). The case below builds ONE dataset
// where bench is globally 21st and asserts both ends — server
// selection and client recommendation over the shipped
// comparable_history — reach the SAME increase-to-105 verdict, while
// the legacy fallback scan over the same global list still finds
// nothing (the original conflict, kept as documentation).
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
  // the body brace follows it. Only a brace that follows a colon is a
  // type — a plain function's body brace directly after `)` is not.
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
function buildFrom(src, fnNames, constNames) {
  const code = [
    ...constNames.map((n) => extractConst(src, n)),
    ...fnNames.map((n) => extractFunction(src, n).replace(/^export /, '')),
  ].join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${[...fnNames, ...constNames].join(', ')} };`)();
}

const server = buildFrom(serverSrc, ['progressionDecision', 'convertWeight', 'selectPreviousSetsByExercise', 'selectComparableHistory'], ['LB_TO_KG']);
const client = buildFrom(clientSrc, ['progressionDecision', 'convertWeightValue'], ['LB_TO_KG']);
const clientReview = buildFrom(clientSrc,
  // W2.3: reviewRecommendation now returns { text, basis } and calls the
  // new recommendationBasis (which uses formatDate) — extract both.
  ['progressionDecision', 'convertWeightValue', 'groupSets', 'targetRange', 'recommendationFromCandidate', 'formatDate', 'recommendationBasis', 'reviewRecommendation'], ['LB_TO_KG']);

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
check('source: server selects comparable history per exercise (W1-CONSISTENCY-001)',
  serverSrc.includes('selectPreviousSetsByExercise(') && serverSrc.includes('previous.byExercise[exercise.key]'));
check('source: server history window is the routine\'s 20 most recent completed workouts',
  /loadRoutineRecentCompleted[\s\S]*?\.limit\(20\)/.test(serverSrc) && serverSrc.includes('recentCompleted.slice(0, 20)'));
check('source: client history window matches (getDashboard recent_limit = 20)',
  clientSrc.includes('api.getDashboard({ recent_limit: 20 })'));
// W4.3-D1 backfill: the plan templates replaced the ROUTINES constant,
// so the prefill-side call now passes templates[routine] keys; both ends
// still derive from the single selectComparableHistory raw selection.
check('source: single raw selection feeds both ends (W1-CONSISTENCY-001 cross-window)',
  serverSrc.includes('selectComparableHistory(recentCompleted, templates[routine].map((exercise) => exercise.key))')
  && serverSrc.includes('selectComparableHistory(recentCompleted, exerciseKeys)'));
check('source: getDashboard ships comparable_history from that selection',
  serverSrc.includes('comparable_history: await loadComparableHistory(ctx)')
  && serverSrc.includes('comparable_history: z.array(comparableHistoryEntryResponse).optional()'));
check('source: forbidden dashboard still returns zero data (no comparable_history leak)',
  serverSrc.includes('return { forbidden: true, active_workout: null, recent_workouts: [], week_summaries: [] };'));
check('source: client review prefers comparable_history, keeps the legacy scan as fallback',
  clientSrc.includes('comparableHistory?.find((entry) => entry.exercise_key === review.key)')
  && clientSrc.includes('groupSets(workout.sets).find((group) => group.key === review.key)'));

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

// --- W1-CONSISTENCY-001: per-exercise selection, both ends agree ---
// Server end: selectPreviousSetsByExercise + progressionDecision is
// exactly what startWorkout's prefill consumes. Client end: the real
// reviewRecommendation over Workout-shaped recent_workouts.
const PS = (weight, reps, completed = true) => ({ exerciseKey: 'barbell-bench', setNumber: 0, targetReps: '6–8', weight, reps, completed });
const benchHistory = (list) => list.map(([w, r, c], i) => ({ ...PS(w, r, c), setNumber: i + 1 }));
function serverDecision(recentCompleted, targetUnit = 'lb') {
  const { byExercise, converted } = server.selectPreviousSetsByExercise(recentCompleted, ['barbell-bench'], targetUnit);
  const history = byExercise['barbell-bench'] ?? [];
  const decision = server.progressionDecision({
    plannedSets: history.length > 0 ? history.length : 4,
    sets: history, targetMin: 6, targetMax: 8, unit: targetUnit,
  });
  return { history, converted, decision };
}
function clientWorkout(unit, benchSets) {
  return {
    unit,
    sets: benchSets.map((s, i) => ({
      exercise_key: 'barbell-bench', exercise_name: '杠铃卧推', set_number: i + 1,
      target_reps: '6–8', weight: s.weight, reps: s.reps, completed: s.completed,
    })),
  };
}
const benchReview = { key: 'barbell-bench', name: '杠铃卧推', unit: 'lb' };

// PM counterexample: the newest push has NO bench press; an older
// push has bench 4x100lbx8, all completed, all at the cap. Both ends
// must reach the bench from the older workout and agree: increase.
{
  const olderBench = benchHistory([[100, 8], [100, 8], [100, 8], [100, 8]]);
  const recentServer = [
    { unit: 'lb', sets: [{ exerciseKey: 'overhead-press', setNumber: 1, weight: 60, reps: 10, completed: true }] },
    { unit: 'lb', sets: olderBench },
  ];
  const { history, decision } = serverDecision(recentServer);
  check('W1-CONSISTENCY: server walks past a bench-less newest workout to the older bench record',
    history.length === 4 && history.every((s) => s.weight === 100));
  check('W1-CONSISTENCY: server prefill verdict for the PM counterexample is increase to 105 (non-null)',
    decision.action === 'increase' && decision.suggestedWeight === 105 && decision.suggestedReps === 6,
    JSON.stringify(decision));
  const clientText = clientReview.reviewRecommendation(benchReview, [
    clientWorkout('lb', []),
    clientWorkout('lb', olderBench),
  ]).text;
  check('W1-CONSISTENCY: client recommendation agrees (increase to 105lb)',
    clientText.includes('下次增至 105lb'), clientText);
}

// Extra uncompleted set must not regress: bench's most recent record
// carries 5 sets, 4 completed at the cap + 1 uncompleted. Planned is
// the recorded 5, so both ends hold at 100 — not increase.
{
  const sets = benchHistory([[100, 8], [100, 8], [100, 8], [100, 8], [100, null, false]]);
  const { history, decision } = serverDecision([{ unit: 'lb', sets }]);
  check('W1-CONSISTENCY: extra uncompleted set keeps planned at the recorded count (hold, not increase)',
    history.length === 5 && decision.action === 'hold' && decision.suggestedWeight === 100,
    JSON.stringify(decision));
  const clientText = clientReview.reviewRecommendation(benchReview, [clientWorkout('lb', sets)]).text;
  check('W1-CONSISTENCY: client agrees on the extra-uncompleted-set case (hold 100lb)',
    clientText.includes('少完成 1 组，下次保持 100lb'), clientText);
}

// Cross-unit per source workout: bench's most recent record is a kg
// workout (4x45kgx8 all at cap); the new workout is lb. 45kg -> 99lb,
// so both ends increase to 104lb and the server flags the conversion.
{
  const kgSets = benchHistory([[45, 8], [45, 8], [45, 8], [45, 8]]);
  const { history, converted, decision } = serverDecision([{ unit: 'kg', sets: kgSets }], 'lb');
  check('W1-CONSISTENCY: cross-unit source is converted per workout (45kg -> 99lb) and flagged',
    converted === true && history.every((s) => s.weight === 99));
  check('W1-CONSISTENCY: server verdict on the converted record is increase to 104',
    decision.action === 'increase' && decision.suggestedWeight === 104, JSON.stringify(decision));
  const clientText = clientReview.reviewRecommendation(benchReview, [clientWorkout('kg', kgSets)]).text;
  check('W1-CONSISTENCY: client agrees on the cross-unit case (increase to 104lb)',
    clientText.includes('下次增至 104lb'), clientText);
}

// Beyond the 20-workout window: bench exists only in the 21st most
// recent workout. Neither end may adopt it — both say no suggestion.
{
  const filler = { unit: 'lb', sets: [{ exerciseKey: 'overhead-press', setNumber: 1, weight: 60, reps: 10, completed: true }] };
  const benchOnly = { unit: 'lb', sets: benchHistory([[100, 8], [100, 8], [100, 8], [100, 8]]) };
  const recentServer = [...Array.from({ length: 20 }, () => filler), benchOnly];
  const { history, decision } = serverDecision(recentServer);
  check('W1-CONSISTENCY: the 21st workout is outside the server window (no history adopted)',
    history.length === 0 && decision.action === 'none');
  const clientText = clientReview.reviewRecommendation(benchReview,
    Array.from({ length: 20 }, () => clientWorkout('lb', []))).text;
  check('W1-CONSISTENCY: client agrees beyond the window (no comparable record)',
    clientText.includes('暂不做重量建议'), clientText);
}

// --- W1-CONSISTENCY-001 cross-window: ONE dataset, both ends agree ---
// The PM counterexample for the second rework: bench's most recent
// comparable record (push, 4x100lbx8, all completed, all at the cap)
// ranks 21st in the GLOBAL completed list — the global 20 are other
// routines' workouts plus one newer bench-less push — but it is the
// 2nd most recent PUSH workout, well inside the routine's own 20.
// Server end: selectPreviousSetsByExercise over the push window (what
// startWorkout consumes). Client end: reviewRecommendation over the
// global recent_workouts PLUS the comparable_history entry the server
// builds from the SAME raw selection (selectComparableHistory). Both
// must say increase to 105lb; the legacy fallback scan over the
// global list alone still finds nothing (the original conflict).
{
  const olderBench = benchHistory([[100, 8], [100, 8], [100, 8], [100, 8]]);
  const benchlessPush = [{ exerciseKey: 'overhead-press', setNumber: 1, targetReps: '8–10', weight: 60, reps: 10, completed: true }];
  const otherRoutineSet = [{ exerciseKey: 'wide-lat-pulldown', setNumber: 1, targetReps: '8–12', weight: 120, reps: 10, completed: true }];
  // Push window, most recent first: bench-less push, then the bench push.
  const pushWindow = [
    { unit: 'lb', sets: benchlessPush },
    { unit: 'lb', sets: olderBench },
  ];
  const { history, decision } = serverDecision(pushWindow);
  check('W1-CONSISTENCY cross-window: server selection adopts the bench record inside the routine window',
    history.length === 4 && history.every((s) => s.weight === 100));
  check('W1-CONSISTENCY cross-window: server prefill verdict is increase to 105',
    decision.action === 'increase' && decision.suggestedWeight === 105 && decision.suggestedReps === 6,
    JSON.stringify(decision));

  // The comparable_history entry exactly as getDashboard builds it:
  // same raw selection, source values unconverted.
  const rawEntries = server.selectComparableHistory(pushWindow, ['barbell-bench', 'overhead-press']);
  const comparableHistory = rawEntries.map((entry) => ({
    routine: 'push',
    exercise_key: entry.exerciseKey,
    unit: entry.unit,
    target: entry.target,
    sets: entry.sets.map((s) => ({ set_number: s.setNumber, weight: s.weight, reps: s.reps, completed: s.completed })),
  }));
  const benchEntry = comparableHistory.find((entry) => entry.exercise_key === 'barbell-bench');
  check('W1-CONSISTENCY cross-window: comparable_history carries the bench candidate in source values',
    benchEntry != null && benchEntry.unit === 'lb' && benchEntry.target === '6–8'
    && benchEntry.sets.length === 4 && benchEntry.sets.every((s) => s.weight === 100 && s.reps === 8 && s.completed));

  // Global recent_workouts, most recent first: 19 other-routine
  // workouts + the bench-less push = the global 20; the bench push
  // would be 21st and is NOT in the list the client receives.
  const globalRecent = [
    {
      unit: 'lb',
      sets: benchlessPush.map((s) => ({
        exercise_key: s.exerciseKey, exercise_name: '站姿推举', set_number: s.setNumber,
        target_reps: s.targetReps, weight: s.weight, reps: s.reps, completed: s.completed,
      })),
    },
    ...Array.from({ length: 19 }, () => ({
      unit: 'lb',
      sets: otherRoutineSet.map((s) => ({
        exercise_key: s.exerciseKey, exercise_name: '高位下拉 · 宽握', set_number: s.setNumber,
        target_reps: s.targetReps, weight: s.weight, reps: s.reps, completed: s.completed,
      })),
    })),
  ];
  const legacyText = clientReview.reviewRecommendation(benchReview, globalRecent).text;
  check('W1-CONSISTENCY cross-window: legacy global scan alone still finds no candidate (the original conflict)',
    legacyText.includes('暂不做重量建议'), legacyText);
  const fixedResult = clientReview.reviewRecommendation(benchReview, globalRecent, comparableHistory);
  check('W1-CONSISTENCY cross-window: client prefers comparable_history and agrees with the server (increase to 105lb)',
    fixedResult.text.includes('下次增至 105lb'), fixedResult.text);
  check('W2.3: the client result carries the source basis line',
    fixedResult.basis === '依据：lb 记录', String(fixedResult.basis));

  // An exercise with NO comparable_history entry still falls back to
  // the recent_workouts scan (older-server compatibility path intact).
  const ohpReview = { key: 'overhead-press', name: '站姿推举', unit: 'lb' };
  const ohpWorkout = {
    unit: 'lb',
    sets: [60, 60, 60].map((w, i) => ({
      exercise_key: 'overhead-press', exercise_name: '站姿推举', set_number: i + 1,
      target_reps: '8–10', weight: w, reps: 10, completed: true,
    })),
  };
  const benchOnlyHistory = comparableHistory.filter((entry) => entry.exercise_key === 'barbell-bench');
  const fallbackText = clientReview.reviewRecommendation(ohpReview, [ohpWorkout], benchOnlyHistory).text;
  check('W1-CONSISTENCY cross-window: entry-less exercise falls back to the recent_workouts scan (increase to 65lb)',
    fallbackText.includes('下次增至 65lb'), fallbackText);
}

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
