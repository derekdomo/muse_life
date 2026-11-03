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
  // W3.1 (migration 0009, additive): optional end-of-session self
  // report, written only by completeWorkout when the user supplies
  // it. All three stay NULL when the user skips the finish panel —
  // NULL means "not recorded", never a default value. sessionRpe is
  // 1–10; painFlags is a JSON array of flag keys (e.g. ["shoulder"]);
  // sessionNotes is free text.
  sessionRpe: integer("session_rpe"),
  painFlags: text("pain_flags"),
  sessionNotes: text("session_notes"),
  // W4.1 (migration 0012, additive): the template version that built
  // this session. NULL for sessions created before versioning
  // existed — never backfilled with a guess.
  planVersion: integer("plan_version"),
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
  // W3.1 (migration 0009, additive): optional per-set RIR
  // (reps in reserve), an integer 0–5. NULL = not recorded; a NULL
  // RIR never feeds any calculation (prefill / progression / volume).
  rir: integer("rir"),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  // W4.1 (migration 0012, additive): per-set snapshot of the planned
  // default rest seconds at session creation. NULL = the plan had no
  // custom default for this exercise when the session was built.
  restSeconds: integer("rest_seconds"),
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
//
// W4.1 (migration 0012): every save stamps the live rows with the new
// template version and clones the outgoing rows into the read-only
// history tables first — all in one atomic batch, so a version is
// never half-archived. Each exercise row also carries its unit
// (lb/kg) and an optional default rest-seconds for the rest timer
// (NULL = the timer's own default).
export const planExercises = sqliteTable("plan_exercises", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routine: text("routine").notNull(),
  sortOrder: integer("sort_order").notNull(),
  exerciseKey: text("exercise_key").notNull(),
  exerciseName: text("exercise_name").notNull(),
  sets: integer("sets").notNull(),
  targetReps: text("target_reps").notNull(),
  version: integer("version").notNull().default(1),
  unit: text("unit", { enum: ["lb", "kg"] }).notNull().default("lb"),
  restSeconds: integer("rest_seconds"),
});

// One row per weekday (day_index 0 = Monday … 6 = Sunday). routine_code
// is a workout routine key or the non-workout codes "swim" / "rest".
// W4.1: stamped with the template version like plan_exercises.
export const planSchedule = sqliteTable("plan_schedule", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayIndex: integer("day_index").notNull(),
  routineCode: text("routine_code").notNull(),
  note: text("note").notNull().default(""),
  version: integer("version").notNull().default(1),
});

// Template version registry (W4.1, migration 0012, additive). One row
// per saved version: version 1, 2, 3, ... with the save instant and
// an optional note. Written by updatePlan in the same atomic batch as
// the plan rows themselves.
export const planVersions = sqliteTable("plan_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: integer("version").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  note: text("note").notNull().default(""),
});

// Read-only archive of superseded plan_exercises rows (W4.1). Cloned
// verbatim from the outgoing live rows before each save, stamped
// with the version they lived under. Never edited afterwards — an
// old template's names and targets survive any later rename.
export const planExerciseHistory = sqliteTable("plan_exercise_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: integer("version").notNull(),
  routine: text("routine").notNull(),
  sortOrder: integer("sort_order").notNull(),
  exerciseKey: text("exercise_key").notNull(),
  exerciseName: text("exercise_name").notNull(),
  sets: integer("sets").notNull(),
  targetReps: text("target_reps").notNull(),
  unit: text("unit", { enum: ["lb", "kg"] }).notNull().default("lb"),
  restSeconds: integer("rest_seconds"),
});

// Read-only archive of superseded plan_schedule rows (W4.1). Same
// verbatim-clone discipline as plan_exercise_history.
export const planScheduleHistory = sqliteTable("plan_schedule_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: integer("version").notNull(),
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

// Owner-recorded body weight + circumferences (W5.3, migration
// 0010, additive). One row per measured_at date — an
// America/Los_Angeles calendar date (YYYY-MM-DD) kept as text, like
// daily_completions.date_key; saveBodyMeasurement upserts on it, so
// a same-day save overwrites that day's row and never touches other
// dates. body_weight is always recorded (required at entry) in
// weight_unit (the workout_sets lb/kg unit口径）; every circumference
// (waist / chest / hips / arm / thigh, in cm) is optional and stays
// NULL when the owner did not record it — NULL means "not
// recorded", never a value to guess or fill. Manual data only: no
// external source, and nothing here feeds any score or formula.
export const bodyMeasurements = sqliteTable("body_measurements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  measuredAt: text("measured_at").notNull(),
  bodyWeight: real("body_weight").notNull(),
  weightUnit: text("weight_unit", { enum: ["lb", "kg"] }).notNull().default("lb"),
  waist: real("waist"),
  chest: real("chest"),
  hips: real("hips"),
  arm: real("arm"),
  thigh: real("thigh"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
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

// Readiness tip cache (W4.2, migration 0011, additive). Single row
// (id = 1) holding the latest tip synced from 健康看板 (space-4):
// payload is the JSON tip, source_read_started_at is the version (the
// instant the space-4 read began — the L1-RACE-001 contract, so an
// older read can never overwrite a newer tip). Read-only data: it is
// rendered on the start page and never feeds any plan, weight, set,
// or completion logic.
export const readinessTipCache = sqliteTable("readiness_tip_cache", {
  id: integer("id").primaryKey(),
  payload: text("payload").notNull(),
  sourceReadStartedAt: text("source_read_started_at").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
