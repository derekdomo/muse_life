// H-SWIM-VIS-001 validation (presentation layer: swimming visibility).
// Runs the REAL production functions (swimInfoByDate / swimDayLabel /
// swimDayDetail / swimWeekSummary) extracted verbatim from
// health-dashboard/client/src/App.tsx, plus source checks on the
// SevenDayFacts and TodayView wiring. Pure Node, no deps.
//
// H-SWIM-PRIV-001: fixtures are FULLY SYNTHETIC and unrelated to any
// real record (invented calendar 2027-03, invented distances/durations).
// The original reconciliation against real data-layer values was done
// only in the private runtime and is not recorded in this repository.
// Shape: 4 swim days in historyDaily, 12 historyWorkouts of which 7
// swimming, and exactly 2 swims inside the trailing 7-day window.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const srcPath = process.argv[2] ?? new URL('./client/src/App.tsx', import.meta.url);
const clientSrc = readFileSync(srcPath, 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  // Candidate body braces: every '{' after the parameter list at
  // angle-bracket depth 0. An object-literal return type (Map<string, {…}>
  // or a bare { … }) contributes its own braces before the real body, so
  // probe each candidate: the right one strips to a callable function.
  let angle = 0;
  let braceDepth = 0;
  const candidates = [];
  for (let i = closeParen + 1; i < source.length && candidates.length < 6; i++) {
    const ch = source[i];
    if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === '{') {
      if (angle === 0 && braceDepth === 0) candidates.push(i);
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth < 0) break;
    }
  }
  for (const bodyStart of candidates) {
    const bodyEnd = matchDelim(source, bodyStart, '{', '}');
    const slice = source.slice(idx, bodyEnd + 1);
    try {
      const fn = new Function(`${stripTypeScriptTypes(slice)}\nreturn typeof ${name} === 'function' ? ${name} : null;`)();
      if (typeof fn === 'function') return slice;
    } catch { /* not the body brace — try the next candidate */ }
  }
  throw new Error(`body of ${name} not found`);
}
function buildFns(src) {
  const parts = ['numberLabel', 'isSwimWorkout', 'swimInfoByDate', 'swimDayLabel', 'swimDayDetail', 'swimWeekSummary']
    .map((name) => extractFunction(src, name));
  return new Function(`${stripTypeScriptTypes(parts.join('\n'))}\nreturn { swimInfoByDate, swimDayLabel, swimDayDetail, swimWeekSummary };`)();
}
const { swimInfoByDate, swimDayLabel, swimDayDetail, swimWeekSummary } = buildFns(clientSrc);

// ------------------------------------------------------------- fixtures
// historyDaily rows: only date + swimMeters are read by swimInfoByDate.
const historyDaily = [
  { date: '2027-03-02', swimMeters: null },
  { date: '2027-03-03', swimMeters: 425 },
  { date: '2027-03-04', swimMeters: 510 },
  { date: '2027-03-05', swimMeters: null },
  { date: '2027-03-06', swimMeters: null },
  { date: '2027-03-07', swimMeters: 0 },
  { date: '2027-03-08', swimMeters: null },
  { date: '2027-03-09', swimMeters: 380 },
  { date: '2027-03-10', swimMeters: null },
  { date: '2027-03-11', swimMeters: 640 },
];
// 12 sessions, 7 swimming (synthetic shape). The 5 non-swim sessions
// all fall outside the last-7 window (2027-03-05–03-11), so the window
// holds exactly the 2 in-window swims.
const historyWorkouts = [
  { id: 'w01', date: '2027-02-14', type: 'swimming', distanceMeters: 455, durationMinutes: 16 },
  { id: 'w02', date: '2027-02-19', type: 'swimming', distanceMeters: 590, durationMinutes: 21 },
  { id: 'w03', date: '2027-02-24', type: 'swimming', distanceMeters: 470, durationMinutes: 15 },
  { id: 'w04', date: '2027-02-26', type: 'walking', distanceMeters: 3200, durationMinutes: 41 },
  { id: 'w05', date: '2027-02-27', type: 'cycling', distanceMeters: 11500, durationMinutes: 44 },
  { id: 'w06', date: '2027-02-28', type: 'running', distanceMeters: 4800, durationMinutes: 29 },
  { id: 'w07', date: '2027-03-01', type: 'elliptical', distanceMeters: null, durationMinutes: 24 },
  { id: 'w08', date: '2027-03-02', type: 'rowing', distanceMeters: 2100, durationMinutes: 14 },
  { id: 'w09', date: '2027-03-03', type: 'swimming', distanceMeters: 425, durationMinutes: 15 },
  { id: 'w10', date: '2027-03-04', type: 'swimming', distanceMeters: 510, durationMinutes: 24 },
  { id: 'w11', date: '2027-03-09', type: 'swimming', distanceMeters: 380, durationMinutes: 13 },
  { id: 'w12', date: '2027-03-11', type: 'swimming', distanceMeters: 640, durationMinutes: 27 },
];
const windowDates = ['2027-03-05', '2027-03-06', '2027-03-07', '2027-03-08', '2027-03-09', '2027-03-10', '2027-03-11'];

// -------------------------------------------- per-day reconciliation
const byDate = swimInfoByDate(historyDaily, historyWorkouts);
check('per-day: exactly the 4 synthetic swim dates are present',
  [...byDate.keys()].sort().join(',') === '2027-03-03,2027-03-04,2027-03-09,2027-03-11',
  [...byDate.keys()].sort().join(','));
const expected = {
  '2027-03-03': { meters: 425, minutes: 15 },
  '2027-03-04': { meters: 510, minutes: 24 },
  '2027-03-09': { meters: 380, minutes: 13 },
  '2027-03-11': { meters: 640, minutes: 27 },
};
for (const [date, exp] of Object.entries(expected)) {
  const info = byDate.get(date);
  check(`per-day ${date}: meters/minutes match data layer`,
    info !== undefined && info.meters === exp.meters && info.minutes === exp.minutes,
    JSON.stringify(info));
  check(`per-day ${date}: cell label`,
    info !== undefined && swimDayLabel(info) === `游泳 ${exp.meters} 米`,
    info ? swimDayLabel(info) : 'missing');
  check(`per-day ${date}: detail text`,
    info !== undefined && swimDayDetail(info) === `游泳 ${exp.meters} 米 · ${exp.minutes} 分`,
    info ? swimDayDetail(info) : 'missing');
}
check('per-day: swimMeters null day absent', !byDate.has('2027-03-08'));
check('per-day: swimMeters 0 day absent', !byDate.has('2027-03-07'));

// ------------------------------------------------- week summary (7d)
const week = swimWeekSummary(historyWorkouts, windowDates);
check('week: count is the 2 in-window swims', week.count === 2, `count=${week.count}`);
check('week: meters sum to 1020', week.meters === 1020, `meters=${week.meters}`);
check('week: metersKnown', week.metersKnown === true);
check('week: label', week.label === '近7天游泳 2 次 · 共 1,020 米', week.label);
// Subset consistency: every session inside the window is a swim, so
// swim count == total == 2.
const totalInWindow = historyWorkouts.filter((w) => windowDates.includes(w.date)).length;
check('week: swim count never exceeds total sessions in window (count7d basis)',
  week.count <= totalInWindow && totalInWindow === 2,
  `swim=${week.count} total=${totalInWindow}`);
// Widening the window must change the count (window really gates).
const wide = swimWeekSummary(historyWorkouts, historyWorkouts.map((w) => w.date));
check('week: widened window counts all 7 swims', wide.count === 7, `count=${wide.count}`);

// ------------------------------------------------------------ edges
const noDuration = swimInfoByDate(
  [{ date: '2027-03-11', swimMeters: 640 }],
  [{ id: 'x1', date: '2027-03-11', type: 'swimming', distanceMeters: 640, durationMinutes: null }],
);
check('edge: unknown duration -> minutes null',
  noDuration.get('2027-03-11')?.minutes === null);
check('edge: unknown duration -> detail says 时长未知',
  swimDayDetail(noDuration.get('2027-03-11')) === '游泳 640 米 · 时长未知',
  swimDayDetail(noDuration.get('2027-03-11')));
const noDistanceWeek = swimWeekSummary(
  [{ id: 'y1', date: '2027-03-09', type: 'swimming', distanceMeters: null, durationMinutes: 18 }],
  windowDates,
);
check('edge: no known distance -> label omits the meters segment',
  noDistanceWeek.count === 1 && noDistanceWeek.metersKnown === false && noDistanceWeek.label === '近7天游泳 1 次',
  noDistanceWeek.label);
check('edge: empty window -> empty label',
  swimWeekSummary(historyWorkouts, []).label === '');

// ------------------------------------------------------ source wiring
check('source: SevenDayFacts derives the swim map',
  clientSrc.includes('swimInfoByDate(snapshot.historyDaily, snapshot.historyWorkouts)'));
check('source: fact-strip cell renders the swim line class',
  clientSrc.includes('className="seven-facts-swim"'));
check('source: fact-strip detail has a 游泳 row',
  clientSrc.includes('<dt>游泳</dt>'));
check('source: TodayView workout line renders the swim summary class',
  clientSrc.includes('className="workout-swim-line"'));
check('source: TodayView derives the week summary',
  clientSrc.includes('swimWeekSummary(snapshot.historyWorkouts'));
check('source: SevenDayFacts still rendered exactly once',
  clientSrc.split('<SevenDayFacts snapshot={snapshot} />').length - 1 === 1);

// ------------------------------------------- mutation sensitivity
// Weakening the positive-meters gate inside swimInfoByDate (written as
// `swimMeters <= 0) continue`) must change the outcome: the swimMeters
// = 0 day (2027-03-07) would appear.
const fnSrc = extractFunction(clientSrc, 'swimInfoByDate');
const mutatedSrc = clientSrc.replace(fnSrc, fnSrc.replace('swimMeters <= 0', 'swimMeters < 0'));
check('mutation: gate pattern found in swimInfoByDate', mutatedSrc !== clientSrc);
if (mutatedSrc !== clientSrc) {
  const mutated = buildFns(mutatedSrc);
  const mutatedMap = mutated.swimInfoByDate(historyDaily, historyWorkouts);
  check('mutation: weakening the gate adds the 0-meter day',
    mutatedMap.has('2027-03-07') && !byDate.has('2027-03-07'));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
