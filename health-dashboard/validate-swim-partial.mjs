// H-SWIM-VIS-001 partial semantics (space-4) validation.
// Runs the REAL production swim derivations extracted verbatim from
// client/src/App.tsx (swimInfoByDate / swimDayLabel / swimDayDetail /
// swimWeekSummary, plus their isSwimWorkout / numberLabel helpers)
// over SYNTHETIC fixtures only — invented dates in 2031 and invented
// distances/durations, deliberately unrelated to any real workout
// record. The rule under test: a known subset is never presented as
// the complete total. When part of a day (or of the week window) is
// unknown, the wording marks the known part as known and names the
// unknown remainder; unknowns are never summed as 0 and no total is
// fabricated. Covers the full boundary set: daily distance present
// with session detail missing / partial, sessions-only days with a
// null daily distance (visible count entry, distance shown as —, no
// fabricated total), a true daily 0 (never shown), mixed workout
// types, same-day duplicates, sparse multi-day gaps, and the shared
// dataDate-anchored 7-CALENDAR-day window (never the last 7 daily
// rows).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

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
  let bodyStart = source.indexOf('{', closeParen);
  while (bodyStart >= 0) {
    let prev = bodyStart - 1;
    while (prev > closeParen && /\s/.test(source[prev])) prev--;
    if (source[prev] !== ':') break;
    bodyStart = source.indexOf('{', matchDelim(source, bodyStart, '{', '}'));
  }
  if (bodyStart < 0) throw new Error(`function ${name} body not found`);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

const NAMES = ['isSwimWorkout', 'numberLabel', 'swimInfoByDate', 'swimDayLabel', 'swimDayDetail', 'swimWeekSummary'];
const code = NAMES.map((name) => stripTypeScriptTypes(extractFunction(clientSrc, name).replace(/^export /, ''))).join('\n');
const fns = new Function(`${code}\nreturn { ${NAMES.join(', ')} };`)();
const { swimInfoByDate, swimDayLabel, swimDayDetail, swimWeekSummary } = fns;

// ------------------------------------------------------------ fixtures
const D = (day) => `2031-06-${String(day).padStart(2, '0')}`; // invented June 2031 dates
const swim = (date, distanceMeters, durationMinutes, type = 'Swimming') => ({ date, type, distanceMeters, durationMinutes });
const daily = (date, swimMeters) => ({ date, swimMeters });

// ------------------------------------------------------------ day: complete data
{
  const info = swimInfoByDate([daily(D(10), 800)], [swim(D(10), 800, 30)]).get(D(10));
  check('day complete: meters from the daily row, minutes from the session, no unknowns',
    info.meters === 800 && info.minutes === 30 && info.sessionCount === 1
    && info.unknownDurationCount === 0 && info.unknownDistanceCount === 0);
  check('day complete: detail is the plain total wording (no partial marker)',
    swimDayDetail(info) === '游泳 800 米 · 30 分');
  check('day complete: short label shows the distance',
    swimDayLabel(info) === '游泳 800 米');
  const dup = swimInfoByDate([daily(D(10), 1100)], [swim(D(10), 500, 20), swim(D(10), 600, 25)]).get(D(10));
  check('day duplicates: two full sessions sum their KNOWN durations (45 分）, no partial marker',
    dup.minutes === 45 && dup.sessionCount === 2 && swimDayDetail(dup) === '游泳 1,100 米 · 45 分');
  const rounded = swimInfoByDate([daily(D(10), 300)], [swim(D(10), 150, 10.4), swim(D(10), 150, 10.4)]).get(D(10));
  check('day durations: fractional known durations sum then round (10.4 + 10.4 -> 21 分）',
    rounded.minutes === 21);
}

// ------------------------------------------------------------ day: partial data
{
  // THE defect case: two swims the same day, one fully known, one
  // all-null. The known subset must not pose as the day's total.
  const info = swimInfoByDate([daily(D(11), 800)], [swim(D(11), 800, 30), swim(D(11), null, null)]).get(D(11));
  check('day partial: unknown components are counted, not zeroed',
    info.sessionCount === 2 && info.unknownDurationCount === 1 && info.unknownDistanceCount === 1 && info.minutes === 30);
  check('day partial: detail marks the distance as the known part （已知，另有记录距离未知）',
    swimDayDetail(info).startsWith('游泳 800 米（已知，另有记录距离未知）'));
  check('day partial: detail marks the duration as known-part with counts （时长已知 30 分（共 2 次，1 次时长未知）)',
    swimDayDetail(info).includes('时长已知 30 分（共 2 次，1 次时长未知）'));
  check('day partial: detail never claims a complete duration total',
    !swimDayDetail(info).includes('· 30 分'));
  // All durations unknown but sessions exist.
  const noDur = swimInfoByDate([daily(D(12), 500)], [swim(D(12), 500, null), swim(D(12), null, null)]).get(D(12));
  check('day partial: every duration unknown -> minutes null with the session count named',
    noDur.minutes === null && swimDayDetail(noDur).includes('时长未知（共 2 次）'));
  // A known distance of exactly 0 is KNOWN (not an unknown).
  const zeroDist = swimInfoByDate([daily(D(13), 400)], [swim(D(13), 0, 15), swim(D(13), 400, 15)]).get(D(13));
  check('day partial: a recorded 0 distance counts as known (no distance-unknown marker)',
    zeroDist.unknownDistanceCount === 0 && !swimDayDetail(zeroDist).includes('距离未知'));
}

// ------------------------------------------------------------ day: boundary set
{
  // Daily distance present, session detail missing entirely.
  const aggOnly = swimInfoByDate([daily(D(14), 800)], []).get(D(14));
  check('boundary: daily distance with NO session detail still shows （时长未知， no partial counts invented)',
    aggOnly.meters === 800 && aggOnly.minutes === null && aggOnly.sessionCount === 0
    && swimDayDetail(aggOnly) === '游泳 800 米 · 时长未知');
  // Sessions only, daily distance null: visible count entry, no
  // fabricated distance — even though sessions carry distances.
  const sessOnly = swimInfoByDate([daily(D(15), null)], [swim(D(15), 700, 28), swim(D(15), 300, 12)]);
  const so = sessOnly.get(D(15));
  check('boundary: sessions-only day enters the map with meters null (no fabricated day total from session distances)',
    so !== undefined && so.meters === null && so.sessionCount === 2 && so.minutes === 40);
  check('boundary: sessions-only label is the count （游泳 2 次）, detail shows 距离 — and never a 米 total',
    swimDayLabel(so) === '游泳 2 次' && swimDayDetail(so).includes('距离 —') && !swimDayDetail(so).includes('米'));
  // Daily row absent entirely, sessions present: same treatment.
  const noRow = swimInfoByDate([], [swim(D(16), null, null)]).get(D(16));
  check('boundary: no daily row at all + one all-null session -> count entry, distance —, duration unknown',
    noRow.meters === null && noRow.sessionCount === 1 && swimDayDetail(noRow).includes('距离 —')
    && swimDayDetail(noRow).includes('时长未知（共 1 次）'));
  // A true daily 0 with no sessions is never shown.
  check('boundary: a true daily 0 (and no sessions) produces NO entry',
    swimInfoByDate([daily(D(17), 0)], []).has(D(17)) === false);
  check('boundary: a null daily distance with no sessions produces NO entry',
    swimInfoByDate([daily(D(17), null)], []).has(D(17)) === false);
  // A true daily 0 WITH sessions: the sessions still earn their entry.
  const zeroWithSessions = swimInfoByDate([daily(D(18), 0)], [swim(D(18), null, 20)]).get(D(18));
  check('boundary: daily 0 + a session -> the session entry stands (meters stays null, not 0)',
    zeroWithSessions !== undefined && zeroWithSessions.meters === null && zeroWithSessions.sessionCount === 1);
  // Mixed types on one day: only swims count as swim sessions.
  const mixed = swimInfoByDate([daily(D(19), 600)], [
    swim(D(19), 600, 25),
    { date: D(19), type: 'Running', distanceMeters: 5000, durationMinutes: 30 },
    { date: D(19), type: 'Cycling', distanceMeters: 20000, durationMinutes: 60 },
  ]).get(D(19));
  check('boundary: mixed workout types — non-swim sessions never enter the swim counts or minutes',
    mixed.sessionCount === 1 && mixed.minutes === 25 && mixed.unknownDurationCount === 0);
  // Sparse multi-day: entries exist only where evidence exists.
  const sparse = swimInfoByDate(
    [daily(D(20), 900), daily(D(23), null)],
    [swim(D(23), null, null)],
  );
  check('boundary: sparse days — gap days have no entry, evidenced days do',
    sparse.has(D(20)) && sparse.has(D(23)) && !sparse.has(D(21)) && !sparse.has(D(22)) && sparse.size === 2);
}

// ------------------------------------------------------------ week summary
const WINDOW = [D(14), D(15), D(16), D(17), D(18), D(19), D(20)]; // 7 calendar days
{
  const full = swimWeekSummary([swim(D(15), 1000, 40), swim(D(18), 1400, 50)], WINDOW);
  check('week complete: count + true total wording （共）',
    full.count === 2 && full.meters === 2400 && full.metersKnown === true && full.unknownDistanceCount === 0
    && full.label === '近7天游泳 2 次 · 共 2,400 米');
  const partial = swimWeekSummary([swim(D(15), 1000, 40), swim(D(18), null, null), swim(D(20), null, 20)], WINDOW);
  check('week partial: the known sum is labelled 已知 with the unknown count, never 共',
    partial.count === 3 && partial.meters === 1000 && partial.unknownDistanceCount === 2
    && partial.label === '近7天游泳 3 次 · 已知 1,000 米（另有 2 次距离未知）' && !partial.label.includes('共'));
  const noneKnown = swimWeekSummary([swim(D(15), null, 40), swim(D(16), null, null)], WINDOW);
  check('week all-unknown distances: count shown, 距离未知， no 0 米 total invented',
    noneKnown.count === 2 && noneKnown.metersKnown === false && noneKnown.label === '近7天游泳 2 次 · 距离未知'
    && !noneKnown.label.includes('0 米'));
  const empty = swimWeekSummary([], WINDOW);
  check('week empty: count 0 and an empty label', empty.count === 0 && empty.label === '');
  const outside = swimWeekSummary([swim(D(13), 5000, 60), swim(D(21), 5000, 60)], WINDOW);
  check('week window: swims on the days just outside the 7 calendar days are excluded',
    outside.count === 0 && outside.label === '');
  const sparseWeek = swimWeekSummary([swim(D(14), 500, 20), swim(D(20), 500, 20)], WINDOW);
  check('week sparse: swims on only 2 of the 7 calendar days still total over the calendar window',
    sparseWeek.count === 2 && sparseWeek.label === '近7天游泳 2 次 · 共 1,000 米');
  const mixedWeek = swimWeekSummary([
    swim(D(15), 800, 30),
    { date: D(16), type: 'Running', distanceMeters: 3000, durationMinutes: 20 },
    swim(D(16), 200, 10, '泳池游泳'),
  ], WINDOW);
  check('week mixed types: only swim sessions count (incl. Chinese type labels)',
    mixedWeek.count === 2 && mixedWeek.meters === 1000);
  const dupWeek = swimWeekSummary([swim(D(15), 400, 15), swim(D(15), 400, 15)], WINDOW);
  check('week duplicates: two swims the same day count as 2 sessions',
    dupWeek.count === 2 && dupWeek.meters === 800);
}

// ------------------------------------------------------------ source checks
check('source: the today page builds the swim window from dataDate calendar days, not the last 7 daily rows',
  clientSrc.includes('shiftDateStr(snapshot.dataDate, index - 6)')
  && !clientSrc.includes('slice(-7).map((row) => row.date)'));
check('source: the seven-day facts strip and the week summary share swimInfoByDate / the dataDate anchor',
  clientSrc.includes('const swimByDate = swimInfoByDate(snapshot.historyDaily, snapshot.historyWorkouts);')
  && clientSrc.includes('swimWeekSummary(snapshot.historyWorkouts, swimWindowDates)'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
