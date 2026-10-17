import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import * as schema from "./schema";

const routineSchema = z.enum(["push", "pull", "legs"]);
const unitSchema = z.enum(["lb", "kg"]);

const ROUTINES = {
  push: [
    { key: "barbell-bench", name: "杠铃卧推", sets: 4, target: "6–8" },
    { key: "overhead-press", name: "站姿推举", sets: 3, target: "8–10" },
    { key: "incline-dumbbell-press", name: "上斜哑铃卧推", sets: 3, target: "8–12" },
    { key: "dips", name: "双杠臂屈伸", sets: 3, target: "10–12" },
    { key: "lateral-raise", name: "哑铃侧平举", sets: 3, target: "12–15" },
  ],
  pull: [
    { key: "wide-lat-pulldown", name: "高位下拉 · 宽握", sets: 4, target: "8–12" },
    { key: "close-lat-pulldown", name: "高位下拉 · 窄握/反握", sets: 3, target: "10–12" },
    { key: "close-seated-row", name: "坐姿划船 · 窄距", sets: 4, target: "10–12" },
    { key: "wide-seated-row", name: "坐姿划船 · 宽距", sets: 3, target: "10–12" },
    { key: "face-pull", name: "面拉", sets: 3, target: "12–15" },
    { key: "rope-curl", name: "绳索弯举", sets: 3, target: "10–12" },
  ],
  legs: [
    { key: "back-squat", name: "深蹲", sets: 4, target: "6–8" },
    { key: "romanian-deadlift", name: "罗马尼亚硬拉", sets: 3, target: "8–10" },
    { key: "bulgarian-split-squat", name: "保加利亚分腿蹲", sets: 3, target: "8–10" },
    { key: "lying-leg-curl", name: "俯卧腿弯举", sets: 3, target: "10–12" },
  ],
} as const;

const setResponse = z.object({
  id: z.number(),
  workout_id: z.number(),
  exercise_key: z.string(),
  exercise_name: z.string(),
  set_number: z.number(),
  target_reps: z.string(),
  weight: z.number().nullable(),
  reps: z.number().nullable(),
  completed: z.boolean(),
});

const workoutResponse = z.object({
  id: z.number(),
  routine: routineSchema,
  unit: unitSchema,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  sets: z.array(setResponse),
  // W1.3 (additive): true only on a workout freshly created by
  // startWorkout whose prefill weights were converted from the previous
  // comparable workout's different unit. Omitted/false everywhere else;
  // older clients ignore it.
  prefill_unit_converted: z.boolean().optional(),
});

async function loadWorkout(ctx: Ctx, workoutId: number) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.workouts).where(eq(schema.workouts.id, workoutId)).limit(1);
  const workout = rows[0];
  if (!workout) return null;
  const setRows = await db
    .select()
    .from(schema.workoutSets)
    .where(eq(schema.workoutSets.workoutId, workoutId))
    .orderBy(asc(schema.workoutSets.id));
  return {
    id: workout.id,
    routine: workout.routine,
    unit: workout.unit,
    started_at: workout.startedAt.toISOString(),
    completed_at: workout.completedAt?.toISOString() ?? null,
    sets: setRows.map((row) => ({
      id: row.id,
      workout_id: row.workoutId,
      exercise_key: row.exerciseKey,
      exercise_name: row.exerciseName,
      set_number: row.setNumber,
      target_reps: row.targetReps,
      weight: row.weight,
      reps: row.reps,
      completed: row.completed,
    })),
  };
}

const startResponse = z.object({ forbidden: z.boolean(), workout: workoutResponse.nullable() });
const doneResponse = z.object({ ok: z.boolean(), forbidden: z.boolean() });
const addSetResponse = z.object({ forbidden: z.boolean(), set: setResponse.nullable() });
const weekSummaryResponse = z.object({
  week_start: z.string(),
  sessions: z.number(),
  measured_completed_sets: z.number(),
  unmeasured_completed_sets: z.number(),
  volume_lb: z.number(),
  volume_kg: z.number(),
});

const comparableHistorySetResponse = z.object({
  set_number: z.number(),
  weight: z.number().nullable(),
  reps: z.number().nullable(),
  completed: z.boolean(),
});

// W1-CONSISTENCY-001 (additive, optional): one exercise's most recent
// comparable history, selected per routine by the same raw selection
// the startWorkout prefill uses (see selectComparableHistory). Sets
// are in the source workout's own unit/values — unconverted. Existing
// consumers （健康看板 sync channel) ignore the field.
const comparableHistoryEntryResponse = z.object({
  routine: routineSchema,
  exercise_key: z.string(),
  unit: unitSchema,
  target: z.string(),
  sets: z.array(comparableHistorySetResponse),
});

const dashboardResponse = z.object({
  forbidden: z.boolean(),
  active_workout: workoutResponse.nullable(),
  recent_workouts: z.array(workoutResponse),
  week_summaries: z.array(weekSummaryResponse),
  comparable_history: z.array(comparableHistoryEntryResponse).optional(),
});

// Owner-only gate (AUDIT-02 / L0.1): every write, initialization, and
// browser-facing action must verify this before touching the database. A
// missing viewer (null/undefined) is treated as not authorized, never as
// owner.
function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

// Trusted sync channel (cross-artifact read fix, 2026-10-15): 健康看板
// (space-4) keeps a strength summary that it refreshes by spawning a task
// which reads this artifact through its published getDashboard action. That
// invocation travels the daemon's internal action channel and carries NO
// browser viewer, so the strict isOwner gate answered every sync with
// forbidden: true — and 健康看板 (correctly) refuses to overwrite its last
// good snapshot on a failed read, so its strength panel froze at the last
// pre-gate sync even though newer workouts kept being logged here.
// getDashboard therefore also accepts an invocation that carries no viewer
// at all — a shape only daemon-internal channels can produce — while any
// invocation that DOES carry a viewer must still be the owner: a guest
// following a share link always arrives WITH a viewer whose isOwner is
// false and keeps receiving zero data. Every mutation (startWorkout,
// updateSet, addSet, completeWorkout, discardWorkout) keeps the strict
// owner gate; this channel is read-only.
function isOwnerOrSyncChannel(ctx: Ctx): boolean {
  return ctx.viewer === undefined || ctx.viewer === null || ctx.viewer.isOwner === true;
}

// W0.3: mutation target ownership. A set/workout mutation may only land
// on a workout that exists and is still active (completed_at null). A
// missing workout is "not-found"; an already-completed one is
// "not-active" — its rows are history and must never be written,
// completed again, or deleted by a mutation aimed at a stale id.
// W-START-001: a workout still initializing (startWorkout has not
// finished inserting its prefill sets and flipping it ready) is never
// a valid target either — "initializing": invisible to getDashboard
// and unwritable by updateSet / addSet / completeWorkout /
// discardWorkout, so no user write can ever land on it.
// W-ACTIVE-001: the handlers no longer decide with this function —
// each write carries the same condition inside its single statement,
// so a completeWorkout landing between a check and a write cannot be
// overwritten. This pure mirror remains for validation scripts.
export function mutationTargetDecision(
  workout: { completed_at: string | null; initializing?: boolean } | null,
): "ok" | "not-found" | "not-active" | "initializing" {
  if (!workout) return "not-found";
  if (workout.initializing) return "initializing";
  if (workout.completed_at != null) return "not-active";
  return "ok";
}

// W0.4: single-active guarantee. startWorkout inserts optimistically
// and then re-checks: if an earlier active workout (smaller id) exists
// alongside the just-inserted one, the insert must yield to it.
export function resolveStartConflict(
  existingActiveId: number | null,
  insertedId: number,
): { action: "created" | "yield"; keepId: number } {
  if (existingActiveId != null && existingActiveId < insertedId) {
    return { action: "yield", keepId: existingActiveId };
  }
  return { action: "created", keepId: insertedId };
}

// W-START-001 (invisible-initialization contract): whether a
// just-inserted workout that must yield to an earlier active one may
// be safely reclaimed (deleted). Under the initializing contract this
// no longer needs edit heuristics: while initializing = 1 the row is
// invisible and unwritable to every other action, so NO user write
// can possibly have landed on it — reclaim is safe exactly while the
// row is still initializing and not completed. startWorkout enforces
// exactly these conditions inside its single conditional DELETE
// (WHERE id = ? AND initializing = 1 AND completed_at IS NULL) — the
// DELETE is the verdict; this pure mirror exists so validation
// scripts can exercise the decision without the database.
export function canReclaimInitializingWorkout(input: {
  initializing: boolean;
  completedAt: string | null;
}): boolean {
  return input.initializing && input.completedAt == null;
}

// W-START-001 (yield decision): when a start's conflict re-check finds
// an earlier active workout, what happens next depends on that
// workout's state — never return it while it is still initializing.
// This pure function is the whole decision; startWorkout drives it in
// a bounded poll loop, re-reading the other row between waits.
//  - other gone (its initialization failed and it cleaned itself up,
//    or it was taken over): proceed — flip own workout ready.
//  - other ready: yield to it (reclaim own initializing row, return
//    the other workout, which is usable: ready with its sets in).
//  - other still initializing and poll attempts remain: wait.
//  - other still initializing, attempts exhausted, and its started_at
//    is at least 30s old: it is a failed leftover — take over
//    (conditionally delete it, then flip own workout ready).
//  - other still initializing, attempts exhausted, but fresh: a live
//    initialization is in flight — reclaim own row and fail with a
//    retryable error instead of returning an unusable workout.
// Self-contained (no module state) so validation scripts can run it
// verbatim over the full matrix.
export function resolveYieldDecision(
  other: { present: boolean; initializing: boolean; startedAtMs: number | null },
  attemptsLeft: number,
  nowMs: number,
): "proceed-self" | "yield-ready" | "wait" | "takeover" | "retry" {
  if (!other.present) return "proceed-self";
  if (!other.initializing) return "yield-ready";
  if (attemptsLeft > 0) return "wait";
  const ageMs = other.startedAtMs == null ? Number.POSITIVE_INFINITY : nowMs - other.startedAtMs;
  return ageMs >= 30_000 ? "takeover" : "retry";
}

// Bounded poll budget for the yield wait above: 10 × 200ms ≈ 2s —
// long enough for a concurrent start's handful of inserts to finish,
// far short of the 30s staleness threshold.
export const YIELD_WAIT_ATTEMPTS = 10;
export const YIELD_WAIT_INTERVAL_MS = 200;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whole-week coverage summaries (H-UNITS-001). Pure and self-contained so
// it can be extracted and run standalone: workouts carry id, completed_at
// (ISO string) and unit; sets carry workout_id, weight, reps, completed;
// now is the current instant. Weeks are bucketed by America/Los_Angeles
// local date with Monday as the week start, and only the current and
// previous week are returned (oldest first, both always present). Volume
// is summed per workout in that workout's own unit — measured sets
// (completed, with both weight and reps) contribute weight × reps to
// volume_lb or volume_kg with NO unit conversion; completed sets missing
// weight or reps count as unmeasured and contribute no volume.
export function summarizeWeekSummaries(
  workouts: { id: number; completed_at: string; unit: "lb" | "kg" }[],
  sets: { workout_id: number; weight: number | null; reps: number | null; completed: boolean }[],
  now: Date,
): z.infer<typeof weekSummaryResponse>[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const laFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localParts = (date: Date) => {
    let year = 0;
    let month = 0;
    let day = 0;
    for (const part of laFormat.formatToParts(date)) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
    }
    return { year, month, day };
  };
  const formatDate = (ms: number) => {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };
  // UTC-midnight timestamp of the Monday (local LA date) of the week
  // containing `date`.
  const weekStartMs = (date: Date) => {
    const { year, month, day } = localParts(date);
    const dayMs = Date.UTC(year, month - 1, day);
    const dow = new Date(dayMs).getUTCDay(); // 0 = Sunday
    return dayMs - ((dow + 6) % 7) * DAY_MS;
  };

  const currentStart = weekStartMs(now);
  const previousStart = currentStart - 7 * DAY_MS;
  const buckets = new Map<number, z.infer<typeof weekSummaryResponse>>();
  for (const start of [previousStart, currentStart]) {
    buckets.set(start, {
      week_start: formatDate(start),
      sessions: 0,
      measured_completed_sets: 0,
      unmeasured_completed_sets: 0,
      volume_lb: 0,
      volume_kg: 0,
    });
  }

  const workoutWeek = new Map<number, { start: number; unit: "lb" | "kg" }>();
  for (const workout of workouts) {
    const completedAt = new Date(workout.completed_at);
    if (Number.isNaN(completedAt.getTime())) continue;
    const start = weekStartMs(completedAt);
    const bucket = buckets.get(start);
    if (!bucket) continue;
    bucket.sessions += 1;
    workoutWeek.set(workout.id, { start, unit: workout.unit });
  }

  for (const set of sets) {
    if (!set.completed) continue;
    const info = workoutWeek.get(set.workout_id);
    if (!info) continue;
    const bucket = buckets.get(info.start);
    if (!bucket) continue;
    if (set.weight != null && set.reps != null) {
      bucket.measured_completed_sets += 1;
      const volume = set.weight * set.reps;
      if (info.unit === "lb") bucket.volume_lb += volume;
      else bucket.volume_kg += volume;
    } else {
      bucket.unmeasured_completed_sets += 1;
    }
  }

  const result: z.infer<typeof weekSummaryResponse>[] = [];
  for (const start of [previousStart, currentStart]) {
    const bucket = buckets.get(start);
    if (bucket) result.push(bucket);
  }
  return result;
}

function targetRepRange(target: string) {
  const values = target.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  const first = values[0] ?? 8;
  return { min: first, max: values[1] ?? first };
}

// W1.1–W1.4: the single progressive-overload rule, shared verbatim with
// the client (WeeklyReview). Pure: no IO, no side effects. `sets` is one
// exercise's sets from its most recent comparable workout; plannedSets is
// that workout's planned set count for the exercise.
export function progressionDecision(input: {
  plannedSets: number;
  sets: { weight: number | null; reps: number | null; completed: boolean }[];
  targetMin: number;
  targetMax: number;
  unit: "lb" | "kg";
}): { action: "increase" | "hold" | "reduce" | "none"; suggestedWeight: number | null; suggestedReps: number | null } {
  const none: { action: "none"; suggestedWeight: null; suggestedReps: null } = {
    action: "none",
    suggestedWeight: null,
    suggestedReps: null,
  };
  if (input.sets.length === 0 || input.plannedSets <= 0) return none;
  const completed = input.sets.filter((set) => set.completed);
  if (completed.length === 0) return none;
  const weightedWeights = completed
    .map((set) => set.weight)
    .filter((weight): weight is number => weight != null);
  // W1.4: bodyweight / unmeasured sets (weight null) never stand in as a
  // comparable load of 0 — with no weighed completed set there is no
  // weight suggestion at all.
  if (weightedWeights.length === 0) return none;
  const base = Math.max(...weightedWeights);
  const increment = input.unit === "lb" ? 5 : 2.5;
  if (completed.length < input.plannedSets) {
    // Not all planned sets were done: hold the weight; per-set reps are
    // carried over by the caller (suggestedReps null = carry over).
    return { action: "hold", suggestedWeight: base, suggestedReps: null };
  }
  if (completed.some((set) => set.reps == null)) return none;
  if (completed.every((set) => set.weight != null && set.reps != null && set.reps >= input.targetMax)) {
    return {
      action: "increase",
      suggestedWeight: Math.round((base + increment) * 2) / 2,
      suggestedReps: input.targetMin,
    };
  }
  if (completed.some((set) => set.reps != null && set.reps < input.targetMin)) {
    return {
      action: "reduce",
      suggestedWeight: Math.max(0, Math.round((base - increment) * 2) / 2),
      suggestedReps: null,
    };
  }
  return { action: "hold", suggestedWeight: base, suggestedReps: null };
}

// W1.3: cross-unit comparability. Weights from a workout recorded in the
// other unit are converted with this constant and rounded to the nearest
// 0.5; reps are never converted.
export const LB_TO_KG = 0.45359237;

export function convertWeight(weight: number | null, from: "lb" | "kg", to: "lb" | "kg"): number | null {
  if (weight == null || from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return Math.round(converted * 2) / 2;
}

export type PreviousSetLike = {
  exerciseKey: string;
  setNumber: number;
  weight: number | null;
  reps: number | null;
  completed: boolean;
};

// W1-CONSISTENCY-001 (cross-window fix): the ONE raw comparable-history
// selection every "next time" verdict derives from. Pure and
// self-contained so validation scripts can run it verbatim.
// `recentCompleted` is ONE routine's completed workouts, most recent
// first; only the first 20 are considered. For EACH exercise key
// independently, the most recent workout in that window that contains
// the exercise contributes ALL of its sets for the exercise (completed
// and uncompleted alike — the identical collection
// progressionDecision judges). NO unit conversion happens here: sets
// keep their source-workout values and the entry records the source
// unit and the exercise's target string from that workout, so the
// startWorkout prefill (via selectPreviousSetsByExercise) and the
// getDashboard comparable_history field are two views of this single
// selection and can never pick different candidates.
export type ComparableSetLike = PreviousSetLike & { targetReps: string };

export type ComparableHistoryRaw = {
  exerciseKey: string;
  unit: "lb" | "kg";
  target: string;
  sets: { setNumber: number; weight: number | null; reps: number | null; completed: boolean }[];
};

export function selectComparableHistory(
  recentCompleted: { unit: "lb" | "kg"; sets: ComparableSetLike[] }[],
  exerciseKeys: string[],
): ComparableHistoryRaw[] {
  const windowed = recentCompleted.slice(0, 20);
  const entries: ComparableHistoryRaw[] = [];
  for (const key of exerciseKeys) {
    for (const workout of windowed) {
      const sets = workout.sets.filter((set) => set.exerciseKey === key);
      if (sets.length === 0) continue;
      const first = sets[0];
      if (!first) continue;
      entries.push({
        exerciseKey: key,
        unit: workout.unit,
        target: first.targetReps,
        sets: sets.map((set) => ({
          setNumber: set.setNumber,
          weight: set.weight,
          reps: set.reps,
          completed: set.completed,
        })),
      });
      break;
    }
  }
  return entries;
}

// W1-CONSISTENCY-001: the prefill view of the same raw selection —
// when a contributing workout's unit differs from the target unit, its
// weights are converted per source workout (LB_TO_KG, 0.5 rounding);
// `converted` is true when any source actually used for a returned
// exercise was converted.
export function selectPreviousSetsByExercise(
  recentCompleted: { unit: "lb" | "kg"; sets: ComparableSetLike[] }[],
  exerciseKeys: string[],
  targetUnit: "lb" | "kg",
): { byExercise: Record<string, PreviousSetLike[]>; converted: boolean } {
  const byExercise: Record<string, PreviousSetLike[]> = {};
  let converted = false;
  for (const entry of selectComparableHistory(recentCompleted, exerciseKeys)) {
    const unitConverted = entry.unit !== targetUnit;
    if (unitConverted) converted = true;
    byExercise[entry.exerciseKey] = entry.sets.map((set) => ({
      exerciseKey: entry.exerciseKey,
      setNumber: set.setNumber,
      weight: unitConverted ? convertWeight(set.weight, entry.unit, targetUnit) : set.weight,
      reps: set.reps,
      completed: set.completed,
    }));
  }
  return { byExercise, converted };
}

type PreviousComparable = {
  byExercise: Record<string, PreviousSetLike[]>;
  converted: boolean;
};

// W1.3 + W1-CONSISTENCY-001: load ONE routine's 20 most recent
// completed workouts (any unit) with all their sets, in the raw shape
// selectComparableHistory consumes. This is the single history read
// behind both the startWorkout prefill and the dashboard's
// comparable_history field.
async function loadRoutineRecentCompleted(
  ctx: Ctx,
  routine: z.infer<typeof routineSchema>,
): Promise<{ unit: "lb" | "kg"; sets: ComparableSetLike[] }[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ id: schema.workouts.id, unit: schema.workouts.unit })
    .from(schema.workouts)
    .where(and(eq(schema.workouts.routine, routine), isNotNull(schema.workouts.completedAt)))
    .orderBy(desc(schema.workouts.completedAt))
    .limit(20);
  if (rows.length === 0) return [];
  const setRows = await db
    .select()
    .from(schema.workoutSets)
    .where(inArray(schema.workoutSets.workoutId, rows.map((row) => row.id)))
    .orderBy(asc(schema.workoutSets.id));
  const setsByWorkout = new Map<number, ComparableSetLike[]>();
  for (const row of setRows) {
    const list = setsByWorkout.get(row.workoutId) ?? [];
    list.push({
      exerciseKey: row.exerciseKey,
      setNumber: row.setNumber,
      targetReps: row.targetReps,
      weight: row.weight,
      reps: row.reps,
      completed: row.completed,
    });
    setsByWorkout.set(row.workoutId, list);
  }
  return rows.map((row) => ({
    unit: row.unit,
    sets: setsByWorkout.get(row.id) ?? [],
  }));
}

async function loadPreviousCompletedSets(
  ctx: Ctx,
  routine: z.infer<typeof routineSchema>,
  unit: z.infer<typeof unitSchema>,
): Promise<PreviousComparable> {
  const recentCompleted = await loadRoutineRecentCompleted(ctx, routine);
  return selectPreviousSetsByExercise(
    recentCompleted,
    ROUTINES[routine].map((exercise) => exercise.key),
    unit,
  );
}

// W1-CONSISTENCY-001: the dashboard view of the same raw selection,
// for all three routines — per exercise, the source workout's unit,
// the exercise's target string, and ALL of its sets in SOURCE values
// (no conversion; the client converts into the review unit exactly as
// the prefill path converts into the new workout's unit). This is
// what lets the weekly review judge the same candidate the prefill
// used even when that candidate sits beyond the global
// recent_workouts window (which mixes routines).
async function loadComparableHistory(
  ctx: Ctx,
): Promise<z.infer<typeof comparableHistoryEntryResponse>[]> {
  const entries: z.infer<typeof comparableHistoryEntryResponse>[] = [];
  for (const routine of ["push", "pull", "legs"] as const) {
    const recentCompleted = await loadRoutineRecentCompleted(ctx, routine);
    for (const raw of selectComparableHistory(recentCompleted, ROUTINES[routine].map((exercise) => exercise.key))) {
      entries.push({
        routine,
        exercise_key: raw.exerciseKey,
        unit: raw.unit,
        target: raw.target,
        sets: raw.sets.map((set) => ({
          set_number: set.setNumber,
          weight: set.weight,
          reps: set.reps,
          completed: set.completed,
        })),
      });
    }
  }
  return entries;
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({ recent_limit: z.number().int().min(1).max(20).default(8) }),
    response: dashboardResponse,
    async handler(ctx, args): Promise<z.infer<typeof dashboardResponse>> {
      // Read-only: also serves 健康看板's internal sync channel (see
      // isOwnerOrSyncChannel). A present non-owner viewer still gets
      // forbidden with zero data.
      if (!isOwnerOrSyncChannel(ctx)) {
        return { forbidden: true, active_workout: null, recent_workouts: [], week_summaries: [] };
      }
      const db = ctx.db<typeof schema>();
      // W-START-001: initializing workouts are invisible — the active
      // selection only ever returns a ready (initializing = 0) one.
      const activeRows = await db
        .select({ id: schema.workouts.id })
        .from(schema.workouts)
        .where(and(isNull(schema.workouts.completedAt), eq(schema.workouts.initializing, 0)))
        .orderBy(desc(schema.workouts.startedAt))
        .limit(1);
      const activeId = activeRows[0]?.id;
      const activeWorkout = activeId ? await loadWorkout(ctx, activeId) : null;

      const recentRows = await db
        .select({ id: schema.workouts.id })
        .from(schema.workouts)
        .where(isNotNull(schema.workouts.completedAt))
        .orderBy(desc(schema.workouts.completedAt))
        .limit(args.recent_limit);
      const recentWorkouts = [];
      for (const row of recentRows) {
        const loaded = await loadWorkout(ctx, row.id);
        if (loaded) recentWorkouts.push(loaded);
      }

      // Whole-week coverage (H-UNITS-001): read ALL completed workouts from
      // the last 21 days with NO limit truncation — recent_workouts above is
      // capped by recent_limit, which silently dropped older same-week
      // sessions from week-over-week volume. 21 days always covers the
      // current and previous Monday-start weeks.
      const now = new Date();
      const cutoff = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
      const weekWorkoutRows = await db
        .select({
          id: schema.workouts.id,
          completedAt: schema.workouts.completedAt,
          unit: schema.workouts.unit,
        })
        .from(schema.workouts)
        .where(and(isNotNull(schema.workouts.completedAt), gte(schema.workouts.completedAt, cutoff)));
      const weekWorkoutIds = weekWorkoutRows.map((row) => row.id);
      const weekSetRows = weekWorkoutIds.length
        ? await db
            .select({
              workoutId: schema.workoutSets.workoutId,
              weight: schema.workoutSets.weight,
              reps: schema.workoutSets.reps,
              completed: schema.workoutSets.completed,
            })
            .from(schema.workoutSets)
            .where(inArray(schema.workoutSets.workoutId, weekWorkoutIds))
        : [];
      const weekWorkoutInputs: { id: number; completed_at: string; unit: "lb" | "kg" }[] = [];
      for (const row of weekWorkoutRows) {
        if (row.completedAt) {
          weekWorkoutInputs.push({ id: row.id, completed_at: row.completedAt.toISOString(), unit: row.unit });
        }
      }
      const weekSummaries = summarizeWeekSummaries(
        weekWorkoutInputs,
        weekSetRows.map((row) => ({
          workout_id: row.workoutId,
          weight: row.weight,
          reps: row.reps,
          completed: row.completed,
        })),
        now,
      );
      return {
        forbidden: false,
        active_workout: activeWorkout,
        recent_workouts: recentWorkouts,
        week_summaries: weekSummaries,
        comparable_history: await loadComparableHistory(ctx),
      };
    },
  }),

  startWorkout: defineAction({
    request: z.object({ routine: routineSchema, unit: unitSchema }),
    response: startResponse,
    async handler(ctx, args): Promise<z.infer<typeof startResponse>> {
      if (!isOwner(ctx)) {
        return { forbidden: true, workout: null };
      }
      const db = ctx.db<typeof schema>();
      // W-START-001: only a READY active short-circuits a start. An
      // initializing one belongs to a concurrent start still in
      // flight; it is not a usable target, so this start proceeds to
      // insert its own initializing row and the conflict re-check
      // below decides which of the two becomes the single usable
      // active.
      const existing = await db
        .select({ id: schema.workouts.id })
        .from(schema.workouts)
        .where(and(isNull(schema.workouts.completedAt), eq(schema.workouts.initializing, 0)))
        .orderBy(desc(schema.workouts.startedAt))
        .limit(1);
      const existingId = existing[0]?.id;
      if (existingId) {
        const loaded = await loadWorkout(ctx, existingId);
        if (!loaded) throw new Error("未能读取进行中的训练");
        return { forbidden: false, workout: loaded };
      }

      // Invisible initialization: the new workout is inserted with
      // initializing = 1 and stays invisible/unwritable (getDashboard
      // and every mutation exclude initializing rows) until the
      // single conditional UPDATE at the end flips it ready.
      const inserted = await db
        .insert(schema.workouts)
        .values({ routine: args.routine, unit: args.unit, initializing: 1 })
        .returning({ id: schema.workouts.id });
      const workoutId = inserted[0]?.id;
      if (!workoutId) throw new Error("未能开始训练");

      // W-START-001 unified failure cleanup: EVERY step of the
      // initialization below (history read, set insert, conflict
      // re-check, ready flip) runs inside one try; any failure
      // removes this run's own initializing workout and its sets and
      // rethrows, so a retry starts from a clean slate instead of
      // meeting a stuck invisible row that every later start yields
      // to. The workout DELETE is conditioned on initializing = 1
      // AND completed_at IS NULL — if this row somehow already
      // became visible or completed it is NOT removed, and neither
      // are its sets (sets are deleted only when the row delete
      // actually removed the still-initializing row).
      const cleanupOwnInitializing = async () => {
        const removed = await db
          .delete(schema.workouts)
          .where(
            and(
              eq(schema.workouts.id, workoutId),
              eq(schema.workouts.initializing, 1),
              isNull(schema.workouts.completedAt),
            ),
          )
          .returning({ id: schema.workouts.id });
        if (removed.length > 0) {
          await db.delete(schema.workoutSets).where(eq(schema.workoutSets.workoutId, workoutId));
        }
      };

      try {
      const previous = await loadPreviousCompletedSets(ctx, args.routine, args.unit);
      const values = ROUTINES[args.routine].flatMap((exercise) => {
        const history = previous.byExercise[exercise.key] ?? [];
        const { min: targetMin, max: targetMax } = targetRepRange(exercise.target);
        // W1.2: prefill comes from the same progressionDecision the
        // weekly review uses — one rule, one verdict for "next time".
        const decision = progressionDecision({
          // W1-CONSISTENCY-001: planned is the exercise's actual set
          // count in that previous workout (history length — all
          // sets, completed or not), exactly as the weekly review
          // computes it. Only with no history does the template
          // count apply.
          plannedSets: history.length > 0 ? history.length : exercise.sets,
          sets: history,
          targetMin,
          targetMax,
          unit: args.unit,
        });

        return Array.from({ length: exercise.sets }, (_, index) => {
          const prior = history.find((set) => set.setNumber === index + 1) ?? history[index] ?? history[history.length - 1];
          let suggestedWeight: number | null = null;
          let suggestedReps: number | null = null;
          if (decision.action === "increase") {
            suggestedWeight = decision.suggestedWeight;
            suggestedReps = decision.suggestedReps;
          } else if (decision.action === "hold" || decision.action === "reduce") {
            suggestedWeight = decision.suggestedWeight;
            suggestedReps = prior ? prior.reps : null;
          }
          return {
            workoutId,
            exerciseKey: exercise.key,
            exerciseName: exercise.name,
            setNumber: index + 1,
            targetReps: exercise.target,
            weight: suggestedWeight,
            reps: suggestedReps,
          };
        });
      });
      await db.insert(schema.workoutSets).values(values);

      // W-START-001 conflict re-check, run after the prefill sets are
      // in and BEFORE this workout becomes ready: re-read ALL other
      // actives — ready and initializing both count as conflict
      // targets. If an earlier active exists, this insert yields to
      // it — but only once the earlier workout is actually usable.
      // resolveYieldDecision drives a bounded poll over the other
      // row's live state:
      //  - it flips ready → reclaim this initializing row (single
      //    conditional DELETE: still initializing, still active —
      //    the mirror of canReclaimInitializingWorkout; no user
      //    write can have landed on it) and return the earlier
      //    workout. Two concurrent starts therefore return the SAME
      //    usable workout.
      //  - it disappears (its own initialization failed and it
      //    cleaned itself up) → fall through and flip THIS workout
      //    ready instead.
      //  - it is still initializing past the poll budget and its
      //    started_at is ≥30s old → a failed leftover: conditionally
      //    delete it and its sets (same initializing = 1 guard), then
      //    flip this workout ready.
      //  - it is still initializing and fresh → a live initialization
      //    is in flight: throw a retryable error (the catch below
      //    reclaims this run's initializing row first). A start NEVER
      //    returns a workout that is not ready with its sets in.
      const otherActiveRows = await db
        .select({
          id: schema.workouts.id,
          initializing: schema.workouts.initializing,
          startedAt: schema.workouts.startedAt,
        })
        .from(schema.workouts)
        .where(and(isNull(schema.workouts.completedAt), ne(schema.workouts.id, workoutId)))
        .orderBy(asc(schema.workouts.id));
      const earliestOther = otherActiveRows[0] ?? null;
      const earliestOtherActiveId = earliestOther?.id ?? null;
      const conflict = resolveStartConflict(earliestOtherActiveId, workoutId);
      if (conflict.action === "yield") {
        const keepId = conflict.keepId;
        let other: { initializing: number; startedAt: Date } | null = earliestOther
          ? { initializing: earliestOther.initializing, startedAt: earliestOther.startedAt }
          : null;
        let attemptsLeft = YIELD_WAIT_ATTEMPTS;
        for (;;) {
          const decision = resolveYieldDecision(
            {
              present: other != null,
              initializing: other != null && other.initializing === 1,
              startedAtMs: other ? other.startedAt.getTime() : null,
            },
            attemptsLeft,
            Date.now(),
          );
          if (decision === "wait") {
            attemptsLeft -= 1;
            await waitMs(YIELD_WAIT_INTERVAL_MS);
            const reread = await db
              .select({ initializing: schema.workouts.initializing, startedAt: schema.workouts.startedAt })
              .from(schema.workouts)
              .where(eq(schema.workouts.id, keepId))
              .limit(1);
            other = reread[0] ?? null;
            continue;
          }
          if (decision === "yield-ready") {
            const reclaimed = await db
              .delete(schema.workouts)
              .where(
                and(
                  eq(schema.workouts.id, workoutId),
                  eq(schema.workouts.initializing, 1),
                  isNull(schema.workouts.completedAt),
                ),
              )
              .returning({ id: schema.workouts.id });
            if (reclaimed.length > 0) {
              await db.delete(schema.workoutSets).where(eq(schema.workoutSets.workoutId, workoutId));
              const kept = await loadWorkout(ctx, keepId);
              if (!kept) throw new Error("未能读取进行中的训练");
              ctx.invalidateQueries();
              return { forbidden: false, workout: kept };
            }
            // The conditional DELETE matched nothing: this row is no
            // longer in its initializing state (defensive — under the
            // contract no other action can flip or complete an
            // initializing row). Delete nothing further and return this
            // workout itself, so a visible or completed record is never
            // lost to the single-active yield.
            const own = await loadWorkout(ctx, workoutId);
            if (!own) throw new Error("未能读取进行中的训练");
            ctx.invalidateQueries();
            return { forbidden: false, workout: own };
          }
          if (decision === "takeover") {
            const removedStale = await db
              .delete(schema.workouts)
              .where(
                and(
                  eq(schema.workouts.id, keepId),
                  eq(schema.workouts.initializing, 1),
                  isNull(schema.workouts.completedAt),
                ),
              )
              .returning({ id: schema.workouts.id });
            if (removedStale.length > 0) {
              await db.delete(schema.workoutSets).where(eq(schema.workoutSets.workoutId, keepId));
            }
            break;
          }
          if (decision === "retry") {
            throw new Error("另一场训练正在初始化，请稍后重试");
          }
          break; // "proceed-self": the other row vanished mid-wait
        }
      }

      // This insert is the earliest surviving active: flip it ready
      // with a single conditional UPDATE — only a row still
      // initializing becomes visible, atomically.
      await db
        .update(schema.workouts)
        .set({ initializing: 0 })
        .where(and(eq(schema.workouts.id, workoutId), eq(schema.workouts.initializing, 1)));

      const workout = await loadWorkout(ctx, workoutId);
      if (!workout) throw new Error("未能读取新训练");
      ctx.invalidateQueries();
      return {
        forbidden: false,
        workout: previous.converted ? { ...workout, prefill_unit_converted: true } : workout,
      };
      } catch (error) {
        // Unified initialization failure cleanup (see
        // cleanupOwnInitializing): best-effort — a cleanup failure
        // never masks the original error, which is rethrown as-is so
        // the caller can retry from a clean slate.
        try {
          await cleanupOwnInitializing();
        } catch {
          // The original error below is the one that matters.
        }
        throw error;
      }
    },
  }),

  updateSet: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      weight: z.number().min(0).max(5000).nullable(),
      reps: z.number().int().min(0).max(1000).nullable(),
      completed: z.boolean(),
    }),
    response: doneResponse,
    async handler(ctx, args): Promise<z.infer<typeof doneResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true };
      }
      const db = ctx.db<typeof schema>();
      // W-ACTIVE-001: the active guard lives INSIDE this single UPDATE
      // — the write lands only when the set's owning workout is still
      // active (completed_at IS NULL) at write time, so a
      // completeWorkout that lands between any earlier read and this
      // statement can no longer be overwritten. W-START-001: the
      // guard also requires initializing = 0 — an initializing
      // workout is not a writable target. RETURNING is the verdict:
      // zero rows means the set is missing or its workout is already
      // history (or still initializing), and nothing was written.
      const updatedRows = await db.all(sql`
        UPDATE workout_sets
        SET weight = ${args.weight}, reps = ${args.reps}, completed = ${args.completed ? 1 : 0}, updated_at = ${Date.now()}
        WHERE id = ${args.id}
          AND EXISTS (
            SELECT 1 FROM workouts
            WHERE workouts.id = workout_sets.workout_id AND workouts.completed_at IS NULL AND workouts.initializing = 0
          )
        RETURNING id
      `);
      if (updatedRows.length === 0) return { ok: false, forbidden: false };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  addSet: defineAction({
    request: z.object({ workout_id: z.number().int().positive(), exercise_key: z.string().min(1) }),
    response: addSetResponse,
    async handler(ctx, args): Promise<z.infer<typeof addSetResponse>> {
      if (!isOwner(ctx)) {
        return { forbidden: true, set: null };
      }
      const db = ctx.db<typeof schema>();
      // Reading the exercise's previous set (set_number / name /
      // target / carried weight) may happen before the write, but the
      // insert itself carries the active guard (W-ACTIVE-001).
      const rows = await db
        .select()
        .from(schema.workoutSets)
        .where(and(eq(schema.workoutSets.workoutId, args.workout_id), eq(schema.workoutSets.exerciseKey, args.exercise_key)))
        .orderBy(desc(schema.workoutSets.setNumber));
      const previous = rows[0];
      if (!previous) throw new Error("没有找到这个动作");
      const nowMs = Date.now();
      // INSERT … SELECT: the row is created only when the target
      // workout exists and is still active at insert time, so a
      // completeWorkout that landed after the read above gains no new
      // sets. W-START-001: initializing = 0 is required too — an
      // initializing workout gains no sets. RETURNING is the verdict:
      // zero rows, zero inserted.
      const insertedRows = await db.all(sql`
        INSERT INTO workout_sets (workout_id, exercise_key, exercise_name, set_number, target_reps, weight, reps, completed, created_at, updated_at)
        SELECT id, ${previous.exerciseKey}, ${previous.exerciseName}, ${previous.setNumber + 1}, ${previous.targetReps}, ${previous.weight}, NULL, 0, ${nowMs}, ${nowMs}
        FROM workouts
        WHERE id = ${args.workout_id} AND completed_at IS NULL AND initializing = 0
        RETURNING id, workout_id, exercise_key, exercise_name, set_number, target_reps, weight, reps, completed
      `);
      const row = insertedRows[0] as
        | {
            id: number;
            workout_id: number;
            exercise_key: string;
            exercise_name: string;
            set_number: number;
            target_reps: string;
            weight: number | null;
            reps: number | null;
            completed: number;
          }
        | undefined;
      if (!row) return { forbidden: false, set: null };
      ctx.invalidateQueries();
      return {
        forbidden: false,
        set: {
          id: row.id,
          workout_id: row.workout_id,
          exercise_key: row.exercise_key,
          exercise_name: row.exercise_name,
          set_number: row.set_number,
          target_reps: row.target_reps,
          weight: row.weight,
          reps: row.reps,
          completed: row.completed === 1,
        },
      };
    },
  }),

  completeWorkout: defineAction({
    request: z.object({ workout_id: z.number().int().positive() }),
    response: doneResponse,
    async handler(ctx, args): Promise<z.infer<typeof doneResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true };
      }
      const db = ctx.db<typeof schema>();
      // W0.3: complete only a workout that exists and is still active;
      // the affected-row count is the verdict, so an already-completed
      // or missing workout reports ok: false instead of success.
      // W-START-001: an initializing workout cannot be completed.
      const updated = await db
        .update(schema.workouts)
        .set({ completedAt: new Date() })
        .where(
          and(
            eq(schema.workouts.id, args.workout_id),
            isNull(schema.workouts.completedAt),
            eq(schema.workouts.initializing, 0),
          ),
        )
        .returning({ id: schema.workouts.id });
      if (updated.length === 0) return { ok: false, forbidden: false };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  discardWorkout: defineAction({
    request: z.object({ workout_id: z.number().int().positive() }),
    response: doneResponse,
    async handler(ctx, args): Promise<z.infer<typeof doneResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true };
      }
      const db = ctx.db<typeof schema>();
      // W-ACTIVE-001: delete the workout row FIRST, with the active
      // guard inside the single DELETE — RETURNING is the verdict.
      // Only a workout still active at delete time is removed, and
      // only then are its sets deleted. A completed workout (history)
      // or a missing id matches zero rows: ok: false, and no set is
      // ever touched. W-START-001: an initializing workout cannot be
      // discarded either (initializing = 0 required).
      const deletedRows = await db.all(sql`
        DELETE FROM workouts
        WHERE id = ${args.workout_id} AND completed_at IS NULL AND initializing = 0
        RETURNING id
      `);
      if (deletedRows.length === 0) return { ok: false, forbidden: false };
      await db.delete(schema.workoutSets).where(eq(schema.workoutSets.workoutId, args.workout_id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),
} satisfies ActionsModule;
