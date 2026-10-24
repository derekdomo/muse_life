// H-SEASON-TAB-001 validation （季节专项 · 游泳版）.
// Runs the REAL production derivations (seasonSwimSessions /
// seasonSwimSummary / seasonSwimDecay / seasonDeltaText) extracted
// verbatim from health-dashboard/client/src/App.tsx, plus source
// checks on the server pipeline contract (actions.ts) and the tab
// wiring. Pure Node, no deps.
//
// Fixtures are FULLY SYNTHETIC and unrelated to any real record
// (invented calendar 2027-05, invented distances/durations/strokes).
// The reconciliation against the owner's real HealthKit records was
// done only in the private runtime and is recorded in changes.md as
// counts/consistency only — never as values in this repository.
// Calibers under test: pace = durationMinutes / distanceMeters x100
// (session totals); strokes per lap = totalStrokes / lapCount (with
// the stored-segment-count fallback); personal bests (min pace / max
// distance / min strokes-per-lap, earliest wins ties); latest vs the
// trailing-30-day mean anchored on the latest swim's own date; lap
// decay halves (first half = first floor(n/2) laps, the middle lap
// of an odd count belongs to the second half).
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
function near(a, b, tol = 1e-9) { return a !== null && b !== null && Math.abs(a - b) <= tol; }
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
  let angle = 0;
  let braceDepth = 0;
  const candidates = [];
  for (let i = closeParen + 1; i < source.length && candidates.length < 6; i++) {
    const ch = source[i];
    if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === '{') {
      if (angle === 0 && braceDepth === 0) candidates.push(i);
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (braceDepth < 0) break;
    }
  }
  for (const bodyStart of candidates) {
    const bodyEnd = matchDelim(source, bodyStart, '{', '}');
    const slice = source.slice(idx, bodyEnd + 1);
    try {
      const fn = new Function(`${stripTypeScriptTypes(slice)}\nreturn typeof ${name} === 'function' ? ${name} : null;`)();
      if (typeof fn === 'function') return slice;
    } catch { /* not the body brace — try the next candidate */ }
  }
  throw new Error(`body of ${name} not found`);
}
const FN_NAMES = ['numberLabel', 'shiftDateStr', 'isSwimWorkout', 'seasonSwimSessions', 'seasonSwimSummary', 'seasonSwimDecay', 'seasonDeltaText'];
function buildFns(src) {
  const parts = FN_NAMES.map((name) => extractFunction(src, name));
  return new Function(`${stripTypeScriptTypes(parts.join('\n'))}\nreturn { seasonSwimSessions, seasonSwimSummary, seasonSwimDecay, seasonDeltaText };`)();
}
const { seasonSwimSessions, seasonSwimSummary, seasonSwimDecay, seasonDeltaText } = buildFns(clientSrc);

// ------------------------------------------------------------- fixtures
// Synthetic laps: `count` laps, the first `splitAt` at `firstSeconds`,
// the rest at `secondSeconds`; strokes alternate 17/18, some nulls.
function makeLaps(count, firstSeconds, secondSeconds, splitAt) {
  return Array.from({ length: count }, (_, i) => ({
    durationSeconds: i < splitAt ? firstSeconds : secondSeconds,
    strokes: i % 5 === 4 ? null : (i % 2 === 0 ? 17 : 18),
    averageHr: i % 4 === 3 ? null : 130 + (i % 7),
  }));
}
const historyWorkouts = [
  { id: 's1', date: '2027-05-02', type: 'swimming', distanceMeters: 500, durationMinutes: 17.5, energyKcal: 210, averageHr: 128, maxHr: 141,
    swimDetail: { totalStrokes: 350, lapCount: 20, lapLengthMeters: 25, segments: makeLaps(20, 45, 50, 10) } },
  { id: 's2', date: '2027-05-09', type: 'swimming', distanceMeters: 600, durationMinutes: 19.8, energyKcal: 235, averageHr: 131, maxHr: 145,
    swimDetail: { totalStrokes: 408, lapCount: 24, lapLengthMeters: 25, segments: null } },
  { id: 's3', date: '2027-05-16', type: 'swimming', distanceMeters: 600, durationMinutes: 18.6, energyKcal: 228, averageHr: 130, maxHr: 144,
    swimDetail: { totalStrokes: 384, lapCount: 24, lapLengthMeters: 25, segments: makeLaps(24, 44, 44, 12) } },
  { id: 'r1', date: '2027-05-20', type: 'running', distanceMeters: 5000, durationMinutes: 27, energyKcal: 320, averageHr: 152, maxHr: 171 },
  { id: 's4', date: '2027-05-23', type: 'swimming', distanceMeters: 750, durationMinutes: 25.5, energyKcal: 305, averageHr: 133, maxHr: 148,
    swimDetail: { totalStrokes: null, lapCount: null, lapLengthMeters: null, segments: makeLaps(30, 47, 49, 15) } },
  { id: 's5', date: '2027-05-30', type: 'swimming', distanceMeters: 600, durationMinutes: 20.4, energyKcal: 244, averageHr: 129, maxHr: 142,
    swimDetail: { totalStrokes: 420, lapCount: 24, lapLengthMeters: 25, segments: makeLaps(24, 46, 46, 12) } },
];

// ------------------------------------------------- session derivation
const sessions = seasonSwimSessions(historyWorkouts);
check('sessions: only the 5 swims, ascending', sessions.map((s) => s.id).join(',') === 's1,s2,s3,s4,s5', sessions.map((s) => s.id).join(','));
const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
check('card s1: pace from session totals (17.5/500x100)', near(byId.s1.paceMinPer100m, 3.5, 1e-9), String(byId.s1.paceMinPer100m));
check('card s3: pace (18.6/600x100)', near(byId.s3.paceMinPer100m, 3.1, 1e-9), String(byId.s3.paceMinPer100m));
check('card s1: strokes per lap (350/20)', near(byId.s1.strokesPerLap, 17.5), String(byId.s1.strokesPerLap));
check('card s3: strokes per lap (384/24)', near(byId.s3.strokesPerLap, 16), String(byId.s3.strokesPerLap));
check('card s1: session facts pass through (hr avg/peak, kcal, strokes, laps)',
  byId.s1.averageHr === 128 && byId.s1.maxHr === 141 && byId.s1.energyKcal === 210 && byId.s1.totalStrokes === 350 && byId.s1.lapCount === 20 && byId.s1.lapLengthMeters === 25);
check('fallback s4: lapCount from segment count', byId.s4.lapCount === 30, String(byId.s4.lapCount));
check('fallback s4: lapLength from distance / segment count', near(byId.s4.lapLengthMeters, 25), String(byId.s4.lapLengthMeters));
check('fallback s4: strokes per lap stays unknown without totalStrokes', byId.s4.strokesPerLap === null);
check('degraded s2: segments stay null (never reconstructed)', byId.s2.segments === null && byId.s2.lapCount === 24);
check('legacy row without swimDetail/maxHr parses to honest nulls', (() => {
  const legacy = seasonSwimSessions([{ id: 'old', date: '2027-04-01', type: 'swimming', distanceMeters: 400, durationMinutes: 15, energyKcal: null, averageHr: null }]);
  const row = legacy[0];
  return row.totalStrokes === null && row.lapCount === null && row.segments === null && row.maxHr === null && near(row.paceMinPer100m, 3.75);
})());
check('pace unknown when duration or distance missing', (() => {
  const rows = seasonSwimSessions([
    { id: 'n1', date: '2027-04-02', type: 'swimming', distanceMeters: 400, durationMinutes: null, energyKcal: null, averageHr: null },
    { id: 'n2', date: '2027-04-03', type: 'swimming', distanceMeters: null, durationMinutes: 12, energyKcal: null, averageHr: null },
  ]);
  return rows[0].paceMinPer100m === null && rows[1].paceMinPer100m === null;
})());

// ------------------------------------------------------- personal bests
const summary = seasonSwimSummary(historyWorkouts);
check('best: fastest pace is s3', summary.bestPaceId === 's3', String(summary.bestPaceId));
check('best: longest distance is s4', summary.bestDistanceId === 's4', String(summary.bestDistanceId));
check('best: lowest strokes per lap is s3', summary.bestStrokesPerLapId === 's3', String(summary.bestStrokesPerLapId));
check('best: ties keep the earliest session', (() => {
  const tied = seasonSwimSummary([
    { id: 't1', date: '2027-06-01', type: 'swimming', distanceMeters: 500, durationMinutes: 17.5, energyKcal: null, averageHr: null, swimDetail: { totalStrokes: 350, lapCount: 20, lapLengthMeters: 25, segments: null } },
    { id: 't2', date: '2027-06-08', type: 'swimming', distanceMeters: 500, durationMinutes: 17.5, energyKcal: null, averageHr: null, swimDetail: { totalStrokes: 350, lapCount: 20, lapLengthMeters: 25, segments: null } },
  ]);
  return tied.bestPaceId === 't1' && tied.bestDistanceId === 't1' && tied.bestStrokesPerLapId === 't1';
})());

// ------------------------------------------- latest vs trailing-30d mean
// Latest = s5 (2027-05-30); window 05-01..05-30 holds all 5 swims.
// pace mean = (3.5+3.3+3.1+3.4+3.4)/5 = 3.34 -> delta +0.06 (slower).
// spl mean over the 4 known = (17.5+17+16+17.5)/4 = 17.0 -> delta +0.5.
// distance mean = 3050/5 = 610 -> delta -10.
const cmp = summary.comparison;
check('comparison: anchored on the latest swim date', cmp !== null && cmp.anchorDate === '2027-05-30', cmp?.anchorDate ?? 'null');
check('comparison: window holds all 5 swims', cmp !== null && cmp.windowCount === 5, String(cmp?.windowCount));
check('comparison: pace delta +0.06', cmp !== null && near(cmp.paceDelta, 0.06, 0.011), String(cmp?.paceDelta));
check('comparison: pace delta text pairs symbol + number + direction word',
  cmp !== null && seasonDeltaText(cmp.paceDelta, 'pace') === '▲ 慢 0.06 分/100米（配速更高 = 更慢）',
  cmp ? seasonDeltaText(cmp.paceDelta, 'pace') : 'null');
check('comparison: strokes-per-lap delta +0.5', cmp !== null && near(cmp.strokesPerLapDelta, 0.5, 0.011), String(cmp?.strokesPerLapDelta));
check('comparison: strokes-per-lap delta text',
  cmp !== null && seasonDeltaText(cmp.strokesPerLapDelta, 'strokesPerLap') === '▲ 多 0.5 划/趟（单趟划数更多）',
  cmp ? seasonDeltaText(cmp.strokesPerLapDelta, 'strokesPerLap') : 'null');
check('comparison: distance delta -10', cmp !== null && near(cmp.distanceDelta, -10, 0.011), String(cmp?.distanceDelta));
check('comparison: distance delta text',
  cmp !== null && seasonDeltaText(cmp.distanceDelta, 'distance') === '▼ 少 10 米（距离更短）',
  cmp ? seasonDeltaText(cmp.distanceDelta, 'distance') : 'null');
check('comparison: window excludes swims older than 30 days before the latest', (() => {
  const wide = seasonSwimSummary([
    { id: 'old1', date: '2027-03-01', type: 'swimming', distanceMeters: 900, durationMinutes: 36, energyKcal: null, averageHr: null, swimDetail: { totalStrokes: 720, lapCount: 36, lapLengthMeters: 25, segments: null } },
    { id: 'new1', date: '2027-05-30', type: 'swimming', distanceMeters: 600, durationMinutes: 20.4, energyKcal: null, averageHr: null, swimDetail: { totalStrokes: 420, lapCount: 24, lapLengthMeters: 25, segments: null } },
  ]);
  return wide.comparison !== null && wide.comparison.windowCount === 1 && near(wide.comparison.paceDelta, 0, 1e-9);
})());
check('delta text: faster pace reads ▼ 快 with the lower-is-faster note',
  seasonDeltaText(-0.12, 'pace') === '▼ 快 0.12 分/100米（配速更低 = 更快）', seasonDeltaText(-0.12, 'pace'));
check('delta text: fewer strokes reads ▼ 少', seasonDeltaText(-0.4, 'strokesPerLap') === '▼ 少 0.4 划/趟（单趟划数更少）', seasonDeltaText(-0.4, 'strokesPerLap'));
check('delta text: longer distance reads ▲ 多', seasonDeltaText(25, 'distance') === '▲ 多 25 米（距离更长）', seasonDeltaText(25, 'distance'));
check('delta text: null delta is an honest no-compare', seasonDeltaText(null, 'pace') === '— 数据不足，无法比较');
check('delta text: zero delta reads as a tie, not an arrow', seasonDeltaText(0, 'distance').startsWith('→ 与均值持平'), seasonDeltaText(0, 'distance'));
check('empty input: no sessions, no bests, no comparison', (() => {
  const empty = seasonSwimSummary([]);
  return empty.sessions.length === 0 && empty.bestPaceId === null && empty.bestDistanceId === null && empty.bestStrokesPerLapId === null && empty.comparison === null;
})());

// ------------------------------------------------------------- lap decay
const decayS1 = seasonSwimDecay(byId.s1.segments);
check('decay s1: lap count and extremes (ties keep first)',
  decayS1 !== null && decayS1.lapCount === 20 && decayS1.fastest.index === 1 && decayS1.fastest.seconds === 45 && decayS1.slowest.index === 11 && decayS1.slowest.seconds === 50,
  JSON.stringify(decayS1 && { f: decayS1.fastest, s: decayS1.slowest }));
check('decay s1: halves 45 -> 50 = +11.1%, worded 变慢 with the even-split note',
  decayS1 !== null && near(decayS1.decayPercent, 100 / 9, 0.05) && decayS1.text.includes('后半程+11.1%') && decayS1.text.includes('后半程变慢') && decayS1.text.includes('前后半程趟数相同'),
  decayS1?.text ?? 'null');
check('decay odd count: middle lap belongs to the second half (stated in the text)', (() => {
  const odd = seasonSwimDecay([40, 42, 44, 46, 48].map((sec) => ({ durationSeconds: sec, strokes: null, averageHr: null })));
  return odd !== null && near(odd.firstHalfAvgSeconds, 41) && near(odd.secondHalfAvgSeconds, 46)
    && odd.text.includes('中间趟计入后半程') && odd.text.includes('最快第 1 趟') && odd.text.includes('最慢第 5 趟');
})());
check('decay negative: a faster second half reads 变快', (() => {
  const neg = seasonSwimDecay([50, 48, 40, 38].map((sec) => ({ durationSeconds: sec, strokes: null, averageHr: null })));
  return neg !== null && neg.decayPercent < 0 && neg.text.includes('后半程变快') && neg.text.includes('后半程-20.4%');
})());
check('decay flat: equal halves read 基本持平', (() => {
  const flat = seasonSwimDecay(byId.s3.segments);
  return flat !== null && near(flat.decayPercent, 0) && flat.text.includes('前后半程基本持平');
})());
check('decay missing: null segments and a single lap both degrade to null',
  seasonSwimDecay(null) === null && seasonSwimDecay([{ durationSeconds: 40, strokes: 17, averageHr: 130 }]) === null && seasonSwimDecay(byId.s2.segments) === null);

// -------------------------------------------------------- source wiring
check('source: client Tab union carries the season tab', clientSrc.includes('"season"'));
check('source: nav renders the 季节专项 button', clientSrc.includes('>季节专项</button>'));
check('source: dashboard routes the season tab to SeasonSwimView', clientSrc.includes('<SeasonSwimView snapshot={snapshot} />'));
check('source: SeasonSwimView derives from seasonSwimSummary over historyWorkouts',
  clientSrc.includes('seasonSwimSummary(snapshot.historyWorkouts)'));
check('source: caliber note names the source and the 25m pool',
  clientSrc.includes('数据来源：Apple Health 游泳 workout · 池长 25 米'));
check('source: today view carries no season derivation (tab is independent, today not lengthened)', (() => {
  const start = clientSrc.indexOf('function TodayView(');
  const end = clientSrc.indexOf('function TrendsView(', start);
  return start > -1 && end > start && !clientSrc.slice(start, end).includes('seasonSwim');
})());
check('source: server schema carries swimDetail + maxHr on the workout row',
  serverSrc.includes('const swimDetailSchema') && serverSrc.includes('swimDetail: swimDetailSchema.nullable().optional()') && serverSrc.includes('maxHr: z.number().positive().nullable().optional()'));
check('source: refresh prompt requests the swim segment fields',
  serverSrc.includes('swimming_stroke_count,lap_count,lap_length_meters,segments'));
check('source: refresh prompt keeps ONLY lap-type segments (aggregates excluded)',
  serverSrc.includes('keep ONLY entries whose segment_type is "lap"'));
check('source: refresh prompt forbids reconstructing laps from totals',
  serverSrc.includes('set segments to null rather than reconstructing laps from totals'));

// ------------------------------------------- mutation sensitivity
// Dropping the pace-best minimum comparison (every session wins)
// must move the best mark off s3 — it lands on the last session —
// proving the min-selection is what the best assertions exercise.
const summaryFnSrc = extractFunction(clientSrc, 'seasonSwimSummary');
const mutatedSrc = clientSrc.replace(summaryFnSrc, summaryFnSrc.replace('session.paceMinPer100m < bestPace', 'true'));
check('mutation: best-pace comparison pattern found', mutatedSrc !== clientSrc);
if (mutatedSrc !== clientSrc) {
  const mutated = buildFns(mutatedSrc);
  check('mutation: without the minimum comparison the pace best is just the last session',
    mutated.seasonSwimSummary(historyWorkouts).bestPaceId === 's5',
    String(mutated.seasonSwimSummary(historyWorkouts).bestPaceId));
}
// Shifting the comparison window anchor from the latest swim's date
// to a fixed later date must change the window membership.
const mutatedWindow = clientSrc.replace('const windowStart = shiftDateStr(latest.date, -29);', 'const windowStart = shiftDateStr(latest.date, -10);');
check('mutation: window-anchor pattern found', mutatedWindow !== clientSrc);
if (mutatedWindow !== clientSrc) {
  const mutated = buildFns(mutatedWindow);
  const narrowed = mutated.seasonSwimSummary(historyWorkouts);
  check('mutation: narrowing the window drops older swims from the mean',
    narrowed.comparison !== null && narrowed.comparison.windowCount === 2 && summary.comparison.windowCount === 5,
    `mutated=${narrowed.comparison?.windowCount} original=${summary.comparison.windowCount}`);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
