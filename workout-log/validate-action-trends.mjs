// W3.3 validation — action-level trends （动作级趋势）.
// Evaluates the REAL production module (server/src/action-trends.ts,
// whole file, types stripped) over synthetic data only:
//  - completion rate / total reps / volume / best set, one worked
//    example each, all from the same fixture;
//  - the Epley (1985) estimated 1RM: 1RM = weight × (1 + reps/30),
//    eligible only for completed sets with weight > 0 and integer
//    reps in 1..12;
//  - bodyweight (weight 0 / null) and missing-weight sets never
//    participate in the 1RM or the best set — no fabricated PR;
//  - >12-rep sets still count toward reps / volume / best set but
//    never toward the 1RM; uncompleted sets count only as planned;
//  - cross-exercise isolation: one exercise's sets never leak into
//    another exercise's trend;
//  - unit conversion: mixed-unit history is converted into the
//    display unit (most recent session's unit) with LB_TO_KG and
//    0.5 rounding BEFORE any comparison, both directions;
//  - mutation sensitivity: four deliberate mutations of the module
//    source (Epley divisor, reps cap, bodyweight guard, completion
//    filter) must each make the behavioral suite fail;
//  - wiring: actions.ts imports the builder, getDashboard returns
//    action_trends, and the client renders the server figures with
//    the visible 「估算 1RM（Epley 公式）」 label while computing no
//    Epley estimate of its own.
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const trendsSrc = readFileSync(new URL('./server/src/action-trends.ts', import.meta.url), 'utf8');
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
function loadTrends(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { buildActionTrends, estimateOneRepMaxEpley, convertTrendWeight, ACTION_TRENDS_VERSION, LB_TO_KG };`,
  )();
}
function loadEngineLbToKg(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(`${code}\nreturn { LB_TO_KG };`)().LB_TO_KG;
}
const T = loadTrends(trendsSrc);

// --- synthetic builders ---
const s = (key, name, weight, reps, completed = true) => ({ exerciseKey: key, exerciseName: name, weight, reps, completed });
const w = (routine, unit, completedAt, sets) => ({ routine, unit, completedAt, sets });
const D1 = '2026-10-20T18:00:00.000Z';
const D2 = '2026-10-13T18:00:00.000Z';

// --- behavioral suite (also run against mutants) ---
// Returns the number of failed assertions; names are stable so a
// mutant's failures can be eyeballed against the real run.
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };
  const find = (entries, key) => entries.find((e) => e.exerciseKey === key);

  // --- worked example: completion rate / total reps / volume / best set / 1RM ---
  const bench = find(mod.buildActionTrends([
    w('push', 'lb', D1, [
      s('bench', 'Bench', 100, 8), s('bench', 'Bench', 100, 8),
      s('bench', 'Bench', 100, 6), s('bench', 'Bench', 100, 8, false),
    ]),
    w('push', 'lb', D2, [
      s('bench', 'Bench', 95, 8), s('bench', 'Bench', 95, 8),
      s('bench', 'Bench', 95, 8), s('bench', 'Bench', 95, 8),
    ]),
  ]), 'bench');
  t('worked example: entry exists', bench != null);
  t('completion rate: 7/8 planned = 0.88', bench.completionRate === 0.88
    && bench.completedSets === 7 && bench.plannedSets === 8);
  t('total reps: completed sets only (8+8+6 + 4×8 = 54)', bench.totalReps === 54);
  t('volume: Σ weight×reps over completed sets = 5240', bench.volume === 5240);
  t('best set: 100×8 (= 800) from the most recent session',
    bench.bestSet != null && bench.bestSet.weight === 100 && bench.bestSet.reps === 8
    && bench.bestSet.volume === 800 && bench.bestSet.date === D1);
  t('estimated 1RM: Epley best is 100×8 → 126.5',
    bench.estimatedOneRepMax != null && bench.estimatedOneRepMax.value === 126.5
    && bench.estimatedOneRepMax.weight === 100 && bench.estimatedOneRepMax.reps === 8);
  t('sessions / last date / version carried',
    bench.sessionCount === 2 && bench.lastDate === D1 && bench.trendsVersion === mod.ACTION_TRENDS_VERSION);

  // --- Epley formula, direct ---
  t('Epley: 100×10 → 133.5', mod.estimateOneRepMaxEpley(100, 10) === 133.5);
  t('Epley: 100×1 → 103.5', mod.estimateOneRepMaxEpley(100, 1) === 103.5);
  t('Epley: 60×12 → 84', mod.estimateOneRepMaxEpley(60, 12) === 84);
  t('Epley ineligible: 13 reps', mod.estimateOneRepMaxEpley(100, 13) === null);
  t('Epley ineligible: 0 reps', mod.estimateOneRepMaxEpley(100, 0) === null);
  t('Epley ineligible: non-integer reps', mod.estimateOneRepMaxEpley(100, 8.5) === null);
  t('Epley ineligible: bodyweight 0', mod.estimateOneRepMaxEpley(0, 8) === null);
  t('Epley ineligible: negative weight', mod.estimateOneRepMaxEpley(-5, 8) === null);
  t('Epley ineligible: missing weight', mod.estimateOneRepMaxEpley(null, 8) === null);
  t('Epley ineligible: missing reps', mod.estimateOneRepMaxEpley(100, null) === null);

  // --- bodyweight / missing weight never fabricate a best set or a PR ---
  const dips = find(mod.buildActionTrends([
    w('push', 'lb', D1, [
      s('dips', 'Dips', 0, 12), s('dips', 'Dips', null, 10), s('dips', 'Dips', 0, 15, false),
    ]),
  ]), 'dips');
  t('bodyweight: completion still counted (2/3, rate 0.67)',
    dips.completedSets === 2 && dips.plannedSets === 3 && dips.completionRate === 0.67);
  t('bodyweight: reps still counted (12+10 = 22)', dips.totalReps === 22);
  t('bodyweight: volume 0, best set null, 1RM null — no fake PR',
    dips.volume === 0 && dips.bestSet === null && dips.estimatedOneRepMax === null);

  // --- >12 reps: counts for reps/volume/best, never for the 1RM ---
  const raise = find(mod.buildActionTrends([
    w('push', 'lb', D1, [s('raise', 'Raise', 50, 15)]),
  ]), 'raise');
  t('>12 reps: volume 750 and best set 50×15',
    raise.volume === 750 && raise.bestSet != null && raise.bestSet.volume === 750);
  t('>12 reps: no 1RM estimate', raise.estimatedOneRepMax === null);

  // --- uncompleted heavy set is invisible to every figure but "planned" ---
  const row = find(mod.buildActionTrends([
    w('pull', 'lb', D1, [s('row', 'Row', 200, 5, false), s('row', 'Row', 80, 10)]),
  ]), 'row');
  t('uncompleted: planned 2 / completed 1',
    row.plannedSets === 2 && row.completedSets === 1 && row.completionRate === 0.5);
  t('uncompleted: 200×5 ignored — best set is 80×10, volume 800',
    row.bestSet != null && row.bestSet.weight === 80 && row.volume === 800);

  // --- cross-exercise isolation ---
  const mixed = mod.buildActionTrends([
    w('push', 'lb', D1, [s('bench', 'Bench', 100, 8), s('fly', 'Fly', 300, 3)]),
    w('push', 'lb', D2, [s('bench', 'Bench', 90, 8)]),
  ]);
  const benchOnly = find(mixed, 'bench');
  const flyOnly = find(mixed, 'fly');
  t('cross-exercise: bench ignores the fly 300×3 (best 100×8, volume 1520)',
    benchOnly.bestSet != null && benchOnly.bestSet.weight === 100 && benchOnly.volume === 1520);
  t('cross-exercise: fly keeps only its own sets (planned 1, best 300×3)',
    flyOnly.plannedSets === 1 && flyOnly.bestSet != null && flyOnly.bestSet.weight === 300);

  // --- unit conversion before comparison, both directions ---
  t('convert: 100 lb → 45.5 kg', mod.convertTrendWeight(100, 'lb', 'kg') === 45.5);
  t('convert: 60 kg → 132.5 lb', mod.convertTrendWeight(60, 'kg', 'lb') === 132.5);
  t('convert: null stays null, same unit is identity',
    mod.convertTrendWeight(null, 'lb', 'kg') === null && mod.convertTrendWeight(100, 'lb', 'lb') === 100);
  const squatLb = find(mod.buildActionTrends([
    w('legs', 'lb', D1, [s('squat', 'Squat', 100, 8)]),
    w('legs', 'kg', D2, [s('squat', 'Squat', 60, 10)]),
  ]), 'squat');
  t('mixed units (display lb): kg set converted to 132.5 before comparing',
    squatLb.unit === 'lb' && squatLb.bestSet != null && squatLb.bestSet.weight === 132.5
    && squatLb.bestSet.date === D2);
  t('mixed units (display lb): volume 800 + 1325 = 2125', squatLb.volume === 2125);
  t('mixed units (display lb): 1RM from the converted set = 176.5',
    squatLb.estimatedOneRepMax != null && squatLb.estimatedOneRepMax.value === 176.5);
  const squatKg = find(mod.buildActionTrends([
    w('legs', 'kg', D1, [s('squat', 'Squat', 50, 10)]),
    w('legs', 'lb', D2, [s('squat', 'Squat', 100, 8)]),
  ]), 'squat');
  t('mixed units (display kg): lb set converted to 45.5 — volume 864, 1RM 66.5 from the kg set',
    squatKg.unit === 'kg' && squatKg.volume === 864
    && squatKg.estimatedOneRepMax != null && squatKg.estimatedOneRepMax.value === 66.5);

  // --- empty shapes ---
  t('empty input → no entries', mod.buildActionTrends([]).length === 0);
  t('workout without sets → no entries', mod.buildActionTrends([w('push', 'lb', D1, [])]).length === 0);

  return failed;
}

const realFailures = suite(T);
check('behavioral suite: all assertions pass on the real module', realFailures === 0, `${realFailures} failed`);
check('constants: trends LB_TO_KG equals the engine LB_TO_KG equals 0.45359237',
  T.LB_TO_KG === 0.45359237 && loadEngineLbToKg(engineSrc) === T.LB_TO_KG);
check('version: ACTION_TRENDS_VERSION is 1', T.ACTION_TRENDS_VERSION === 1);

// --- mutation sensitivity: each mutant MUST break the suite ---
const mutants = [
  ['Epley divisor 30 → 20', trendsSrc.replace('weight * (1 + reps / 30)', 'weight * (1 + reps / 20)')],
  ['1RM reps cap 12 → 30', trendsSrc.replace('reps > 12', 'reps > 30')],
  ['bodyweight guard weight <= 0 → weight < 0', trendsSrc.replace('weight <= 0', 'weight < 0')],
  ['completion filter removed (uncompleted sets counted)', trendsSrc.replace('if (!set.completed) continue;', '')],
];
for (const [name, mutated] of mutants) {
  if (mutated === trendsSrc) {
    check(`mutation applies: ${name}`, false, 'replacement did not change the source');
    continue;
  }
  let failedCount = -1;
  try {
    failedCount = suite(loadTrends(mutated));
  } catch {
    failedCount = -2; // a mutant that throws also proves sensitivity
  }
  check(`mutation sensitivity: ${name}`, failedCount !== 0, `suite failures: ${failedCount}`);
}

// --- wiring ---
check('wiring: actions.ts imports buildActionTrends from ./action-trends',
  serverSrc.includes('buildActionTrends') && serverSrc.includes('from "./action-trends"'));
check('wiring: getDashboard returns action_trends via loadActionTrends',
  serverSrc.includes('action_trends: await loadActionTrends(ctx)'));
check('wiring: dashboard response schema carries action_trends with estimated_one_rep_max',
  serverSrc.includes('action_trends: z.array(actionTrendEntryResponse).optional()')
  && serverSrc.includes('estimated_one_rep_max'));
check('wiring: loader reuses the per-routine completed windows (loadRoutineRecentCompleted)',
  serverSrc.includes('loadActionTrends') && serverSrc.includes('loadRoutineRecentCompleted(ctx, routine)'));
check('wiring: client consumes dashboard action_trends',
  clientSrc.includes('actionTrends={dashboard.data.action_trends}'));
check('wiring: client labels the estimate 「估算 1RM（Epley 公式）」 visibly',
  clientSrc.includes('估算 1RM（Epley 公式）'));
check('wiring: client computes no Epley estimate of its own',
  !clientSrc.includes('estimateOneRepMax') && !clientSrc.includes('reps / 30'));
check('wiring: no existing export removed — progressionDecision adapter and engine entry points intact',
  serverSrc.includes('export function progressionDecision')
  && engineSrc.includes('export function evaluateProgression')
  && engineSrc.includes('export function convertEngineWeight'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
