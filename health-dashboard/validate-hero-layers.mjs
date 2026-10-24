// H-UI-002 (first-screen layering) + H-FRESH-001 (per-source hero status)
// validation. Runs the REAL production functions (todayConclusion,
// weekFocusTeaser) extracted verbatim from client/src/App.tsx over
// synthetic data only, plus wiring checks on the layered structure:
// hero holds only the three layers, the sunk blocks render below it
// exactly once, and the deleted duplicate blocks stay deleted.
// Pure Node, no deps. Mutation: dropping the missing-input naming in
// todayConclusion must change the no-readiness outcome.
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
  // Skip an optional `: { ... }` return-type annotation before the body.
  let scan = closeParen + 1;
  while (source[scan] === ' ' || source[scan] === '\n') scan++;
  if (source[scan] === ':') {
    const typeStart = source.indexOf('{', scan);
    scan = matchDelim(source, typeStart, '{', '}') + 1;
  }
  const bodyStart = source.indexOf('{', scan);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ---------- Wiring: three layers in the hero, everything else sunk ----------
const heroStart = clientSrc.indexOf('function WhoopHero(');
const heroEnd = clientSrc.indexOf('function SevenDayFacts(', heroStart);
const heroSrc = clientSrc.slice(heroStart, heroEnd);
check('hero renders per-source lines (healthLine + strengthLine)', heroSrc.includes('source.healthLine') && heroSrc.includes('source.strengthLine'));
check('hero no longer renders the drivers grid (dedupe)', !heroSrc.includes('whoop-drivers'));
check('hero no longer renders SevenDayFacts or WeekReviewPanel', !heroSrc.includes('<SevenDayFacts') && !heroSrc.includes('<WeekReviewPanel'));
check('hero keeps the three score rings + TRIMP note', heroSrc.includes('whoop-scores') && heroSrc.includes('Banister TRIMP'));
check('hero renders the week-focus teaser card', heroSrc.includes('weekFocusTeaser('));
check('teaser button scrolls to the full week review panel', heroSrc.includes('scrollToId("week-review-panel")'));
check('basis button scrolls to the readiness panel', heroSrc.includes('scrollToId("readiness-basis")'));
const todayStart = clientSrc.indexOf('function TodayView(');
const todayEnd = clientSrc.indexOf('function HistoryView(', todayStart);
const todaySrc = clientSrc.slice(todayStart, todayEnd);
check('full week review panel rendered once, below the hero', countOccurrences(todaySrc, '<WeekReviewPanel') === 1 && todaySrc.indexOf('<WeekReviewPanel') > todaySrc.indexOf('<WhoopHero'));
check('week review panel carries its anchor id exactly once', countOccurrences(clientSrc, 'id="week-review-panel"') === 1);
check('seven-day facts rendered once, below the hero', countOccurrences(todaySrc, '<SevenDayFacts') === 1 && todaySrc.indexOf('<SevenDayFacts') > todaySrc.indexOf('<WhoopHero'));
check('readiness basis anchor id present once', countOccurrences(clientSrc, 'id="readiness-basis"') === 1);
check('standalone 昨日概览 verdict block removed (dedupe)', !todaySrc.includes('昨日概览') && !todaySrc.includes('verdict-title'));
check('missing note still rendered in TodayView (not hidden)', todaySrc.includes('missing-note') || heroSrc.includes('missing-note') || todaySrc.includes('还没同步完'));
check('KPI board kept as the single yesterday-metrics presentation', countOccurrences(todaySrc, 'kpi-board') >= 1 && countOccurrences(todaySrc, '<Kpi ') === 4);

// ---------- todayConclusion: real function over synthetic inputs ----------
function buildFns(src) {
  const code = ['todayConclusion', 'weekFocusTeaser'].map((n) => extractFunction(src, n).replace(/^export /, '')).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { todayConclusion, weekFocusTeaser };`)();
}
const { todayConclusion, weekFocusTeaser } = buildFns(clientSrc);
const snap = (over = {}) => ({
  dataDate: '2026-10-22',
  coverageIncomplete: false,
  restingHr: { value: 62 },
  hrv: { value: 41 },
  ...over,
});
const withReadiness = todayConclusion({ status: '状态良好', summary: '恢复不错，可以按计划训练。' }, snap());
check('conclusion with readiness = status + summary verbatim', withReadiness.title === '状态良好' && withReadiness.text === '恢复不错，可以按计划训练。');
const noReadiness = todayConclusion(null, snap({ restingHr: { value: null }, hrv: { value: null }, coverageIncomplete: true }));
check('conclusion without readiness says 数据不足', noReadiness.title === '数据不足');
check('conclusion names the missing inputs', noReadiness.text.includes('静息心率') && noReadiness.text.includes('HRV'));
check('conclusion distinguishes 还没同步完 when coverage incomplete', noReadiness.text.includes('还没同步完'));
const noReadinessWorn = todayConclusion(null, snap({ restingHr: { value: null } }));
check('conclusion distinguishes 当天没戴表 when coverage complete', noReadinessWorn.text.includes('当天没戴表') && !noReadinessWorn.text.includes('还没同步完'));
check('conclusion deterministic', JSON.stringify(todayConclusion(null, snap())) === JSON.stringify(todayConclusion(null, snap())));

// Mutation: remove the missing-input naming -> the no-readiness text must change.
const mutatedSrc = clientSrc.replace('const missing = [snapshot.restingHr.value === null ? "静息心率" : null, snapshot.hrv.value === null ? "HRV" : null]', 'const missing = []');
check('mutation source actually differs', mutatedSrc !== clientSrc);
if (mutatedSrc !== clientSrc) {
  const mutated = buildFns(mutatedSrc);
  const mutatedOut = mutated.todayConclusion(null, snap({ restingHr: { value: null }, hrv: { value: null }, coverageIncomplete: true }));
  check('mutation (drop missing naming) changes outcome', !mutatedOut.text.includes('静息心率'));
}

// ---------- weekFocusTeaser: real function over a synthetic review ----------
const teaser = weekFocusTeaser({ focus: '固定睡眠窗口', reviewWindow: { start: '2026-10-16', end: '2026-10-22' } });
check('teaser returns the focus line verbatim', teaser.focusText === '固定睡眠窗口');
check('teaser window label uses month/day of both ends', teaser.windowLabel === '复盘窗 10月16日–10月22日');

console.log(`\nvalidate-hero-layers: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
