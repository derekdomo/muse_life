-- W-MIG-004 corrective migration, part 1 of 2: rebuild the workouts
-- parent table with the child-preservation pattern that is now the
-- standing rule for ANY future rebuild of this parent table:
-- (1) copy every workout_sets row into a backup table first,
-- (2) rebuild the parent preserving every original id, the routine
-- CHECK (including home_posture / home_snowboard), the initializing
-- column and the workouts_completed_at_idx index,
-- (3) restore any child row the parent drop removed, matched by its
-- original id and only when its parent row exists,
-- (4) verify parent and child counts and that no orphan child row
-- remains — a failed verification makes this migration fail, and the
-- migration runner wraps the whole migration in one atomic unit, so
-- a failure leaves the previous database untouched,
-- (5) drop the backup and guard tables.
-- This replaces the bare drop-and-rename shape of 0004, which loses
-- every child row whenever foreign key enforcement is active while
-- the parent is dropped.
DROP TABLE IF EXISTS workout_sets_backup_0005;
--> statement-breakpoint
DROP TABLE IF EXISTS workouts_new;
--> statement-breakpoint
DROP TABLE IF EXISTS _child_preservation_guard;
--> statement-breakpoint
CREATE TABLE workout_sets_backup_0005 AS SELECT * FROM workout_sets;
--> statement-breakpoint
CREATE TABLE workouts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine TEXT NOT NULL CHECK (routine IN ('push', 'pull', 'legs', 'home_posture', 'home_snowboard')),
  unit TEXT NOT NULL DEFAULT 'lb' CHECK (unit IN ('lb', 'kg')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  initializing INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO workouts_new (id, routine, unit, started_at, completed_at, initializing)
SELECT id, routine, unit, started_at, completed_at, initializing FROM workouts;
--> statement-breakpoint
CREATE TABLE _child_preservation_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
--> statement-breakpoint
INSERT INTO _child_preservation_guard (ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM workouts) = (SELECT COUNT(*) FROM workouts_new) THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE workouts;
--> statement-breakpoint
ALTER TABLE workouts_new RENAME TO workouts;
--> statement-breakpoint
CREATE INDEX workouts_completed_at_idx ON workouts(completed_at);
--> statement-breakpoint
INSERT INTO workout_sets (id, workout_id, exercise_key, exercise_name, set_number, target_reps, weight, reps, completed, created_at, updated_at)
SELECT id, workout_id, exercise_key, exercise_name, set_number, target_reps, weight, reps, completed, created_at, updated_at
FROM workout_sets_backup_0005
WHERE NOT EXISTS (SELECT 1 FROM workout_sets AS existing WHERE existing.id = workout_sets_backup_0005.id)
  AND EXISTS (SELECT 1 FROM workouts AS parent WHERE parent.id = workout_sets_backup_0005.workout_id);
--> statement-breakpoint
INSERT INTO _child_preservation_guard (ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM workout_sets) = (SELECT COUNT(*) FROM workout_sets_backup_0005) THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO _child_preservation_guard (ok)
SELECT CASE WHEN EXISTS (SELECT 1 FROM workout_sets AS s LEFT JOIN workouts AS w ON w.id = s.workout_id WHERE w.id IS NULL) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE _child_preservation_guard;
--> statement-breakpoint
DROP TABLE workout_sets_backup_0005;
--> statement-breakpoint
-- W-PLAN-SAFE-001 support, part 2 of 2: the plan_meta marker table
-- (single source of truth for "the plan seed has completed" — plan
-- code never infers initialization from plan tables being empty, so
-- a saved plan can never be overwritten by the default template),
-- a backfill marking every pre-existing database that already holds
-- plan rows as seeded (its saved plan is preserved exactly), and the
-- (routine, exercise_key) unique index that arbitrates concurrent
-- first-open seeds together with the existing unique indexes on
-- plan_schedule(day_index) and plan_daily_items(item_key).
CREATE TABLE IF NOT EXISTS plan_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO plan_meta (key, value)
SELECT 'seeded', '1'
WHERE EXISTS (SELECT 1 FROM plan_exercises)
   OR EXISTS (SELECT 1 FROM plan_schedule)
   OR EXISTS (SELECT 1 FROM plan_daily_items);
--> statement-breakpoint
-- W-PLAN-SAFE-001 (duplicate-key upgrade path): a database that ran
-- 0001–0004 can legally hold two rows with the same
-- (routine, exercise_key) — nothing forbade it before this migration —
-- and the unique index below would reject the whole upgrade. So
-- BEFORE creating the index: copy every duplicate row except the
-- smallest id of its (routine, exercise_key) group, verbatim and in
-- full, into the plan_exercise_conflicts archive table (all
-- plan_exercises columns plus an archived_note), then delete the
-- archived copies from plan_exercises. Nothing is silently dropped:
-- every removed row survives in the archive, queryable afterwards.
-- Databases without duplicates archive zero rows and behave exactly
-- as before; databases that already applied 0005 never re-run this.
CREATE TABLE IF NOT EXISTS plan_exercise_conflicts (
  id INTEGER PRIMARY KEY,
  routine TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  sets INTEGER NOT NULL,
  target_reps TEXT NOT NULL,
  archived_note TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO plan_exercise_conflicts (id, routine, sort_order, exercise_key, exercise_name, sets, target_reps, archived_note)
SELECT id, routine, sort_order, exercise_key, exercise_name, sets, target_reps,
       'duplicate (routine, exercise_key) row archived by migration 0005 before creating plan_exercises_routine_key_idx; the smallest id of the group was kept in plan_exercises'
FROM plan_exercises
WHERE id NOT IN (SELECT MIN(id) FROM plan_exercises GROUP BY routine, exercise_key);
--> statement-breakpoint
DELETE FROM plan_exercises
WHERE id NOT IN (SELECT MIN(id) FROM plan_exercises GROUP BY routine, exercise_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS plan_exercises_routine_key_idx ON plan_exercises(routine, exercise_key);
