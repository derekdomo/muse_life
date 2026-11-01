// W5.2 validation — plate calculator + warmup set generator.
// Loads the REAL production module client/src/plate-warmup.ts
// (verbatim, via node's type stripping — the module has no imports
// by design) and asserts every path over synthetic weights only:
//  - plate libraries and bar presets/defaults match the brief;
//  - greedy largest-first fill: exact combos in lb and kg, preset
//    and custom bars, repeated plates, smallest-plate precision;
//  - the not-exact fallback: achieved weight is the greedy result
//    (the closest loadable weight the mandated fill produces, never
//    above the target) and `exact` is false — never labelled exact;
//  - at/below-bar targets: bare bar, exact only when target == bar;
//  - warmup generation: all three presets, every weight rounded to
//    a loadable weight by the SAME calcPlateCombo fill (same
//    caliber as the calculator), never above the raw percentage
//    weight, never below the bar;
//  - formatting helpers (per-side text, bare-bar wording).
// Then three mutation runs against the production source — each
// mutation MUST flip at least one asserted result, proving the
// assertions actually bind the production behaviour:
//  M1 greedy order deleted (libraries ascending, smallest first);
//  M2 closest-fallback deleted (`exact` hard-coded true);
//  M3 loadable rounding deleted (warmup keeps the raw weight).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('./client/src/plate-warmup.ts', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function loadModule(src) {
  if (/^import\s/m.test(src)) throw new Error('plate-warmup.ts must stay import-free');
  const js = stripTypeScriptTypes(src).replace(/^export /gm, '');
  const names = [
    'PLATE_LIBRARY', 'DEFAULT_BAR_WEIGHT', 'BAR_WEIGHT_PRESETS', 'WARMUP_PRESETS',
    'calcPlateCombo', 'generateWarmupSets', 'loadableWeight', 'formatPlateWeight', 'formatPlatesPerSide',
  ];
  const box = { exports: {} };
  new Function('module', 'exports', `${js}\nmodule.exports = { ${names.join(', ')} };`)(box, box.exports);
  return box.exports;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function assertSuite(m, label) {
  const local = { passed: 0, failures: 0 };
  const t = (name, ok, note = '') => {
    if (ok) local.passed++;
    else local.failures++;
    // Only the production run feeds the global tally: a mutation
    // run's inner failures are the EXPECTED flips, counted once by
    // the caller's "mutation flips results" check.
    if (label === 'production') {
      if (ok) passed++;
      else failures++;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}: ${name}${note ? ` (${note})` : ''}`);
  };

  // Libraries / bars per the brief.
  t('lb library', eq(m.PLATE_LIBRARY.lb, [45, 35, 25, 10, 5, 2.5]));
  t('kg library', eq(m.PLATE_LIBRARY.kg, [25, 20, 15, 10, 5, 2.5, 1.25]));
  t('default bars 45lb / 20kg', m.DEFAULT_BAR_WEIGHT.lb === 45 && m.DEFAULT_BAR_WEIGHT.kg === 20);
  t('bar presets', eq(m.BAR_WEIGHT_PRESETS.lb, [45, 35]) && eq(m.BAR_WEIGHT_PRESETS.kg, [20, 15]));

  // Greedy exact fills.
  let c = m.calcPlateCombo(135, 45, 'lb');
  t('lb 135 = bar + 45/side exact', eq(c.platesPerSide, [45]) && c.achievedWeight === 135 && c.exact === true);
  c = m.calcPlateCombo(185, 45, 'lb');
  t('lb 185 greedy largest-first 45+25', eq(c.platesPerSide, [45, 25]) && c.exact === true);
  c = m.calcPlateCombo(225, 45, 'lb');
  t('lb 225 repeats largest plate 45+45', eq(c.platesPerSide, [45, 45]) && c.exact === true);
  c = m.calcPlateCombo(100, 20, 'kg');
  t('kg 100 = 25+15 per side exact', eq(c.platesPerSide, [25, 15]) && c.exact === true);
  c = m.calcPlateCombo(62.5, 20, 'kg');
  t('kg 62.5 uses 1.25 plate', eq(c.platesPerSide, [20, 1.25]) && c.exact === true);
  c = m.calcPlateCombo(120, 35, 'lb');
  t('lb 120 on 35 bar = 35+5+2.5', eq(c.platesPerSide, [35, 5, 2.5]) && c.exact === true);
  c = m.calcPlateCombo(50, 15, 'kg');
  t('kg 50 on 15 bar = 15+2.5', eq(c.platesPerSide, [15, 2.5]) && c.exact === true);
  c = m.calcPlateCombo(138, 33, 'lb');
  t('custom bar 33lb: 138 = 45+5+2.5 per side', eq(c.platesPerSide, [45, 5, 2.5]) && c.achievedWeight === 138 && c.exact === true);

  // Not-exact fallback: greedy result, labelled not exact, never above target.
  c = m.calcPlateCombo(142, 45, 'lb');
  t('lb 142 falls back to 140, not exact', eq(c.platesPerSide, [45, 2.5]) && c.achievedWeight === 140 && c.exact === false);
  c = m.calcPlateCombo(101, 20, 'kg');
  t('kg 101 falls back to 100, not exact', c.achievedWeight === 100 && c.exact === false && c.achievedWeight < 101);

  // At / below the bar.
  c = m.calcPlateCombo(45, 45, 'lb');
  t('target == bar is the bare bar, exact', eq(c.platesPerSide, []) && c.achievedWeight === 45 && c.exact === true);
  c = m.calcPlateCombo(40, 45, 'lb');
  t('target below bar: bare bar achieved, not exact', eq(c.platesPerSide, []) && c.achievedWeight === 45 && c.exact === false);

  // Warmup presets per the brief.
  t('three presets with brief steps', m.WARMUP_PRESETS.length === 3
    && eq(m.WARMUP_PRESETS[0].steps, [{ percent: 50, reps: 8 }, { percent: 70, reps: 5 }, { percent: 85, reps: 3 }])
    && eq(m.WARMUP_PRESETS[1].steps, [{ percent: 60, reps: 5 }, { percent: 80, reps: 3 }])
    && eq(m.WARMUP_PRESETS[2].steps, [{ percent: 40, reps: 8 }, { percent: 55, reps: 5 }, { percent: 70, reps: 3 }, { percent: 85, reps: 2 }]));

  // Warmup weights: same plate fill as the calculator.
  const w = m.generateWarmupSets(200, 45, 'lb', m.WARMUP_PRESETS[0].steps);
  t('standard @200lb -> 100/140/170 x 8/5/3', eq(w.map((s) => s.weight), [100, 140, 170]) && eq(w.map((s) => s.reps), [8, 5, 3]));
  const w2 = m.generateWarmupSets(185, 45, 'lb', m.WARMUP_PRESETS[0].steps);
  t('warmup rounds via calculator fill (92.5->90, 129.5->125, 157.25->155)',
    eq(w2.map((s) => s.weight), [90, 125, 155])
    && w2.every((s) => s.weight === m.calcPlateCombo(s.rawWeight, 45, 'lb').achievedWeight)
    && w2.every((s) => s.weight <= s.rawWeight && s.weight >= 45));
  const w3 = m.generateWarmupSets(60, 20, 'kg', m.WARMUP_PRESETS[2].steps);
  t('light-many @60kg -> 22.5/32.5/40/50', eq(w3.map((s) => s.weight), [22.5, 32.5, 40, 50]));
  const w4 = m.generateWarmupSets(100, 45, 'lb', m.WARMUP_PRESETS[1].steps);
  t('fewer @100lb: 60% raw 60 -> 60 exact plates, 80% raw 80 -> 80', eq(w4.map((s) => s.weight), [60, 80]));

  // Formatting.
  t('per-side text', m.formatPlatesPerSide([45, 10]) === '45 + 10' && m.formatPlatesPerSide([]) === '空杆' && m.formatPlatesPerSide([2.5]) === '2.5');
  t('weight format trims zeros', m.formatPlateWeight(45) === '45' && m.formatPlateWeight(2.5) === '2.5' && m.formatPlateWeight(1.25) === '1.25');

  return local;
}

const base = assertSuite(loadModule(source), 'production');
check('production suite fully green', base.failures === 0, `${base.passed} passed`);

// --- Mutations: each must flip the suite from green to failing ---
function mutate(name, from, to) {
  if (!source.includes(from)) {
    check(`mutation ${name} applies`, false, 'anchor text not found in production source');
    return;
  }
  const mutated = loadModule(source.replace(from, to));
  const result = assertSuite(mutated, `mutation ${name}`);
  check(`mutation ${name} flips results`, result.failures > 0, `${result.failures} assertion(s) flipped`);
}

mutate('M1 greedy-order-deleted', 'lb: [45, 35, 25, 10, 5, 2.5]', 'lb: [2.5, 5, 10, 25, 35, 45]');
mutate('M2 closest-fallback-deleted', 'exact: achievedScaled === toScaled(targetWeight)', 'exact: true');
mutate('M3 loadable-rounding-deleted', 'weight: combo.achievedWeight', 'weight: rawWeight');

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
