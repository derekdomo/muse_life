// H-UI-001 (rework) validation, synced to the TRIMP era.
// User decision 2026-10-17 ("按学术来"): the daily load score is
// Banister TRIMP (1991) — duration × ΔHR × 0.64·e^(1.92·ΔHR) summed
// over the day's sessions, shown on a 0–21 saturating map banded by
// WHOOP's published ranges (轻 0–9 / 中 10–13 / 高 14–17 / 全力 18–21).
// The PM 2026-10-15 neutral downgrade ("负荷评分公式未经审定") is
// superseded: strainScore now returns a computable score when the
// day's sessions carry duration + average HR, resting HR and HRmax
// are known, and stays honest (computable: false, missingReason named)
// when any input is missing. Sessions are filtered to dataDate only
// (no cross-date splice); a session missing duration or average HR is
// skipped and named in the detail, never scored as zero load.
// This script runs the REAL production functions
// (actualSleepHours / numberLabel / percentBand / hasSleepSession /
// sleepScore / strainScore, plus dateLabel used by strainScore's
// honesty notes) extracted verbatim from
// health-dashboard/client/src/App.tsx over synthetic data only.
// Pure Node, no deps. It also executes three source mutations
// (removing the sleep-session gate, restoring a cross-date session
// fallback, restoring a scored return on the missing-input path) and
// asserts the mutated functions change the outcome — proving
// sensitivity.
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

check('source: hero sleep ring hides missing sleep (hasSleepSession gate in sleepScore)',
  clientSrc.includes('<ScoreRing label="睡眠" score={sleep} suffix="%"')
  && extractFunction(clientSrc, 'sleepScore').includes('if (!hasSleepSession(snapshot))'));
check('source: strain note states the Banister TRIMP caliber, no unreviewed-formula downgrade',
  clientSrc.includes('负荷口径 · Banister TRIMP') && clientSrc.includes('0–21 分为饱和映射 21×(1 − e^(−TRIMP/150))')
  && !clientSrc.includes('负荷评分公式未经审定'));
check('source: readiness trend note states archive-based history, never copies today\'s value',
  clientSrc.includes('readiness 近 7 天：有存档的日期显示当日分数') && clientSrc.includes('不复制今日值'));
check('source: strain ring carries the /21 suffix when computable',
  clientSrc.includes('score={strain} suffix="/ 21"'));
check('source: 0-21 strain formula and band labels are the TRIMP-era wording (轻/中/高/全力)',
  clientSrc.includes('轻负荷') && clientSrc.includes('中等负荷') && clientSrc.includes('高负荷') && clientSrc.includes('全力以赴')
  && clientSrc.includes('/ 21'));

const FN_NAMES = ['numberLabel', 'actualSleepHours', 'percentBand', 'hasSleepSession', 'sleepScore', 'strainScore', 'dateLabel'];
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
    historyDaily: [{ date: '2026-10-14', exerciseMinutes: 60, activeKcal: 300, restingHr: 60, hrMax: 190 }],
    historyWorkouts: [],
    steps: { value: 6000 },
    restingHr: { value: 60 },
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

// ------------------------------------------------------------ strainScore (Banister TRIMP)
{
  // Only dataDate's own sessions count: a session on another day is
  // never spliced in, and missing inputs are never treated as zero
  // load — the score is honest about what it could score.
  const r = strainScore(snapshot({ historyWorkouts: [{ date: '2026-10-13', durationMinutes: 30, averageHr: 150 }] }));
  check('strain: session on another day is not spliced in (dataDate filter)',
    r.computable === true && r.scoredSessions === 0 && r.totalSessions === 0 && r.trimp === 0
    && r.detail.includes('TRIMP 0') && r.detail.includes('0 次运动'));
}
{
  // 30 min at 150 bpm, resting 60, HRmax 190:
  // ΔHR = 90/130, TRIMP = 30 × ΔHR × 0.64·e^(1.92·ΔHR) ≈ 50.2,
  // value = 21×(1−e^(−TRIMP/150)) ≈ 6.0 → 轻负荷. The zero-duration
  // session is scored (a real zero is a fact, not missing data).
  const r = strainScore(snapshot({
    historyWorkouts: [
      { date: '2026-10-14', durationMinutes: 30, averageHr: 150 },
      { date: '2026-10-14', durationMinutes: 0, averageHr: 150 },
    ],
  }));
  check('strain: complete session data computes a TRIMP score with /21 banding, real zeros scored',
    r.computable === true && r.missingReason === null
    && r.display === '6.0' && r.bandLabel === '轻负荷' && r.band === 'blue' && r.pct === 29
    && r.scoredSessions === 2 && r.totalSessions === 2
    && r.detail.includes('TRIMP 50') && r.detail.includes('2 次运动'));
  const mixed = strainScore(snapshot({
    historyWorkouts: [
      { date: '2026-10-14', durationMinutes: 30, averageHr: 150 },
      { date: '2026-10-14', durationMinutes: null, averageHr: 150 },
    ],
  }));
  check('strain: session missing duration/avgHr is skipped and named in the detail, never scored as zero',
    mixed.computable === true && mixed.scoredSessions === 1 && mixed.totalSessions === 2
    && mixed.detail.includes('TRIMP 50 · 1 次运动') && mixed.detail.includes('另 1 次缺心率/时长未计入'));
}
{
  const r = strainScore(snapshot({
    historyWorkouts: [{ date: '2026-10-14', durationMinutes: null, averageHr: 150 }],
  }));
  check('strain: sessions without scorable HR data -> not computable, names the missing input',
    r.computable === false && r.pct === null && r.display === '—' && r.band === 'slate' && r.bandLabel === '数据不足'
    && r.detail.includes('缺平均心率或时长') && r.missingReason === '运动缺心率或时长');
}
{
  const r = strainScore(snapshot({
    historyDaily: [{ date: '2026-10-14', exerciseMinutes: 60, activeKcal: 300, restingHr: null, hrMax: 190 }],
    restingHr: { value: null },
  }));
  check('strain: resting HR missing -> not computable, names 静息心率缺失',
    r.computable === false && r.pct === null && r.display === '—' && r.bandLabel === '数据不足'
    && r.detail.includes('静息心率缺失') && r.missingReason === '静息心率缺失');
  const r2 = strainScore(snapshot({
    historyDaily: [{ date: '2026-10-14', exerciseMinutes: 60, activeKcal: 300, restingHr: 60 }],
  }));
  check('strain: HRmax missing -> 待同步, never fabricates a max',
    r2.computable === false && r2.pct === null && r2.bandLabel === '待同步'
    && r2.detail.includes('最高心率未同步') && r2.missingReason === '最高心率未同步');
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noSessionGate = buildFns(clientSrc.replace('if (!hasSleepSession(snapshot))', 'if (false)'));
  const snap = snapshot({ sleep: sleepMissing });
  const rd = readiness({ radar: [{ key: 'sleep', score: 8 }], components: [comp('lastSleep', 8), comp('sleepBank', null)] });
  check('mutation: removing sleep-session gate flips missing-sleep case to a score',
    sleepScore(snap, rd).pct === null && noSessionGate.sleepScore(snap, rd).pct === 80);

  const withFallback = buildFns(clientSrc.replace(
    'snapshot.historyWorkouts.filter((workout) => workout.date === date)',
    'snapshot.historyWorkouts',
  ));
  const otherDay = snapshot({ historyWorkouts: [{ date: '2026-10-13', durationMinutes: 30, averageHr: 150 }] });
  check('mutation: restoring a cross-date session fallback scores the other day\'s session',
    strainScore(otherDay).scoredSessions === 0 && withFallback.strainScore(otherDay).scoredSessions === 1);

  const scored = buildFns(clientSrc.replace(
    'pct: null, display: "—", band: "slate", bandLabel, detail, missingReason,',
    'pct: 50, display: "10.5", band: "green", bandLabel: "负荷适中", detail, missingReason,',
  ));
  const restMissing = snapshot({
    historyDaily: [{ date: '2026-10-14', exerciseMinutes: 60, activeKcal: 300, restingHr: null, hrMax: 190 }],
    restingHr: { value: null },
  });
  check('mutation: restoring a scored strain return flips the missing-resting case to a numeric score',
    strainScore(restMissing).pct === null && scored.strainScore(restMissing).pct === 50);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
