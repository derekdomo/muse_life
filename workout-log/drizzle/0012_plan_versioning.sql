-- W4.1: plan template versioning. Additive: pure CREATE TABLE for the
-- version registry + read-only history tables, plus ADD COLUMN on
-- existing tables (no ALTER of existing columns, no DROP/RENAME).
--
-- Model: every updatePlan save stamps the new live rows with the new
-- version and registers one plan_versions row. Before overwriting,
-- the save clones the outgoing live rows into plan_exercise_history /
-- plan_schedule_history stamped with the old version — those history
-- rows are never edited afterwards, so an old template's names and
-- targets survive any later rename. Sessions bind the template
-- version at creation (workouts.plan_version) and snapshot the
-- exercise name / target reps / rest seconds into each created
-- workout_sets row, so history renders from the session's own
-- snapshot and can never be rewritten by a new template.
CREATE TABLE plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- Read-only archive of superseded plan_exercises rows (W4.1).
--> statement-breakpoint

CREATE TABLE plan_exercise_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  routine TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  sets INTEGER NOT NULL,
  target_reps TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'lb',
  rest_seconds INTEGER
);

-- Read-only archive of superseded plan_schedule rows (W4.1).
--> statement-breakpoint

CREATE TABLE plan_schedule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  day_index INTEGER NOT NULL,
  routine_code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- Version stamp + per-exercise unit and default rest seconds (W4.1).
-- Existing rows keep working: version defaults to 1, unit to 'lb',
-- rest_seconds stays NULL (no custom default — the rest timer's own
-- default applies).
--> statement-breakpoint

ALTER TABLE plan_exercises ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE plan_exercises ADD COLUMN unit TEXT NOT NULL DEFAULT 'lb';
--> statement-breakpoint

ALTER TABLE plan_exercises ADD COLUMN rest_seconds INTEGER;

-- Version stamp for the weekly schedule rows (W4.1).
--> statement-breakpoint

ALTER TABLE plan_schedule ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- The template version that built this session (W4.1). NULL for
-- sessions created before versioning existed — never backfilled with
-- a guess.
--> statement-breakpoint

ALTER TABLE workouts ADD COLUMN plan_version INTEGER;

-- Per-set snapshot of the planned default rest seconds at session
-- creation (W4.1). NULL = the plan had no custom default for this
-- exercise when the session was built.
--> statement-breakpoint

ALTER TABLE workout_sets ADD COLUMN rest_seconds INTEGER;

-- Backfill for databases that already hold a plan: the live rows are
-- version 1 by definition, so register version 1 once. Databases
-- with no plan rows register nothing — their first save lands at
-- version 1 through the normal updatePlan path.
--> statement-breakpoint

INSERT INTO plan_versions (version, created_at, note)
SELECT 1, CAST(strftime('%s','now') AS INTEGER) * 1000, 'W4.1 migration backfill'
WHERE EXISTS (SELECT 1 FROM plan_exercises)
  AND NOT EXISTS (SELECT 1 FROM plan_versions WHERE version = 1);
