// H-SLEEP-REG-001 (space-4) validation.
// Runs the REAL production sleepRegularity extracted verbatim from
// client/src/App.tsx over synthetic fixtures only (invented dates and
// clock times — nothing here is a real sleep record). Covers:
// (1) n = 0 / 1 / 6 -> empty / insufficient, no SD numbers anywhere;
// (2) n = 7 / 13 -> computed but flagged partial with a reason;
// (3) n = 14 -> full window, not partial;
// (4) the window is a 14-CALENDAR-day grid anchored on the latest
//     record's wake date: same-night duplicates count once, old
//     records outside the window are never borrowed to fill n;
// (5) per-night main-sleep selection (selectMainSleep caliber):
//     longest time in bed wins, ties go to the evening-first earlier
//     start; a nap beside a main sleep never counts;
// (6) circular statistics: alternating 23:50 / 00:10 starts give a
//     SMALL SD (the old noon-unfolded linear SD read them as >700
//     minutes apart — the naive comparison below proves the teeth),
//     the noon cut (11:50 / 12:10) is likewise small, all-identical
//     nights give SD 0, and times spread around the whole clock
//     (R ~ 0) give null mean/SD flagged spreadUndefined;
// (7) unusable rows (missing/invalid date, unparseable clocks,
//     zero duration) never count as nights; input order is irrelevant.
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

const code = stripTypeScriptTypes(extractFunction(clientSrc, 'sleepRegularity').replace(/^export /, ''));
const sleepRegularity = new Function(`${code}\nreturn sleepRegularity;`)();

// ------------------------------------------------------------ fixtures
const shift = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const ANCHOR = '2031-03-20'; // invented anchor date
const night = (date, start, end) => ({ date, start, end });
const nightsBack = (count, start, end, anchor = ANCHOR) =>
  Array.from({ length: count }, (_, i) => night(shift(anchor, i - (count - 1)), start, end));
const near = (a, b, tol) => a !== null && Math.abs(a - b) <= tol;
const clockNear = (a, b, tol) => {
  if (a === null) return false;
  const diff = Math.min(Math.abs(a - b), 1440 - Math.abs(a - b));
  return diff <= tol;
};

// ------------------------------------------------------------ (1) n sizes
{
  const r0 = sleepRegularity([]);
  check('n=0: empty, SDs null, missing caliber 当天没戴表',
    r0.status === 'empty' && r0.sampleCount === 0 && r0.onsetSdMinutes === null && r0.midpointSdMinutes === null
    && r0.missingLabel === '当天没戴表' && r0.windowStart === null && r0.windowEnd === null);
  check('n=0 with incomplete coverage: missing caliber 还没同步完',
    sleepRegularity([], true).missingLabel === '还没同步完');
  const r1 = sleepRegularity(nightsBack(1, '23:00', '07:00'));
  check('n=1: insufficient, SDs and means null, window anchored on the record',
    r1.status === 'insufficient' && r1.sampleCount === 1 && r1.onsetSdMinutes === null && r1.midpointSdMinutes === null
    && r1.onsetMeanClockMinutes === null && r1.windowEnd === ANCHOR && r1.windowStart === shift(ANCHOR, -13));
  const r6 = sleepRegularity(nightsBack(6, '23:00', '07:00'));
  check('n=6: insufficient (below the 7-night floor), no SD shown',
    r6.status === 'insufficient' && r6.sampleCount === 6 && r6.sufficient === false && r6.onsetSdMinutes === null);
}

// ------------------------------------------------------------ (2)(3) partial band
{
  const r7 = sleepRegularity(nightsBack(7, '23:00', '07:00'));
  check('n=7: computed, flagged partial with a reason naming the missing nights',
    r7.status === 'ok' && r7.sufficient === true && r7.partial === true
    && typeof r7.partialReason === 'string' && r7.partialReason.includes('7')
    && r7.onsetSdMinutes !== null && r7.midpointSdMinutes !== null);
  const r13 = sleepRegularity(nightsBack(13, '23:00', '07:00'));
  check('n=13: computed, still partial (13/14)',
    r13.status === 'ok' && r13.sampleCount === 13 && r13.partial === true && r13.partialReason !== null);
  const r14 = sleepRegularity(nightsBack(14, '23:00', '07:00'));
  check('n=14: full window, not partial, no reason',
    r14.status === 'ok' && r14.sampleCount === 14 && r14.partial === false && r14.partialReason === null);
  check('identical nights: SD is 0 to within float residue (<0.01 min; the panel rounds to 0 分钟） and mean is the shared start/midpoint',
    near(r14.onsetSdMinutes, 0, 0.01) && near(r14.midpointSdMinutes, 0, 0.01)
    && clockNear(r14.onsetMeanClockMinutes, 23 * 60, 1) && clockNear(r14.midpointMeanClockMinutes, 3 * 60, 1));
}

// ------------------------------------------------------------ (4) calendar window
{
  // 6 nights inside the window + 8 older nights just outside it: the
  // old sessions must NOT be borrowed to reach the 7-night floor.
  const inside = nightsBack(6, '23:00', '07:00');
  const outside = Array.from({ length: 8 }, (_, i) => night(shift(ANCHOR, -14 - i), '23:00', '07:00'));
  const r = sleepRegularity([...outside, ...inside]);
  check('window: older records outside the 14 calendar days are never borrowed (n stays 6, insufficient)',
    r.sampleCount === 6 && r.status === 'insufficient' && r.windowEnd === ANCHOR && r.windowStart === shift(ANCHOR, -13));
  // A stray FUTURE-dated record re-anchors the window on itself.
  const future = sleepRegularity([...nightsBack(14, '23:00', '07:00'), night('2031-04-02', '23:00', '07:00')]);
  check('window: the anchor is the LATEST record date (a later record re-anchors)',
    future.windowEnd === '2031-04-02' && future.sampleCount === 2);
}

// ------------------------------------------------------------ (5) main-sleep selection
{
  // Every night carries a midday nap beside the main sleep: only the
  // main sleep may count, once per wake date.
  const withNaps = nightsBack(7, '23:00', '07:00')
    .flatMap((row) => [row, night(row.date, '13:00', '13:40')]);
  const r = sleepRegularity(withNaps);
  check('main sleep: a nap beside the main sleep never counts (n=7, onset from the main sleep)',
    r.sampleCount === 7 && clockNear(r.onsetMeanClockMinutes, 23 * 60, 1) && near(r.onsetSdMinutes, 0, 0.01));
  // Conflicting duplicates on one date: the longest time in bed wins.
  const conflict = Array.from({ length: 7 }, (_, i) => shift(ANCHOR, i - 6))
    .flatMap((date) => [night(date, '23:00', '05:00'), night(date, '22:00', '06:00')]);
  const rc = sleepRegularity(conflict);
  check('main sleep: conflicting duplicates — longest in bed wins (onset 22:00, not 23:00)',
    rc.sampleCount === 7 && clockNear(rc.onsetMeanClockMinutes, 22 * 60, 1));
  // Equal durations: the evening-first earlier start wins the tie.
  const tie = Array.from({ length: 7 }, (_, i) => shift(ANCHOR, i - 6))
    .flatMap((date) => [night(date, '00:30', '06:30'), night(date, '23:30', '05:30')]);
  const rt = sleepRegularity(tie);
  check('main sleep: equal durations — the earlier (evening-first) start wins (onset 23:30)',
    rt.sampleCount === 7 && clockNear(rt.onsetMeanClockMinutes, 23 * 60 + 30, 1));
  // Identical duplicate rows for one night still count once.
  const dup = nightsBack(7, '23:00', '07:00').flatMap((row) => [row, { ...row }]);
  check('main sleep: identical duplicates count once per wake date',
    sleepRegularity(dup).sampleCount === 7);
}

// ------------------------------------------------------------ (6) circular statistics
{
  // Alternating 23:50 / 00:10 starts (8h durations): on the circle
  // these are 20 minutes apart, so the circular SD must be small.
  const alternating = Array.from({ length: 14 }, (_, i) => {
    const date = shift(ANCHOR, i - 13);
    return i % 2 === 0 ? night(date, '23:50', '07:50') : night(date, '00:10', '08:10');
  });
  const r = sleepRegularity(alternating);
  check('circular: alternating 23:50 / 00:10 starts -> small onset SD (order of tens of minutes)',
    r.onsetSdMinutes !== null && r.onsetSdMinutes < 30, `sd=${r.onsetSdMinutes?.toFixed(1)}`);
  check('circular: alternating starts -> mean onset at ~00:00',
    clockNear(r.onsetMeanClockMinutes, 0, 15));
  // Teeth: the naive linear SD of the same clock minutes (the class
  // of bug the old noon-unfold produced) is huge by comparison.
  const linear = (() => {
    const values = alternating.map((row) => (row.start === '23:50' ? 1430 : 10));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
  })();
  check('circular: naive linear SD of the same starts is >700 min (the failure mode being fixed)',
    linear > 700 && r.onsetSdMinutes !== null && r.onsetSdMinutes < linear / 10, `linear=${linear.toFixed(0)}`);
  // The noon cut: alternating 11:50 / 12:10 starts are also 20
  // minutes apart on the circle.
  const noonCut = Array.from({ length: 14 }, (_, i) => {
    const date = shift(ANCHOR, i - 13);
    return i % 2 === 0 ? night(date, '11:50', '19:50') : night(date, '12:10', '20:10');
  });
  const rn = sleepRegularity(noonCut);
  check('circular: alternating 11:50 / 12:10 starts (noon cut) -> small onset SD',
    rn.onsetSdMinutes !== null && rn.onsetSdMinutes < 30, `sd=${rn.onsetSdMinutes?.toFixed(1)}`);
  // R ~ 0: starts spread evenly around the whole clock.
  const spreadStarts = ['00:00', '06:00', '12:00', '18:00'];
  const spreadEnds = ['04:00', '10:00', '16:00', '22:00'];
  const spread = Array.from({ length: 8 }, (_, i) => night(shift(ANCHOR, i - 7), spreadStarts[i % 4], spreadEnds[i % 4]));
  const rs = sleepRegularity(spread);
  check('circular: starts spread around the whole clock (R ~ 0) -> onset mean/SD null, flagged spreadUndefined, status still ok',
    rs.status === 'ok' && rs.onsetSpreadUndefined === true && rs.onsetSdMinutes === null && rs.onsetMeanClockMinutes === null);
  // Midpoint wraps past midnight: 23:00 -> 07:00 has midpoint 03:00.
  const mid = sleepRegularity(nightsBack(7, '23:00', '07:00'));
  check('circular: midpoint of 23:00-07:00 is 03:00 (wraps past midnight)',
    clockNear(mid.midpointMeanClockMinutes, 3 * 60, 1));
}

// ------------------------------------------------------------ (7) unusable rows / order
{
  const base = nightsBack(7, '23:00', '07:00');
  const polluted = [
    ...base,
    { date: 'not-a-date', start: '22:00', end: '06:00' },
    { date: '', start: '22:00', end: '06:00' },
    night(shift(ANCHOR, -3), '25:00', '07:00'), // unparseable clock on an in-window date that already has a main sleep... keeps main
    night(shift(ANCHOR, -2), '07:00', '07:00'), // zero duration on a date whose main sleep exists in base
  ];
  const r = sleepRegularity(polluted);
  check('unusable rows: bad dates / bad clocks / zero duration never add nights (n stays 7)',
    r.sampleCount === 7 && clockNear(r.onsetMeanClockMinutes, 23 * 60, 1));
  const onlyBad = sleepRegularity([night(ANCHOR, '07:00', '07:00'), { date: 'bogus', start: '23:00', end: '07:00' }]);
  check('unusable rows: a zero-duration-only record leaves the window empty',
    onlyBad.status === 'empty' && onlyBad.sampleCount === 0 && onlyBad.windowEnd === ANCHOR);
  const shuffled = [...base].reverse();
  const ordered = sleepRegularity(base);
  const unordered = sleepRegularity(shuffled);
  check('order: shuffled input gives the identical result',
    unordered.sampleCount === ordered.sampleCount
    && unordered.onsetSdMinutes === ordered.onsetSdMinutes
    && unordered.onsetMeanClockMinutes === ordered.onsetMeanClockMinutes
    && unordered.windowStart === ordered.windowStart && unordered.windowEnd === ordered.windowEnd);
}

// ------------------------------------------------------------ source checks
check('source: panel labels the start time 开始时刻（代理） and shows the formula + window + records entry',
  clientSrc.includes('开始时刻（代理）') && clientSrc.includes('圆周标准差 = √(−2 ln R)')
  && clientSrc.includes('查看睡眠记录') && clientSrc.includes('有效 {result.sampleCount}/{result.windowDays} 晚'));
check('source: sleepRegularity never feeds readiness (no readiness reference in the function)',
  !/readiness/i.test(extractFunction(clientSrc, 'sleepRegularity')));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
