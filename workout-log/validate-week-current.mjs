// W2.3 validation — the weekly review is explicitly the PREVIOUS
// complete week, plus a separate in-progress-week layer.
// Runs the REAL production pure functions extracted verbatim from
// client/src/App.tsx (previousCompleteWeek, currentWeekRange,
// currentWeekSummary, workoutsInRange, completedCount) and
// server/src/actions.ts (selectComparableHistory), over synthetic
// data only, plus source-wiring checks for the parts that need the
// live UI / action channel:
//  - cutoff Thu 2026-10-22: complete week = 10-12..10-18 (window
//    [10-12, 10-19)), in-progress week = 10-19..10-22;
//  - zero saved sessions this week -> the summary is empty (the UI
//    then shows only 本周暂无已保存完成记录）;
//  - an in-progress (active, completed_at null) workout is never
//    counted in the completed sessions/sets;
//  - Monday boundary: on a Monday the in-progress window starts
//    today; on a Sunday it still starts the past Monday;
//  - the week containing the 2026-11-01 DST end still spans Monday
//    .. Sunday local calendar days;
//  - a late-saved record belongs to the week of its completed_at,
//    not its started_at (same rule as workoutsInRange);
//  - server: selectComparableHistory passes the source workout's
//    completedAt through as sourceCompletedAt without changing the
//    selection, and the dashboard entry exposes it as
//    source_completed_at;
//  - copy: the review calls its week 该复盘周 (never 本周）, the
//    adjustments block is titled 下次训练参考， and every suggestion
//    carries a 依据 line built from the comparable source.
process.env.TZ = 'America/Los_Angeles';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');

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
  const between = source.slice(closeParen + 1, bodyStart).trimStart();
  if (between.startsWith(':')) {
    const typeEnd = matchDelim(source, bodyStart, '{', '}');
    const nextBrace = source.indexOf('{', typeEnd);
    if (nextBrace > -1 && source.slice(typeEnd + 1, nextBrace).trim() === '') bodyStart = nextBrace;
  }
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
const CLIENT_FN = ['completedCount', 'previousCompleteWeek', 'workoutsInRange', 'currentWeekRange', 'currentWeekSummary'];
const C = new Function(
  `${stripTypeScriptTypes(CLIENT_FN.map((n) => extractFunction(clientSrc, n)).join('\n'))}\nreturn { ${CLIENT_FN.join(', ')} };`,
)();
const S = new Function(
  `${stripTypeScriptTypes(extractFunction(serverSrc, 'selectComparableHistory'))}\nreturn { selectComparableHistory };`,
)();

// --- helpers ---
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (y, m, d, h = 12, min = 0) => local(y, m, d, h, min).toISOString();
let setId = 0;
function mkSets(n, completed) {
  return Array.from({ length: n }, (_, i) => {
    setId += 1;
    return {
      id: setId, workout_id: 0, exercise_key: 'ex', exercise_name: '动作',
      set_number: i + 1, target_reps: '8', weight: 100, reps: 8, completed: i < completed,
    };
  });
}
function mkWorkout(id, routine, startedIso, completedIso, totalSets, completedSets) {
  return { id, routine, unit: 'lb', started_at: startedIso, completed_at: completedIso, sets: mkSets(totalSets, completedSets) };
}

// --- 1: cutoff Thu 2026-10-22 windows ---
{
  const now = local(2026, 10, 22, 15);
  const prev = C.previousCompleteWeek(now);
  check('cutoff 10-22: complete week window is [2026-10-12, 2026-10-19)',
    ymd(prev.start) === '2026-10-12' && ymd(prev.end) === '2026-10-19', `${ymd(prev.start)}..${ymd(prev.end)}`);
  const cur = C.currentWeekRange(now);
  check('cutoff 10-22: in-progress window is Mon 2026-10-19 through today 2026-10-22',
    ymd(cur.start) === '2026-10-19' && ymd(cur.today) === '2026-10-22' && ymd(cur.end) === '2026-10-23',
    `${ymd(cur.start)}..${ymd(cur.today)}..${ymd(cur.end)}`);
  check('cutoff 10-22: in-progress window starts exactly where the complete week ends',
    cur.start.getTime() === prev.end.getTime());
}

// --- 2: summary counts only saved-completed sessions of this week ---
{
  const now = local(2026, 10, 22, 15);
  const mon = mkWorkout(1, 'push', iso(2026, 10, 19, 7), iso(2026, 10, 19, 8), 4, 3);
  const wed = mkWorkout(2, 'pull', iso(2026, 10, 21, 7), iso(2026, 10, 21, 8), 5, 5);
  const lastSun = mkWorkout(3, 'legs', iso(2026, 10, 18, 7), iso(2026, 10, 18, 8), 6, 6);
  const active = mkWorkout(4, 'legs', iso(2026, 10, 22, 9), null, 6, 2);
  const summary = C.currentWeekSummary([mon, wed, lastSun, active], now);
  check('summary: 2 saved sessions this week (last Sunday and the active one excluded)',
    summary.sessions.length === 2 && summary.sessions.map((w) => w.id).join(',') === '1,2',
    `ids=${summary.sessions.map((w) => w.id).join(',')}`);
  check('summary: completed sets count completed sets only (3 + 5 = 8)',
    summary.completedSets === 8, `got ${summary.completedSets}`);
}

// --- 3: zero saved sessions this week ---
{
  const now = local(2026, 10, 22, 15);
  const lastWeek = mkWorkout(5, 'push', iso(2026, 10, 15, 7), iso(2026, 10, 15, 8), 4, 4);
  const summary = C.currentWeekSummary([lastWeek], now);
  check('zero case: no sessions and no sets when only last week has records',
    summary.sessions.length === 0 && summary.completedSets === 0);
  check('zero case: empty input is an empty summary',
    C.currentWeekSummary([], now).sessions.length === 0);
  check('zero case: UI shows exactly the no-saved-record line',
    clientSrc.includes('本周暂无已保存完成记录'));
}

// --- 4: the active workout is listed separately, never counted ---
{
  check('active line: rendered on its own with the not-counted marker',
    clientSrc.includes('正在记录：') && clientSrc.includes('（未计入完成数）'));
  const startIdx = clientSrc.indexOf('<CurrentWeekProgress');
  const activeIdx = clientSrc.indexOf('activeWorkout={workout} compact');
  check('wiring: start page renders CurrentWeekProgress above WeeklyReview',
    startIdx > -1 && clientSrc.indexOf('<WeeklyReview', startIdx) > startIdx);
  check('wiring: ActiveWorkout renders the compact variant with the active workout',
    activeIdx > -1);
  const now = local(2026, 10, 22, 15);
  const activeOnly = C.currentWeekSummary([mkWorkout(6, 'push', iso(2026, 10, 22, 9), null, 4, 4)], now);
  check('active line: an active workout alone yields a zero completed summary',
    activeOnly.sessions.length === 0 && activeOnly.completedSets === 0);
}

// --- 5: Monday / Sunday boundaries ---
{
  const monday = C.currentWeekRange(local(2026, 10, 19, 0, 30));
  check('Monday boundary: on Monday the window starts today',
    ymd(monday.start) === '2026-10-19' && ymd(monday.today) === '2026-10-19' && ymd(monday.end) === '2026-10-20');
  const prevFromMonday = C.previousCompleteWeek(local(2026, 10, 19, 0, 30));
  check('Monday boundary: complete week from a Monday is still [10-12, 10-19)',
    ymd(prevFromMonday.start) === '2026-10-12' && ymd(prevFromMonday.end) === '2026-10-19');
  const sunday = C.currentWeekRange(local(2026, 10, 25, 23, 0));
  check('Sunday boundary: on Sunday the window still starts the past Monday',
    ymd(sunday.start) === '2026-10-19' && ymd(sunday.today) === '2026-10-25' && ymd(sunday.end) === '2026-10-26');
  const now = local(2026, 10, 22, 15);
  const atMondayMidnight = mkWorkout(7, 'push', iso(2026, 10, 19, 0, 0), iso(2026, 10, 19, 0, 0), 1, 1);
  const justBefore = mkWorkout(8, 'push', iso(2026, 10, 18, 23, 0), iso(2026, 10, 18, 23, 59), 1, 1);
  const cur = C.currentWeekRange(now);
  check('Monday boundary: a completion at Monday 00:00 local is in-progress week, Sunday 23:59 is not',
    C.workoutsInRange([atMondayMidnight], cur.start, cur.end).length === 1
    && C.workoutsInRange([justBefore], cur.start, cur.end).length === 0);
}

// --- 6: the DST-end week (fallback on Sun 2026-11-01) ---
{
  const wed = C.currentWeekRange(local(2026, 10, 28, 12));
  check('DST week: Wed 2026-10-28 window starts Mon 2026-10-26',
    ymd(wed.start) === '2026-10-26' && ymd(wed.today) === '2026-10-28' && ymd(wed.end) === '2026-10-29');
  const sun = C.currentWeekRange(local(2026, 11, 1, 12));
  check('DST week: on Sun 2026-11-01 (fallback day) the window is Mon 10-26 .. Sun 11-01',
    ymd(sun.start) === '2026-10-26' && ymd(sun.today) === '2026-11-01' && ymd(sun.end) === '2026-11-02');
  const prev = C.previousCompleteWeek(local(2026, 11, 2, 9));
  check('DST week: complete week seen from Mon 2026-11-02 is [2026-10-26, 2026-11-02)',
    ymd(prev.start) === '2026-10-26' && ymd(prev.end) === '2026-11-02');
  const dayMs = 24 * 60 * 60 * 1000;
  const calendarDays = Math.round((Date.UTC(2026, 10, 2) - Date.UTC(2026, 9, 26)) / dayMs);
  check('DST week: the window spans 7 calendar days even though the fallback makes it 169 hours',
    calendarDays === 7 && (prev.end.getTime() - prev.start.getTime()) === 169 * 60 * 60 * 1000,
    `hours=${(prev.end.getTime() - prev.start.getTime()) / 3600000}`);
}

// --- 7: late-saved records belong to the week of completed_at ---
{
  const now = local(2026, 10, 22, 15);
  // Started Saturday of the previous week, only saved/completed Monday.
  const lateSaved = mkWorkout(9, 'legs', iso(2026, 10, 17, 18), iso(2026, 10, 19, 9), 6, 6);
  const summary = C.currentWeekSummary([lateSaved], now);
  check('late save: a record completed Monday counts in the in-progress week despite a Saturday start',
    summary.sessions.length === 1 && summary.sessions[0]?.id === 9);
  const prev = C.previousCompleteWeek(now);
  check('late save: the same record is NOT in the previous complete week',
    C.workoutsInRange([lateSaved], prev.start, prev.end).length === 0);
  const atEnd = mkWorkout(10, 'push', iso(2026, 10, 22, 23), iso(2026, 10, 23, 0, 0), 1, 1);
  check('late save: a completion exactly at tomorrow 00:00 is outside the in-progress window',
    C.currentWeekSummary([atEnd], now).sessions.length === 0);
}

// --- 8: server source_completed_at pass-through ---
{
  const set = (key, n, w, r, c) => ({ exerciseKey: key, setNumber: n, targetReps: '6-8', weight: w, reps: r, completed: c });
  const recentCompleted = [
    { unit: 'lb', completedAt: '2026-10-20T15:00:00.000Z', sets: [set('bench', 1, 100, 8, true), set('bench', 2, 100, 8, true)] },
    { unit: 'kg', completedAt: '2026-10-13T15:00:00.000Z', sets: [set('bench', 1, 60, 8, true), set('row', 1, 50, 10, true)] },
    { unit: 'lb', sets: [set('curl', 1, 30, 12, true)] },
  ];
  const entries = S.selectComparableHistory(recentCompleted, ['bench', 'row', 'curl']);
  const byKey = Object.fromEntries(entries.map((e) => [e.exerciseKey, e]));
  check('server: bench still selects the MOST RECENT workout (selection unchanged)',
    byKey.bench?.unit === 'lb' && byKey.bench?.sets.length === 2);
  check('server: sourceCompletedAt is that source workout\'s own completion time',
    byKey.bench?.sourceCompletedAt === '2026-10-20T15:00:00.000Z'
    && byKey.row?.sourceCompletedAt === '2026-10-13T15:00:00.000Z',
    `bench=${byKey.bench?.sourceCompletedAt} row=${byKey.row?.sourceCompletedAt}`);
  check('server: a caller that supplies no completedAt gets null, selection intact',
    byKey.curl?.sourceCompletedAt === null && byKey.curl?.sets.length === 1);
  check('server: dashboard entry exposes source_completed_at as a nullable string',
    serverSrc.includes('source_completed_at: z.string().nullable()')
    && serverSrc.includes('source_completed_at: raw.sourceCompletedAt'));
  check('server: loadRoutineRecentCompleted passes each workout\'s completedAt through',
    serverSrc.includes('completedAt: schema.workouts.completedAt')
    && serverSrc.includes('completedAt: row.completedAt ? row.completedAt.toISOString() : null'));
}

// --- 9: review copy + basis wiring ---
{
  const reviewStart = clientSrc.indexOf('function WeeklyReview');
  const reviewEnd = clientSrc.indexOf('function CompletionReceipt');
  const reviewSlice = clientSrc.slice(reviewStart, reviewEnd);
  check('copy: the review header still names the previous complete week with its dates',
    reviewSlice.includes('上个完整周 · {compactDate(start)}–{compactDate(endInclusive)}'));
  check('copy: performance evidence says 该复盘周， never 本周， for the review week',
    reviewSlice.includes('该复盘周 {review.completed}/{review.planned} 组')
    && !reviewSlice.includes('本周 {review.completed}'));
  check('copy: the adjustments block is titled 下次训练参考 (no 下周调整 left)',
    reviewSlice.includes('下次训练参考') && !clientSrc.includes('下周调整'));
  check('basis: comparable_history path cites source_completed_at, fallback cites the workout completed_at',
    clientSrc.includes('recommendationBasis(historyEntry.source_completed_at, historyEntry.unit, review.unit)')
    && clientSrc.includes('recommendationBasis(comparable.workout.completed_at, comparable.workout.unit, review.unit)'));
  check('basis: line format is 依据：{date} · {unit} 记录 with the 已换算 marker on unit mismatch',
    clientSrc.includes('`依据：${parts.join(" · ")}`') && clientSrc.includes('parts.push("已换算")'));
  check('wiring: each session row on the start page opens its record through the History focus',
    clientSrc.includes('onOpenWorkout={(id) => setHistoryFocus((prev) => ({ id, n: (prev?.n ?? 0) + 1 }))}'));
  check('title: the layer is titled 本周进行中 with the Monday..today range',
    clientSrc.includes('`本周进行中 · ${compactDate(summary.start)}–${compactDate(summary.today)}`'));
  check('totals: the summary line counts saved sessions and completed sets in words and numbers',
    clientSrc.includes('已保存完成 {summary.sessions.length} 次 · 共 {summary.completedSets} 组'));
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
