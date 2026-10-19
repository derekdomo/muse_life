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
DROP TABLE workouts;
--> statement-breakpoint
ALTER TABLE workouts_new RENAME TO workouts;
--> statement-breakpoint
CREATE INDEX workouts_completed_at_idx ON workouts(completed_at);
--> statement-breakpoint
CREATE TABLE plan_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  sets INTEGER NOT NULL,
  target_reps TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX plan_exercises_routine_idx ON plan_exercises(routine, sort_order);
--> statement-breakpoint
CREATE TABLE plan_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_index INTEGER NOT NULL,
  routine_code TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE UNIQUE INDEX plan_schedule_day_idx ON plan_schedule(day_index);
--> statement-breakpoint
CREATE TABLE plan_daily_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX plan_daily_items_key_idx ON plan_daily_items(item_key);
--> statement-breakpoint
CREATE TABLE daily_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX daily_completions_date_item_idx ON daily_completions(date_key, item_key);
