// H-UI-001 (rework) validation.
// PM 2026-10-15 23:38: the Whoop home showed 50 for missing sleep (the
// server radar defaults the sleep dimension to 5 when both sleep
// components are missing) and the 0-21 strain score counted missing
// items as 0 and could splice a different date's daily row with
// dataDate's steps. This script runs the REAL production functions
// (actualSleepHours / numberLabel / percentBand / hasSleepSession /
// sleepScore / strainScore) extracted verbatim from
// health-dashboard/client/src/App.tsx over synthetic data only.
// Pure Node, no deps. It also executes three source mutations
// (removing the sleep-session gate, restoring the cross-date strain
// fallback, removing the strain missing-item gate) and asserts the
// mutated functions change the outcome — proving sensitivity.
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

check('source: WhoopHero driver hides missing sleep (hasSleepSession gate)',
  clientSrc.includes('hasSleepSession(snapshot) ? `${sleepHours.toFixed(1)} h` : "—"'));
check('source: strain note states same-date + completeness rule',
  clientSrc.includes('三项齐全时才换算'));

const FN_NAMES = ['numberLabel', 'actualSleepHours', 'percentBand', 'hasSleepSession', 'sleepScore', 'strainScore'];
function buildFns(src) {
  const code = FN_NAMES.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { hasSleepSession, sleepScore, strainScore };`)();
}
const { hasSleepSession, sleepScore, strainScore } = buildFns(clientSrc);

// ------------------------------------------------------------ synthetic data
const sleepPresent = {
  status: '正常', bedtime: '23:00', wakeTime: '06:00',
  inBedHours: 7, coreHours: 4, deepHours: 1, remHours: 2,
  awakeMinutes: 10, quality: 80, efficiency: 90, awakenings: 1,
};
const sleepMissing = {
  status: '数据缺失', bedtime: '00:00', wakeTime: '00:00',
  inBedHours: 0, coreHours: null, deepHours: null, remHours: null,
  awakeMinutes: null, quality: null, efficiency: null, awakenings: null,
};
function snapshot(over = {}) {
  return {
    dataDate: '2026-10-14',
    sleep: sleepPresent,
    historySleeps: [],
    historyDaily: [{ date: '2026-10-14', exerciseMinutes: 60, activeKcal: 300 }],
    steps: { value: 6000 },
    ...over,
  };
}
const comp = (key, score) => ({ key, score });
function readiness(over = {}) {
  return {
    score: 8, status: '准备就绪', confidence: '高', signalCount: 4,
    radar: [{ key: 'sleep', score: 5 }],
    components: [comp('lastSleep', null), comp('sleepBank', null), comp('hrv', 7), comp('restingHr', 7)],
    ...over,
  };
}

// ------------------------------------------------------------ sleepScore
{
  const r = sleepScore(snapshot({ sleep: sleepMissing }), readiness());
  check('sleep missing: no score, slate, 未记录 (server radar default 5 ignored)',
    r.pct === null && r.display === '—' && r.band === 'slate' && r.bandLabel === '数据不足' && r.detail.includes('昨晚睡眠未记录'));
  check('hasSleepSession: missing false / present true',
    hasSleepSession(snapshot({ sleep: sleepMissing })) === false && hasSleepSession(snapshot()) === true);
}
{
  // Sleep session exists but both sleep components are null while the
  // radar still carries the server default 5 -> must not show 50.
  const r = sleepScore(snapshot(), readiness());
  check('sleep present, both components null, radar 5: 数据不足 not 50, detail notes 睡眠信号不足',
    r.pct === null && r.bandLabel === '数据不足' && r.detail.includes('睡眠信号不足'));
}
{
  const r = sleepScore(snapshot({ sleep: sleepMissing }),
    readiness({ radar: [{ key: 'sleep', score: 8 }], components: [comp('lastSleep', 8), comp('sleepBank', null)] }));
  check('sleep missing even with a stale component score: still 未记录, no score',
    r.pct === null && r.detail.includes('昨晚睡眠未记录'));
}
{
  const r = sleepScore(snapshot(),
    readiness({ radar: [{ key: 'sleep', score: 8 }], components: [comp('lastSleep', 8), comp('sleepBank', null)] }));
  check('sleep present + lastSleep score 8: radar used, pct 80, 睡眠充足',
    r.pct === 80 && r.band === 'green' && r.bandLabel === '睡眠充足');
}
{
  const hist = Array.from({ length: 8 }, () => ({ totalHours: 7 }));
  const r = sleepScore(snapshot({ historySleeps: hist }), null);
  check('no readiness, >=8 nights history at need: fallback pct 100', r.pct === 100);
  const r2 = sleepScore(snapshot({ historySleeps: hist.slice(0, 7) }), null);
  check('no readiness, <8 nights history: 数据不足', r2.pct === null && r2.bandLabel === '数据不足');
  const r3 = sleepScore(snapshot({ sleep: sleepMissing, historySleeps: hist }), null);
  check('no readiness, sleep missing despite history: 未记录 (fallback gated)',
    r3.pct === null && r3.detail.includes('昨晚睡眠未记录'));
}

// ------------------------------------------------------------ strainScore
{
  const r = strainScore(snapshot({ historyDaily: [{ date: '2026-10-13', exerciseMinutes: 60, activeKcal: 300 }] }));
  check('strain: no row on dataDate -> 数据不足, no cross-date splice',
    r.pct === null && r.band === 'slate' && r.detail.includes('活动记录缺失'));
}
{
  const r = strainScore(snapshot({ historyDaily: [{ date: '2026-10-14', exerciseMinutes: null, activeKcal: 300 }] }));
  check('strain: exercise null -> 数据不足 naming 运动时长缺失',
    r.pct === null && r.detail.includes('运动时长缺失'));
  const r2 = strainScore(snapshot({ historyDaily: [{ date: '2026-10-14', exerciseMinutes: 30, activeKcal: null }] }));
  check('strain: kcal null -> 数据不足 naming 活动能量缺失',
    r2.pct === null && r2.detail.includes('活动能量缺失'));
  const r3 = strainScore(snapshot({ steps: { value: null } }));
  check('strain: steps null -> 数据不足 naming 步数缺失',
    r3.pct === null && r3.detail.includes('步数缺失'));
}
{
  const r = strainScore(snapshot({
    historyDaily: [{ date: '2026-10-14', exerciseMinutes: 0, activeKcal: 0 }],
    steps: { value: 0 },
  }));
  check('strain: all three truly zero -> complete score 0.0 (valid zero is not missing)',
    r.pct === 0 && r.display === '0.0' && r.band === 'blue');
}
{
  const r = strainScore(snapshot());
  check('strain: complete data 60min/300kcal/6000 steps -> 10.5, pct 50, green',
    r.display === '10.5' && r.pct === 50 && r.band === 'green');
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noSessionGate = buildFns(clientSrc.replace('if (!hasSleepSession(snapshot))', 'if (false)'));
  const snap = snapshot({ sleep: sleepMissing });
  const rd = readiness({ radar: [{ key: 'sleep', score: 8 }], components: [comp('lastSleep', 8), comp('sleepBank', null)] });
  check('mutation: removing sleep-session gate flips missing-sleep case to a score',
    sleepScore(snap, rd).pct === null && noSessionGate.sleepScore(snap, rd).pct === 80);

  const withFallback = buildFns(clientSrc.replace(
    '.find((daily) => daily.date === snapshot.dataDate)',
    '.find((daily) => daily.date === snapshot.dataDate) ?? snapshot.historyDaily[snapshot.historyDaily.length - 1]',
  ));
  const otherDay = snapshot({ historyDaily: [{ date: '2026-10-13', exerciseMinutes: 60, activeKcal: 300 }] });
  check('mutation: restoring cross-date fallback flips no-row case to a score',
    strainScore(otherDay).pct === null && withFallback.strainScore(otherDay).pct === 50);

  const noMissingGate = buildFns(clientSrc.replace('if (missing) {', 'if (false) {'));
  const partial = snapshot({ historyDaily: [{ date: '2026-10-14', exerciseMinutes: null, activeKcal: 300 }] });
  check('mutation: removing strain missing-item gate flips exercise-null case to a score',
    strainScore(partial).pct === null && noMissingGate.strainScore(partial).pct !== null);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
