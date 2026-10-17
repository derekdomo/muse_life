import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
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

const dashboardResponse = z.object({
  forbidden: z.boolean(),
  active_workout: workoutResponse.nullable(),
  recent_workouts: z.array(workoutResponse),
  week_summaries: z.array(weekSummaryResponse),
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
export function mutationTargetDecision(
  workout: { completed_at: string | null } | null,
): "ok" | "not-found" | "not-active" {
  if (!workout) return "not-found";
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

type PreviousComparable = {
  sets: { exerciseKey: string; setNumber: number; weight: number | null; reps: number | null; completed: boolean }[];
  converted: boolean;
};

// W1.3: the previous comparable workout is the routine's most recent
// completed workout in ANY unit; when its unit differs from the new
// workout's, every weight is converted into the new unit.
async function loadPreviousCompletedSets(
  ctx: Ctx,
  routine: z.infer<typeof routineSchema>,
  unit: z.infer<typeof unitSchema>,
): Promise<PreviousComparable> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ id: schema.workouts.id, unit: schema.workouts.unit })
    .from(schema.workouts)
    .where(and(eq(schema.workouts.routine, routine), isNotNull(schema.workouts.completedAt)))
    .orderBy(desc(schema.workouts.completedAt))
    .limit(1);
  const previous = rows[0];
  if (!previous) return { sets: [], converted: false };
  const setRows = await db
    .select()
    .from(schema.workoutSets)
    .where(and(eq(schema.workoutSets.workoutId, previous.id), eq(schema.workoutSets.completed, true)))
    .orderBy(asc(schema.workoutSets.id));
  const converted = previous.unit !== unit;
  return {
    converted,
    sets: setRows.map((row) => ({
      exerciseKey: row.exerciseKey,
      setNumber: row.setNumber,
      weight: converted ? convertWeight(row.weight, previous.unit, unit) : row.weight,
      reps: row.reps,
      completed: row.completed,
    })),
  };
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
      const activeRows = await db
        .select({ id: schema.workouts.id })
        .from(schema.workouts)
        .where(isNull(schema.workouts.completedAt))
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
      const existing = await db
        .select({ id: schema.workouts.id })
        .from(schema.workouts)
        .where(isNull(schema.workouts.completedAt))
        .orderBy(desc(schema.workouts.startedAt))
        .limit(1);
      const existingId = existing[0]?.id;
      if (existingId) {
        const loaded = await loadWorkout(ctx, existingId);
        if (!loaded) throw new Error("未能读取进行中的训练");
        return { forbidden: false, workout: loaded };
      }

      const inserted = await db
        .insert(schema.workouts)
        .values({ routine: args.routine, unit: args.unit })
        .returning({ id: schema.workouts.id });
      const workoutId = inserted[0]?.id;
      if (!workoutId) throw new Error("未能开始训练");

      const previous = await loadPreviousCompletedSets(ctx, args.routine, args.unit);
      const values = ROUTINES[args.routine].flatMap((exercise) => {
        const history = previous.sets.filter((set) => set.exerciseKey === exercise.key);
        const { min: targetMin, max: targetMax } = targetRepRange(exercise.target);
        // W1.2: prefill comes from the same progressionDecision the
        // weekly review uses — one rule, one verdict for "next time".
        const decision = progressionDecision({
          plannedSets: exercise.sets,
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

      // W0.4: re-check for a single active workout. A concurrent start
      // may have inserted its own workout after the pre-check above;
      // if an earlier active workout (smaller id) now exists, this
      // insert yields: delete the just-inserted workout and its sets
      // and return the earlier active one instead.
      const activeRows = await db
        .select({ id: schema.workouts.id })
        .from(schema.workouts)
        .where(isNull(schema.workouts.completedAt))
        .orderBy(asc(schema.workouts.id));
      const earliestOtherActiveId = activeRows.map((row) => row.id).find((id) => id !== workoutId) ?? null;
      const conflict = resolveStartConflict(earliestOtherActiveId, workoutId);
      if (conflict.action === "yield") {
        await db.delete(schema.workoutSets).where(eq(schema.workoutSets.workoutId, workoutId));
        await db.delete(schema.workouts).where(eq(schema.workouts.id, workoutId));
        const kept = await loadWorkout(ctx, conflict.keepId);
        if (!kept) throw new Error("未能读取进行中的训练");
        ctx.invalidateQueries();
        return { forbidden: false, workout: kept };
      }

      const workout = await loadWorkout(ctx, workoutId);
      if (!workout) throw new Error("未能读取新训练");
      ctx.invalidateQueries();
      return {
        forbidden: false,
        workout: previous.converted ? { ...workout, prefill_unit_converted: true } : workout,
      };
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
      // W0.3: resolve the set's owning workout first and only write
      // when that workout exists and is still active. A stale write
      // aimed at a completed (or deleted) workout is refused without
      // touching the database.
      const setRows = await db
        .select({ workoutId: schema.workoutSets.workoutId })
        .from(schema.workoutSets)
        .where(eq(schema.workoutSets.id, args.id))
        .limit(1);
      const owner = setRows[0];
      if (!owner) return { ok: false, forbidden: false };
      const workoutRows = await db
        .select({ completedAt: schema.workouts.completedAt })
        .from(schema.workouts)
        .where(eq(schema.workouts.id, owner.workoutId))
        .limit(1);
      const target = workoutRows[0];
      const decision = mutationTargetDecision(
        target ? { completed_at: target.completedAt?.toISOString() ?? null } : null,
      );
      if (decision !== "ok") return { ok: false, forbidden: false };
      const updated = await db
        .update(schema.workoutSets)
        .set({ weight: args.weight, reps: args.reps, completed: args.completed, updatedAt: new Date() })
        .where(eq(schema.workoutSets.id, args.id))
        .returning({ id: schema.workoutSets.id });
      if (updated.length === 0) return { ok: false, forbidden: false };
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
      // W0.3: only an existing, still-active workout may gain sets.
      const workoutRows = await db
        .select({ completedAt: schema.workouts.completedAt })
        .from(schema.workouts)
        .where(eq(schema.workouts.id, args.workout_id))
        .limit(1);
      const target = workoutRows[0];
      const decision = mutationTargetDecision(
        target ? { completed_at: target.completedAt?.toISOString() ?? null } : null,
      );
      if (decision !== "ok") return { forbidden: false, set: null };
      const rows = await db
        .select()
        .from(schema.workoutSets)
        .where(and(eq(schema.workoutSets.workoutId, args.workout_id), eq(schema.workoutSets.exerciseKey, args.exercise_key)))
        .orderBy(desc(schema.workoutSets.setNumber));
      const previous = rows[0];
      if (!previous) throw new Error("没有找到这个动作");
      const inserted = await db
        .insert(schema.workoutSets)
        .values({
          workoutId: args.workout_id,
          exerciseKey: previous.exerciseKey,
          exerciseName: previous.exerciseName,
          setNumber: previous.setNumber + 1,
          targetReps: previous.targetReps,
          weight: previous.weight,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("未能添加一组");
      ctx.invalidateQueries();
      return {
        forbidden: false,
        set: {
          id: row.id,
          workout_id: row.workoutId,
          exercise_key: row.exerciseKey,
          exercise_name: row.exerciseName,
          set_number: row.setNumber,
          target_reps: row.targetReps,
          weight: row.weight,
          reps: row.reps,
          completed: row.completed,
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
      const updated = await db
        .update(schema.workouts)
        .set({ completedAt: new Date() })
        .where(and(eq(schema.workouts.id, args.workout_id), isNull(schema.workouts.completedAt)))
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
      // W0.3: discard only ever deletes an active workout. A completed
      // workout is history and must survive a discard aimed at its id;
      // a missing one has nothing to delete. Both report ok: false.
      const workoutRows = await db
        .select({ completedAt: schema.workouts.completedAt })
        .from(schema.workouts)
        .where(eq(schema.workouts.id, args.workout_id))
        .limit(1);
      const target = workoutRows[0];
      const decision = mutationTargetDecision(
        target ? { completed_at: target.completedAt?.toISOString() ?? null } : null,
      );
      if (decision !== "ok") return { ok: false, forbidden: false };
      await db.delete(schema.workoutSets).where(eq(schema.workoutSets.workoutId, args.workout_id));
      await db.delete(schema.workouts).where(eq(schema.workouts.id, args.workout_id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),
} satisfies ActionsModule;
