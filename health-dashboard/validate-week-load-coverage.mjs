// H-LOAD-001 / H-SYNC-DIVERGE-001 (coverage + previous-week absolutes)
// validation.
//
// Two contracts on the REAL client weekLoad (extracted verbatim from
// client/src/App.tsx and executed over synthetic fixtures only):
// (1) The snapshot-level coverageIncomplete flag carries NO locatable
//     detail — no query, no date. When it is set and every concrete
//     window check passed, the comparison must downgrade conservatively:
//     sufficient=false, every percentage null, slate band, and the
//     reason states that the comparison cannot be confirmed
//     (「无法确认本周对比」). The old claim — flag set + sufficient +
//     percentages + green band + "窗口外有日期覆盖不完整，不影响本周对比" —
//     must never come back. When a concrete in-window gap exists, that
//     named gap stays the reason. With no coverage problem at all, the
//     original behavior is unchanged.
// (2) factsDetail's first-screen line stays compact (this week +
//     percentages), and the previous week's same-span absolutes —
//     sessions / duration / strength volume plus exercise minutes and
//     steps summed from the daily rows, labelled with their exact
//     window — are present in weekLoad's previousDetail for the
//     expandable detail area, in sufficient AND insufficient outcomes.
//
// Source root: the live artifact workspace (the source of truth). Set
// HD_ROOT to run against another copy. Pure Node, no deps.
// Exit code is non-zero when any assertion fails.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..', '..', 'ts-spaces', 'space-4');
const ROOT = process.env.HD_ROOT ?? (existsSync(join(DEFAULT_ROOT, 'client', 'src', 'App.tsx')) ? DEFAULT_ROOT : HERE);
const clientSrc = readFileSync(join(ROOT, 'client', 'src', 'App.tsx'), 'utf8');

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
  const idx = source.search(new RegExp(`(async )?function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  let pos = closeParen;
  for (;;) {
    const candidate = source.indexOf('{', pos);
    if (candidate < 0) throw new Error(`function ${name}: no body found`);
    const end = matchDelim(source, candidate, '{', '}');
    const between = source.slice(closeParen + 1, candidate).trim();
    const after = source.slice(end + 1).trimStart();
    if (between !== ':' && !after.startsWith('|')) return source.slice(idx, end + 1);
    pos = end + 1;
  }
}

// ------------------------------------------------------- source level
check('source: the "不影响本周对比" assertion is gone from the client',
  !clientSrc.includes('不影响本周对比'));
check('source: weekLoad carries previousDetail (previous-week absolutes); weekLoad itself has no coverageNote (that field legitimately belongs to week-review metrics)',
  clientSrc.includes('previousDetail: string') && !extractFunction(clientSrc, 'weekLoad').includes('coverageNote'));
check('source: the load block renders the previous-week absolutes in an expandable details area (combined expand layer)',
  clientSrc.includes('<summary className="whoop-load-note">负荷依据 · 上周同期数据 · readiness 近 7 天</summary>')
  && clientSrc.includes('{load.previousDetail}'));

// ------------------------------------------------------- real weekLoad
function buildWeekLoad(source) {
  const names = ['mondayOf', 'shiftDateStr', 'volumeLabel', 'volumeInDisplayUnit', 'dateLabel', 'weekLoad'];
  const lbLine = source.match(/const LB_TO_KG = [^;]+;/)[0];
  const code = names.map((n) => extractFunction(source, n)).join('\n');
  return new Function(`${lbLine}\n${stripTypeScriptTypes(code)}\nreturn weekLoad;`)();
}
const weekLoad = buildWeekLoad(clientSrc);

// Synthetic fixture: dataDate Wednesday 2026-10-14. Both windows fully
// covered — daily rows for every date 2026-09-28..2026-10-14 (exercise
// 30 min, 8000 steps each), strength weeks with confirmed whole-week
// coverage and no unmeasured sets, 3 completed strength sessions in
// each Mon–Wed window (60 min, 500 lb each), no HealthKit sessions.
const DATES = [];
for (let d = 28; d <= 30; d++) DATES.push(`2026-09-${d}`);
for (let d = 1; d <= 14; d++) DATES.push(`2026-10-${String(d).padStart(2, '0')}`);
const workout = (id, date) => ({
  id, date, startedAt: `${date}T15:00:00.000Z`, completedAt: `${date}T16:00:00.000Z`,
  status: 'completed', routine: 'push', unit: 'lb', durationMinutes: 60,
  completedSets: 1, totalSets: 1, totalVolume: 500, exercises: [],
});
function fixture(overrides = {}) {
  return {
    dataDate: '2026-10-14',
    coverageIncomplete: false,
    historySleeps: [],
    historyWorkouts: [],
    historyDaily: DATES.map((date) => ({ date, steps: 8000, exerciseMinutes: 30 })),
    strengthTraining: {
      updatedAt: '2026-10-14T16:00:00.000Z', displayUnit: 'lb',
      workouts: [
        workout('c1', '2026-10-12'), workout('c2', '2026-10-13'), workout('c3', '2026-10-14'),
        workout('p1', '2026-10-05'), workout('p2', '2026-10-06'), workout('p3', '2026-10-07'),
      ],
      weeklyTrend: [
        { weekStart: '2026-10-05', sessions: 3, volume: 1500, coverageComplete: true, measuredCompletedSets: 10, unmeasuredCompletedSets: 0 },
        { weekStart: '2026-10-12', sessions: 3, volume: 1500, coverageComplete: true, measuredCompletedSets: 10, unmeasuredCompletedSets: 0 },
      ],
    },
    ...overrides,
  };
}
const readinessStub = {
  score: 7, confidence: '高', sleepDebtHours: 0.5,
  components: [
    { key: 'hrv', zScore: 0.3 },
    { key: 'restingHr', zScore: 0.2 },
  ],
};

// ------------------------------------- baseline: no coverage problem
{
  const load = weekLoad(fixture(), readinessStub);
  check('baseline: complete windows + no coverage flag stay sufficient (original behavior unchanged)',
    load.sufficient === true, load.reasons.join(';'));
  check('baseline: equal weeks compare at 0% on all three metrics',
    load.sessionsChangePct === 0 && load.durationChangePct === 0 && load.volumeChangePct === 0);
  check('baseline: benign readiness + flat load stays green',
    load.band === 'green', load.verdict);
  check('baseline: first-screen detail keeps this week + percentages, compact',
    load.detail.includes('本周 3 次') && load.detail.includes('较上周') && !load.detail.includes('上周同期（'));
  check('previousDetail: previous-week absolutes with the exact window label',
    load.previousDetail.includes('上周同期（10/5–10/7）'), load.previousDetail);
  check('previousDetail: sessions / duration / strength volume absolutes present',
    load.previousDetail.includes('训练 3 次') && load.previousDetail.includes('时长 180 分钟')
    && load.previousDetail.includes('力量 3 次') && load.previousDetail.includes('容量 1,500 lb'), load.previousDetail);
  check('previousDetail: exercise minutes and steps summed from the daily rows',
    load.previousDetail.includes('运动 90 分钟') && load.previousDetail.includes('步数 24,000 步'), load.previousDetail);
}

// --------------------- coverage flag set, no locatable gap → downgrade
{
  const load = weekLoad(fixture({ coverageIncomplete: true }), readinessStub);
  check('coverage: unlocatable coverageIncomplete downgrades to insufficient',
    load.sufficient === false, load.reasons.join(';'));
  check('coverage: all percentages are null when downgraded',
    load.sessionsChangePct === null && load.durationChangePct === null && load.volumeChangePct === null);
  check('coverage: band is slate (no green) and verdict refuses to compare',
    load.band === 'slate' && load.verdict === '数据不足，暂不比较', load.verdict);
  check('coverage: the reason states plainly that the comparison cannot be confirmed',
    load.reasons.some((r) => r.includes('无法确认本周对比')) && load.detail.includes('无法确认本周对比'), load.reasons.join(';'));
  check('coverage: the old "不影响本周对比" assertion appears nowhere in the result',
    !JSON.stringify(load).includes('不影响本周对比'));
  check('coverage: known facts are still shown (this week sessions/duration, previous absolutes)',
    load.detail.includes('本周已知 3 次') && load.previousDetail.includes('训练 3 次'), load.detail);
}

// --------------------- coverage flag set WITH a concrete in-window gap
{
  const snap = fixture({ coverageIncomplete: true });
  snap.historyDaily = snap.historyDaily.filter((row) => row.date !== '2026-10-13');
  const load = weekLoad(snap, readinessStub);
  check('coverage+gap: still insufficient, and the CONCRETE gap is the named reason',
    load.sufficient === false && load.reasons.some((r) => r.includes('每日记录缺') && r.includes('2026-10-13')), load.reasons.join(';'));
  check('coverage+gap: percentages stay null',
    load.sessionsChangePct === null && load.durationChangePct === null && load.volumeChangePct === null);
}

// --------------------- no flag, concrete gap → original downgrade path
{
  const snap = fixture();
  snap.historyDaily = snap.historyDaily.filter((row) => row.date !== '2026-10-06');
  const load = weekLoad(snap, readinessStub);
  check('gap only: insufficient via the concrete previous-window gap (original behavior unchanged)',
    load.sufficient === false && load.reasons.some((r) => r.includes('上周同期每日记录缺')), load.reasons.join(';'));
}

// --------------------- previous-week daily metrics honestly missing
{
  const snap = fixture();
  snap.historyDaily = snap.historyDaily.map((row) => (row.date >= '2026-10-05' && row.date <= '2026-10-07' ? { ...row, steps: null } : row));
  const load = weekLoad(snap, readinessStub);
  check('previousDetail: a null-steps previous window says 未记录 instead of summing the days that exist',
    load.previousDetail.includes('步数 未记录') && load.previousDetail.includes('运动 90 分钟'), load.previousDetail);
}

// ------------------------------------------------------------- mutation
{
  const mutated = clientSrc.replace(
    'if (snapshot.coverageIncomplete && reasons.length === 0) {',
    'if (snapshot.coverageIncomplete && reasons.length < 0) {',
  );
  const mutantLoad = buildWeekLoad(mutated);
  const load = mutantLoad(fixture({ coverageIncomplete: true }), readinessStub);
  check('mutation: disabling the coverage downgrade restores the old sufficient/green outcome (downgrade is load-bearing)',
    mutated !== clientSrc && load.sufficient === true,
    `mutant sufficient: ${load.sufficient}`);
}

console.log(`\n${passed} passed, ${failures} failed (source root: ${ROOT})`);
process.exit(failures ? 1 : 0);
