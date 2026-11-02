// H4.3 睡眠债与今晚睡眠需求 (sleep debt + tonight's sleep need),
// borrowed from Whoop's published Sleep Need concept. This module is
// PURE: it has no imports, performs no I/O, and reads no clock — every
// input arrives as an argument, so repo-side validation
// (validate-sleep-debt.mjs) can load it verbatim and run it over
// synthetic fixtures.
//
// Data caliber: the inputs are the SAME sleep sessions every other
// panel reads — the health snapshot's historySleeps, already reduced
// by the caller to ONE main sleep per wake-up date (the deterministic
// CWEB-SLEEP-001 main-sleep selection) with its actual sleep duration
// (core + deep + REM; awake time is never part of actual sleep). No
// second data copy and no second sync path exist for this panel.
//
// Definitions (printed verbatim on the panel):
// - Window: the 14 calendar days ending at asOf (the readiness date —
//   the morning the owner wakes into "tonight"), inclusive. A date
//   inside the window with NO recorded session is MISSING: it is
//   counted and listed, contributes nothing to the debt sum, is never
//   filled with 0 hours, and is never backfilled with an older date's
//   session. Dates after asOf never enter any computation.
// - Personal baseline: the EXISTING long-term sleep-need caliber —
//   the same one readiness uses (`stats()` over the most recent 14
//   recorded nights on or before asOf): the plain mean of actual
//   sleep over the most recent ≤14 recorded nights, available only
//   when at least SLEEP_DEBT_BASELINE_MIN_NIGHTS (8) nights exist.
//   Fewer than 8 → baseline null and no debt/need numbers at all.
// - Cumulative sleep debt = Σ over the window's RECORDED nights of
//   (baseline − that night's actual sleep). The sum is signed: a
//   negative total is a sleep surplus (睡眠盈余), never clamped to 0.
// - Tonight's suggested sleep = baseline + tonight's repayment, where
//   repayment = min(SLEEP_DEBT_REPAY_CAP_HOURS, outstanding debt ×
//   SLEEP_DEBT_REPAY_SHARE) and outstanding debt counts only a
//   positive debt (a surplus adds nothing). Constants: share 25%,
//   cap +1.5 h.
// - Usual wake time: the median wake clock time over the baseline
//   nights that carry one; when none does, the fixed default 07:00
//   is used and flagged (usualWakeFromDefault) so the panel can say
//   so. Suggested bedtime = usual wake time − tonight's suggested
//   sleep, wrapped onto the clock (it normally lands the prior
//   evening).
// - Honesty: this is a routine/scheduling reference in the spirit of
//   Whoop Sleep Need — not Whoop's official number, not a medical
//   measurement, and not medical advice. Direction is always symbol
//   + word + signed hours (▲ 有睡眠债 / ▼ 睡眠盈余 / ● 基本持平), so
//   meaning never rides on color alone (the owner's color-vision
//   rule).

export const SLEEP_DEBT_WINDOW_DAYS = 14;
export const SLEEP_DEBT_BASELINE_MAX_NIGHTS = 14;
export const SLEEP_DEBT_BASELINE_MIN_NIGHTS = 8;
export const SLEEP_DEBT_REPAY_SHARE = 0.25;
export const SLEEP_DEBT_REPAY_CAP_HOURS = 1.5;
export const SLEEP_DEBT_BALANCED_TOLERANCE_HOURS = 0.5;
export const SLEEP_DEBT_DEFAULT_WAKE_MINUTES = 7 * 60;

export interface SleepDebtNightInput {
  // Wake-up calendar date (YYYY-MM-DD) of the night's main sleep.
  date: string;
  // Actual sleep that night in hours (core + deep + REM).
  hours: number;
  // Wake clock time as minutes since midnight, or null when the
  // session carries no usable wake time.
  wakeMinutes: number | null;
}

export interface SleepDebtStatus {
  symbol: string;
  word: string;
}

export interface SleepDebtResult {
  asOf: string;
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  // Distinct window dates with a recorded session / without one.
  recordedNights: number;
  missingNights: number;
  missingDates: string[];
  // Nights the baseline mean was computed over (≤ 14, most recent).
  baselineNights: number;
  baselineHours: number | null;
  // Signed cumulative debt in hours; null when the baseline is
  // unavailable or the window holds no recorded night at all.
  debtHours: number | null;
  status: SleepDebtStatus | null;
  // Tonight's repayment on top of the baseline (0 when the debt is
  // zero or a surplus); null whenever debtHours is null.
  extraTonightHours: number | null;
  suggestedSleepHours: number | null;
  // "HH:MM" clock strings; usualWakeTime is null only when asOf is
  // not a real date (the empty result).
  usualWakeTime: string | null;
  usualWakeFromDefault: boolean;
  suggestedBedtime: string | null;
  // True only when a baseline exists AND the window holds at least
  // one recorded night — the only state in which numbers are shown.
  sufficient: boolean;
}

export function sleepDebtIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function sleepDebtShiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function sleepDebtStatusFor(debtHours: number | null): SleepDebtStatus | null {
  if (debtHours === null || !Number.isFinite(debtHours)) return null;
  if (debtHours > SLEEP_DEBT_BALANCED_TOLERANCE_HOURS) return { symbol: "▲", word: "有睡眠债" };
  if (debtHours < -SLEEP_DEBT_BALANCED_TOLERANCE_HOURS) return { symbol: "▼", word: "睡眠盈余" };
  return { symbol: "●", word: "基本持平" };
}

export function formatClockMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const rest = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

// Suggested bedtime = wake time − sleep duration, on the clock: a
// 07:00 wake with an 8.75 h need lands at 22:15 (the prior evening).
export function suggestedBedtime(wakeMinutes: number, sleepHours: number): string {
  return formatClockMinutes(wakeMinutes - Math.round(sleepHours * 60));
}

function sleepDebtRound(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function computeSleepDebt(nights: SleepDebtNightInput[], asOf: string): SleepDebtResult {
  const windowEnd = asOf;
  const windowStart = sleepDebtIsRealDate(asOf) ? sleepDebtShiftDate(asOf, -(SLEEP_DEBT_WINDOW_DAYS - 1)) : asOf;
  const empty: SleepDebtResult = {
    asOf,
    windowStart,
    windowEnd,
    windowDays: SLEEP_DEBT_WINDOW_DAYS,
    recordedNights: 0,
    missingNights: SLEEP_DEBT_WINDOW_DAYS,
    missingDates: [],
    baselineNights: 0,
    baselineHours: null,
    debtHours: null,
    status: null,
    extraTonightHours: null,
    suggestedSleepHours: null,
    usualWakeTime: null,
    usualWakeFromDefault: false,
    suggestedBedtime: null,
    sufficient: false,
  };
  if (!sleepDebtIsRealDate(asOf)) return empty;

  // One night per wake-up date: if the caller ever passes duplicates,
  // the longest actual sleep wins (the main sleep), deterministically
  // and independent of array order. Future dates and unusable rows
  // never enter.
  const byDate = new Map<string, SleepDebtNightInput>();
  for (const night of nights) {
    if (!sleepDebtIsRealDate(night.date) || night.date > asOf) continue;
    if (!Number.isFinite(night.hours) || night.hours < 0) continue;
    const previous = byDate.get(night.date);
    if (!previous || night.hours > previous.hours) byDate.set(night.date, night);
  }
  const recorded = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Personal baseline — the existing long-term caliber: mean actual
  // sleep over the most recent ≤14 recorded nights, gated at ≥8.
  const baselineNights = recorded.slice(-SLEEP_DEBT_BASELINE_MAX_NIGHTS);
  const baselineRaw = baselineNights.length >= SLEEP_DEBT_BASELINE_MIN_NIGHTS
    ? baselineNights.reduce((sum, night) => sum + night.hours, 0) / baselineNights.length
    : null;

  // The 14-day calendar window: every date is either recorded or
  // missing. Missing dates are listed and skipped — the debt sum
  // below never sees them.
  const missingDates: string[] = [];
  let recordedInWindow = 0;
  for (let offset = 0; offset < SLEEP_DEBT_WINDOW_DAYS; offset += 1) {
    const date = sleepDebtShiftDate(windowStart, offset);
    if (byDate.has(date)) recordedInWindow += 1;
    else missingDates.push(date);
  }

  // Cumulative debt over the window's recorded nights only. A date
  // with no session contributes nothing: not 0 hours slept, not an
  // older session shifted forward.
  let debtRaw: number | null = null;
  if (baselineRaw !== null && recordedInWindow > 0) {
    debtRaw = 0;
    for (let offset = 0; offset < SLEEP_DEBT_WINDOW_DAYS; offset += 1) {
      const night = byDate.get(sleepDebtShiftDate(windowStart, offset));
      if (!night) continue;
      debtRaw += baselineRaw - night.hours;
    }
  }
  const debtHours = debtRaw === null ? null : sleepDebtRound(debtRaw);

  // Tonight: repay a share of the outstanding (positive) debt,
  // capped; a surplus never shortens tonight below the baseline.
  const extraRaw = debtRaw === null
    ? null
    : Math.min(SLEEP_DEBT_REPAY_CAP_HOURS, Math.max(0, debtRaw) * SLEEP_DEBT_REPAY_SHARE);
  const suggestedRaw = baselineRaw === null || extraRaw === null ? null : baselineRaw + extraRaw;

  // Usual wake time: median wake clock over the baseline nights that
  // carry one; the fixed 07:00 default (flagged) when none does.
  const wakeSamples = baselineNights
    .map((night) => night.wakeMinutes)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0 && value < 1440)
    .sort((a, b) => a - b);
  let usualWakeMinutes = SLEEP_DEBT_DEFAULT_WAKE_MINUTES;
  let usualWakeFromDefault = true;
  if (wakeSamples.length) {
    const mid = Math.floor(wakeSamples.length / 2);
    usualWakeMinutes = wakeSamples.length % 2 === 1
      ? (wakeSamples[mid] ?? SLEEP_DEBT_DEFAULT_WAKE_MINUTES)
      : Math.round(((wakeSamples[mid - 1] ?? 0) + (wakeSamples[mid] ?? 0)) / 2);
    usualWakeFromDefault = false;
  }

  return {
    asOf,
    windowStart,
    windowEnd,
    windowDays: SLEEP_DEBT_WINDOW_DAYS,
    recordedNights: recordedInWindow,
    missingNights: missingDates.length,
    missingDates,
    baselineNights: baselineNights.length,
    baselineHours: baselineRaw === null ? null : sleepDebtRound(baselineRaw),
    debtHours,
    status: sleepDebtStatusFor(debtHours),
    extraTonightHours: extraRaw === null ? null : sleepDebtRound(extraRaw),
    suggestedSleepHours: suggestedRaw === null ? null : sleepDebtRound(suggestedRaw),
    usualWakeTime: formatClockMinutes(usualWakeMinutes),
    usualWakeFromDefault,
    suggestedBedtime: suggestedRaw === null ? null : suggestedBedtime(usualWakeMinutes, suggestedRaw),
    sufficient: baselineRaw !== null && recordedInWindow > 0,
  };
}
