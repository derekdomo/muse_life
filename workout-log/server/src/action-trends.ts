// W3.3: per-exercise ("action-level") training trends for the
// history page. Pure and self-contained (no imports, no IO), in the
// same style as progression-engine.ts, so validation scripts can
// evaluate this file verbatim and run the real functions over
// synthetic data. The client only renders what this module computes.
//
// Definitions (all judged per exercise — sets are NEVER compared
// across different exercises):
//   - planned sets: every recorded set of the exercise inside
//     completed workouts; completed sets: those flagged completed.
//     Completion rate = completed / planned (two decimals), null
//     when there are no planned sets.
//   - total reps: reps summed over completed sets that recorded
//     reps (a completed set without reps contributes its completion
//     but no reps, exactly like the week summaries treat
//     unmeasured sets).
//   - volume: weight × reps summed over completed sets with BOTH
//     recorded, in the display unit. Sets from a session recorded
//     in the other unit are converted FIRST (LB_TO_KG, 0.5
//     rounding — the server's long-standing convertEngineWeight
//     convention), so a volume or a "best" is never a mix of raw
//     lb and raw kg numbers.
//   - best set: the completed set with the highest weight × reps
//     among sets with a real positive weight and recorded reps.
//     Bodyweight sets (weight 0 / null) can never be a "best set".
// Estimated 1RM (Epley, 1985): 1RM = weight × (1 + reps / 30),
// computed ONLY over eligible sets — completed, weight > 0, and
// reps an integer in 1..12 — after unit conversion into the
// display unit. Bodyweight (0 / null weight), missing-weight,
// missing-reps, >12-rep and uncompleted sets NEVER participate,
// so no fake PR is generated from them. The best (highest)
// eligible estimate wins; its source set is carried so the UI can
// show what the estimate derives from.

export const ACTION_TRENDS_VERSION = 1;

// The same conversion constant the rest of the server uses
// (asserted equal to the server's and the engine's by validation).
export const LB_TO_KG = 0.45359237;

export type ActionTrendUnit = "lb" | "kg";

export type ActionTrendSet = {
  exerciseKey: string;
  exerciseName: string;
  weight: number | null;
  reps: number | null;
  completed: boolean;
};

// One completed workout, in the shape the dashboard loader passes.
// Callers pass workouts most recent first.
export type ActionTrendWorkout = {
  routine: string;
  unit: ActionTrendUnit;
  completedAt: string | null;
  sets: ActionTrendSet[];
};

export type ActionTrendBestSet = {
  weight: number;
  reps: number;
  volume: number;
  date: string | null;
};

export type ActionTrendOneRepMax = {
  value: number;
  weight: number;
  reps: number;
  date: string | null;
};

export type ActionTrend = {
  routine: string;
  exerciseKey: string;
  exerciseName: string;
  // Display unit: the unit of the most recent session containing
  // the exercise. Every weight-derived figure below is expressed
  // in this unit (converted where the source session differed).
  unit: ActionTrendUnit;
  plannedSets: number;
  completedSets: number;
  completionRate: number | null;
  totalReps: number;
  volume: number;
  bestSet: ActionTrendBestSet | null;
  estimatedOneRepMax: ActionTrendOneRepMax | null;
  sessionCount: number;
  lastDate: string | null;
  trendsVersion: number;
};

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

// Same conversion as the progression engine's convertEngineWeight:
// null stays null, same-unit is identity, otherwise LB_TO_KG with
// 0.5 rounding.
export function convertTrendWeight(
  weight: number | null,
  from: ActionTrendUnit,
  to: ActionTrendUnit,
): number | null {
  if (weight == null || from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return roundHalf(converted);
}

// Epley (1985) estimated one-rep max for ONE set, or null when the
// set is not eligible: weight must be a real positive number and
// reps an integer in 1..12. The caller converts the weight into
// the display unit first; this function never sees raw mixed-unit
// input. The result is rounded to the 0.5 grid the app displays
// weights on.
export function estimateOneRepMaxEpley(weight: number | null, reps: number | null): number | null {
  if (weight == null || weight <= 0) return null;
  if (reps == null || !Number.isInteger(reps) || reps < 1 || reps > 12) return null;
  return roundHalf(weight * (1 + reps / 30));
}

export function buildActionTrends(workouts: ActionTrendWorkout[]): ActionTrend[] {
  type Acc = {
    routine: string;
    exerciseKey: string;
    exerciseName: string;
    unit: ActionTrendUnit;
    plannedSets: number;
    completedSets: number;
    totalReps: number;
    volume: number;
    bestSet: ActionTrendBestSet | null;
    estimatedOneRepMax: ActionTrendOneRepMax | null;
    sessionCount: number;
    lastDate: string | null;
  };
  const byKey = new Map<string, Acc>();
  const order: string[] = [];
  for (const workout of workouts) {
    // Group this workout's sets per exercise, preserving set order.
    const groups = new Map<string, ActionTrendSet[]>();
    for (const set of workout.sets) {
      const list = groups.get(set.exerciseKey) ?? [];
      list.push(set);
      groups.set(set.exerciseKey, list);
    }
    for (const [exerciseKey, sets] of groups) {
      let acc = byKey.get(exerciseKey);
      if (!acc) {
        const first = sets[0];
        if (!first) continue;
        acc = {
          routine: workout.routine,
          exerciseKey,
          exerciseName: first.exerciseName,
          unit: workout.unit,
          plannedSets: 0,
          completedSets: 0,
          totalReps: 0,
          volume: 0,
          bestSet: null,
          estimatedOneRepMax: null,
          sessionCount: 0,
          lastDate: workout.completedAt,
        };
        byKey.set(exerciseKey, acc);
        order.push(exerciseKey);
      }
      acc.sessionCount += 1;
      acc.plannedSets += sets.length;
      for (const set of sets) {
        if (!set.completed) continue;
        acc.completedSets += 1;
        if (set.reps != null) acc.totalReps += set.reps;
        if (set.weight == null || set.reps == null) continue;
        const weight = convertTrendWeight(set.weight, workout.unit, acc.unit);
        if (weight == null) continue;
        acc.volume += weight * set.reps;
        // Best set and 1RM only ever consider real positive loads:
        // a recorded 0 is bodyweight, never a comparable load.
        if (weight > 0) {
          const setVolume = weight * set.reps;
          if (acc.bestSet == null || setVolume > acc.bestSet.volume) {
            acc.bestSet = { weight, reps: set.reps, volume: setVolume, date: workout.completedAt };
          }
          const estimate = estimateOneRepMaxEpley(weight, set.reps);
          if (estimate != null && (acc.estimatedOneRepMax == null || estimate > acc.estimatedOneRepMax.value)) {
            acc.estimatedOneRepMax = { value: estimate, weight, reps: set.reps, date: workout.completedAt };
          }
        }
      }
    }
  }
  return order.map((key) => {
    const acc = byKey.get(key);
    if (!acc) throw new Error(`action trend accumulator missing for ${key}`);
    return {
      routine: acc.routine,
      exerciseKey: acc.exerciseKey,
      exerciseName: acc.exerciseName,
      unit: acc.unit,
      plannedSets: acc.plannedSets,
      completedSets: acc.completedSets,
      completionRate: acc.plannedSets > 0
        ? Math.round((acc.completedSets / acc.plannedSets) * 100) / 100
        : null,
      totalReps: acc.totalReps,
      volume: acc.volume,
      bestSet: acc.bestSet,
      estimatedOneRepMax: acc.estimatedOneRepMax,
      sessionCount: acc.sessionCount,
      lastDate: acc.lastDate,
      trendsVersion: ACTION_TRENDS_VERSION,
    };
  });
}
