// W4.1 validation — plan template versioning.
// Evaluates the REAL production module (server/src/plan-versioning.ts,
// whole file, types stripped) over synthetic data only, plus
// source-wiring checks for the server plumbing (updatePlan archive
// batch / startWorkout snapshot binding / getDashboard + getPlan
// version fields) and the client (editor unit+rest fields, version
// list, rest-timer default):
//
//  - validateRestSeconds rejects non-integers and out-of-range
//    values (never clamps); null/undefined means "no custom default";
//  - computeVersionMigration: first save lands at v1 with no
//    archive; later saves archive the outgoing rows verbatim stamped
//    with the old version and stamp new rows with the new version;
//  - bindSessionSnapshot expands per-exercise sets and carries the
//    name/target/rest snapshot; resolveHistoryDisplay always renders
//    the session snapshot, never the live template (history cannot
//    be rewritten by a rename);
//  - buildVersionList sorts newest-first and marks the live version
//    current;
//  - mutation sensitivity: M1 (drop version stamping) and M2 (render
//    live template values instead of the snapshot) must each flip
//    the corresponding assertions.
//
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleSrc = readFileSync(new URL('./server/src/plan-versioning.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('./drizzle/0012_plan_versioning.sql', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function loadModule(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { PLAN_VERSION_FIRST, REST_SECONDS_MIN, REST_SECONDS_MAX, validateRestSeconds, normalizeRestSeconds, validatePlanUnit, normalizePlanUnit, stampPlanAtVersion, computeVersionMigration, bindSessionSnapshot, resolveHistoryDisplay, buildVersionList };`,
  )();
}

const M = loadModule(moduleSrc);
const {
  PLAN_VERSION_FIRST, REST_SECONDS_MIN, REST_SECONDS_MAX,
  validateRestSeconds, normalizeRestSeconds, validatePlanUnit, normalizePlanUnit,
  stampPlanAtVersion, computeVersionMigration, bindSessionSnapshot,
  resolveHistoryDisplay, buildVersionList,
} = M;

// ---------- rest seconds validation ----------
check('rest: null/undefined = no custom default', validateRestSeconds(null) === null && validateRestSeconds(undefined) === null);
check('rest: 15 and 600 accepted', validateRestSeconds(15) === null && validateRestSeconds(600) === null);
check('rest: 14 rejected', validateRestSeconds(14) !== null);
check('rest: 601 rejected', validateRestSeconds(601) !== null);
check('rest: non-integer rejected (never clamped)', validateRestSeconds(30.5) !== null);
check('rest: string rejected', validateRestSeconds('60') !== null);
check('rest: bounds constants are 15/600', REST_SECONDS_MIN === 15 && REST_SECONDS_MAX === 600);
check('normalizeRestSeconds: null stays null, 90 stays 90', normalizeRestSeconds(null) === null && normalizeRestSeconds(90) === 90);

// ---------- unit ----------
check('unit: lb/kg valid, else invalid', validatePlanUnit('lb') && validatePlanUnit('kg') && !validatePlanUnit('lbs') && !validatePlanUnit(''));
check('normalizePlanUnit: unknown falls back to lb', normalizePlanUnit('lbs') === 'lb' && normalizePlanUnit(undefined) === 'lb' && normalizePlanUnit('kg') === 'kg');

// ---------- version migration ----------
const exV1 = [
  { routine: 'push', sortOrder: 0, exerciseKey: 'bench', exerciseName: '卧推', sets: 4, targetReps: '6–8', unit: 'lb', restSeconds: 90 },
];
const schV1 = [{ dayIndex: 0, routineCode: 'push', note: '' }];

const mig1 = computeVersionMigration({
  oldVersion: 0, oldExercises: [], oldSchedule: [],
  newExercises: exV1, newSchedule: schV1, createdAt: new Date('2026-11-02T00:00:00Z'), note: '',
});
check('migration: first save lands at v1', mig1.newVersion === 1 && mig1.stamped.version === 1);
check('migration: first save archives nothing', mig1.exerciseHistory.length === 0 && mig1.scheduleHistory.length === 0);
check('migration: new rows stamped v1', mig1.stamped.exercises[0].version === 1 && mig1.stamped.schedule[0].version === 1);
check('migration: version registry row registered', mig1.stamped.versionRow.version === 1);

const exV2 = [
  { routine: 'push', sortOrder: 0, exerciseKey: 'bench', exerciseName: '杠铃卧推·改名', sets: 5, targetReps: '5–8', unit: 'kg', restSeconds: 120 },
];
const mig2 = computeVersionMigration({
  oldVersion: 1, oldExercises: exV1, oldSchedule: schV1,
  newExercises: exV2, newSchedule: schV1, createdAt: new Date('2026-11-03T00:00:00Z'), note: '',
});
check('migration: second save lands at v2', mig2.newVersion === 2);
check('migration: old rows archived verbatim stamped v1', mig2.exerciseHistory.length === 1
  && mig2.exerciseHistory[0].version === 1
  && mig2.exerciseHistory[0].exerciseName === '卧推'
  && mig2.exerciseHistory[0].restSeconds === 90);
check('migration: schedule archived stamped v1', mig2.scheduleHistory.length === 1 && mig2.scheduleHistory[0].version === 1);
check('migration: new rows stamped v2', mig2.stamped.exercises[0].version === 2 && mig2.stamped.exercises[0].unit === 'kg');

// ---------- session snapshot ----------
const bound = bindSessionSnapshot(
  [{ exerciseKey: 'bench', exerciseName: '卧推', targetReps: '6–8', restSeconds: 90, sets: 2 }],
  1,
);
check('snapshot: workout binds template version', bound.planVersion === 1);
check('snapshot: sets expanded per exercise.sets', bound.sets.length === 2);
check('snapshot: name/target/rest carried into every set row',
  bound.sets.every((s) => s.exerciseName === '卧推' && s.targetReps === '6–8' && s.restSeconds === 90));

// ---------- history display guard ----------
const disp = resolveHistoryDisplay({
  snapshotName: '卧推', snapshotTargetReps: '6–8', snapshotRestSeconds: 90,
  liveName: '杠铃卧推·改名', liveTargetReps: '5–8', liveRestSeconds: 120,
});
check('history: renders the session snapshot even when the live template was renamed',
  disp.name === '卧推' && disp.targetReps === '6–8' && disp.restSeconds === 90);

// ---------- version list ----------
const list = buildVersionList(
  [{ version: 1, createdAt: '2026-11-02T00:00:00Z', note: '' }, { version: 2, createdAt: '2026-11-03T00:00:00Z', note: '' }],
  2,
);
check('version list: newest first, live marked current',
  list[0].version === 2 && list[0].current === true && list[1].version === 1 && list[1].current === false);

// ---------- source wiring ----------
check('wiring: actions.ts imports plan-versioning', serverSrc.includes('from "./plan-versioning"'));
check('wiring: updatePlan archives into history tables', serverSrc.includes('schema.planExerciseHistory') && serverSrc.includes('schema.planScheduleHistory'));
check('wiring: updatePlan registers the new version', serverSrc.includes('schema.planVersions'));
check('wiring: startWorkout stamps planVersion on the workout row', serverSrc.includes('planVersion: templateVersion'));
check('wiring: startWorkout snapshots restSeconds into set rows', serverSrc.includes('restSeconds: exercise.restSeconds'));
check('wiring: getPlan returns plan_version + plan_versions', serverSrc.includes('plan_version: liveVersion') && serverSrc.includes('plan_versions: buildVersionList'));
check('schema: plan_versions / plan_exercise_history / plan_schedule_history tables',
  schemaSrc.includes('plan_versions') && schemaSrc.includes('plan_exercise_history') && schemaSrc.includes('plan_schedule_history'));
check('schema: plan_exercises carries version + unit + rest_seconds',
  schemaSrc.includes('version: integer("version")') && schemaSrc.includes('restSeconds: integer("rest_seconds")'));
check('schema: workouts carries plan_version', schemaSrc.includes('planVersion: integer("plan_version")'));
check('migration 0012: creates 3 tables + 6 additive columns, backfills v1',
  migrationSrc.includes('CREATE TABLE plan_versions') && migrationSrc.includes('ADD COLUMN rest_seconds INTEGER')
  && migrationSrc.includes('W4.1 migration backfill'));
check('client: editor has unit + rest-seconds fields', clientSrc.includes('plan-field-unit') && clientSrc.includes('plan-field-rest'));
check('client: PlanVersionList renders current/read-only marks', clientSrc.includes('function PlanVersionList') && clientSrc.includes('模板版本'));
check('client: rest timer adopts the snapshot default', clientSrc.includes('setRestDuration(state, plannedRestSeconds)'));

// ---------- mutation sensitivity (must flip) ----------
function mutatedStamping() {
  // M1: drop the version stamp — new rows lose their version.
  const src = moduleSrc.replace('exercises: exercises.map((e) => ({ ...e, version }))',
    'exercises: exercises.map((e) => ({ ...e }))');
  return loadModule(src);
}
function mutatedHistoryRewrite() {
  // M2: history renders live template values instead of the snapshot.
  const src = moduleSrc.replace('    name: input.snapshotName,\n    targetReps: input.snapshotTargetReps,\n    restSeconds: input.snapshotRestSeconds,',
    '    name: input.liveName ?? input.snapshotName,\n    targetReps: input.liveTargetReps ?? input.snapshotTargetReps,\n    restSeconds: input.liveRestSeconds ?? input.snapshotRestSeconds,');
  return loadModule(src);
}
const M1 = mutatedStamping();
const m1 = M1.computeVersionMigration({
  oldVersion: 0, oldExercises: [], oldSchedule: [],
  newExercises: exV1, newSchedule: schV1, createdAt: new Date(), note: '',
});
check('MUTATION M1 (drop version stamp): new-row version assertion flips',
  m1.stamped.exercises[0].version !== 1);
const M2 = mutatedHistoryRewrite();
const d2 = M2.resolveHistoryDisplay({
  snapshotName: '卧推', snapshotTargetReps: '6–8', snapshotRestSeconds: 90,
  liveName: '杠铃卧推·改名', liveTargetReps: '5–8', liveRestSeconds: 120,
});
check('MUTATION M2 (history rewrite): snapshot assertion flips', d2.name !== '卧推');

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
