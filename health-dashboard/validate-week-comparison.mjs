// H-UNITS-001 (comparability rework) validation: the StrengthPanel
// week-over-week label must never turn an unknown/partial volume into a
// percentage. Runs the REAL weekIsComparable / weekComparisonLabel
// extracted from client/src/App.tsx (types stripped with
// node:module.stripTypeScriptTypes) over synthetic weeks only.
// Pre-fix behaviour (for the record): the old inline expression
//   delta = prev.volume > 0 ? round((cur.volume - prev.volume) / prev.volume * 100) : null
// turns the PM counterexample (this week one completed set with weight
// null -> volume 0, last week a valid 100) into "-100%". The first
// assertion below reproduces that old result from the old formula, and
// the rest assert the new label for the same input is "无法比较".
// Pure Node, no deps. Exit code non-zero on any failure.
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

// ---------------------------------------------------------------- source
check('server schema: measuredCompletedSets optional',
  serverSrc.includes('measuredCompletedSets: z.number().int().nonnegative().optional(),'));
check('server schema: unmeasuredCompletedSets optional',
  serverSrc.includes('unmeasuredCompletedSets: z.number().int().nonnegative().optional(),'));
check('sync prompt takes both counts per week from week_summaries',
  serverSrc.includes('take sessions, measuredCompletedSets, and unmeasuredCompletedSets directly from that entry'));
check('server schema: coverageComplete optional',
  serverSrc.includes('coverageComplete: z.boolean().optional(),'));
check('sync prompt forbids inferring coverage from the truncated workouts array',
  serverSrc.includes('never infer whole-week sessions or set counts from the truncated workouts list'));
check('panel uses the shared comparison label',
  clientSrc.includes('const comparison = weekComparisonLabel(currentWeek, previousWeek);'));
check('panel no longer computes the old raw delta expression',
  !clientSrc.includes('((currentWeek.volume - previousWeek.volume) / previousWeek.volume) * 100'));
check('incomplete/unconfirmed weeks are tagged distinctly in the panel',
  clientSrc.includes('currentWeekTag') && clientSrc.includes('不完整') && clientSrc.includes('未确认'));

// ------------------------------------------------------- real-function run
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
const code = ['weekIsComparable', 'weekComparisonLabel'].map((n) => extractFunction(clientSrc, n)).join('\n');
const impl = new Function(`${stripTypeScriptTypes(code)}\nreturn { weekIsComparable, weekComparisonLabel };`)();
const label = impl.weekComparisonLabel;

// Week fixtures: volume is already in displayUnit (server/prompt contract).
const wk = (volume, extra = {}) => ({ weekStart: '2026-10-05', sessions: 1, volume, ...extra });
// A "measured" week under the current contract: counts recorded AND
// whole-week coverage confirmed (coverageComplete from week_summaries).
const measured = (volume, sets = 10) => wk(volume, { measuredCompletedSets: sets, unmeasuredCompletedSets: 0, coverageComplete: true });

// PM counterexample, pre-fix formula reproduced for the record:
{
  const oldDelta = Math.round(((0 - 100) / 100) * 100);
  check('pre-fix baseline: old formula turns the unknown-volume week into -100%', oldDelta === -100);
}
// Missing weight (this week: one completed set, weight null, reps present
// -> upstream volume 0, that set counted unmeasured):
check('missing weight week vs valid week => 无法比较 (not -100%)',
  label(wk(0, { measuredCompletedSets: 0, unmeasuredCompletedSets: 1 }), measured(100)) === '无法比较');
// Missing reps (same upstream shape: set without reps contributes nothing):
check('missing reps week vs valid week => 无法比较',
  label(wk(0, { measuredCompletedSets: 0, unmeasuredCompletedSets: 1 }), measured(100)) === '无法比较');
// All sets unknown (a full session, nothing measured):
check('all-unknown week vs valid week => 无法比较',
  label(wk(0, { measuredCompletedSets: 0, unmeasuredCompletedSets: 12 }), measured(100)) === '无法比较');
// Partially missing (some measured volume, some unmeasured sets):
check('partially missing week (volume 50 + 2 unmeasured) vs valid 100 => 无法比较 (not -50%)',
  label(wk(50, { measuredCompletedSets: 8, unmeasuredCompletedSets: 2 }), measured(100)) === '无法比较');
// Unmeasured sets in the PREVIOUS week also block the comparison:
check('valid week vs partially missing previous week => 无法比较',
  label(measured(100), wk(50, { measuredCompletedSets: 8, unmeasuredCompletedSets: 2 })) === '无法比较');
// Bodyweight week: completed sets exist but all are bodyweight
// (weight null by design) -> counted unmeasured -> not comparable:
check('bodyweight-only week vs valid week => 无法比较',
  label(wk(0, { measuredCompletedSets: 0, unmeasuredCompletedSets: 9 }), measured(100)) === '无法比较');
// Legacy snapshot: counts never recorded -> coverage unknown:
check('legacy weeks without counts => 无法比较',
  label(wk(80), wk(100)) === '无法比较');
check('one legacy week is enough to block the comparison',
  label(measured(80), wk(100)) === '无法比较');
// Effective zero: previous week fully measured with volume 0 (no
// sessions) is a genuine zero baseline -> no percentage, but also not
// "无法比较":
check('comparable zero previous week => — (no percentage, not 无法比较)',
  label(measured(100), wk(0, { sessions: 0, measuredCompletedSets: 0, unmeasuredCompletedSets: 0, coverageComplete: true })) === '—');
// Comparable current zero (no training this week, coverage recorded)
// against a valid previous week is a real -100%:
check('comparable zero current week vs valid 100 => -100% (genuine)',
  label(wk(0, { sessions: 0, measuredCompletedSets: 0, unmeasuredCompletedSets: 0, coverageComplete: true }), measured(100)) === '-100%');
// All-valid mixed-unit weeks: weeklyTrend volumes are already converted
// to displayUnit, so the ratio is the same in either display unit and
// switching units cannot manufacture progress:
check('all-valid weeks in kg (145.4 vs 100) => +45%',
  label(measured(145.4), measured(100)) === '+45%');
check('same weeks switched to lb (320.5 vs 220.5) => same +45%, no fake progress',
  label(measured(320.5), measured(220.5)) === '+45%');
check('all-valid decrease (80 vs 100) => -20%',
  label(measured(80), measured(100)) === '-20%');
// Missing weeks:
check('no current week => —', label(undefined, measured(100)) === '—');
check('no previous week => —', label(measured(100), undefined) === '—');
check('weekIsComparable: measured week true, unmeasured/legacy false',
  impl.weekIsComparable(measured(10)) === true
  && impl.weekIsComparable(wk(10, { measuredCompletedSets: 3, unmeasuredCompletedSets: 1 })) === false
  && impl.weekIsComparable(wk(10)) === false
  && impl.weekIsComparable(undefined) === false);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
