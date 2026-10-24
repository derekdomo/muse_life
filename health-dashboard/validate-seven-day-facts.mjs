// H-LOAD-001-D1 validation (seven-day facts strip).
// Runs the REAL production function (sevenDayFacts) extracted verbatim from
// health-dashboard/client/src/App.tsx over synthetic data only, plus source
// checks on the SevenDayFacts component wiring. Pure Node, no deps. Also
// executes two source mutations (dropping the conflict gate, and counting
// gaps as covered) and asserts the mutated function changes the outcome —
// proving sensitivity.
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
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

function buildFn(src) {
  const code = extractFunction(src, 'sevenDayFacts');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { sevenDayFacts };`)().sevenDayFacts;
}
function buildLaToday(src) {
  const code = extractFunction(src, 'laTodayDateString');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { laTodayDateString };`)().laTodayDateString;
}
const rawSevenDayFacts = buildFn(clientSrc);
const laTodayDateString = buildLaToday(clientSrc);
// Existing fixtures were written when 2026-10-14 was a completed day;
// pin LA "today" to 2026-10-15 by default so those cases keep exercising
// the ended-day path, and pass an explicit todayLa for the new boundary
// cases (LA today / future / yesterday).
const sevenDayFacts = (rows, dataDate, coverageIncomplete, metricKey, todayLa = '2026-10-15') =>
  rawSevenDayFacts(rows, dataDate, coverageIncomplete, metricKey, todayLa);

// ---------------------------------------------------------- source wiring
check('source: strip renders once in TodayView below the hero (H-UI-002 sunk layout)',
  clientSrc.split('<SevenDayFacts snapshot={snapshot} />').length - 1 === 1
  && clientSrc.indexOf('<SevenDayFacts snapshot={snapshot} />') > clientSrc.indexOf('<WhoopHero'));
check('source: default metric is exerciseMinutes',
  clientSrc.includes('useState<SevenDayMetricKey>("exerciseMinutes")'));
check('source: copy states raw facts, not a readiness/recovery score',
  clientSrc.includes('逐日原始记录，不是恢复或负荷评分'));
check('source: day detail honestly reports the missing per-day source/timestamp fields',
  clientSrc.includes('该日记录未单独标注来源') && clientSrc.includes('该日记录未单独记录'));
check('source: coverage-incomplete note is rendered from the facts result, no new sync path',
  clientSrc.includes('来源覆盖不完整：健康数据还没同步完') && clientSrc.includes('facts.coverageIncomplete'));
check('source: no sleep metric is offered anywhere in the facts function',
  !/totalHours|sleep/i.test(extractFunction(clientSrc, 'sevenDayFacts')));
check('source: caller passes the LA today computed by laTodayDateString',
  clientSrc.includes('sevenDayFacts(snapshot.historyDaily, snapshot.dataDate, snapshot.coverageIncomplete, metricKey, laTodayDateString())'));
check('source: sevenDayFacts takes an explicit todayLa parameter and never reads the clock itself',
  /function sevenDayFacts\([\s\S]*?todayLa: string/.test(clientSrc)
  && !/new Date\(\)|Date\.now/.test(extractFunction(clientSrc, 'sevenDayFacts')));

// ------------------------------------------------------------ synthetic data
const row = (date, patch = {}) => ({
  date, steps: null, activeKcal: null, exerciseMinutes: null,
  restingHr: null, hrvMs: null, respiratoryRate: null, weightKg: null, swimMeters: null, ...patch,
});
// Window 2026-10-08 .. 2026-10-14: values, a real 0, a null-metric row,
// and a fully absent day (2026-10-11 has no row at all).
const base = [
  row('2026-10-08', { exerciseMinutes: 30, steps: 8000, hrvMs: 42.5, restingHr: 58 }),
  row('2026-10-09', { exerciseMinutes: 0, steps: 0, hrvMs: 0, restingHr: 60 }),
  row('2026-10-10', { exerciseMinutes: null, steps: 5000, hrvMs: null, restingHr: null }),
  row('2026-10-12', { exerciseMinutes: 45, steps: 9200, hrvMs: 39.25, restingHr: 57 }),
  row('2026-10-13', { exerciseMinutes: 20, steps: 6100, hrvMs: 44, restingHr: 59 }),
  row('2026-10-14', { exerciseMinutes: 60, steps: 12345, hrvMs: 47.5, restingHr: 56 }),
];
const DATES = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];

// ------------------------------------------------------------ metric mapping
{
  const r = sevenDayFacts(base, '2026-10-14', false, 'exerciseMinutes');
  check('metric mapping: exactly four metrics, no sleep option',
    r.metrics.map((m) => m.key).join(',') === 'exerciseMinutes,steps,hrvMs,restingHr');
  const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  check('metric mapping: exerciseMinutes 显示为「运动分钟」unit 分钟',
    byKey.exerciseMinutes.label === '运动分钟' && byKey.exerciseMinutes.unit === '分钟');
  check('metric mapping: steps unit 步', byKey.steps.unit === '步');
  check('metric mapping: hrvMs unit ms', byKey.hrvMs.unit === 'ms');
  check('metric mapping: restingHr unit bpm', byKey.restingHr.unit === 'bpm');
  check('selected metric def follows the requested key',
    r.metric.key === 'exerciseMinutes' && r.metric.label === '运动分钟');
}

// ------------------------------------------------------------ window & values
{
  const r = sevenDayFacts(base, '2026-10-14', false, 'exerciseMinutes');
  check('window: 7 consecutive calendar days ending at dataDate',
    r.days.map((d) => d.date).join(',') === DATES.join(','));
  check('values pass through raw, in date order',
    r.days.map((d) => String(d.value)).join('|') === '30|0|null|null|45|20|60');
  check('gap: null metric and absent day are gaps, never filled with 0',
    r.days[2].value === null && r.days[2].conflict === false && r.days[3].value === null && r.days[3].conflict === false);
  check('real 0 is a valid value and counts as covered',
    r.days[1].value === 0 && r.days[1].conflict === false);
  check('coverage x/7 counts only legal non-missing days',
    r.covered === 5 && r.boundaryOk === true && r.boundaryNote === null);
}
{
  const steps = sevenDayFacts(base, '2026-10-14', false, 'steps');
  check('switching metric swaps only values/unit: steps incl. real 0, covered 6/7',
    steps.days.map((d) => d.value).join('|') === '8000|0|5000||9200|6100|12345' && steps.covered === 6 && steps.metric.unit === '步');
  const hrv = sevenDayFacts(base, '2026-10-14', false, 'hrvMs');
  check('switching metric: hrvMs raw decimals and 0 preserved, gaps stay gaps',
    hrv.days[0].value === 42.5 && hrv.days[1].value === 0 && hrv.days[2].value === null && hrv.covered === 5 && hrv.metric.unit === 'ms');
  const rhr = sevenDayFacts(base, '2026-10-14', false, 'restingHr');
  check('switching metric: restingHr values with unit bpm',
    rhr.days[6].value === 56 && rhr.metric.unit === 'bpm' && rhr.covered === 5);
}

// ------------------------------------------------------------ duplicates
{
  const dupSame = [...base, row('2026-10-13', { exerciseMinutes: 20, steps: 1 })];
  const r = sevenDayFacts(dupSame, '2026-10-14', false, 'exerciseMinutes');
  check('duplicate rows with identical values dedupe to that value',
    r.days[5].value === 20 && r.days[5].conflict === false && r.covered === 5);
  const rSteps = sevenDayFacts(dupSame, '2026-10-14', false, 'steps');
  check('dedupe is per-metric: steps on the duplicated date conflict instead',
    rSteps.days[5].conflict === true && rSteps.days[5].value === null);
}
{
  const dupConflict = [...base, row('2026-10-12', { exerciseMinutes: 50 })];
  const r = sevenDayFacts(dupConflict, '2026-10-14', false, 'exerciseMinutes');
  check('same-day conflicting values: marked conflict/unavailable, not summed, not max-picked',
    r.days[4].conflict === true && r.days[4].value === null && r.covered === 4);
  const dupNullMix = [...base, row('2026-10-12', { exerciseMinutes: null })];
  const r2 = sevenDayFacts(dupNullMix, '2026-10-14', false, 'exerciseMinutes');
  check('same-day value vs null duplicate is also a conflict (no silent pick)',
    r2.days[4].conflict === true && r2.days[4].value === null);
}

// ------------------------------------------------------------ boundaries
{
  const r = sevenDayFacts(base, '2026-02-30', false, 'steps');
  check('invalid dataDate (nonexistent calendar day): boundary note, no window presented',
    r.boundaryOk === false && r.days.length === 0 && r.covered === 0 && r.boundaryNote.includes('日期边界未满足'));
  const r2 = sevenDayFacts(base, '14/10/2026', false, 'steps');
  check('invalid dataDate (wrong format): boundary note, no window',
    r2.boundaryOk === false && r2.days.length === 0 && r2.boundaryNote.includes('日期边界未满足'));
}
{
  const noEnd = base.filter((entry) => entry.date !== '2026-10-14');
  const r = sevenDayFacts(noEnd, '2026-10-14', false, 'exerciseMinutes');
  check('dataDate day itself incomplete (no row): boundary note shown, window still ends at dataDate with a gap',
    r.boundaryOk === false && r.boundaryNote.includes('日期边界未满足')
    && r.days.length === 7 && r.days[6].date === '2026-10-14' && r.days[6].value === null && r.covered === 4);
}
{
  const r = sevenDayFacts(base, '2026-10-14', true, 'steps');
  check('global coverageIncomplete is carried through for the source-gap note',
    r.coverageIncomplete === true && r.boundaryOk === true);
  const r2 = sevenDayFacts(base, '2026-10-14', false, 'steps');
  check('complete coverage: flag stays false', r2.coverageIncomplete === false);
}

// ------------------------------------------- complete-day boundary vs LA today
{
  // dataDate IS LA today and the day has a row: the day has not ended,
  // so the row is partial — boundary unsatisfied with the partial note,
  // while the raw per-day values stay visible.
  const r = sevenDayFacts(base, '2026-10-14', false, 'exerciseMinutes', '2026-10-14');
  check('LA today with a row: boundary unsatisfied (day still in progress)',
    r.boundaryOk === false && r.boundaryNote.includes('日期边界未满足')
    && r.boundaryNote.includes('数据日期为今天') && r.boundaryNote.includes('当天尚未结束')
    && r.boundaryNote.includes('未完整数据') && r.boundaryNote.includes('不作为完整趋势'));
  check('LA today with a row: raw values still presented, not hidden',
    r.days.length === 7 && r.days[6].date === '2026-10-14' && r.days[6].value === 60 && r.covered === 5);
}
{
  // dataDate AFTER LA today (future date) with a row: boundary anomaly,
  // a distinct note from both the partial-today and the no-row notes.
  const r = sevenDayFacts(base, '2026-10-14', false, 'steps', '2026-10-13');
  check('future dataDate with a row: boundary unsatisfied (future-date note)',
    r.boundaryOk === false && r.boundaryNote.includes('数据日期在未来')
    && r.boundaryNote.includes('日期边界异常') && !r.boundaryNote.includes('数据日期为今天')
    && !r.boundaryNote.includes('尚无完整的每日记录'));
  check('future dataDate with a row: raw values still presented',
    r.days.length === 7 && r.days[6].value === 12345);
}
{
  // dataDate is a real yesterday relative to LA today, with a row: the
  // day has ended, so the boundary is satisfied and there is no note.
  const r = sevenDayFacts(base, '2026-10-14', false, 'steps', '2026-10-15');
  check('real yesterday with a row: boundary satisfied, no note',
    r.boundaryOk === true && r.boundaryNote === null && r.covered === 6);
  // Same day, but as LA today with a real 0 on the end day: the 0 still
  // counts as covered even though the boundary fails as partial.
  const zeroDay = [row('2026-10-14', { exerciseMinutes: 0 })];
  const rz = sevenDayFacts(zeroDay, '2026-10-14', false, 'exerciseMinutes', '2026-10-14');
  check('real 0 on LA today: counts as covered, boundary still partial',
    rz.days[6].value === 0 && rz.covered === 1 && rz.boundaryOk === false
    && rz.boundaryNote.includes('数据日期为今天'));
  // Duplicate conflict on LA today: conflict marking is unchanged.
  const dup = [row('2026-10-14', { exerciseMinutes: 10 }), row('2026-10-14', { exerciseMinutes: 25 })];
  const rd = sevenDayFacts(dup, '2026-10-14', false, 'exerciseMinutes', '2026-10-14');
  check('duplicate conflict on LA today: still conflict/unavailable, boundary partial',
    rd.days[6].conflict === true && rd.days[6].value === null && rd.covered === 0
    && rd.boundaryOk === false && rd.boundaryNote.includes('数据日期为今天'));
  // An unusable todayLa can never prove the day ended.
  const rb = sevenDayFacts(base, '2026-10-14', false, 'steps', 'not-a-date');
  check('invalid todayLa: boundary unsatisfied, never silently complete',
    rb.boundaryOk === false && rb.boundaryNote.includes('日期边界未满足'));
}

// ------------------------------------------------------------ LA calendar edges
{
  // Spring forward 2026-03-08 (America/Los_Angeles): the 7 calendar days
  // ending 2026-03-09 must be exactly 03-03..03-09, no skipped/doubled day.
  const r = sevenDayFacts([], '2026-03-09', false, 'steps');
  check('LA boundary across spring-forward DST: continuous 7 calendar days',
    r.days.map((d) => d.date).join(',') === '2026-03-03,2026-03-04,2026-03-05,2026-03-06,2026-03-07,2026-03-08,2026-03-09');
}
{
  // Fall back 2026-11-01 plus a month boundary.
  const r = sevenDayFacts([], '2026-11-02', false, 'steps');
  check('LA boundary across fall-back DST and month end: continuous 7 calendar days',
    r.days.map((d) => d.date).join(',') === '2026-10-27,2026-10-28,2026-10-29,2026-10-30,2026-10-31,2026-11-01,2026-11-02');
}
{
  const r = sevenDayFacts([], '2026-03-01', false, 'steps');
  check('LA boundary across February (non-leap): continuous 7 calendar days',
    r.days.map((d) => d.date).join(',') === '2026-02-23,2026-02-24,2026-02-25,2026-02-26,2026-02-27,2026-02-28,2026-03-01');
  const leap = sevenDayFacts([], '2024-03-01', false, 'steps');
  check('LA boundary across February (leap year, includes 02-29)',
    leap.days.map((d) => d.date).join(',') === '2024-02-24,2024-02-25,2024-02-26,2024-02-27,2024-02-28,2024-02-29,2024-03-01');
}

// ------------------------------------------- client LA-today computation
{
  // Around LA midnight (PDT, UTC-7): 06:59:59Z is still 2026-10-16 in
  // Los Angeles; 07:00:00Z is exactly LA midnight of 2026-10-17.
  check('laTodayDateString: just before LA midnight stays on the previous LA day',
    laTodayDateString(new Date('2026-10-17T06:59:59Z')) === '2026-10-16');
  check('laTodayDateString: at LA midnight rolls to the new LA day',
    laTodayDateString(new Date('2026-10-17T07:00:00Z')) === '2026-10-17');
  // Spring forward 2026-03-08 (02:00 PST -> 03:00 PDT): 07:59:59Z is
  // 2026-03-07 23:59:59 PST; 08:00:00Z is 2026-03-08 00:00 PST; later
  // that morning (10:00Z = 03:00 PDT) is still 2026-03-08.
  check('laTodayDateString: spring-forward eve stays 2026-03-07',
    laTodayDateString(new Date('2026-03-08T07:59:59Z')) === '2026-03-07');
  check('laTodayDateString: spring-forward morning is 2026-03-08 (no skipped day)',
    laTodayDateString(new Date('2026-03-08T08:00:00Z')) === '2026-03-08'
    && laTodayDateString(new Date('2026-03-08T10:00:00Z')) === '2026-03-08');
  // Fall back 2026-11-01 (02:00 PDT -> 01:00 PST): 06:59:59Z is
  // 2026-10-31 23:59:59 PDT; 07:00:00Z is 2026-11-01 00:00 PDT; the
  // repeated 01:00 hour (09:00Z, PST) is still 2026-11-01.
  check('laTodayDateString: fall-back eve stays 2026-10-31',
    laTodayDateString(new Date('2026-11-01T06:59:59Z')) === '2026-10-31');
  check('laTodayDateString: fall-back repeated hour stays 2026-11-01 (no doubled day)',
    laTodayDateString(new Date('2026-11-01T07:00:00Z')) === '2026-11-01'
    && laTodayDateString(new Date('2026-11-01T09:00:00Z')) === '2026-11-01');
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noConflictGate = buildFn(clientSrc.replace('if (distinct.length > 1) return { date, value: null, conflict: true };', 'if (distinct.length > 999) return { date, value: null, conflict: true };'));
  const dupConflict = [...base, row('2026-10-12', { exerciseMinutes: 50 })];
  check('mutation: dropping the conflict gate lets a conflicting day pass as a value',
    sevenDayFacts(dupConflict, '2026-10-14', false, 'exerciseMinutes').days[4].conflict === true
    && noConflictGate(dupConflict, '2026-10-14', false, 'exerciseMinutes', '2026-10-15').days[4].conflict === false);

  const gapsCovered = buildFn(clientSrc.replace('const covered = days.filter((day) => !day.conflict && day.value !== null).length;', 'const covered = days.filter((day) => !day.conflict).length;'));
  check('mutation: counting gaps as covered inflates x/7',
    sevenDayFacts(base, '2026-10-14', false, 'exerciseMinutes').covered === 5
    && gapsCovered(base, '2026-10-14', false, 'exerciseMinutes', '2026-10-15').covered === 7);

  const noEndedGate = buildFn(clientSrc.replace('const boundaryOk = hasEndRow && isRealDate(todayLa) && dataDate < todayLa;', 'const boundaryOk = hasEndRow;'));
  check('mutation: dropping the ended-day gate presents LA today as a complete trend',
    sevenDayFacts(base, '2026-10-14', false, 'exerciseMinutes', '2026-10-14').boundaryOk === false
    && noEndedGate(base, '2026-10-14', false, 'exerciseMinutes', '2026-10-14').boundaryOk === true);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
