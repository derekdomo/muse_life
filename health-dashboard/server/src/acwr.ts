// H4.2 训练负荷平衡 (ACWR — acute:chronic workload ratio), borrowed from
// Garmin's published Training Load concept. This module is PURE: it has
// no imports, performs no I/O, and reads no clock — every input arrives
// as an argument, so repo-side validation (validate-acwr.mjs) can load
// it verbatim and run it over synthetic fixtures.
//
// Data caliber: the inputs are the SAME strength-training workouts the
// existing internal sync channel (space-6 训练记录 → saveStrengthTrainingSnapshot,
// the H-LOAD-001 source) already stores — each workout's totalVolume is
// the W3.2/W3.3 caliber (sum over completed sets of weight × reps, in
// the workout's own unit) and durationMinutes is the session duration.
// No second data copy and no second sync path exist for ACWR.
//
// Definitions (shown verbatim on the page):
// - Acute window: the 7 calendar days ending at asOf, inclusive.
// - Chronic window: the 28 calendar days ending at asOf, inclusive.
// - Acute load = the window's per-day average (total ÷ observed days).
// - Chronic load = the window's per-day average (total ÷ observed days).
// - ACWR = acute daily average ÷ chronic daily average, computed
//   separately for training volume and for duration. There is no
//   invented composite: the two ratios are reported side by side.
// - Observed days: when the recorded history starts after a window
//   opens (historyStartDate), only the days from historyStartDate to
//   asOf count — missing history days are NEVER padded with 0, and the
//   chronic average divides by the observed days only. The result
//   carries historyNote 「仅 X 天数据」 whenever the chronic window is
//   observed for fewer than 28 days.
// - A completed workout whose durationMinutes is null makes that
//   window's duration total unknown (null), never 0 — the duration
//   ratio is then null while the volume ratio still computes.
// - Only completed workouts count; active workouts contribute nothing.
// - A chronic daily average of 0 (no recorded load in the window)
//   makes the ratio null (数据不足), never 0 and never infinite.
//
// Thresholds (Garmin's published Training Load bands, as adopted by
// H4.2): ACWR < 0.8 不足 / 0.8–1.3 适宜 / >1.3–1.5 偏高 / >1.5 过高.
// Every band pairs its word with a distinct symbol (▼ / ● / ▲ / ◆) and
// the numeric ratio, so meaning never rides on color alone.

export type AcwrUnit = "lb" | "kg";

export type AcwrBand = "不足" | "适宜" | "偏高" | "过高";

export interface AcwrWorkoutInput {
  date: string;
  status: "active" | "completed";
  durationMinutes: number | null;
  totalVolume: number;
  unit: AcwrUnit;
}

export interface AcwrBandResult {
  band: AcwrBand;
  symbol: string;
  label: string;
}

export interface AcwrResult {
  asOf: string;
  displayUnit: AcwrUnit;
  acuteWindowStart: string;
  acuteWindowEnd: string;
  chronicWindowStart: string;
  chronicWindowEnd: string;
  // Calendar days of each window that are actually observed (history
  // start through asOf). acuteDays ≤ 7, chronicDays ≤ 28; both are 0
  // only when nothing is observed at all.
  acuteDays: number;
  chronicDays: number;
  insufficientHistory: boolean;
  // 「仅 X 天数据」 when chronicDays < 28, otherwise null.
  historyNote: string | null;
  hasData: boolean;
  sessionsAcute: number;
  sessionsChronic: number;
  // Volume (in displayUnit). Totals are null only when the window is
  // unobserved; daily averages divide by observed days, never by the
  // full 7 / 28 when history is shorter.
  acuteVolumeTotal: number | null;
  chronicVolumeTotal: number | null;
  acuteVolumeDailyAvg: number | null;
  chronicVolumeDailyAvg: number | null;
  volumeAcwr: number | null;
  volumeBand: AcwrBandResult | null;
  // Duration (minutes). A total is null when any completed workout in
  // that window lacks a duration (missing stays missing, never 0) or
  // when the window is unobserved.
  acuteDurationTotal: number | null;
  chronicDurationTotal: number | null;
  acuteDurationDailyAvg: number | null;
  chronicDurationDailyAvg: number | null;
  durationAcwr: number | null;
  durationBand: AcwrBandResult | null;
  // Completed workouts inside each window whose duration is unknown.
  acuteDurationMissing: number;
  chronicDurationMissing: number;
}

export const ACWR_ACUTE_DAYS = 7;
export const ACWR_CHRONIC_DAYS = 28;

const ACWR_LB_TO_KG = 0.45359237;

export function convertAcwrVolume(volume: number, fromUnit: AcwrUnit, toUnit: AcwrUnit): number {
  if (fromUnit === toUnit) return volume;
  if (fromUnit === "lb" && toUnit === "kg") return volume * ACWR_LB_TO_KG;
  return volume / ACWR_LB_TO_KG;
}

export function acwrIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function acwrShiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function acwrDaysBetween(start: string, end: string): number {
  const delta = Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`);
  return Math.round(delta / 86_400_000) + 1;
}

export function acwrBandFor(ratio: number | null): AcwrBandResult | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio < 0.8) return { band: "不足", symbol: "▼", label: "不足" };
  if (ratio <= 1.3) return { band: "适宜", symbol: "●", label: "适宜" };
  if (ratio <= 1.5) return { band: "偏高", symbol: "▲", label: "偏高" };
  return { band: "过高", symbol: "◆", label: "过高" };
}

function acwrRound(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function computeAcwr(
  workouts: AcwrWorkoutInput[],
  asOf: string,
  displayUnit: AcwrUnit,
  historyStartDate: string | null,
): AcwrResult {
  const acuteWindowEnd = asOf;
  const chronicWindowEnd = asOf;
  const acuteWindowStart = acwrIsRealDate(asOf) ? acwrShiftDate(asOf, -(ACWR_ACUTE_DAYS - 1)) : asOf;
  const chronicWindowStart = acwrIsRealDate(asOf) ? acwrShiftDate(asOf, -(ACWR_CHRONIC_DAYS - 1)) : asOf;

  const empty: AcwrResult = {
    asOf,
    displayUnit,
    acuteWindowStart,
    acuteWindowEnd,
    chronicWindowStart,
    chronicWindowEnd,
    acuteDays: 0,
    chronicDays: 0,
    insufficientHistory: false,
    historyNote: null,
    hasData: false,
    sessionsAcute: 0,
    sessionsChronic: 0,
    acuteVolumeTotal: null,
    chronicVolumeTotal: null,
    acuteVolumeDailyAvg: null,
    chronicVolumeDailyAvg: null,
    volumeAcwr: null,
    volumeBand: null,
    acuteDurationTotal: null,
    chronicDurationTotal: null,
    acuteDurationDailyAvg: null,
    chronicDurationDailyAvg: null,
    durationAcwr: null,
    durationBand: null,
    acuteDurationMissing: 0,
    chronicDurationMissing: 0,
  };
  if (!acwrIsRealDate(asOf)) return empty;

  const completed = workouts.filter(
    (workout) => workout.status === "completed" && acwrIsRealDate(workout.date) && workout.date <= asOf,
  );

  // Observed history starts at the caller's coverage start when it is a
  // real date on/before asOf; otherwise the earliest completed workout
  // on record is the first day we can honestly claim to observe. Days
  // before that start are unknown — excluded from every divisor.
  let effectiveStart: string | null = null;
  if (historyStartDate !== null && acwrIsRealDate(historyStartDate) && historyStartDate <= asOf) {
    effectiveStart = historyStartDate;
  } else if (completed.length) {
    effectiveStart = completed.reduce((min, workout) => (workout.date < min ? workout.date : min), completed[0]?.date ?? asOf);
  }
  if (effectiveStart === null) return empty;

  const observedStartFor = (windowStart: string): string => (effectiveStart > windowStart ? effectiveStart : windowStart);
  const acuteObservedStart = observedStartFor(acuteWindowStart);
  const chronicObservedStart = observedStartFor(chronicWindowStart);
  const acuteDays = acwrDaysBetween(acuteObservedStart, asOf);
  const chronicDays = acwrDaysBetween(chronicObservedStart, asOf);
  const insufficientHistory = chronicDays < ACWR_CHRONIC_DAYS;
  const historyNote = insufficientHistory ? `仅 ${chronicDays} 天数据` : null;

  const inWindow = (date: string, windowStart: string): boolean => date >= windowStart && date <= asOf;
  const acuteWorkouts = completed.filter((workout) => inWindow(workout.date, acuteWindowStart));
  const chronicWorkouts = completed.filter((workout) => inWindow(workout.date, chronicWindowStart));

  const volumeTotal = (list: AcwrWorkoutInput[]): number =>
    list.reduce((sum, workout) => sum + convertAcwrVolume(workout.totalVolume, workout.unit, displayUnit), 0);
  const durationTotal = (list: AcwrWorkoutInput[]): number | null =>
    list.some((workout) => workout.durationMinutes === null)
      ? null
      : list.reduce((sum, workout) => sum + (workout.durationMinutes ?? 0), 0);

  const acuteVolumeRaw = volumeTotal(acuteWorkouts);
  const chronicVolumeRaw = volumeTotal(chronicWorkouts);
  const acuteDurationRaw = durationTotal(acuteWorkouts);
  const chronicDurationRaw = durationTotal(chronicWorkouts);

  const acuteVolumeDailyAvgRaw = acuteVolumeRaw / acuteDays;
  const chronicVolumeDailyAvgRaw = chronicVolumeRaw / chronicDays;
  const acuteDurationDailyAvgRaw = acuteDurationRaw === null ? null : acuteDurationRaw / acuteDays;
  const chronicDurationDailyAvgRaw = chronicDurationRaw === null ? null : chronicDurationRaw / chronicDays;

  const volumeAcwrRaw = chronicVolumeDailyAvgRaw > 0 ? acuteVolumeDailyAvgRaw / chronicVolumeDailyAvgRaw : null;
  const durationAcwrRaw =
    acuteDurationDailyAvgRaw !== null && chronicDurationDailyAvgRaw !== null && chronicDurationDailyAvgRaw > 0
      ? acuteDurationDailyAvgRaw / chronicDurationDailyAvgRaw
      : null;
  const volumeAcwr = volumeAcwrRaw === null ? null : acwrRound(volumeAcwrRaw);
  const durationAcwr = durationAcwrRaw === null ? null : acwrRound(durationAcwrRaw);

  return {
    asOf,
    displayUnit,
    acuteWindowStart,
    acuteWindowEnd,
    chronicWindowStart,
    chronicWindowEnd,
    acuteDays,
    chronicDays,
    insufficientHistory,
    historyNote,
    hasData: chronicWorkouts.length > 0,
    sessionsAcute: acuteWorkouts.length,
    sessionsChronic: chronicWorkouts.length,
    acuteVolumeTotal: acwrRound(acuteVolumeRaw),
    chronicVolumeTotal: acwrRound(chronicVolumeRaw),
    acuteVolumeDailyAvg: acwrRound(acuteVolumeDailyAvgRaw),
    chronicVolumeDailyAvg: acwrRound(chronicVolumeDailyAvgRaw),
    volumeAcwr,
    volumeBand: acwrBandFor(volumeAcwr),
    acuteDurationTotal: acuteDurationRaw === null ? null : acwrRound(acuteDurationRaw),
    chronicDurationTotal: chronicDurationRaw === null ? null : acwrRound(chronicDurationRaw),
    acuteDurationDailyAvg: acuteDurationDailyAvgRaw === null ? null : acwrRound(acuteDurationDailyAvgRaw),
    chronicDurationDailyAvg: chronicDurationDailyAvgRaw === null ? null : acwrRound(chronicDurationDailyAvgRaw),
    durationAcwr,
    durationBand: acwrBandFor(durationAcwr),
    acuteDurationMissing: acuteWorkouts.filter((workout) => workout.durationMinutes === null).length,
    chronicDurationMissing: chronicWorkouts.filter((workout) => workout.durationMinutes === null).length,
  };
}
