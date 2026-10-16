// H-LOAD-001 (rework backfill) validation.
// PM 2026-10-16 02:40: the 07f38f2 delivery was registered in plans/changes
// only — the published weekLoad source was not in the repo and there were no
// rerunnable assertions, no same-window dual-source reconciliation, and no
// mutation evidence. This script runs the REAL production functions
// (mondayOf / shiftDateStr / percentBand / recoveryScore / volumeLabel /
// volumeInDisplayUnit / weekLoad) extracted verbatim from
// health-dashboard/client/src/App.tsx (now backfilled from the published
// artifact, space-4) over synthetic data only. Pure Node, no deps.
// It also executes two source mutations (removing the coverageComplete gate
// and removing the low-readiness red gate) and asserts the mutated function
// changes the verdict — proving the assertions below are sensitive to those
// gates rather than vacuous.
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

// ------------------------------------------------------------ source level
check('source: WeekLoad carries structured facts (sufficient/reasons/windows/pcts)',
  clientSrc.includes('sufficient: boolean;') && clientSrc.includes('sessionsChangePct: number | null;')
  && clientSrc.includes('durationChangePct: number | null;') && clientSrc.includes('volumeChangePct: number | null;'));
check('source: consumer WhoopHero renders weekLoad verdict + detail',
  clientSrc.includes('const load = weekLoad(snapshot, readiness);')
  && clientSrc.includes('<div className={`whoop-load whoop-${load.band}`}>')
  && clientSrc.includes('{load.verdict}') && clientSrc.includes('{load.detail}'));
check('source: WeekLoad carries window ranges + readinessTrend, WhoopHero renders the trend',
  clientSrc.includes('readinessTrend: ReadinessTrendPoint[];')
  && clientSrc.includes('currentWindow: { start: string; end: string }')
  && clientSrc.includes('load.readinessTrend.map')
  && clientSrc.includes('服务端只保存最新一天分数，其余日期为缺口，不复制今日值'));
check('source: no date-based HK strength dedup remains in weekLoad',
  !extractFunction(clientSrc, 'weekLoad').includes('strengthDates.has(session.date)'));
check('source: no exerciseMinutes aggregation remains in weekLoad',
  !extractFunction(clientSrc, 'weekLoad').includes('exerciseMinutes'));

const FN_NAMES = ['mondayOf', 'shiftDateStr', 'percentBand', 'recoveryScore', 'volumeLabel', 'volumeInDisplayUnit', 'dateLabel', 'weekLoad'];
function buildWeekLoad(src) {
  const lbLine = src.match(/const LB_TO_KG = [^;]+;/)[0];
  const code = FN_NAMES.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${lbLine}\n${stripTypeScriptTypes(code)}\nreturn weekLoad;`)();
}
const weekLoad = buildWeekLoad(clientSrc);

// ------------------------------------------------------------ synthetic data
// Anchor: dataDate Wed 2026-10-14; current window Mon 10-12..Wed 10-14,
// previous same-span Mon 10-05..Wed 10-07.
const CUR = ['2026-10-12', '2026-10-13', '2026-10-14'];
const PREV = ['2026-10-05', '2026-10-06', '2026-10-07'];
const daily = (dates) => dates.map((date) => ({ date, exerciseMinutes: 30 }));
const strengthWk = (weekStart, sessions, extra = {}) => ({
  weekStart, sessions, volume: 0, coverageComplete: true,
  measuredCompletedSets: 10, unmeasuredCompletedSets: 0, ...extra,
});
const sw = (date, durationMinutes, totalVolume = 1000, unit = 'lb') => ({
  status: 'completed', date, durationMinutes, totalVolume, unit,
});
const hk = (date, durationMinutes, type = 'Swimming') => ({ date, durationMinutes, type });

function snapshot(over = {}) {
  const base = {
    dataDate: '2026-10-14',
    coverageIncomplete: false,
    historyDaily: daily([...PREV, ...CUR]),
    historyWorkouts: [hk('2026-10-13', 30), hk('2026-10-06', 30)],
    strengthTraining: {
      updatedAt: '2026-10-14T00:00:00.000Z',
      displayUnit: 'lb',
      workouts: [sw('2026-10-12', 60), sw('2026-10-05', 60)],
      weeklyTrend: [strengthWk('2026-10-12', 1), strengthWk('2026-10-05', 1)],
    },
  };
  return { ...base, ...over, strengthTraining: { ...base.strengthTraining, ...(over.strengthTraining ?? {}) } };
}
const readiness = (over = {}) => ({
  date: '2026-10-15', score: 8, confidence: '高', status: '恢复良好', sleepDebtHours: 1,
  components: [{ key: 'hrv', zScore: 0 }, { key: 'restingHr', zScore: 0 }], ...over,
});

// ------------------------------------------------------------ happy path
{
  const r = weekLoad(snapshot(), readiness());
  check('dual-source same window: current sessions 2 (1 strength + 1 HK), duration 90, volume 1000',
    r.current.sessions === 2 && r.current.strengthSessions === 1 && r.current.healthKitSessions === 1
    && r.current.durationMinutes === 90 && r.current.strengthVolume === 1000);
  check('dual-source same window: previous sessions 2, duration 90; all pcts 0',
    r.previous.sessions === 2 && r.previous.durationMinutes === 90
    && r.sessionsChangePct === 0 && r.durationChangePct === 0 && r.volumeChangePct === 0);
  check('normal tier: sufficient + green verdict',
    r.sufficient === true && r.band === 'green' && r.verdict.includes('状态稳定'));
  check('detail reconciles both windows + strength volume',
    r.detail.includes('训练 2 次') && r.detail.includes('上周同期') && r.detail.includes('容量 1,000 lb'));
  check('visible: both window date ranges shown (current 10/12–10/14, previous 10/5–10/7)',
    r.detail.includes('本周（10/12–10/14）') && r.detail.includes('上周同期（10/5–10/7）')
    && r.currentWindow.start === '2026-10-12' && r.currentWindow.end === '2026-10-14'
    && r.previousWindow.start === '2026-10-05' && r.previousWindow.end === '2026-10-07');
  check('visible: all three change pcts in detail (sessions/duration/volume) + previous volume with unit',
    r.detail.includes('次数较上周同期 0%') && r.detail.includes('时长较上周同期 0%')
    && r.detail.includes('容量较上周同期 0%') && r.detail.includes('上周同期 1 次 · 容量 1,000 lb'));
  check('readinessTrend: 7 consecutive dates ending at readiness.date, only that date carries the score',
    r.readinessTrend.length === 7 && r.readinessTrend[0].date === '2026-10-09'
    && r.readinessTrend[6].date === '2026-10-15' && r.readinessTrend[6].score === 8
    && r.readinessTrend.slice(0, 6).every((point) => point.score === null));
}

// Cross-source ambiguity (PM 2026-10-16 05:45): an HK strength session on
// a date that also has a completed strength workout can never be proven
// to be the same session (HK rows carry no start/end or cross-source id),
// so nothing is deleted by date — both sources' facts are kept and the
// whole comparison degrades to insufficient with no percentages/verdict.
{
  const snap = snapshot({
    historyWorkouts: [hk('2026-10-12', 45, 'Traditional Strength Training'), hk('2026-10-12', 20), hk('2026-10-06', 30)],
    strengthTraining: {
      workouts: [sw('2026-10-12', 60), sw('2026-10-12', 50, 500), sw('2026-10-05', 60)],
      weeklyTrend: [strengthWk('2026-10-12', 2), strengthWk('2026-10-05', 1)],
    },
  });
  const r = weekLoad(snap, readiness());
  check('ambiguity: same-day HK strength + strength record -> insufficient, reason names the date',
    r.sufficient === false && r.band === 'slate'
    && r.reasons.some((x) => x.includes('重复归属未确认') && x.includes('2026-10-12'))
    && r.sessionsChangePct === null && r.durationChangePct === null && r.volumeChangePct === null);
  check('ambiguity: both sources kept (strength 2 + HK 2 = 4 sessions, duration 175, volume 1500)',
    r.current.strengthSessions === 2 && r.current.healthKitSessions === 2
    && r.current.sessions === 4 && r.current.durationMinutes === 175 && r.current.strengthVolume === 1500);
  check('ambiguity: detail keeps both-source facts and the reason',
    r.detail.includes('HealthKit 2 次') && r.detail.includes('重复归属未确认'));
}
// PM's exact synthetic case: strength record 60m on a day, HK has one
// plausibly-duplicate 60m strength session AND one independent 90m
// strength session that same day. The old date-based deletion returned
// 1 session / 60m / green; the correct outcome is ambiguity, not a guess.
{
  const snap = snapshot({
    historyWorkouts: [hk('2026-10-13', 60, 'Traditional Strength Training'), hk('2026-10-13', 90, 'Traditional Strength Training'), hk('2026-10-06', 30)],
    strengthTraining: {
      workouts: [sw('2026-10-13', 60), sw('2026-10-05', 60)],
      weeklyTrend: [strengthWk('2026-10-12', 1), strengthWk('2026-10-05', 1)],
    },
  });
  const r = weekLoad(snap, readiness());
  check('ambiguity (PM case): independent HK strength session is not silently deleted',
    r.sufficient === false && r.current.sessions === 3 && r.current.durationMinutes === 210
    && r.reasons.some((x) => x.includes('重复归属未确认')));
  const moved = snapshot({
    historyWorkouts: [hk('2026-10-13', 60, 'Traditional Strength Training'), hk('2026-10-14', 90, 'Traditional Strength Training'), hk('2026-10-06', 30)],
    strengthTraining: {
      workouts: [sw('2026-10-13', 60), sw('2026-10-05', 60)],
      weeklyTrend: [strengthWk('2026-10-12', 1), strengthWk('2026-10-05', 1)],
    },
  });
  const r2 = weekLoad(moved, readiness());
  check('ambiguity (PM case): HK strength on a date with NO strength record counts normally',
    r2.sufficient === false && r2.current.healthKitSessions === 2);
  const clean = snapshot({
    historyWorkouts: [hk('2026-10-14', 90, 'Traditional Strength Training'), hk('2026-10-06', 30)],
  });
  const r3 = weekLoad(clean, readiness());
  check('no overlap at all: sufficient, HK strength session counted (sessions 2, duration 150)',
    r3.sufficient === true && r3.current.sessions === 2 && r3.current.durationMinutes === 150);
}
// readinessTrend without readiness: dated gaps only, ending dataDate + 1.
{
  const r = weekLoad(snapshot(), null);
  check('readinessTrend: null readiness -> 7 dated gaps ending 2026-10-15, no copied score',
    r.readinessTrend.length === 7 && r.readinessTrend[6].date === '2026-10-15'
    && r.readinessTrend.every((point) => point.score === null));
}

// Unit conversion per session into displayUnit.
{
  const snap = snapshot({
    strengthTraining: {
      displayUnit: 'kg',
      workouts: [sw('2026-10-12', 60, 100, 'kg'), sw('2026-10-05', 60, 100, 'kg')],
    },
  });
  const r = weekLoad(snap, readiness());
  check('unit: kg sessions shown in kg display unit unchanged (100)',
    Math.abs(r.current.strengthVolume - 100) < 1e-9);
  const snapLb = snapshot({
    strengthTraining: { workouts: [sw('2026-10-12', 60, 100, 'kg'), sw('2026-10-05', 60)] },
  });
  const r2 = weekLoad(snapLb, readiness());
  check('unit: 100 kg converted to lb display (220.46…)',
    Math.abs(r2.current.strengthVolume - 100 / 0.45359237) < 0.01);
}

// Previous window zero: no fabricated percentages.
{
  const snap = snapshot({
    historyWorkouts: [hk('2026-10-13', 30)],
    strengthTraining: {
      workouts: [sw('2026-10-12', 60)],
      weeklyTrend: [strengthWk('2026-10-12', 1), strengthWk('2026-10-05', 0)],
    },
  });
  const r = weekLoad(snap, readiness());
  check('previous zero: sufficient, pcts null, detail says 不算百分比',
    r.sufficient === true && r.sessionsChangePct === null && r.durationChangePct === null
    && r.volumeChangePct === null && r.detail.includes('不算百分比'));
}

// ------------------------------------------------------------ three tiers
{
  const up = (curDur, prevDur) => snapshot({
    historyWorkouts: [hk('2026-10-13', curDur - 60), hk('2026-10-06', prevDur - 60)],
  });
  const y = weekLoad(up(130, 100), readiness());
  check('yellow: duration +30% within +20..+40 band', y.band === 'yellow' && y.durationChangePct === 30);
  const red = weekLoad(up(150, 100), readiness({ components: [{ key: 'hrv', zScore: -0.2 }, { key: 'restingHr', zScore: 0 }] }));
  check('red: duration +50% with worsening HRV', red.band === 'red' && red.verdict.includes('该歇了'));
  const noWorsen = weekLoad(up(150, 100), readiness());
  check('not red: duration +50% without recovery worsening stays yellow',
    noWorsen.band === 'yellow');
  check('red: low readiness score < 2 alone',
    weekLoad(snapshot(), readiness({ score: 1.5 })).band === 'red');
  check('red: hrvZ <= -1 and restingZ <= -0.5',
    weekLoad(snapshot(), readiness({ components: [{ key: 'hrv', zScore: -1.2 }, { key: 'restingHr', zScore: -0.6 }] })).band === 'red');
  check('yellow: hrvZ <= -0.5 alone',
    weekLoad(snapshot(), readiness({ components: [{ key: 'hrv', zScore: -0.6 }, { key: 'restingHr', zScore: 0 }] })).band === 'yellow');
  check('red: sleep debt >= 5h', weekLoad(snapshot(), readiness({ sleepDebtHours: 5 })).band === 'red');
  check('yellow: sleep debt 3-5h', weekLoad(snapshot(), readiness({ sleepDebtHours: 3.5 })).band === 'yellow');
  check('low confidence never green: slate + 先不下结论',
    (() => { const r = weekLoad(snapshot(), readiness({ confidence: '低' })); return r.band === 'slate' && r.verdict.includes('置信度低'); })());
  check('missing readiness: slate recovery-insufficient, facts still sufficient',
    (() => { const r = weekLoad(snapshot(), null); return r.band === 'slate' && r.sufficient === true && r.verdict.includes('恢复数据不足'); })());
}

// ------------------------------------------------------------ insufficient gates
function expectInsufficient(name, snap, reasonPart) {
  const r = weekLoad(snap, readiness());
  check(`insufficient: ${name}`,
    r.sufficient === false && r.band === 'slate' && r.sessionsChangePct === null
    && r.durationChangePct === null && r.volumeChangePct === null
    && r.reasons.some((x) => x.includes(reasonPart)), r.reasons.join('; '));
}
expectInsufficient('coverageIncomplete flag', snapshot({ coverageIncomplete: true }), '还没同步完');
expectInsufficient('missing one daily row in previous window',
  snapshot({ historyDaily: daily([...PREV.slice(1), ...CUR]) }), '每日记录缺 2026-10-05');
expectInsufficient('duplicated daily row',
  snapshot({ historyDaily: [...daily([...PREV, ...CUR]), { date: '2026-10-13', exerciseMinutes: 5 }] }), '重复');
expectInsufficient('strength not synced', snapshot({ strengthTraining: { updatedAt: null } }), '力量训练尚未同步');
expectInsufficient('strength week summary missing',
  snapshot({ strengthTraining: { weeklyTrend: [strengthWk('2026-10-12', 1)] } }), '力量周汇总缺失');
expectInsufficient('coverageComplete not true',
  snapshot({ strengthTraining: { weeklyTrend: [strengthWk('2026-10-12', 1, { coverageComplete: false }), strengthWk('2026-10-05', 1)] } }), '整周覆盖未确认');
expectInsufficient('set counts missing',
  snapshot({ strengthTraining: { weeklyTrend: [strengthWk('2026-10-12', 1, { measuredCompletedSets: undefined }), strengthWk('2026-10-05', 1)] } }), '计数缺失');
expectInsufficient('unmeasured completed set',
  snapshot({ strengthTraining: { weeklyTrend: [strengthWk('2026-10-12', 1, { unmeasuredCompletedSets: 1 }), strengthWk('2026-10-05', 1)] } }), '缺重量或次数');
expectInsufficient('workout list disagrees with whole-week summary (truncated list)',
  snapshot({ strengthTraining: { weeklyTrend: [strengthWk('2026-10-12', 2), strengthWk('2026-10-05', 1)] } }), '不一致');
expectInsufficient('HK session without duration',
  snapshot({ historyWorkouts: [hk('2026-10-13', null), hk('2026-10-06', 30)] }), '时长缺失');
expectInsufficient('strength session without duration',
  snapshot({ strengthTraining: { workouts: [sw('2026-10-12', null), sw('2026-10-05', 60)] } }), '时长缺失');

// Monday boundary: window is the single Monday in each week.
{
  const snap = snapshot({
    dataDate: '2026-10-12',
    historyDaily: daily(['2026-10-05', '2026-10-12']),
    historyWorkouts: [hk('2026-10-12', 30), hk('2026-10-05', 30), hk('2026-10-13', 99)],
    strengthTraining: {
      workouts: [sw('2026-10-12', 60), sw('2026-10-05', 60)],
      weeklyTrend: [strengthWk('2026-10-12', 1), strengthWk('2026-10-05', 1)],
    },
  });
  const r = weekLoad(snap, readiness());
  check('monday boundary: elapsed 1 day both windows, out-of-window session excluded',
    r.sufficient === true && r.current.sessions === 2 && r.current.durationMinutes === 90 && r.previous.sessions === 2);
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noCoverage = buildWeekLoad(clientSrc.replace('if (week.coverageComplete !== true)', 'if (false)'));
  const snap = snapshot({ strengthTraining: { weeklyTrend: [strengthWk('2026-10-12', 1, { coverageComplete: false }), strengthWk('2026-10-05', 1)] } });
  check('mutation: removing coverageComplete gate flips that case to sufficient (assertions are sensitive)',
    weekLoad(snap, readiness()).sufficient === false && noCoverage(snap, readiness()).sufficient === true);
  const noLowScore = buildWeekLoad(clientSrc.replace('readiness.score < 2', 'false'));
  check('mutation: removing low-readiness gate flips score 1.5 case from red to green',
    weekLoad(snapshot(), readiness({ score: 1.5 })).band === 'red'
    && noLowScore(snapshot(), readiness({ score: 1.5 })).band === 'green');
  const noAmbiguity = buildWeekLoad(clientSrc.replace('addReason(`重复归属未确认', 'void(`重复归属未确认'));
  const ambSnap = snapshot({
    historyWorkouts: [hk('2026-10-12', 45, 'Traditional Strength Training'), hk('2026-10-06', 30)],
  });
  check('mutation: removing the ambiguity gate flips the same-day overlap case to sufficient',
    weekLoad(ambSnap, readiness()).sufficient === false
    && noAmbiguity(ambSnap, readiness()).sufficient === true);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
