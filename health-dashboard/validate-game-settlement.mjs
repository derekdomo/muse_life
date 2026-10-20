// CWEB-SETTLE-001 (P0) + CWEB-SLEEP-001 (P1) validation.
// PM repro on the old settlement (version 64b8b68): the ledger booked
// with ON CONFLICT DO NOTHING and skipped existing (date, category)
// keys, so a partial snapshot froze forever — coverageIncomplete=true
// with steps=2000 booked 2 XP, and the later complete revision to
// 12000 steps still showed 2 (total 12, not 22); a second strength
// session the same day never topped up. And buildGamePlan emitted one
// sleep candidate per sleep row, with the settle Map keeping the last
// array element — main sleep 7h + nap 1h scored 1 or 10 XP depending on
// array order.
// This script runs the REAL production functions (buildGamePlan /
// selectMainSleep / planLedgerAction and their helpers) extracted
// verbatim from health-dashboard/server/src/actions.ts over synthetic
// data only, applying candidates to an in-memory ledger with the same
// decision flow settleGame uses. Pure Node, no deps. It also executes
// three source mutations (removing the completeness gate, making main-
// sleep selection last-row-wins, disabling revision) and asserts the
// mutated code changes the outcome — proving sensitivity.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
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
  // The body opens at the first '{' after the parameter list that does
  // not itself open an object-literal return type (those follow ':').
  let bodyStart = source.indexOf('{', closeParen);
  while (bodyStart >= 0) {
    let prev = bodyStart - 1;
    while (prev > closeParen && /\s/.test(source[prev])) prev--;
    if (source[prev] !== ':') break;
    bodyStart = source.indexOf('{', matchDelim(source, bodyStart, '{', '}'));
  }
  if (bodyStart < 0) throw new Error(`function ${name} body not found`);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function extractConst(source, name) {
  const idx = source.search(new RegExp(`const ${name}(?![A-Za-z0-9_])`));
  if (idx < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  for (let i = idx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return source.slice(idx, i + 1);
  }
  throw new Error(`const ${name} unterminated`);
}

// ------------------------------------------------------------ source checks
check('source: completeness-gate preview note present',
  serverSrc.includes('数据尚未完整，暂为预览'));
check('source: settleGame settles domain candidates via settleLedgerRow',
  serverSrc.includes('await settleLedgerRow(ctx, candidate)'));
check('source: old freeze-on-conflict sleep condition gone',
  !serverSrc.includes('row.date <= dataDate || !health.coverageIncomplete'));
check('source: character page states the settlement/revision rule line',
  clientSrc.includes('数据完整后才结算；来源修订会自动按差额修正账本'));

const CONST_NAMES = [
  'GAME_RULE_VERSION', 'GAME_QUEST_TARGET_STEPS', 'GAME_QUEST_REWARD_XP',
  'GAME_STRENGTH_SESSION_XP', 'GAME_ATTR_XP_PCT_PER_POINT', 'GAME_ATTR_DOMAIN_CAP_PCT',
  'GAME_ATTRIBUTES', 'GAME_ATTRIBUTE_DOMAIN', 'GAME_EQUIPMENT', 'GAME_EQUIPMENT_BY_ID',
];
const FN_NAMES = [
  'timeInBedHours', 'totalSleepHours', 'shiftDate', 'sleepStartOrderKey',
  'selectMainSleep', 'stepsXpFor', 'sleepXpFor', 'attrBonusPct', 'equippedDefs',
  'equipBonusPct', 'boostedXp', 'planLedgerAction', 'buildGamePlan',
];
function buildFns(src) {
  const code = [
    ...CONST_NAMES.map((n) => extractConst(src, n)),
    ...FN_NAMES.map((n) => extractFunction(src, n)),
  ].join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { buildGamePlan, planLedgerAction, selectMainSleep, GAME_RULE_VERSION };`)();
}
const { buildGamePlan, planLedgerAction, selectMainSleep, GAME_RULE_VERSION } = buildFns(serverSrc);

// ------------------------------------------------------------ synthetic data
const T1 = '2026-10-15T15:00:00.000Z';
const T2 = '2026-10-16T15:00:00.000Z';
const T3 = '2026-10-17T15:00:00.000Z';
const TODAY = '2026-10-15';
const DAY = '2026-10-14';

function makeProfile() {
  return {
    gold: 0, goldInitialized: true,
    attributes: { strength: 0, endurance: 0, spirit: 0, stamina: 0 },
    attrPointsEarned: 0, owned: [], equipped: { weapon: null, armor: null, accessory: null },
  };
}
function makeHealth({ dataDate = DAY, updatedAt = T1, coverageIncomplete = false, daily = [], sleeps = [] } = {}) {
  return {
    dataDate, updatedAt, coverageIncomplete,
    morningReference: { date: TODAY, hrvMs: null, avgHrBpm: null },
    historyDaily: daily, historySleeps: sleeps,
  };
}
function makeStrength(updatedAt, dates) {
  return {
    updatedAt, displayUnit: 'lb', note: 'synthetic', weeklyTrend: [],
    workouts: dates.map((date, i) => ({ id: `w${i}`, date, status: 'completed' })),
  };
}
function sleepRow(date, start, end, hours) {
  return { date, start, end, totalHours: hours, coreHours: hours, deepHours: 0, remHours: 0, awakeMinutes: 0, quality: null, awakenings: 0, efficiency: null };
}

// In-memory ledger applying candidates exactly as settleGame does:
// dedupe by (date, category, detail), decide via planLedgerAction,
// insert / refresh source ref / revise in place, gold follows by delta.
function settleCandidates(ledger, goldBox, candidates) {
  const unique = [...new Map(candidates.map((c) => [`${c.localDate}|${c.category}|${c.detail}`, c])).values()];
  for (const candidate of unique) {
    const key = `${candidate.localDate}|${candidate.category}|${candidate.detail}`;
    const existing = ledger.get(key);
    const action = planLedgerAction(existing, candidate);
    if (action.kind === 'insert') {
      ledger.set(key, {
        localDate: candidate.localDate, category: candidate.category, detail: candidate.detail,
        xp: candidate.xp, gold: candidate.gold, ruleVersion: GAME_RULE_VERSION,
        sourceDate: candidate.sourceDate, sourceUpdatedAt: candidate.sourceUpdatedAt,
      });
      goldBox.gold = Math.max(0, goldBox.gold + candidate.gold);
    } else if (action.kind === 'refresh_source_ref') {
      existing.sourceDate = candidate.sourceDate;
      existing.sourceUpdatedAt = candidate.sourceUpdatedAt;
    } else if (action.kind === 'revise') {
      existing.xp = candidate.xp;
      existing.gold = candidate.gold;
      existing.sourceDate = candidate.sourceDate;
      existing.sourceUpdatedAt = candidate.sourceUpdatedAt;
      goldBox.gold = Math.max(0, goldBox.gold + action.goldDelta);
    }
  }
}
const totalXp = (ledger) => [...ledger.values()].reduce((sum, row) => sum + row.xp, 0);
const rowXp = (ledger, date, category) => ledger.get(`${date}|${category}|`)?.xp;

// ------------------------------------------------------------ complete day, first settlement
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const health = makeHealth({
    daily: [{ date: DAY, steps: 12000 }],
    sleeps: [sleepRow(DAY, '23:00', '06:00', 7)],
  });
  const plan = buildGamePlan(health, null, TODAY, makeProfile());
  settleCandidates(ledger, goldBox, plan.candidates);
  check('complete day: steps 12000 -> 12 XP, quest +10, main sleep 7h -> 10, total 32',
    rowXp(ledger, DAY, 'steps') === 12 && rowXp(ledger, DAY, 'quest_steps') === 10
    && rowXp(ledger, DAY, 'sleep') === 10 && totalXp(ledger) === 32);
  check('complete day: gold minted 1:1 with awarded XP (32)',
    goldBox.gold === 32 && [...ledger.values()].every((row) => row.gold === row.xp));
}

// ------------------------------------------------------------ partial snapshot: preview only, zero booked
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const health = makeHealth({
    coverageIncomplete: true,
    daily: [{ date: DAY, steps: 2000 }],
    sleeps: [sleepRow(DAY, '23:00', '06:00', 7)],
  });
  const plan = buildGamePlan(health, null, TODAY, makeProfile());
  settleCandidates(ledger, goldBox, plan.candidates);
  const stepsPreview = plan.previews.find((p) => p.category === 'steps');
  const sleepPreview = plan.previews.find((p) => p.category === 'sleep');
  check('partial (coverageIncomplete): no health candidate is produced',
    plan.candidates.length === 0);
  check('partial: nothing booked, total 0, gold 0',
    ledger.size === 0 && totalXp(ledger) === 0 && goldBox.gold === 0);
  check('partial: steps and sleep previews state 数据尚未完整，暂为预览',
    stepsPreview?.state === 'preview' && stepsPreview.note.includes('数据尚未完整，暂为预览')
    && sleepPreview?.state === 'preview' && sleepPreview.note.includes('数据尚未完整，暂为预览'));
}

// ------------------------------------------------------------ revision: delta top-up (PM numbers)
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const profile = makeProfile();
  // A complete snapshot first reads only 2000 steps for the day.
  let plan = buildGamePlan(makeHealth({ updatedAt: T1, daily: [{ date: DAY, steps: 2000 }] }), null, TODAY, profile);
  settleCandidates(ledger, goldBox, plan.candidates);
  check('revision setup: complete snapshot at 2000 steps books steps 2 XP, total 2',
    rowXp(ledger, DAY, 'steps') === 2 && totalXp(ledger) === 2);
  // The source revises the same day to 12000 steps (newer updatedAt).
  plan = buildGamePlan(makeHealth({ updatedAt: T2, daily: [{ date: DAY, steps: 12000 }] }), null, TODAY, profile);
  settleCandidates(ledger, goldBox, plan.candidates);
  check('revision: steps row corrected 2 -> 12 in place, quest inserts 10, total 22',
    rowXp(ledger, DAY, 'steps') === 12 && rowXp(ledger, DAY, 'quest_steps') === 10 && totalXp(ledger) === 22);
  check('revision: gold follows the delta (2 -> 22, no double mint)',
    goldBox.gold === 22 && ledger.get(`${DAY}|steps|`)?.sourceUpdatedAt === T2);
}
{
  // The PM's literal frozen state: a row the OLD code booked from the
  // partial snapshot (steps 2 XP at source T1, current rule version).
  const ledger = new Map();
  const goldBox = { gold: 2 };
  ledger.set(`${DAY}|steps|`, {
    localDate: DAY, category: 'steps', detail: '', xp: 2, gold: 2,
    ruleVersion: GAME_RULE_VERSION, sourceDate: DAY, sourceUpdatedAt: T1,
  });
  const plan = buildGamePlan(makeHealth({ updatedAt: T2, daily: [{ date: DAY, steps: 12000 }] }), null, TODAY, makeProfile());
  settleCandidates(ledger, goldBox, plan.candidates);
  check('legacy frozen row: complete revision unfreezes it, steps 2 -> 12, total 22',
    rowXp(ledger, DAY, 'steps') === 12 && totalXp(ledger) === 22 && goldBox.gold === 22);
}

// ------------------------------------------------------------ strength: same-day 1 -> 2 sessions top-up
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const profile = makeProfile();
  let plan = buildGamePlan(null, makeStrength(T1, [DAY]), TODAY, profile);
  settleCandidates(ledger, goldBox, plan.candidates);
  check('strength: one completed session books 10 XP from its own snapshot (no health snapshot)',
    rowXp(ledger, DAY, 'strength') === 10 && totalXp(ledger) === 10);
  plan = buildGamePlan(null, makeStrength(T2, [DAY, DAY]), TODAY, profile);
  settleCandidates(ledger, goldBox, plan.candidates);
  check('strength: second session the same day tops the row up 10 -> 20',
    rowXp(ledger, DAY, 'strength') === 20 && totalXp(ledger) === 20 && goldBox.gold === 20);
  const gatedPlan = buildGamePlan(makeHealth({ coverageIncomplete: true }), makeStrength(T1, [DAY]), TODAY, profile);
  check('strength: still a candidate while health coverage is incomplete',
    gatedPlan.candidates.some((c) => c.category === 'strength'));
}

// ------------------------------------------------------------ repeat open: no re-award
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const profile = makeProfile();
  const health = makeHealth({ daily: [{ date: DAY, steps: 12000 }], sleeps: [sleepRow(DAY, '23:00', '06:00', 7)] });
  const plan = buildGamePlan(health, null, TODAY, profile);
  settleCandidates(ledger, goldBox, plan.candidates);
  const snapshotAfterFirst = JSON.stringify([...ledger.values()]);
  settleCandidates(ledger, goldBox, plan.candidates);
  settleCandidates(ledger, goldBox, buildGamePlan(health, null, TODAY, profile).candidates);
  check('repeat open with the same source version: ledger and gold byte-identical',
    JSON.stringify([...ledger.values()]) === snapshotAfterFirst && goldBox.gold === 32 && totalXp(ledger) === 32);
  const sameVersionCandidate = { localDate: DAY, category: 'steps', detail: '', xp: 99, gold: 99, sourceDate: DAY, sourceUpdatedAt: T1 };
  check('planLedgerAction: same sourceUpdatedAt skips even a different value',
    planLedgerAction(ledger.get(`${DAY}|steps|`), sameVersionCandidate).kind === 'skip');
}

// ------------------------------------------------------------ source revision downward
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const profile = makeProfile();
  settleCandidates(ledger, goldBox, buildGamePlan(makeHealth({ updatedAt: T2, daily: [{ date: DAY, steps: 12000 }] }), null, TODAY, profile).candidates);
  settleCandidates(ledger, goldBox, buildGamePlan(makeHealth({ updatedAt: T3, daily: [{ date: DAY, steps: 5000 }] }), null, TODAY, profile).candidates);
  check('downward revision: steps row drops 12 -> 5, total follows to 15',
    rowXp(ledger, DAY, 'steps') === 5 && totalXp(ledger) === 15 && goldBox.gold === 15);
  check('downward revision: no row is ever deleted (quest row remains booked)',
    ledger.has(`${DAY}|quest_steps|`) && rowXp(ledger, DAY, 'quest_steps') === 10);
}

// ------------------------------------------------------------ same value, newer source: refresh ref only
{
  const existing = {
    localDate: DAY, category: 'steps', detail: '', xp: 12, gold: 12,
    ruleVersion: GAME_RULE_VERSION, sourceDate: DAY, sourceUpdatedAt: T1,
  };
  const candidate = { localDate: DAY, category: 'steps', detail: '', xp: 12, gold: 12, sourceDate: DAY, sourceUpdatedAt: T2 };
  check('planLedgerAction: same value + newer source version refreshes only the reference',
    planLedgerAction(existing, candidate).kind === 'refresh_source_ref');
  check('planLedgerAction: different value + newer source version revises with the gold delta',
    JSON.stringify(planLedgerAction(existing, { ...candidate, xp: 20, gold: 20 })) === JSON.stringify({ kind: 'revise', goldDelta: 8 }));
}

// ------------------------------------------------------------ main sleep + nap: order-independent (CWEB-SLEEP-001)
{
  const main = sleepRow(DAY, '23:05', '06:05', 7);
  const nap = sleepRow(DAY, '13:00', '14:00', 1);
  for (const [label, sleeps] of [['main first', [main, nap]], ['nap first', [nap, main]]]) {
    const plan = buildGamePlan(makeHealth({ sleeps }), null, TODAY, makeProfile());
    const candidate = plan.candidates.find((c) => c.category === 'sleep');
    check(`main sleep + nap (${label}): exactly one sleep candidate, scored on the 7h main sleep (10 XP)`,
      plan.candidates.filter((c) => c.category === 'sleep').length === 1 && candidate?.xp === 10);
    check(`selectMainSleep (${label}): picks the longest in-bed row, not the nap`,
      selectMainSleep(sleeps)?.start === '23:05');
  }
  // Tie on time in bed (7h each): the earlier start wins in both orders.
  const early = sleepRow(DAY, '22:30', '05:30', 6.5);
  const late = sleepRow(DAY, '23:30', '06:30', 7);
  for (const sleeps of [[early, late], [late, early]]) {
    const plan = buildGamePlan(makeHealth({ sleeps }), null, TODAY, makeProfile());
    const candidate = plan.candidates.find((c) => c.category === 'sleep');
    check('main sleep tie: equal in-bed duration picks the earlier start (22:30, 6.5h -> 9 XP) in both orders',
      selectMainSleep(sleeps)?.start === '22:30' && candidate?.xp === 9);
  }
  // No measurable time in bed: unconfirmed preview, nothing booked.
  const plan = buildGamePlan(makeHealth({ sleeps: [sleepRow(DAY, '--', '--', 7)] }), null, TODAY, makeProfile());
  const preview = plan.previews.find((p) => p.category === 'sleep');
  check('main sleep indeterminable: no sleep candidate, unconfirmed preview states 主睡眠无法确认',
    !plan.candidates.some((c) => c.category === 'sleep')
    && preview?.state === 'preview' && preview?.xp === null && preview.note.includes('主睡眠无法确认'));
}

// ------------------------------------------------------------ old rule version rows never recompute
{
  const ledger = new Map();
  const goldBox = { gold: 2 };
  ledger.set(`${DAY}|steps|`, {
    localDate: DAY, category: 'steps', detail: '', xp: 2, gold: 2,
    ruleVersion: GAME_RULE_VERSION - 1, sourceDate: DAY, sourceUpdatedAt: T1,
  });
  const plan = buildGamePlan(makeHealth({ updatedAt: T2, daily: [{ date: DAY, steps: 12000 }] }), null, TODAY, makeProfile());
  settleCandidates(ledger, goldBox, plan.candidates);
  const row = ledger.get(`${DAY}|steps|`);
  check('old ruleVersion row: not recomputed, not re-awarded, source ref untouched',
    row?.xp === 2 && row?.gold === 2 && row?.sourceUpdatedAt === T1
    && planLedgerAction(row, plan.candidates.find((c) => c.category === 'steps')).kind === 'skip');
}

// ------------------------------------------------------------ mutation sensitivity
{
  const noGate = buildFns(serverSrc.replace(
    'const incomplete = health.coverageIncomplete;',
    'const incomplete = false;',
  ));
  const partial = makeHealth({ coverageIncomplete: true, daily: [{ date: DAY, steps: 2000 }] });
  check('mutation: removing the completeness gate makes the partial snapshot produce candidates',
    buildGamePlan(partial, null, TODAY, makeProfile()).candidates.length === 0
    && noGate.buildGamePlan(partial, null, TODAY, makeProfile()).candidates.length > 0);

  const lastWins = buildFns(serverSrc.replace(
    'if (inBed > bestInBed || (inBed === bestInBed && startKey < bestStartKey))',
    'if (inBed >= 0)',
  ));
  const sleeps = [sleepRow(DAY, '23:05', '06:05', 7), sleepRow(DAY, '13:00', '14:00', 1)];
  const realPlan = buildGamePlan(makeHealth({ sleeps }), null, TODAY, makeProfile());
  const mutatedPlan = lastWins.buildGamePlan(makeHealth({ sleeps }), null, TODAY, makeProfile());
  check('mutation: last-row-wins main-sleep selection flips the award to the nap (1 XP)',
    realPlan.candidates.find((c) => c.category === 'sleep')?.xp === 10
    && mutatedPlan.candidates.find((c) => c.category === 'sleep')?.xp === 1);

  const noRevise = buildFns(serverSrc.replace(
    'return { kind: "revise", goldDelta: candidate.gold - existing.gold };',
    'return { kind: "skip" };',
  ));
  const settleWith = (fns, ledger, goldBox, candidates) => {
    for (const candidate of candidates) {
      const key = `${candidate.localDate}|${candidate.category}|${candidate.detail}`;
      const existing = ledger.get(key);
      const action = fns.planLedgerAction(existing, candidate);
      if (action.kind === 'insert') {
        ledger.set(key, { ...candidate, ruleVersion: fns.GAME_RULE_VERSION });
        goldBox.gold += candidate.gold;
      } else if (action.kind === 'revise') {
        existing.xp = candidate.xp;
        existing.gold = candidate.gold;
        existing.sourceUpdatedAt = candidate.sourceUpdatedAt;
        goldBox.gold += action.goldDelta;
      }
    }
  };
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const profile = makeProfile();
  settleWith(noRevise, ledger, goldBox, noRevise.buildGamePlan(makeHealth({ updatedAt: T1, daily: [{ date: DAY, steps: 2000 }] }), null, TODAY, profile).candidates);
  settleWith(noRevise, ledger, goldBox, noRevise.buildGamePlan(makeHealth({ updatedAt: T2, daily: [{ date: DAY, steps: 12000 }] }), null, TODAY, profile).candidates);
  check('mutation: disabling revision freezes steps at 2 (total 12, not 22)',
    totalXp(ledger) === 12 && rowXp(ledger, DAY, 'steps') === 2);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
