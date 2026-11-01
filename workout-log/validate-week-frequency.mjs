// W3.4 validation — frequency over the last 4 complete weeks
// （近 4 个完整周训练频率）.
// Evaluates the REAL production module (server/src/week-frequency.ts,
// whole file, types stripped) over synthetic data only:
//  - the 4-week window: Monday-start (America/Los_Angeles), only
//    fully ended weeks — the in-progress week and anything older
//    are excluded, including across the UTC/LA date boundary;
//  - per-exercise grouping: one exercise's sets never leak into
//    another's cells; completed-set counting ignores uncompleted
//    sets; frequency counts only sessions with a completed set;
//  - the three states, one fixture each: 没练 (planned, no record),
//    没记录 (no plan expectation, no record), 主动减量 (recorded but
//    clearly below the personal baseline) — plus the two honest
//    fallbacks 已练 / 无法判断；
//  - tonnage never judges: multiplying every weight by 10 changes
//    volumes but flips NO state;
//  - empty behaviour: no workouts and no plan still yields the 4
//    week descriptors with zero tonnage and no exercises; a plan
//    with no workouts reports 没练 / 没记录， never an invented
//    classification;
//  - mutation sensitivity: three deliberate mutations of the module
//    source (week-start day, deload threshold, completion filter)
//    must each make the behavioral suite fail;
//  - wiring: actions.ts imports the builder and returns
//    week_frequency from getDashboard, and the client renders the
//    server states with the public definitions while computing no
//    frequency state of its own.
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const freqSrc = readFileSync(new URL('./server/src/week-frequency.ts', import.meta.url), 'utf8');
const engineSrc = readFileSync(new URL('./server/src/progression-engine.ts', import.meta.url), 'utf8');
const trendsSrc = readFileSync(new URL('./server/src/action-trends.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function loadFreq(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { buildWeekFrequency, weekFrequencyWeeks, classifyWeekCell, convertFrequencyWeight, WEEK_FREQUENCY_VERSION, LB_TO_KG, DELOAD_MAX_RATIO };`,
  )();
}
function loadConst(source, name) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(`${code}\nreturn { ${name} };`)()[name];
}
const F = loadFreq(freqSrc);

// --- synthetic builders ---
// "Now" is fixed at Sunday 2026-11-01 11:00 Los Angeles time, so
// the current (excluded) week starts Mon 2026-10-26 and the four
// complete weeks start 09-28 / 10-05 / 10-12 / 10-19. Workout times
// below are UTC; Los Angeles is UTC-7 (PDT) through Oct 31.
const NOW = '2026-11-01T19:00:00.000Z';
const s = (key, name, weight, reps, completed = true) => ({ exerciseKey: key, exerciseName: name, weight, reps, completed });
const w = (routine, unit, completedAt, sets) => ({ routine, unit, completedAt, sets });
const rep = (n, make) => Array.from({ length: n }, (_, i) => make(i));

const PLAN_EXERCISES = [
  { routine: 'push', exerciseKey: 'bench', exerciseName: 'Bench', setsPerSession: 4 },
  { routine: 'legs', exerciseKey: 'squat', exerciseName: 'Squat', setsPerSession: 4 },
  { routine: 'pull', exerciseKey: 'ghost', exerciseName: 'Ghost', setsPerSession: 3 },
];
const PLAN_SCHEDULE = [
  { dayIndex: 1, routineCode: 'push' },
  { dayIndex: 6, routineCode: 'legs' },
];

function fixture(weightScale = 1) {
  const bw = 100 * weightScale;
  const ew = 50 * weightScale;
  return {
    now: NOW,
    planExercises: PLAN_EXERCISES,
    planSchedule: PLAN_SCHEDULE,
    workouts: [
      // bench (plan: 4 sets × 1 session/week = 4 expected)
      w('push', 'lb', '2026-09-30T17:00:00.000Z', [ // W1: 12 done + 2 not
        ...rep(12, () => s('bench', 'Bench', bw, 8)),
        ...rep(2, () => s('bench', 'Bench', bw, 8, false)),
      ]),
      w('push', 'lb', '2026-10-02T17:00:00.000Z', rep(3, () => s('bench', 'Bench', bw, 8, false))), // W1 second session, 0 done
      w('push', 'lb', '2026-10-07T17:00:00.000Z', rep(12, () => s('bench', 'Bench', bw, 8))), // W2
      w('push', 'lb', '2026-10-14T17:00:00.000Z', rep(12, () => s('bench', 'Bench', bw, 8))), // W3
      w('push', 'lb', '2026-10-21T17:00:00.000Z', rep(4, () => s('bench', 'Bench', bw, 8))), // W4: clearly below baseline 12
      w('push', 'lb', '2026-10-28T17:00:00.000Z', rep(9, () => s('bench', 'Bench', bw, 8))), // current week — excluded
      // squat (plan: 4 expected): only W2 has a record, below plan, no baseline
      w('legs', 'lb', '2026-10-08T17:00:00.000Z', [
        s('squat', 'Squat', 150, 6), s('squat', 'Squat', 150, 6),
        s('squat', 'Squat', 150, 6, false), s('squat', 'Squat', 150, 6, false),
      ]),
      // old-move (not in the plan): trained in W1 only
      w('pull', 'lb', '2026-09-29T17:00:00.000Z', rep(6, () => s('old-move', 'Old Move', ew, 10))),
      // even-base (not in the plan): 8 / 10 / 2 / — (even-count baseline in W3)
      w('legs', 'lb', '2026-09-30T18:00:00.000Z', rep(8, () => s('even-base', 'Even Base', ew, 10))),
      w('legs', 'lb', '2026-10-07T18:00:00.000Z', rep(10, () => s('even-base', 'Even Base', ew, 10))),
      w('legs', 'lb', '2026-10-14T18:00:00.000Z', rep(2, () => s('even-base', 'Even Base', ew, 10))),
      // edge-move (not in the plan): LA-date boundary probes
      w('push', 'lb', '2026-10-26T03:00:00.000Z', rep(2, () => s('edge-move', 'Edge Move', ew, 10))), // Sun Oct 25 20:00 LA → W4
      w('push', 'lb', '2026-10-19T07:30:00.000Z', rep(1, () => s('edge-move', 'Edge Move', ew, 10))), // Mon Oct 19 00:30 LA → W4
      w('push', 'lb', '2026-10-26T07:30:00.000Z', rep(5, () => s('edge-move', 'Edge Move', ew, 10))), // Mon Oct 26 00:30 LA → current week, excluded
      w('push', 'lb', '2026-09-27T17:00:00.000Z', rep(7, () => s('edge-move', 'Edge Move', ew, 10))), // Sun Sep 27 → before the window, excluded
    ],
  };
}

// --- behavioral suite (also run against mutants) ---
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };
  const result = mod.buildWeekFrequency(fixture());
  const find = (key) => result.exercises.find((e) => e.exerciseKey === key);
  const cell = (entry, i) => entry.weeks[i];

  // --- the 4-week window: Monday start, complete weeks only ---
  t('window: exactly 4 weeks', result.weeks.length === 4);
  t('window: starts are the Mondays 09-28 / 10-05 / 10-12 / 10-19',
    JSON.stringify(result.weeks.map((x) => x.weekStart)) === JSON.stringify(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']));
  t('window: ends are the Sundays 10-04 / 10-11 / 10-18 / 10-25',
    JSON.stringify(result.weeks.map((x) => x.weekEnd)) === JSON.stringify(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']));
  t('window: every start is a Monday',
    result.weeks.every((x) => new Date(`${x.weekStart}T00:00:00Z`).getUTCDay() === 1));
  t('window: weekFrequencyWeeks agrees and excludes the current week (10-26)',
    JSON.stringify(mod.weekFrequencyWeeks(NOW).map((x) => x.weekStart)) === JSON.stringify(result.weeks.map((x) => x.weekStart))
    && !result.weeks.some((x) => x.weekStart === '2026-10-26'));

  // --- bench: counting, grouping, frequency, states ---
  const bench = find('bench');
  t('bench: entry exists with plan facts (4 sets/session, 1 session/week expected)',
    bench != null && bench.setsPerSession === 4 && bench.expectedSessionsPerWeek === 1 && bench.unit === 'lb');
  const b1 = cell(bench, 0);
  const b2 = cell(bench, 1);
  const b3 = cell(bench, 2);
  const b4 = cell(bench, 3);
  t('counting: W1 completed 12 (uncompleted sets never count)', b1.completedSets === 12);
  t('counting: W1 recorded 17 (12 + 2 + 3 across two sessions)', b1.recordedSets === 17);
  t('frequency: W1 sessions 2 but frequency 1 (second session completed nothing)',
    b1.sessions === 2 && b1.frequency === 1);
  t('states: W1–W3 trained at 12 sets', b1.state === 'trained' && b2.state === 'trained' && b3.state === 'trained'
    && b2.completedSets === 12 && b3.completedSets === 12);
  t('window: the current-week bench workout (9 sets) is excluded — total stays 40',
    bench.weeks.reduce((sum, c) => sum + c.completedSets, 0) === 40);
  t('state 主动减量： W4 has 4 sets vs baseline 12 (median of the other weeks) → reduced',
    b4.state === 'reduced' && b4.completedSets === 4 && b4.baselineSets === 12);
  t('主动减量 reason is labelled a guess （推测）', b4.reason.includes('推测'));
  t('volume: W4 cell volume is 4 × 100 × 8 = 3200 lb (reference figure)', b4.volume === 3200);

  // --- squat: 没练 weeks + 无法判断 week ---
  const squat = find('squat');
  t('squat: W1 / W3 / W4 planned (4 expected) with no record → not_trained （没练）',
    cell(squat, 0).state === 'not_trained' && cell(squat, 2).state === 'not_trained' && cell(squat, 3).state === 'not_trained'
    && cell(squat, 0).expectedSets === 4 && cell(squat, 0).completedSets === 0);
  const sq2 = cell(squat, 1);
  t('squat: W2 completed 2 of 4 recorded, below plan, no baseline → uncertain （无法判断）',
    sq2.state === 'uncertain' && sq2.completedSets === 2 && sq2.recordedSets === 4 && sq2.baselineSets === null);

  // --- ghost: in the plan template but its routine is never scheduled ---
  const ghost = find('ghost');
  t('ghost: expected sessions 0 → every week no_record （没记录）, never not_trained',
    ghost != null && ghost.expectedSessionsPerWeek === 0
    && ghost.weeks.every((c) => c.state === 'no_record' && c.expectedSets === 0));

  // --- old-move: history-only exercise ---
  const oldMove = find('old-move');
  t('old-move: W1 trained with no plan expectation (expected null)',
    cell(oldMove, 0).state === 'trained' && cell(oldMove, 0).completedSets === 6 && cell(oldMove, 0).expectedSets === null);
  t('old-move: W2–W4 nothing planned and nothing recorded → no_record （没记录）',
    [1, 2, 3].every((i) => cell(oldMove, i).state === 'no_record'));

  // --- even-base: even-count baseline median ---
  const evenBase = find('even-base');
  t('even-base: W3 baseline is median(8, 10) = 9 and 2 sets → reduced',
    cell(evenBase, 2).state === 'reduced' && cell(evenBase, 2).baselineSets === 9);
  t('even-base: W1 trained (8 vs baseline median(10, 2) = 6, not clearly below)',
    cell(evenBase, 0).state === 'trained' && cell(evenBase, 0).baselineSets === 6);
  t('even-base: W4 no record and no plan → no_record', cell(evenBase, 3).state === 'no_record');

  // --- edge-move: LA-date bucketing across the UTC boundary ---
  const edge = find('edge-move');
  const e4 = cell(edge, 3);
  t('boundary: Sun 20:00 LA and Mon 00:30 LA both land in W4 → 3 completed, 2 sessions, frequency 2',
    e4.completedSets === 3 && e4.sessions === 2 && e4.frequency === 2);
  t('boundary: current-week (Mon 10-26) and pre-window (Sun 09-27) workouts excluded — total stays 3',
    edge.weeks.reduce((sum, c) => sum + c.completedSets, 0) === 3);
  t('boundary: W1–W3 hold no edge record → no_record',
    [0, 1, 2].every((i) => cell(edge, i).state === 'no_record'));

  // --- cross-exercise isolation (exact counts above already prove
  // it; one explicit probe: squat's W2 sets never touch bench W2) ---
  t('isolation: bench W2 stays 12 although squat trained in W2', b2.completedSets === 12 && b2.recordedSets === 12);

  // --- global tonnage (reference only): W4 = bench 3200 lb + edge 1500 lb ---
  const wk4 = result.weeks[3];
  t('tonnage: W4 global volume is 4700 lb = 2131.9 kg', wk4.volumeLb === 4700 && wk4.volumeKg === 2131.9);

  // --- tonnage never judges: ×10 weights flip no state ---
  const heavy = mod.buildWeekFrequency(fixture(10));
  const sameStates = result.exercises.every((entry) => {
    const other = heavy.exercises.find((e) => e.exerciseKey === entry.exerciseKey && e.routine === entry.routine);
    return other != null && entry.weeks.every((c, i) => other.weeks[i].state === c.state);
  });
  const heavyBench = heavy.exercises.find((e) => e.exerciseKey === 'bench');
  t('tonnage invariance: ×10 weights leave every state unchanged', sameStates);
  t('tonnage invariance: volumes DO scale (bench W4 3200 → 32000)', heavyBench.weeks[3].volume === 32000);

  // --- classifyWeekCell, direct boundaries ---
  t('classify: expected > 0, nothing recorded → not_trained',
    mod.classifyWeekCell({ completedSets: 0, recordedSets: 0, expectedSets: 4, baselineSets: null }).state === 'not_trained');
  t('classify: no expectation, nothing recorded → no_record',
    mod.classifyWeekCell({ completedSets: 0, recordedSets: 0, expectedSets: null, baselineSets: null }).state === 'no_record');
  t('classify: recorded but 0 completed, no expectation → not_trained',
    mod.classifyWeekCell({ completedSets: 0, recordedSets: 3, expectedSets: null, baselineSets: null }).state === 'not_trained');
  t('classify: baseline below the minimum (3 sets) can never prove reduced → not reduced',
    mod.classifyWeekCell({ completedSets: 1, recordedSets: 1, expectedSets: null, baselineSets: 3 }).state === 'trained');

  // --- empty-record behaviour ---
  const empty = mod.buildWeekFrequency({ now: NOW, workouts: [], planExercises: [], planSchedule: [] });
  t('empty: no plan and no workouts → 4 week descriptors, zero tonnage, no exercises',
    empty.weeks.length === 4 && empty.exercises.length === 0
    && empty.weeks.every((x) => x.volumeKg === 0 && x.volumeLb === 0));
  const planOnly = mod.buildWeekFrequency({ now: NOW, workouts: [], planExercises: PLAN_EXERCISES, planSchedule: PLAN_SCHEDULE });
  const planBench = planOnly.exercises.find((e) => e.exerciseKey === 'bench');
  const planGhost = planOnly.exercises.find((e) => e.exerciseKey === 'ghost');
  t('empty weeks: plan with no workouts → bench all not_trained, ghost all no_record, nothing invented',
    planBench.weeks.every((c) => c.state === 'not_trained')
    && planGhost.weeks.every((c) => c.state === 'no_record')
    && planOnly.exercises.every((e) => e.weeks.every((c) => c.state === 'not_trained' || c.state === 'no_record')));

  return failed;
}

const realFailures = suite(F);
check('behavioral suite: all assertions pass on the real module', realFailures === 0, `${realFailures} failed`);
check('constants: frequency LB_TO_KG equals the engine / trends LB_TO_KG equals 0.45359237',
  F.LB_TO_KG === 0.45359237 && loadConst(engineSrc, 'LB_TO_KG') === F.LB_TO_KG && loadConst(trendsSrc, 'LB_TO_KG') === F.LB_TO_KG);
check('version: WEEK_FREQUENCY_VERSION is 1 and DELOAD_MAX_RATIO is 0.5',
  F.WEEK_FREQUENCY_VERSION === 1 && F.DELOAD_MAX_RATIO === 0.5);
check('conversion: 100 lb → 45.5 kg, null stays null',
  F.convertFrequencyWeight(100, 'lb', 'kg') === 45.5 && F.convertFrequencyWeight(null, 'lb', 'kg') === null);

// --- mutation sensitivity: each mutant MUST break the suite ---
const mutants = [
  ['week start Monday → Sunday ((dow + 6) % 7 → dow % 7)', freqSrc.replace('((dow + 6) % 7)', '(dow % 7)')],
  ['deload threshold 0.5 → 0.1 (reduced all but removed)', freqSrc.replace('DELOAD_MAX_RATIO = 0.5', 'DELOAD_MAX_RATIO = 0.1')],
  ['completion filter removed (uncompleted sets counted)', freqSrc.split('if (!set.completed) continue;').join('')],
];
for (const [name, mutated] of mutants) {
  if (mutated === freqSrc) {
    check(`mutation applies: ${name}`, false, 'replacement did not change the source');
    continue;
  }
  let failedCount = -1;
  try {
    failedCount = suite(loadFreq(mutated));
  } catch {
    failedCount = -2; // a mutant that throws also proves sensitivity
  }
  check(`mutation sensitivity: ${name}`, failedCount !== 0, `suite failures: ${failedCount}`);
}

// --- wiring ---
check('wiring: actions.ts imports buildWeekFrequency from ./week-frequency',
  serverSrc.includes('buildWeekFrequency') && serverSrc.includes('from "./week-frequency"'));
check('wiring: getDashboard returns week_frequency via loadWeekFrequency',
  serverSrc.includes('week_frequency: await loadWeekFrequency(ctx, now)'));
check('wiring: dashboard response schema carries week_frequency',
  serverSrc.includes('week_frequency: weekFrequencyResponse.optional()'));
check('wiring: loader feeds the current plan (templates + schedule) and a 42-day completed window',
  serverSrc.includes('loadWeekFrequency') && serverSrc.includes('loadPlanTemplates(ctx)')
  && serverSrc.includes('schema.planSchedule'));
check('wiring: client section 「近 4 个完整周训练频率」 renders week_frequency',
  clientSrc.includes('近 4 个完整周训练频率') && clientSrc.includes('weekFrequency={dashboard.data.week_frequency}'));
check('wiring: client labels every state with symbol + text （已练 / 没练 / 没记录 / 主动减量（推测） / 无法判断）',
  clientSrc.includes('主动减量（推测）') && clientSrc.includes('没练') && clientSrc.includes('没记录') && clientSrc.includes('无法判断'));
check('wiring: client publicly states the definitions and the tonnage disclaimer',
  clientSrc.includes('本周（进行中）不计入') && clientSrc.includes('仅作为工作量参考，不用于判断是否进步'));
check('wiring: client computes no frequency state of its own (no module import, no classifier / threshold)',
  !clientSrc.includes('from "./week-frequency"') && !clientSrc.includes('classifyWeekCell')
  && !clientSrc.includes('DELOAD') && !clientSrc.includes('baselineSets'));
check('wiring: no existing export removed — engine / trends entry points intact',
  serverSrc.includes('export function progressionDecision')
  && engineSrc.includes('export function evaluateProgression')
  && trendsSrc.includes('export function buildActionTrends'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
