import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";

const routineSchema = z.enum(["push", "pull", "legs", "home_posture", "home_snowboard"]);
const unitSchema = z.enum(["lb", "kg"]);

export const ROUTINE_KEYS = ["push", "pull", "legs", "home_posture", "home_snowboard"] as const;
export type RoutineKey = (typeof ROUTINE_KEYS)[number];
export const SCHEDULE_CODES = [...ROUTINE_KEYS, "swim", "rest"] as const;

export type PlanExercise = { key: string; name: string; sets: number; target: string };
export type PlanTemplateMap = Record<RoutineKey, PlanExercise[]>;

// Default plan (2026-10-18 frequency sync, approved by the user):
// gym Push/Pull/Legs stay the 3 heavy sessions with the posture and
// snowboard upgrades applied; Home A posture runs 2x/week, Home B
// snowboard 1x/week. These constants are ONLY the idempotent seed and
// the fallback when the plan tables are unreadable — the live plan is
// the persisted rows, editable through updatePlan.
export const DEFAULT_PLAN_TEMPLATES: PlanTemplateMap = {
  push: [
    { key: "barbell-bench", name: "杠铃卧推", sets: 4, target: "6–8" },
    { key: "overhead-press", name: "站姿推举", sets: 3, target: "8–10" },
    { key: "incline-dumbbell-press", name: "上斜哑铃卧推", sets: 3, target: "8–12" },
    { key: "dips", name: "双杠臂屈伸", sets: 3, target: "10–12" },
    { key: "lateral-raise", name: "哑铃侧平举", sets: 3, target: "12–15" },
    { key: "push-up-plus", name: "前锯肌 Push-up Plus", sets: 2, target: "12" },
  ],
  pull: [
    { key: "wide-lat-pulldown", name: "高位下拉 · 宽握", sets: 4, target: "8–12" },
    { key: "close-lat-pulldown", name: "高位下拉 · 窄握/反握", sets: 3, target: "10–12" },
    { key: "close-seated-row", name: "坐姿划船 · 窄距", sets: 4, target: "10–12" },
    { key: "wide-seated-row", name: "坐姿划船 · 宽距", sets: 3, target: "10–12" },
    { key: "face-pull", name: "面拉", sets: 3, target: "15–20" },
    { key: "reverse-pec-deck", name: "反向蝴蝶机 · 后三角", sets: 3, target: "12–15" },
    { key: "rope-curl", name: "绳索弯举", sets: 3, target: "10–12" },
  ],
  legs: [
    { key: "back-squat", name: "深蹲", sets: 4, target: "6–8" },
    { key: "romanian-deadlift", name: "罗马尼亚硬拉", sets: 3, target: "8–10" },
    { key: "bulgarian-split-squat", name: "保加利亚分腿蹲 · 负重", sets: 3, target: "10" },
    { key: "lying-leg-curl", name: "俯卧腿弯举", sets: 3, target: "10–12" },
    { key: "calf-raise", name: "提踵", sets: 3, target: "15–20" },
    { key: "tibialis-raise", name: "靠墙胫骨前肌抬脚尖", sets: 2, target: "20" },
  ],
  home_posture: [
    { key: "supine-chin-tuck", name: "仰卧收下巴", sets: 3, target: "10" },
    { key: "prone-ytw", name: "俯趴 Bench Y-T-W", sets: 2, target: "8" },
    { key: "side-external-rotation", name: "侧卧外旋 · 小片", sets: 2, target: "12" },
    { key: "thoracic-extension", name: "胸椎伸展 · Bench 边缘", sets: 2, target: "60秒" },
  ],
  home_snowboard: [
    { key: "single-leg-balance", name: "单腿平衡触点", sets: 2, target: "60秒" },
    { key: "home-bulgarian-split-squat", name: "保加利亚分腿蹲 · Bench 抱片", sets: 3, target: "12" },
    { key: "bench-step-up", name: "Bench 登阶", sets: 2, target: "10" },
    { key: "home-calf-raise", name: "提踵 · 抱片", sets: 3, target: "20" },
    { key: "tibialis-raise", name: "靠墙胫骨前肌抬脚尖", sets: 2, target: "20" },
    { key: "wall-sit", name: "靠墙静蹲", sets: 3, target: "45秒" },
    { key: "dead-bug", name: "死虫", sets: 3, target: "10" },
    { key: "side-plank", name: "侧平板", sets: 2, target: "40秒" },
  ],
};

export const DEFAULT_PLAN_SCHEDULE: { day_index: number; routine_code: string; note: string }[] = [
  { day_index: 0, routine_code: "home_posture", note: "在家 A · 体态 20 分钟" },
  { day_index: 1, routine_code: "push", note: "健身房重练" },
  { day_index: 2, routine_code: "home_snowboard", note: "在家 B · 单板 25 分钟，与腿日隔 48 小时以上" },
  { day_index: 3, routine_code: "pull", note: "健身房重练" },
  { day_index: 4, routine_code: "home_posture", note: "在家 A · 体态 20 分钟" },
  { day_index: 5, routine_code: "swim", note: "游泳 1–2 次安排在本日或休息日" },
  { day_index: 6, routine_code: "legs", note: "健身房重练" },
];

export const DEFAULT_DAILY_ITEMS: { key: string; title: string; detail: string }[] = [
  { key: "daily-chin-tuck", title: "收下巴 Chin Tuck", detail: "10 次 · 每次停 5 秒" },
  { key: "daily-wall-angels", title: "靠墙天使", detail: "10 次 · 后背贴墙慢速滑动" },
  { key: "daily-doorway-stretch", title: "门框胸肌拉伸", detail: "30 秒 · 两侧都要" },
  { key: "daily-monitor-height", title: "确认显示器高度", detail: "屏幕上沿与视线齐平 · 升降桌站姿检查" },
];

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
// W2.3 (additive): source_completed_at is the source workout's own
// completion time (ISO string, nullable), passed through untouched
// from that workout's completedAt so the weekly review can cite the
// exact record each suggestion derives from. Older consumers ignore
// it; the selection itself is unchanged.
const comparableHistoryEntryResponse = z.object({
  routine: routineSchema,
  exercise_key: z.string(),
  unit: unitSchema,
  target: z.string(),
  source_completed_at: z.string().nullable(),
  sets: z.array(comparableHistorySetResponse),
});

// W4.3-D1 (additive): one exercise's previous-comparable entry for the
// completion receipt — the most recent EARLIER completed workout of
// the same routine that contains the same exercise key, with that
// exercise's completed/total set counts there and the source
// workout's completion time (its 来源日期）. Counts are the source
// record's own: uncompleted sets stay uncompleted (never zero-filled)
// and a real 0 completed count is reported as 0.
const receiptPreviousEntryResponse = z.object({
  exercise_key: z.string(),
  source_completed_at: z.string(),
  completed_sets: z.number(),
  total_sets: z.number(),
});

const dashboardResponse = z.object({
  forbidden: z.boolean(),
  active_workout: workoutResponse.nullable(),
  recent_workouts: z.array(workoutResponse),
  week_summaries: z.array(weekSummaryResponse),
  comparable_history: z.array(comparableHistoryEntryResponse).optional(),
  // W4.3-D1 (additive, optional): present ONLY when the caller passed
  // receipt_workout_id — the completed workout read back by that exact
  // id for the completion receipt. Null when the id is unknown or the
  // workout is not completed; the client then shows its retryable
  // not-read state and never substitutes a recent record. Callers that
  // pass no id （健康看板 sync) receive neither field, exactly as
  // before, and may ignore both.
  receipt: workoutResponse.nullable().optional(),
  receipt_previous: z.array(receiptPreviousEntryResponse).optional(),
});

const planExerciseResponse = z.object({
  key: z.string(),
  name: z.string(),
  sets: z.number(),
  target: z.string(),
});
const planRoutineResponse = z.object({
  routine: routineSchema,
  exercises: z.array(planExerciseResponse),
});
const planScheduleEntryResponse = z.object({
  day_index: z.number(),
  routine_code: z.string(),
  note: z.string(),
});
const planDailyItemResponse = z.object({
  key: z.string(),
  title: z.string(),
  detail: z.string(),
});
// W-PLAN-SAFE-001 follow-up: one candidate copy of a conflicted
// plan exercise. source "live" is the copy currently in
// plan_exercises (displayed, but NOT confirmed while the conflict is
// open); source "archived" is a preserved copy in
// plan_exercise_conflicts, identified by archive_id for the owner's
// selection. Only plan fields are exposed — nothing beyond the
// training-plan content itself.
const planConflictCandidateResponse = z.object({
  source: z.enum(["live", "archived"]),
  archive_id: z.number().nullable(),
  // W-PLAN-SAFE-001 P0 tail (additive): the candidate's own row id —
  // the plan_exercises id for the live copy, the archive row id for
  // an archived copy (same value as archive_id there). The client
  // echoes the full candidate id set back as expected_candidate_ids
  // when confirming, so a confirmation is bound to exactly the
  // candidates that were displayed.
  id: z.number(),
  name: z.string(),
  sets: z.number(),
  target: z.string(),
  sort_order: z.number(),
});
const planConflictResponse = z.object({
  routine: z.string(),
  exercise_key: z.string(),
  exercise_name: z.string(),
  candidate_count: z.number(),
  archived_at: z.string().nullable(),
  candidates: z.array(planConflictCandidateResponse),
  // W-PLAN-SAFE-001 P0 tail (additive): the plan version token as
  // read inside the same version bracket as the candidates above.
  // The client echoes it as expected_plan_version when confirming;
  // unlike the bare token rule for the plan body (never exposed on a
  // conflict-free response), it appears ONLY inside a conflict entry
  // the owner is being asked to decide on, because binding the
  // decision to the displayed version is the point of the field.
  plan_version: z.string().nullable(),
});
const resolvePlanConflictResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  error: z.string().nullable(),
  // W-PLAN-SAFE-001 P0 tail (additive, optional): the typed outcome
  // of a confirmation. "resolved" — this call closed the conflict;
  // "already_resolved" — an earlier identical decision already
  // closed it (idempotent receipt, ok:true); "stale" — the plan or
  // the candidate set changed after the candidates were displayed,
  // nothing was written, refresh and re-decide (ok:false). Omitted
  // on responses that predate the field and on plain validation /
  // batch failures (retryable, error carries the message).
  outcome: z.enum(["resolved", "already_resolved", "stale"]).optional(),
});

const planResponse = z.object({
  forbidden: z.boolean(),
  routines: z.array(planRoutineResponse),
  schedule: z.array(planScheduleEntryResponse),
  daily_items: z.array(planDailyItemResponse),
  daily_date: z.string(),
  daily_done: z.array(z.string()),
  // W-PLAN-SAFE-001 follow-up (additive, optional): present ONLY
  // while plan_exercise_conflicts holds unconfirmed archive rows
  // (migration 0005 archived duplicate (routine, exercise_key) rows
  // and kept the smallest id live). A database with no unconfirmed
  // conflict receives neither field, exactly as before — the plan is
  // never silently presented as confirmed while a conflict is open:
  // each entry names the routine/key, how many candidate copies
  // exist in total, when the copies were archived, and every
  // candidate's plan fields so the owner can pick one via
  // resolvePlanConflict.
  conflicts: z.array(planConflictResponse).optional(),
  conflict_count: z.number().optional(),
  // W-PLAN-SAFE-001 P0 tail (additive, optional): present ONLY when
  // the version-bracketed read exhausted its bounded retries because
  // saves kept landing mid-read. The response then carries NO plan
  // body at all (empty arrays) plus this retryable error — a caller
  // must keep whatever plan it already has and offer a retry, never
  // present the empty body as the plan. A successful read omits the
  // field entirely, exactly as before.
  read_error: z.string().optional(),
});
const updatePlanResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  error: z.string().nullable(),
});

// W-PLAN-SAFE-001: the plan_meta marker is the only "seeded" signal.
// A saved plan whose tables were later emptied still carries the
// marker, so it is never re-seeded over; getPlan / startWorkout never
// infer initialization from a plan table being empty.
const PLAN_META_SEEDED_KEY = "seeded";

// W-PLAN-SAFE-001 (version token): plan_meta also carries an internal
// integer version under this key. It starts at '0' when the seed lands
// and is incremented by exactly 1 inside every successful updatePlan
// batch, so the three plan tables plus this token always change as
// one atomic unit. getPlan brackets its cross-table read with two
// reads of the token and only trusts the read when both agree — a
// save landing mid-read is detected and the whole read retried, so a
// response can never mix one save's exercises with another's
// schedule. The token is internal bookkeeping: it is never exposed in
// any response. daily_completions is NOT part of the plan version —
// it is keyed by date and item key, written by toggleDailyItem, and
// read separately as before.
const PLAN_META_VERSION_KEY = "version";

// W-PLAN-SAFE-001 P0 tail: getPlan's version-bracketed read retries
// at most this many times before returning its explicit retryable
// read_error. Finite on purpose (see the getPlan handler).
export const PLAN_READ_MAX_ATTEMPTS = 5;

// One-statement version increment for updatePlan's atomic batch:
// inserts '1' when the token row does not exist yet (a save that is
// the first plan write a database ever sees), otherwise adds 1 to the
// stored integer in place.
function planVersionIncrement(db: ReturnType<Ctx["db"]>) {
  return db
    .insert(schema.planMeta)
    .values({ key: PLAN_META_VERSION_KEY, value: "1" })
    .onConflictDoUpdate({
      target: schema.planMeta.key,
      set: { value: sql`CAST(CAST(${schema.planMeta.value} AS INTEGER) + 1 AS TEXT)` },
    });
}

// The current plan version token ('0' before any save), or null when
// the token row is absent (a database seeded before the token
// existed, or one whose seed has not landed yet).
async function readPlanVersion(ctx: Ctx): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ value: schema.planMeta.value })
    .from(schema.planMeta)
    .where(eq(schema.planMeta.key, PLAN_META_VERSION_KEY))
    .limit(1);
  return rows[0]?.value ?? null;
}

// W-PLAN-SAFE-001 P0 tail (decision binding): a canonical stamp of
// one conflict group's full decision state — the plan version token,
// the group's archive rows (id + every plan field + archived_at) and
// the live row (id + every plan field, or its absence). Two reads of
// the group produce the same stamp iff the owner would be shown
// exactly the same candidates for the same plan version, so
// resolvePlanConflict can bind a confirmation to what was displayed:
// the client echoes the stamp it saw, and the handler compares it
// against a fresh stamp inside the claim (see there). Pure and
// self-contained so validation scripts can exercise it directly.
export function conflictVersionStamp(input: {
  planVersion: string | null;
  live: { id: number; sortOrder: number; exerciseName: string; sets: number; targetReps: string } | null;
  archived: {
    id: number;
    sortOrder: number;
    exerciseName: string;
    sets: number;
    targetReps: string;
    archivedAtMs: number | null;
  }[];
}): string {
  const livePart = input.live
    ? [
        input.live.id,
        input.live.sortOrder,
        input.live.exerciseName,
        input.live.sets,
        input.live.targetReps,
      ].join("\u001F")
    : "none";
  const archivedPart = [...input.archived]
    .sort((a, b) => a.id - b.id)
    .map((row) =>
      [row.id, row.sortOrder, row.exerciseName, row.sets, row.targetReps, row.archivedAtMs ?? "null"].join("\u001F"),
    )
    .join("\u001E");
  return `v${input.planVersion ?? "null"}|live:${livePart}|arch:${archivedPart}`;
}

// Atomic, idempotent plan seed. The marker decides: when it exists
// this is a no-op. Otherwise the default rows for all three plan
// tables, the version token AND the marker land in ONE db.batch —
// the platform db handle exposes no transaction method (see
// @hatch/space-sdk's SpaceDb type), and batch is its atomic
// multi-statement write: every statement commits or none does, so a
// failed or interrupted seed leaves no partial plan and no marker,
// and the next open simply retries.
//
// W-PLAN-SAFE-001 (execution-time seed guard): the marker pre-check
// above is only a fast path — it cannot close the race where a legal
// first save lands AFTER this seed's pre-check but BEFORE its batch
// executes (the pre-check would have said "not seeded", yet seeding
// now would resurrect default rows the user just deleted). So every
// default-row insert is an INSERT … SELECT … WHERE NOT EXISTS
// (SELECT 1 FROM plan_meta WHERE key = 'seeded'): the guard is
// evaluated when the statement executes, inside the batch, so if a
// save (or a winning concurrent seed) has already landed the marker,
// each guarded insert writes ZERO rows. The marker insert stays LAST
// in the batch (onConflictDoNothing): a batch that fails anywhere
// still leaves zero rows and no marker, and two concurrent first
// opens still converge to exactly one copy of the template — the
// first batch's rows land, the second batch's guarded inserts all
// see the marker and write nothing. (Claiming the marker in a
// separate earlier step is deliberately NOT done: it would open a
// window where the marker exists but the template does not.)
async function ensurePlanSeeded(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const marker = await db
    .select({ key: schema.planMeta.key })
    .from(schema.planMeta)
    .where(eq(schema.planMeta.key, PLAN_META_SEEDED_KEY))
    .limit(1);
  if (marker.length > 0) return;
  const seedGuard = sql`NOT EXISTS (SELECT 1 FROM plan_meta WHERE key = ${PLAN_META_SEEDED_KEY})`;
  const exerciseSelects = ROUTINE_KEYS.flatMap((routine) =>
    DEFAULT_PLAN_TEMPLATES[routine].map((exercise, index) =>
      sql`SELECT ${routine}, ${index}, ${exercise.key}, ${exercise.name}, ${exercise.sets}, ${exercise.target}`,
    ),
  );
  const scheduleSelects = DEFAULT_PLAN_SCHEDULE.map(
    (entry) => sql`SELECT ${entry.day_index}, ${entry.routine_code}, ${entry.note}`,
  );
  const dailySelects = DEFAULT_DAILY_ITEMS.map(
    (item, index) => sql`SELECT ${item.key}, ${item.title}, ${item.detail}, ${index}`,
  );
  await db.batch([
    db.run(sql`
      INSERT INTO plan_exercises (routine, sort_order, exercise_key, exercise_name, sets, target_reps)
      SELECT * FROM (${sql.join(exerciseSelects, sql` UNION ALL `)})
      WHERE ${seedGuard}
    `),
    db.run(sql`
      INSERT INTO plan_schedule (day_index, routine_code, note)
      SELECT * FROM (${sql.join(scheduleSelects, sql` UNION ALL `)})
      WHERE ${seedGuard}
    `),
    db.run(sql`
      INSERT INTO plan_daily_items (item_key, title, detail, sort_order)
      SELECT * FROM (${sql.join(dailySelects, sql` UNION ALL `)})
      WHERE ${seedGuard}
    `),
    db.insert(schema.planMeta).values({ key: PLAN_META_VERSION_KEY, value: "0" }).onConflictDoNothing(),
    db.insert(schema.planMeta).values({ key: PLAN_META_SEEDED_KEY, value: "1" }).onConflictDoNothing(),
  ]);
}

// The live templates: persisted rows in sort order, per routine. A
// routine with no rows (should not happen after ensurePlanSeeded)
// falls back to the default template for that routine.
async function loadPlanTemplates(ctx: Ctx): Promise<PlanTemplateMap> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.planExercises)
    .orderBy(asc(schema.planExercises.sortOrder), asc(schema.planExercises.id));
  const templates = {} as PlanTemplateMap;
  for (const routine of ROUTINE_KEYS) templates[routine] = [];
  for (const row of rows) {
    if ((ROUTINE_KEYS as readonly string[]).includes(row.routine)) {
      templates[row.routine as RoutineKey].push({
        key: row.exerciseKey,
        name: row.exerciseName,
        sets: row.sets,
        target: row.targetReps,
      });
    }
  }
  for (const routine of ROUTINE_KEYS) {
    if (templates[routine].length === 0) templates[routine] = [...DEFAULT_PLAN_TEMPLATES[routine]];
  }
  return templates;
}

// W-PLAN-SAFE-001 follow-up (conflict visibility): every
// plan_exercise_conflicts group that still has an unconfirmed row
// (resolved_at IS NULL) becomes one conflict entry. Candidates are
// the live plan_exercises row for the key (if it still exists — the
// editor may legitimately have deleted it) followed by the archived
// copies in id order, each with its full plan fields so the owner
// can compare versions before choosing. archived_at is the earliest
// archival stamp in the group (for rows archived by migration 0005
// that is the 0006 tracking stamp — see that migration's header).
// Groups whose rows are all resolved never appear here. planVersion
// is the version token of the bracket this read belongs to (see
// getPlan); it is stamped onto every entry so the client can bind a
// later confirmation to the exact version it was shown.
async function loadPlanConflicts(
  ctx: Ctx,
  planVersion: string | null,
): Promise<z.infer<typeof planConflictResponse>[]> {
  const db = ctx.db<typeof schema>();
  const unresolved = await db
    .select()
    .from(schema.planExerciseConflicts)
    .where(isNull(schema.planExerciseConflicts.resolvedAt))
    .orderBy(asc(schema.planExerciseConflicts.id));
  if (unresolved.length === 0) return [];
  const groups = new Map<string, (typeof unresolved)[number][]>();
  for (const row of unresolved) {
    const groupKey = `${row.routine} ${row.exerciseKey}`;
    const group = groups.get(groupKey);
    if (group) group.push(row);
    else groups.set(groupKey, [row]);
  }
  const conflicts: z.infer<typeof planConflictResponse>[] = [];
  for (const group of groups.values()) {
    const head = group[0];
    if (!head) continue;
    const liveRows = await db
      .select()
      .from(schema.planExercises)
      .where(
        and(
          eq(schema.planExercises.routine, head.routine),
          eq(schema.planExercises.exerciseKey, head.exerciseKey),
        ),
      )
      .orderBy(asc(schema.planExercises.id))
      .limit(1);
    const live = liveRows[0];
    const candidates: z.infer<typeof planConflictCandidateResponse>[] = [];
    if (live) {
      candidates.push({
        source: "live",
        archive_id: null,
        id: live.id,
        name: live.exerciseName,
        sets: live.sets,
        target: live.targetReps,
        sort_order: live.sortOrder,
      });
    }
    for (const row of group) {
      candidates.push({
        source: "archived",
        archive_id: row.id,
        id: row.id,
        name: row.exerciseName,
        sets: row.sets,
        target: row.targetReps,
        sort_order: row.sortOrder,
      });
    }
    let archivedAt: Date | null = null;
    for (const row of group) {
      if (row.archivedAt && (!archivedAt || row.archivedAt < archivedAt)) archivedAt = row.archivedAt;
    }
    conflicts.push({
      routine: head.routine,
      exercise_key: head.exerciseKey,
      exercise_name: live?.exerciseName ?? head.exerciseName,
      candidate_count: candidates.length,
      archived_at: archivedAt ? archivedAt.toISOString() : null,
      candidates,
      plan_version: planVersion,
    });
  }
  return conflicts;
}

// Pure plan validation, shared by updatePlan (and validation scripts).
// Returns a human-readable error string, or null when the plan is
// saveable. Rules: every routine present exactly once with 1–15
// exercises; exercise keys unique per routine and slug-shaped; sets
// 1–10; names and targets non-empty; the schedule covers all 7 days
// exactly once with known codes; daily items 1–10 with unique keys
// and non-empty titles.
export function validatePlanInput(input: {
  routines: { routine: string; exercises: { key: string; name: string; sets: number; target: string }[] }[];
  schedule: { day_index: number; routine_code: string; note: string }[];
  daily_items: { key: string; title: string; detail: string }[];
}): string | null {
  const keyPattern = /^[a-z0-9][a-z0-9-]*$/;
  if (input.routines.length !== ROUTINE_KEYS.length) return "训练日模板不完整";
  const seenRoutines = new Set<string>();
  for (const entry of input.routines) {
    if (!(ROUTINE_KEYS as readonly string[]).includes(entry.routine)) return `未知训练日：${entry.routine}`;
    if (seenRoutines.has(entry.routine)) return "训练日模板有重复";
    seenRoutines.add(entry.routine);
    if (entry.exercises.length < 1 || entry.exercises.length > 15) return "每个训练日需要 1–15 个动作";
    const keys = new Set<string>();
    for (const exercise of entry.exercises) {
      if (!keyPattern.test(exercise.key)) return `动作标识不合法：${exercise.key}`;
      if (keys.has(exercise.key)) return `同一训练日内动作重复：${exercise.name}`;
      keys.add(exercise.key);
      if (exercise.name.trim() === "" || exercise.name.length > 60) return "动作名称不能为空";
      if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 10) {
        return `组数需要在 1–10 之间：${exercise.name}`;
      }
      if (exercise.target.trim() === "" || exercise.target.length > 30) return `目标次数不能为空：${exercise.name}`;
    }
  }
  if (input.schedule.length !== 7) return "周安排需要正好 7 天";
  const days = new Set<number>();
  for (const entry of input.schedule) {
    if (!Number.isInteger(entry.day_index) || entry.day_index < 0 || entry.day_index > 6) return "周安排日期不合法";
    if (days.has(entry.day_index)) return "周安排有重复的日期";
    days.add(entry.day_index);
    if (!(SCHEDULE_CODES as readonly string[]).includes(entry.routine_code)) return "周安排里有未知安排";
    if (entry.note.length > 120) return "周安排备注太长";
  }
  if (input.daily_items.length < 1 || input.daily_items.length > 10) return "每日微练需要 1–10 项";
  const itemKeys = new Set<string>();
  for (const item of input.daily_items) {
    if (!keyPattern.test(item.key)) return `微练标识不合法：${item.key}`;
    if (itemKeys.has(item.key)) return "每日微练有重复项";
    itemKeys.add(item.key);
    if (item.title.trim() === "" || item.title.length > 60) return "微练名称不能为空";
    if (item.detail.length > 120) return "微练说明太长";
  }
  return null;
}

// The viewer's calendar date for the daily checklist, in the same
// America/Los_Angeles frame the week summaries use.
export function laDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

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
  // W2.3 (additive): the contributing workout's completion time as an
  // ISO string, or null when the caller did not supply one. Pure
  // pass-through — it never influences which workout is selected.
  sourceCompletedAt: string | null;
  sets: { setNumber: number; weight: number | null; reps: number | null; completed: boolean }[];
};

export function selectComparableHistory(
  recentCompleted: { unit: "lb" | "kg"; completedAt?: string | null; sets: ComparableSetLike[] }[],
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
        sourceCompletedAt: workout.completedAt ?? null,
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
): Promise<{ unit: "lb" | "kg"; completedAt: string | null; sets: ComparableSetLike[] }[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ id: schema.workouts.id, unit: schema.workouts.unit, completedAt: schema.workouts.completedAt })
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
    // W2.3: the source workout's completion time, passed through so
    // selectComparableHistory can stamp it onto the dashboard entry.
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    sets: setsByWorkout.get(row.id) ?? [],
  }));
}

async function loadPreviousCompletedSets(
  ctx: Ctx,
  routine: z.infer<typeof routineSchema>,
  unit: z.infer<typeof unitSchema>,
  exerciseKeys: string[],
): Promise<PreviousComparable> {
  const recentCompleted = await loadRoutineRecentCompleted(ctx, routine);
  return selectPreviousSetsByExercise(recentCompleted, exerciseKeys, unit);
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
  const templates = await loadPlanTemplates(ctx);
  for (const routine of ROUTINE_KEYS) {
    const recentCompleted = await loadRoutineRecentCompleted(ctx, routine);
    for (const raw of selectComparableHistory(recentCompleted, templates[routine].map((exercise) => exercise.key))) {
      entries.push({
        routine,
        exercise_key: raw.exerciseKey,
        unit: raw.unit,
        target: raw.target,
        source_completed_at: raw.sourceCompletedAt,
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

// W4.3-D1: the pure per-exercise previous-comparable selection behind
// the completion receipt. `candidates` is the receipt workout's own
// routine's completed workouts that finished strictly before it, most
// recent first (the caller filters and orders). For each exercise key
// (in the receipt workout's own order) the FIRST candidate containing
// that key contributes the entry — matched by key only, so a
// same-named exercise under a different key never counts as
// comparable. Counts are that exercise's own sets in the source
// workout: uncompleted sets are never zero-filled, and an exercise
// whose source sets were all uncompleted reports a real
// completed_sets of 0. Self-contained so validation scripts can run
// it verbatim.
export function selectReceiptPrevious(
  candidates: { id: number; completed_at: string; sets: { exercise_key: string; completed: boolean }[] }[],
  exerciseKeys: string[],
): z.infer<typeof receiptPreviousEntryResponse>[] {
  const entries: z.infer<typeof receiptPreviousEntryResponse>[] = [];
  for (const key of exerciseKeys) {
    for (const candidate of candidates) {
      const sets = candidate.sets.filter((set) => set.exercise_key === key);
      if (sets.length === 0) continue;
      entries.push({
        exercise_key: key,
        source_completed_at: candidate.completed_at,
        completed_sets: sets.filter((set) => set.completed).length,
        total_sets: sets.length,
      });
      break;
    }
  }
  return entries;
}

// W4.3-D1: load the receipt workout's previous-comparable candidates —
// completed workouts of the SAME routine that finished strictly
// before it ((completed_at, id) order, so a same-instant record with a
// larger id never counts as "earlier"), most recent first, capped at
// the same 20-workout window the comparable-history selection uses.
async function loadReceiptPrevious(
  ctx: Ctx,
  receipt: z.infer<typeof workoutResponse>,
): Promise<z.infer<typeof receiptPreviousEntryResponse>[]> {
  if (!receipt.completed_at) return [];
  const db = ctx.db<typeof schema>();
  const completedAtMs = new Date(receipt.completed_at).getTime();
  const rows = await db
    .select({ id: schema.workouts.id, completedAt: schema.workouts.completedAt })
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.routine, receipt.routine),
        isNotNull(schema.workouts.completedAt),
        ne(schema.workouts.id, receipt.id),
      ),
    )
    .orderBy(desc(schema.workouts.completedAt), desc(schema.workouts.id))
    .limit(40);
  const earlier: { id: number; completedAt: Date }[] = [];
  for (const row of rows) {
    if (!row.completedAt) continue;
    const ms = row.completedAt.getTime();
    if (ms < completedAtMs || (ms === completedAtMs && row.id < receipt.id)) {
      earlier.push({ id: row.id, completedAt: row.completedAt });
      if (earlier.length >= 20) break;
    }
  }
  if (earlier.length === 0) return [];
  const setRows = await db
    .select({
      workoutId: schema.workoutSets.workoutId,
      exerciseKey: schema.workoutSets.exerciseKey,
      completed: schema.workoutSets.completed,
    })
    .from(schema.workoutSets)
    .where(inArray(schema.workoutSets.workoutId, earlier.map((row) => row.id)));
  const setsByWorkout = new Map<number, { exercise_key: string; completed: boolean }[]>();
  for (const row of setRows) {
    const list = setsByWorkout.get(row.workoutId) ?? [];
    list.push({ exercise_key: row.exerciseKey, completed: row.completed });
    setsByWorkout.set(row.workoutId, list);
  }
  const candidates = earlier.map((row) => ({
    id: row.id,
    completed_at: row.completedAt.toISOString(),
    sets: setsByWorkout.get(row.id) ?? [],
  }));
  const exerciseKeys = [...new Set(receipt.sets.map((set) => set.exercise_key))];
  return selectReceiptPrevious(candidates, exerciseKeys);
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({
      recent_limit: z.number().int().min(1).max(20).default(8),
      // W4.3-D1 (additive, optional): the id of the workout the caller
      // just completed, to read back by id for the completion
      // receipt. Omitted by every existing caller.
      receipt_workout_id: z.number().int().positive().optional(),
    }),
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
      // W4.3-D1 (additive): when the caller names the workout it just
      // completed, read THAT record back by id for the completion
      // receipt, together with its per-exercise previous-comparable
      // entries. Located strictly by id — never by a "most recent"
      // substitution: an unknown or not-yet-completed id answers
      // receipt: null and the client shows its retryable not-read
      // state instead of guessing. This runs only after the gate
      // above passed, under the same owner / sync-channel rule as the
      // rest of this action — nothing here widens access, and no
      // write path is involved.
      let receiptFields: {
        receipt: z.infer<typeof workoutResponse> | null;
        receipt_previous: z.infer<typeof receiptPreviousEntryResponse>[];
      } | null = null;
      if (args.receipt_workout_id != null) {
        const located = await loadWorkout(ctx, args.receipt_workout_id);
        if (located && located.completed_at != null) {
          receiptFields = {
            receipt: located,
            receipt_previous: await loadReceiptPrevious(ctx, located),
          };
        } else {
          receiptFields = { receipt: null, receipt_previous: [] };
        }
      }
      return {
        forbidden: false,
        active_workout: activeWorkout,
        recent_workouts: recentWorkouts,
        week_summaries: weekSummaries,
        comparable_history: await loadComparableHistory(ctx),
        ...(receiptFields ?? {}),
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
      await ensurePlanSeeded(ctx);
      const templates = await loadPlanTemplates(ctx);
      const template = templates[args.routine];
      const previous = await loadPreviousCompletedSets(
        ctx,
        args.routine,
        args.unit,
        template.map((exercise) => exercise.key),
      );
      const values = template.flatMap((exercise) => {
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

      // W-START-001 full arbitration, run after the prefill sets are
      // in and BEFORE this workout becomes ready. Every iteration
      // re-reads ALL other actives — ready and initializing both
      // count — and re-decides from scratch; no single observation
      // (a vanished row, a takeover DELETE's row count, a lone 30s
      // age) ever licenses flipping this workout ready directly:
      //  - a ready other exists → yield to the earliest one: reclaim
      //    this initializing row (single conditional DELETE: still
      //    initializing, still active — the mirror of
      //    canReclaimInitializingWorkout; no user write can have
      //    landed on it) and return that workout, so concurrent
      //    starts return the SAME usable workout.
      //  - the earliest other is still initializing → the bounded
      //    poll driven by resolveYieldDecision: wait while it works;
      //    past the budget, take it over only if its started_at is
      //    ≥30s old (conditional DELETE + its sets), then
      //    RE-ARBITRATE from a fresh full read — the DELETE may have
      //    matched 0 rows because the other flipped ready first
      //    (the loser of that race yields to the now-ready other on
      //    the next iteration, never flips itself ready too), or
      //    another waiter may now be the earliest candidate
      //    (several waiters on the same stale leftover converge on
      //    ONE survivor). A fresh still-initializing other past the
      //    budget fails this start with a retryable error (the catch
      //    below reclaims this run's initializing row first). A
      //    start NEVER returns a workout that is not ready with its
      //    sets in.
      //  - no other active precedes this one and none is ready →
      //    this insert is the unique candidate: flip it ready with a
      //    single conditional UPDATE whose WHERE also proves,
      //    atomically at flip time, that no other ready active
      //    exists and no earlier initializing active exists. A 0-row
      //    flip means a race was lost between the read and the flip:
      //    re-arbitrate instead of assuming.
      // After a successful flip, re-check that no other ready
      // active exists; on a conflict the earliest ready workout
      // deterministically wins and this start returns it (a
      // response-level yield — an already-visible row is never
      // deleted; only a still-initializing own row may ever be
      // reclaimed).
      let attemptsLeft = YIELD_WAIT_ATTEMPTS;
      for (;;) {
        const otherActiveRows = await db
          .select({
            id: schema.workouts.id,
            initializing: schema.workouts.initializing,
            startedAt: schema.workouts.startedAt,
          })
          .from(schema.workouts)
          .where(and(isNull(schema.workouts.completedAt), ne(schema.workouts.id, workoutId)))
          .orderBy(asc(schema.workouts.id));

        // Yield-ready: a usable active already exists. Reclaim this
        // run's still-initializing row and return that workout.
        const readyOther = otherActiveRows.find((row) => row.initializing === 0) ?? null;
        if (readyOther) {
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
            const kept = await loadWorkout(ctx, readyOther.id);
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

        const earliestOther = otherActiveRows[0] ?? null;
        const earliestOtherActiveId = earliestOther?.id ?? null;
        const conflict = resolveStartConflict(earliestOtherActiveId, workoutId);
        if (conflict.action === "yield") {
          const keepId = conflict.keepId;
          const keeper = otherActiveRows.find((row) => row.id === keepId) ?? null;
          const decision = resolveYieldDecision(
            {
              present: keeper != null,
              initializing: keeper != null && keeper.initializing === 1,
              startedAtMs: keeper ? keeper.startedAt.getTime() : null,
            },
            attemptsLeft,
            Date.now(),
          );
          if (decision === "wait") {
            attemptsLeft -= 1;
            await waitMs(YIELD_WAIT_INTERVAL_MS);
            continue;
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
            // W-START-001 re-arbitration: whether the DELETE removed
            // the stale row or matched 0 rows (the other flipped
            // ready or vanished first), arbitration starts over with
            // a fresh full read and a fresh wait budget — this start
            // flips ready only as the unique surviving candidate of
            // a later iteration.
            attemptsLeft = YIELD_WAIT_ATTEMPTS;
            continue;
          }
          if (decision === "retry") {
            throw new Error("另一场训练正在初始化，请稍后重试");
          }
          // "proceed-self" / "yield-ready" decided from a snapshot
          // whose row changed state mid-decision: re-arbitrate on a
          // fresh full read rather than acting on the stale one.
          continue;
        }

        // This insert precedes every other active and none is ready:
        // it is the unique candidate. Flip ready with a single
        // conditional UPDATE — the flip lands only while this row is
        // still initializing AND no other ready active exists AND
        // no earlier initializing active exists, atomically.
        const flipped = await db
          .update(schema.workouts)
          .set({ initializing: 0 })
          .where(
            and(
              eq(schema.workouts.id, workoutId),
              eq(schema.workouts.initializing, 1),
              sql`NOT EXISTS (SELECT 1 FROM workouts WHERE workouts.completed_at IS NULL AND workouts.initializing = 0 AND workouts.id <> ${workoutId})`,
              sql`NOT EXISTS (SELECT 1 FROM workouts WHERE workouts.completed_at IS NULL AND workouts.initializing = 1 AND workouts.id < ${workoutId})`,
            ),
          )
          .returning({ id: schema.workouts.id });
        if (flipped.length === 0) {
          // Lost a race between the arbitration read and the flip:
          // never assume — re-arbitrate while budget remains, else
          // fail retryably (the catch reclaims this initializing
          // row, so the retry starts clean).
          if (attemptsLeft > 0) {
            attemptsLeft -= 1;
            await waitMs(YIELD_WAIT_INTERVAL_MS);
            continue;
          }
          throw new Error("另一场训练正在初始化，请稍后重试");
        }

        // W-START-001 post-flip re-check: no OTHER ready active may
        // exist now. (The guarded flip makes this unreachable in
        // practice; if a conflict is ever observed, the earliest
        // ready workout deterministically wins and this start
        // returns it. Already-visible rows are never deleted here —
        // only a still-initializing own row may be reclaimed, and
        // this one just flipped.)
        const readyConflicts = await db
          .select({ id: schema.workouts.id })
          .from(schema.workouts)
          .where(
            and(
              isNull(schema.workouts.completedAt),
              eq(schema.workouts.initializing, 0),
              ne(schema.workouts.id, workoutId),
            ),
          )
          .orderBy(asc(schema.workouts.id))
          .limit(1);
        const conflictRow = readyConflicts[0] ?? null;
        if (conflictRow && conflictRow.id < workoutId) {
          const kept = await loadWorkout(ctx, conflictRow.id);
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
      }
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

  getPlan: defineAction({
    request: z.object({}),
    response: planResponse,
    async handler(ctx): Promise<z.infer<typeof planResponse>> {
      const empty: z.infer<typeof planResponse> = {
        forbidden: true,
        routines: [],
        schedule: [],
        daily_items: [],
        daily_date: laDateKey(new Date()),
        daily_done: [],
      };
      // Strictly owner-only, unlike getDashboard: the L0.1 sync-channel
      // exception the user accepted covers getDashboard's read for the
      // 健康看板 sync, and the plan surface does not extend it.
      if (!isOwner(ctx)) return empty;
      await ensurePlanSeeded(ctx);
      const db = ctx.db<typeof schema>();
      // W-PLAN-SAFE-001 (version-checked read): the three plan tables
      // are read between two reads of the version token. A save is
      // one atomic batch that also increments the token, so equal
      // bracketing tokens prove no save interleaved and the rows all
      // come from the same saved version. On a mismatch the WHOLE
      // read is retried (bounded — see below).
      //
      // W-PLAN-SAFE-001 P0 tail (exhaustion must fail, never mix):
      // the retry is bounded at PLAN_READ_MAX_ATTEMPTS and exhaustion
      // is an explicit retryable failure (read_error, no plan body) —
      // NEVER a "successful" response assembled from the last raced
      // attempt, whose routines could come from one save and its
      // schedule/daily from another, a combination that was never
      // saved together. The bound stays finite on purpose: an
      // unbounded loop would hide writer starvation behind a hung
      // read instead of surfacing a retryable error.
      let templates: PlanTemplateMap | null = null;
      let scheduleRows: (typeof schema.planSchedule.$inferSelect)[] = [];
      let dailyRows: (typeof schema.planDailyItems.$inferSelect)[] = [];
      let conflicts: z.infer<typeof planConflictResponse>[] = [];
      let consistent = false;
      for (let attempt = 0; attempt < PLAN_READ_MAX_ATTEMPTS; attempt++) {
        const versionBefore = await readPlanVersion(ctx);
        templates = await loadPlanTemplates(ctx);
        scheduleRows = await db
          .select()
          .from(schema.planSchedule)
          .orderBy(asc(schema.planSchedule.dayIndex));
        dailyRows = await db
          .select()
          .from(schema.planDailyItems)
          .orderBy(asc(schema.planDailyItems.sortOrder), asc(schema.planDailyItems.id));
        // W-PLAN-SAFE-001 follow-up: the conflict state is read
        // inside the same version bracket — resolvePlanConflict
        // increments the token in its batch, so a resolution landing
        // mid-read is detected and retried like any other save, and
        // the candidates shown always belong to the same plan
        // version as the routines above. The bracket's version is
        // stamped onto the conflict entries for decision binding.
        conflicts = await loadPlanConflicts(ctx, versionBefore);
        const versionAfter = await readPlanVersion(ctx);
        if (versionBefore === versionAfter) {
          consistent = true;
          break;
        }
      }
      const dateKey = laDateKey(new Date());
      if (!consistent || !templates) {
        // Retry exhaustion: no consistent snapshot was read. Return
        // the typed retryable failure with NO plan body — the client
        // keeps the plan/draft it already shows and offers a retry.
        return {
          forbidden: false,
          routines: [],
          schedule: [],
          daily_items: [],
          daily_date: dateKey,
          daily_done: [],
          read_error: "计划读取时另一窗口正在连续保存，未能读到完整一致的版本；当前显示未改动，请重试",
        };
      }
      const doneRows = await db
        .select()
        .from(schema.dailyCompletions)
        .where(eq(schema.dailyCompletions.dateKey, dateKey));
      return {
        forbidden: false,
        routines: ROUTINE_KEYS.map((routine) => ({ routine, exercises: templates[routine] })),
        schedule: scheduleRows.map((row) => ({
          day_index: row.dayIndex,
          routine_code: row.routineCode,
          note: row.note,
        })),
        daily_items: dailyRows.map((row) => ({ key: row.itemKey, title: row.title, detail: row.detail })),
        daily_date: dateKey,
        daily_done: doneRows.filter((row) => row.done === 1).map((row) => row.itemKey),
        // No unconfirmed conflict → both fields omitted, so the
        // response is byte-for-byte the pre-fix shape.
        ...(conflicts.length > 0 ? { conflicts, conflict_count: conflicts.length } : {}),
      };
    },
  }),

  updatePlan: defineAction({
    request: z.object({
      routines: z.array(
        z.object({
          routine: z.string(),
          exercises: z.array(
            z.object({
              key: z.string(),
              name: z.string(),
              sets: z.number(),
              target: z.string(),
            }),
          ),
        }),
      ),
      schedule: z.array(
        z.object({ day_index: z.number(), routine_code: z.string(), note: z.string() }),
      ),
      daily_items: z.array(
        z.object({ key: z.string(), title: z.string(), detail: z.string() }),
      ),
    }),
    response: updatePlanResponse,
    async handler(ctx, args): Promise<z.infer<typeof updatePlanResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true, error: null };
      }
      const error = validatePlanInput(args);
      if (error) return { ok: false, forbidden: false, error };
      const db = ctx.db<typeof schema>();
      // W-PLAN-SAFE-001: the full replace of the three plan tables is
      // ONE db.batch — the platform db handle exposes no transaction
      // method (see @hatch/space-sdk's SpaceDb type), and batch is
      // its atomic multi-statement write: the deletes and inserts
      // commit together or not at all, so any failure leaves the
      // previous plan completely intact and a concurrent getPlan only
      // ever reads the whole old plan or the whole new one. Two
      // concurrent saves are two batches; they cannot interleave, so
      // the stored plan is always exactly one of the submitted plans.
      // Daily completions key off item keys, which the editor keeps
      // stable across renames, so history survives a save — and this
      // batch never touches workout or completion rows. The trailing
      // plan_meta inserts keep the seeded marker present even if a
      // save is somehow the first plan write a database ever sees,
      // and increment the internal plan version token in the SAME
      // batch — so the token and the tables can never drift apart,
      // which is what makes getPlan's bracketed version check sound.
      try {
        await db.batch([
          db.delete(schema.planExercises),
          db.delete(schema.planSchedule),
          db.delete(schema.planDailyItems),
          db.insert(schema.planExercises).values(
            args.routines.flatMap((entry) =>
              entry.exercises.map((exercise, index) => ({
                routine: entry.routine,
                sortOrder: index,
                exerciseKey: exercise.key,
                exerciseName: exercise.name.trim(),
                sets: exercise.sets,
                targetReps: exercise.target.trim(),
              })),
            ),
          ),
          db.insert(schema.planSchedule).values(
            args.schedule.map((entry) => ({
              dayIndex: entry.day_index,
              routineCode: entry.routine_code,
              note: entry.note,
            })),
          ),
          db.insert(schema.planDailyItems).values(
            args.daily_items.map((item, index) => ({
              itemKey: item.key,
              title: item.title.trim(),
              detail: item.detail,
              sortOrder: index,
            })),
          ),
          db.insert(schema.planMeta).values({ key: PLAN_META_SEEDED_KEY, value: "1" }).onConflictDoNothing(),
          planVersionIncrement(db),
        ]);
      } catch {
        // The batch rolled back: the old plan is untouched. Report a
        // retryable failure instead of throwing — the editor keeps
        // its local draft and offers 保存计划 again.
        return { ok: false, forbidden: false, error: "保存失败，原计划未改动，请重试" };
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, error: null };
    },
  }),

  // W-PLAN-SAFE-001 follow-up (owner confirmation / restore path):
  // the owner picks which candidate copy of an unconfirmed
  // (routine, exercise_key) conflict is authoritative.
  // selected_archive_id null confirms the currently displayed live
  // copy; an archive id restores that preserved copy into
  // plan_exercises under its ORIGINAL row id. Either way the whole
  // group is closed in ONE atomic batch together with the plan
  // version increment: the chosen copy's archive row (when the
  // choice came from the archive) is stamped resolution='selected',
  // every other archive row of the group 'superseded', and all of
  // them record resolution_selected_id (the winning row's id) and
  // resolved_at — the decision itself stays traceable. When an
  // archived copy wins, the displaced live row is first copied into
  // the archive already-resolved, so no candidate is ever lost.
  // Until this action runs, nothing marks any copy as confirmed:
  // getPlan keeps surfacing the conflict on every read.
  //
  // W-PLAN-SAFE-001 P0 tail + rework (bound, atomically claimed
  // decisions): a confirmation is bound to what the owner was
  // actually shown, and the binding is REQUIRED. The client echoes
  // the candidate set it displayed (expected_candidate_ids) and
  // the plan version those candidates belonged to
  // (expected_plan_version). Both fields must arrive with the
  // request — expected_plan_version may be null (the token row did
  // not exist when the conflict was displayed) but the field itself
  // may not be absent; it must otherwise be a non-negative integer
  // decimal string, and expected_candidate_ids a non-empty array of
  // integers. A request missing or malforming either field — an
  // older client above all — is rejected with the typed stale
  // answer BEFORE any database write: it fails safe and can never
  // claim a version it was never shown. A well-formed binding is
  // checked against a fresh read BEFORE anything is written, and a
  // mismatch is the same typed stale failure — the decision is not
  // applied to a plan or candidate set the owner never saw.
  //
  // The binding is then re-verified INSIDE the same atomic batch by
  // its FIRST statement: a conditional claim that stamps the
  // still-unresolved group rows with this decision's marker, only
  // while every unresolved row still carries a NULL
  // resolution_selected_id (i.e. no other decision claimed the
  // group first) AND the plan version token still equals the bound
  // one. The batch's SECOND statement is the version advance,
  // itself guarded on the claim marker (and, for a non-null bound
  // version, on the token still equalling it; for a null bound
  // version it inserts '1' only while the token row is still
  // absent). A save or a rival decision landing between this
  // handler's pre-read and the batch therefore makes the claim
  // stamp ZERO rows — and then every later statement in the batch
  // writes zero rows too, the version advance included: the batch
  // is a no-op, there is NO compensation write afterwards (a
  // cross-transaction −1 was the ABA hazard removed by this
  // rework), and the handler simply re-reads and answers the typed
  // stale / already_resolved verdict. On a landed claim the token
  // advances by exactly 1, atomically with the decision, and the
  // handler judges the outcome from a post-batch re-read of the
  // actual token (never from a statement RETURNING). It never
  // reports success for a version the owner did not see, never
  // overwrites the newer plan, never resets a winner's rows, and
  // never drops a candidate. A repeated submission of the SAME
  // decision (double tap, retried request) is answered from the
  // recorded decision: ok with outcome "already_resolved".
  resolvePlanConflict: defineAction({
    request: z.object({
      routine: z.string().min(1),
      exercise_key: z.string().min(1),
      selected_archive_id: z.number().int().nullable(),
      // Required binding (P0 tail, made mandatory by the P0
      // rework): the displayed candidate ids, in display order —
      // the live candidate's plan_exercises id (when a live
      // candidate was shown) followed by the archived candidates'
      // archive ids — and the plan version token the displayed
      // conflict belonged to (null when the token row did not exist
      // at display time). Both fields must arrive with the request;
      // the schema keeps them optional and the ids unrefined ONLY
      // so a request that omits or malforms them reaches the
      // handler, which answers the typed stale rejection with zero
      // writes instead of a transport-level schema error.
      expected_candidate_ids: z.array(z.number()).optional(),
      expected_plan_version: z.string().nullable().optional(),
    }),
    response: resolvePlanConflictResponse,
    async handler(ctx, args): Promise<z.infer<typeof resolvePlanConflictResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true, error: null };
      }
      const db = ctx.db<typeof schema>();
      const staleError = "计划或候选副本已经变化，你看到的版本已过期；没有确认任何版本，请刷新后按最新候选重新确认";
      // W-PLAN-SAFE-001 P0 rework (required binding): both binding
      // fields MUST arrive with the request. expected_plan_version
      // may be null (the token row did not exist when the conflict
      // was displayed) but the field itself may not be absent; the
      // version must be null or a non-negative integer decimal
      // string, and expected_candidate_ids a non-empty array of
      // integers. Anything else — above all an older client that
      // sends neither field — is rejected here, BEFORE any database
      // write, with the typed stale answer: zero writes, the
      // conflict stays open, the plan untouched. (The isOwner gate
      // above runs first, so forbidden callers still hear only
      // "forbidden".)
      const candidateIdsArg = args.expected_candidate_ids;
      const planVersionArg = args.expected_plan_version;
      if (
        !Array.isArray(candidateIdsArg) ||
        candidateIdsArg.length === 0 ||
        !candidateIdsArg.every((id) => Number.isInteger(id)) ||
        planVersionArg === undefined ||
        (planVersionArg !== null && !/^\d+$/.test(planVersionArg))
      ) {
        return {
          ok: false,
          forbidden: false,
          error: "确认请求缺少有效的候选绑定（候选编号与计划版本为必填，旧版请求无法确认未展示的版本），没有确认任何版本，请刷新后按最新候选重新确认",
          outcome: "stale",
        };
      }
      const groupRows = () =>
        db
          .select()
          .from(schema.planExerciseConflicts)
          .where(
            and(
              eq(schema.planExerciseConflicts.routine, args.routine),
              eq(schema.planExerciseConflicts.exerciseKey, args.exercise_key),
            ),
          )
          .orderBy(asc(schema.planExerciseConflicts.id));
      const liveRowFor = () =>
        db
          .select()
          .from(schema.planExercises)
          .where(
            and(
              eq(schema.planExercises.routine, args.routine),
              eq(schema.planExercises.exerciseKey, args.exercise_key),
            ),
          )
          .orderBy(asc(schema.planExercises.id))
          .limit(1);
      type GroupRow = typeof schema.planExerciseConflicts.$inferSelect;
      type LiveRow = typeof schema.planExercises.$inferSelect;
      const stampOf = (version: string | null, live: LiveRow | undefined, rows: GroupRow[]) =>
        conflictVersionStamp({
          planVersion: version,
          live: live
            ? {
                id: live.id,
                sortOrder: live.sortOrder,
                exerciseName: live.exerciseName,
                sets: live.sets,
                targetReps: live.targetReps,
              }
            : null,
          archived: rows.map((row) => ({
            id: row.id,
            sortOrder: row.sortOrder,
            exerciseName: row.exerciseName,
            sets: row.sets,
            targetReps: row.targetReps,
            archivedAtMs: row.archivedAt ? row.archivedAt.getTime() : null,
          })),
        });
      // Idempotent receipt / closed-group verdict, from the group's
      // recorded decision. The decision's KIND is part of its
      // identity: an archive restore marks the winning row
      // 'selected', while a live confirmation marks every row
      // 'superseded' with the live row's id recorded. A repeat is
      // the SAME decision only when it asks for the same kind and
      // the same winner — confirming "the live copy" after an
      // archive restore is a different request (the live copy is
      // now the restored row, which the original decision picked
      // from the archive) and stays an error, as before.
      const closedGroupVerdict = (
        rows: GroupRow[],
        live: LiveRow | undefined,
      ): z.infer<typeof resolvePlanConflictResponse> | null => {
        if (rows.length === 0 || rows.some((row) => row.resolvedAt === null)) return null;
        const alreadyResolved: z.infer<typeof resolvePlanConflictResponse> = {
          ok: true,
          forbidden: false,
          error: null,
          outcome: "already_resolved",
        };
        const closedError: z.infer<typeof resolvePlanConflictResponse> = {
          ok: false,
          forbidden: false,
          error: "没有找到待确认的冲突，可能已经确认过了",
        };
        const selectedRow = rows.find((row) => row.resolution === "selected");
        if (args.selected_archive_id !== null) {
          return selectedRow && selectedRow.id === args.selected_archive_id
            ? alreadyResolved
            : closedError;
        }
        if (selectedRow) return closedError;
        const winner = rows[0]?.resolutionSelectedId ?? null;
        return winner !== null && live !== undefined && winner === live.id
          ? alreadyResolved
          : closedError;
      };

      const allRows = await groupRows();
      const unresolved = allRows.filter((row) => row.resolvedAt === null);
      const liveRows0 = await liveRowFor();
      const live0 = liveRows0[0];
      if (unresolved.length === 0) {
        const verdict = closedGroupVerdict(allRows, live0);
        if (verdict) return verdict;
        return { ok: false, forbidden: false, error: "没有找到待确认的冲突，可能已经确认过了" };
      }
      if (args.selected_archive_id !== null && !unresolved.some((row) => row.id === args.selected_archive_id)) {
        return { ok: false, forbidden: false, error: "所选的归档副本不存在或已经确认过" };
      }
      if (args.selected_archive_id === null && !live0) {
        return { ok: false, forbidden: false, error: "当前显示的这一份已不在计划中，请从归档副本里选一份恢复" };
      }
      // Display binding (presence and shape already enforced
      // above): the current state must still be what the client was
      // shown — same plan version, same candidate ids in display
      // order. Otherwise this confirmation refers to a version the
      // owner never saw: typed stale, zero writes.
      let boundVersion = await readPlanVersion(ctx);
      {
        const displayedIds = [
          ...(live0 ? [live0.id] : []),
          ...unresolved.map((row) => row.id),
        ];
        const idsMatch =
          candidateIdsArg.length === displayedIds.length &&
          candidateIdsArg.every((id, index) => id === displayedIds[index]);
        if (!idsMatch || planVersionArg !== boundVersion) {
          return { ok: false, forbidden: false, error: staleError, outcome: "stale" };
        }
      }

      // Decision loop (bounded): build the decision batch from a
      // fresh read, claim the group as the batch's first statement,
      // and verify from the batch results + a post-read stamp that
      // the claim actually landed on the state the decision was
      // built from. A lost race retries against the fresh state at
      // most once (identical re-decision → proceed; anything else →
      // typed verdict); a rollback that itself fails throws, so a
      // torn state is never answered as success.
      for (let decisionAttempt = 0; decisionAttempt < 2; decisionAttempt++) {
        const rowsNow = decisionAttempt === 0 ? allRows : await groupRows();
        const unresolvedNow = rowsNow.filter((row) => row.resolvedAt === null);
        const liveRowsNow = decisionAttempt === 0 ? liveRows0 : await liveRowFor();
        const live = liveRowsNow[0];
        if (decisionAttempt > 0) {
          if (unresolvedNow.length === 0) {
            const verdict = closedGroupVerdict(rowsNow, live);
            if (verdict) return verdict;
            return { ok: false, forbidden: false, error: staleError, outcome: "stale" };
          }
          boundVersion = await readPlanVersion(ctx);
          // Re-decide against the fresh state: proceed only if the
          // request still denotes the SAME decision here — the bound
          // version and candidate ids still match what the client
          // was shown, and the requested winner still exists.
          const freshIds = [...(live ? [live.id] : []), ...unresolvedNow.map((row) => row.id)];
          const bindingStillMatches =
            planVersionArg === boundVersion &&
            candidateIdsArg.length === freshIds.length &&
            candidateIdsArg.every((id, index) => id === freshIds[index]);
          const winnerStillExists =
            args.selected_archive_id !== null
              ? unresolvedNow.some((row) => row.id === args.selected_archive_id)
              : live !== undefined;
          if (!bindingStillMatches || !winnerStillExists) {
            return { ok: false, forbidden: false, error: staleError, outcome: "stale" };
          }
        }
        // The decision's own batch increments the token exactly
        // once, so a cleanly landed decision reads back stamped at
        // bound+1 ('1' when the token row did not exist yet). A
        // rival write landing in between moves it further — the
        // post-read stamp comparison below catches both that and a
        // claim that stamped zero rows.
        const expectedPostVersion =
          boundVersion === null ? "1" : String(Number(boundVersion) + 1);
        const now = new Date();
        // The post-decision state a clean landing produces, derived
        // from the pre-decision state: confirming the live copy
        // changes no plan row; restoring an archived copy makes
        // THAT copy the live row and archives the displaced live row
        // (already resolved) alongside the group's rows. (The stamp
        // ignores resolution fields, so the group's own rows stamp
        // identically before and after being closed.)
        const chosenPre =
          args.selected_archive_id === null
            ? undefined
            : unresolvedNow.find((row) => row.id === args.selected_archive_id);
        const expectedPostLive: LiveRow | undefined =
          args.selected_archive_id === null
            ? live
            : chosenPre
              ? {
                  id: chosenPre.id,
                  routine: chosenPre.routine,
                  sortOrder: chosenPre.sortOrder,
                  exerciseKey: chosenPre.exerciseKey,
                  exerciseName: chosenPre.exerciseName,
                  sets: chosenPre.sets,
                  targetReps: chosenPre.targetReps,
                }
              : undefined;
        const expectedPostArchived: GroupRow[] =
          args.selected_archive_id === null || !live
            ? unresolvedNow
            : [
                ...unresolvedNow,
                {
                  id: live.id,
                  routine: live.routine,
                  sortOrder: live.sortOrder,
                  exerciseKey: live.exerciseKey,
                  exerciseName: live.exerciseName,
                  sets: live.sets,
                  targetReps: live.targetReps,
                  archivedNote: "",
                  archivedAt: now,
                  resolvedAt: now,
                  resolution: "superseded",
                  resolutionSelectedId: chosenPre?.id ?? null,
                },
              ];
        // Rows of the group closed by EARLIER decisions stamp
        // identically on both sides of the comparison.
        const stampExpected = stampOf(expectedPostVersion, expectedPostLive, [
          ...rowsNow.filter((row) => row.resolvedAt !== null),
          ...expectedPostArchived,
        ]);
        // The pre-decision stamp of this attempt, for telling a
        // genuine batch failure (state untouched → retryable) from
        // a race the batch itself rejected (state moved → stale).
        const stampPre = stampOf(boundVersion, live, rowsNow);
        const marker = -(decisionAttempt + 1);
        const statements: BatchItem<"sqlite">[] = [];
        // (1) The atomic claim, FIRST in the batch: stamp every
        // still-unresolved row of the group with this decision's
        // marker, conditioned — evaluated when the statement
        // executes, inside the batch — on the plan version token
        // still equalling the bound version (or still being absent,
        // when the bound version was absent). Any save or rival
        // decision that landed after the pre-read bumped the token,
        // so the claim then stamps ZERO rows and the decision below
        // is rolled back instead of applied to an unseen version.
        const versionGuard =
          boundVersion === null
            ? sql`NOT EXISTS (SELECT 1 FROM plan_meta WHERE key = ${PLAN_META_VERSION_KEY})`
            : sql`EXISTS (SELECT 1 FROM plan_meta WHERE key = ${PLAN_META_VERSION_KEY} AND value = ${boundVersion})`;
        statements.push(
          db
            .update(schema.planExerciseConflicts)
            .set({ resolutionSelectedId: marker })
            .where(
              and(
                eq(schema.planExerciseConflicts.routine, args.routine),
                eq(schema.planExerciseConflicts.exerciseKey, args.exercise_key),
                isNull(schema.planExerciseConflicts.resolvedAt),
                isNull(schema.planExerciseConflicts.resolutionSelectedId),
                versionGuard,
              ),
            )
            .returning({ id: schema.planExerciseConflicts.id }),
        );

        // Every decision statement below is guarded on this claim
        // marker still being present (for updates: on the target row
        // itself carrying the marker; for inserts/deletes: on a
        // marker row existing in the group). When the claim stamped
        // zero rows, each decision statement therefore writes ZERO
        // rows too — a lost race can never apply its decision to a
        // state it did not bind, and never has to be "undone" off
        // another decision's rows.
        const claimExists = () =>
          sql`EXISTS (SELECT 1 FROM plan_exercise_conflicts WHERE routine = ${args.routine} AND exercise_key = ${args.exercise_key} AND resolution_selected_id = ${marker})`;

        // (2) The claim-guarded version advance, in the SAME batch,
        // immediately after the claim: it fires only while this
        // decision's claim marker exists — i.e. only when the claim
        // above actually stamped the still-unresolved rows. With a
        // non-null bound version it additionally requires the token
        // to still equal that version; with a null bound version
        // (no token row at display time) it inserts '1' only while
        // the claim marker exists AND the token row is still
        // absent. A claim that stamped zero rows therefore leaves
        // the version untouched: the whole batch writes zero rows
        // and there is NOTHING to compensate afterwards. On a
        // landed claim the token advances by exactly 1, atomically
        // with the decision statements below.
        if (boundVersion === null) {
          statements.push(
            db.run(sql`
              INSERT INTO plan_meta (key, value)
              SELECT ${PLAN_META_VERSION_KEY}, '1'
              WHERE ${claimExists()}
                AND NOT EXISTS (SELECT 1 FROM plan_meta WHERE key = ${PLAN_META_VERSION_KEY})
            `),
          );
        } else {
          statements.push(
            db.run(sql`
              UPDATE plan_meta
              SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
              WHERE key = ${PLAN_META_VERSION_KEY} AND value = ${boundVersion}
                AND ${claimExists()}
            `),
          );
        }

        if (args.selected_archive_id === null) {
          if (!live) {
            return { ok: false, forbidden: false, error: "当前显示的这一份已不在计划中，请从归档副本里选一份恢复" };
          }
          statements.push(
            db
              .update(schema.planExerciseConflicts)
              .set({ resolvedAt: now, resolution: "superseded", resolutionSelectedId: live.id })
              .where(eq(schema.planExerciseConflicts.resolutionSelectedId, marker)),
          );
        } else {
          const chosen = unresolvedNow.find((row) => row.id === args.selected_archive_id);
          if (!chosen) {
            return { ok: false, forbidden: false, error: "所选的归档副本不存在或已经确认过" };
          }
          if (live) {
            statements.push(
              db.run(sql`
                INSERT INTO plan_exercise_conflicts (id, routine, sort_order, exercise_key, exercise_name, sets, target_reps, archived_note, archived_at, resolved_at, resolution, resolution_selected_id)
                SELECT ${live.id}, ${live.routine}, ${live.sortOrder}, ${live.exerciseKey}, ${live.exerciseName}, ${live.sets}, ${live.targetReps},
                  ${"live plan row displaced by the owner's conflict resolution (an archived copy was selected); archived already resolved"},
                  ${now.getTime()}, ${now.getTime()}, ${"superseded"}, ${chosen.id}
                WHERE ${claimExists()}
              `),
              db
                .delete(schema.planExercises)
                .where(and(eq(schema.planExercises.id, live.id), claimExists())),
            );
          }
          statements.push(
            db.run(sql`
              INSERT INTO plan_exercises (id, routine, sort_order, exercise_key, exercise_name, sets, target_reps)
              SELECT ${chosen.id}, ${chosen.routine}, ${chosen.sortOrder}, ${chosen.exerciseKey}, ${chosen.exerciseName}, ${chosen.sets}, ${chosen.targetReps}
              WHERE ${claimExists()}
            `),
            db
              .update(schema.planExerciseConflicts)
              .set({ resolvedAt: now, resolution: "selected", resolutionSelectedId: chosen.id })
              .where(
                and(
                  eq(schema.planExerciseConflicts.id, chosen.id),
                  eq(schema.planExerciseConflicts.resolutionSelectedId, marker),
                ),
              ),
          );
          const others = unresolvedNow.filter((row) => row.id !== chosen.id);
          if (others.length > 0) {
            statements.push(
              db
                .update(schema.planExerciseConflicts)
                .set({ resolvedAt: now, resolution: "superseded", resolutionSelectedId: chosen.id })
                .where(
                  and(
                    inArray(
                      schema.planExerciseConflicts.id,
                      others.map((row) => row.id),
                    ),
                    eq(schema.planExerciseConflicts.resolutionSelectedId, marker),
                  ),
                ),
            );
          }
        }
        // Every branch above pushes the claim, the claim-guarded
        // version advance and at least one decision statement, so
        // the batch is never empty — the tuple shape db.batch
        // requires is guaranteed at runtime.
        const batchItems = statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
        let results: unknown[];
        try {
          results = await db.batch(batchItems);
        } catch {
          // The batch rolled back atomically: nothing of this
          // decision was written. WHY it failed decides the answer:
          // if a rival decision closed the group in the meantime,
          // answer from that recorded decision (already_resolved
          // for an identical repeat, the closed-group error for a
          // different one); if the bound state otherwise moved, the
          // confirmation is stale; only a failure against an
          // untouched state is the plain retryable error.
          const rowsAfter = await groupRows();
          const liveAfter = (await liveRowFor())[0];
          if (rowsAfter.length > 0 && rowsAfter.every((row) => row.resolvedAt !== null)) {
            const verdict = closedGroupVerdict(rowsAfter, liveAfter);
            if (verdict) return verdict;
          }
          const versionAfter = await readPlanVersion(ctx);
          if (stampOf(versionAfter, liveAfter, rowsAfter) !== stampPre) {
            return { ok: false, forbidden: false, error: staleError, outcome: "stale" };
          }
          return { ok: false, forbidden: false, error: "确认失败，冲突与原计划未改动，请重试" };
        }
        const claimRows = results[0] as unknown[];
        const claimCount = Array.isArray(claimRows) ? claimRows.length : 0;
        if (claimCount === 0) {
          // The claim stamped nothing: the bound state had already
          // moved (a save or a rival decision bumped the version
          // token first). Every decision statement AND the version
          // advance were guarded on the claim marker, so this batch
          // wrote ZERO rows — no version change, no decision write,
          // and NO compensation write afterwards (a cross-transaction
          // −1 here was the ABA hazard: a concurrent getPlan could
          // bracket-read the transient +1 as its versionBefore, watch
          // a real save land, and then see the −1 restore the token
          // to versionBefore over the NEW plan). Just loop: the
          // re-read answers the typed verdict (stale /
          // already_resolved / re-decide). Nothing else is touched;
          // in particular a winning decision's rows are never reset
          // by a loser.
          continue;
        }
        // The decision landed. Judge the committed version by
        // re-reading the actual token — never from a statement
        // RETURNING — so the stamp comparison below is against the
        // state the database really holds now.
        const newVersion = await readPlanVersion(ctx);
        const postRows = await groupRows();
        const postLiveRows = await liveRowFor();
        const postLive = postLiveRows[0];
        const committedStamp = stampOf(newVersion, postLive, postRows);
        const claimLanded =
          claimCount === unresolvedNow.length && committedStamp === stampExpected;
        if (claimLanded) {
          ctx.invalidateQueries();
          return { ok: true, forbidden: false, error: null, outcome: "resolved" };
        }
        // The claim landed yet the committed state is not the state
        // this decision derives — an invariant violation that must
        // never be papered over by tearing at rows we no longer
        // understand. Fail loudly instead.
        throw new Error("计划冲突确认出现不一致状态，已停止以避免误改计划");
        // Loop: re-read and either re-decide identically or answer
        // the typed verdict (stale / already_resolved).
      }
      return { ok: false, forbidden: false, error: staleError, outcome: "stale" };
    },
  }),

  toggleDailyItem: defineAction({
    request: z.object({
      date_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      item_key: z.string().min(1),
      done: z.boolean(),
    }),
    response: doneResponse,
    async handler(ctx, args): Promise<z.infer<typeof doneResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true };
      }
      const db = ctx.db<typeof schema>();
      // Upsert the one (date, item) row. The checklist is purely
      // informational — nothing here touches workout state.
      const existing = await db
        .select({ id: schema.dailyCompletions.id })
        .from(schema.dailyCompletions)
        .where(
          and(
            eq(schema.dailyCompletions.dateKey, args.date_key),
            eq(schema.dailyCompletions.itemKey, args.item_key),
          ),
        )
        .limit(1);
      const existingId = existing[0]?.id;
      if (existingId) {
        await db
          .update(schema.dailyCompletions)
          .set({ done: args.done ? 1 : 0, updatedAt: new Date() })
          .where(eq(schema.dailyCompletions.id, existingId));
      } else {
        await db.insert(schema.dailyCompletions).values({
          dateKey: args.date_key,
          itemKey: args.item_key,
          done: args.done ? 1 : 0,
        });
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),
} satisfies ActionsModule;
