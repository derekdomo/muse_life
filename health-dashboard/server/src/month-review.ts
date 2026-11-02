// H4.5 月度回顾与长期基线漂移 (monthly review vs long-term baseline),
// borrowed from the Bevel / Oura monthly-report shape. This module is
// PURE: it has no imports, performs no I/O, and reads no clock — every
// input arrives as an argument, so repo-side validation
// (validate-month-review.mjs) can load it verbatim and run it over
// synthetic fixtures.
//
// Data caliber: the inputs are the SAME sources every other panel
// reads — the health snapshot's historyDaily (HRV / resting HR /
// steps) and its historySleeps already reduced by the caller to ONE
// main sleep per wake-up date (the deterministic CWEB-SLEEP-001
// selection) with its actual sleep duration (core + deep + REM;
// awake time is never part of actual sleep). No second data copy and
// no second sync path exist for this panel.
//
// Definitions (printed verbatim on the panel):
// - Review window: the previous COMPLETE calendar month before the
//   anchor (the readiness date — the morning the owner opens the
//   dashboard). With an anchor anywhere in November 2026 the review
//   window is 2026-10-01 .. 2026-10-31. The current, unfinished month
//   is never reviewed.
// - Month mean: the plain mean of the metric's VALID days inside the
//   review window. A window date is valid when a usable value is
//   recorded for it: a historyDaily row dated on/before the
//   snapshot's dataDate (rows after dataDate are not complete days —
//   the H0.3 partial-day rule; the caller's partial date is excluded
//   on top of that) with a non-null value, or a recorded main sleep
//   for that wake-up date. A date inside an owner-declared status
//   period (H4.4) is EXCLUDED — the caller passes the status dates
//   (computed by status-mode's statusDatesInWindow) and those dates
//   count as neither valid nor missing. Every other window date is
//   MISSING for that metric: counted, listed by date, and never
//   filled with 0. Each metric counts its valid days independently.
// - Long-term baselines (all anchored at the review month's END, so
//   a baseline never uses data from after the month under review):
//   · HRV / resting HR: the MEDIAN of the valid days inside the
//     ≤28 calendar days ending at the review month's end (a robust
//     statistic, so a few extreme days cannot move it), available
//     only with at least MONTH_REVIEW_BASELINE_MIN_DAYS (14) valid
//     days — fewer → baseline null （基线不足）.
//   · Steps: the MEDIAN of the complete days' step counts inside
//     the same ≤28-day window, same ≥14 gate.
//   · Sleep: the H4.3 caliber unchanged — the plain MEAN of actual
//     sleep over the most recent ≤14 recorded nights on or before
//     the review month's end, available only at ≥8 nights.
//   Status dates are excluded from every baseline window too (the
//   H4.4 exclusion caliber), and the partial day never enters one.
// - Offset = month mean − baseline. Direction uses the SAME
//   practical-difference thresholds as the H3 week review: HRV
//   ±10% of baseline, resting HR ±3 bpm, sleep ±30 minutes, steps
//   ±20% of baseline. At or beyond the threshold the direction reads
//   偏高 (▲) / 偏低 (▼); inside it the row reads ● 与基线接近 and
//   still shows the signed offset number. A row is judgeable only
//   when its baseline is sufficient AND the month holds at least
//   MONTH_REVIEW_MIN_VALID_DAYS (7) valid days; otherwise offset and
//   direction are null and the panel says 无法判断 — nothing is
//   invented to fill the gap.
// - Honesty: a single month is noisy. This module emits offset FACTS
//   and a threshold direction only — never a trend verdict （上升 /
//   变好 / 变差）, never a score, and never a medical judgement. The
//   panel prints that disclaimer next to the numbers.

export const MONTH_REVIEW_BASELINE_DAYS = 28;
export const MONTH_REVIEW_BASELINE_MIN_DAYS = 14;
export const MONTH_REVIEW_SLEEP_BASELINE_MAX_NIGHTS = 14;
export const MONTH_REVIEW_SLEEP_BASELINE_MIN_NIGHTS = 8;
export const MONTH_REVIEW_MIN_VALID_DAYS = 7;
export const MONTH_REVIEW_HRV_THRESHOLD_PCT = 0.10;
export const MONTH_REVIEW_RESTING_HR_THRESHOLD_BPM = 3;
export const MONTH_REVIEW_SLEEP_THRESHOLD_MINUTES = 30;
export const MONTH_REVIEW_STEPS_THRESHOLD_PCT = 0.20;

export type MonthReviewMetricKey = "hrv" | "restingHr" | "sleep" | "steps";

export interface MonthReviewDailyInput {
  date: string;
  steps: number | null;
  restingHr: number | null;
  hrvMs: number | null;
}

export interface MonthReviewNightInput {
  // Wake-up calendar date (YYYY-MM-DD) of the night's main sleep.
  date: string;
  // Actual sleep that night in hours (core + deep + REM).
  hours: number;
}

export interface MonthReviewInput {
  daily: MonthReviewDailyInput[];
  nights: MonthReviewNightInput[];
  // Every date inside an owner-declared status period (H4.4), as
  // computed by the caller from the stored periods. Such a date is
  // excluded from the month mean AND from every baseline window.
  statusDates: readonly string[];
  // The readiness date ("today" for the dashboard) — the review
  // window is the complete calendar month before this date's month.
  anchorDate: string;
  // The snapshot's latest complete metrics day: daily rows dated
  // after it are not complete days and never count as valid.
  dataDate: string;
  // The current partial day (the morning-reference date), excluded
  // everywhere on top of the dataDate rule; null when unknown.
  partialDate: string | null;
}

export interface MonthReviewDirection {
  symbol: string;
  word: string;
}

export interface MonthReviewMetric {
  key: MonthReviewMetricKey;
  label: string;
  unit: string;
  digits: number;
  // Mean over the month's valid days; null when the month holds no
  // valid day for this metric at all — never a fabricated 0.
  monthMean: number | null;
  validDays: number;
  // Window dates with no usable value (status dates excluded —
  // they are gaps by declaration, not missing records).
  missingDates: string[];
  // The long-term baseline (median or sleep mean per the caliber
  // above); null whenever the baseline gate fails.
  baseline: number | null;
  baselineDays: number;
  baselineSufficient: boolean;
  // monthMean − baseline; null unless the row is judgeable.
  offset: number | null;
  // ▲ 偏高 / ▼ 偏低 / ● 与基线接近; null unless judgeable.
  direction: MonthReviewDirection | null;
  judgeable: boolean;
}

export interface MonthReviewResult {
  monthLabel: string;
  monthStart: string;
  monthEnd: string;
  monthDays: number;
  anchorDate: string;
  minValidDays: number;
  // Status-period dates inside the review window, ascending — the
  // declared gaps the month means skip over.
  statusExcludedDates: string[];
  metrics: MonthReviewMetric[];
}

export function monthReviewIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function monthReviewShiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// The previous complete calendar month before the anchor's month:
// [first day, last day] plus its length in days and display label.
// Null when the anchor is not a real date.
export function previousMonthWindow(anchorDate: string): { start: string; end: string; days: number; label: string } | null {
  if (!monthReviewIsRealDate(anchorDate)) return null;
  const year = Number(anchorDate.slice(0, 4));
  const month = Number(anchorDate.slice(5, 7));
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const start = `${String(prevYear).padStart(4, "0")}-${String(prevMonth).padStart(2, "0")}-01`;
  // Day 0 of the anchor's month is the review month's last day.
  const endDate = new Date(Date.UTC(year, month - 1, 0, 12, 0, 0));
  const end = endDate.toISOString().slice(0, 10);
  const days = Number(end.slice(8, 10));
  return { start, end, days, label: `${prevYear} 年 ${prevMonth} 月` };
}

export function monthReviewMean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Median of the values (the middle value, or the mean of the two
// middle values for an even count); null for an empty list.
export function monthReviewMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

// The practical-difference direction for one metric, using the H3
// week review's thresholds. `offset` and `baseline` are the raw
// (unrounded) values. At or beyond the threshold the word is
// 偏高 / 偏低 by the offset's sign; inside it, ● 与基线接近 — the
// panel still prints the signed offset beside the word, so the fact
// is never hidden by the label.
export function monthReviewDirection(key: MonthReviewMetricKey, offset: number, baseline: number): MonthReviewDirection {
  let threshold: number;
  if (key === "hrv") threshold = Math.abs(baseline) * MONTH_REVIEW_HRV_THRESHOLD_PCT;
  else if (key === "restingHr") threshold = MONTH_REVIEW_RESTING_HR_THRESHOLD_BPM;
  else if (key === "sleep") threshold = MONTH_REVIEW_SLEEP_THRESHOLD_MINUTES / 60;
  else threshold = Math.abs(baseline) * MONTH_REVIEW_STEPS_THRESHOLD_PCT;
  if (offset >= threshold && offset > 0) return { symbol: "▲", word: "偏高" };
  if (offset <= -threshold && offset < 0) return { symbol: "▼", word: "偏低" };
  return { symbol: "●", word: "与基线接近" };
}

function monthReviewRound(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface MetricDef {
  key: MonthReviewMetricKey;
  label: string;
  unit: string;
  digits: number;
}

const METRIC_DEFS: MetricDef[] = [
  { key: "hrv", label: "HRV", unit: "ms", digits: 1 },
  { key: "restingHr", label: "静息心率", unit: "bpm", digits: 1 },
  { key: "sleep", label: "睡眠", unit: "小时", digits: 2 },
  { key: "steps", label: "步数", unit: "步", digits: 0 },
];

export function computeMonthReview(input: MonthReviewInput): MonthReviewResult | null {
  const window = previousMonthWindow(input.anchorDate);
  if (!window) return null;
  const { start: monthStart, end: monthEnd, days: monthDays, label: monthLabel } = window;
  const statusSet = new Set(input.statusDates.filter((date) => monthReviewIsRealDate(date)));
  const dataDate = monthReviewIsRealDate(input.dataDate) ? input.dataDate : null;
  const partialDate = input.partialDate !== null && monthReviewIsRealDate(input.partialDate) ? input.partialDate : null;

  // A date is excluded from every statistic when it is a declared
  // status date (H4.4) or the current partial day (H0.3).
  const isExcludedDate = (date: string): boolean => statusSet.has(date) || (partialDate !== null && date === partialDate);

  // Daily values by date. A row is usable only when it is dated on
  // or before dataDate (a later row is not a complete day). When two
  // usable rows disagree on a field for the same date, that field is
  // a conflict and reads as missing — the week review's caliber —
  // never an arbitrary pick.
  type DailyField = "steps" | "restingHr" | "hrvMs";
  const dailyByDate = new Map<string, Record<DailyField, number | null>>();
  const dailyConflicts = new Set<string>();
  for (const row of input.daily) {
    if (!monthReviewIsRealDate(row.date)) continue;
    if (dataDate !== null && row.date > dataDate) continue;
    const record: Record<DailyField, number | null> = {
      steps: typeof row.steps === "number" && Number.isFinite(row.steps) && row.steps >= 0 ? row.steps : null,
      restingHr: typeof row.restingHr === "number" && Number.isFinite(row.restingHr) && row.restingHr > 0 ? row.restingHr : null,
      // HRV of exactly 0 is not a usable reading (readiness treats
      // hrvMs > 0 the same way); it reads as missing, never as 0 ms.
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

  // One main sleep per wake-up date: if the caller ever passes
  // duplicates, the longest actual sleep wins (the main sleep),
  // deterministically and independent of array order.
  const sleepByDate = new Map<string, number>();
  for (const night of input.nights) {
    if (!monthReviewIsRealDate(night.date)) continue;
    if (!Number.isFinite(night.hours) || night.hours < 0) continue;
    const previous = sleepByDate.get(night.date);
    if (previous === undefined || night.hours > previous) sleepByDate.set(night.date, night.hours);
  }

  // The review month's dates and the baseline window's dates
  // (≤28 calendar days ending at the review month's end).
  const monthDates: string[] = [];
  for (let offset = 0; offset < monthDays; offset += 1) monthDates.push(monthReviewShiftDate(monthStart, offset));
  const baselineDates: string[] = [];
  for (let back = MONTH_REVIEW_BASELINE_DAYS - 1; back >= 0; back -= 1) baselineDates.push(monthReviewShiftDate(monthEnd, -back));

  const statusExcludedDates = monthDates.filter((date) => statusSet.has(date));

  // Daily-metric baseline: median over the baseline window's valid
  // days, gated at ≥14 valid days.
  const dailyBaseline = (field: DailyField): { baselineRaw: number | null; days: number } => {
    const values: number[] = [];
    for (const date of baselineDates) {
      if (isExcludedDate(date)) continue;
      const value = dailyValue(date, field);
      if (value !== null) values.push(value);
    }
    const baselineRaw = values.length >= MONTH_REVIEW_BASELINE_MIN_DAYS ? monthReviewMedian(values) : null;
    return { baselineRaw, days: values.length };
  };

  // Sleep baseline: the H4.3 caliber — mean over the most recent
  // ≤14 recorded nights on or before the review month's end,
  // status nights excluded, gated at ≥8 nights.
  const sleepBaseline = (): { baselineRaw: number | null; days: number } => {
    const nights = [...sleepByDate.entries()]
      .filter(([date]) => date <= monthEnd && !isExcludedDate(date))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-MONTH_REVIEW_SLEEP_BASELINE_MAX_NIGHTS);
    const baselineRaw = nights.length >= MONTH_REVIEW_SLEEP_BASELINE_MIN_NIGHTS
      ? monthReviewMean(nights.map(([, hours]) => hours))
      : null;
    return { baselineRaw, days: nights.length };
  };

  const dailyFieldFor = (key: MonthReviewMetricKey): DailyField | null =>
    key === "hrv" ? "hrvMs" : key === "sleep" ? null : key;

  const metrics: MonthReviewMetric[] = METRIC_DEFS.map((def) => {
    const field = dailyFieldFor(def.key);
    const pick = (date: string): number | null =>
      field === null ? sleepByDate.get(date) ?? null : dailyValue(date, field);
    const monthValues: number[] = [];
    const missingDates: string[] = [];
    for (const date of monthDates) {
      if (isExcludedDate(date)) continue;
      const value = pick(date);
      if (value !== null) monthValues.push(value);
      else missingDates.push(date);
    }
    const monthMeanRaw = monthReviewMean(monthValues);
    const { baselineRaw, days: baselineDays } = field === null ? sleepBaseline() : dailyBaseline(field);
    const baselineSufficient = baselineRaw !== null;
    const judgeable = baselineSufficient && monthMeanRaw !== null && monthValues.length >= MONTH_REVIEW_MIN_VALID_DAYS;
    const offsetRaw = judgeable && monthMeanRaw !== null && baselineRaw !== null ? monthMeanRaw - baselineRaw : null;
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      digits: def.digits,
      monthMean: monthMeanRaw === null ? null : monthReviewRound(monthMeanRaw, def.digits),
      validDays: monthValues.length,
      missingDates,
      baseline: baselineRaw === null ? null : monthReviewRound(baselineRaw, def.digits),
      baselineDays,
      baselineSufficient,
      offset: offsetRaw === null ? null : monthReviewRound(offsetRaw, def.digits),
      direction: offsetRaw !== null && baselineRaw !== null ? monthReviewDirection(def.key, offsetRaw, baselineRaw) : null,
      judgeable,
    };
  });

  return {
    monthLabel,
    monthStart,
    monthEnd,
    monthDays,
    anchorDate: input.anchorDate,
    minValidDays: MONTH_REVIEW_MIN_VALID_DAYS,
    statusExcludedDates,
    metrics,
  };
}
