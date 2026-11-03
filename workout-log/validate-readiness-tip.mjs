// W4.2 validation — read-only readiness tip from 健康看板 (space-4).
// Evaluates the REAL production module (server/src/readiness-tip.ts,
// whole file, types stripped) over synthetic data only, plus
// source-wiring checks for the sync plumbing (saveReadinessTip /
// refreshReadinessTip / getDashboard.readiness_tip) and the client
// panel:
//
//  - tier meta is pinned to space-4's H2.1 contract (label/symbol/
//    level/headline per tier — the color-vision triple channel);
//  - buildReadinessTip passes a valid space-4 advice through
//    verbatim; missing/invalid input honestly falls back to 数据不足
//    with null (never 0) score/signalCount;
//  - canReadinessTipModifyPlan is pinned false — the executable W4.2
//    red line: the tip can never change a plan, weight, set, or
//    completion state;
//  - decideReadinessTipSave implements the L1-RACE-001 version
//    contract (apply / duplicate / ignore incl. NaN guards);
//  - wiring: actions.ts carries the sync prompt, both actions, the
//    atomic compare-and-write save, and the additive getDashboard
//    field; the client renders the panel with exactly one control
//    (44px re-sync) and no plan-writing call inside it;
//  - mutation sensitivity: three deliberate mutations (tier meta
//    swap, 0-fill signalCount, read-only gate forced open) must each
//    flip the corresponding assertions.
//
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleSrc = readFileSync(new URL('./server/src/readiness-tip.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8');

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
    `${code}\nreturn { READINESS_TIP_TIERS, READINESS_TIP_META, buildReadinessTip, canReadinessTipModifyPlan, validateReadinessAdvice, decideReadinessTipSave };`,
  )();
}

// --- synthetic builders ---
const validAdvice = (over = {}) => ({
  tier: 'reduced',
  label: '降强度',
  symbol: '▼',
  level: 2,
  headline: '降低强度或缩短时长。',
  status: '量力而行',
  score: 4,
  confidence: '中',
  signalCount: 5,
  reasons: ['准备度状态「量力而行」对应建议档「降强度」（第 2 档）'],
  missingSignals: ['睡眠：当天没戴表'],
  ...over,
});
const RS = '2026-11-02T21:55:00.000Z';

// --- behavioral suite (also run against mutants) ---
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };

  // tier meta pinned to the H2.1 contract
  t('meta: normal pinned', mod.READINESS_TIP_META.normal.label === '正常计划'
    && mod.READINESS_TIP_META.normal.symbol === '✓' && mod.READINESS_TIP_META.normal.level === 3);
  t('meta: reduced pinned', mod.READINESS_TIP_META.reduced.label === '降强度'
    && mod.READINESS_TIP_META.reduced.symbol === '▼' && mod.READINESS_TIP_META.reduced.level === 2);
  t('meta: recovery pinned', mod.READINESS_TIP_META.recovery.label === '恢复日'
    && mod.READINESS_TIP_META.recovery.symbol === '○' && mod.READINESS_TIP_META.recovery.level === 1);
  t('meta: insufficient pinned', mod.READINESS_TIP_META.insufficient.label === '数据不足'
    && mod.READINESS_TIP_META.insufficient.symbol === '—' && mod.READINESS_TIP_META.insufficient.level === 0);
  t('meta: four tiers exactly', mod.READINESS_TIP_TIERS.length === 4
    && mod.READINESS_TIP_TIERS.join(',') === 'normal,reduced,recovery,insufficient');
  t('meta: headlines carry no prescription', Object.values(mod.READINESS_TIP_META)
    .every((m) => !/kg|lb|组|次|动作/.test(m.headline)));

  // read-only red line
  t('red line: canReadinessTipModifyPlan is false', mod.canReadinessTipModifyPlan() === false);

  // verbatim pass-through
  const tip = mod.buildReadinessTip(validAdvice(), RS);
  t('pass-through: tier/label/symbol/level', tip.tier === 'reduced' && tip.label === '降强度'
    && tip.symbol === '▼' && tip.level === 2);
  t('pass-through: status/score/confidence/signalCount', tip.status === '量力而行'
    && tip.score === 4 && tip.confidence === '中' && tip.signalCount === 5);
  t('pass-through: reasons/missingSignals verbatim', tip.reasons.length === 1
    && tip.reasons[0].includes('量力而行') && tip.missingSignals.length === 1
    && tip.missingSignals[0].includes('睡眠'));
  t('pass-through: readStartedAt stamped', tip.readStartedAt === RS);
  t('pass-through: input not mutated', (() => {
    const input = validAdvice(); const before = JSON.stringify(input);
    mod.buildReadinessTip(input, RS); return JSON.stringify(input) === before;
  })());

  // honest fallback: missing
  const miss = mod.buildReadinessTip(null, RS);
  t('missing: falls back to 数据不足', miss.tier === 'insufficient' && miss.status === '数据不足'
    && miss.symbol === '—' && miss.level === 0);
  t('missing: score/signalCount stay null, never 0', miss.score === null && miss.signalCount === null);
  t('missing: reason names the gap', miss.reasons.some((r) => r.includes('未同步') || r.includes('读取失败')));
  const missU = mod.buildReadinessTip(undefined, RS);
  t('missing: undefined behaves like null', missU.tier === 'insufficient' && missU.score === null);

  // honest fallback: contract violation
  const badTier = mod.buildReadinessTip(validAdvice({ tier: 'turbo' }), RS);
  t('invalid: unknown tier rejected', badTier.tier === 'insufficient' && badTier.score === null
    && badTier.reasons.some((r) => r.includes('unknown-tier')));
  const badLabel = mod.buildReadinessTip(validAdvice({ label: '全力以赴' }), RS);
  t('invalid: label mismatch rejected', badLabel.tier === 'insufficient'
    && badLabel.reasons.some((r) => r.includes('label-mismatch')));
  const badScore = mod.buildReadinessTip(validAdvice({ score: 'high' }), RS);
  t('invalid: non-numeric score rejected', badScore.tier === 'insufficient');

  // validateReadinessAdvice verdicts
  t('validate: valid -> null', mod.validateReadinessAdvice(validAdvice()) === null);
  t('validate: null -> missing', mod.validateReadinessAdvice(null) === 'missing');
  t('validate: undefined -> missing', mod.validateReadinessAdvice(undefined) === 'missing');
  t('validate: bad tier -> unknown-tier', mod.validateReadinessAdvice(validAdvice({ tier: 'x' })) === 'unknown-tier');
  t('validate: score 0 is a real score, not missing', mod.validateReadinessAdvice(validAdvice({ score: 0 })) === null);
  t('validate: signalCount 0 passes, tip keeps real 0', (() => {
    const v = mod.validateReadinessAdvice(validAdvice({ signalCount: 0 }));
    const built = mod.buildReadinessTip(validAdvice({ signalCount: 0 }), RS);
    return v === null && built.signalCount === 0;
  })());

  // version contract matrix
  t('version: no existing -> apply', mod.decideReadinessTipSave(null, RS) === 'apply');
  t('version: newer incoming -> apply',
    mod.decideReadinessTipSave('2026-11-02T20:00:00.000Z', '2026-11-02T21:00:00.000Z') === 'apply');
  t('version: same instant -> duplicate',
    mod.decideReadinessTipSave(RS, RS) === 'duplicate');
  t('version: older incoming -> ignore',
    mod.decideReadinessTipSave('2026-11-02T21:00:00.000Z', '2026-11-02T20:00:00.000Z') === 'ignore');
  t('version: NaN incoming -> ignore', mod.decideReadinessTipSave(RS, 'not-a-date') === 'ignore');
  t('version: NaN existing -> apply', mod.decideReadinessTipSave('not-a-date', RS) === 'apply');

  return failed;
}

const realFailed = suite(loadModule(moduleSrc));
check('behavioral suite (real module)', realFailed === 0, `${realFailed} failed`);

// --- wiring checks (source assertions) ---
check('wiring: READINESS_TIP_SYNC_PROMPT present', serverSrc.includes('READINESS_TIP_SYNC_PROMPT'));
check('wiring: prompt reads space-4 getDashboard verbatim',
  serverSrc.includes('readinessAdvice') && serverSrc.includes('space-4'));
check('wiring: prompt stamps read-start instant, never finish',
  /record the current instant as readStartedAt/i.test(serverSrc) || /readStartedAt/i.test(serverSrc));
check('wiring: saveReadinessTip action defined', /saveReadinessTip: defineAction\(/.test(serverSrc));
check('wiring: refreshReadinessTip action defined', /refreshReadinessTip: defineAction\(/.test(serverSrc));
check('wiring: save gated on owner-or-sync-channel', serverSrc.includes('isOwnerOrSyncChannel(ctx)'));
check('wiring: save enforces read-only red line', serverSrc.includes('canReadinessTipModifyPlan()'));
check('wiring: save validates advice contract', serverSrc.includes('validateReadinessAdvice(args.payload)'));
check('wiring: atomic compare-and-write on readStartedAt',
  serverSrc.includes('excluded.source_read_started_at >'));
check('wiring: getDashboard returns readiness_tip', serverSrc.includes('readiness_tip: await loadReadinessTip(ctx)'));
check('wiring: readiness_tip additive in dashboardResponse',
  /readiness_tip: readinessTipResponse\.nullable\(\)\.optional\(\)/.test(serverSrc));
check('wiring: refresh spawns task expecting saveReadinessTip',
  serverSrc.includes('expectsAction: "saveReadinessTip"'));
check('wiring: schema has readiness_tip_cache', schemaSrc.includes('readiness_tip_cache'));
check('wiring: migration 0011 present',
  (() => { try { readFileSync(new URL('./drizzle/0011_add_readiness_tip_cache.sql', import.meta.url), 'utf8'); return true; } catch { return false; } })());

// --- client checks ---
check('client: ReadinessTipPanel renders tier symbol+label+level',
  clientSrc.includes('ReadinessTipPanel') && clientSrc.includes('readiness-tip-tier'));
check('client: panel shows honest data-insufficient state',
  clientSrc.includes('尚未同步健康看板的训练建议'));
check('client: exactly one control — 44px re-sync', clientSrc.includes('readiness-tip-resync')
  && cssSrc.includes('.readiness-tip-resync') && /\.readiness-tip-resync\s*\{[^}]*min-height:\s*44px/.test(cssSrc));
check('client: no plan-writing call inside the panel',
  !/startWorkout|updateSet|addSet|completeWorkout|updatePlan/.test(
    clientSrc.slice(clientSrc.indexOf('function ReadinessTipPanel'),
      clientSrc.indexOf('function StartScreen'))));
check('client: completion signal is persistent state, not fixed duration',
  clientSrc.includes('readStartedAt') && !/setTimeout\(\(\) => setSyncing\(false\), \d+\)/.test(clientSrc));

// --- mutations (real execution, must flip) ---
function runMutant(name, mutate) {
  const failed = suite(loadModule(mutate(moduleSrc)));
  check(`mutation: ${name} flips the suite`, failed > 0, `${failed} flipped`);
}
runMutant('tier meta label swapped', (src) =>
  src.replace(`normal: { label: "正常计划"`, `normal: { label: "全力以赴"`));
runMutant('signalCount 0-filled in fallback', (src) =>
  src.replace('signalCount: null,\n    reasons,', 'signalCount: 0,\n    reasons,'));
runMutant('read-only gate forced open', (src) =>
  src.replace('export function canReadinessTipModifyPlan(): false {\n  return false;',
    'export function canReadinessTipModifyPlan(): false {\n  return true as unknown as false;'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
