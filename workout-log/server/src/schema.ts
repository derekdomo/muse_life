import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workouts = sqliteTable("workouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routine: text("routine", { enum: ["push", "pull", "legs"] }).notNull(),
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
