import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workouts = sqliteTable("workouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routine: text("routine", {
    enum: ["push", "pull", "legs", "home_posture", "home_snowboard"],
  }).notNull(),
  unit: text("unit", { enum: ["lb", "kg"] }).notNull().default("lb"),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  // W-START-001: a workout is inserted with initializing = 1 while
  // startWorkout inserts its prefill sets; it becomes a usable active
  // workout only when a single conditional UPDATE flips this to 0.
  // Every read/write target selection excludes initializing = 1 rows,
  // so an initializing workout is invisible and unwritable. Existing
  // rows default to 0 (ready).
  initializing: integer("initializing").notNull().default(0),
});

export const workoutSets = sqliteTable("workout_sets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workoutId: integer("workout_id")
    .notNull()
    .references(() => workouts.id, { onDelete: "cascade" }),
  exerciseKey: text("exercise_key").notNull(),
  exerciseName: text("exercise_name").notNull(),
  setNumber: integer("set_number").notNull(),
  targetReps: text("target_reps").notNull(),
  weight: real("weight"),
  reps: integer("reps"),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Editable training plan (2026-10-18 frequency sync): routine templates
// are persisted rows, not code constants. startWorkout builds a session
// from these rows; the plan editor rewrites them through updatePlan.
export const planExercises = sqliteTable("plan_exercises", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routine: text("routine").notNull(),
  sortOrder: integer("sort_order").notNull(),
  exerciseKey: text("exercise_key").notNull(),
  exerciseName: text("exercise_name").notNull(),
  sets: integer("sets").notNull(),
  targetReps: text("target_reps").notNull(),
});

// One row per weekday (day_index 0 = Monday … 6 = Sunday). routine_code
// is a workout routine key or the non-workout codes "swim" / "rest".
export const planSchedule = sqliteTable("plan_schedule", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayIndex: integer("day_index").notNull(),
  routineCode: text("routine_code").notNull(),
  note: text("note").notNull().default(""),
});

// The daily posture micro-routine items (checklist on the home screen).
export const planDailyItems = sqliteTable("plan_daily_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemKey: text("item_key").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  sortOrder: integer("sort_order").notNull(),
});

// Plan bookkeeping markers (W-PLAN-SAFE-001, migration 0005). The
// 'seeded' row is the ONLY signal that the default plan seed has
// completed: it is written in the same atomic batch as the seed rows
// themselves (and backfilled by the migration for databases that
// already held a plan). Plan code never infers "not initialized" from
// the plan tables being empty, so a saved plan can never be
// overwritten by the default template.
export const planMeta = sqliteTable("plan_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Archive of duplicate (routine, exercise_key) plan rows (migration
// 0005): when a pre-0005 database held two rows for one key, every
// copy except the smallest id was moved here verbatim before the
// unique index was created — nothing was dropped. Migration 0006
// added the tracking columns: a group is an UNCONFIRMED conflict
// while any of its rows has resolvedAt null; getPlan surfaces such
// groups explicitly and resolvePlanConflict closes them, recording
// which candidate the owner picked (resolutionSelectedId) and when
// (resolvedAt) on every row of the group. Rows archived later as the
// displaced live copy of a resolution are born already-resolved.
export const planExerciseConflicts = sqliteTable("plan_exercise_conflicts", {
  id: integer("id").primaryKey(),
  routine: text("routine").notNull(),
  sortOrder: integer("sort_order").notNull(),
  exerciseKey: text("exercise_key").notNull(),
  exerciseName: text("exercise_name").notNull(),
  sets: integer("sets").notNull(),
  targetReps: text("target_reps").notNull(),
  archivedNote: text("archived_note").notNull(),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  resolution: text("resolution"),
  resolutionSelectedId: integer("resolution_selected_id"),
});

// Per-day completion of one daily micro-routine item. date_key is the
// America/Los_Angeles calendar date (YYYY-MM-DD). Purely informational:
// it never gates starting or finishing a workout.
export const dailyCompletions = sqliteTable("daily_completions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dateKey: text("date_key").notNull(),
  itemKey: text("item_key").notNull(),
  done: integer("done").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
