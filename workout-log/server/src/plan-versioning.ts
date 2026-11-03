// W4.1: plan template versioning (pure functions, zero imports).
// Every exported function is exercised by
// workout-log/validate-plan-versioning.mjs against the real module.
//
// Model:
// - plan_versions registers one row per saved template version
//   (version = 1, 2, 3, ...; created_at = the save instant).
// - Each updatePlan save clones the CURRENT live plan_exercises /
//   plan_schedule rows into the read-only history tables stamped
//   with the old version, then writes the new rows stamped with the
//   new version — all in ONE atomic db.batch, so a version is never
//   half-archived.
// - New sessions bind the template version at creation: the version
//   goes on the workouts row, and each created workout_sets row
//   snapshots the exercise name / target reps / rest seconds as they
//   were at creation. History pages render from the session's own
//   snapshot and never re-read the live template — a renamed action
//   or changed target can never rewrite history.

export const PLAN_VERSION_FIRST = 1;

// Rest seconds: an optional per-exercise default for the rest timer.
// null / undefined means "no custom default" (the timer's own
// default); otherwise an integer 15–600. Anything else is REJECTED,
// never clamped.
export const REST_SECONDS_MIN = 15;
export const REST_SECONDS_MAX = 600;

export type PlanUnit = "lb" | "kg";

export function validateRestSeconds(
  value: number | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < REST_SECONDS_MIN || value > REST_SECONDS_MAX) {
    return `默认休息需要是 ${REST_SECONDS_MIN}–${REST_SECONDS_MAX} 秒的整数`;
  }
  return null;
}

export function normalizeRestSeconds(
  value: number | null | undefined,
): number | null {
  if (value === undefined || value === null) return null;
  return value;
}

export function validatePlanUnit(value: unknown): value is PlanUnit {
  return value === "lb" || value === "kg";
}

export function normalizePlanUnit(value: unknown): PlanUnit {
  return validatePlanUnit(value) ? value : "lb";
}

export interface VersionedExerciseInput {
  routine: string;
  sortOrder: number;
  exerciseKey: string;
  exerciseName: string;
  sets: number;
  targetReps: string;
  unit: PlanUnit;
  restSeconds: number | null;
}

export interface VersionedScheduleInput {
  dayIndex: number;
  routineCode: string;
  note: string;
}

// The result of stamping a fresh plan at a version: the rows that go
// into the live tables (already version-stamped) plus the
// plan_versions registration row.
export interface StampedPlan {
  version: number;
  exercises: (VersionedExerciseInput & { version: number })[];
  schedule: (VersionedScheduleInput & { version: number })[];
  versionRow: { version: number; createdAt: Date; note: string };
}

export function stampPlanAtVersion(
  exercises: VersionedExerciseInput[],
  schedule: VersionedScheduleInput[],
  version: number,
  createdAt: Date,
  note: string,
): StampedPlan {
  return {
    version,
    exercises: exercises.map((e) => ({ ...e, version })),
    schedule: schedule.map((s) => ({ ...s, version })),
    versionRow: { version, createdAt, note },
  };
}

// Archive step: clone the outgoing live rows into the read-only
// history tables, stamped with the version they lived under. The
// clone is verbatim — history rows are never edited afterwards, so
// an old template's names/targets survive any later rename.
export interface ArchivedExerciseRow extends VersionedExerciseInput {
  version: number;
}

export interface ArchivedScheduleRow extends VersionedScheduleInput {
  version: number;
}

export interface VersionMigration {
  newVersion: number;
  exerciseHistory: ArchivedExerciseRow[];
  scheduleHistory: ArchivedScheduleRow[];
  stamped: StampedPlan;
}

// Pure computation of one version migration. oldVersion is the
// version currently live (PLAN_VERSION_FIRST - 1 = 0 means "no
// versioned plan yet" — nothing is archived, the first save simply
// lands at version 1). The caller performs the clone + delete +
// insert + registration as ONE atomic batch; this function only
// computes the rows.
export function computeVersionMigration(input: {
  oldVersion: number;
  oldExercises: VersionedExerciseInput[];
  oldSchedule: VersionedScheduleInput[];
  newExercises: VersionedExerciseInput[];
  newSchedule: VersionedScheduleInput[];
  createdAt: Date;
  note: string;
}): VersionMigration {
  const newVersion = input.oldVersion + 1;
  const exerciseHistory: ArchivedExerciseRow[] =
    input.oldVersion >= PLAN_VERSION_FIRST
      ? input.oldExercises.map((e) => ({ ...e, version: input.oldVersion }))
      : [];
  const scheduleHistory: ArchivedScheduleRow[] =
    input.oldVersion >= PLAN_VERSION_FIRST
      ? input.oldSchedule.map((s) => ({ ...s, version: input.oldVersion }))
      : [];
  const stamped = stampPlanAtVersion(
    input.newExercises,
    input.newSchedule,
    newVersion,
    input.createdAt,
    input.note,
  );
  return { newVersion, exerciseHistory, scheduleHistory, stamped };
}

// Session snapshot binding: at startWorkout time the template row is
// already the truth — the workout row records which template
// version built it, and every created set row records the exercise
// name / target reps / rest seconds as they were then. Later edits
// create a new version and never touch these rows, so history is
// immutable by construction.
export interface SessionSnapshotExercise {
  exerciseKey: string;
  exerciseName: string;
  targetReps: string;
  restSeconds: number | null;
  sets: number;
}

export interface BoundSession {
  planVersion: number;
  sets: {
    exerciseKey: string;
    exerciseName: string;
    targetReps: string;
    restSeconds: number | null;
  }[];
}

export function bindSessionSnapshot(
  templateExercises: SessionSnapshotExercise[],
  templateVersion: number,
): BoundSession {
  const sets: BoundSession["sets"] = [];
  for (const exercise of templateExercises) {
    for (let i = 0; i < exercise.sets; i++) {
      sets.push({
        exerciseKey: exercise.exerciseKey,
        exerciseName: exercise.exerciseName,
        targetReps: exercise.targetReps,
        restSeconds: exercise.restSeconds,
      });
    }
  }
  return { planVersion: templateVersion, sets };
}

// Read-side guard: a history renderer must use the session's own
// snapshot, never the live template. Given a stored set row and the
// (possibly newer) live template row for the same key, the rendered
// name/target/rest MUST equal the stored snapshot — any other choice
// is history rewriting and is rejected here.
export function resolveHistoryDisplay(input: {
  snapshotName: string;
  snapshotTargetReps: string;
  snapshotRestSeconds: number | null;
  liveName: string | null;
  liveTargetReps: string | null;
  liveRestSeconds: number | null | undefined;
}): { name: string; targetReps: string; restSeconds: number | null } {
  return {
    name: input.snapshotName,
    targetReps: input.snapshotTargetReps,
    restSeconds: input.snapshotRestSeconds,
  };
}

// Version list for the editor: every registered version with its
// edit time, newest first; the live version is marked current, all
// others read-only.
export interface PlanVersionEntry {
  version: number;
  createdAt: Date | string;
  note: string;
  current: boolean;
}

export function buildVersionList(
  versions: { version: number; createdAt: Date | string; note: string }[],
  liveVersion: number,
): PlanVersionEntry[] {
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({ ...v, current: v.version === liveVersion }));
}
