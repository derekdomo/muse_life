// W5.1: per-muscle-group set counts over the last 7 days plus the
// days since each group was last trained — the facts behind the
// history view's 肌群恢复热力图 (muscle "recovery" heatmap). Pure
// and self-contained (no imports, no IO), in the same style as
// action-trends.ts and week-frequency.ts, so validation scripts
// can evaluate this file verbatim and run the real functions over
// synthetic data. The client only renders what this module
// computes.
//
// The exercise -> muscle-group mapping below is the SAME map the
// rest of the artifact already uses (MUSCLE-MAP.md map_version 1):
// identical to the client's MUSCLE_MAP in client/src/App.tsx, which
// also drives the exercise guide's muscle diagram
// (client/src/MuscleDiagram.tsx paints from it) and the completion
// receipt's muscle facts. It is duplicated here ONLY because this
// module must stay import-free for verbatim validation;
// validate-muscle-heatmap.mjs asserts the two copies are
// entry-for-entry identical, so they can never silently drift into
// a second, different mapping.
//
// Definitions (facts only — this module computes NO recovery
// percentage and NO recovery score; nothing here judges how
// "recovered" a muscle is):
//   - Window: the last 7 calendar days in the America/Los_Angeles
//     frame the rest of the dashboard uses — today and the 6 days
//     before it, by natural (calendar) day. A workout belongs to
//     the calendar day it was completed on (LA date).
//   - Set counts: COMPLETED sets only, inside completed workouts.
//     An uncompleted set never counts, and an exercise with zero
//     completed sets in a workout contributes nothing at all — not
//     even an unmapped line (the receipt's rule).
//   - Attribution: an exercise's completed sets count under EACH
//     of its muscle groups — under its primary groups as primary
//     sets and under its secondary (synergist, 协同） groups as
//     secondary sets — the same duplicate-attribution rule as the
//     completion receipt's muscle facts (H4.6). Per-group counts
//     must therefore never be summed into a whole-body total.
//   - daysSinceLastTrained: whole calendar days between the
//     group's most recent training day and today. The most recent
//     day is judged over EVERY completed workout the caller
//     passes (the dashboard loader passes the full completed
//     history, not just the window), counting a day whenever the
//     group received at least one completed set as primary OR
//     secondary. Null when the group has never been trained in
//     the records passed; a group trained today reports 0.
//   - An exercise whose key has no mapping is reported once in
//     unmappedExercises （尚无映射） and never guessed into a
//     group.

export const MUSCLE_HEATMAP_VERSION = 1;

// The mapping's own version (MUSCLE-MAP.md map_version). Asserted
// equal to the client's MUSCLE_MAP_VERSION by validation.
export const MUSCLE_MAP_VERSION = 1;

export type MuscleMapping = { primary: string[]; secondary: string[] };

// Verbatim copy of the client's MUSCLE_MAP (MUSCLE-MAP.md v1, all
// 31 stable exercise_keys incl. lateral-lunge). An unknown/custom
// key is explicitly unmapped — never guessed from a similar name.
export const MUSCLE_MAP: Record<string, MuscleMapping> = {
  "barbell-bench": { primary: ["胸"], secondary: ["肱三头肌", "肩前束"] },
  "overhead-press": { primary: ["肩前束", "肩中束"], secondary: ["肱三头肌", "核心"] },
  "incline-dumbbell-press": { primary: ["胸"], secondary: ["肩前束", "肱三头肌"] },
  dips: { primary: ["胸", "肱三头肌"], secondary: ["肩前束"] },
  "lateral-raise": { primary: ["肩中束"], secondary: ["斜方肌"] },
  "push-up-plus": { primary: ["前锯肌"], secondary: ["胸", "核心"] },
  "wide-lat-pulldown": { primary: ["背阔肌"], secondary: ["肱二头肌", "肩后束"] },
  "close-lat-pulldown": { primary: ["背阔肌"], secondary: ["肱二头肌"] },
  "close-seated-row": { primary: ["背阔肌", "菱形肌"], secondary: ["肱二头肌", "斜方肌"] },
  "wide-seated-row": { primary: ["菱形肌", "肩后束"], secondary: ["背阔肌", "斜方肌"] },
  "face-pull": { primary: ["肩后束"], secondary: ["斜方肌", "菱形肌"] },
  "reverse-pec-deck": { primary: ["肩后束"], secondary: ["斜方肌"] },
  "rope-curl": { primary: ["肱二头肌"], secondary: [] },
  "back-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["核心", "腘绳肌"] },
  "romanian-deadlift": { primary: ["腘绳肌", "臀大肌"], secondary: ["斜方肌", "核心"] },
  "bulgarian-split-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿", "核心"] },
  "lying-leg-curl": { primary: ["腘绳肌"], secondary: ["小腿"] },
  "calf-raise": { primary: ["小腿"], secondary: [] },
  "tibialis-raise": { primary: ["胫骨前肌"], secondary: [] },
  "supine-chin-tuck": { primary: ["颈深屈肌"], secondary: [] },
  "prone-ytw": { primary: ["斜方肌", "肩后束"], secondary: ["菱形肌", "胸椎伸展肌群"] },
  "side-external-rotation": { primary: ["肩后束"], secondary: [] },
  "thoracic-extension": { primary: ["胸椎伸展肌群"], secondary: [] },
  "single-leg-balance": { primary: ["小腿", "臀大肌"], secondary: ["核心"] },
  "home-bulgarian-split-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿", "核心"] },
  "bench-step-up": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿"] },
  "lateral-lunge": { primary: ["股四头肌", "臀大肌"], secondary: ["核心"] },
  "home-calf-raise": { primary: ["小腿"], secondary: [] },
  "wall-sit": { primary: ["股四头肌"], secondary: ["臀大肌"] },
  "dead-bug": { primary: ["核心"], secondary: [] },
  "side-plank": { primary: ["腹斜肌", "核心"], secondary: ["臀大肌"] },
};

// Every muscle group named anywhere in MUSCLE_MAP, in display
// order (front of body to back, top to bottom, then legs). The
// heatmap always reports exactly this list — a group with no
// training is a fact too (0 sets, never trained), never omitted.
// Validation asserts this list equals the union of the map's
// primary/secondary names, so a future map edit cannot silently
// drop a group from the heatmap.
export const MUSCLE_GROUPS: string[] = [
  "胸",
  "肩前束",
  "肩中束",
  "肩后束",
  "肱二头肌",
  "肱三头肌",
  "前锯肌",
  "背阔肌",
  "斜方肌",
  "菱形肌",
  "胸椎伸展肌群",
  "核心",
  "腹斜肌",
  "颈深屈肌",
  "股四头肌",
  "臀大肌",
  "腘绳肌",
  "小腿",
  "胫骨前肌",
];

export type MuscleHeatmapSet = {
  exerciseKey: string;
  exerciseName: string;
  completed: boolean;
};

// One completed workout, in the shape the dashboard loader passes.
// completedAt is the workout's completion instant (ISO string);
// workouts with a null completedAt are ignored entirely.
export type MuscleHeatmapWorkout = {
  completedAt: string | null;
  sets: MuscleHeatmapSet[];
};

export type MuscleHeatmapInput = {
  // The current instant (ISO string). The 7-day window and the
  // days-since figures are judged against this instant's LA date.
  now: string;
  workouts: MuscleHeatmapWorkout[];
};

export type MuscleHeatmapEntry = {
  muscle: string;
  // Completed sets inside the 7-day window attributed to this
  // group as a PRIMARY group of their exercise.
  primarySets: number;
  // Completed sets inside the window attributed to this group as
  // a SECONDARY (synergist) group of their exercise.
  secondarySets: number;
  // primarySets + secondarySets. Duplicate attribution applies
  // across groups, never within one entry.
  totalSets: number;
  // LA calendar date (YYYY-MM-DD) of the group's most recent
  // training day over all workouts passed, or null when never.
  lastTrainedDate: string | null;
  // Whole calendar days between lastTrainedDate and today
  // (0 = trained today); null exactly when lastTrainedDate is.
  daysSinceLastTrained: number | null;
  // True when totalSets > 0 — the group was trained inside the
  // 7-day window. A pure restatement of the counts, not a score.
  trainedInWindow: boolean;
};

export type MuscleHeatmapResult = {
  // LA calendar dates (YYYY-MM-DD) bounding the 7-day window,
  // both inclusive: windowEnd is today, windowStart is 6 days
  // earlier.
  windowStart: string;
  windowEnd: string;
  // One entry per MUSCLE_GROUPS member, in MUSCLE_GROUPS order.
  muscles: MuscleHeatmapEntry[];
  // Display names of exercises that had at least one completed
  // set in some passed workout but whose key has no mapping —
  // first-seen order, each name once. Never guessed into a group.
  unmappedExercises: string[];
  heatmapVersion: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const laFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// UTC-midnight timestamp of the LA calendar day containing `date`
// — the same day-bucketing week-frequency.ts uses, so "calendar
// day" means the same thing across the whole dashboard.
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

// The 7-day window for `now` (ISO instant): today (LA date) and
// the 6 calendar days before it, both bounds inclusive.
export function muscleHeatmapWindow(now: string): { windowStart: string; windowEnd: string } {
  const todayMs = laDayMs(new Date(now));
  return { windowStart: formatDate(todayMs - 6 * DAY_MS), windowEnd: formatDate(todayMs) };
}

export function buildMuscleHeatmap(input: MuscleHeatmapInput): MuscleHeatmapResult {
  const todayMs = laDayMs(new Date(input.now));
  const windowStartMs = todayMs - 6 * DAY_MS;

  type Acc = { primarySets: number; secondarySets: number; lastDayMs: number | null };
  const byMuscle = new Map<string, Acc>();
  for (const muscle of MUSCLE_GROUPS) {
    byMuscle.set(muscle, { primarySets: 0, secondarySets: 0, lastDayMs: null });
  }
  const unmappedExercises: string[] = [];

  for (const workout of input.workouts) {
    if (workout.completedAt == null) continue;
    const dayMs = laDayMs(new Date(workout.completedAt));
    const inWindow = dayMs >= windowStartMs && dayMs <= todayMs;
    // Group this workout's sets per exercise, preserving order.
    const groups = new Map<string, MuscleHeatmapSet[]>();
    for (const set of workout.sets) {
      const list = groups.get(set.exerciseKey) ?? [];
      list.push(set);
      groups.set(set.exerciseKey, list);
    }
    for (const [exerciseKey, sets] of groups) {
      const completedCount = sets.filter((set) => set.completed).length;
      // Zero completed sets: the exercise contributes nothing at
      // all — no group counts, no last-trained day, not even an
      // unmapped line.
      if (completedCount === 0) continue;
      const mapping = MUSCLE_MAP[exerciseKey];
      if (!mapping) {
        const name = sets[0]?.exerciseName ?? exerciseKey;
        if (!unmappedExercises.includes(name)) unmappedExercises.push(name);
        continue;
      }
      for (const muscle of mapping.primary) {
        const acc = byMuscle.get(muscle);
        if (!acc) continue;
        if (acc.lastDayMs == null || dayMs > acc.lastDayMs) acc.lastDayMs = dayMs;
        if (inWindow) acc.primarySets += completedCount;
      }
      for (const muscle of mapping.secondary) {
        const acc = byMuscle.get(muscle);
        if (!acc) continue;
        if (acc.lastDayMs == null || dayMs > acc.lastDayMs) acc.lastDayMs = dayMs;
        if (inWindow) acc.secondarySets += completedCount;
      }
    }
  }

  const muscles: MuscleHeatmapEntry[] = MUSCLE_GROUPS.map((muscle) => {
    const acc = byMuscle.get(muscle) ?? { primarySets: 0, secondarySets: 0, lastDayMs: null };
    const totalSets = acc.primarySets + acc.secondarySets;
    return {
      muscle,
      primarySets: acc.primarySets,
      secondarySets: acc.secondarySets,
      totalSets,
      lastTrainedDate: acc.lastDayMs == null ? null : formatDate(acc.lastDayMs),
      // A last-trained day in the future relative to `now` (clock
      // skew between records) clamps to 0 — never a negative count.
      daysSinceLastTrained: acc.lastDayMs == null
        ? null
        : Math.max(0, Math.round((todayMs - acc.lastDayMs) / DAY_MS)),
      trainedInWindow: totalSets > 0,
    };
  });

  return {
    windowStart: formatDate(windowStartMs),
    windowEnd: formatDate(todayMs),
    muscles,
    unmappedExercises,
    heatmapVersion: MUSCLE_HEATMAP_VERSION,
  };
}
