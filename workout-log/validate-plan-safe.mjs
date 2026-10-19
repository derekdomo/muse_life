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
//     - the internal plan version token starts at '0' on seed,
//       increments by exactly 1 per successful save (never on a
//       failed or forbidden one), and is never exposed in responses;
//     - PM counterexample (a): a controlled adapter lets a legal
//       updatePlan land right after getPlan has read the first plan
//       table — the raced getPlan must return the whole old version
//       or the whole new one, never old exercises + new schedule;
//     - PM counterexample (b): the seed's pre-check passes, then the
//       seed batch is paused and a first legal user save lands
//       first — when the seed resumes, its guarded inserts write
//       zero rows: the user plan stays byte-identical and a deleted
//       default exercise is not resurrected;
//     - non-owner and viewer-less callers get forbidden responses
//       with zero writes (including no seeding on a fresh database);
//     - emptying the plan tables by hand does NOT re-trigger the
//       seed (the plan_meta marker, not table emptiness, decides);
//     - updatePlan never touches workouts, workout_sets or
//       daily_completions; a completion recorded before a save is
//       still there after it.
//  B3/D. W-PLAN-SAFE-001 conflict visibility + resolution (0006):
//     - 0006 is purely additive for BOTH database classes: a database
//       whose journal already contains 0005 (archive rows present)
//       and a database still on 0001-0004 (0005 archives first, then
//       0006) converge; archive rows keep id + content verbatim,
//       archived_at is stamped, resolved_at starts NULL;
//     - getPlan exposes an unconfirmed conflict explicitly (routine,
//       key, candidate count, archive stamp, every candidate's plan
//       fields — live copy + archived copy), on every read, until
//       the owner resolves it; a conflict-free database's response
//       carries NO conflict fields at all;
//     - resolvePlanConflict is owner-only; confirming the live copy
//       leaves the plan byte-identical and closes the group with the
//       live row's id recorded; restoring an archived copy makes
//       that copy the live plan row under its original id, archives
//       the displaced live copy already-resolved, and stamps the
//       chosen row 'selected' with the decision time; a poisoned
//       resolution batch returns a retryable ok:false and changes
//       nothing; resolving an already-closed group is an error,
//       never a silent success.
//  E. W-PLAN-SAFE-001 P0 tail (1) — getPlan retry exhaustion: a
//     legal updatePlan landing between EVERY pair of plan-table
//     reads (0/1/4 raced attempts) still yields one whole saved
//     version; a save landing on EVERY attempt (5 = the bound, and
//     persistent contention) yields the typed retryable read_error
//     with NO plan body — never a successful mixed version.
//  F. W-PLAN-SAFE-001 P0 tail (2) — resolvePlanConflict decision
//     binding + atomic claim: a confirmation bound (candidate ids +
//     plan version) to what getPlan displayed cannot confirm a newer
//     plan it never saw when an updatePlan interleaves between the
//     handler's pre-read and its batch (both branches); two racing
//     confirmations — identical and opposite, in both orders —
//     leave exactly the winner's decision, the loser getting a
//     typed stale / already_resolved answer and changing nothing;
//     sequential duplicate submissions get the already_resolved
//     idempotent receipt; forbidden callers carrying binding
//     fields write nothing.
//  G. W-PLAN-SAFE-001 P0 rework — required binding + claim-guarded
//     version advance: (a) a request with BOTH binding fields
//     missing is typed-stale rejected with zero writes (conflict
//     still open, plan byte-identical, version unchanged); (b) each
//     field missing on its own, an empty or non-integer candidate
//     list, and malformed version strings (negative / decimal /
//     non-numeric) are likewise rejected with zero writes; (c) the
//     PM compensation-ABA counterexample: a request bound to
//     OLD/v1 whose claim loses to an interleaved MID/v2 save leaves
//     the version at exactly v2 — never v3, never rolled back —
//     issues no compensation batch, and a getPlan inside the window
//     returns a whole saved version or the typed read_error; (d)
//     bound confirmations of BOTH branches still resolve with the
//     version advancing exactly 1, duplicates stay
//     already_resolved without advancing it again.
// Synthetic data only.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');
const { drizzle } = require('drizzle-orm/libsql');
const { sql } = require('drizzle-orm');

const { Actions, DEFAULT_PLAN_TEMPLATES, DEFAULT_PLAN_SCHEDULE, DEFAULT_DAILY_ITEMS, PLAN_READ_MAX_ATTEMPTS, conflictVersionStamp } =
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
check('migrations: sequence 0001..0006 present',
  MIGRATION_FILES.length === 6 && MIGRATION_FILES[4].startsWith('0005_') && MIGRATION_FILES[5].startsWith('0006_'),
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
  check('B: no duplicates → plan_exercise_conflicts archive exists and stays empty',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts')) === 0);
  client.close();
}

// ---------- B2. PM counterexample (c): 0005 over a pre-0005 database
// whose plan_exercises legally holds duplicate (routine,
// exercise_key) rows — the unique index must NOT reject the upgrade;
// the smallest id stays, the other row is archived verbatim. ------
{
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = OFF');
  await applyMigrations(client, MIGRATION_FILES.slice(0, 4));
  const insertExercise = async (sortOrder, key, name, sets, target) =>
    (await client.execute({
      sql: 'INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      args: ['push', sortOrder, key, name, sets, target],
    })).rows[0][0];
  const keepId = await insertExercise(0, 'dup-move', '保留行', 3, '8–10');
  const archId = await insertExercise(1, 'dup-move', '归档行·原始内容', 5, '12–15');
  const soloId = await insertExercise(2, 'solo-move', '独立行', 2, '10');
  check('B2 setup: duplicate (routine, exercise_key) rows legally coexist before 0005',
    keepId < archId && soloId > archId);
  await client.execute('PRAGMA foreign_keys = ON');
  let migrationError = null;
  try {
    await applyMigrations(client, MIGRATION_FILES.slice(4, 5));
  } catch (e) { migrationError = e; }
  check('B2: 0005 succeeds despite the pre-existing duplicate keys', migrationError === null,
    migrationError ? String(migrationError) : '');
  check('B2: (routine, exercise_key) unique index exists after dedupe',
    (await scalar(client, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='plan_exercises_routine_key_idx'`)) === 1);
  const kept = (await client.execute(
    'SELECT id, routine, sort_order, exercise_key, exercise_name, sets, target_reps FROM plan_exercises ORDER BY id',
  )).rows;
  check('B2: plan_exercises keeps the smallest-id row of the group plus unrelated rows',
    kept.length === 2 && kept[0][0] === keepId && kept[1][0] === soloId
    && kept[0][4] === '保留行' && kept[1][4] === '独立行');
  const archived = (await client.execute(
    'SELECT id, routine, sort_order, exercise_key, exercise_name, sets, target_reps, archived_note FROM plan_exercise_conflicts',
  )).rows;
  check('B2: the other duplicate survives in plan_exercise_conflicts, content byte-identical',
    archived.length === 1
    && archived[0][0] === archId && archived[0][1] === 'push' && archived[0][2] === 1
    && archived[0][3] === 'dup-move' && archived[0][4] === '归档行·原始内容'
    && archived[0][5] === 5 && archived[0][6] === '12–15'
    && typeof archived[0][7] === 'string' && archived[0][7].length > 0);
  let dupRejected = false;
  try {
    await client.execute(`INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES ('push', 9, 'dup-move', '再来一行', 1, '1')`);
  } catch { dupRejected = true; }
  check('B2: the unique index now rejects a fresh duplicate', dupRejected);
  client.close();
}

// ---------- B3. 0006 conflict tracking: BOTH database classes -----
// (i) a database whose journal already contains 0005 — its archive
// rows exist — receives ONLY 0006; (ii) a database still on
// 0001-0004 runs 0005 (archiving) and then 0006 in one upgrade.
// Both must converge: same columns, archive rows verbatim,
// archived_at stamped, resolved_at NULL (unconfirmed).
async function conflictedRawClient(twoPhase) {
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = OFF');
  await applyMigrations(client, MIGRATION_FILES.slice(0, 4));
  await client.execute(`INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES ('push', 0, 'dup-move', '当前显示版', 3, '8–10')`);
  await client.execute(`INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES ('push', 1, 'dup-move', '归档版·原始内容', 5, '12–15')`);
  await client.execute('PRAGMA foreign_keys = ON');
  if (twoPhase) {
    await applyMigrations(client, MIGRATION_FILES.slice(4, 5));
    const midCount = await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts');
    const midCols = (await client.execute(`SELECT COUNT(*) FROM pragma_table_info('plan_exercise_conflicts') WHERE name IN ('archived_at', 'resolved_at', 'resolution', 'resolution_selected_id')`)).rows[0][0];
    check('B3(i): after 0005 alone the archive exists without tracking columns',
      midCount === 1 && midCols === 0);
    await applyMigrations(client, MIGRATION_FILES.slice(5, 6));
  } else {
    await applyMigrations(client, MIGRATION_FILES.slice(4, 6));
  }
  return client;
}
for (const [label, twoPhase] of [['B3(i) journal already contains 0005', true], ['B3(ii) still on 0001-0004', false]]) {
  const client = await conflictedRawClient(twoPhase);
  check(`${label}: 0006 adds all four tracking columns`,
    (await scalar(client, `SELECT COUNT(*) FROM pragma_table_info('plan_exercise_conflicts') WHERE name IN ('archived_at', 'resolved_at', 'resolution', 'resolution_selected_id')`)) === 4);
  const rows = (await client.execute(
    'SELECT routine, sort_order, exercise_key, exercise_name, sets, target_reps, archived_at, resolved_at, resolution, resolution_selected_id FROM plan_exercise_conflicts',
  )).rows;
  check(`${label}: archive row survives 0006 verbatim (id-keyed content unchanged)`,
    rows.length === 1 && rows[0][0] === 'push' && rows[0][2] === 'dup-move'
    && rows[0][3] === '归档版·原始内容' && rows[0][4] === 5 && rows[0][5] === '12–15');
  check(`${label}: archived_at is stamped and the group starts unconfirmed`,
    typeof rows[0][6] === 'number' && rows[0][6] > 0 && rows[0][7] === null && rows[0][8] === null && rows[0][9] === null);
  check(`${label}: the live copy kept by 0005 is still the plan row`,
    (await scalar(client, `SELECT exercise_name FROM plan_exercises WHERE exercise_key='dup-move'`)) === '当前显示版');
  client.close();
}
// (iii) Defensive class: journal records 0005 but the archive table
// itself is absent — 0006 recreates it empty instead of failing,
// and an empty archive means no conflict anywhere.
{
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = OFF');
  await applyMigrations(client, MIGRATION_FILES.slice(0, 5));
  await client.execute('DROP TABLE plan_exercise_conflicts');
  let err = null;
  try {
    await applyMigrations(client, MIGRATION_FILES.slice(5, 6));
  } catch (e) { err = e; }
  check('B3(iii): 0006 succeeds even when the archive table is absent',
    err === null, err ? String(err) : '');
  check('B3(iii): the archive is recreated empty, with all tracking columns',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts')) === 0
    && (await scalar(client, `SELECT COUNT(*) FROM pragma_table_info('plan_exercise_conflicts') WHERE name IN ('archived_at', 'resolved_at', 'resolution', 'resolution_selected_id')`)) === 4);
  client.close();
}

// ---------- C. Real handlers over a migrated in-memory database ----------
const EXPECTED_EXERCISES = Object.values(DEFAULT_PLAN_TEMPLATES).reduce((n, list) => n + list.length, 0);

// Wrap a select builder so that `pending` runs AFTER the query has
// executed but BEFORE the awaiting caller resumes — the controlled
// interleaving point for PM counterexample (a): "the first plan table
// has been read; now a save lands before the remaining tables are
// read". Chained builder calls stay wrapped; only 'then' is special.
function wrapAfterRead(builder, pending) {
  return new Proxy(builder, {
    get(bt, bp) {
      if (bp === 'then') {
        return (onFulfilled, onRejected) =>
          Promise.resolve(builder)
            .then(async (rows) => { await pending; return rows; })
            .then(onFulfilled, onRejected);
      }
      const value = Reflect.get(bt, bp, bt);
      if (typeof value === 'function') {
        return (...args) => {
          const result = value.apply(bt, args);
          if (result && typeof result === 'object' && typeof result.then === 'function') {
            return wrapAfterRead(result, pending);
          }
          return result;
        };
      }
      return value;
    },
  });
}

async function freshHandlerDb({ withDuplicates = false } = {}) {
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = ON');
  if (withDuplicates) {
    // Pre-0005 state: two legally coexisting rows for one
    // (routine, exercise_key) with DIFFERENT content — 0005 keeps
    // the smallest id live and archives the other, 0006 stamps the
    // archive row unconfirmed. (0005's marker backfill also marks
    // this database seeded, so no default seed interferes.)
    await applyMigrations(client, MIGRATION_FILES.slice(0, 4));
    await client.execute(`INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES ('push', 0, 'dup-move', '当前显示版', 3, '8–10')`);
    await client.execute(`INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps) VALUES ('push', 1, 'dup-move', '归档版', 5, '12–15')`);
    await applyMigrations(client, MIGRATION_FILES.slice(4));
  } else {
    await applyMigrations(client, MIGRATION_FILES);
  }
  const realDb = drizzle(client, { schema });
  // Hooks for the controlled adapters:
  //  failAt       — splice a poison statement into the next batches
  //  delayMs      — hold every batch open this long
  //  seedBatchGate— awaited before a batch executes (PM (b) pauses
  //                 the seed batch here and lands a user save first)
  //  onSelect     — called with { table, index } on every select's
  //                 .from(); returning a promise wraps that read
  //                 with wrapAfterRead (PM (a))
  const hook = { failAt: null, delayMs: 0, seedBatchGate: null, onSelect: null, batchCount: 0, selectCount: 0 };
  const wrappedDb = new Proxy(realDb, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (items) => {
          hook.batchCount++;
          if (hook.seedBatchGate) await hook.seedBatchGate(items);
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
      if (prop === 'select') {
        return (...selectArgs) => {
          const builder = target.select(...selectArgs);
          return new Proxy(builder, {
            get(bt, bp) {
              if (bp === 'from') {
                return (table) => {
                  const chained = bt.from(table);
                  hook.selectCount++;
                  const pending = hook.onSelect
                    ? hook.onSelect({ table, index: hook.selectCount })
                    : null;
                  if (pending && typeof pending.then === 'function') {
                    return wrapAfterRead(chained, pending);
                  }
                  return chained;
                };
              }
              const value = Reflect.get(bt, bp, bt);
              return typeof value === 'function' ? value.bind(bt) : value;
            },
          });
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
  check('C1: a conflict-free database gets NO conflict fields (response exactly as before)',
    !('conflicts' in seeded) && !('conflict_count' in seeded));
  check('C1: seed leaves the internal version token at 0 (and the response never exposes it)',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '0'
    && !('version' in seeded));
  const before = planPayload(await Actions.getPlan.handler(owner(), {}));
  const gu = await Actions.updatePlan.handler(guest(), asUpdateArgs(variantOf(seeded, '客')));
  check('C1: guest updatePlan is forbidden', gu.ok === false && gu.forbidden === true);
  const au = await Actions.updatePlan.handler(anon(), asUpdateArgs(variantOf(seeded, '匿')));
  check('C1: viewer-less updatePlan is forbidden', au.ok === false && au.forbidden === true);
  const gt = await Actions.toggleDailyItem.handler(guest(), { date_key: seeded.daily_date, item_key: seeded.daily_items[0].key, done: true });
  check('C1: guest toggleDailyItem is forbidden', gt.ok === false && gt.forbidden === true);
  check('C1: plan unchanged after forbidden writes',
    planPayload(await Actions.getPlan.handler(owner(), {})) === before);
  check('C1: version token untouched by forbidden writes',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '0');
  check('C1: forbidden toggle wrote no completion rows',
    (await scalar(client, 'SELECT COUNT(*) FROM daily_completions')) === 0);
  const ownSave = await Actions.updatePlan.handler(owner(), asUpdateArgs(variantOf(seeded, '主')));
  check('C1: owner save succeeds and increments the version token to 1',
    ownSave.ok === true
    && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
  const ownSave2 = await Actions.updatePlan.handler(owner(), asUpdateArgs(variantOf(seeded, '再')));
  check('C1: a second owner save increments the version token to 2',
    ownSave2.ok === true
    && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '2');
  client.close();
}

// C2: concurrent first-open seeds + seed-batch failure injection.
{
  const { client, hook, owner } = await freshHandlerDb();
  // Poison every position of the seed batch (5 statements + tail:
  // 3 guarded default-row inserts, the version insert-or-ignore, and
  // the marker insert last): each attempt must fail as a whole —
  // zero rows, no marker, no version row.
  for (let failAt = 0; failAt <= 5; failAt++) {
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
  check('C2: exactly one seed marker, with the version token at 0',
    (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='seeded'`)) === 1
    && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '0'
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_meta')) === 2);
  check('C2: both concurrent readers see the identical complete plan', planPayload(p1) === planPayload(p2));
  client.close();
}

// C3: updatePlan failure injection at every batch position.
{
  const { client, hook, owner } = await freshHandlerDb();
  const original = await Actions.getPlan.handler(owner(), {});
  const originalPayload = planPayload(original);
  const planB = variantOf(original, '乙');
  // The save batch is 8 statements + tail: 3 deletes, 3 inserts, the
  // seeded-marker insert and the version increment.
  for (let failAt = 0; failAt <= 8; failAt++) {
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
  check('C3: failed saves never incremented the version token',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '0');
  const okRes = await Actions.updatePlan.handler(owner(), asUpdateArgs(planB));
  check('C3: the same save succeeds once failures stop (retryable)', okRes.ok === true);
  check('C3: the successful save incremented the version token exactly once',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
  const readBack = await Actions.getPlan.handler(owner(), {});
  check('C3: legal save round-trips exactly through getPlan',
    planPayload(readBack) === planPayload(planB));
  client.close();
}

// C4: concurrent updatePlans never mix; reads during a save see a
// complete plan (old, then new — never empty or half).
{
  const { client, hook, owner } = await freshHandlerDb();
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
  check('C4: two concurrent saves advanced the version token by exactly 2',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '2');
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

// C7: PM counterexample (a) — a legal updatePlan lands AFTER
// getPlan has read the first plan table (plan_exercises) but before
// it reads the rest. Without the version-bracketed retry read this
// returns old exercises + new schedule; with it, the response must
// be the whole old version or the whole new version.
{
  const { client, hook, owner } = await freshHandlerDb();
  const base = await Actions.getPlan.handler(owner(), {});
  const basePayload = planPayload(base);
  const planNew = variantOf(base, '新');
  let fired = false;
  let saveResult = null;
  hook.onSelect = ({ table }) => {
    if (!fired && table === schema.planExercises) {
      fired = true;
      return (async () => {
        saveResult = await Actions.updatePlan.handler(owner(), asUpdateArgs(planNew));
      })();
    }
    return undefined;
  };
  const raced = await Actions.getPlan.handler(owner(), {});
  hook.onSelect = null;
  check('PM-a: the controlled adapter landed a legal save mid-read',
    fired && saveResult !== null && saveResult.ok === true);
  check('PM-a: raced getPlan returns the whole old version or the whole new version, never a mix',
    planPayload(raced) === basePayload || planPayload(raced) === planPayload(planNew),
    `raced=${planPayload(raced) === basePayload ? 'old' : planPayload(raced) === planPayload(planNew) ? 'new' : 'MIXED'}`);
  check('PM-a: the save advanced the version token exactly once',
    (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
  check('PM-a: a later getPlan reads the complete new plan',
    planPayload(await Actions.getPlan.handler(owner(), {})) === planPayload(planNew));
  client.close();
}

// C8: PM counterexample (b) — the seed's pre-check passes on a fresh
// database, then the seed batch is paused and a FIRST legal user
// save lands (custom exercise key added, default 'dips' deleted).
// When the seed resumes, its execution-time guarded inserts must
// write zero rows: the user plan stays exactly as saved and the
// deleted default never comes back.
{
  const { client, hook, owner } = await freshHandlerDb();
  const userPlan = {
    routines: Object.entries(DEFAULT_PLAN_TEMPLATES).map(([routine, exercises]) => ({
      routine,
      exercises: exercises.map((e) => ({ key: e.key, name: e.name, sets: e.sets, target: e.target })),
    })),
    schedule: DEFAULT_PLAN_SCHEDULE.map((s) => ({ day_index: s.day_index, routine_code: s.routine_code, note: s.note })),
    daily_items: DEFAULT_DAILY_ITEMS.map((d) => ({ key: d.key, title: d.title, detail: d.detail })),
  };
  const push = userPlan.routines.find((r) => r.routine === 'push');
  push.exercises = push.exercises.filter((e) => e.key !== 'dips');
  push.exercises.push({ key: 'my-custom-press', name: '我的自定义推举', sets: 3, target: '10' });
  const userPayload = planPayload(userPlan);
  let gateUsed = false;
  let saveResult = null;
  hook.seedBatchGate = async () => {
    if (gateUsed) return; // nested batches (the save itself) pass through
    gateUsed = true;
    saveResult = await Actions.updatePlan.handler(owner(), asUpdateArgs(userPlan));
  };
  const opened = await Actions.getPlan.handler(owner(), {});
  hook.seedBatchGate = null;
  check('PM-b: the gate paused the seed batch and the first legal user save landed inside it',
    gateUsed && saveResult !== null && saveResult.ok === true);
  check('PM-b: the racing first open returns the user plan, not the default template',
    planPayload(opened) === userPayload);
  check('PM-b: stored plan is the user plan row-for-row after the late seed resumed',
    planPayload(await Actions.getPlan.handler(owner(), {})) === userPayload
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercises')) === EXPECTED_EXERCISES
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_schedule')) === DEFAULT_PLAN_SCHEDULE.length
    && (await scalar(client, 'SELECT COUNT(*) FROM plan_daily_items')) === DEFAULT_DAILY_ITEMS.length);
  check('PM-b: the deleted default exercise was NOT resurrected by the late seed',
    (await scalar(client, `SELECT COUNT(*) FROM plan_exercises WHERE exercise_key='dips'`)) === 0);
  check('PM-b: the custom exercise key survived the late seed',
    (await scalar(client, `SELECT COUNT(*) FROM plan_exercises WHERE exercise_key='my-custom-press'`)) === 1);
  check('PM-b: exactly one marker, and the version token is the save\u2019s 1 (seed insert-or-ignore did not reset it)',
    (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='seeded'`)) === 1
    && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
  client.close();
}

// ---------- D. W-PLAN-SAFE-001 conflict visibility + resolution ---
// Handler level, over a database that went through the real
// two-phase upgrade with a duplicate (routine, exercise_key) pair.
{
  const { client, hook, owner, guest, anon } = await freshHandlerDb({ withDuplicates: true });
  const liveRow = (await client.execute(`SELECT id FROM plan_exercises WHERE exercise_key='dup-move'`)).rows[0];
  const archRow = (await client.execute(`SELECT id FROM plan_exercise_conflicts WHERE exercise_key='dup-move'`)).rows[0];
  check('D setup: smallest id stayed live, the other copy was archived',
    liveRow && archRow && liveRow[0] < archRow[0], `live=${liveRow?.[0]} archived=${archRow?.[0]}`);
  const liveId = liveRow[0];
  const archiveId = archRow[0];

  const g1 = await Actions.getPlan.handler(owner(), {});
  // The required display binding every well-formed confirmation
  // below carries (P0 rework: both fields must arrive).
  const shownBinding = {
    expected_candidate_ids: g1.conflicts[0].candidates.map((c) => c.id),
    expected_plan_version: g1.conflicts[0].plan_version,
  };
  check('D: getPlan exposes the unconfirmed conflict explicitly',
    g1.forbidden === false && g1.conflict_count === 1 && Array.isArray(g1.conflicts) && g1.conflicts.length === 1);
  const conflict = g1.conflicts[0];
  check('D: conflict carries routine, key, total candidate count and an archive stamp',
    conflict.routine === 'push' && conflict.exercise_key === 'dup-move'
    && conflict.candidate_count === 2 && typeof conflict.archived_at === 'string' && conflict.archived_at.length > 0);
  check('D: candidates expose BOTH versions with their plan fields (live first, archived by id)',
    conflict.candidates.length === 2
    && conflict.candidates[0].source === 'live' && conflict.candidates[0].archive_id === null
    && conflict.candidates[0].name === '当前显示版' && conflict.candidates[0].sets === 3 && conflict.candidates[0].target === '8–10'
    && conflict.candidates[1].source === 'archived' && conflict.candidates[1].archive_id === archiveId
    && conflict.candidates[1].name === '归档版' && conflict.candidates[1].sets === 5 && conflict.candidates[1].target === '12–15');
  const g2 = await Actions.getPlan.handler(owner(), {});
  check('D: unchosen, the conflict is still there on the next read (never silently resolved)',
    g2.conflict_count === 1 && planPayload(g2) === planPayload(g1));
  check('D: the displayed plan still uses the live copy while unconfirmed (plan stays usable)',
    g1.routines.find((r) => r.routine === 'push').exercises.some((e) => e.key === 'dup-move' && e.name === '当前显示版'));

  const guestResolve = await Actions.resolvePlanConflict.handler(guest(), { routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId });
  check('D: guest resolvePlanConflict is forbidden', guestResolve.ok === false && guestResolve.forbidden === true);
  const anonResolve = await Actions.resolvePlanConflict.handler(anon(), { routine: 'push', exercise_key: 'dup-move', selected_archive_id: null });
  check('D: viewer-less resolvePlanConflict is forbidden', anonResolve.ok === false && anonResolve.forbidden === true);
  const bogus = await Actions.resolvePlanConflict.handler(owner(), { routine: 'push', exercise_key: 'dup-move', selected_archive_id: 999999, ...shownBinding });
  check('D: selecting a non-existent archive id is a typed error, conflict untouched',
    bogus.ok === false && bogus.forbidden === false && typeof bogus.error === 'string' && bogus.error.length > 0
    && (await Actions.getPlan.handler(owner(), {})).conflict_count === 1);

  // Failure injection: poison the resolution batch — every position
  // it can take (claim, claim-guarded version advance, insert
  // displaced, delete live, insert restored, stamp selected = 6
  // statements + tail).
  const planBeforeFail = planPayload(await Actions.getPlan.handler(owner(), {}));
  for (let failAt = 0; failAt <= 6; failAt++) {
    hook.failAt = failAt;
    const res = await Actions.resolvePlanConflict.handler(owner(), { routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...shownBinding });
    hook.failAt = null;
    check(`D: resolution failure at batch position ${failAt} returns retryable ok:false`,
      res.ok === false && res.forbidden === false && typeof res.error === 'string' && res.error.length > 0);
    const after = await Actions.getPlan.handler(owner(), {});
    check(`D: resolution failure at batch position ${failAt} leaves plan + open conflict untouched`,
      planPayload(after) === planBeforeFail && after.conflict_count === 1
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1);
  }

  // Owner restores the archived copy.
  const versionRowBefore = (await client.execute(`SELECT value FROM plan_meta WHERE key='version'`)).rows[0];
  const versionBefore = versionRowBefore ? versionRowBefore[0] : null;
  const resolved = await Actions.resolvePlanConflict.handler(owner(), { routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...shownBinding });
  check('D: owner selecting the archived copy succeeds', resolved.ok === true && resolved.forbidden === false && resolved.error === null);
  check('D: the resolution incremented the plan version token exactly once',
    Number(await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === Number(versionBefore ?? '0') + 1);
  const g3 = await Actions.getPlan.handler(owner(), {});
  check('D: after resolution the conflict is closed (no conflict fields)',
    !('conflicts' in g3) && !('conflict_count' in g3));
  check('D: the selected archived copy is now the effective plan version',
    g3.routines.find((r) => r.routine === 'push').exercises.some((e) => e.key === 'dup-move' && e.name === '归档版' && e.sets === 5 && e.target === '12–15'));
  check('D: the restored row carries its ORIGINAL archive id in plan_exercises',
    (await scalar(client, `SELECT id FROM plan_exercises WHERE exercise_key='dup-move'`)) === archiveId);
  const chosenRow = (await client.execute(`SELECT resolution, resolution_selected_id, resolved_at FROM plan_exercise_conflicts WHERE id=${archiveId}`)).rows[0];
  check('D: the chosen archive row is stamped selected, with its own id and a resolution time (decision trace)',
    chosenRow[0] === 'selected' && chosenRow[1] === archiveId && typeof chosenRow[2] === 'number' && chosenRow[2] > 0);
  const displaced = (await client.execute(`SELECT exercise_name, sets, target_reps, resolution, resolution_selected_id, resolved_at FROM plan_exercise_conflicts WHERE id=${liveId}`)).rows[0];
  check('D: the displaced live copy was archived already-resolved — no candidate lost',
    displaced && displaced[0] === '当前显示版' && displaced[1] === 3 && displaced[2] === '8–10'
    && displaced[3] === 'superseded' && displaced[4] === archiveId && typeof displaced[5] === 'number');
  check('D: no unconfirmed archive rows remain',
    (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 0);
  const again = await Actions.resolvePlanConflict.handler(owner(), { routine: 'push', exercise_key: 'dup-move', selected_archive_id: null, ...shownBinding });
  check('D: resolving an already-closed group is a typed error, not a silent success',
    again.ok === false && again.forbidden === false && typeof again.error === 'string' && again.error.length > 0);
  client.close();
}

// D2: confirming the currently displayed (live) copy instead.
{
  const { client, owner } = await freshHandlerDb({ withDuplicates: true });
  const liveId = (await client.execute(`SELECT id FROM plan_exercises WHERE exercise_key='dup-move'`)).rows[0][0];
  const before = await Actions.getPlan.handler(owner(), {});
  const res = await Actions.resolvePlanConflict.handler(owner(), {
    routine: 'push', exercise_key: 'dup-move', selected_archive_id: null,
    expected_candidate_ids: before.conflicts[0].candidates.map((c) => c.id),
    expected_plan_version: before.conflicts[0].plan_version,
  });
  check('D2: owner confirming the live copy succeeds', res.ok === true && res.forbidden === false);
  const after = await Actions.getPlan.handler(owner(), {});
  check('D2: the plan is byte-identical after confirming the live copy',
    planPayload(after) === planPayload(before));
  check('D2: the conflict is closed after confirming the live copy',
    !('conflicts' in after) && !('conflict_count' in after));
  const arch = (await client.execute(`SELECT resolution, resolution_selected_id, resolved_at FROM plan_exercise_conflicts WHERE exercise_key='dup-move'`)).rows[0];
  check('D2: the archive row records the LIVE row id as the selected candidate, with a resolution time',
    arch[0] === 'superseded' && arch[1] === liveId && typeof arch[2] === 'number' && arch[2] > 0);
  check('D2: the live row kept its original id and content',
    (await scalar(client, `SELECT id FROM plan_exercises WHERE exercise_key='dup-move'`)) === liveId
    && (await scalar(client, `SELECT exercise_name FROM plan_exercises WHERE exercise_key='dup-move'`)) === '当前显示版');
  client.close();
}


// ---------- E. W-PLAN-SAFE-001 P0 tail (1): getPlan must never
// return a mixed version; bounded retry exhaustion is an explicit
// retryable failure (read_error, no plan body). ----------
{
  // E1: a legal save lands after EACH plan-table read in turn —
  // the raced read must still return one whole saved version.
  const tableCases = [
    ['plan_exercises', schema.planExercises],
    ['plan_schedule', schema.planSchedule],
    ['plan_daily_items', schema.planDailyItems],
    ['plan_exercise_conflicts', schema.planExerciseConflicts],
  ];
  for (const [label, table] of tableCases) {
    const { hook, owner } = await freshHandlerDb();
    const base = await Actions.getPlan.handler(owner(), {});
    const basePayload = planPayload(base);
    const planNew = variantOf(base, `插${label}`);
    let fired = false;
    let saveResult = null;
    hook.onSelect = ({ table: t }) => {
      if (!fired && t === table) {
        fired = true;
        return (async () => { saveResult = await Actions.updatePlan.handler(owner(), asUpdateArgs(planNew)); })();
      }
      return undefined;
    };
    const raced = await Actions.getPlan.handler(owner(), {});
    hook.onSelect = null;
    check(`E1: save landing after the ${label} read — raced getPlan is one whole version`,
      fired && saveResult !== null && saveResult.ok === true
      && raced.read_error === undefined
      && (planPayload(raced) === basePayload || planPayload(raced) === planPayload(planNew)),
      `raced=${planPayload(raced) === basePayload ? 'old' : planPayload(raced) === planPayload(planNew) ? 'new' : 'MIXED'}`);
  }

  // E2: saves land on the first K attempts (K = 0, 1, 4): with the
  // bound at 5 attempts the read still succeeds, returning the
  // newest whole saved version.
  for (const k of [0, 1, 4]) {
    const { hook, owner } = await freshHandlerDb();
    const base = await Actions.getPlan.handler(owner(), {});
    let firedCount = 0;
    let lastSavePayload = planPayload(base);
    hook.onSelect = ({ table }) => {
      if (table === schema.planExercises && firedCount < k) {
        const tag = `竞${firedCount}`;
        firedCount++;
        return (async () => {
          const res = await Actions.updatePlan.handler(owner(), asUpdateArgs(variantOf(base, tag)));
          if (res.ok) lastSavePayload = planPayload(variantOf(base, tag));
        })();
      }
      return undefined;
    };
    const raced = await Actions.getPlan.handler(owner(), {});
    hook.onSelect = null;
    check(`E2: ${k} raced attempt(s) then quiet — getPlan succeeds with the newest whole version`,
      firedCount === k && raced.read_error === undefined && planPayload(raced) === lastSavePayload);
  }

  // E3: a save lands on EVERY attempt — at the bound (5) and beyond
  // (persistent contention): the answer is the typed retryable
  // failure with no plan body, and a later quiet read recovers.
  for (const cap of [PLAN_READ_MAX_ATTEMPTS, PLAN_READ_MAX_ATTEMPTS + 3]) {
    const { hook, owner } = await freshHandlerDb();
    const base = await Actions.getPlan.handler(owner(), {});
    let firedCount = 0;
    hook.onSelect = ({ table }) => {
      if (table === schema.planExercises && firedCount < cap) {
        const tag = `耗${firedCount}`;
        firedCount++;
        return (async () => {
          await Actions.updatePlan.handler(owner(), asUpdateArgs(variantOf(base, tag)));
        })();
      }
      return undefined;
    };
    const raced = await Actions.getPlan.handler(owner(), {});
    hook.onSelect = null;
    check(`E3: saves on every attempt (cap ${cap}) — getPlan fails explicitly, never a mixed success`,
      raced.forbidden === false
      && typeof raced.read_error === 'string' && raced.read_error.length > 0
      && raced.routines.length === 0 && raced.schedule.length === 0 && raced.daily_items.length === 0
      && !('conflicts' in raced),
      `read_error=${JSON.stringify(raced.read_error)} attempts-raced=${firedCount}`);
    check(`E3: the bound held — exactly ${PLAN_READ_MAX_ATTEMPTS} attempts were raced, no unbounded retry`,
      firedCount === PLAN_READ_MAX_ATTEMPTS, `fired=${firedCount}`);
    const recovered = await Actions.getPlan.handler(owner(), {});
    check('E3: once the writer quiets, getPlan recovers the newest whole saved version',
      recovered.read_error === undefined
      && planPayload(recovered) === planPayload(variantOf(base, `耗${PLAN_READ_MAX_ATTEMPTS - 1}`)));
  }

  // E4: the decision-binding stamp is a pure function of the full
  // decision state (version, live copy, archived copies).
  const stampBase = {
    planVersion: '3',
    live: { id: 1, sortOrder: 0, exerciseName: '甲', sets: 3, targetReps: '8' },
    archived: [{ id: 2, sortOrder: 1, exerciseName: '乙', sets: 5, targetReps: '12', archivedAtMs: 1000 }],
  };
  check('E4: conflictVersionStamp is deterministic for identical state',
    conflictVersionStamp(stampBase) === conflictVersionStamp(JSON.parse(JSON.stringify(stampBase))));
  check('E4: conflictVersionStamp changes with the plan version',
    conflictVersionStamp({ ...stampBase, planVersion: '4' }) !== conflictVersionStamp(stampBase));
  check('E4: conflictVersionStamp changes with any candidate content',
    conflictVersionStamp({ ...stampBase, live: { ...stampBase.live, sets: 4 } }) !== conflictVersionStamp(stampBase)
    && conflictVersionStamp({ ...stampBase, archived: [{ ...stampBase.archived[0], exerciseName: '丙' }] }) !== conflictVersionStamp(stampBase));
}

// ---------- F. W-PLAN-SAFE-001 P0 tail (2): resolvePlanConflict
// binds the decision to the displayed candidates + plan version
// and claims the group atomically inside its batch. ----------
{
  // Helpers local to this section: displayed-binding from getPlan,
  // and a full-plan variant for conflict databases (whose schedule /
  // daily tables are empty until the first save fills them).
  const bindingOf = (plan) => {
    const conflict = plan.conflicts[0];
    return {
      expected_candidate_ids: conflict.candidates.map((c) => c.id),
      expected_plan_version: conflict.plan_version,
    };
  };
  const fullVariantOf = (plan, tag) => {
    const copy = JSON.parse(planPayload(plan));
    if (copy.schedule.length === 0) {
      copy.schedule = DEFAULT_PLAN_SCHEDULE.map((e) => ({ day_index: e.day_index, routine_code: e.routine_code, note: e.note }));
    }
    if (copy.daily_items.length === 0) {
      copy.daily_items = DEFAULT_DAILY_ITEMS.map((d) => ({ key: d.key, title: d.title, detail: d.detail }));
    }
    return variantOf(copy, tag);
  };

  // F1: confirm-LIVE bound to the displayed candidates; a legal
  // updatePlan lands between the handler's pre-read and its batch
  // (the batch gate). The old confirmation must NOT confirm the
  // unseen new plan: typed stale, the new plan untouched, the
  // conflict still open with every candidate preserved.
  {
    const { client, hook, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const planNew = fullVariantOf(shown, '新窗');
    let gateUsed = false;
    let saveResult = null;
    hook.seedBatchGate = async () => {
      if (gateUsed) return;
      gateUsed = true;
      saveResult = await Actions.updatePlan.handler(owner(), asUpdateArgs(planNew));
    };
    const res = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: null, ...bindingOf(shown),
    });
    hook.seedBatchGate = null;
    check('F1: the interleaved legal save landed inside the confirm',
      gateUsed && saveResult !== null && saveResult.ok === true);
    check('F1: the stale live-confirmation is a typed stale failure, not a success',
      res.ok === false && res.forbidden === false && res.outcome === 'stale'
      && typeof res.error === 'string' && res.error.length > 0);
    const after = await Actions.getPlan.handler(owner(), {});
    check('F1: the newer plan was NOT overwritten or confirmed away',
      planPayload(after) === planPayload(planNew));
    check('F1: the conflict is still open and no candidate was lost',
      after.conflict_count === 1
      && after.conflicts[0].candidate_count === 2
      && after.conflicts[0].candidates.some((c) => c.source === 'archived' && c.archive_id === archiveId && c.name === '归档版')
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1);
    check('F1: the version token is exactly the interleaved save\u2019s (the stale decision added nothing)',
      (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
  }

  // F2: confirm-ARCHIVE with the same interleave: same guarantees,
  // through the restore branch.
  {
    const { client, hook, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const planNew = fullVariantOf(shown, '新窗');
    let gateUsed = false;
    let saveResult = null;
    hook.seedBatchGate = async () => {
      if (gateUsed) return;
      gateUsed = true;
      saveResult = await Actions.updatePlan.handler(owner(), asUpdateArgs(planNew));
    };
    const res = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...bindingOf(shown),
    });
    hook.seedBatchGate = null;
    check('F2: the interleaved legal save landed inside the restore-confirm',
      gateUsed && saveResult !== null && saveResult.ok === true);
    check('F2: the stale archive-confirmation is a typed stale failure, not a success',
      res.ok === false && res.forbidden === false && res.outcome === 'stale');
    const after = await Actions.getPlan.handler(owner(), {});
    check('F2: the newer plan stands and the conflict is still open with all candidates',
      planPayload(after) === planPayload(planNew)
      && after.conflict_count === 1 && after.conflicts[0].candidate_count === 2
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1);
    check('F2: the version token is exactly the interleaved save\u2019s',
      (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
  }

  // F3: two confirmations race (both bound to the same displayed
  // state), in both orders and with identical + opposite choices.
  // Exactly the winner's decision is recorded; the loser changes
  // nothing and gets already_resolved (identical) or a typed
  // failure (opposite).
  async function raceScenario(firstChoice, secondChoice, label) {
    const { client, hook, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const pick = (choice) => (choice === 'archived' ? archiveId : null);
    let gateUsed = false;
    let secondResult = null;
    hook.seedBatchGate = async () => {
      if (gateUsed) return;
      gateUsed = true;
      secondResult = await Actions.resolvePlanConflict.handler(owner(), {
        routine: 'push', exercise_key: 'dup-move', selected_archive_id: pick(secondChoice), ...bindingOf(shown),
      });
    };
    const firstResult = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: pick(firstChoice), ...bindingOf(shown),
    });
    hook.seedBatchGate = null;
    check(`${label}: both confirmations ran (the second interleaved into the first\u2019s batch window)`,
      gateUsed && secondResult !== null);
    check(`${label}: the interleaved (second) confirmation won with outcome resolved`,
      secondResult.ok === true && secondResult.outcome === 'resolved');
    const after = await Actions.getPlan.handler(owner(), {});
    const winnerName = secondChoice === 'archived' ? '归档版' : '当前显示版';
    check(`${label}: the effective plan is exactly the winner\u2019s decision`,
      !('conflicts' in after)
      && after.routines.find((r) => r.routine === 'push').exercises.some((e) => e.key === 'dup-move' && e.name === winnerName));
    check(`${label}: the version token advanced exactly once (the loser wrote nothing)`,
      (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
    if (firstChoice === secondChoice) {
      check(`${label}: the identical loser gets the already_resolved idempotent receipt`,
        firstResult.ok === true && firstResult.outcome === 'already_resolved');
    } else {
      check(`${label}: the opposite loser gets a typed failure and did NOT claim the unseen version`,
        firstResult.ok === false && firstResult.forbidden === false
        && typeof firstResult.error === 'string' && firstResult.error.length > 0);
    }
    check(`${label}: no candidate was lost in the race`,
      (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts')) === (secondChoice === 'archived' ? 2 : 1),
      'archive rows: winner-archived adds the displaced live copy, winner-live adds none');
  }
  await raceScenario('live', 'archived', 'F3a live-then-archived(interleaved)');
  await raceScenario('archived', 'live', 'F3b archived-then-live(interleaved)');
  await raceScenario('archived', 'archived', 'F3c archived-vs-archived(interleaved)');
  await raceScenario('live', 'live', 'F3d live-vs-live(interleaved)');

  // F4: sequential duplicates — the same decision submitted twice
  // (double tap / retry after success) gets the idempotent receipt;
  // a different decision against the closed group stays an error.
  {
    const { owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const args = { routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...bindingOf(shown) };
    const first = await Actions.resolvePlanConflict.handler(owner(), args);
    check('F4: the first archive confirmation resolves with outcome resolved',
      first.ok === true && first.outcome === 'resolved');
    const dup = await Actions.resolvePlanConflict.handler(owner(), args);
    check('F4: the identical repeat is the already_resolved idempotent receipt',
      dup.ok === true && dup.outcome === 'already_resolved');
    const other = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: null, ...bindingOf(shown),
    });
    check('F4: a different decision against the closed group is still a typed error',
      other.ok === false && other.outcome === undefined);
  }
  {
    const { owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const args = { routine: 'push', exercise_key: 'dup-move', selected_archive_id: null, ...bindingOf(shown) };
    const first = await Actions.resolvePlanConflict.handler(owner(), args);
    const dup = await Actions.resolvePlanConflict.handler(owner(), args);
    check('F4b: a repeated live confirmation is also the already_resolved receipt',
      first.ok === true && first.outcome === 'resolved'
      && dup.ok === true && dup.outcome === 'already_resolved');
  }

  // F5: bound confirmation against a QUIET state whose version has
  // simply moved on (sequential save after display) — typed stale
  // from the pre-check, zero writes; and a confirmation carrying a
  // forged candidate set is stale too.
  {
    const { client, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    await Actions.updatePlan.handler(owner(), asUpdateArgs(fullVariantOf(shown, '新')));
    const stale = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...bindingOf(shown),
    });
    check('F5: confirming displayed candidates after a later save is typed stale, zero writes',
      stale.ok === false && stale.outcome === 'stale'
      && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1'
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1);
    const fresh = await Actions.getPlan.handler(owner(), {});
    const forged = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId,
      expected_candidate_ids: [999999], expected_plan_version: fresh.conflicts[0].plan_version,
    });
    check('F5: a candidate set that was never displayed is typed stale too',
      forged.ok === false && forged.outcome === 'stale');
    const proper = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...bindingOf(fresh),
    });
    check('F5: the refreshed binding confirms normally afterwards',
      proper.ok === true && proper.outcome === 'resolved');
  }

  // F6: forbidden callers carrying binding fields write nothing at
  // all; and since the P0 rework the binding is REQUIRED — an
  // unbound (older-client) owner request no longer resolves: it is
  // rejected with the typed stale answer and zero writes, and the
  // same decision WITH its binding then resolves normally.
  {
    const { client, owner, guest, anon } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const g = await Actions.resolvePlanConflict.handler(guest(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...bindingOf(shown),
    });
    const a = await Actions.resolvePlanConflict.handler(anon(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: null, ...bindingOf(shown),
    });
    check('F6: guest/viewer-less confirmations with binding fields are forbidden, zero writes',
      g.ok === false && g.forbidden === true && a.ok === false && a.forbidden === true
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1
      && (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='version'`)) === 0);
    const unbound = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId,
    });
    check('F6: an unbound (older-client) confirmation is typed stale with zero writes — the conflict stays open',
      unbound.ok === false && unbound.forbidden === false && unbound.outcome === 'stale'
      && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1
      && (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='version'`)) === 0);
    const bound = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId, ...bindingOf(shown),
    });
    check('F6: the same decision WITH its required binding resolves normally',
      bound.ok === true && bound.outcome === 'resolved');
  }
}

// ---------- G. W-PLAN-SAFE-001 P0 rework: the binding is REQUIRED
// (missing/malformed bindings fail safe with zero writes) and the
// decision batch's version advance is guarded on the claim itself
// (a lost claim writes nothing at all — no compensation batch). --
{
  const bindingOfG = (plan) => {
    const conflict = plan.conflicts[0];
    return {
      expected_candidate_ids: conflict.candidates.map((c) => c.id),
      expected_plan_version: conflict.plan_version,
    };
  };
  const fullVariantOfG = (plan, tag) => {
    const copy = JSON.parse(planPayload(plan));
    if (copy.schedule.length === 0) {
      copy.schedule = DEFAULT_PLAN_SCHEDULE.map((e) => ({ day_index: e.day_index, routine_code: e.routine_code, note: e.note }));
    }
    if (copy.daily_items.length === 0) {
      copy.daily_items = DEFAULT_DAILY_ITEMS.map((d) => ({ key: d.key, title: d.title, detail: d.detail }));
    }
    return variantOf(copy, tag);
  };

  // G(a)+(b): missing / malformed bindings — every shape is a typed
  // stale rejection with zero writes: the conflict stays open, the
  // plan stays byte-identical, the version token never appears.
  {
    const { client, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const binding = bindingOfG(shown);
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const planBefore = planPayload(shown);
    const base = { routine: 'push', exercise_key: 'dup-move', selected_archive_id: archiveId };
    const expectStaleNoWrites = async (label, args) => {
      const res = await Actions.resolvePlanConflict.handler(owner(), args);
      const after = await Actions.getPlan.handler(owner(), {});
      check(`G: ${label} — typed stale rejection, zero writes`,
        res.ok === false && res.forbidden === false && res.outcome === 'stale'
        && typeof res.error === 'string' && res.error.length > 0
        && planPayload(after) === planBefore && after.conflict_count === 1
        && (await scalar(client, 'SELECT COUNT(*) FROM plan_exercise_conflicts WHERE resolved_at IS NULL')) === 1
        && (await scalar(client, `SELECT COUNT(*) FROM plan_meta WHERE key='version'`)) === 0);
    };
    await expectStaleNoWrites('(a) an older-client request with BOTH binding fields missing', { ...base });
    await expectStaleNoWrites('(b) only expected_candidate_ids, the version field missing',
      { ...base, expected_candidate_ids: binding.expected_candidate_ids });
    await expectStaleNoWrites('(b) only expected_plan_version, the candidate ids field missing',
      { ...base, expected_plan_version: binding.expected_plan_version });
    await expectStaleNoWrites('(b) an empty candidate id list',
      { ...base, expected_candidate_ids: [], expected_plan_version: binding.expected_plan_version });
    await expectStaleNoWrites('(b) a non-integer candidate id',
      { ...base, expected_candidate_ids: [1.5], expected_plan_version: binding.expected_plan_version });
    for (const bad of ['-1', '1.5', 'abc']) {
      await expectStaleNoWrites(`(b) a malformed plan version "${bad}"`,
        { ...base, expected_candidate_ids: binding.expected_candidate_ids, expected_plan_version: bad });
    }
    client.close();
  }

  // G(c): the PM compensation-ABA counterexample. A confirmation
  // bound to OLD/v1 is in flight; before its claim executes, another
  // save commits MID/v2. The stale claim must stamp zero rows and
  // its batch must write NOTHING — the version stays exactly v2
  // (never v3, never rolled back), no compensation batch is issued,
  // and a getPlan inside the window returns a whole saved version.
  {
    const { client, hook, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown0 = await Actions.getPlan.handler(owner(), {});
    const oldSave = await Actions.updatePlan.handler(owner(), asUpdateArgs(fullVariantOfG(shown0, '旧')));
    check('G(c) setup: the OLD save landed (plan version v1)',
      oldSave.ok === true
      && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
    const shownOld = await Actions.getPlan.handler(owner(), {});
    const oldBinding = bindingOfG(shownOld);
    check('G(c) setup: the displayed binding is bound to OLD/v1',
      oldBinding.expected_plan_version === '1');
    const midPlan = fullVariantOfG(shownOld, '中');
    let gatePhase = 'armed'; // armed → saving (MID's own batch) → spent
    let saveResult = null;
    let versionAfterMid = null;
    let gatePlan = null;
    const laterGateVersions = [];
    hook.seedBatchGate = async () => {
      if (gatePhase === 'armed') {
        gatePhase = 'saving';
        saveResult = await Actions.updatePlan.handler(owner(), asUpdateArgs(midPlan));
        gatePhase = 'spent';
        versionAfterMid = await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`);
        gatePlan = await Actions.getPlan.handler(owner(), {});
        return;
      }
      if (gatePhase === 'saving') return; // the MID save's own batch gate
      // Any FURTHER batch in this window (a compensation write in
      // the pre-rework design) is observed BEFORE it executes: the
      // token must still read exactly v2 there.
      laterGateVersions.push(await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`));
    };
    const batchesBefore = hook.batchCount;
    const res = await Actions.resolvePlanConflict.handler(owner(), {
      routine: 'push', exercise_key: 'dup-move', selected_archive_id: null, ...oldBinding,
    });
    hook.seedBatchGate = null;
    const batchesUsed = hook.batchCount - batchesBefore;
    check('G(c): the interleaved MID save landed inside the stale claim\u2019s batch window',
      saveResult !== null && saveResult.ok === true && versionAfterMid === '2');
    check('G(c): the OLD-bound confirmation is a typed stale failure',
      res.ok === false && res.forbidden === false && res.outcome === 'stale');
    check('G(c): the version is exactly v2 afterwards — never v3, never rolled back to v1',
      (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '2'
      && laterGateVersions.every((v) => v === '2'),
      `later batch gates observed versions: ${JSON.stringify(laterGateVersions)}`);
    check('G(c): the stale claim issued NO compensation batch (only the MID save + its own decision batch ran)',
      batchesUsed === 2, `batches=${batchesUsed}`);
    check('G(c): the getPlan inside the window returned the whole MID plan (or the typed read_error), never a mix',
      gatePlan !== null
      && (typeof gatePlan.read_error === 'string' || planPayload(gatePlan) === planPayload(midPlan)));
    const after = await Actions.getPlan.handler(owner(), {});
    check('G(c): the plan is exactly MID and the conflict is still open with every candidate',
      planPayload(after) === planPayload(midPlan)
      && after.conflict_count === 1 && after.conflicts[0].candidate_count === 2);
    client.close();
  }

  // G(d): bound confirmations of both branches still resolve, the
  // version advances by exactly 1, and a duplicate submission is
  // the already_resolved receipt WITHOUT advancing it again.
  for (const [label, pickArchived] of [['live', false], ['archive', true]]) {
    const { client, owner } = await freshHandlerDb({ withDuplicates: true });
    const shown = await Actions.getPlan.handler(owner(), {});
    const archiveId = shown.conflicts[0].candidates.find((c) => c.source === 'archived').archive_id;
    const args = {
      routine: 'push', exercise_key: 'dup-move',
      selected_archive_id: pickArchived ? archiveId : null, ...bindingOfG(shown),
    };
    const first = await Actions.resolvePlanConflict.handler(owner(), args);
    check(`G(d): a bound ${label} confirmation resolves and the version advances exactly 1 (absent → 1)`,
      first.ok === true && first.outcome === 'resolved'
      && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
    const dup = await Actions.resolvePlanConflict.handler(owner(), args);
    check(`G(d): the duplicate ${label} confirmation is already_resolved and does NOT advance the version again`,
      dup.ok === true && dup.outcome === 'already_resolved'
      && (await scalar(client, `SELECT value FROM plan_meta WHERE key='version'`)) === '1');
    client.close();
  }
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
