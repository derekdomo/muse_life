CREATE TABLE workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine TEXT NOT NULL CHECK (routine IN ('push', 'pull', 'legs')),
  unit TEXT NOT NULL DEFAULT 'lb' CHECK (unit IN ('lb', 'kg')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE workout_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_key TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  set_number INTEGER NOT NULL,
  target_reps TEXT NOT NULL,
  weight REAL,
  reps INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX workout_sets_workout_id_idx ON workout_sets(workout_id);
--> statement-breakpoint
CREATE INDEX workouts_completed_at_idx ON workouts(completed_at);
