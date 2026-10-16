// H-SOURCE-001 validation: the health snapshot and the standalone
// strength snapshot must be loaded, validated, and reported
// independently — one source missing or corrupt must never swallow the
// other. Runs the REAL extracted pure functions from
// server/src/actions.ts (types stripped with
// node:module.stripTypeScriptTypes) over synthetic load objects only:
// effectiveStrength, buildDataStatus, buildUnifiedTimeline. The async DB
// loaders themselves cannot run outside the artifact runtime; their
// state contract (ok / missing / corrupt, parse failure marks only its
// own source) is asserted against the source text, and the builder's
// artifact audit covers the deployed handlers.
// Five-state matrix: health-only, strength-only, both, neither, and one
// side corrupt (both directions). Pure Node, no deps. Exit non-zero on
// any failure.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

// ---------------------------------------------------------------- source
check('independent health loader exists', src.includes('async function loadHealthSnapshot(ctx: Ctx): Promise<HealthLoad>'));
check('independent strength loader exists', src.includes('async function loadStrengthSnapshot(ctx: Ctx): Promise<StrengthLoad>'));
check('health loader marks schema-mismatch payload corrupt, not missing',
  src.includes('return snapshot ? { state: "ok", snapshot } : { state: "corrupt", snapshot: null };'));
check('strength loader marks schema-mismatch payload corrupt, not missing',
  src.includes('return strength ? { state: "ok", strength } : { state: "corrupt", strength: null };'));
check('getDashboard no longer early-returns on a missing health row',
  !src.includes('if (!first) {\n        const logs = await loadRecentLogs(ctx);\n        return { forbidden: false, snapshot: null, readiness: null, strengthSyncTaskId: null, dataStatus: buildDataStatus(null, logs), unifiedTimeline: [] };'));
check('buildDataStatus takes both loads, not a merged snapshot',
  src.includes('function buildDataStatus(health: HealthLoad, strength: StrengthLoad, logs: SyncLogEntry[]): DataStatus'));
check('corrupt health detail says damaged, distinct from never-synced',
  src.includes('"健康快照损坏，等待重新同步"') && src.includes('"尚未同步过健康数据"'));
check('corrupt strength detail says damaged, distinct from never-synced',
  src.includes('"训练快照损坏，等待重新同步"') && src.includes('"尚未同步过训练记录"'));
check('corrupt standalone strength merges an honest placeholder, not stale embedded data',
  src.includes('const CORRUPT_STRENGTH_PLACEHOLDER: StrengthTraining = {') && src.includes('训练快照已损坏，重新同步后恢复。'));
check('response carries additive per-source fields',
  src.includes('healthState: z.enum(["ok", "missing", "corrupt"])') && src.includes('strengthState: z.enum(["ok", "missing", "corrupt"])') && src.includes('strength: strengthTrainingSchema.nullable()'));
{
  // Auto-sync must be spawned before the health-state branch so the
  // health missing/corrupt path also triggers it.
  const spawnIdx = src.indexOf('const strengthSyncTaskId = await maybeAutoSyncStrength(ctx);');
  const branchIdx = src.indexOf('if (healthLoad.state !== "ok" || !healthLoad.snapshot) {');
  check('auto strength sync runs before the health-state branch (every owner path)',
    spawnIdx > 0 && branchIdx > spawnIdx, `spawn=${spawnIdx} branch=${branchIdx}`);
}
check('diagnostics loads both sources independently',
  src.indexOf('const healthLoad = await loadHealthSnapshot(ctx);', src.indexOf('getSyncDiagnostics')) > 0
  && src.indexOf('const strengthLoad = await loadStrengthSnapshot(ctx);', src.indexOf('getSyncDiagnostics')) > 0);

// ------------------------------------------------------- real-function run
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
const FN = ['clamp', 'round', 'totalSleepHours', 'timeInBedHours', 'convertVolumeToUnit',
  'freshnessFor', 'effectiveStrength', 'buildDataStatus', 'buildUnifiedTimeline'];
const lbDecl = src.match(/const LB_TO_KG = [0-9.]+;/)?.[0] ?? '';
if (!lbDecl) throw new Error('LB_TO_KG declaration not found');
const code = `${lbDecl}\n${FN.map((n) => extractFunction(src, n)).join('\n')}`;
const stripped = stripTypeScriptTypes(code);
const impl = new Function(`${stripped}\nreturn { effectiveStrength, buildDataStatus, buildUnifiedTimeline };`)();

// ------------------------------------------------------------- fixtures
const nowIso = new Date().toISOString();
function strengthData({ workouts = [], displayUnit = 'kg', updatedAt = nowIso } = {}) {
  return { updatedAt, displayUnit, workouts, weeklyTrend: [], note: 'synthetic' };
}
function workout(id, date, unit, totalVolume) {
  return {
    id, date, startedAt: `${date}T15:00:00.000Z`, completedAt: `${date}T16:00:00.000Z`,
    status: 'completed', routine: 'push', unit, durationMinutes: 60,
    completedSets: 5, totalSets: 5, totalVolume, exercises: [],
  };
}
function healthSnap({ embedded = strengthData() } = {}) {
  return {
    dataDate: '2026-10-14', updatedAt: nowIso, timezone: 'America/Los_Angeles', coverageIncomplete: false,
    strengthTraining: embedded,
    historyDaily: [{ date: '2026-10-14', steps: 5000, activeKcal: 300, exerciseMinutes: 30, restingHr: 60, hrvMs: 40, respiratoryRate: 14, weightKg: 80, swimMeters: 0 }],
    historySleeps: [],
  };
}
const okHealth = (embedded) => ({ state: 'ok', snapshot: healthSnap({ embedded }) });
const missingHealth = { state: 'missing', snapshot: null };
const corruptHealth = { state: 'corrupt', snapshot: null };
const okStrength = (s) => ({ state: 'ok', strength: s });
const missingStrength = { state: 'missing', strength: null };
const corruptStrength = { state: 'corrupt', strength: null };
const dayOf = (timeline, date) => timeline.find((d) => d.date === date);

// effectiveStrength resolution order
{
  const standalone = strengthData({ workouts: [workout('s', '2026-10-14', 'kg', 10)] });
  const embedded = strengthData({ workouts: [workout('e', '2026-10-13', 'lb', 20)] });
  check('effectiveStrength: standalone ok wins over embedded',
    impl.effectiveStrength(okHealth(embedded), okStrength(standalone)) === standalone);
  check('effectiveStrength: standalone missing falls back to embedded (legacy)',
    impl.effectiveStrength(okHealth(embedded), missingStrength) === embedded);
  check('effectiveStrength: standalone corrupt yields null, never stale embedded',
    impl.effectiveStrength(okHealth(embedded), corruptStrength) === null);
  check('effectiveStrength: standalone missing + health missing yields null',
    impl.effectiveStrength(missingHealth, missingStrength) === null);
}

// Matrix 1: both sources ok
{
  const s = strengthData({ workouts: [workout('a', '2026-10-14', 'lb', 100)] });
  const ds = impl.buildDataStatus(okHealth(), okStrength(s), []);
  check('both ok: overall is not empty/partial', ds.overall === 'ok' || ds.overall === 'stale', ds.overall);
  check('both ok: neither side missing', ds.health.freshness !== 'missing' && ds.strength.freshness !== 'missing');
  const tl = impl.buildUnifiedTimeline(healthSnap(), impl.effectiveStrength(okHealth(), okStrength(s)));
  const day = dayOf(tl, '2026-10-14');
  check('both ok: timeline day merges health + strength, volume converted lb->kg 45.4',
    day.hasHealth && day.hasStrength && day.strengthVolume === 45.4, `vol=${day?.strengthVolume}`);
}

// Matrix 2: strength only (health missing) — the original bug scenario
{
  const s = strengthData({ workouts: [workout('a', '2026-10-14', 'kg', 100)] });
  const ds = impl.buildDataStatus(missingHealth, okStrength(s), []);
  check('strength only: health marked missing', ds.health.freshness === 'missing');
  check('strength only: strength NOT marked missing', ds.strength.freshness !== 'missing', ds.strength.freshness);
  check('strength only: overall partial (not empty)', ds.overall === 'partial', ds.overall);
  const tl = impl.buildUnifiedTimeline(null, impl.effectiveStrength(missingHealth, okStrength(s)));
  check('strength only: timeline still has the strength day',
    tl.length === 1 && tl[0].hasStrength && !tl[0].hasHealth && tl[0].strengthVolume === 100);
}

// Matrix 3: health only (standalone missing, embedded empty)
{
  const emptyEmbedded = strengthData({ workouts: [], updatedAt: null });
  const ds = impl.buildDataStatus(okHealth(emptyEmbedded), missingStrength, []);
  check('health only: health not missing', ds.health.freshness !== 'missing');
  check('health only: strength marked missing', ds.strength.freshness === 'missing');
  check('health only: overall partial', ds.overall === 'partial', ds.overall);
  const tl = impl.buildUnifiedTimeline(healthSnap({ embedded: emptyEmbedded }), impl.effectiveStrength(okHealth(emptyEmbedded), missingStrength));
  check('health only: timeline has health days and no strength sessions',
    tl.length > 0 && tl.every((d) => d.hasHealth && !d.hasStrength));
}

// Matrix 4: neither source
{
  const ds = impl.buildDataStatus(missingHealth, missingStrength, []);
  check('neither: overall empty', ds.overall === 'empty', ds.overall);
  check('neither: both sides missing', ds.health.freshness === 'missing' && ds.strength.freshness === 'missing');
  check('neither: timeline empty', impl.buildUnifiedTimeline(null, null).length === 0);
}

// Matrix 5a: health corrupt, strength ok — corrupt must not swallow strength
{
  const s = strengthData({ workouts: [workout('a', '2026-10-14', 'kg', 100)] });
  const ds = impl.buildDataStatus(corruptHealth, okStrength(s), []);
  check('health corrupt: health detail says damaged', ds.health.detail.includes('损坏'), ds.health.detail);
  check('health corrupt: strength still usable, overall partial',
    ds.strength.freshness !== 'missing' && ds.overall === 'partial', `${ds.strength.freshness}/${ds.overall}`);
  const tl = impl.buildUnifiedTimeline(null, impl.effectiveStrength(corruptHealth, okStrength(s)));
  check('health corrupt: timeline still shows strength', tl.length === 1 && tl[0].hasStrength);
}

// Matrix 5b: strength corrupt, health ok — corrupt must not swallow health
{
  const ds = impl.buildDataStatus(okHealth(), corruptStrength, []);
  check('strength corrupt: strength detail says damaged', ds.strength.detail.includes('损坏'), ds.strength.detail);
  check('strength corrupt: health still usable, overall partial',
    ds.health.freshness !== 'missing' && ds.overall === 'partial', `${ds.health.freshness}/${ds.overall}`);
  const tl = impl.buildUnifiedTimeline(healthSnap(), impl.effectiveStrength(okHealth(), corruptStrength));
  check('strength corrupt: timeline keeps health days, no strength',
    tl.length > 0 && tl.every((d) => d.hasHealth && !d.hasStrength));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
