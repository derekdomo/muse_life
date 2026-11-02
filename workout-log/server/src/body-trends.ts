// W5.3: body weight + circumference trends against training
// aggregates, for the history / review view. Pure and
// self-contained (no imports, no IO), in the same style as
// progression-engine.ts / action-trends.ts / week-frequency.ts, so
// validation scripts can evaluate this file verbatim and run the
// real functions over synthetic data. The client only renders what
// this module computes.
//
// Scope — records and trends ONLY:
//   - Inputs are the owner's manually recorded body measurements
//     (one row per America/Los_Angeles calendar date) plus the
//     EXISTING training aggregates (per-week training volume and
//     per-week best working-set volume, computed by the caller
//     from workout records — never from the measurements).
//   - Output is a date-aligned comparison series: one point per
//     RECORDED measurement date (never a fabricated date), each
//     point carrying that date's recorded values verbatim and the
//     training aggregates of the Monday-start week containing it.
//   - A circumference the owner did not record stays null on its
//     point — never zero-filled, never carried forward from a
//     neighbouring date, never interpolated. A week with no
//     training aggregate stays null — never back-filled from the
//     measurements.
//   - Training figures NEVER mix in manual data: week volume and
//     week best-set volume pass through from the training input
//     untouched (unit conversion aside), and changing any
//     measurement changes no training figure.
//   - This module issues NO weight-loss / health conclusion, no
//     verdict, no label, no advice: its outputs are numbers, dates
//     and nulls only.

export const BODY_TRENDS_VERSION = 1;

// The same conversion constant the rest of the server uses
// (asserted equal to the engine's / trends' by validation).
export const LB_TO_KG = 0.45359237;

export type BodyTrendUnit = "lb" | "kg";

// One manually recorded measurement row, as stored. measuredAt is
// an America/Los_Angeles calendar date (YYYY-MM-DD). bodyWeight is
// always recorded (required at entry); every circumference is
// optional and null when the owner did not record it that day.
export type BodyMeasurementInput = {
  measuredAt: string;
  bodyWeight: number;
  unit: BodyTrendUnit;
  waist: number | null;
  chest: number | null;
  hips: number | null;
  arm: number | null;
  thigh: number | null;
};

// One week of EXISTING training aggregate, computed by the caller
// from completed workout records: volume is weight × reps summed
// over completed sets of that week, bestSetVolume is the largest
// single completed set's weight × reps of that week. Both are
// expressed in `unit`; both are null when the week has no such
// recorded set. weekStart / weekEnd are calendar dates
// (YYYY-MM-DD), Monday-start.
export type BodyTrainingWeekInput = {
  weekStart: string;
  weekEnd: string;
  unit: BodyTrendUnit;
  volume: number | null;
  bestSetVolume: number | null;
};

export type BodyTrendsInput = {
  measurements: BodyMeasurementInput[];
  trainingWeeks: BodyTrainingWeekInput[];
  // Every weight-derived figure in the output is expressed in this
  // unit (converted where a source row differed).
  displayUnit: BodyTrendUnit;
};

// One recorded date, aligned with its week's training aggregates.
// Circumferences pass through exactly as recorded (null stays
// null); bodyWeight is converted into the display unit.
export type BodyTrendPoint = {
  date: string;
  bodyWeight: number;
  waist: number | null;
  chest: number | null;
  hips: number | null;
  arm: number | null;
  thigh: number | null;
  // The Monday (YYYY-MM-DD) of the week containing `date`.
  weekStart: string;
  // That week's training aggregates (display unit), or null when
  // the caller supplied no aggregate for that week. Sourced ONLY
  // from the training input — never from the measurements.
  weekVolume: number | null;
  weekBestSetVolume: number | null;
};

// One training week, converted into the display unit, in input
// order. Weeks with no measurement still appear here so the UI can
// draw the training series continuously alongside the points.
export type BodyTrendWeek = {
  weekStart: string;
  weekEnd: string;
  volume: number | null;
  bestSetVolume: number | null;
};

export type BodyTrendsResult = {
  displayUnit: BodyTrendUnit;
  points: BodyTrendPoint[];
  weeks: BodyTrendWeek[];
  trendsVersion: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyToMs(dateKey: string): number {
  const [y = 1970, m = 1, d = 1] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function msToDateKey(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// The Monday (YYYY-MM-DD) of the Monday-start calendar week
// containing a calendar date — the same Monday rule week-frequency
// uses. Pure calendar math on the date key itself, so no timezone
// can shift the alignment.
export function bodyTrendWeekStart(dateKey: string): string {
  const dayMs = dateKeyToMs(dateKey);
  const dow = new Date(dayMs).getUTCDay(); // 0 = Sunday
  return msToDateKey(dayMs - ((dow + 6) % 7) * DAY_MS);
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

// Same conversion as the progression engine / action trends:
// null stays null, same-unit is identity, otherwise LB_TO_KG with
// 0.5 rounding.
export function convertBodyWeight(
  weight: number | null,
  from: BodyTrendUnit,
  to: BodyTrendUnit,
): number | null {
  if (weight == null || from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return roundHalf(converted);
}

export function buildBodyTrends(input: BodyTrendsInput): BodyTrendsResult {
  const { displayUnit } = input;

  // Training weeks, converted into the display unit. Values pass
  // through from the training input only — a null stays null and
  // no measurement ever contributes to them.
  const weeks: BodyTrendWeek[] = input.trainingWeeks.map((week) => ({
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    volume: convertBodyWeight(week.volume, week.unit, displayUnit),
    bestSetVolume: convertBodyWeight(week.bestSetVolume, week.unit, displayUnit),
  }));
  const weekByStart = new Map<string, BodyTrendWeek>();
  for (const week of weeks) weekByStart.set(week.weekStart, week);

  // One point per recorded date. The store keeps a single row per
  // date (same-day saves upsert); if a caller still passes two
  // rows for one date, the LAST one wins — the same overwrite rule
  // as the save itself. Points are emitted oldest first.
  const byDate = new Map<string, BodyMeasurementInput>();
  for (const row of input.measurements) byDate.set(row.measuredAt, row);
  const dates = [...byDate.keys()].sort();

  const points: BodyTrendPoint[] = dates.map((date) => {
    const row = byDate.get(date);
    if (!row) throw new Error(`body trend point missing for ${date}`);
    const weekStart = bodyTrendWeekStart(date);
    const week = weekByStart.get(weekStart) ?? null;
    return {
      date,
      bodyWeight: convertBodyWeight(row.bodyWeight, row.unit, displayUnit) ?? row.bodyWeight,
      waist: row.waist,
      chest: row.chest,
      hips: row.hips,
      arm: row.arm,
      thigh: row.thigh,
      weekStart,
      weekVolume: week ? week.volume : null,
      weekBestSetVolume: week ? week.bestSetVolume : null,
    };
  });

  return { displayUnit, points, weeks, trendsVersion: BODY_TRENDS_VERSION };
}
