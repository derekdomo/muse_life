// H-SWIM-STROKE-001 validation （泳姿推断）.
// Runs the REAL production derivations (classifySwimLap /
// aggregateSwimStrokes / swimStrokeBreakdown / swimStrokeTotals, plus
// their dependencies seasonSwimSessions / seasonSwimSummary) extracted
// verbatim from health-dashboard/client/src/App.tsx, plus source
// checks on the stroke UI wiring. Pure Node, no deps.
//
// Fixtures are FULLY SYNTHETIC and unrelated to any real record
// (invented calendar 2027-06, invented durations/strokes/heart rates).
// The reconciliation against the owner's real HealthKit records was
// done only in the private runtime and is recorded in changes.md as
// counts/consistency only — never as values in this repository.
//
// Calibers under test (owner calibration 2026-10-24: fast cluster =
// freestyle 自由泳, slow cluster = breaststroke 蛙泳; every surface
// labels this 推测 — Apple Health carries NO native stroke label):
// - duration <= 38s -> freestyle; >= 45s -> breaststroke;
// - the (38, 45)s overlap band falls back to strokes (<= 17
//   freestyle, > 17 breaststroke); with no strokes in the band the
//   split is 41.5s;
// - duration missing -> strokes only; both missing -> null.
// Aggregation: distance = lapCount x lap length (25 m when the lap
// length is unknown); shares are over CLASSIFIED distance only; pace
// comes from the group's mean lap duration; heart rate averages only
// laps that carry one; unclassified laps are counted, never dropped
// silently.
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
const FN_NAMES = ['numberLabel', 'shiftDateStr', 'isSwimWorkout', 'seasonSwimSessions', 'seasonSwimSummary', 'classifySwimLap', 'aggregateSwimStrokes', 'swimStrokeBreakdown', 'swimStrokeTotals', 'swimStrokeGroupLine'];
function buildFns(src) {
  const parts = FN_NAMES.map((name) => extractFunction(src, name));
  return new Function(`${stripTypeScriptTypes(parts.join('\n'))}\nreturn { seasonSwimSessions, seasonSwimSummary, classifySwimLap, swimStrokeBreakdown, swimStrokeTotals, swimStrokeGroupLine };`)();
}
const { seasonSwimSessions, seasonSwimSummary, classifySwimLap, swimStrokeBreakdown, swimStrokeTotals, swimStrokeGroupLine } = buildFns(clientSrc);

// ------------------------------------------------- classify: duration
check('classify: 38.0s boundary is freestyle (duration wins over strokes)', classifySwimLap(38.0, 99) === 'freestyle');
check('classify: 45.0s boundary is breaststroke (duration wins over strokes)', classifySwimLap(45.0, 1) === 'breaststroke');
check('classify: clearly fast lap is freestyle', classifySwimLap(30, null) === 'freestyle');
check('classify: clearly slow lap is breaststroke', classifySwimLap(52, null) === 'breaststroke');

// ------------------------------------------- classify: overlap band
check('classify: band 41s + 15 strokes is freestyle', classifySwimLap(41, 15) === 'freestyle');
check('classify: band 41s + 20 strokes is breaststroke', classifySwimLap(41, 20) === 'breaststroke');
check('classify: band strokes boundary 17 is freestyle', classifySwimLap(42, 17) === 'freestyle');
check('classify: band strokes boundary 18 is breaststroke', classifySwimLap(42, 18) === 'breaststroke');
check('classify: band without strokes, 41s (<= 41.5) is freestyle', classifySwimLap(41, null) === 'freestyle');
check('classify: band without strokes, 43s (> 41.5) is breaststroke', classifySwimLap(43, null) === 'breaststroke');
check('classify: band without strokes, exactly 41.5s is freestyle', classifySwimLap(41.5, null) === 'freestyle');

// --------------------------------------------- classify: missing data
check('classify: duration missing, strokes 14 -> freestyle', classifySwimLap(null, 14) === 'freestyle');
check('classify: duration missing, strokes 17 boundary -> freestyle', classifySwimLap(null, 17) === 'freestyle');
check('classify: duration missing, strokes 18 -> breaststroke', classifySwimLap(null, 18) === 'breaststroke');
check('classify: both missing -> null (unclassified, never guessed)', classifySwimLap(null, null) === null);

// ------------------------------------------------------------- fixtures
// Synthetic bimodal session A (10 laps x 25 m), built end-to-end
// through seasonSwimSessions from a synthetic workout record.
// freestyle laps: #1 33s/15, #2 36s/16 (hr null), #3 band 41s/15,
//   #7 duration-missing/14 strokes  -> 4 laps
// breaststroke laps: #4 band 41s/20, #5 48s/21, #6 52s/22 (hr null),
//   #8 duration-missing/19 strokes, #10 band 43s/no strokes -> 5 laps
// unclassified: #9 both missing -> 1 lap
const lapsA = [
  { durationSeconds: 33, strokes: 15, averageHr: 120 },
  { durationSeconds: 36, strokes: 16, averageHr: null },
  { durationSeconds: 41, strokes: 15, averageHr: 122 },
  { durationSeconds: 41, strokes: 20, averageHr: 124 },
  { durationSeconds: 48, strokes: 21, averageHr: 126 },
  { durationSeconds: 52, strokes: 22, averageHr: null },
  { durationSeconds: null, strokes: 14, averageHr: 118 },
  { durationSeconds: null, strokes: 19, averageHr: 128 },
  { durationSeconds: null, strokes: null, averageHr: 130 },
  { durationSeconds: 43, strokes: null, averageHr: 121 },
];
const workoutsA = [
  { id: 'a1', date: '2027-06-01', type: 'swimming', distanceMeters: 250, durationMinutes: 12, energyKcal: 150, averageHr: 123, maxHr: 135,
    swimDetail: { totalStrokes: null, lapCount: 10, lapLengthMeters: 25, segments: lapsA } },
  { id: 'r1', date: '2027-06-02', type: 'running', distanceMeters: 3000, durationMinutes: 15, energyKcal: 200, averageHr: 150, maxHr: 165 },
];
const sessionsA = seasonSwimSessions(workoutsA);
check('pipeline: seasonSwimSessions keeps only the synthetic swim', sessionsA.length === 1 && sessionsA[0].id === 'a1');
check('pipeline: seasonSwimSummary sessions feed the same derivation', seasonSwimSummary(workoutsA).sessions.length === 1);

const bdA = swimStrokeBreakdown(sessionsA[0]);
check('breakdown A: freestyle lap count', bdA.freestyle.lapCount === 4, String(bdA.freestyle.lapCount));
check('breakdown A: breaststroke lap count', bdA.breaststroke.lapCount === 5, String(bdA.breaststroke.lapCount));
check('breakdown A: unclassified counted, not dropped', bdA.unclassifiedCount === 1, String(bdA.unclassifiedCount));
check('breakdown A: distance = laps x lap length (free 4x25, breast 5x25)',
  bdA.freestyle.distanceMeters === 100 && bdA.breaststroke.distanceMeters === 125);
check('breakdown A: shares are over classified distance only (100/225, 125/225)',
  near(bdA.freestyle.distanceSharePercent, 100 / 225 * 100) && near(bdA.breaststroke.distanceSharePercent, 125 / 225 * 100),
  `${bdA.freestyle.distanceSharePercent}/${bdA.breaststroke.distanceSharePercent}`);
check('breakdown A: freestyle pace from mean duration ((33+36+41)/3 s over 25 m)',
  near(bdA.freestyle.paceMinPer100m, (110 / 3) / 25 * 100 / 60), String(bdA.freestyle.paceMinPer100m));
check('breakdown A: breaststroke pace from mean duration ((41+48+52+43)/4 s over 25 m)',
  near(bdA.breaststroke.paceMinPer100m, 46 / 25 * 100 / 60), String(bdA.breaststroke.paceMinPer100m));
check('breakdown A: freestyle avg strokes (15+16+15+14)/4', near(bdA.freestyle.avgStrokesPerLap, 15), String(bdA.freestyle.avgStrokesPerLap));
check('breakdown A: breaststroke avg strokes skip the strokeless lap ((20+21+22+19)/4)', near(bdA.breaststroke.avgStrokesPerLap, 20.5), String(bdA.breaststroke.avgStrokesPerLap));
check('breakdown A: freestyle avg hr counts only laps carrying hr ((120+122+118)/3)', near(bdA.freestyle.avgHr, 120), String(bdA.freestyle.avgHr));
check('breakdown A: breaststroke avg hr counts only laps carrying hr ((124+126+128+121)/4)', near(bdA.breaststroke.avgHr, 124.75), String(bdA.breaststroke.avgHr));
check('group line: renders counts, distance, share, pace, strokes and hr as text+numbers',
  swimStrokeGroupLine(bdA.freestyle).includes('4 趟') && swimStrokeGroupLine(bdA.freestyle).includes('100 米') && swimStrokeGroupLine(bdA.freestyle).includes('44.4%'));

// ------------------------------------- session B: lap length missing
// Constructed directly as a session (lapLengthMeters null): the
// aggregation must fall back to the stated 25 m pool caliber.
const sessionB = {
  id: 'b1', date: '2027-06-08', distanceMeters: null, durationMinutes: null, energyKcal: null,
  averageHr: null, maxHr: null, totalStrokes: null, lapCount: 4, lapLengthMeters: null,
  paceMinPer100m: null, strokesPerLap: null,
  segments: [
    { durationSeconds: 30, strokes: 12, averageHr: 110 },
    { durationSeconds: 50, strokes: 20, averageHr: 130 },
    { durationSeconds: 38.0, strokes: 17, averageHr: null },
    { durationSeconds: 45.0, strokes: 10, averageHr: 140 },
  ],
};
const bdB = swimStrokeBreakdown(sessionB);
check('breakdown B: missing lap length falls back to 25 m (2 laps -> 50 m per group)',
  bdB.freestyle.distanceMeters === 50 && bdB.breaststroke.distanceMeters === 50);
check('breakdown B: equal groups split the classified share 50/50',
  near(bdB.freestyle.distanceSharePercent, 50) && near(bdB.breaststroke.distanceSharePercent, 50));
check('breakdown B: no unclassified laps', bdB.unclassifiedCount === 0);

// ------------------------------------------------------- order freedom
const shuffledA = { ...sessionsA[0], segments: [...lapsA].reverse() };
const bdShuffled = swimStrokeBreakdown(shuffledA);
check('order: shuffled laps keep group counts and unclassified count',
  bdShuffled.freestyle.lapCount === bdA.freestyle.lapCount && bdShuffled.breaststroke.lapCount === bdA.breaststroke.lapCount && bdShuffled.unclassifiedCount === bdA.unclassifiedCount);
check('order: shuffled laps keep distances, shares and group means',
  bdShuffled.freestyle.distanceMeters === bdA.freestyle.distanceMeters
  && near(bdShuffled.freestyle.distanceSharePercent, bdA.freestyle.distanceSharePercent)
  && near(bdShuffled.breaststroke.avgHr, bdA.breaststroke.avgHr)
  && near(bdShuffled.freestyle.avgStrokesPerLap, bdA.freestyle.avgStrokesPerLap));

// ------------------------------------------------------------ totals
const totals = swimStrokeTotals([sessionsA[0], sessionB]);
check('totals: lap counts aggregate across sessions (free 4+2, breast 5+2)',
  totals.freestyle.lapCount === 6 && totals.breaststroke.lapCount === 7, `${totals.freestyle.lapCount}/${totals.breaststroke.lapCount}`);
check('totals: distances aggregate (free 150 m, breast 175 m)',
  totals.freestyle.distanceMeters === 150 && totals.breaststroke.distanceMeters === 175);
check('totals: shares recomputed over the combined classified distance (150/325, 175/325)',
  near(totals.freestyle.distanceSharePercent, 150 / 325 * 100) && near(totals.breaststroke.distanceSharePercent, 175 / 325 * 100));
check('totals: freestyle pace pools durations across sessions ((110+68)/5 s)',
  near(totals.freestyle.paceMinPer100m, (178 / 5) / 25 * 100 / 60), String(totals.freestyle.paceMinPer100m));
check('totals: breaststroke pace pools durations across sessions ((184+95)/6 s)',
  near(totals.breaststroke.paceMinPer100m, (279 / 6) / 25 * 100 / 60), String(totals.breaststroke.paceMinPer100m));
check('totals: unclassified aggregates too', totals.unclassifiedCount === 1);
check('totals: single-session totals equal that session breakdown',
  swimStrokeTotals([sessionsA[0]]).freestyle.lapCount === bdA.freestyle.lapCount && swimStrokeTotals([sessionsA[0]]).unclassifiedCount === bdA.unclassifiedCount);

// ------------------------------------------------------ honest empties
check('empty: no sessions -> zero counts and null shares/paces (never 0% or 0 pace)', (() => {
  const empty = swimStrokeTotals([]);
  return empty.freestyle.lapCount === 0 && empty.breaststroke.lapCount === 0 && empty.unclassifiedCount === 0
    && empty.freestyle.distanceSharePercent === null && empty.freestyle.paceMinPer100m === null && empty.freestyle.avgHr === null;
})());
check('empty: session without segments contributes nothing', (() => {
  const none = swimStrokeBreakdown({ ...sessionB, segments: null });
  return none.freestyle.lapCount === 0 && none.breaststroke.lapCount === 0 && none.unclassifiedCount === 0;
})());

// -------------------------------------------------------- source wiring
check('source: stroke totals block is titled 泳姿构成（推测）', clientSrc.includes('<h3>泳姿构成（推测）</h3>'));
check('source: caliber sentence labels the inference as 按本人数据定标的推测',
  clientSrc.includes('泳姿为按本人数据定标的推测（用时为主、划数为辅）'));
check('source: caliber sentence states Apple Health has no native stroke label',
  clientSrc.includes('Apple Health 无原生泳姿标签'));
check('source: per-lap table carries a 泳姿 column', clientSrc.includes('<th scope="col">泳姿</th>'));
check('source: per-card line reports both groups with the 推测 label',
  clientSrc.includes('（泳姿为推测）'));
check('source: client source carries no neutral 快组/慢组 wording anywhere',
  !clientSrc.includes('快组') && !clientSrc.includes('慢组'));

// ------------------------------------------- mutation sensitivity
// Lowering the fast threshold 38 -> 30 pushes a 33s lap with 20
// strokes into the overlap band, where its strokes reclassify it as
// breaststroke — proving the 38s boundary is what the boundary
// assertions exercise.
const classifySrc = extractFunction(clientSrc, 'classifySwimLap');
const mutatedSrc = clientSrc.replace(classifySrc, classifySrc.replace('durationSeconds <= 38', 'durationSeconds <= 30'));
check('mutation: fast-threshold pattern found', mutatedSrc !== clientSrc);
if (mutatedSrc !== clientSrc) {
  const mutated = buildFns(mutatedSrc);
  check('mutation: original classifies the 33s/20-stroke lap as freestyle', classifySwimLap(33, 20) === 'freestyle');
  check('mutation: with the threshold at 30 the same lap flips to breaststroke',
    mutated.classifySwimLap(33, 20) === 'breaststroke', String(mutated.classifySwimLap(33, 20)));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
