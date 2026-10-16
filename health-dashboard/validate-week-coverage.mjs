// H-UNITS-001 (whole-week coverage rework) validation.
// PM counterexample (2026-10-15 20:33 review): a week with 21 completed
// workouts whose earliest one has a completed set missing weight. The old
// chain — workout-log getDashboard capped at recent_limit 20, counts
// derived from that sample — reported unmeasured=0 for the week and the
// client printed -100%. This script runs the REAL producer
// (summarizeWeekSummaries from workout-log/server/src/actions.ts, fed the
// FULL week the way the new handler does) and the REAL client comparators
// (weekIsComparable / weekComparisonLabel / weekComparisonReason from
// health-dashboard/client/src/App.tsx) over synthetic data only.
// Pure Node, no deps. Exit code non-zero on any failure.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const producerSrc = readFileSync(new URL('../workout-log/server/src/actions.ts', import.meta.url), 'utf8');
const healthServerSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
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

// ------------------------------------------------------------- source side
check('producer: dashboard response carries week_summaries',
  producerSrc.includes('week_summaries: z.array(weekSummaryResponse)'));
check('producer: forbidden branch returns empty week_summaries',
  producerSrc.includes('recent_workouts: [], week_summaries: []'));
{
  const segStart = producerSrc.indexOf('Whole-week coverage (H-UNITS-001)');
  const segEnd = producerSrc.indexOf('week_summaries: weekSummaries');
  const seg = segStart >= 0 && segEnd > segStart ? producerSrc.slice(segStart, segEnd) : '';
  check('producer: whole-week query window exists (21d, gte) with NO limit truncation',
    seg.includes('gte(schema.workouts.completedAt, cutoff)') && !seg.includes('.limit('));
}
check('health schema: coverageComplete optional boolean',
  healthServerSrc.includes('coverageComplete: z.boolean().optional(),'));
check('health prompt: matched weeks take counts from week_summaries and set coverageComplete',
  healthServerSrc.includes('take sessions, measuredCompletedSets, and unmeasuredCompletedSets directly from that entry')
  && healthServerSrc.includes('set coverageComplete: true'));
check('health prompt: legacy source without week_summaries sets no coverage and no counts',
  healthServerSrc.includes('set coverageComplete on no week and leave measuredCompletedSets and unmeasuredCompletedSets empty'));
check('client: comparability gate requires coverageComplete',
  clientSrc.includes('week.coverageComplete === true'));

// ------------------------------------------------------- producer behavior
const summarize = new Function(
  `${stripTypeScriptTypes(extractFunction(producerSrc, 'summarizeWeekSummaries'))}\nreturn summarizeWeekSummaries;`,
)();

// Wednesday 2026-10-14 11:00 in Los Angeles (18:00Z, PDT = UTC-7).
const now = new Date('2026-10-14T18:00:00Z');
const la = (day, hour = 17) => new Date(Date.UTC(2026, 9, day, hour, 0, 0)).toISOString();

// PM counterexample: 21 completed workouts in the current week
// (Mon 2026-10-12 .. Sun 2026-10-18). The earliest (id 1) has one completed
// set missing weight; ids 2..20 are lb with a legal zero-weight set each;
// id 21 is kg with a real measured set.
const workouts = [];
const sets = [];
for (let id = 1; id <= 21; id++) {
  workouts.push({ id, completed_at: la(12 + (id % 3)), unit: id === 21 ? 'kg' : 'lb' });
}
sets.push({ workout_id: 1, weight: null, reps: 10, completed: true });
for (let id = 2; id <= 20; id++) sets.push({ workout_id: id, weight: 0, reps: 10, completed: true });
sets.push({ workout_id: 21, weight: 10, reps: 10, completed: true });
// Previous week (Mon 2026-10-05): one kg workout — two measured sets, one
// bodyweight set (weight null), one incomplete set that must be ignored.
workouts.push({ id: 30, completed_at: la(7), unit: 'kg' });
sets.push({ workout_id: 30, weight: 10, reps: 5, completed: true });
sets.push({ workout_id: 30, weight: 20, reps: 5, completed: true });
sets.push({ workout_id: 30, weight: null, reps: 12, completed: true });
sets.push({ workout_id: 30, weight: 50, reps: 5, completed: false });
// Three weeks ago: must fall outside both buckets.
workouts.push({ id: 40, completed_at: '2026-09-22T17:00:00.000Z', unit: 'lb' });
sets.push({ workout_id: 40, weight: 100, reps: 5, completed: true });

const [prev, cur] = summarize(workouts, sets, now);
check('producer: buckets are previous then current Monday week',
  prev.week_start === '2026-10-05' && cur.week_start === '2026-10-12');
check('PM counterexample: full week of 21 -> sessions 21 (no truncation)',
  cur.sessions === 21);
check('PM counterexample: the earliest missing-weight set is counted unmeasured=1',
  cur.unmeasured_completed_sets === 1);
check('producer: measured count covers the other 20 sets',
  cur.measured_completed_sets === 20);
check('producer: volume split by source unit (lb zero-weight 0, kg 10x10=100)',
  cur.volume_lb === 0 && cur.volume_kg === 100);
check('producer: previous week kg volume 150, bodyweight set unmeasured, incomplete set ignored',
  prev.sessions === 1 && prev.measured_completed_sets === 2 && prev.unmeasured_completed_sets === 1
  && prev.volume_kg === 150 && prev.volume_lb === 0);
check('producer: out-of-window workout excluded from both buckets',
  prev.sessions + cur.sessions === 22);

// The old failure mode, for the record: feeding the same producer only the
// 20 most recent workouts (the truncated sample) hides the unmeasured set —
// which is exactly why the handler must feed it the full week (asserted
// above at the source level) and why the client must not trust counts
// without coverageComplete (asserted below).
const truncated = workouts.filter((w) => w.id !== 1);
const [, curTrunc] = summarize(truncated, sets, now);
check('record: truncated sample would report unmeasured=0 (the old -100% trap)',
  curTrunc.unmeasured_completed_sets === 0 && curTrunc.sessions === 20);

const [emptyPrev, emptyCur] = summarize([], [], now);
check('producer: empty source -> both weeks present and zeroed',
  emptyPrev.week_start === '2026-10-05' && emptyCur.week_start === '2026-10-12'
  && emptyCur.sessions === 0 && emptyCur.measured_completed_sets === 0 && emptyCur.unmeasured_completed_sets === 0);

// --------------------------------------------------------- client behavior
const clientCode = ['weekIsComparable', 'weekComparisonLabel', 'weekComparisonReason']
  .map((n) => extractFunction(clientSrc, n)).join('\n');
const client = new Function(
  `${stripTypeScriptTypes(clientCode)}\nreturn { weekIsComparable, weekComparisonLabel, weekComparisonReason };`,
)();
const wk = (volume, extra = {}) => ({ weekStart: '2026-10-05', sessions: 1, volume, ...extra });
const covered = (volume, sets = 10) => wk(volume, { measuredCompletedSets: sets, unmeasuredCompletedSets: 0, coverageComplete: true });

check('client: fully covered weeks compare (+45%) with no reason',
  client.weekComparisonLabel(covered(145.4), covered(100)) === '+45%'
  && client.weekComparisonReason(covered(145.4), covered(100)) === null);
check('client: counts WITHOUT coverageComplete (last round snapshot) => 无法比较 + coverage reason, not missing-set reason',
  client.weekComparisonLabel(wk(0, { measuredCompletedSets: 20, unmeasuredCompletedSets: 0 }), covered(100)) === '无法比较'
  && client.weekComparisonReason(wk(0, { measuredCompletedSets: 20, unmeasuredCompletedSets: 0 }), covered(100))?.includes('整周覆盖尚未确认') === true
  && client.weekComparisonReason(wk(0, { measuredCompletedSets: 20, unmeasuredCompletedSets: 0 }), covered(100))?.includes('缺重量') === false);
check('client: PM chain end-to-end — full-week summary with unmeasured=1 becomes a covered-but-incomplete week => 无法比较 + missing-set reason',
  client.weekComparisonLabel(
    wk(0, { measuredCompletedSets: cur.measured_completed_sets, unmeasuredCompletedSets: cur.unmeasured_completed_sets, coverageComplete: true }),
    covered(100)) === '无法比较'
  && client.weekComparisonReason(
    wk(0, { measuredCompletedSets: cur.measured_completed_sets, unmeasuredCompletedSets: cur.unmeasured_completed_sets, coverageComplete: true }),
    covered(100))?.includes('缺重量或次数') === true);
check('client: coverageComplete true but measured count missing => 无法比较',
  client.weekComparisonLabel(wk(50, { unmeasuredCompletedSets: 0, coverageComplete: true }), covered(100)) === '无法比较');
check('client: coverageComplete explicitly false => 无法比较',
  client.weekComparisonLabel(wk(50, { measuredCompletedSets: 5, unmeasuredCompletedSets: 0, coverageComplete: false }), covered(100)) === '无法比较');
check('client: covered genuine-zero previous week => — and no reason mislabel',
  client.weekComparisonLabel(covered(100), wk(0, { sessions: 0, measuredCompletedSets: 0, unmeasuredCompletedSets: 0, coverageComplete: true })) === '—');
check('client: missing week => label —, reason null',
  client.weekComparisonLabel(undefined, covered(100)) === '—'
  && client.weekComparisonReason(undefined, covered(100)) === null);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
