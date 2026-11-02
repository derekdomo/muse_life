// H4.4 状态模式 (status mode), borrowed from Oura Rest Mode / Gentler
// Streak Set Status. This module is PURE: it has no imports, performs
// no I/O, and reads no clock — every input arrives as an argument, so
// repo-side validation (validate-status-mode.mjs) can load it verbatim
// and run it over synthetic fixtures.
//
// The owner may declare a status period — 生病 / 受伤 / 旅行 — with an
// inclusive start and end date, stored in the status_period table and
// written only through the owner-gated saveStatusPeriod /
// deleteStatusPeriod actions (the same gate semantics as
// saveMorningCheckin). This module turns those stored periods into
// every derived fact the dashboard needs; the client only renders:
//
// - Suppression: a readiness whose date falls inside a period is
//   replaced by the status note (mode + start/end + a one-line
//   description). No score, no grade/status tier, no 今日结论 — the
//   caller also skips archiving that date, so it stays a gap in the
//   readiness trend instead of a number.
// - Baseline exclusion: rows dated inside a period are removed from
//   the readiness baseline windows (calculateReadiness filters its
//   already-selected baseline rows through excludeStatusDates). The
//   readiness formula itself is untouched — only its baseline inputs
//   lose the status days.
// - Conclusion gaps: status dates inside a conclusion window are
//   reported as marks/gaps (statusMarksForWindow / the view's marks),
//   so trend conclusions name the gap and draw no conclusion from
//   those days.
// - Marks: every date inside a period carries { mode, symbol } so
//   trend charts and per-day fact strips can label it with symbol +
//   text together — meaning never rides on color alone (the owner's
//   color-vision rule).
//
// Scope red line (PM review): NO recovery-progress or recovery-
// reference rule exists here. A status period never yields a
// "recovered %" / "back to baseline" judgement of any kind; it only
// suppresses, excludes, and marks. Periods are validated strictly
// (known mode, real YYYY-MM-DD dates, start ≤ end); an invalid stored
// row is ignored by every function below — it can never suppress,
// exclude, or mark anything. With no periods at all (every database
// created before this feature, and every owner who never sets one)
// every function is a no-op: readiness, baselines, and trends behave
// exactly as they did before H4.4.

export const STATUS_MODES = ["生病", "受伤", "旅行"] as const;

export type StatusModeKind = (typeof STATUS_MODES)[number];

// One symbol per mode, always rendered TOGETHER with the mode's text
// name — the symbol alone never carries the meaning.
export const STATUS_MODE_SYMBOLS: Record<StatusModeKind, string> = {
  "生病": "✚",
  "受伤": "✖",
  "旅行": "✈",
};

// The one-line description shown with the status note. It states only
// what the mode DOES in this dashboard (no grade, no baseline, no
// conclusion for those days) — never a recovery judgement or advice.
export const STATUS_MODE_DESCRIPTIONS: Record<StatusModeKind, string> = {
  "生病": "生病期间不评训练等级，这段时间不进基线、不下结论，只作记录。",
  "受伤": "受伤期间不评训练等级，这段时间不进基线、不下结论，只作记录。",
  "旅行": "旅行期间作息与日常不同，不评训练等级，这段时间不进基线、不下结论，只作记录。",
};

export interface StatusPeriod {
  id: number;
  mode: StatusModeKind;
  startDate: string;
  endDate: string;
}

export interface StatusMark {
  date: string;
  mode: StatusModeKind;
  symbol: string;
}

export interface StatusModeView {
  // Every valid stored period, newest start first — the management
  // list the owner edits. Never fabricated: no rows, empty list.
  periods: StatusPeriod[];
  // The period covering the anchor (readiness) date, or null.
  active: StatusPeriod | null;
  // True exactly when `active` is non-null: the readiness for the
  // anchor date is suppressed to the status note.
  suppressed: boolean;
  // The full status note for the anchor date (mode + dates +
  // description), or null when not suppressed.
  note: string | null;
  // The active mode's one-line description, or null.
  description: string | null;
  // Symbol+text marks for every status date inside the requested
  // window, ascending by date.
  marks: StatusMark[];
}

export function statusIsKnownMode(value: string): value is StatusModeKind {
  return (STATUS_MODES as readonly string[]).includes(value);
}

export function statusIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function statusShiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// A stored period participates only when it is fully well-formed:
// a known mode, two real calendar dates, and start ≤ end. Anything
// else (a corrupt or hand-edited row) is ignored everywhere — legacy
// databases simply have no rows, which this treats as "no status".
export function isValidStatusPeriod(period: StatusPeriod): boolean {
  return statusIsKnownMode(period.mode)
    && statusIsRealDate(period.startDate)
    && statusIsRealDate(period.endDate)
    && period.startDate <= period.endDate;
}

// Deterministic order for overlap resolution: earliest start first,
// then lowest id. When periods overlap, the SAME period wins for a
// date on every surface, every time.
function sortedValidPeriods(periods: readonly StatusPeriod[]): StatusPeriod[] {
  return periods
    .filter((period) => isValidStatusPeriod(period))
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.id - b.id));
}

// The period covering `date`, both boundary dates INCLUSIVE, or null.
// A malformed query date is covered by nothing.
export function statusPeriodForDate(periods: readonly StatusPeriod[], date: string): StatusPeriod | null {
  if (!statusIsRealDate(date)) return null;
  for (const period of sortedValidPeriods(periods)) {
    if (period.startDate <= date && date <= period.endDate) return period;
  }
  return null;
}

export function isStatusDate(periods: readonly StatusPeriod[], date: string): boolean {
  return statusPeriodForDate(periods, date) !== null;
}

// The baseline-exclusion primitive: drop every row whose date falls
// inside a status period. calculateReadiness applies this to its
// baseline windows only — the rows themselves stay stored and stay
// visible as facts everywhere else.
export function excludeStatusDates<T extends { date: string }>(rows: readonly T[], periods: readonly StatusPeriod[]): T[] {
  if (!periods.length) return [...rows];
  return rows.filter((row) => !isStatusDate(periods, row.date));
}

// The status note: mode name + start/end dates + the one-line
// description. This exact line replaces the readiness score, grade,
// and 今日结论 for a suppressed date.
export function statusNoteFor(period: StatusPeriod): string {
  return `${period.mode}（${period.startDate} 至 ${period.endDate}）：${STATUS_MODE_DESCRIPTIONS[period.mode]}`;
}

// The structural minimum of a readiness object this module may
// suppress. Extra fields ride through the spread untouched.
export interface SuppressibleReadiness {
  date: string;
  score: number | null;
  objectiveScore: number | null;
  status: string;
  summary: string;
  adjustments: string[];
  signalCount: number;
  components: Array<{ score: number | null; zScore: number | null; contribution: number | null; detail: string; [key: string]: unknown }>;
  radar: Array<{ score: number; [key: string]: unknown }>;
}

// Suppress one computed readiness to its status note when its date
// falls inside a status period: score and objective score become
// null, the status becomes 状态期 (never a training grade), the
// summary becomes the status note, and every component score is
// nulled so no surface can resurrect a grade from the parts. The
// radar falls back to the neutral 5 the readiness code itself uses
// for "no signal". Outside a period the object is returned AS IS —
// the identical reference, so non-status days are provably untouched.
export function suppressReadinessForStatus<T extends SuppressibleReadiness>(readiness: T, periods: readonly StatusPeriod[]): T {
  const period = statusPeriodForDate(periods, readiness.date);
  if (!period) return readiness;
  return {
    ...readiness,
    score: null,
    objectiveScore: null,
    status: "状态期",
    summary: statusNoteFor(period),
    adjustments: [],
    signalCount: 0,
    components: readiness.components.map((component) => ({
      ...component,
      score: null,
      zScore: null,
      contribution: null,
      detail: "状态期不评估",
    })),
    radar: readiness.radar.map((dimension) => ({ ...dimension, score: 5 })),
  };
}

// Symbol+text marks for every status date inside [windowStart,
// windowEnd] (both inclusive), ascending. Dates outside every period
// get no mark; the window is clipped against each period, so a long
// period marks only its in-window dates. The enumeration is bounded
// (at most 400 days) so a pathological window cannot loop forever.
export function statusMarksForWindow(periods: readonly StatusPeriod[], windowStart: string, windowEnd: string): StatusMark[] {
  if (!statusIsRealDate(windowStart) || !statusIsRealDate(windowEnd) || windowStart > windowEnd) return [];
  const marks: StatusMark[] = [];
  let date = windowStart;
  for (let guard = 0; date <= windowEnd && guard < 400; guard += 1) {
    const period = statusPeriodForDate(periods, date);
    if (period) marks.push({ date, mode: period.mode, symbol: STATUS_MODE_SYMBOLS[period.mode] });
    date = statusShiftDate(date, 1);
  }
  return marks;
}

// The gap dates of a conclusion window: exactly the marked dates.
// A conclusion over a window containing these dates must name them
// as gaps and draw nothing from them.
export function statusDatesInWindow(periods: readonly StatusPeriod[], windowStart: string, windowEnd: string): string[] {
  return statusMarksForWindow(periods, windowStart, windowEnd).map((mark) => mark.date);
}

// Assemble the dashboard's status-mode view from the stored periods.
// `anchorDate` is the readiness date the suppression decision belongs
// to (null when no health snapshot exists — then nothing is
// suppressed and no marks are produced, but the stored periods still
// list for management). The marks window is the caller's display
// window; pass null bounds for no marks.
export function buildStatusModeView(
  periods: readonly StatusPeriod[],
  anchorDate: string | null,
  windowStart: string | null,
  windowEnd: string | null,
): StatusModeView {
  const valid = sortedValidPeriods(periods);
  const active = anchorDate === null ? null : statusPeriodForDate(valid, anchorDate);
  return {
    periods: [...valid].sort((a, b) => (a.startDate > b.startDate ? -1 : a.startDate < b.startDate ? 1 : b.id - a.id)),
    active,
    suppressed: active !== null,
    note: active ? statusNoteFor(active) : null,
    description: active ? STATUS_MODE_DESCRIPTIONS[active.mode] : null,
    marks: windowStart !== null && windowEnd !== null ? statusMarksForWindow(valid, windowStart, windowEnd) : [],
  };
}
