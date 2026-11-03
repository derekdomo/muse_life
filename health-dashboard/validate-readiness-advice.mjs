// H2.1 今日训练建议 (readiness advice) validation.
// Runs the REAL production pure module (server/src/readiness-advice.ts
// — no imports, all logic exported) over synthetic fixtures only; no
// real health data is ever used. Covers: (1) the four-tier mapping
// boundaries (准备就绪 / 全力以赴 → 正常计划， 量力而行 → 降强度，
// 恢复 → 恢复日， 数据不足 → 数据不足； the readiness status is the
// sole tier input, so the same score under different statuses maps
// differently and a high score never re-tiers a 量力而行 day),
// (2) the trigger basis naming (status, score, confidence, every
// adjustment verbatim, the tier's component items), (3) status
// periods (H4.4) yielding NO advice — via the suppressed flag and
// via the 状态期 status alike, (4) the 数据不足 branch (no score,
// signal-count reason), and (5) missing signals named individually
// (never dropped, never zero). Three source mutations are executed
// for real (tier mapping, suppression guard, missing-signal filter)
// and each must flip its corresponding assertion. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const adviceSrc = readFileSync(new URL('./server/src/readiness-advice.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function buildModule(src) {
  const code = stripTypeScriptTypes(src.replace(/^export /gm, ''));
  return new Function(`${code}\nreturn { buildReadinessAdvice, adviceTierForStatus, missingSignalsFor, READINESS_ADVICE_TIERS, READINESS_ADVICE_META, READINESS_STATUS_TO_ADVICE_TIER };`)();
}
const M = buildModule(adviceSrc);
const { buildReadinessAdvice, adviceTierForStatus, missingSignalsFor, READINESS_ADVICE_META } = M;

// ------------------------------------------------------------ source checks
check('source: advice module has no imports (pure module)', !/^import /m.test(adviceSrc));
check('source: advice module performs no I/O or writes (no ctx, no db, no defineAction)',
  !adviceSrc.includes('ctx.') && !adviceSrc.includes('defineAction') && !adviceSrc.includes('fetch('));
check('source: server imports buildReadinessAdvice from the pure module',
  serverSrc.includes('buildReadinessAdvice') && serverSrc.includes('from "./readiness-advice"'));
check('source: getDashboard response carries the additive readinessAdvice field',
  serverSrc.includes('readinessAdvice: readinessAdviceSchema.nullable()')
  && serverSrc.includes('const readinessAdvice = buildReadinessAdvice({'));
check('source: all three getDashboard paths carry readinessAdvice (null for non-owner, null for no-snapshot, derived on success)',
  (serverSrc.match(/readinessAdvice: null/g) ?? []).length === 2
  && serverSrc.includes('readinessHistory, readiness, readinessAdvice,'));
check('source: no schema or readiness-formula change rides along (schema file has no advice table; tierFor untouched)',
  !schemaSrc.includes('readiness_advice') && !schemaSrc.includes('readinessAdvice')
  && serverSrc.includes('function tierFor(score: number)'));
check('source: every defineAction carries a v26 description',
  (serverSrc.match(/defineAction\(\{/g) ?? []).length === (serverSrc.match(/description: "/g) ?? []).length,
  `${(serverSrc.match(/defineAction\(\{/g) ?? []).length} actions`);
check('source: client renders the advice card from the server field only and never computes a tier itself',
  clientSrc.includes('function ReadinessAdviceCard') && clientSrc.includes('今日训练建议')
  && clientSrc.includes('advice.reasons.map') && clientSrc.includes('readinessAdvice={readinessAdvice}')
  && !clientSrc.includes('buildReadinessAdvice') && !clientSrc.includes('adviceTierForStatus'));
check('source: client entry to 训练记录 is honest — a button (never an anchor/link), the no-deep-link limit is stated in the card',
  clientSrc.includes('打开训练记录') && clientSrc.includes('平台暂不支持应用间深链')
  && clientSrc.includes('不会写入训练记录') && !/<a[^>]*>\s*打开训练记录/.test(clientSrc)
  && clientSrc.includes('className="readiness-advice-entry-btn"'));
check('source: tier presentation is symbol + text + number together (symbol, label, numeric level all rendered)',
  clientSrc.includes('advice.symbol') && clientSrc.includes('advice.label') && clientSrc.includes('第 {advice.level} 档'));

// ------------------------------------------------------------ fixtures
const COMPONENTS = [
  { key: 'hrv', label: 'HRV', score: 3.0, detail: 'ln(HRV) z -1.00', missingLabel: null },
  { key: 'restingHr', label: '静息心率', score: 4.0, detail: '方向校正后 z -0.50', missingLabel: null },
  { key: 'lastSleep', label: '昨晚睡眠', score: 8.0, detail: '时长 90 / 规律 80 / 中断 85', missingLabel: null },
  { key: 'sleepBank', label: '7 天睡眠银行', score: 7.0, detail: '近 7 晚按个人需求累计', missingLabel: null },
  { key: 'trainingLoad', label: '训练负荷', score: null, detail: '历史覆盖不足，暂不纳入', missingLabel: null },
  { key: 'respiratoryRate', label: '呼吸频率', score: null, detail: '当天没戴表', missingLabel: '当天没戴表' },
];
const inputFor = (status, score, extra = {}) => ({
  status,
  score,
  confidence: '中',
  signalCount: 4,
  adjustments: [],
  components: COMPONENTS,
  ...extra,
});

// ------------------------------------------- (1) four-tier mapping boundaries
{
  check('mapping: the tier set is exactly the four briefed tiers',
    JSON.stringify(M.READINESS_ADVICE_TIERS) === JSON.stringify(['normal', 'reduced', 'recovery', 'insufficient']));
  check('mapping: 准备就绪 → 正常计划 (symbol ✓, level 3) and 全力以赴 → 正常计划',
    adviceTierForStatus('准备就绪') === 'normal' && adviceTierForStatus('全力以赴') === 'normal'
    && buildReadinessAdvice(inputFor('准备就绪', 6.5))?.label === '正常计划'
    && buildReadinessAdvice(inputFor('准备就绪', 6.5))?.symbol === '✓'
    && buildReadinessAdvice(inputFor('准备就绪', 6.5))?.level === 3
    && buildReadinessAdvice(inputFor('全力以赴', 9.1))?.tier === 'normal');
  check('mapping: 量力而行 → 降强度 (symbol ▼, level 2)',
    adviceTierForStatus('量力而行') === 'reduced'
    && buildReadinessAdvice(inputFor('量力而行', 3.5))?.label === '降强度'
    && buildReadinessAdvice(inputFor('量力而行', 3.5))?.symbol === '▼'
    && buildReadinessAdvice(inputFor('量力而行', 3.5))?.level === 2);
  check('mapping: 恢复 → 恢复日 (symbol ○, level 1)',
    adviceTierForStatus('恢复') === 'recovery'
    && buildReadinessAdvice(inputFor('恢复', 1.2))?.label === '恢复日'
    && buildReadinessAdvice(inputFor('恢复', 1.2))?.symbol === '○'
    && buildReadinessAdvice(inputFor('恢复', 1.2))?.level === 1);
  check('mapping: the status is the sole tier input — the same score maps by status, and a high score never re-tiers 量力而行',
    buildReadinessAdvice(inputFor('准备就绪', 4.9))?.tier === 'normal'
    && buildReadinessAdvice(inputFor('量力而行', 4.9))?.tier === 'reduced'
    && buildReadinessAdvice(inputFor('量力而行', 9.5))?.tier === 'reduced'
    && buildReadinessAdvice(inputFor('恢复', 9.5))?.tier === 'recovery');
  check('mapping: headlines are the four briefed non-medical sentences, free of any weight/set/exercise prescription',
    READINESS_ADVICE_META.normal.headline === '按计划训练即可。'
    && READINESS_ADVICE_META.reduced.headline === '降低强度或缩短时长。'
    && READINESS_ADVICE_META.recovery.headline === '安排恢复日或休息。'
    && READINESS_ADVICE_META.insufficient.headline === '先补齐数据再定计划。'
    && Object.values(READINESS_ADVICE_META).every((meta) => !/千克|公斤|kg|深蹲|卧推|组数|RM/.test(meta.headline)));
}

// ------------------------------------------- (2) trigger basis naming
{
  const reduced = buildReadinessAdvice(inputFor('量力而行', 3.5, {
    adjustments: ['HRV 被压制且静息心率升高：降一档', '7 天睡眠债超过 3 小时：降一档'],
  }));
  const joined = reduced.reasons.join('\n');
  check('basis: the status, tier, score, and confidence are all named',
    joined.includes('准备度状态「量力而行」') && joined.includes('降强度')
    && joined.includes('准备度分数 3.5/10') && joined.includes('置信度中') && joined.includes('可用信号 4 项'));
  check('basis: every readiness adjustment is carried verbatim',
    joined.includes('保守修正：HRV 被压制且静息心率升高：降一档') && joined.includes('保守修正：7 天睡眠债超过 3 小时：降一档'));
  check('basis: 降强度 names its lowest-scored components (HRV first, then 静息心率） with scores and details',
    joined.includes('主要拉分组件：HRV 3/10') && joined.includes('ln(HRV) z -1.00')
    && joined.includes('主要拉分组件：静息心率 4/10') && !joined.includes('主要拉分组件：昨晚睡眠'));
  const normal = buildReadinessAdvice(inputFor('全力以赴', 9.1));
  check('basis: 正常计划 names its highest-scored supporting components',
    normal.reasons.join('\n').includes('支撑组件：昨晚睡眠 8/10')
    && normal.reasons.join('\n').includes('支撑组件：7 天睡眠银行 7/10'));
  check('basis: the advice echoes the input score/confidence/signalCount without recomputing them',
    reduced.score === 3.5 && reduced.confidence === '中' && reduced.signalCount === 4 && reduced.status === '量力而行');
  const fixture = inputFor('恢复', 1.2);
  const snapshot = JSON.stringify(fixture);
  buildReadinessAdvice(fixture);
  check('basis: derivation never mutates the readiness input', JSON.stringify(fixture) === snapshot);
}

// ------------------------------------------- (3) status period: no advice
{
  check('status: a suppressed readiness (H4.4 flag) yields NO advice even with a ready status and high score',
    buildReadinessAdvice(inputFor('准备就绪', 9.0, { suppressed: true })) === null);
  check('status: the 状态期 status itself yields NO advice even without the flag',
    buildReadinessAdvice(inputFor('状态期', null, { suppressed: false })) === null
    && adviceTierForStatus('状态期') === null);
  check('status: no readiness at all yields no advice (null / undefined input)',
    buildReadinessAdvice(null) === null && buildReadinessAdvice(undefined) === null);
  check('status: an unknown status yields no advice rather than a guessed tier',
    buildReadinessAdvice(inputFor('未知状态', 5)) === null);
}

// ------------------------------------------- (4) 数据不足 branch
{
  const insufficient = buildReadinessAdvice({
    status: '数据不足', score: null, confidence: '低', signalCount: 1,
    adjustments: [], components: COMPONENTS,
  });
  check('insufficient: 数据不足 → tier insufficient (symbol —, level 0) with the补齐数据 headline',
    insufficient?.tier === 'insufficient' && insufficient?.label === '数据不足'
    && insufficient?.symbol === '—' && insufficient?.level === 0
    && insufficient?.headline === '先补齐数据再定计划。' && insufficient?.score === null);
  check('insufficient: the basis states there is no score and names the signal-count shortfall',
    insufficient.reasons.join('\n').includes('准备度分数暂无')
    && insufficient.reasons.join('\n').includes('可用信号 1 项'));
}

// ------------------------------------------- (5) missing signals named individually
{
  const missing = missingSignalsFor(COMPONENTS);
  check('missing: every scoreless component is named individually with its reason',
    missing.length === 2
    && missing.some((line) => line.includes('训练负荷') && line.includes('历史覆盖不足'))
    && missing.some((line) => line.includes('呼吸频率') && line.includes('当天没戴表')));
  check('missing: a scored component is never listed as missing',
    !missing.some((line) => line.startsWith('HRV')) && !missing.some((line) => line.startsWith('昨晚睡眠')));
  const advice = buildReadinessAdvice(inputFor('准备就绪', 6.5));
  check('missing: the advice carries missingSignals and the basis names each missing signal',
    advice.missingSignals.length === 2
    && advice.reasons.join('\n').includes('缺失信号：训练负荷')
    && advice.reasons.join('\n').includes('缺失信号：呼吸频率：当天没戴表'));
  const full = buildReadinessAdvice(inputFor('准备就绪', 6.5, {
    components: COMPONENTS.map((component) => ({ ...component, score: component.score ?? 6 })),
  }));
  check('missing: with every component scored, no missing signal is invented',
    full.missingSignals.length === 0 && !full.reasons.join('\n').includes('缺失信号'));
}

// ------------------------------------------------------- mutation sensitivity
{
  const mappingMutant = buildModule(adviceSrc.replace('"量力而行": "reduced"', '"量力而行": "normal"'));
  check('mutation setup: the tier-mapping mutant source actually differs', adviceSrc.includes('"量力而行": "reduced"'));
  const realTier = buildReadinessAdvice(inputFor('量力而行', 3.5))?.tier;
  const mutantTier = mappingMutant.buildReadinessAdvice(inputFor('量力而行', 3.5))?.tier;
  check('mutation: remapping 量力而行 to normal flips the mapping assertion',
    realTier === 'reduced' && mutantTier === 'normal');

  const suppressMutant = buildModule(adviceSrc.replace('if (input.suppressed || input.status === "状态期") return null;', 'if (false) return null;'));
  check('mutation setup: the suppression-off mutant source actually differs',
    adviceSrc.includes('if (input.suppressed || input.status === "状态期") return null;'));
  const realSuppressed = buildReadinessAdvice(inputFor('准备就绪', 9.0, { suppressed: true }));
  const mutantSuppressed = suppressMutant.buildReadinessAdvice(inputFor('准备就绪', 9.0, { suppressed: true }));
  check('mutation: disabling the status-period guard flips the no-advice assertion',
    realSuppressed === null && mutantSuppressed !== null && mutantSuppressed.tier === 'normal');

  const missingMutant = buildModule(adviceSrc.replace('component.score === null', 'component.score !== null'));
  check('mutation setup: the missing-filter mutant source actually differs', adviceSrc.includes('component.score === null'));
  const realMissing = missingSignalsFor(COMPONENTS);
  const mutantMissing = missingMutant.missingSignalsFor(COMPONENTS);
  check('mutation: inverting the missing-signal filter flips the naming assertion',
    realMissing.length === 2 && mutantMissing.length === 4
    && !realMissing.some((line) => line.startsWith('HRV')) && mutantMissing.some((line) => line.startsWith('HRV')));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
