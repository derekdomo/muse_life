// H2.3 趋势 7/30 天切换与三类日期标记 (trend windows + three kinds of
// date marks). This module is PURE: it has no imports, performs no
// I/O, and reads no clock — every input arrives as an argument, so
// repo-side validation (validate-trend-ranges.mjs) can load it
// verbatim and run it over synthetic fixtures.
//
// Data caliber: the inputs are the SAME sources every other panel
// reads — the health snapshot's historyDaily (HRV / resting HR /
// steps) and its historySleeps already reduced by the caller to ONE
// main sleep per wake-up date (the deterministic CWEB-SLEEP-001
// selection, actual sleep = core + deep + REM, awake never counted),
// the readiness_history archive rows (H-LOAD-001: the score computed
// and shown on that date; no row → a gap, never backfilled), the
// strength snapshot's completed-session dates (the existing 训练记录
// sync channel — no new data source), and the health snapshot's
// HealthKit workout dates. No second data copy and no second sync
// path exist for this feature.
//
// Definitions (printed verbatim in the page legend):
// - Windows: 7 or 30 calendar days ENDING at the snapshot's dataDate
//   (the latest complete metrics day). The partial day (the readiness
//   date) never appears in a window, and daily rows dated after
//   dataDate are not complete days and never count. When the stored
//   history starts after a window opens, only the observed days are
//   shown and the window carries historyNote 「仅 X 天数据」 — missing
//   days are NEVER padded with 0 and a short window never poses as a
//   complete one.
// - 缺失段 (missing segments): inside the OBSERVED span of a window
//   (from the later of the window start and the first stored date),
//   a date is missing when NONE of the four metrics (HRV / 静息心率 /
//   睡眠 / 步数) carries a valid value for it and it is not an
//   owner-declared status date (H4.4 — a status date is a declared
//   gap with its own mark, not a missing record). Consecutive
//   missing dates merge into one segment. A missing segment is a
//   gap marker only — no conclusion is drawn from it.
// - 训练日 (training days): a window date with a completed strength
//   session in the strength snapshot and/or a HealthKit workout
//   session in the health snapshot. The two sources are flagged
//   separately on the mark; neither is inferred from the other.
// - 偏离基线 (deviation from the personal baseline): the baseline
//   caliber is the H4.5 long-term baseline, anchored at the window
//   end — HRV / resting HR / steps take the MEDIAN of the valid days
//   inside the ≤28 calendar days ending at the window end, available
//   only with at least 14 valid days; sleep keeps the H4.3 caliber —
//   the plain MEAN of the most recent ≤14 recorded nights on or
//   before the window end, available only at ≥8 nights. Status
//   dates (H4.4) are excluded from every baseline, exactly as in
//   H4.5. A date is marked only when its value's offset from the
//   baseline reaches the practical-difference threshold — the same
//   thresholds as H1.7/H3/H4.5: HRV ±10% of baseline, resting HR
//   ±3 bpm, sleep ±30 minutes, steps ±20% of baseline. Below the
//   threshold the day is ordinary single-day noise and is NOT
//   marked. A status date is never deviation-marked (its own status
//   mark already names the day, and H4.4 draws no trend conclusion
//   from status days); training marks stack freely with deviation
//   and status marks.
// - Readiness points come from the archive alone: a date with no
//   archive row (or an archived 数据不足 null score) is a null
//   point — a gap, never filled with another day's score.
// - Duplicate daily rows that disagree on a field make that field
//   read as missing for the date (the week/month review caliber) —
//   never an arbitrary pick. HRV of exactly 0 is not a usable
//   reading and reads as missing, as in readiness and H4.5.

export const TREND_WINDOW_DAYS_LIST: readonly number[] = [7, 30];
export const TREND_DEFAULT_WINDOW_DAYS = 7;
export const TREND_BASELINE_DAYS = 28;
export const TREND_BASELINE_MIN_DAYS = 14;
export const TREND_SLEEP_BASELINE_MAX_NIGHTS = 14;
export const TREND_SLEEP_BASELINE_MIN_NIGHTS = 8;
export const TREND_HRV_THRESHOLD_PCT = 0.10;
export const TREND_RESTING_HR_THRESHOLD_BPM = 3;
export const TREND_SLEEP_THRESHOLD_MINUTES = 30;
export const TREND_STEPS_THRESHOLD_PCT = 0.20;

export type TrendMetricKey = "hrv" | "restingHr" | "sleep" | "steps";
export type TrendWindowDays = 7 | 30;

export interface TrendDailyInput {
  date: string;
  steps: number | null;
  restingHr: number | null;
  hrvMs: number | null;
}

export interface TrendNightInput {
  // Wake-up calendar date (YYYY-MM-DD) of the night's main sleep.
  date: string;
  // Actual sleep that night in hours (core + deep + REM).
  hours: number;
}

export interface TrendReadinessInput {
  date: string;
  // The archived score for the date; null = that day's readiness
  // was 数据不足 — a gap either way when no row exists at all.
  score: number | null;
}

export interface TrendRangesInput {
  daily: TrendDailyInput[];
  nights: TrendNightInput[];
  readiness: TrendReadinessInput[];
  // Dates with a completed strength session (existing 训练记录 sync
  // channel snapshot).
  strengthTrainingDates: readonly string[];
  // Dates with a HealthKit workout session (health snapshot).
  hkWorkoutDates: readonly string[];
  // Every date inside an owner-declared status period (H4.4), as
  // computed by the caller from the stored periods.
  statusDates: readonly string[];
  // The readiness date ("today" for the dashboard) — the partial
  // day, excluded everywhere.
  anchorDate: string;
  // The snapshot's latest complete metrics day: both windows end
  // here, and daily rows dated after it never count.
  dataDate: string;
  // The current partial day (the morning-reference date), excluded
  // everywhere on top of the dataDate rule; null when unknown.
  partialDate: string | null;
}

export interface TrendSeriesPoint {
  date: string;
  value: number | null;
}

export interface TrendMetricSeries {
  key: TrendMetricKey;
  label: string;
  unit: string;
  digits: number;
  points: TrendSeriesPoint[];
  // The long-term baseline (H4.5 caliber, anchored at the window
  // end); null whenever the baseline gate fails — never invented.
  baseline: number | null;
  baselineDays: number;
  baselineSufficient: boolean;
}

export interface TrendMissingSegment {
  startDate: string;
  endDate: string;
  days: number;
}

export interface TrendTrainingDay {
  date: string;
  strength: boolean;
  hkWorkout: boolean;
}

export interface TrendDeviation {
  date: string;
  metric: TrendMetricKey;
  label: string;
  // ▲ 偏高 / ▼ 偏低 — the symbol always travels with the word and
  // the signed offset number, so meaning never rides on color.
  symbol: string;
  word: string;
  value: number;
  baseline: number;
  offset: number;
  unit: string;
  digits: number;
}

export interface TrendWindowResult {
  days: TrendWindowDays;
  windowStart: string;
  windowEnd: string;
  // Calendar days of the window actually covered by stored history
  // (first stored date through windowEnd). observedDays ≤ days.
  observedDays: number;
  // 「仅 X 天数据」 when observedDays < days, otherwise null.
  historyNote: string | null;
  metrics: TrendMetricSeries[];
  readiness: TrendSeriesPoint[];
  missingSegments: TrendMissingSegment[];
  // Every missing date inside the observed span, ascending — the
  // per-date form of missingSegments, for per-day chart marks.
  missingDates: string[];
  trainingDays: TrendTrainingDay[];
  deviations: TrendDeviation[];
}

export interface TrendRangesResult {
  anchorDate: string;
  dataDate: string;
  windows: TrendWindowResult[];
}

export function trendIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function trendShiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function trendDaysBetween(start: string, end: string): number {
  const delta = Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`);
  return Math.round(delta / 86_400_000) + 1;
}

export function trendMean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Median of the values (the middle value, or the mean of the two
// middle values for an even count); null for an empty list.
export function trendMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

// The practical-difference threshold for one metric, in the
// metric's own unit (sleep: hours). Percentage thresholds scale
// with the baseline's magnitude, as in H3/H4.5.
export function trendThresholdFor(key: TrendMetricKey, baseline: number): number {
  if (key === "hrv") return Math.abs(baseline) * TREND_HRV_THRESHOLD_PCT;
  if (key === "restingHr") return TREND_RESTING_HR_THRESHOLD_BPM;
  if (key === "sleep") return TREND_SLEEP_THRESHOLD_MINUTES / 60;
  return Math.abs(baseline) * TREND_STEPS_THRESHOLD_PCT;
}

// The deviation direction for one day's value against its baseline:
// ▲ 偏高 / ▼ 偏低 once the offset reaches the practical-difference
// threshold; null inside it (ordinary single-day noise, unmarked).
export function trendDeviationDirection(
  key: TrendMetricKey,
  value: number,
  baseline: number,
): { symbol: string; word: string } | null {
  const offset = value - baseline;
  if (offset === 0) return null;
  const threshold = trendThresholdFor(key, baseline);
  if (offset > 0 && offset >= threshold) return { symbol: "▲", word: "偏高" };
  if (offset < 0 && offset <= -threshold) return { symbol: "▼", word: "偏低" };
  return null;
}

function trendRound(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface MetricDef {
  key: TrendMetricKey;
  label: string;
  unit: string;
  digits: number;
}

export const TREND_METRIC_DEFS: MetricDef[] = [
  { key: "hrv", label: "HRV", unit: "ms", digits: 1 },
  { key: "restingHr", label: "静息心率", unit: "bpm", digits: 1 },
  { key: "sleep", label: "睡眠", unit: "小时", digits: 2 },
  { key: "steps", label: "步数", unit: "步", digits: 0 },
];

type DailyField = "steps" | "restingHr" | "hrvMs";

export function computeTrendRanges(input: TrendRangesInput): TrendRangesResult | null {
  if (!trendIsRealDate(input.dataDate)) return null;
  const windowEnd = input.dataDate;
  const statusSet = new Set(input.statusDates.filter((date) => trendIsRealDate(date)));
  const partialDate = input.partialDate !== null && trendIsRealDate(input.partialDate) ? input.partialDate : null;
  const isExcludedDate = (date: string): boolean =>
    statusSet.has(date) || (partialDate !== null && date === partialDate);

  // Daily values by date. A row is usable only when dated on or
  // before dataDate (a later row is not a complete day). Conflicting
  // duplicate rows make the disagreed field read as missing.
  const dailyByDate = new Map<string, Record<DailyField, number | null>>();
  const dailyConflicts = new Set<string>();
  for (const row of input.daily) {
    if (!trendIsRealDate(row.date)) continue;
    if (row.date > windowEnd) continue;
    const record: Record<DailyField, number | null> = {
      steps: typeof row.steps === "number" && Number.isFinite(row.steps) && row.steps >= 0 ? row.steps : null,
      restingHr: typeof row.restingHr === "number" && Number.isFinite(row.restingHr) && row.restingHr > 0 ? row.restingHr : null,
      // HRV of exactly 0 is not a usable reading; it reads as
      // missing, never as 0 ms.
      hrvMs: typeof row.hrvMs === "number" && Number.isFinite(row.hrvMs) && row.hrvMs > 0 ? row.hrvMs : null,
    };
    const existing = dailyByDate.get(row.date);
    if (existing === undefined) {
      dailyByDate.set(row.date, record);
      continue;
    }
    for (const field of ["steps", "restingHr", "hrvMs"] as DailyField[]) {
      if (existing[field] !== record[field]) dailyConflicts.add(`${row.date}|${field}`);
    }
  }
  const dailyValue = (date: string, field: DailyField): number | null => {
    if (dailyConflicts.has(`${date}|${field}`)) return null;
    return dailyByDate.get(date)?.[field] ?? null;
  };

  // One main sleep per wake-up date (already reduced by the
  // caller); a duplicate keeps the longest actual sleep, as in
  // H4.5 — deterministic and order-independent.
  const sleepByDate = new Map<string, number>();
  for (const night of input.nights) {
    if (!trendIsRealDate(night.date)) continue;
    if (night.date > windowEnd) continue;
    if (!Number.isFinite(night.hours) || night.hours < 0) continue;
    const previous = sleepByDate.get(night.date);
    if (previous === undefined || night.hours > previous) sleepByDate.set(night.date, night.hours);
  }

  const readinessByDate = new Map<string, number | null>();
  for (const row of input.readiness) {
    if (!trendIsRealDate(row.date)) continue;
    if (typeof row.score === "number" && Number.isFinite(row.score)) readinessByDate.set(row.date, row.score);
    else if (!readinessByDate.has(row.date)) readinessByDate.set(row.date, null);
  }

  const strengthDates = new Set(input.strengthTrainingDates.filter((date) => trendIsRealDate(date)));
  const hkDates = new Set(input.hkWorkoutDates.filter((date) => trendIsRealDate(date)));

  // The first stored date bounds the observed span: nothing before
  // it is "missing" — it is simply not yet history, and the window
  // note （仅 X 天数据） says exactly how much history exists.
  const storedDates = [...dailyByDate.keys(), ...sleepByDate.keys()].filter((date) => date <= windowEnd);
  const coverageStart = storedDates.length
    ? storedDates.reduce((min, date) => (date < min ? date : min), storedDates[0] ?? windowEnd)
    : null;

  const dailyFieldFor = (key: TrendMetricKey): DailyField | null =>
    key === "hrv" ? "hrvMs" : key === "sleep" ? null : key;
  const metricValue = (key: TrendMetricKey, date: string): number | null => {
    const field = dailyFieldFor(key);
    return field === null ? sleepByDate.get(date) ?? null : dailyValue(date, field);
  };

  // Baselines (H4.5 caliber), anchored at the window end and shared
  // by both windows — the same day always judges against the same
  // baseline whichever window displays it.
  const baselineDates: string[] = [];
  for (let back = TREND_BASELINE_DAYS - 1; back >= 0; back -= 1) baselineDates.push(trendShiftDate(windowEnd, -back));
  const baselineFor = (def: MetricDef): { baselineRaw: number | null; days: number } => {
    if (def.key === "sleep") {
      const nights = [...sleepByDate.entries()]
        .filter(([date]) => date <= windowEnd && !isExcludedDate(date))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-TREND_SLEEP_BASELINE_MAX_NIGHTS);
      const baselineRaw = nights.length >= TREND_SLEEP_BASELINE_MIN_NIGHTS
        ? trendMean(nights.map(([, hours]) => hours))
        : null;
      return { baselineRaw, days: nights.length };
    }
    const field = dailyFieldFor(def.key);
    const values: number[] = [];
    if (field !== null) {
      for (const date of baselineDates) {
        if (isExcludedDate(date)) continue;
        const value = dailyValue(date, field);
        if (value !== null) values.push(value);
      }
    }
    const baselineRaw = values.length >= TREND_BASELINE_MIN_DAYS ? trendMedian(values) : null;
    return { baselineRaw, days: values.length };
  };
  const baselines = new Map<TrendMetricKey, { baselineRaw: number | null; days: number }>();
  for (const def of TREND_METRIC_DEFS) baselines.set(def.key, baselineFor(def));

  const buildWindow = (days: TrendWindowDays): TrendWindowResult => {
    const windowStart = trendShiftDate(windowEnd, -(days - 1));
    const dates: string[] = [];
    for (let offset = 0; offset < days; offset += 1) dates.push(trendShiftDate(windowStart, offset));
    const observedStart = coverageStart !== null && coverageStart > windowStart ? coverageStart : windowStart;
    const observedDays = coverageStart === null ? 0 : trendDaysBetween(observedStart, windowEnd);
    const historyNote = observedDays < days ? `仅 ${observedDays} 天数据` : null;

    const metrics: TrendMetricSeries[] = TREND_METRIC_DEFS.map((def) => {
      const baseline = baselines.get(def.key) ?? { baselineRaw: null, days: 0 };
      return {
        key: def.key,
        label: def.label,
        unit: def.unit,
        digits: def.digits,
        points: dates.map((date) => ({ date, value: metricValue(def.key, date) })),
        baseline: baseline.baselineRaw === null ? null : trendRound(baseline.baselineRaw, def.digits),
        baselineDays: baseline.days,
        baselineSufficient: baseline.baselineRaw !== null,
      };
    });

    const readiness: TrendSeriesPoint[] = dates.map((date) => ({
      date,
      value: readinessByDate.get(date) ?? null,
    }));

    // Missing dates: inside the observed span only, a date with no
    // valid value in ANY metric and no status declaration. Status
    // dates break segments — they are declared gaps, not missing
    // records — and dates before the observed span are outside
    // history entirely (the window note covers them).
    const missingDates: string[] = [];
    for (const date of dates) {
      if (coverageStart === null || date < coverageStart) continue;
      if (statusSet.has(date)) continue;
      const hasAny = TREND_METRIC_DEFS.some((def) => metricValue(def.key, date) !== null);
      if (!hasAny) missingDates.push(date);
    }
    const missingSegments: TrendMissingSegment[] = [];
    for (const date of missingDates) {
      const last = missingSegments[missingSegments.length - 1];
      if (last && trendShiftDate(last.endDate, 1) === date) {
        last.endDate = date;
        last.days += 1;
      } else {
        missingSegments.push({ startDate: date, endDate: date, days: 1 });
      }
    }

    const trainingDays: TrendTrainingDay[] = dates
      .filter((date) => strengthDates.has(date) || hkDates.has(date))
      .map((date) => ({ date, strength: strengthDates.has(date), hkWorkout: hkDates.has(date) }));

    const deviations: TrendDeviation[] = [];
    for (const date of dates) {
      if (statusSet.has(date)) continue;
      for (const def of TREND_METRIC_DEFS) {
        const baseline = baselines.get(def.key)?.baselineRaw ?? null;
        if (baseline === null) continue;
        const value = metricValue(def.key, date);
        if (value === null) continue;
        const direction = trendDeviationDirection(def.key, value, baseline);
        if (!direction) continue;
        deviations.push({
          date,
          metric: def.key,
          label: def.label,
          symbol: direction.symbol,
          word: direction.word,
          value: trendRound(value, def.digits),
          baseline: trendRound(baseline, def.digits),
          offset: trendRound(value - baseline, def.digits),
          unit: def.unit,
          digits: def.digits,
        });
      }
    }

    return {
      days,
      windowStart,
      windowEnd,
      observedDays,
      historyNote,
      metrics,
      readiness,
      missingSegments,
      missingDates,
      trainingDays,
      deviations,
    };
  };

  return {
    anchorDate: input.anchorDate,
    dataDate: windowEnd,
    windows: [buildWindow(7), buildWindow(30)],
  };
}
