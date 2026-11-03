// H3.4 睡眠/恢复与训练表现的关联探索 (sleep/recovery ↔ training
// performance correlation), a descriptive-only exploration for the
// week review. This module is PURE: it has no imports, performs no
// I/O, and reads no clock — every input arrives as an argument, so
// repo-side validation (validate-sleep-training-correlation.mjs) can
// load it verbatim and run it over synthetic fixtures.
//
// Data caliber: the inputs are the SAME sources every other panel
// reads — the strength workouts the existing training-record sync
// channel (space-6 训练记录 → saveStrengthTrainingSnapshot) already
// stores, the health snapshot's main sleeps reduced by the caller to
// ONE main sleep per wake-up date (the deterministic CWEB-SLEEP-001
// selection, with actual sleep via the totalSleepHours caliber —
// core + deep + REM, the H4.3 sleep caliber), and the day's recovery
// signal from the readiness_history archive. No second data copy and
// no second sync path exist for this exploration.
//
// Definitions (shown verbatim on the panel):
// - A "pair" is one COMPLETED strength workout together with the
//   main sleep of the night before it: the sleep session whose
//   WAKE-UP date equals the workout's calendar date (the night the
//   owner slept before training that day). A workout whose date has
//   no recorded main sleep is UNPAIRED — excluded from every mean
//   and counted in unpairedCount. A missing night is missing: it is
//   never treated as 0 hours slept and never backfilled with another
//   date's session. Active workouts never enter at all.
// - Training performance keeps the EXISTING calibers, unchanged:
//   volume is the workout's stored totalVolume (the sync caliber —
//   sum over completed sets of weight × reps), converted into the
//   display unit with the same 1 lb = 0.45359237 kg factor ACWR
//   uses; duration is the workout's stored durationMinutes. A pair
//   whose duration is unknown still counts for volume; it is
//   excluded from the duration means only and counted in
//   durationMissingPairs (missing is never 0 minutes).
// - The day's recovery signal is the readiness score archived for
//   the workout's own date. A pair with no archived score (or a null
//   score) is excluded from the readiness means only and counted in
//   readinessMissingPairs.
// - Personal sleep baseline: the EXISTING H4.3 sleep-need caliber —
//   the plain mean of actual sleep over the most recent ≤14 recorded
//   nights, available only when at least 8 nights are recorded.
//   Groups are defined against it: a paired night at or above the
//   baseline is the 睡得好组 (good-sleep group); below it is the
//   睡得差组 (poor-sleep group). Without a baseline no grouping is
//   honest, so the groups stay null even past the sample gate.
// - Sample gate (hard): fewer than SLEEP_TRAINING_MIN_PAIRS (6)
//   valid pairs → sufficient: false and EVERY group, mean, and
//   difference is null — the panel shows 样本不足（当前 n/6） and
//   renders no association numbers and no conclusion. At or above
//   the gate the panel shows descriptive group means and the
//   good − poor mean differences only.
// - Honesty: this is observational correlation only. The module
//   emits counts, means, and differences — never a causal claim,
//   never a medical judgement, and it never feeds back into any
//   training plan. Direction is always symbol + word + signed
//   number (▲ 较高 / ▼ 较低 / ● 持平), so meaning never rides on
//   color alone (the owner's color-vision rule).

export const SLEEP_TRAINING_MIN_PAIRS = 6;
export const SLEEP_TRAINING_BASELINE_MAX_NIGHTS = 14;
export const SLEEP_TRAINING_BASELINE_MIN_NIGHTS = 8;

export type SleepTrainingUnit = "lb" | "kg";

export type SleepTrainingGroupKey = "good" | "poor";

export interface SleepTrainingWorkoutInput {
  date: string;
  status: "active" | "completed";
  durationMinutes: number | null;
  totalVolume: number;
  unit: SleepTrainingUnit;
}

export interface SleepTrainingNightInput {
  // Wake-up calendar date (YYYY-MM-DD) of the night's main sleep.
  date: string;
  // Actual sleep that night in hours (core + deep + REM).
  hours: number;
}

export interface SleepTrainingReadinessInput {
  date: string;
  score: number | null;
}

export interface SleepTrainingPair {
  // The workout's calendar date; also the wake-up date of the
  // previous night's main sleep it paired with.
  date: string;
  sleepHours: number;
  // Volume in displayUnit (converted from the workout's own unit).
  volume: number;
  durationMinutes: number | null;
  // The readiness score archived for the workout's date, or null.
  readinessScore: number | null;
  // Group against the personal baseline; null when no baseline
  // exists (the pair still counts toward the sample gate).
  group: SleepTrainingGroupKey | null;
}

export interface SleepTrainingGroupStats {
  pairs: number;
  sleepMeanHours: number | null;
  volumeMean: number | null;
  // Pairs in this group whose duration is recorded.
  durationPairs: number;
  durationMeanMinutes: number | null;
  // Pairs in this group with an archived readiness score.
  readinessPairs: number;
  readinessMean: number | null;
}

export interface SleepTrainingCorrelationResult {
  displayUnit: SleepTrainingUnit;
  threshold: number;
  // Completed workouts with a real date — the pairing candidates.
  totalWorkouts: number;
  // Workouts paired with a valid previous-night main sleep (n).
  pairedCount: number;
  // Completed workouts excluded because the previous night's main
  // sleep is missing (never treated as 0 hours).
  unpairedCount: number;
  // Paired workouts whose duration is unknown (excluded from the
  // duration means only).
  durationMissingPairs: number;
  // Paired workouts with no archived readiness score for their date
  // (excluded from the readiness means only).
  readinessMissingPairs: number;
  // Nights the personal baseline mean was computed over (≤ 14, most
  // recent recorded nights); baselineHours is null below 8 nights.
  baselineNights: number;
  baselineHours: number | null;
  // True only at/above the hard sample gate. When false, every group
  // and difference below is null — no association is presented.
  sufficient: boolean;
  goodGroup: SleepTrainingGroupStats | null;
  poorGroup: SleepTrainingGroupStats | null;
  // Good-group mean − poor-group mean; null whenever either side has
  // no surviving pair for that metric, the gate fails, or no
  // baseline exists — never 0, never invented.
  volumeDiff: number | null;
  durationDiff: number | null;
  readinessDiff: number | null;
  pairs: SleepTrainingPair[];
}

const SLEEP_TRAINING_LB_TO_KG = 0.45359237;

export function convertSleepTrainingVolume(volume: number, fromUnit: SleepTrainingUnit, toUnit: SleepTrainingUnit): number {
  if (fromUnit === toUnit) return volume;
  if (fromUnit === "lb" && toUnit === "kg") return volume * SLEEP_TRAINING_LB_TO_KG;
  return volume / SLEEP_TRAINING_LB_TO_KG;
}

export function sleepTrainingIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function sleepTrainingDirection(diff: number | null): { symbol: string; word: string } {
  if (diff === null) return { symbol: "—", word: "无数据" };
  if (diff > 0) return { symbol: "▲", word: "较高" };
  if (diff < 0) return { symbol: "▼", word: "较低" };
  return { symbol: "●", word: "持平" };
}

function sleepTrainingRound(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function meanOf(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function groupStats(pairs: SleepTrainingPair[]): SleepTrainingGroupStats {
  const durations = pairs.map((pair) => pair.durationMinutes).filter((value): value is number => value !== null);
  const readiness = pairs.map((pair) => pair.readinessScore).filter((value): value is number => value !== null);
  return {
    pairs: pairs.length,
    sleepMeanHours: pairs.length ? sleepTrainingRound(meanOf(pairs.map((pair) => pair.sleepHours)) ?? 0, 2) : null,
    volumeMean: pairs.length ? sleepTrainingRound(meanOf(pairs.map((pair) => pair.volume)) ?? 0) : null,
    durationPairs: durations.length,
    durationMeanMinutes: durations.length ? sleepTrainingRound(meanOf(durations) ?? 0) : null,
    readinessPairs: readiness.length,
    readinessMean: readiness.length ? sleepTrainingRound(meanOf(readiness) ?? 0) : null,
  };
}

export function computeSleepTrainingCorrelation(
  workouts: SleepTrainingWorkoutInput[],
  nights: SleepTrainingNightInput[],
  readiness: SleepTrainingReadinessInput[],
  displayUnit: SleepTrainingUnit,
): SleepTrainingCorrelationResult {
  // One night per wake-up date: if the caller ever passes duplicates,
  // the longest actual sleep wins (the main sleep), deterministically
  // and independent of array order. Unusable rows never enter.
  const nightByDate = new Map<string, number>();
  for (const night of nights) {
    if (!sleepTrainingIsRealDate(night.date)) continue;
    if (!Number.isFinite(night.hours) || night.hours < 0) continue;
    const previous = nightByDate.get(night.date);
    if (previous === undefined || night.hours > previous) nightByDate.set(night.date, night.hours);
  }
  const recordedNights = [...nightByDate.entries()]
    .map(([date, hours]) => ({ date, hours }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Personal baseline — the existing H4.3 caliber: mean actual sleep
  // over the most recent ≤14 recorded nights, gated at ≥8 nights.
  const baselineSlice = recordedNights.slice(-SLEEP_TRAINING_BASELINE_MAX_NIGHTS);
  const baselineRaw = baselineSlice.length >= SLEEP_TRAINING_BASELINE_MIN_NIGHTS
    ? baselineSlice.reduce((sum, night) => sum + night.hours, 0) / baselineSlice.length
    : null;

  const readinessByDate = new Map<string, number | null>();
  for (const row of readiness) {
    if (sleepTrainingIsRealDate(row.date)) {
      readinessByDate.set(row.date, row.score !== null && Number.isFinite(row.score) ? row.score : null);
    }
  }

  // Pairing: each completed workout looks up the main sleep whose
  // wake-up date is the workout's own date — the night before the
  // training day. No such night → unpaired, excluded and counted.
  const completed = workouts.filter(
    (workout) => workout.status === "completed" && sleepTrainingIsRealDate(workout.date) && Number.isFinite(workout.totalVolume) && workout.totalVolume >= 0,
  );
  const pairs: SleepTrainingPair[] = [];
  let unpairedCount = 0;
  for (const workout of completed) {
    const sleepHours = nightByDate.get(workout.date);
    if (sleepHours === undefined) {
      unpairedCount += 1;
      continue;
    }
    pairs.push({
      date: workout.date,
      sleepHours,
      volume: convertSleepTrainingVolume(workout.totalVolume, workout.unit, displayUnit),
      durationMinutes: workout.durationMinutes !== null && Number.isFinite(workout.durationMinutes) && workout.durationMinutes >= 0
        ? workout.durationMinutes
        : null,
      readinessScore: readinessByDate.get(workout.date) ?? null,
      group: baselineRaw === null ? null : sleepHours >= baselineRaw ? "good" : "poor",
    });
  }
  pairs.sort((a, b) => a.date.localeCompare(b.date));

  const pairedCount = pairs.length;
  const durationMissingPairs = pairs.filter((pair) => pair.durationMinutes === null).length;
  const readinessMissingPairs = pairs.filter((pair) => pair.readinessScore === null).length;

  // The hard sample gate: below it, no groups, no means, no
  // differences — the panel shows 样本不足（当前 n/6） only.
  const sufficient = pairedCount >= SLEEP_TRAINING_MIN_PAIRS;

  let goodGroup: SleepTrainingGroupStats | null = null;
  let poorGroup: SleepTrainingGroupStats | null = null;
  let volumeDiff: number | null = null;
  let durationDiff: number | null = null;
  let readinessDiff: number | null = null;
  if (sufficient && baselineRaw !== null) {
    goodGroup = groupStats(pairs.filter((pair) => pair.group === "good"));
    poorGroup = groupStats(pairs.filter((pair) => pair.group === "poor"));
    if (goodGroup.volumeMean !== null && poorGroup.volumeMean !== null) {
      volumeDiff = sleepTrainingRound(goodGroup.volumeMean - poorGroup.volumeMean);
    }
    if (goodGroup.durationMeanMinutes !== null && poorGroup.durationMeanMinutes !== null) {
      durationDiff = sleepTrainingRound(goodGroup.durationMeanMinutes - poorGroup.durationMeanMinutes);
    }
    if (goodGroup.readinessMean !== null && poorGroup.readinessMean !== null) {
      readinessDiff = sleepTrainingRound(goodGroup.readinessMean - poorGroup.readinessMean);
    }
  }

  return {
    displayUnit,
    threshold: SLEEP_TRAINING_MIN_PAIRS,
    totalWorkouts: completed.length,
    pairedCount,
    unpairedCount,
    durationMissingPairs,
    readinessMissingPairs,
    baselineNights: baselineSlice.length,
    baselineHours: baselineRaw === null ? null : sleepTrainingRound(baselineRaw, 2),
    sufficient,
    goodGroup,
    poorGroup,
    volumeDiff,
    durationDiff,
    readinessDiff,
    pairs: pairs.map((pair) => ({ ...pair, sleepHours: sleepTrainingRound(pair.sleepHours, 2), volume: sleepTrainingRound(pair.volume) })),
  };
}
