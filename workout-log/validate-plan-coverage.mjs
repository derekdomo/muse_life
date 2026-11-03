// W6.1 validation — planned weekly muscle-group coverage of the
// current plan templates （计划肌群覆盖）, the OpenGym-borrowed
// "what has gone untrained" muscle-map mode applied to the PLAN.
// Evaluates the REAL production module (server/src/plan-coverage.ts,
// whole file, types stripped) over synthetic data only:
//  - planned weekly sets = template sets × the routine's weekly
//    sessions from the schedule; a routine the schedule never
//    places contributes 0 — its exercises add nothing at all, not
//    even an unmapped line (the W5.1 zero-count rule);
//  - attribution: an exercise's planned sets count under EACH of
//    its groups — primary sets under primary groups, synergist
//    （协同） sets under secondary groups (duplicate attribution,
//    the H4.6 / W5.1 rule);
//  - state is a restatement of the counts: primary > 0 ->
//    "primary"; secondary-only -> "secondary_only"; nothing
//    planned -> "none"; uncoveredCount counts the "none" groups;
//  - the map is PASSED IN (the module carries no second copy of
//    MUSCLE_MAP): a group the map names but the caller's list
//    omits is appended, never dropped; an unmapped contributing
//    exercise is listed once, never guessed into a group;
//  - facts only: entries carry exactly the seven plan-fact fields
//    — no recovery / fatigue / score key exists to render;
//  - mutation sensitivity: three deliberate mutations of the
//    module source (weekly-sessions multiplication deleted,
//    synergist attribution deleted, primary-state threshold
//    broken) must each make the behavioral suite fail;
//  - wiring: actions.ts imports the builder, passes the one shared
//    MUSCLE_MAP / MUSCLE_GROUPS in, and getPlan returns the
//    additive optional plan_coverage; the client renders the
//    section from that field with symbol + text + numbers and
//    computes no coverage of its own.
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleSrc = readFileSync(new URL('./server/src/plan-coverage.ts', import.meta.url), 'utf8');
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
    `${code}\nreturn { buildPlanCoverage, PLAN_COVERAGE_VERSION };`,
  )();
}
const C = loadModule(moduleSrc);

// --- synthetic fixture (invented exercises / map, no real data) ---
const MAP = {
  'ex-bench': { primary: ['胸'], secondary: ['肱三头肌'] },
  'ex-fly': { primary: ['胸'], secondary: [] },
  'ex-curl': { primary: ['肱二头肌'], secondary: [] },
  'ex-squat': { primary: ['股四头肌'], secondary: ['核心'] },
  'ex-neck': { primary: ['颈部'], secondary: [] },
};
const GROUPS = ['胸', '肱三头肌', '肱二头肌', '股四头肌', '核心', '小腿'];
const EXERCISES = [
  { routine: 'push', exerciseKey: 'ex-bench', exerciseName: '卧推（合成）', sets: 4 },
  { routine: 'push', exerciseKey: 'ex-fly', exerciseName: '夹胸（合成）', sets: 3 },
  { routine: 'push', exerciseKey: 'ex-neck', exerciseName: '颈屈伸（合成）', sets: 1 },
  { routine: 'pull', exerciseKey: 'ex-curl', exerciseName: '弯举（合成）', sets: 3 },
  // legs is never placed by the schedule below: contributes 0.
  { routine: 'legs', exerciseKey: 'ex-squat', exerciseName: '深蹲（合成）', sets: 5 },
  { routine: 'home', exerciseKey: 'ex-custom', exerciseName: '自创动作（合成）', sets: 2 },
];
const WEEKLY = { push: 2, pull: 1, home: 3 };

// --- behavioral suite (also run against mutants) ---
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };
  const find = (result, muscle) => result.muscles.find((e) => e.muscle === muscle);
  const r = mod.buildPlanCoverage({
    exercises: EXERCISES, weeklySessions: WEEKLY, muscleMap: MAP, muscleGroups: GROUPS,
  });

  t('report order: caller list first, map-only group （颈部） appended, never dropped',
    r.muscles.length === 7
      && r.muscles.slice(0, 6).every((e, i) => e.muscle === GROUPS[i])
      && r.muscles[6].muscle === '颈部');

  const chest = find(r, '胸');
  t('胸： primary 14 (bench 4×2 + fly 3×2), weekly multiplication applied',
    chest.plannedPrimarySets === 14 && chest.plannedSecondarySets === 0 && chest.plannedTotalSets === 14);
  t('胸： state primary, both contributing exercises named once, in order',
    chest.state === 'primary'
      && chest.primaryExercises.join('|') === '卧推（合成）|夹胸（合成）'
      && chest.secondaryExercises.length === 0);

  const triceps = find(r, '肱三头肌');
  t('肱三头肌： synergist-only 8 (bench 4×2) -> state secondary_only',
    triceps.plannedPrimarySets === 0 && triceps.plannedSecondarySets === 8
      && triceps.plannedTotalSets === 8 && triceps.state === 'secondary_only'
      && triceps.secondaryExercises.join('|') === '卧推（合成）');

  const biceps = find(r, '肱二头肌');
  t('肱二头肌： primary 3 (curl 3×1)',
    biceps.plannedPrimarySets === 3 && biceps.state === 'primary');

  const quads = find(r, '股四头肌');
  const core = find(r, '核心');
  t('unscheduled routine contributes nothing: 股四头肌 / 核心 stay 0 and name no exercise',
    quads.plannedTotalSets === 0 && quads.state === 'none' && quads.primaryExercises.length === 0
      && core.plannedTotalSets === 0 && core.state === 'none' && core.secondaryExercises.length === 0);

  const neck = find(r, '颈部');
  t('颈部 (map-only group): primary 2 (1×2), state primary',
    neck.plannedPrimarySets === 2 && neck.state === 'primary');

  t('uncoveredCount counts exactly the none groups （股四头肌 / 核心 / 小腿 = 3)',
    r.uncoveredCount === 3);
  t('unmapped: the contributing custom exercise listed once, never guessed',
    r.unmappedExercises.length === 1 && r.unmappedExercises[0] === '自创动作（合成）');

  t('facts only: entries carry exactly the seven plan-fact fields (no score / recovery)',
    r.muscles.every((e) => {
      const keys = Object.keys(e).sort();
      return keys.join(',') === 'muscle,plannedPrimarySets,plannedSecondarySets,plannedTotalSets,primaryExercises,secondaryExercises,state';
    }));

  const dup = mod.buildPlanCoverage({
    exercises: [
      { routine: 'push', exerciseKey: 'ex-bench', exerciseName: '卧推（合成）', sets: 2 },
      { routine: 'push', exerciseKey: 'ex-bench', exerciseName: '卧推（合成）', sets: 2 },
    ],
    weeklySessions: { push: 2 }, muscleMap: MAP, muscleGroups: GROUPS,
  });
  const dupChest = find(dup, '胸');
  t('duplicate exercise entries sum their sets but name the exercise once',
    dupChest.plannedPrimarySets === 8 && dupChest.primaryExercises.length === 1);

  const empty = mod.buildPlanCoverage({
    exercises: [], weeklySessions: {}, muscleMap: MAP, muscleGroups: GROUPS,
  });
  t('empty plan: every group 0 / none, uncovered = all groups, no unmapped',
    empty.muscles.every((e) => e.plannedTotalSets === 0 && e.state === 'none')
      && empty.uncoveredCount === empty.muscles.length
      && empty.unmappedExercises.length === 0);

  const zeroSets = mod.buildPlanCoverage({
    exercises: [{ routine: 'push', exerciseKey: 'ex-custom', exerciseName: '自创动作（合成）', sets: 0 }],
    weeklySessions: { push: 2 }, muscleMap: MAP, muscleGroups: GROUPS,
  });
  t('zero-set exercise contributes nothing — not even an unmapped line',
    zeroSets.unmappedExercises.length === 0
      && zeroSets.muscles.every((e) => e.plannedTotalSets === 0));

  return failed;
}

const suiteFailures = suite(C);
check('behavioral suite: all assertions pass on the real module', suiteFailures === 0, `${suiteFailures} failed`);
check('module is import-free (verbatim-evaluable pure module)', !/^import\s/m.test(moduleSrc));
check('coverage version is 1', C.PLAN_COVERAGE_VERSION === 1);
check('module carries no copy of the production MUSCLE_MAP (map is passed in)',
  !moduleSrc.includes('barbell-bench') && !moduleSrc.includes('MUSCLE_MAP:'));

// --- mutations: each must flip at least one suite assertion ---
function mutate(name, anchor, replacement) {
  const occurrences = moduleSrc.split(anchor).length - 1;
  check(`mutation anchor unique: ${name}`, occurrences === 1, `${occurrences} occurrence(s)`);
  if (occurrences !== 1) return;
  const mutant = loadModule(moduleSrc.replace(anchor, replacement));
  const failed = suite(mutant);
  check(`mutation flips the suite: ${name}`, failed > 0, `${failed} assertion(s) flipped`);
}
mutate('weekly-sessions multiplication deleted',
  'const contribution = plannedSets(exercise.sets) * sessions;',
  'const contribution = plannedSets(exercise.sets);');
mutate('synergist （协同） attribution deleted',
  'acc.secondarySets += contribution;',
  'acc.secondarySets += 0;');
mutate('primary-state threshold broken',
  'acc.primarySets > 0',
  'acc.primarySets > 999');

// --- wiring: server + client ---
{
  check('wiring: actions.ts imports the builder from ./plan-coverage',
    serverSrc.includes('buildPlanCoverage') && serverSrc.includes('from "./plan-coverage"'));
  check('wiring: actions.ts passes the ONE shared MUSCLE_MAP / MUSCLE_GROUPS in',
    serverSrc.includes('muscleMap: MUSCLE_MAP') && serverSrc.includes('muscleGroups: MUSCLE_GROUPS')
      && serverSrc.includes('from "./muscle-heatmap"'));
  check('wiring: plan response declares plan_coverage optional (additive)',
    serverSrc.includes('plan_coverage: planCoverageResponse.optional()'));
  check('wiring: getPlan returns plan_coverage beside template_version / versions',
    serverSrc.includes('plan_coverage: {') && serverSrc.includes('uncovered_count: coverage.uncoveredCount'));
  check('wiring: coverage is computed from the bracketed templates (templates[routine])',
    serverSrc.includes('coverageExercises.push({'));
  check('wiring: client renders the coverage section with its public 口径',
    clientSrc.includes('计划肌群覆盖') && clientSrc.includes('模板组数 × 它所在训练日每周出现的次数')
      && clientSrc.includes('不看实际完成记录'));
  check('wiring: client states use symbol + text (✓ 有主要动作 / ◐ 仅协同带到 / ○ 未安排）',
    clientSrc.includes('"✓"') && clientSrc.includes('"◐"') && clientSrc.includes('"○"')
      && clientSrc.includes('有主要动作') && clientSrc.includes('仅协同带到') && clientSrc.includes('未安排'));
  check('wiring: StartScreen mounts <PlanCoverage> from planData.plan_coverage inside a >=44px details summary',
    clientSrc.includes('<PlanCoverage data={planData?.plan_coverage} />')
      && clientSrc.includes('计划覆盖 <span>当前计划每周肌群组数</span>'));
  check('wiring: client computes no coverage of its own (never calls buildPlanCoverage)',
    !clientSrc.includes('buildPlanCoverage('));
}

console.log(`\nvalidate-plan-coverage: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
