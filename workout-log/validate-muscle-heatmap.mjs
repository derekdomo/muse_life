// W5.1 validation — muscle-group weekly sets + days since last
// trained （肌群恢复热力图 facts), and the shared exercise ->
// muscle-group map.
// Evaluates the REAL production module (server/src/muscle-heatmap.ts,
// whole file, types stripped) over synthetic data only:
//  - window: the last 7 LA calendar days including today; a set
//    completed one minute before the window's first LA midnight
//    is OUT, one at that midnight is IN (natural-day boundary);
//  - counts: COMPLETED sets only (an uncompleted set never counts),
//    inside completed workouts only (a null completedAt workout is
//    ignored wholesale);
//  - attribution: an exercise's completed sets count under EACH of
//    its groups — primary sets under primary groups, synergist
//    （协同） sets under secondary groups (duplicate attribution,
//    the H4.6 receipt rule);
//  - days since last trained: whole calendar days to the group's
//    most recent training day over ALL history passed (primary or
//    secondary both count), 0 for today, null pair for never;
//  - an exercise with zero completed sets contributes nothing —
//    not even an unmapped line; an unmapped key with completed
//    sets is listed once under unmappedExercises, never guessed;
//  - facts only: entries carry exactly the seven fact fields —
//    no recovery percentage / score key exists to render;
//  - map parity: the module's MUSCLE_MAP is entry-for-entry
//    identical to the client's MUSCLE_MAP in client/src/App.tsx
//    (the map the guide diagram and the receipt use) and the
//    versions match — the heatmap never runs on a second mapping;
//    MUSCLE_GROUPS equals the union of the map's group names;
//  - mutation sensitivity: three deliberate mutations of the
//    module source (synergist attribution deleted, 7-day window
//    lower bound deleted, completed-only filter deleted) must
//    each make the behavioral suite fail;
//  - wiring: actions.ts imports the builder, getDashboard returns
//    muscle_heatmap / muscle_map / muscle_map_version behind the
//    same read gate, and the client renders the heatmap + the
//    full mapping table from those fields while containing no
//    heatmap computation of its own.
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleSrc = readFileSync(new URL('./server/src/muscle-heatmap.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function loadModule(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { buildMuscleHeatmap, muscleHeatmapWindow, MUSCLE_MAP, MUSCLE_MAP_VERSION, MUSCLE_GROUPS, MUSCLE_HEATMAP_VERSION };`,
  )();
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractConstObject(source, name) {
  const idx = source.search(new RegExp(`const ${name}\\s*:`));
  if (idx < 0) throw new Error(`const ${name} not found`);
  const bodyStart = source.indexOf('{', idx);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
const H = loadModule(moduleSrc);
const clientMap = new Function(
  `${stripTypeScriptTypes(extractConstObject(clientSrc, 'MUSCLE_MAP'))}\nreturn MUSCLE_MAP;`,
)();
const clientVersionMatch = clientSrc.match(/MUSCLE_MAP_VERSION = (\d+)/);

// --- synthetic builders ---
// ex(key, name, completedSets, uncompletedSets) -> that exercise's sets.
const ex = (key, name, done, undone = 0) => [
  ...Array.from({ length: done }, () => ({ exerciseKey: key, exerciseName: name, completed: true })),
  ...Array.from({ length: undone }, () => ({ exerciseKey: key, exerciseName: name, completed: false })),
];
const wk = (completedAt, ...exerciseSets) => ({ completedAt, sets: exerciseSets.flat() });

// "Now": 2026-10-29 12:00 in Los Angeles (PDT, UTC-7) — today is
// 2026-10-29 and the 7-day window is 2026-10-23 … 2026-10-29.
const NOW = '2026-10-29T19:00:00.000Z';
const FIXTURE = [
  // Today (LA Oct 29): bench 4 done + 1 not done, dips 3 done,
  // one unmapped custom exercise with 2 completed sets.
  wk('2026-10-29T16:00:00.000Z',
    ex('barbell-bench', '杠铃卧推', 4, 1),
    ex('dips', '双杠臂屈伸', 3),
    ex('sled-push-custom', '雪橇推（自创）', 2)),
  // Window start day (LA Oct 23): squats.
  wk('2026-10-23T15:00:00.000Z',
    ex('back-squat', '深蹲', 4)),
  // One minute BEFORE the window's first LA midnight (LA Oct 22
  // 23:59): outside the window, but still the last training day.
  wk('2026-10-23T06:59:00.000Z',
    ex('tibialis-raise', '靠墙胫骨前肌抬脚尖', 2)),
  // Exactly AT the window's first LA midnight (LA Oct 23 00:00):
  // inside the window.
  wk('2026-10-23T07:00:00.000Z',
    ex('calf-raise', '提踵', 2)),
  // LA Oct 22: pulldowns — outside the window.
  wk('2026-10-22T16:00:00.000Z',
    ex('wide-lat-pulldown', '高位下拉 · 宽握', 4)),
  // LA Oct 10: leg curls (older 腘绳肌 day than the squat's
  // synergist day) + rope curls recorded but never completed.
  wk('2026-10-10T16:00:00.000Z',
    ex('lying-leg-curl', '俯卧腿弯举', 3),
    ex('rope-curl', '绳索弯举', 0, 3),
    ex('ghost-custom', '幽灵动作（自创）', 0, 2)),
  // The same unmapped exercise again on LA Oct 28: still one line.
  wk('2026-10-28T16:00:00.000Z',
    ex('sled-push-custom', '雪橇推（自创）', 1)),
  // Not a completed workout at all: ignored wholesale, dead-bug
  // sets and all.
  wk(null,
    ex('dead-bug', '死虫', 3)),
];

// --- behavioral suite (also run against mutants) ---
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };
  const find = (result, muscle) => result.muscles.find((e) => e.muscle === muscle);
  const r = mod.buildMuscleHeatmap({ now: NOW, workouts: FIXTURE });

  t('window: 2026-10-23 … 2026-10-29 (7 natural days incl. today)',
    r.windowStart === '2026-10-23' && r.windowEnd === '2026-10-29');
  t('all 19 groups reported, in MUSCLE_GROUPS order',
    r.muscles.length === 19 && r.muscles.every((e, i) => e.muscle === mod.MUSCLE_GROUPS[i]));

  const chest = find(r, '胸');
  t('胸： primary 7 (bench 4 + dips 3), uncompleted set never counts',
    chest.primarySets === 7 && chest.secondarySets === 0 && chest.totalSets === 7);
  t('胸： trained today — last 2026-10-29, 0 days, in window',
    chest.lastTrainedDate === '2026-10-29' && chest.daysSinceLastTrained === 0 && chest.trainedInWindow === true);

  const triceps = find(r, '肱三头肌');
  t('肱三头肌： primary 3 (dips) + synergist 4 (bench) = 7',
    triceps.primarySets === 3 && triceps.secondarySets === 4 && triceps.totalSets === 7);
  const frontDelt = find(r, '肩前束');
  t('肩前束： synergist-only attribution counts (bench 4 + dips 3 = 7)',
    frontDelt.primarySets === 0 && frontDelt.secondarySets === 7 && frontDelt.totalSets === 7);

  const quads = find(r, '股四头肌');
  t('股四头肌： window-start day counts (squat 4 on Oct 23), 6 days ago',
    quads.primarySets === 4 && quads.lastTrainedDate === '2026-10-23' && quads.daysSinceLastTrained === 6);
  const core = find(r, '核心');
  t('核心： synergist 4 from squats only — the uncompleted (null) workout is ignored',
    core.primarySets === 0 && core.secondarySets === 4 && core.totalSets === 4);
  const hams = find(r, '腘绳肌');
  t('腘绳肌： most recent day wins — synergist Oct 23 over primary Oct 10',
    hams.primarySets === 0 && hams.secondarySets === 4
      && hams.lastTrainedDate === '2026-10-23' && hams.daysSinceLastTrained === 6);

  const tibialis = find(r, '胫骨前肌');
  t('胫骨前肌： 23:59 the night before the window is OUT (0 sets) but is the last day (7 days)',
    tibialis.totalSets === 0 && tibialis.trainedInWindow === false
      && tibialis.lastTrainedDate === '2026-10-22' && tibialis.daysSinceLastTrained === 7);
  const calves = find(r, '小腿');
  t('小腿： exactly at the window-start midnight is IN (2 sets)',
    calves.primarySets === 2 && calves.lastTrainedDate === '2026-10-23' && calves.daysSinceLastTrained === 6);

  const lats = find(r, '背阔肌');
  t('背阔肌： Oct 22 session outside window — 0 sets, not trained in window, 7 days',
    lats.totalSets === 0 && lats.trainedInWindow === false
      && lats.lastTrainedDate === '2026-10-22' && lats.daysSinceLastTrained === 7);
  const biceps = find(r, '肱二头肌');
  t('肱二头肌： synergist day Oct 22 kept; zero-completed rope curls add nothing',
    biceps.totalSets === 0 && biceps.lastTrainedDate === '2026-10-22' && biceps.daysSinceLastTrained === 7);

  const neck = find(r, '颈深屈肌');
  t('颈深屈肌： never trained — 0 sets, null date, null days',
    neck.totalSets === 0 && neck.lastTrainedDate === null
      && neck.daysSinceLastTrained === null && neck.trainedInWindow === false);

  t('unmapped: the custom exercise listed once despite two sessions',
    r.unmappedExercises.length === 1 && r.unmappedExercises[0] === '雪橇推（自创）');
  t('unmapped: a custom exercise with zero completed sets is NOT listed',
    !r.unmappedExercises.some((name) => name.includes('幽灵动作')));

  t('facts only: entries carry exactly the seven fact fields (no score / percentage)',
    r.muscles.every((e) => {
      const keys = Object.keys(e).sort();
      return keys.join(',') === 'daysSinceLastTrained,lastTrainedDate,muscle,primarySets,secondarySets,totalSets,trainedInWindow';
    }));

  const empty = mod.buildMuscleHeatmap({ now: NOW, workouts: [] });
  t('empty history: every group 0 / null, no unmapped, window still stated',
    empty.muscles.length === 19
      && empty.muscles.every((e) => e.totalSets === 0 && e.lastTrainedDate === null && e.daysSinceLastTrained === null)
      && empty.unmappedExercises.length === 0
      && empty.windowStart === '2026-10-23' && empty.windowEnd === '2026-10-29');

  const dst = mod.muscleHeatmapWindow('2026-11-02T08:00:00.000Z');
  t('window across the DST fall-back: Nov 2 00:00 PST -> 2026-10-27 … 2026-11-02',
    dst.windowStart === '2026-10-27' && dst.windowEnd === '2026-11-02');

  return failed;
}

const suiteFailures = suite(H);
check('behavioral suite: all assertions pass on the real module', suiteFailures === 0, `${suiteFailures} failed`);

// --- map parity: ONE mapping, shared with the client ---
{
  const serverKeys = Object.keys(H.MUSCLE_MAP).sort();
  const clientKeys = Object.keys(clientMap).sort();
  check('map parity: server and client maps cover the same 31 exercise keys',
    serverKeys.length === 31 && serverKeys.join('|') === clientKeys.join('|'));
  const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const mismatches = serverKeys.filter((key) => {
    const s = H.MUSCLE_MAP[key];
    const c = clientMap[key];
    return !c || !sameList(s.primary, c.primary) || !sameList(s.secondary, c.secondary);
  });
  check('map parity: every entry identical (primary + secondary, in order)', mismatches.length === 0,
    mismatches.join(','));
  check('map parity: MUSCLE_MAP_VERSION matches the client (both 1)',
    H.MUSCLE_MAP_VERSION === 1 && clientVersionMatch !== null && clientVersionMatch[1] === '1');
  const union = new Set();
  for (const mapping of Object.values(H.MUSCLE_MAP)) {
    for (const name of mapping.primary) union.add(name);
    for (const name of mapping.secondary) union.add(name);
  }
  check('MUSCLE_GROUPS equals the union of group names used by the map (19)',
    H.MUSCLE_GROUPS.length === 19 && [...union].sort().join('|') === [...H.MUSCLE_GROUPS].sort().join('|'));
  check('module is import-free (verbatim-evaluable pure module)', !/^import\s/m.test(moduleSrc));
  check('heatmap version is 1', H.MUSCLE_HEATMAP_VERSION === 1);
}

// --- mutations: each must flip at least one suite assertion ---
function mutate(name, anchor, replacement) {
  const occurrences = moduleSrc.split(anchor).length - 1;
  check(`mutation anchor unique: ${name}`, occurrences === 1, `${occurrences} occurrence(s)`);
  if (occurrences !== 1) return;
  const mutant = loadModule(moduleSrc.replace(anchor, replacement));
  const failed = suite(mutant);
  check(`mutation flips the suite: ${name}`, failed > 0, `${failed} assertion(s) flipped`);
}
mutate('synergist （协同） attribution deleted',
  'acc.secondarySets += completedCount;',
  'acc.secondarySets += 0;');
mutate('7-day window lower bound deleted',
  'const inWindow = dayMs >= windowStartMs && dayMs <= todayMs;',
  'const inWindow = dayMs <= todayMs;');
mutate('completed-only filter deleted',
  'sets.filter((set) => set.completed).length',
  'sets.length');

// --- wiring: server + client ---
{
  check('wiring: actions.ts imports the builder + map from ./muscle-heatmap',
    serverSrc.includes('buildMuscleHeatmap') && serverSrc.includes('from "./muscle-heatmap"')
      && serverSrc.includes('MUSCLE_MAP_VERSION'));
  check('wiring: getDashboard returns muscle_heatmap / muscle_map / muscle_map_version',
    serverSrc.includes('muscle_heatmap: await loadMuscleHeatmap(ctx, now)')
      && serverSrc.includes('muscle_map: muscleMapEntries()')
      && serverSrc.includes('muscle_map_version: MUSCLE_MAP_VERSION'));
  check('wiring: dashboard response declares the three fields optional (additive)',
    serverSrc.includes('muscle_heatmap: muscleHeatmapResponse.optional()')
      && serverSrc.includes('muscle_map: z.array(muscleMapEntryResponse).optional()')
      && serverSrc.includes('muscle_map_version: z.number().optional()'));
  check('wiring: loader reads the full completed history (no date cutoff in loadMuscleHeatmap)',
    !/loadMuscleHeatmap[\s\S]{0,2400}?gte\(schema\.workouts\.completedAt/.test(serverSrc));
  check('wiring: client renders the heatmap section with its public 口径',
    clientSrc.includes('肌群恢复热力图') && clientSrc.includes('最近 7 个自然日')
      && clientSrc.includes('只计已完成组') && clientSrc.includes('不计算恢复百分比'));
  check('wiring: client states use symbol + text （● 已练 / ○ 未练 / — 从未训练）',
    clientSrc.includes('"●"') && clientSrc.includes('"○"') && clientSrc.includes('"—"')
      && clientSrc.includes('已练') && clientSrc.includes('未练') && clientSrc.includes('从未训练'));
  check('wiring: client shows the full mapping table from muscle_map',
    clientSrc.includes('动作 → 肌群映射表') && clientSrc.includes('mapEntries.map')
      && clientSrc.includes('muscleMap={dashboard.data.muscle_map}'));
  check('wiring: StartScreen renders <MuscleHeatmap> after <WeekFrequency>',
    clientSrc.indexOf('<MuscleHeatmap') > clientSrc.indexOf('<WeekFrequency'));
  check('wiring: client computes no heatmap of its own (never calls buildMuscleHeatmap)',
    !clientSrc.includes('buildMuscleHeatmap('));
}

console.log(`\nvalidate-muscle-heatmap: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
