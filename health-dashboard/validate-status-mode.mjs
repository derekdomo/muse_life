// H4.4 状态模式 (status mode) validation.
// Runs the REAL production pure module (server/src/status-mode.ts —
// no imports, all logic exported) over synthetic fixtures only; no
// real health data is ever used. Covers: (1) readiness suppression
// inside a status period (score/grade/summary replaced by the status
// note, start AND end dates inclusive, the day before/after
// untouched), (2) baseline exclusion (status dates removed from
// dated rows exactly, boundaries included), (3) anomaly/conclusion
// gaps (marks + gap dates inside a window; nothing outside), (4)
// trend marks (symbol + mode text per covered date, clipped to the
// window, deterministic under overlap), and (5) start/end boundary
// behaviour + legacy compatibility (no periods = total no-op;
// single-day periods; invalid stored rows ignored everywhere).
// Three source mutations are executed for real (end date made
// exclusive, suppression disabled, exclusion disabled) and each must
// flip its corresponding assertion. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const statusSrc = readFileSync(new URL('./server/src/status-mode.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('./drizzle/0019_add_status_period.sql', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function buildModule(src) {
  const code = stripTypeScriptTypes(src.replace(/^export /gm, ''));
  return new Function(`${code}\nreturn { STATUS_MODES, STATUS_MODE_SYMBOLS, STATUS_MODE_DESCRIPTIONS, statusIsKnownMode, statusIsRealDate, isValidStatusPeriod, statusPeriodForDate, isStatusDate, excludeStatusDates, statusNoteFor, suppressReadinessForStatus, statusMarksForWindow, statusDatesInWindow, buildStatusModeView };`)();
}
const M = buildModule(statusSrc);
const {
  STATUS_MODES, STATUS_MODE_SYMBOLS, isValidStatusPeriod, statusPeriodForDate, isStatusDate,
  excludeStatusDates, suppressReadinessForStatus, statusMarksForWindow, statusDatesInWindow, buildStatusModeView,
} = M;

// ------------------------------------------------------------ source checks
check('source: status module has no imports (pure module)', !/^import /m.test(statusSrc));
check('source: server imports the pure status-mode module',
  serverSrc.includes('from "./status-mode"') && serverSrc.includes('suppressReadinessForStatus') && serverSrc.includes('buildStatusModeView'));
check('source: schema + migration add the status_period table additively (new table only, nothing altered or dropped)',
  schemaSrc.includes('statusPeriod = sqliteTable("status_period"')
  && migrationSrc.includes('CREATE TABLE `status_period`')
  && !/DROP|ALTER TABLE/.test(migrationSrc));
check('source: getDashboard response carries the additive statusMode field built from the loaded periods',
  serverSrc.includes('statusMode: statusModeSchema') && serverSrc.includes('buildStatusModeView(statusPeriods, readinessDate'));
check('source: calculateReadiness excludes status dates from the daily baseline window and the sleep baseline',
  serverSrc.includes('excludeStatusDates(snapshot.historyDaily.filter((row) => row.date < snapshot.dataDate).slice(-14), statusPeriods)')
  && serverSrc.includes('excludeStatusDates(sleepHistory, statusPeriods)'));
check('source: a suppressed readiness is not archived (the date stays a trend gap)',
  serverSrc.includes('if (!readinessSuppressed)') && serverSrc.includes('statusPeriodForDate(statusPeriods, readinessDate)'));
check('source: save/delete status period actions exist behind the strict owner gate (forbidden before any write)',
  serverSrc.includes('saveStatusPeriod: defineAction({') && serverSrc.includes('deleteStatusPeriod: defineAction({')
  && serverSrc.includes('if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可设置状态", periodId: null }')
  && serverSrc.includes('if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可删除状态", periodId: null }'));
check('source: the readiness status enum gains 状态期 (never produced by tierFor)',
  serverSrc.includes('"状态期"')
  && (() => { const start = serverSrc.indexOf('function tierFor'); const body = serverSrc.slice(start, serverSrc.indexOf('}', start) + 1); return start >= 0 && !body.includes('状态期'); })());
check('source: every defineAction carries a v26 description',
  (serverSrc.match(/defineAction\(\{/g) ?? []).length === (serverSrc.match(/description: "/g) ?? []).length,
  `${(serverSrc.match(/defineAction\(\{/g) ?? []).length} actions`);
check('source: client renders the management panel, saves through the new actions, and marks from the server view only',
  clientSrc.includes('function StatusModePanel') && clientSrc.includes('api.saveStatusPeriod') && clientSrc.includes('api.deleteStatusPeriod')
  && clientSrc.includes('statusMarkMap') && clientSrc.includes('状态期 ·'));
check('source: the three modes and their symbols are the briefed set',
  JSON.stringify(STATUS_MODES) === JSON.stringify(['生病', '受伤', '旅行'])
  && STATUS_MODE_SYMBOLS['生病'] === '✚' && STATUS_MODE_SYMBOLS['受伤'] === '✖' && STATUS_MODE_SYMBOLS['旅行'] === '✈');

// ------------------------------------------------------------ fixtures
const SICK = { id: 1, mode: '生病', startDate: '2026-11-03', endDate: '2026-11-05' };
const TRAVEL = { id: 2, mode: '旅行', startDate: '2026-10-10', endDate: '2026-10-12' };
const readinessOn = (date, score = 7.5) => ({
  date, score, objectiveScore: score, status: '准备就绪', summary: '可用信号整体接近个人滚动基线。',
  adjustments: ['主观晨检 6/10：仅向保守方向修正'], signalCount: 5,
  components: [{ key: 'hrv', label: 'HRV', weight: 32.5, score: 7, zScore: 1, contribution: 0.5, raw: '50.0 ms', baseline: '基线', detail: 'ln(HRV) z +1.00', missingLabel: null }],
  radar: [{ key: 'sleep', label: '睡眠', score: 7 }],
});

// ------------------------------------------- (1) readiness suppression
{
  const before = readinessOn('2026-11-02');
  check('suppress: the day before the period is returned untouched (identical reference, score and grade intact)',
    suppressReadinessForStatus(before, [SICK]) === before && before.score === 7.5 && before.status === '准备就绪');
  const first = suppressReadinessForStatus(readinessOn('2026-11-03'), [SICK]);
  check('suppress: the start date is suppressed — no score, no grade, status is 状态期',
    first.score === null && first.objectiveScore === null && first.status === '状态期' && first.signalCount === 0 && first.adjustments.length === 0);
  check('suppress: the summary becomes the status note (mode + start/end dates + one-line description)',
    first.summary.includes('生病') && first.summary.includes('2026-11-03') && first.summary.includes('2026-11-05') && first.summary.includes('不评训练等级'));
  check('suppress: component scores are nulled so no surface can resurrect a grade from the parts',
    first.components[0].score === null && first.components[0].zScore === null && first.components[0].contribution === null && first.components[0].detail === '状态期不评估');
  const last = suppressReadinessForStatus(readinessOn('2026-11-05'), [SICK]);
  check('suppress: the end date is suppressed too (both boundaries inclusive)',
    last.score === null && last.status === '状态期');
  const after = readinessOn('2026-11-06');
  check('suppress: the day after the period is untouched',
    suppressReadinessForStatus(after, [SICK]) === after && after.score === 7.5);
  const original = readinessOn('2026-11-04');
  suppressReadinessForStatus(original, [SICK]);
  check('suppress: suppression never mutates the computed readiness object',
    original.score === 7.5 && original.status === '准备就绪' && original.components[0].score === 7);
}

// ------------------------------------------- (2) baseline exclusion
{
  const rows = [
    { date: '2026-10-08', restingHr: 60 }, { date: '2026-10-09', restingHr: 60 },
    { date: '2026-10-10', restingHr: 99 }, { date: '2026-10-11', restingHr: 99 }, { date: '2026-10-12', restingHr: 99 },
    { date: '2026-10-13', restingHr: 60 }, { date: '2026-10-14', restingHr: 60 },
  ];
  const kept = excludeStatusDates(rows, [TRAVEL]);
  check('baseline: exactly the status dates are removed from the baseline rows (boundaries inclusive)',
    kept.length === 4 && kept.every((row) => row.restingHr === 60)
    && kept.map((row) => row.date).join(',') === '2026-10-08,2026-10-09,2026-10-13,2026-10-14');
  check('baseline: the surviving baseline mean is the non-status mean (60), unpolluted by the status days (99)',
    kept.reduce((sum, row) => sum + row.restingHr, 0) / kept.length === 60);
  check('baseline: isStatusDate agrees on the day before, the boundaries, and the day after',
    !isStatusDate([TRAVEL], '2026-10-09') && isStatusDate([TRAVEL], '2026-10-10')
    && isStatusDate([TRAVEL], '2026-10-12') && !isStatusDate([TRAVEL], '2026-10-13'));
  check('baseline: exclusion returns a filtered copy — the stored rows array is never mutated',
    rows.length === 7 && kept !== rows && rows[2].restingHr === 99);
}

// ------------------------------------------- (3) conclusion gaps + (4) marks
{
  const view = buildStatusModeView([TRAVEL], '2026-10-11', '2026-10-09', '2026-10-13');
  check('gap: an anchor inside the period is active + suppressed with the status note',
    view.active?.id === 2 && view.suppressed === true && view.note !== null && view.note.includes('旅行') && view.note.includes('2026-10-10') && view.note.includes('2026-10-12'));
  check('marks: every covered date in the window carries symbol + mode, clipped to the window, ascending',
    view.marks.length === 3
    && view.marks.map((mark) => mark.date).join(',') === '2026-10-10,2026-10-11,2026-10-12'
    && view.marks.every((mark) => mark.mode === '旅行' && mark.symbol === '✈'));
  check('gap: statusDatesInWindow returns exactly the marked dates as the conclusion gap set',
    statusDatesInWindow([TRAVEL], '2026-10-09', '2026-10-13').join(',') === '2026-10-10,2026-10-11,2026-10-12'
    && statusDatesInWindow([TRAVEL], '2026-10-13', '2026-10-20').length === 0);
  const outside = buildStatusModeView([TRAVEL], '2026-10-20', '2026-10-14', '2026-10-20');
  check('gap: an anchor outside every period suppresses nothing and marks nothing',
    outside.active === null && outside.suppressed === false && outside.note === null && outside.marks.length === 0 && outside.periods.length === 1);
  const clipped = statusMarksForWindow([{ id: 9, mode: '受伤', startDate: '2026-10-01', endDate: '2026-10-31' }], '2026-10-30', '2026-11-02');
  check('marks: a long period marks only its in-window dates, across the month boundary',
    clipped.map((mark) => mark.date).join(',') === '2026-10-30,2026-10-31' && clipped.every((mark) => mark.symbol === '✖'));
}

// ------------------------------------------- (5) boundaries + legacy compatibility
{
  const empty = buildStatusModeView([], '2026-11-03', '2026-10-27', '2026-11-03');
  const plain = readinessOn('2026-11-03');
  check('legacy: with no periods at all (every pre-H4.4 database) the view is empty and nothing is suppressed, excluded, or marked',
    empty.periods.length === 0 && empty.active === null && empty.suppressed === false && empty.note === null && empty.marks.length === 0
    && suppressReadinessForStatus(plain, []) === plain
    && excludeStatusDates([{ date: '2026-11-03' }], []).length === 1);
  const single = { id: 7, mode: '受伤', startDate: '2026-11-04', endDate: '2026-11-04' };
  check('boundary: a single-day period (start = end) covers exactly that day',
    isStatusDate([single], '2026-11-04') && !isStatusDate([single], '2026-11-03') && !isStatusDate([single], '2026-11-05')
    && suppressReadinessForStatus(readinessOn('2026-11-04'), [single]).status === '状态期');
  const invalid = [
    { id: 11, mode: '生病', startDate: '2026-11-05', endDate: '2026-11-03' },
    { id: 12, mode: '请假', startDate: '2026-11-03', endDate: '2026-11-05' },
    { id: 13, mode: '旅行', startDate: '2026-13-01', endDate: '2026-13-05' },
    { id: 14, mode: '旅行', startDate: 'not-a-date', endDate: '2026-11-05' },
  ];
  check('legacy: invalid stored rows (end before start, unknown mode, malformed dates) are ignored by every derivation',
    invalid.every((row) => !isValidStatusPeriod(row))
    && statusPeriodForDate(invalid, '2026-11-04') === null
    && suppressReadinessForStatus(readinessOn('2026-11-04'), invalid).score === 7.5
    && statusMarksForWindow(invalid, '2026-11-01', '2026-11-07').length === 0
    && buildStatusModeView(invalid, '2026-11-04', '2026-11-01', '2026-11-07').periods.length === 0);
  const overlap = [
    { id: 5, mode: '旅行', startDate: '2026-11-04', endDate: '2026-11-06' },
    { id: 3, mode: '生病', startDate: '2026-11-03', endDate: '2026-11-05' },
  ];
  check('boundary: overlapping periods resolve deterministically — earliest start wins, on every surface',
    statusPeriodForDate(overlap, '2026-11-04')?.mode === '生病'
    && statusMarksForWindow(overlap, '2026-11-04', '2026-11-04')[0]?.mode === '生病'
    && suppressReadinessForStatus(readinessOn('2026-11-04'), overlap).summary.includes('生病'));
  check('boundary: a malformed query date is covered by nothing',
    statusPeriodForDate([SICK], '2026-02-30') === null && statusPeriodForDate([SICK], 'junk') === null);
}

// ------------------------------------------------------- mutation sensitivity
{
  const endExclusive = buildModule(statusSrc.replace('date <= period.endDate', 'date < period.endDate'));
  check('mutation setup: the end-exclusive mutant source actually differs', statusSrc.includes('date <= period.endDate'));
  const realLast = suppressReadinessForStatus(readinessOn('2026-11-05'), [SICK]);
  const mutantLast = endExclusive.suppressReadinessForStatus(readinessOn('2026-11-05'), [SICK]);
  check('mutation: making the end date exclusive flips the end-boundary suppression assertion',
    realLast.score === null && mutantLast.score === 7.5 && mutantLast.status === '准备就绪');

  const noSuppress = buildModule(statusSrc.replace('if (!period) return readiness;', 'if (true) return readiness;'));
  check('mutation setup: the suppression-off mutant source actually differs', statusSrc.includes('if (!period) return readiness;'));
  const realMid = suppressReadinessForStatus(readinessOn('2026-11-04'), [SICK]);
  const mutantMid = noSuppress.suppressReadinessForStatus(readinessOn('2026-11-04'), [SICK]);
  check('mutation: disabling suppression flips the in-period suppression assertion',
    realMid.score === null && realMid.status === '状态期' && mutantMid.score === 7.5 && mutantMid.status === '准备就绪');

  const noExclude = buildModule(statusSrc.replace('!isStatusDate(periods, row.date)', 'true'));
  check('mutation setup: the exclusion-off mutant source actually differs', statusSrc.includes('!isStatusDate(periods, row.date)'));
  const rows = [
    { date: '2026-10-09', restingHr: 60 }, { date: '2026-10-10', restingHr: 99 },
    { date: '2026-10-11', restingHr: 99 }, { date: '2026-10-13', restingHr: 60 },
  ];
  const realKept = excludeStatusDates(rows, [TRAVEL]);
  const mutantKept = noExclude.excludeStatusDates(rows, [TRAVEL]);
  check('mutation: disabling exclusion flips the baseline-exclusion assertion',
    realKept.length === 2 && mutantKept.length === 4);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
