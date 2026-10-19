// W-MIG-004 / W-PLAN-SAFE-001 validation. Run with:
//   bun validate-plan-safe.mjs
// (bun, because it imports the real TypeScript server module.)
//
// Coverage:
//  A. Migration hazard reproduction: the 0004 parent-table rebuild
//     (drop + rename) executed with foreign_keys = ON deletes every
//     workout_sets child row — the exact failure PM reproduced.
//  B. Migration 0005 under foreign_keys = ON: the child-preservation
//     rebuild keeps every workout and every set with its original id,
//     foreign_key_check stays empty, the completed_at index and the
//     home-routine CHECK survive, plan_meta is created and backfilled
//     for a database that already holds a (customized) plan, and the
//     (routine, exercise_key) unique index exists.
//  C. Real handlers (imported from server/src/actions.ts) over a
//     real drizzle db on an in-memory libsql database migrated with
//     the real drizzle/*.sql sequence:
//     - concurrent first-open seeds produce exactly one template and
//       one marker; a poisoned statement at EVERY position of the
//       seed batch leaves zero rows and no marker, and a retry then
//       seeds cleanly (seed atomicity + idempotency);
//     - updatePlan with a poisoned statement at EVERY position of
//       its batch returns a retryable ok:false and the previous plan
//       is read back byte-identical (replace atomicity);
//     - two concurrent updatePlans never mix: the stored plan is
//       exactly one of the two submitted plans;
//     - a getPlan issued while a save is in flight reads the complete
//       old plan, and after the save the complete new one;
//     - a legal save round-trips exactly through getPlan;
//     - non-owner and viewer-less callers get forbidden responses
//       with zero writes (including no seeding on a fresh database);
//     - emptying the plan tables by hand does NOT re-trigger the
//       seed (the plan_meta marker, not table emptiness, decides);
//     - updatePlan never touches workouts, workout_sets or
//       daily_completions; a completion recorded before a save is
//       still there after it.
// Synthetic data only.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');
const { drizzle } = require('drizzle-orm/libsql');
const { sql } = require('drizzle-orm');

const { Actions, DEFAULT_PLAN_TEMPLATES, DEFAULT_PLAN_SCHEDULE, DEFAULT_DAILY_ITEMS } =
  await import('./server/src/actions.ts');
const schema = await import('./server/src/schema.ts');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

const MIGRATION_FILES = readdirSync(new URL('./drizzle', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort();
check('migrations: sequence 0001..0005 present',
  MIGRATION_FILES.length === 5 && MIGRATION_FILES[4].startsWith('0005_'),
  MIGRATION_FILES.join(','));

async function applyMigrations(client, files) {
  for (const file of files) {
    const content = readFileSync(new URL(`./drizzle/${file}`, import.meta.url), 'utf8');
    for (const chunk of content.split('--> statement-breakpoint')) {
      const stmt = chunk.trim();
      if (stmt) await client.execute(stmt);
    }
  }
}
async function scalar(client, stmt) {
  const rs = await client.execute(stmt);
  return rs.rows[0][0];
}
async function insertWorkoutWithSets(client, routine, setCount) {
  const w = await client.execute({
    sql: 'INSERT INTO workouts (routine, unit, started_at, completed_at) VALUES (?, ?, ?, ?) RETURNING id',
    args: [routine, 'lb', 1700000000000, 1700003600000],
  });
  const workoutId = w.rows[0][0];
  for (let i = 1; i <= setCount; i++) {
    await client.execute({
      sql: `INSERT INTO workout_sets (workout_id, exercise_key, exercise_name, set_number, target_reps, weight, reps, completed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [workoutId, `ex-${i}`, `动作 ${i}`, i, '8–10', 100, 8, 1, 1700000000000, 1700000000000],
    });
  }
  return workoutId;
}

// ---------- A. 0004 hazard reproduction (foreign_keys = ON) ----------
{
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = ON');
  await applyMigrations(client, MIGRATION_FILES.slice(0, 3));
  await insertWorkoutWithSets(client, 'push', 3);
  check('A setup: 3 sets exist before 0004', (await scalar(client, 'SELECT COUNT(*) FROM workout_sets')) === 3);
  await applyMigrations(client, MIGRATION_FILES.slice(3, 4));
  check('A hazard: 0004 rebuild under foreign_keys=ON keeps the parent row',
    (await scalar(client, 'SELECT COUNT(*) FROM workouts')) === 1);
  check('A hazard: 0004 rebuild under foreign_keys=ON deletes ALL child sets (the P0)',
    (await scalar(client, 'SELECT COUNT(*) FROM workout_sets')) === 0);
  client.close();
}

// ---------- B. 0005 child-preservation rebuild (foreign_keys = ON) ----------
{
  const client = createClient({ url: ':memory:' });
  // Mirror the real platform runner for 0001..0004 (foreign_keys OFF
  // inside the migration unit), so the pre-0005 state holds data.
  await client.execute('PRAGMA foreign_keys = OFF');
  await applyMigrations(client, MIGRATION_FILES.slice(0, 4));
  const w1 = await insertWorkoutWithSets(client, 'push', 4);
  const w2 = await insertWorkoutWithSets(client, 'home_posture', 3);
  // A customized pre-existing plan: push WITHOUT the default 'dips'
  // row — the 0005 marker backfill must preserve it exactly.
  await client.execute(`INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES ('push', 0, 'barbell-bench', '杠铃卧推', 4, '6–8')`);
  await client.execute(`INSERT INTO plan_schedule (day_index, routine_code, note) VALUES (1, 'push', '')`);
  await client.execute(`INSERT INTO plan_daily_items (item_key, title, detail, sort_order) VALUES ('daily-chin-tuck', '收下巴 Chin Tuck', '', 0)`);
  const setIdsBefore = (await client.execute('SELECT id FROM workout_sets ORDER BY id')).rows.map((r) => r[0]);
  check('B setup: 7 sets across 2 workouts before 0005', setIdsBefore.length === 7, `w1=${w1} w2=${w2}`);

  await client.execute('PRAGMA foreign_keys = ON');
  await applyMigrations(client, MIGRATION_FILES.slice(4, 5));

  check('B: workouts preserved', (await scalar(client, 'SELECT COUNT(*) FROM workouts')) === 2);
  check('B: every set preserved under foreign_keys=ON',
    (await scalar(client, 'SELECT COUNT(*) FROM workout_sets')) === 7);
  const setIdsAfter = (await client.execute('SELECT id FROM workout_sets ORDER BY id')).rows.map((r) => r[0]);
  check('B: set ids identical before/after', JSON.stringify(setIdsAfter) === JSON.stringify(setIdsBefore));
  check('B: foreign_key_check is empty',
    (await client.execute('PRAGMA foreign_key_check')).rows.length === 0);
  check('B: workouts_completed_at_idx recreated',
    (await scalar(client, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='workouts_completed_at_idx'`)) === 1);
  check('B: plan_meta marker backfilled for the pre-existing plan',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='seeded'`)) === '1');
  check('B: customized plan rows untouched by 0005 (no default re-added)',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')) === 1);
  check('B: (routine, exercise_key) unique index exists',
    (await scalar(client, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='plan_exercises_routine_key_idx'`)) === 1);
  let bogusRejected = false;
  try {
    await client.execute(`INSERT INTO workouts (routine, unit, started_at) VALUES ('bogus', 'lb', 1)`);
  } catch { bogusRejected = true; }
  check('B: routine CHECK still rejects unknown routines', bogusRejected);
  await client.execute(`INSERT INTO workouts (routine, unit, started_at) VALUES ('home_snowboard', 'lb', 1)`);
  check('B: routine CHECK still accepts home_snowboard',
    (await scalar(client, `SELECT COUNT(*) FROM workouts WHERE routine='home_snowboard'`)) === 1);
  check('B: backup and guard tables are gone afterwards',
    (await scalar(client, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('workout_sets_backup_0005', '_child_preservation_guard', 'workouts_new')`)) === 0);
  client.close();
}

// ---------- C. Real handlers over a migrated in-memory database ----------
const EXPECTED_EXERCISES = Object.values(DEFAULT_PLAN_TEMPLATES).reduce((n, list) => n + list.length, 0);

async function freshHandlerDb() {
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = ON');
  await applyMigrations(client, MIGRATION_FILES);
  const realDb = drizzle(client, { schema });
  const hook = { failAt: null, delayMs: 0 };
  const wrappedDb = new Proxy(realDb, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (items) => {
          if (hook.delayMs) await new Promise((r) => setTimeout(r, hook.delayMs));
          if (hook.failAt != null) {
            const poison = target.run(sql`SELECT * FROM table_that_does_not_exist`);
            const next = [...items];
            next.splice(hook.failAt, 0, poison);
            return target.batch(next);
          }
          return target.batch(items);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const makeCtx = (viewer) => ({ db: () => wrappedDb, viewer, invalidateQueries: () => {} });
  const owner = () => makeCtx({ source: 'local', authenticated: true, spaceSlug: 'space-6', userId: 'o', ownerUserId: 'o', isOwner: true });
  const guest = () => makeCtx({ source: 'local', authenticated: true, spaceSlug: 'space-6', userId: 'g', ownerUserId: 'o', isOwner: false });
  const anon = () => makeCtx(undefined);
  return { client, hook, owner, guest, anon };
}
const planPayload = (plan) => JSON.stringify({ routines: plan.routines, schedule: plan.schedule, daily_items: plan.daily_items });
const asUpdateArgs = (plan) => ({ routines: plan.routines, schedule: plan.schedule, daily_items: plan.daily_items });
function variantOf(plan, tag) {
  const copy = JSON.parse(planPayload(plan));
  copy.routines[0].exercises[0].name = `${copy.routines[0].exercises[0].name}·${tag}`;
  copy.schedule[0].note = `备注·${tag}`;
  copy.daily_items[0].title = `${copy.daily_items[0].title}·${tag}`;
  return copy;
}

// C1: non-owner / viewer-less callers — forbidden, zero writes, no seed.
{
  const { client, owner, guest, anon } = await freshHandlerDb();
  const g = await Actions.getPlan.handler(guest(), {});
  check('C1: guest getPlan is forbidden', g.forbidden === true);
  const a = await Actions.getPlan.handler(anon(), {});
  check('C1: viewer-less getPlan is forbidden (plan surface has no sync exception)', a.forbidden === true);
  check('C1: forbidden reads wrote nothing (no seed, no marker)',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')) === 0
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_schedule')) === 0
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_daily_items')) === 0
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_meta')) === 0);
  const seeded = await Actions.getPlan.handler(owner(), {});
  check('C1: owner first open seeds and reads the default plan',
    seeded.forbidden === false && planPayload(seeded).length > 0);
  const before = planPayload(await Actions.getPlan.handler(owner(), {}));
  const gu = await Actions.updatePlan.handler(guest(), asUpdateArgs(variantOf(seeded, '客')));
  check('C1: guest updatePlan is forbidden', gu.ok === false && gu.forbidden === true);
  const gt = await Actions.toggleDailyItem.handler(guest(), { date_key: seeded.daily_date, item_key: seeded.daily_items[0].key, done: true });
  check('C1: guest toggleDailyItem is forbidden', gt.ok === false && gt.forbidden === true);
  check('C1: plan unchanged after forbidden writes',
    planPayload(await Actions.getPlan.handler(owner(), {})) === before);
  check('C1: forbidden toggle wrote no completion rows',
    (await scalar(client, 'SELECT COUNT(*) FROM daily_completions')) === 0);
  client.close();
}

// C2: concurrent first-open seeds + seed-batch failure injection.
{
  const { client, hook, owner } = await freshHandlerDb();
  // Poison every position of the seed batch (4 statements + tail):
  // each attempt must fail as a whole — zero rows, no marker.
  for (let failAt = 0; failAt <= 4; failAt++) {
    hook.failAt = failAt;
    let threw = false;
    try {
      await Actions.getPlan.handler(owner(), {});
    } catch { threw = true; }
    check(`C2: seed failure at batch position ${failAt} propagates`, threw);
    check(`C2: seed failure at batch position ${failAt} leaves zero rows and no marker`,
      (await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')) === 0
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_schedule')) === 0
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_daily_items')) === 0
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_meta')) === 0);
  }
  hook.failAt = null;
  const [p1, p2] = await Promise.all([
    Actions.getPlan.handler(owner(), {}),
    Actions.getPlan.handler(owner(), {}),
  ]);
  check('C2: two concurrent first opens both succeed', p1.forbidden === false && p2.forbidden === false);
  check('C2: concurrent seeds converge to exactly one template copy',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')) === EXPECTED_EXERCISES
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_schedule')) === DEFAULT_PLAN_SCHEDULE.length
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_daily_items')) === DEFAULT_DAILY_ITEMS.length,
    `exercises=${await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')}`);
  check('C2: exactly one seed marker', (await scalar(client, 'SELECT COUNT(*) FROM plan_meta')) === 1);
  check('C2: both concurrent readers see the identical complete plan', planPayload(p1) === planPayload(p2));
  client.close();
}

// C3: updatePlan failure injection at every batch position.
{
  const { client, hook, owner } = await freshHandlerDb();
  const original = await Actions.getPlan.handler(owner(), {});
  const originalPayload = planPayload(original);
  const planB = variantOf(original, '乙');
  for (let failAt = 0; failAt <= 7; failAt++) {
    hook.failAt = failAt;
    const res = await Actions.updatePlan.handler(owner(), asUpdateArgs(planB));
    check(`C3: save failure at batch position ${failAt} returns retryable ok:false (no throw)`,
      res.ok === false && res.forbidden === false && typeof res.error === 'string' && res.error.length > 0);
    hook.failAt = null;
    const after = await Actions.getPlan.handler(owner(), {});
    check(`C3: save failure at batch position ${failAt} leaves the old plan byte-identical`,
      planPayload(after) === originalPayload);
    hook.failAt = failAt;
  }
  hook.failAt = null;
  const okRes = await Actions.updatePlan.handler(owner(), asUpdateArgs(planB));
  check('C3: the same save succeeds once failures stop (retryable)', okRes.ok === true);
  const readBack = await Actions.getPlan.handler(owner(), {});
  check('C3: legal save round-trips exactly through getPlan',
    planPayload(readBack) === planPayload(planB));
  client.close();
}

// C4: concurrent updatePlans never mix; reads during a save see a
// complete plan (old, then new — never empty or half).
{
  const { hook, owner } = await freshHandlerDb();
  const base = await Actions.getPlan.handler(owner(), {});
  const planB = variantOf(base, '乙');
  const planC = variantOf(base, '丙');
  hook.delayMs = 40;
  const [r1, r2] = await Promise.all([
    Actions.updatePlan.handler(owner(), asUpdateArgs(planB)),
    Actions.updatePlan.handler(owner(), asUpdateArgs(planC)),
  ]);
  hook.delayMs = 0;
  check('C4: both concurrent saves report success', r1.ok === true && r2.ok === true);
  const finalPlan = planPayload(await Actions.getPlan.handler(owner(), {}));
  check('C4: final plan is exactly one submitted plan, never a mix',
    finalPlan === planPayload(planB) || finalPlan === planPayload(planC));

  const planD = variantOf(base, '丁');
  hook.delayMs = 80;
  const savePromise = Actions.updatePlan.handler(owner(), asUpdateArgs(planD));
  await new Promise((r) => setTimeout(r, 20));
  const during = await Actions.getPlan.handler(owner(), {});
  check('C4: getPlan during an in-flight save reads the complete previous plan',
    planPayload(during) === finalPlan);
  const saveRes = await savePromise;
  hook.delayMs = 0;
  check('C4: the in-flight save then lands', saveRes.ok === true);
  check('C4: getPlan after the save reads the complete new plan',
    planPayload(await Actions.getPlan.handler(owner(), {})) === planPayload(planD));
}

// C5: marker (not emptiness) decides seeding; updatePlan leaves
// workouts, sets and daily_completions untouched.
{
  const { client, owner } = await freshHandlerDb();
  const plan = await Actions.getPlan.handler(owner(), {});
  const itemKey = plan.daily_items[0].key;
  const toggle = await Actions.toggleDailyItem.handler(owner(), { date_key: plan.daily_date, item_key: itemKey, done: true });
  check('C5: owner toggleDailyItem succeeds', toggle.ok === true);
  await insertWorkoutWithSets(client, 'push', 5);
  const workoutsBefore = await scalar(client, 'SELECT COUNT(*) FROM workouts');
  const setsBefore = await scalar(client, 'SELECT COUNT(*) FROM workout_sets');

  const planB = variantOf(plan, '乙');
  const save = await Actions.updatePlan.handler(owner(), asUpdateArgs(planB));
  check('C5: save succeeds', save.ok === true);
  check('C5: updatePlan did not touch workouts or sets',
    (await scalar(client, 'SELECT COUNT(*) FROM workouts')) === workoutsBefore
    && (await scalar(client, 'SELECT COUNT(*) FROM workout_sets')) === setsBefore);
  check('C5: daily_completions history survives the save',
    (await scalar(client, 'SELECT COUNT(*) FROM daily_completions')) === 1);
  const after = await Actions.getPlan.handler(owner(), {});
  check('C5: completion still reported after the save', after.daily_done.includes(itemKey));

  await client.execute('DELETE FROM plan_exercises');
  await client.execute('DELETE FROM plan_schedule');
  await client.execute('DELETE FROM plan_daily_items');
  const emptied = await Actions.getPlan.handler(owner(), {});
  check('C5: emptied plan tables are NOT re-seeded (marker decides, not emptiness)',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')) === 0
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_schedule')) === 0
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_daily_items')) === 0
    && (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='seeded'`)) === 1
    && emptied.forbidden === false);
  client.close();
}

// C6: startWorkout seeds through the same marker path on a fresh db.
{
  const { client, owner } = await freshHandlerDb();
  const started = await Actions.startWorkout.handler(owner(), { routine: 'home_posture', unit: 'lb' });
  const expectedSets = DEFAULT_PLAN_TEMPLATES.home_posture.reduce((n, e) => n + e.sets, 0);
  check('C6: startWorkout on a fresh database seeds and starts',
    started.forbidden === false && started.workout !== null && started.workout.sets.length === expectedSets,
    `sets=${started.workout?.sets.length} expected=${expectedSets}`);
  check('C6: seed marker written by the startWorkout path',
    (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='seeded'`)) === 1);
  client.close();
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
