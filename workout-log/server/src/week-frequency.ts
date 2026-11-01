// W3.4: per-exercise training frequency over the last 4 COMPLETE
// weeks, for the history / review view. Pure and self-contained
// (no imports, no IO), in the same style as progression-engine.ts
// and action-trends.ts, so validation scripts can evaluate this
// file verbatim and run the real functions over synthetic data.
// The client only renders what this module computes.
//
// Definitions (all judged per (routine, exercise) — sets are NEVER
// compared across different exercises, matching W3.3):
//   - A "complete week" is a Monday-start calendar week (in the
//     America/Los_Angeles frame the week summaries use) that has
//     fully ended. The window is the 4 such weeks immediately
//     before the current week's Monday; the in-progress week is
//     NEVER included, and neither is anything older.
//   - Per exercise and week: completed sets (sets flagged
//     completed inside completed workouts bucketed to that week),
//     recorded sets (all of the exercise's sets in those workouts),
//     sessions (workouts containing the exercise) and frequency
//     (sessions with at least one completed set — the exercise's
//     sessions-per-week that week).
//   - Expected sets come from the CURRENT plan only: the plan
//     template's sets-per-session for the exercise times how often
//     the current weekly schedule places its routine. There is no
//     plan history, so past weeks are judged against today's plan
//     — the UI says so. An exercise absent from the plan (or whose
//     routine the schedule never places) has no expectation (null).
//   - Volume (weight × reps over completed sets with both
//     recorded, converted into the exercise's display unit with
//     LB_TO_KG and 0.5 rounding, exactly like W3.3) and the
//     per-week global tonnage (all exercises, expressed in kg and
//     lb) are WORKLOAD REFERENCE ONLY. No state below ever reads a
//     volume: whether the user progressed is judged by the W3.2
//     progression engine and the W3.3 trends, never by tonnage,
//     and "reduced" is judged on completed SETS alone.
//
// Weekly states （三态 + 两个诚实兜底）, per exercise per week:
//   - "not_trained" （没练）: the current plan expects the exercise
//     that week (expected sets > 0) but there is no completed set —
//     or the week holds a record of the exercise with 0 completed
//     sets. Planned, but not done.
//   - "no_record" （没记录）: no plan expectation AND no record of
//     the exercise that week — there is nothing to judge from.
//   - "reduced" （主动减量，推测）: the week HAS completed sets, but
//     the count is at most DELOAD_MAX_RATIO of the exercise's
//     personal baseline (the median completed-set count of the
//     OTHER window weeks with a record, requiring at least
//     BASELINE_MIN_WEEKS such weeks and a baseline of at least
//     DELOAD_MIN_BASELINE_SETS sets). This is labelled a guess in
//     the UI: a low week can equally be a missed log or an off
//     week, and the module never claims to know the intent.
//   - "uncertain" （无法判断）: completed sets exist but fall short
//     of the plan expectation while no usable baseline exists —
//     the data cannot distinguish a deliberate cut from an
//     occasional light week, so no classification is invented.
//   - "trained" （已练）: completed sets exist and none of the
//     above applies.

export const WEEK_FREQUENCY_VERSION = 1;

// The same conversion constant the rest of the server uses
// (asserted equal to the engine's / trends' by validation).
export const LB_TO_KG = 0.45359237;

// "Reduced" thresholds: a week counts as clearly below baseline
// only at or under this share of the baseline, and only against a
// baseline of at least this many sets (tiny counts prove nothing).
export const DELOAD_MAX_RATIO = 0.5;
export const DELOAD_MIN_BASELINE_SETS = 4;
// A baseline needs at least this many OTHER recorded weeks.
export const BASELINE_MIN_WEEKS = 2;

export type WeekFrequencyUnit = "lb" | "kg";

export type WeekFrequencyState = "trained" | "not_trained" | "no_record" | "reduced" | "uncertain";

export type WeekFrequencySet = {
  exerciseKey: string;
  exerciseName: string;
  weight: number | null;
  reps: number | null;
  completed: boolean;
};

// One completed workout, in the shape the dashboard loader passes.
export type WeekFrequencyWorkout = {
  routine: string;
  unit: WeekFrequencyUnit;
  completedAt: string | null;
  sets: WeekFrequencySet[];
};

// One exercise of the CURRENT plan template.
export type WeekFrequencyPlanExercise = {
  routine: string;
  exerciseKey: string;
  exerciseName: string;
  setsPerSession: number;
};

// One row of the CURRENT weekly schedule (dayIndex 0 = Monday …
// 6 = Sunday; routineCode is a routine key or "swim" / "rest").
export type WeekFrequencyScheduleEntry = {
  dayIndex: number;
  routineCode: string;
};

export type WeekFrequencyInput = {
  // The current instant (ISO string). Only fully ended weeks
  // before this instant's week are reported.
  now: string;
  workouts: WeekFrequencyWorkout[];
  planExercises: WeekFrequencyPlanExercise[];
  planSchedule: WeekFrequencyScheduleEntry[];
};

export type WeekFrequencyWeek = {
  weekStart: string;
  weekEnd: string;
  // Global tonnage for the week (every exercise): workload
  // reference only, never an input to any state.
  volumeKg: number;
  volumeLb: number;
};

export type WeekFrequencyCell = {
  weekStart: string;
  completedSets: number;
  recordedSets: number;
  sessions: number;
  frequency: number;
  // Workload reference only (display unit); never judged.
  volume: number;
  expectedSets: number | null;
  baselineSets: number | null;
  state: WeekFrequencyState;
  reason: string;
};

export type WeekFrequencyEntry = {
  routine: string;
  exerciseKey: string;
  exerciseName: string;
  // Display unit: the unit of the most recent in-window session
  // containing the exercise ("lb" when there is none — its volume
  // is then 0 anyway).
  unit: WeekFrequencyUnit;
  setsPerSession: number | null;
  expectedSessionsPerWeek: number | null;
  weeks: WeekFrequencyCell[];
  frequencyVersion: number;
};

export type WeekFrequencyResult = {
  weeks: WeekFrequencyWeek[];
  exercises: WeekFrequencyEntry[];
  frequencyVersion: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const laFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function laDayMs(date: Date): number {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of laFormat.formatToParts(date)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return Date.UTC(year, month - 1, day);
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// UTC-midnight timestamp of the Monday (LA local date) of the week
// containing `date` — the same Monday-start rule summarizeWeekSummaries
// uses in actions.ts.
function weekMondayMs(date: Date): number {
  const dayMs = laDayMs(date);
  const dow = new Date(dayMs).getUTCDay(); // 0 = Sunday
  return dayMs - ((dow + 6) % 7) * DAY_MS;
}

// The 4 complete-week windows for `now`, oldest first. The current
// (in-progress) week is excluded by construction: the newest window
// ends the day before the current week's Monday.
export function weekFrequencyWeeks(now: string): WeekFrequencyWeek[] {
  const nowDate = new Date(now);
  const currentMonday = weekMondayMs(nowDate);
  const weeks: WeekFrequencyWeek[] = [];
  for (let back = 4; back >= 1; back--) {
    const start = currentMonday - back * 7 * DAY_MS;
    weeks.push({ weekStart: formatDate(start), weekEnd: formatDate(start + 6 * DAY_MS), volumeKg: 0, volumeLb: 0 });
  }
  return weeks;
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

// Same conversion as the progression engine / action trends:
// null stays null, same-unit is identity, otherwise LB_TO_KG with
// 0.5 rounding.
export function convertFrequencyWeight(
  weight: number | null,
  from: WeekFrequencyUnit,
  to: WeekFrequencyUnit,
): number | null {
  if (weight == null || from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return roundHalf(converted);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const low = sorted[mid - 1] ?? 0;
  const high = sorted[mid] ?? 0;
  return (low + high) / 2;
}

// The whole state judgement for one (exercise, week) cell. Pure
// set-count logic: volumes are deliberately NOT a parameter, so
// tonnage can never influence a state.
export function classifyWeekCell(input: {
  completedSets: number;
  recordedSets: number;
  expectedSets: number | null;
  baselineSets: number | null;
}): { state: WeekFrequencyState; reason: string } {
  const { completedSets, recordedSets, expectedSets, baselineSets } = input;
  if (completedSets === 0) {
    if (expectedSets != null && expectedSets > 0) {
      return {
        state: "not_trained",
        reason: recordedSets > 0
          ? `按当前计划该周应练 ${expectedSets} 组，该周有记录但完成 0 组`
          : `按当前计划该周应练 ${expectedSets} 组，但没有完成记录`,
      };
    }
    if (recordedSets > 0) {
      return { state: "not_trained", reason: "该周有该动作的记录，但完成组数为 0" };
    }
    return { state: "no_record", reason: "该周既无当前计划安排，也无任何完成记录可依据" };
  }
  const baselineUsable = baselineSets != null && baselineSets >= DELOAD_MIN_BASELINE_SETS;
  if (baselineUsable && baselineSets != null && completedSets <= baselineSets * DELOAD_MAX_RATIO) {
    const pct = Math.round((completedSets / baselineSets) * 100);
    return {
      state: "reduced",
      reason: `完成 ${completedSets} 组，仅为其余周基线 ${baselineSets} 组的 ${pct}%，明显偏低——推测为主动减量，也可能是漏记或状态原因，无法确知`,
    };
  }
  if (expectedSets != null && expectedSets > 0 && completedSets < expectedSets && !baselineUsable) {
    return {
      state: "uncertain",
      reason: `完成了 ${completedSets} 组，低于当前计划的 ${expectedSets} 组；其余周可比记录不足，无法判断是主动减量还是偶尔少练`,
    };
  }
  return { state: "trained", reason: `完成 ${completedSets} 组` };
}

export function buildWeekFrequency(input: WeekFrequencyInput): WeekFrequencyResult {
  const weeks = weekFrequencyWeeks(input.now);
  const weekIndexByMonday = new Map<number, number>();
  weeks.forEach((week, index) => {
    const [y = 1970, m = 1, d = 1] = week.weekStart.split("-").map(Number);
    weekIndexByMonday.set(Date.UTC(y, m - 1, d), index);
  });

  // Bucket workouts into the window; anything in the current week,
  // older than the window, or without a valid completion time is
  // ignored entirely (it creates no exercise and no record).
  type Bucketed = { workout: WeekFrequencyWorkout; weekIndex: number };
  const bucketed: Bucketed[] = [];
  for (const workout of input.workouts) {
    if (!workout.completedAt) continue;
    const completedDate = new Date(workout.completedAt);
    if (Number.isNaN(completedDate.getTime())) continue;
    const weekIndex = weekIndexByMonday.get(weekMondayMs(completedDate));
    if (weekIndex == null) continue;
    bucketed.push({ workout, weekIndex });
  }
  // Most recent first, so display-unit / name selection below reads
  // the newest record first (same convention as W3.3).
  bucketed.sort((a, b) => {
    const at = new Date(a.workout.completedAt ?? "").getTime();
    const bt = new Date(b.workout.completedAt ?? "").getTime();
    return bt - at;
  });

  // Global per-week tonnage (reference only): every completed set
  // with weight and reps, converted into kg / lb WITHOUT the 0.5
  // display rounding, summed raw and rounded once at the end.
  const rawKg = weeks.map(() => 0);
  for (const { workout, weekIndex } of bucketed) {
    for (const set of workout.sets) {
      if (!set.completed) continue;
      if (set.weight == null || set.reps == null) continue;
      const kg = workout.unit === "kg" ? set.weight : set.weight * LB_TO_KG;
      const acc = rawKg[weekIndex] ?? 0;
      rawKg[weekIndex] = acc + kg * set.reps;
    }
  }
  weeks.forEach((week, index) => {
    const kg = rawKg[index] ?? 0;
    week.volumeKg = Math.round(kg * 10) / 10;
    week.volumeLb = Math.round((kg / LB_TO_KG) * 10) / 10;
  });

  // Expected sessions per routine from the current schedule.
  const sessionsByRoutine = new Map<string, number>();
  for (const entry of input.planSchedule) {
    sessionsByRoutine.set(entry.routineCode, (sessionsByRoutine.get(entry.routineCode) ?? 0) + 1);
  }
  const planByKey = new Map<string, WeekFrequencyPlanExercise>();
  for (const exercise of input.planExercises) {
    const key = `${exercise.routine} ${exercise.exerciseKey}`;
    if (!planByKey.has(key)) planByKey.set(key, exercise);
  }

  // Per-(routine, exercise) accumulation over the window.
  type Acc = {
    routine: string;
    exerciseKey: string;
    exerciseName: string;
    unit: WeekFrequencyUnit;
    planIndex: number | null;
    lastMs: number;
    cells: { completedSets: number; recordedSets: number; sessions: number; frequency: number; volume: number }[];
  };
  const byKey = new Map<string, Acc>();
  const order: string[] = [];
  const getAcc = (routine: string, exerciseKey: string, planIndex: number | null): Acc => {
    const key = `${routine} ${exerciseKey}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        routine,
        exerciseKey,
        exerciseName: exerciseKey,
        unit: "lb",
        planIndex,
        lastMs: Number.NEGATIVE_INFINITY,
        cells: weeks.map(() => ({ completedSets: 0, recordedSets: 0, sessions: 0, frequency: 0, volume: 0 })),
      };
      byKey.set(key, acc);
      order.push(key);
    }
    return acc;
  };
  // Plan exercises first, in plan order — they appear even with no
  // record at all, which is exactly what 没练 / 没记录 report.
  input.planExercises.forEach((exercise, index) => {
    const acc = getAcc(exercise.routine, exercise.exerciseKey, index);
    acc.exerciseName = exercise.exerciseName;
  });
  for (const { workout, weekIndex } of bucketed) {
    const groups = new Map<string, WeekFrequencySet[]>();
    for (const set of workout.sets) {
      const list = groups.get(set.exerciseKey) ?? [];
      list.push(set);
      groups.set(set.exerciseKey, list);
    }
    for (const [exerciseKey, sets] of groups) {
      const acc = getAcc(workout.routine, exerciseKey, null);
      const completedMs = new Date(workout.completedAt ?? "").getTime();
      if (completedMs > acc.lastMs) {
        acc.lastMs = completedMs;
        acc.unit = workout.unit;
        const first = sets[0];
        const plan = planByKey.get(`${workout.routine} ${exerciseKey}`);
        if (!plan && first && first.exerciseName) acc.exerciseName = first.exerciseName;
      }
      const cell = acc.cells[weekIndex];
      if (!cell) continue;
      cell.sessions += 1;
      let hasCompleted = false;
      for (const set of sets) {
        cell.recordedSets += 1;
        if (!set.completed) continue;
        hasCompleted = true;
        cell.completedSets += 1;
        if (set.weight == null || set.reps == null) continue;
        const weight = convertFrequencyWeight(set.weight, workout.unit, acc.unit);
        if (weight == null) continue;
        cell.volume += weight * set.reps;
      }
      if (hasCompleted) cell.frequency += 1;
    }
  }

  // Entry order: plan order first, then history-only exercises by
  // most recent in-window session (newest first).
  const planOrdered = order.filter((key) => (byKey.get(key)?.planIndex ?? null) != null);
  planOrdered.sort((a, b) => (byKey.get(a)?.planIndex ?? 0) - (byKey.get(b)?.planIndex ?? 0));
  const historyOrdered = order.filter((key) => (byKey.get(key)?.planIndex ?? null) == null);
  historyOrdered.sort((a, b) => (byKey.get(b)?.lastMs ?? 0) - (byKey.get(a)?.lastMs ?? 0));

  const exercises: WeekFrequencyEntry[] = [];
  for (const key of [...planOrdered, ...historyOrdered]) {
    const acc = byKey.get(key);
    if (!acc) continue;
    const plan = planByKey.get(key) ?? null;
    const expectedSessions = plan ? (sessionsByRoutine.get(plan.routine) ?? 0) : null;
    const expectedSets = plan && expectedSessions != null ? plan.setsPerSession * expectedSessions : null;
    // Baselines: per week, the median completed-set count of the
    // OTHER weeks that hold a record (completed sets > 0); null
    // when fewer than BASELINE_MIN_WEEKS such weeks exist.
    const baselines: (number | null)[] = [];
    for (let index = 0; index < acc.cells.length; index++) {
      const others = acc.cells
        .filter((other, otherIndex) => otherIndex !== index && other.completedSets > 0)
        .map((other) => other.completedSets);
      baselines.push(others.length >= BASELINE_MIN_WEEKS ? median(others) : null);
    }
    const cells: WeekFrequencyCell[] = acc.cells.map((cell, index) => {
      const week = weeks[index];
      const baselineSets = baselines[index] ?? null;
      const { state, reason } = classifyWeekCell({
        completedSets: cell.completedSets,
        recordedSets: cell.recordedSets,
        expectedSets,
        baselineSets,
      });
      return {
        weekStart: week ? week.weekStart : "",
        completedSets: cell.completedSets,
        recordedSets: cell.recordedSets,
        sessions: cell.sessions,
        frequency: cell.frequency,
        volume: cell.volume,
        expectedSets,
        baselineSets,
        state,
        reason,
      };
    });
    exercises.push({
      routine: acc.routine,
      exerciseKey: acc.exerciseKey,
      exerciseName: acc.exerciseName,
      unit: acc.unit,
      setsPerSession: plan ? plan.setsPerSession : null,
      expectedSessionsPerWeek: expectedSessions,
      weeks: cells,
      frequencyVersion: WEEK_FREQUENCY_VERSION,
    });
  }

  return { weeks, exercises, frequencyVersion: WEEK_FREQUENCY_VERSION };
}
