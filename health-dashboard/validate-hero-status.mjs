// H-UI-001 (source strip) validation.
// Runs the REAL production functions (heroSourceStatus and its helpers
// freshnessLabel / updatedLabel) extracted verbatim from
// health-dashboard/client/src/App.tsx over synthetic data only.
// Pure Node, no deps. Also executes two source mutations (dropping the
// readiness-null health retry, and letting a stale strength source outrank a
// stale health source) and asserts the mutated function changes the outcome
// — proving sensitivity.
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

check('source: WhoopHero renders the source strip before the scores',
  clientSrc.includes('whoop-source-bar') && clientSrc.indexOf('whoop-source-bar') < clientSrc.indexOf('whoop-scores'));
check('source: data status panel carries the scroll target id',
  clientSrc.includes('id="data-status-panel"'));
check('source: hero action scrolls to the data status panel, no guessed cross-artifact URL',
  clientSrc.includes('scrollToId("data-status-panel")') && !/https?:\/\/[^\s"'`]*?(?:workout|space-6)[^\s"'`]*?/i.test(clientSrc));

const FN_NAMES = ['updatedLabel', 'freshnessLabel', 'heroSourceStatus'];
function buildFns(src) {
  const code = FN_NAMES.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { heroSourceStatus };`)();
}
const { heroSourceStatus } = buildFns(clientSrc);

// Producer side: the REAL server freshnessFor from server/src/actions.ts —
// buildDataStatus feeds it a corrupt-specific detailBase ("…快照损坏，等待
// 重新同步") or a never-synced one ("尚未同步过…") with updatedAt null, and
// both come out as freshness "missing". Feeding those producer rows into
// the hero proves the corrupt vs never-synced distinction survives the
// producer -> hero chain instead of being rewritten to 尚未同步.
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const { freshnessFor } = new Function(`${stripTypeScriptTypes(extractFunction(serverSrc, 'freshnessFor'))}\nreturn { freshnessFor };`)();

// ------------------------------------------------------------ synthetic data
const row = (freshness, updatedAt = '2026-10-16T15:00:00Z', detail = '') => ({ source: 'x', label: 'x', detail, freshness, updatedAt, ageMinutes: 30, dataDate: '2026-10-14' });
const status = (health, strength) => ({ health, strength, overall: 'ok', overallLabel: '', recentLogs: [] });
const snap = { dataDate: '2026-10-14' };
const rd = (date = '2026-10-14') => ({ date });

// ------------------------------------------------------------ cases
{
  const r = heroSourceStatus(snap, rd(), status(row('fresh'), row('today')));
  check('both sources usable + readiness same date: 同日 noted, single view-status action',
    r.dataDateLine.includes('数据日期 2026-10-14（最近完整日）') && r.dataDateLine.includes('恢复参考同日')
    && r.healthLine.startsWith('新鲜') && r.healthLine.includes('更新于') && r.strengthLine.startsWith('今天更新')
    && r.action.kind === 'view-status' && r.action.label === '查看数据状态');
}
{
  const r = heroSourceStatus(snap, rd('2026-10-15'), status(row('fresh'), row('fresh')));
  check('readiness date differs from dataDate: labelled separately, never merged',
    r.dataDateLine.includes('数据日期 2026-10-14（最近完整日）') && r.dataDateLine.includes('恢复参考日期 2026-10-15'));
}
{
  const r = heroSourceStatus(snap, null, status(row('fresh'), row('fresh')));
  check('readiness missing: data date line stands alone (the missing reference is named in the conclusion layer, not merged here), action retries health sync even when sources look fresh',
    r.dataDateLine === '数据日期 2026-10-14（最近完整日）' && r.action.kind === 'sync-health' && r.action.label === '重新同步健康数据');
}
{
  const r = heroSourceStatus(snap, rd(), null);
  check('dataStatus null: both lines 来源状态未知 (no guessing), action retries health sync',
    r.healthLine === '来源状态未知' && r.strengthLine === '来源状态未知' && r.action.kind === 'sync-health');
}
{
  const r = heroSourceStatus(snap, rd(), status(row('stale'), row('missing')));
  check('health stale outranks strength missing: action is health sync (fixed priority)',
    r.action.kind === 'sync-health' && r.healthLine.startsWith('已过期'));
}
{
  const r = heroSourceStatus(snap, rd(), status(row('fresh'), row('missing', null)));
  check('health fresh + strength missing with empty detail: line falls back to 尚未同步, action syncs strength',
    r.strengthLine === '尚未同步' && r.action.kind === 'sync-strength' && r.action.label === '同步训练记录');
}
{
  // producer -> hero: corrupt strength snapshot (server detail) must NOT
  // read as never synced.
  const corruptStrength = freshnessFor('strength', '训练记录', null, null, '训练快照损坏，等待重新同步');
  const neverStrength = freshnessFor('strength', '训练记录', null, null, '尚未同步过训练记录');
  check('producer: corrupt and never-synced rows share freshness missing but keep distinct details',
    corruptStrength.freshness === 'missing' && neverStrength.freshness === 'missing' && corruptStrength.detail !== neverStrength.detail);
  const rc = heroSourceStatus(snap, rd(), status(row('fresh'), corruptStrength));
  const rn = heroSourceStatus(snap, rd(), status(row('fresh'), neverStrength));
  check('hero: corrupt strength line shows the damage reason, never-synced line differs, both keep the strength sync action',
    rc.strengthLine === '训练快照损坏，等待重新同步' && rn.strengthLine === '尚未同步过训练记录'
    && rc.strengthLine !== rn.strengthLine && rc.action.kind === 'sync-strength' && rn.action.kind === 'sync-strength');
}
{
  const corruptHealth = freshnessFor('health', 'Apple 健康', null, null, '健康快照损坏，等待重新同步');
  const neverHealth = freshnessFor('health', 'Apple 健康', null, null, '尚未同步过健康数据');
  const rc = heroSourceStatus(snap, rd(), status(corruptHealth, row('fresh')));
  const rn = heroSourceStatus(snap, rd(), status(neverHealth, row('fresh')));
  check('hero: corrupt health line shows the damage reason vs never-synced, action retries health sync',
    rc.healthLine === '健康快照损坏，等待重新同步' && rn.healthLine === '尚未同步过健康数据' && rc.action.kind === 'sync-health');
}
{
  const partial = { dataDate: '2026-10-14', coverageIncomplete: true };
  const rp = heroSourceStatus(partial, rd(), status(row('fresh'), row('fresh')));
  check('partial coverage with fresh timestamps: coverage gap is visible on the first layer, action unchanged',
    rp.coverageLine === '覆盖不完整' && rp.action.kind === 'view-status');
  const rf = heroSourceStatus(snap, rd(), status(row('fresh'), row('fresh')));
  check('complete coverage: no coverage line',
    rf.coverageLine === null);
}
check('source: coverage line renders inside the strip before the primary action',
  clientSrc.includes('whoop-source-coverage')
  && clientSrc.indexOf('whoop-source-bar') < clientSrc.indexOf('whoop-source-coverage')
  && clientSrc.indexOf('whoop-source-coverage') < clientSrc.indexOf('whoop-scores')
  && clientSrc.indexOf('whoop-source-coverage') < clientSrc.indexOf('whoop-source-action'));
{
  const r = heroSourceStatus(snap, rd(), status(row('today'), row('stale')));
  check('health today + strength stale: action syncs strength',
    r.action.kind === 'sync-strength');
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noReadinessGate = buildFns(clientSrc.replace('readiness === null || healthStale', 'healthStale'));
  const input = [snap, null, status(row('fresh'), row('fresh'))];
  check('mutation: dropping the readiness-null gate flips missing-readiness action to view-status',
    heroSourceStatus(...input).action.kind === 'sync-health' && noReadinessGate.heroSourceStatus(...input).action.kind === 'view-status');

  const strengthFirst = buildFns(clientSrc.replace(
    'const action: HeroSourceStatus["action"] = readiness === null || healthStale',
    'const action: HeroSourceStatus["action"] = strengthStale ? { kind: "sync-strength", label: "同步训练记录" } : readiness === null || healthStale',
  ));
  const both = [snap, rd(), status(row('stale'), row('missing'))];
  check('mutation: letting strength outrank health flips both-bad action to sync-strength',
    heroSourceStatus(...both).action.kind === 'sync-health' && strengthFirst.heroSourceStatus(...both).action.kind === 'sync-strength');

  const noDetail = buildFns(clientSrc.replace('if (source.freshness === "missing") return source.detail ? source.detail : "尚未同步";', 'if (source.freshness === "missing") return "尚未同步";'));
  const corruptStrength = freshnessFor('strength', '训练记录', null, null, '训练快照损坏，等待重新同步');
  const cInput = [snap, rd(), status(row('fresh'), corruptStrength)];
  check('mutation: dropping the detail passthrough rewrites the corrupt line back to 尚未同步',
    heroSourceStatus(...cInput).strengthLine === '训练快照损坏，等待重新同步' && noDetail.heroSourceStatus(...cInput).strengthLine === '尚未同步');

  const noCoverage = buildFns(clientSrc.replace('snapshot.coverageIncomplete\n    ? "覆盖不完整"', 'false\n    ? "覆盖不完整"'));
  const pInput = [{ dataDate: '2026-10-14', coverageIncomplete: true }, rd(), status(row('fresh'), row('fresh'))];
  check('mutation: dropping the coverageIncomplete gate hides the partial-coverage line',
    heroSourceStatus(...pInput).coverageLine !== null && noCoverage.heroSourceStatus(...pInput).coverageLine === null);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
