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
  clientSrc.includes('whoop-source-strip') && clientSrc.indexOf('whoop-source-strip') < clientSrc.indexOf('whoop-scores'));
check('source: data status panel carries the scroll target id',
  clientSrc.includes('id="data-status-panel"'));
check('source: hero action scrolls to the data status panel, no guessed cross-artifact URL',
  clientSrc.includes('getElementById("data-status-panel")') && !/space-6|workout-log.*https?:|https?:.*workout/.test(clientSrc));

const FN_NAMES = ['updatedLabel', 'freshnessLabel', 'heroSourceStatus'];
function buildFns(src) {
  const code = FN_NAMES.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { heroSourceStatus };`)();
}
const { heroSourceStatus } = buildFns(clientSrc);

// ------------------------------------------------------------ synthetic data
const row = (freshness, updatedAt = '2026-10-16T15:00:00Z') => ({ source: 'x', label: 'x', detail: '', freshness, updatedAt, ageMinutes: 30, dataDate: '2026-10-14' });
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
  check('readiness missing: line says 恢复参考缺失 and action retries health sync even when sources look fresh',
    r.dataDateLine.includes('恢复参考缺失') && r.action.kind === 'sync-health' && r.action.label === '重新同步健康数据');
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
  check('health fresh + strength missing/never synced: line says 尚未同步, action syncs strength',
    r.strengthLine.includes('还没有') && r.strengthLine.includes('尚未同步') && r.action.kind === 'sync-strength' && r.action.label === '同步训练记录');
}
{
  const r = heroSourceStatus(snap, rd(), status(row('today'), row('stale')));
  check('health today + strength stale: action syncs strength',
    r.action.kind === 'sync-strength');
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noReadinessGate = buildFns(clientSrc.replace('readiness === null || healthBad', 'healthBad'));
  const input = [snap, null, status(row('fresh'), row('fresh'))];
  check('mutation: dropping the readiness-null gate flips missing-readiness action to view-status',
    heroSourceStatus(...input).action.kind === 'sync-health' && noReadinessGate.heroSourceStatus(...input).action.kind === 'view-status');

  const strengthFirst = buildFns(clientSrc.replace(
    'const action: { kind: HeroActionKind; label: string } = readiness === null || healthBad',
    'const action: { kind: HeroActionKind; label: string } = strengthBad ? { kind: "sync-strength", label: "同步训练记录" } : readiness === null || healthBad',
  ));
  const both = [snap, rd(), status(row('stale'), row('missing'))];
  check('mutation: letting strength outrank health flips both-bad action to sync-strength',
    heroSourceStatus(...both).action.kind === 'sync-health' && strengthFirst.heroSourceStatus(...both).action.kind === 'sync-strength');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
