// W6.1: planned weekly muscle-group coverage of the CURRENT plan
// templates — the plan-level counterpart of W5.1's history heatmap.
// Borrowed design idea (information architecture only, no code) from
// OpenGym (github.com/DuarteSantos8/openGym, AGPL-3.0): its muscle
// map has a mode for "what has gone untrained" (README, Features →
// Progress: "A muscle map in three modes: where your volume went,
// what is still recovering, and what has gone untrained"). Applied
// here to the PLAN instead of history: for each muscle group, how
// many sets per week the current templates + weekly schedule plan
// for it, and which groups the plan does not cover at all.
//
// Pure and self-contained (no imports, no IO), in the same style as
// muscle-heatmap.ts / week-frequency.ts, so validation scripts can
// evaluate this file verbatim and run the real functions over
// synthetic data. The client only renders what this module computes.
//
// Definitions (facts about the plan only — this module reads NO
// workout history, computes NO recovery / fatigue / detraining
// judgement, and never changes a plan, a template or a weight):
//   - Weekly sessions per routine come from the caller's count of
//     the plan_schedule rows (how many weekdays carry each routine
//     code). A routine the schedule never places contributes 0.
//   - An exercise's planned weekly sets = its template set count ×
//     its routine's weekly sessions. Those sets count under EACH of
//     its muscle groups — under its primary groups as planned
//     primary sets and under its secondary (synergist, 协同） groups
//     as planned secondary sets — the same duplicate-attribution
//     rule as W5.1 / the completion receipt, so per-group planned
//     sets must never be summed into a whole-body total.
//   - Coverage state per group: "primary" when planned primary
//     sets > 0; "secondary_only" when only synergist sets are
//     planned; "none" when the plan plans nothing for the group.
//     The state is a restatement of the counts, not a score.
//   - The exercise -> muscle-group mapping is PASSED IN by the
//     caller (actions.ts passes the one MUSCLE_MAP from
//     muscle-heatmap.ts — MUSCLE-MAP.md v1, the same map the guide
//     diagram, the receipt and the W5.1 heatmap share). This module
//     carries no second copy of the map, so it can never drift.
//   - An exercise whose key has no mapping is reported once in
//     unmappedExercises （尚无映射） when it contributes planned
//     sets, and never guessed into a group. An exercise in a
//     routine the schedule never places contributes nothing at
//     all — not even an unmapped line (the W5.1 zero-count rule).

export const PLAN_COVERAGE_VERSION = 1;

export type PlanCoverageState = "primary" | "secondary_only" | "none";

export type PlanCoverageMuscleMapping = { primary: string[]; secondary: string[] };

export type PlanCoverageExerciseInput = {
  routine: string;
  exerciseKey: string;
  exerciseName: string;
  // The template's planned set count for one session of the routine.
  sets: number;
};

export type PlanCoverageInput = {
  exercises: PlanCoverageExerciseInput[];
  // Routine code -> how many times per week the current schedule
  // places it. Missing / non-positive / non-finite counts as 0.
  weeklySessions: Record<string, number>;
  // The one shared exercise -> muscle-group map (MUSCLE-MAP.md v1),
  // passed in — never duplicated here.
  muscleMap: Record<string, PlanCoverageMuscleMapping>;
  // Display order for the report: exactly these groups are always
  // reported (a group with nothing planned is a fact too), followed
  // by any further group the map names, in first-seen order.
  muscleGroups: string[];
};

export type PlanCoverageEntry = {
  muscle: string;
  // Planned sets per week attributed to this group as a PRIMARY
  // group of their exercise (template sets × weekly sessions).
  plannedPrimarySets: number;
  // Planned sets per week attributed as a SECONDARY (synergist)
  // group. Duplicate attribution applies across groups, never
  // within one entry.
  plannedSecondarySets: number;
  // plannedPrimarySets + plannedSecondarySets.
  plannedTotalSets: number;
  state: PlanCoverageState;
  // Names of the exercises contributing planned primary sets to
  // this group, first-seen order, each name once.
  primaryExercises: string[];
  // Names of the exercises contributing planned secondary sets.
  secondaryExercises: string[];
};

export type PlanCoverageResult = {
  muscles: PlanCoverageEntry[];
  // Display names of contributing exercises whose key has no
  // mapping — first-seen order, each name once. Never guessed.
  unmappedExercises: string[];
  // How many reported groups the plan plans nothing for
  // (state "none") — a restatement of the entries, not a score.
  uncoveredCount: number;
  coverageVersion: number;
};

function weeklyCount(raw: number | undefined): number {
  return raw != null && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function plannedSets(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function buildPlanCoverage(input: PlanCoverageInput): PlanCoverageResult {
  // Report order: the caller's list first, then any group named by
  // the map but missing from the list, in first-seen order — a map
  // edit can never silently drop a group from the report.
  const order: string[] = [];
  for (const muscle of input.muscleGroups) {
    if (!order.includes(muscle)) order.push(muscle);
  }
  for (const mapping of Object.values(input.muscleMap)) {
    for (const muscle of [...mapping.primary, ...mapping.secondary]) {
      if (!order.includes(muscle)) order.push(muscle);
    }
  }

  type Acc = {
    primarySets: number;
    secondarySets: number;
    primaryExercises: string[];
    secondaryExercises: string[];
  };
  const byMuscle = new Map<string, Acc>();
  for (const muscle of order) {
    byMuscle.set(muscle, { primarySets: 0, secondarySets: 0, primaryExercises: [], secondaryExercises: [] });
  }
  const unmappedExercises: string[] = [];

  for (const exercise of input.exercises) {
    const sessions = weeklyCount(input.weeklySessions[exercise.routine]);
    const contribution = plannedSets(exercise.sets) * sessions;
    // Zero contribution (unscheduled routine or a non-positive set
    // count): the exercise contributes nothing at all — no group
    // counts, no exercise names, not even an unmapped line.
    if (contribution <= 0) continue;
    const mapping = input.muscleMap[exercise.exerciseKey];
    if (!mapping) {
      if (!unmappedExercises.includes(exercise.exerciseName)) {
        unmappedExercises.push(exercise.exerciseName);
      }
      continue;
    }
    for (const muscle of mapping.primary) {
      const acc = byMuscle.get(muscle);
      if (!acc) continue;
      acc.primarySets += contribution;
      if (!acc.primaryExercises.includes(exercise.exerciseName)) {
        acc.primaryExercises.push(exercise.exerciseName);
      }
    }
    for (const muscle of mapping.secondary) {
      const acc = byMuscle.get(muscle);
      if (!acc) continue;
      acc.secondarySets += contribution;
      if (!acc.secondaryExercises.includes(exercise.exerciseName)) {
        acc.secondaryExercises.push(exercise.exerciseName);
      }
    }
  }

  const muscles: PlanCoverageEntry[] = order.map((muscle) => {
    const acc = byMuscle.get(muscle) ?? {
      primarySets: 0,
      secondarySets: 0,
      primaryExercises: [],
      secondaryExercises: [],
    };
    const plannedTotalSets = acc.primarySets + acc.secondarySets;
    const state: PlanCoverageState = acc.primarySets > 0
      ? "primary"
      : acc.secondarySets > 0
        ? "secondary_only"
        : "none";
    return {
      muscle,
      plannedPrimarySets: acc.primarySets,
      plannedSecondarySets: acc.secondarySets,
      plannedTotalSets,
      state,
      primaryExercises: acc.primaryExercises,
      secondaryExercises: acc.secondaryExercises,
    };
  });

  return {
    muscles,
    unmappedExercises,
    uncoveredCount: muscles.filter((entry) => entry.state === "none").length,
    coverageVersion: PLAN_COVERAGE_VERSION,
  };
}
