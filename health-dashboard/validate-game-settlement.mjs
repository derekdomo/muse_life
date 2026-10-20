// CWEB-SETTLE-001 (P0) + CWEB-SLEEP-001 (P1) + CWEB-PROFILE-SAFE-001
// (P0) validation, extended for the CWEB-SETTLE-001 PM follow-up round
// (insert-conflict re-read, immutable adoption boundary, same-instant
// format idempotency).
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
// The atomicity scenarios added for CWEB-PROFILE-SAFE-001 /
// CWEB-SETTLE-001 drive the REAL production pure functions
// (applyPurchase / applyAllocation / applyEquip / applyUnequip /
// parseGameProfile / compareSourceVersions), interleaved against an
// in-memory store that mirrors saveGameProfile's revision guard, and a
// reconciliation model that mirrors settleGame's gold arithmetic step
// for step (balance + watermark advance in one write; a failed write
// leaves both untouched).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
check('source: profile writes are revision-guarded compare-and-swap',
  serverSrc.includes('COALESCE(${schema.gameState.revision}, 0) = ${expectedRevision}')
  && serverSrc.includes('COALESCE(${schema.gameState.revision}, 0) + 1'));
check('source: no unconditional game_state upsert remains',
  !serverSrc.includes('onConflictDoUpdate({ target: schema.gameState.id'));
check('source: settlement reconciles gold against the persisted ledger watermark',
  serverSrc.includes('ledgerGoldSum - baseline') && serverSrc.includes('profile.goldLedgerSum = ledgerGoldSum'));
check('source: ledger row updates repeat the monotonic guard at write time',
  serverSrc.includes('sourceVersionSqlBefore(schema.gameSettlements.sourceUpdatedAt, candidateVersion)'));
check('source: write-time guard compares normalized instants (unixepoch subsec) with the lexicographic fallback, not raw strings',
  serverSrc.includes("unixepoch(${stored}, 'subsec')") && serverSrc.includes('ELSE ${stored} < ${candidate} END'));
check('source: ledger insert verifies the landed row via RETURNING and re-reads the winner on conflict',
  serverSrc.includes('.returning({ localDate: schema.gameSettlements.localDate })')
  && serverSrc.includes('const winnerRows = await db.select().from(schema.gameSettlements).where(key).limit(1);'));
check('source: baseline adoption reads the immutable migration boundary, not the live updatedAt',
  serverSrc.includes('const boundary = row.exists ? (row.goldAdoptionBoundary ?? row.updatedAt) : null;'));
check('source: compareSourceVersions returns 0 for equal parsed instants',
  serverSrc.includes('if (timeA === timeB) return 0;'));
const migration0012Src = readFileSync(new URL('./drizzle/0012_add_game_gold_adoption_boundary.sql', import.meta.url), 'utf8');
check('source: migration 0012 adds the adoption boundary and backfills it from updated_at for null-watermark rows',
  migration0012Src.includes('ADD COLUMN `gold_adoption_boundary`')
  && migration0012Src.includes('SET `gold_adoption_boundary` = `updated_at`')
  && migration0012Src.includes('`gold_ledger_sum` IS NULL'));
check('source: schema carries the adoption boundary column',
  readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8').includes('goldAdoptionBoundary: integer("gold_adoption_boundary"'));
check('source: planLedgerAction orders source versions monotonically',
  serverSrc.includes('compareSourceVersions(candidate.sourceUpdatedAt, existing.sourceUpdatedAt) <= 0'));
check('source: all four profile mutations route through the CAS retry helper',
  (serverSrc.match(/updateGameProfile\(ctx/g) ?? []).length >= 4);
check('source: daily-task booking is a single atomic insert (no select-then-insert claim check)',
  serverSrc.includes('async function bookLedgerRow(ctx: Ctx, candidate: GameCandidate): Promise<void>'));

const CONST_NAMES = [
  'GAME_RULE_VERSION', 'GAME_QUEST_TARGET_STEPS', 'GAME_QUEST_REWARD_XP',
  'GAME_STRENGTH_SESSION_XP', 'GAME_ATTR_XP_PCT_PER_POINT', 'GAME_ATTR_DOMAIN_CAP_PCT',
  'GAME_ATTRIBUTES', 'GAME_ATTRIBUTE_DOMAIN', 'GAME_EQUIPMENT', 'GAME_EQUIPMENT_BY_ID',
  'GAME_SLOT_LABELS',
];
const FN_NAMES = [
  'timeInBedHours', 'totalSleepHours', 'shiftDate', 'sleepStartOrderKey',
  'selectMainSleep', 'stepsXpFor', 'sleepXpFor', 'attrBonusPct', 'equippedDefs',
  'equipBonusPct', 'boostedXp', 'planLedgerAction', 'buildGamePlan',
  'defaultGameProfile', 'parseGameProfile', 'compareSourceVersions',
  'allocatedPoints', 'unspentPoints',
  'applyAllocation', 'applyPurchase', 'applyEquip', 'applyUnequip',
];
function buildFns(src) {
  const code = [
    ...CONST_NAMES.map((n) => extractConst(src, n)),
    ...FN_NAMES.map((n) => extractFunction(src, n)),
  ].join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { buildGamePlan, planLedgerAction, selectMainSleep, GAME_RULE_VERSION, GAME_EQUIPMENT_BY_ID, defaultGameProfile, parseGameProfile, compareSourceVersions, applyAllocation, applyPurchase, applyEquip, applyUnequip, unspentPoints };`)();
}
const { buildGamePlan, planLedgerAction, selectMainSleep, GAME_RULE_VERSION, GAME_EQUIPMENT_BY_ID, defaultGameProfile, parseGameProfile, compareSourceVersions, applyAllocation, applyPurchase, applyEquip, applyUnequip, unspentPoints } = buildFns(serverSrc);

// ------------------------------------------------------------ synthetic data
const T1 = '2026-10-15T15:00:00.000Z';
const T2 = '2026-10-16T15:00:00.000Z';
const T3 = '2026-10-17T15:00:00.000Z';
const TODAY = '2026-10-15';
const DAY = '2026-10-14';

function makeProfile() {
  return {
    gold: 0, goldInitialized: true, goldLedgerSum: null,
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

// ------------------------------------------------------------ monotonic source versions: older source never rolls back
{
  const ledger = new Map();
  const goldBox = { gold: 0 };
  const profile = makeProfile();
  // Settle the day from the NEWER source T2 first (12000 steps).
  settleCandidates(ledger, goldBox, buildGamePlan(makeHealth({ updatedAt: T2, daily: [{ date: DAY, steps: 12000 }] }), null, TODAY, profile).candidates);
  check('monotonic setup: T2 settles steps 12 + quest 10, gold 22, source ref T2',
    rowXp(ledger, DAY, 'steps') === 12 && goldBox.gold === 22
    && ledger.get(`${DAY}|steps|`)?.sourceUpdatedAt === T2);
  // A stale T1 read finishes late and re-opens: nothing may roll back.
  settleCandidates(ledger, goldBox, buildGamePlan(makeHealth({ updatedAt: T1, daily: [{ date: DAY, steps: 2000 }] }), null, TODAY, profile).candidates);
  const row = ledger.get(`${DAY}|steps|`);
  check('monotonic: older source T1 after T2 leaves xp, gold and the source reference untouched',
    row?.xp === 12 && row?.gold === 12 && row?.sourceUpdatedAt === T2 && goldBox.gold === 22);
  check('planLedgerAction: older source with a different value skips',
    planLedgerAction(row, { localDate: DAY, category: 'steps', detail: '', xp: 2, gold: 2, sourceDate: DAY, sourceUpdatedAt: T1 }).kind === 'skip');
  check('planLedgerAction: older source with the same value skips (reference never refreshed backward)',
    planLedgerAction(row, { localDate: DAY, category: 'steps', detail: '', xp: 12, gold: 12, sourceDate: DAY, sourceUpdatedAt: T1 }).kind === 'skip');
  check('planLedgerAction: unversioned (null) candidate never overwrites a versioned row',
    planLedgerAction(row, { localDate: DAY, category: 'steps', detail: '', xp: 99, gold: 99, sourceDate: DAY, sourceUpdatedAt: null }).kind === 'skip');
  const unversioned = { localDate: DAY, category: 'steps', detail: '', xp: 2, gold: 2, ruleVersion: GAME_RULE_VERSION, sourceDate: DAY, sourceUpdatedAt: null };
  check('planLedgerAction: versioned candidate supersedes an unversioned row (refresh on equal value, revise on change)',
    planLedgerAction(unversioned, { localDate: DAY, category: 'steps', detail: '', xp: 2, gold: 2, sourceDate: DAY, sourceUpdatedAt: T1 }).kind === 'refresh_source_ref'
    && planLedgerAction(unversioned, { localDate: DAY, category: 'steps', detail: '', xp: 5, gold: 5, sourceDate: DAY, sourceUpdatedAt: T1 }).kind === 'revise');
  check('compareSourceVersions: null is oldest, equal is 0, instants order',
    compareSourceVersions(null, T1) < 0 && compareSourceVersions(T1, null) > 0
    && compareSourceVersions(T2, T2) === 0 && compareSourceVersions(T1, T2) < 0 && compareSourceVersions(T3, T2) > 0);
}

// ------------------------------------------------------------ profile CAS: concurrent writes compose (CWEB-PROFILE-SAFE-001)
// In-memory store mirroring saveGameProfile: a save lands only when the
// expected revision still matches the stored one (stored null reads as
// 0); a landed save stores the draft and advances the revision by one.
// casUpdate mirrors updateGameProfile: read → apply on a draft → CAS,
// re-reading and re-applying on a miss, typed rejections write nothing.
function makeCasStore(profile) {
  return { revision: 0, profile };
}
function casSave(store, expectedRevision, draft) {
  if (store.revision !== expectedRevision) return false;
  store.profile = draft;
  store.revision = expectedRevision + 1;
  return true;
}
function casUpdate(store, apply) {
  for (let i = 0; i < 5; i++) {
    const expected = store.revision;
    const draft = structuredClone(store.profile);
    const result = apply(draft);
    if (!result.ok) return result;
    if (casSave(store, expected, draft)) return { ok: true, profile: draft };
  }
  return { ok: false, message: 'busy' };
}
const swordDef = GAME_EQUIPMENT_BY_ID.get('iron_sword');
const armorDef = GAME_EQUIPMENT_BY_ID.get('leather_armor');
{
  // The PM repro interleave: settlement pass A reads the profile (gold
  // 1000, revision 0) and pauses; purchase B lands (gold 700, owns the
  // sword, revision 1); A resumes. The old unconditional upsert restored
  // gold 1000 and un-owned the sword; the CAS guard must reject A's
  // stale write, and A's retry must keep B's purchase AND A's own delta.
  const store = makeCasStore({ ...makeProfile(), gold: 1000 });
  const aExpected = store.revision;
  const aDraft = structuredClone(store.profile);
  aDraft.gold += 10; // the settlement credit A intends to persist
  const bought = casUpdate(store, (p) => applyPurchase(p, swordDef));
  check('read×buy: purchase lands first (gold 1000 -> 700, sword owned, success re-readable)',
    bought.ok === true && store.profile.gold === 700 && store.profile.owned.includes('iron_sword') && store.revision === 1);
  check('read×buy: the stale settlement write is rejected by the revision guard, purchase intact',
    casSave(store, aExpected, aDraft) === false && store.profile.gold === 700 && store.profile.owned.includes('iron_sword'));
  const retried = casUpdate(store, (p) => { p.gold += 10; return { ok: true }; });
  check('read×buy: retrying on the latest profile composes (gold 710, sword still owned)',
    retried.ok === true && store.profile.gold === 710 && store.profile.owned.includes('iron_sword') && store.revision === 2);
}
{
  // Write×write: an allocation and a purchase prepared against the same
  // revision — exactly one lands first, the other retries on top; the
  // final state equals the serial composition of both.
  const store = makeCasStore({ ...makeProfile(), gold: 1000, attrPointsEarned: 3 });
  const allocDraft = structuredClone(store.profile);
  check('write×write setup: allocation applies cleanly on its draft',
    applyAllocation(allocDraft, 'strength', 2).ok === true);
  const bought = casUpdate(store, (p) => applyPurchase(p, swordDef));
  check('write×write: the first writer to CAS wins; the prepared draft of the other is stale',
    bought.ok === true && casSave(store, 0, allocDraft) === false);
  const allocated = casUpdate(store, (p) => applyAllocation(p, 'strength', 2));
  check('write×write: retried allocation composes with the purchase (gold 700, 力量 2, 1 point left, sword owned)',
    allocated.ok === true && store.profile.gold === 700 && store.profile.attributes.strength === 2
    && unspentPoints(store.profile) === 1 && store.profile.owned.includes('iron_sword'));
}
{
  // Two different purchases in flight: both must land, each charged once.
  const store = makeCasStore({ ...makeProfile(), gold: 1000 });
  const armorDraft = structuredClone(store.profile);
  applyPurchase(armorDraft, armorDef);
  casUpdate(store, (p) => applyPurchase(p, swordDef));
  check('write×write (buy×buy): stale armor draft rejected',
    casSave(store, 0, armorDraft) === false && store.profile.gold === 700);
  const armorBought = casUpdate(store, (p) => applyPurchase(p, armorDef));
  check('write×write (buy×buy): retry buys the armor on the latest balance (gold 450, both owned)',
    armorBought.ok === true && store.profile.gold === 450
    && store.profile.owned.includes('iron_sword') && store.profile.owned.includes('leather_armor'));
}
{
  // Duplicate purchase of the same item: typed rejection, zero writes,
  // charged exactly once in total.
  const store = makeCasStore({ ...makeProfile(), gold: 1000 });
  casUpdate(store, (p) => applyPurchase(p, swordDef));
  const revisionAfterBuy = store.revision;
  const duplicate = casUpdate(store, (p) => applyPurchase(p, swordDef));
  check('duplicate purchase: rejected as already owned, no write, gold charged exactly once (700)',
    duplicate.ok === false && duplicate.message.includes('已经拥有')
    && store.profile.gold === 700 && store.revision === revisionAfterBuy);
  // A concurrent duplicate prepared before the first buy landed also
  // resolves to the same typed rejection on retry (serial-equivalent).
  const racing = makeCasStore({ ...makeProfile(), gold: 1000 });
  const staleDraft = structuredClone(racing.profile);
  applyPurchase(staleDraft, swordDef);
  casUpdate(racing, (p) => applyPurchase(p, swordDef));
  const resolved = casSave(racing, 0, staleDraft) === false
    ? casUpdate(racing, (p) => applyPurchase(p, swordDef))
    : { ok: true };
  check('duplicate purchase under race: retry sees the item owned and rejects; total charge stays 300',
    resolved.ok === false && racing.profile.gold === 700 && racing.profile.owned.filter((id) => id === 'iron_sword').length === 1);
}
{
  // Insufficient gold: typed rejection with ZERO writes (revision and
  // balance untouched, nothing owned).
  const store = makeCasStore({ ...makeProfile(), gold: 100 });
  const poor = casUpdate(store, (p) => applyPurchase(p, swordDef));
  check('insufficient gold: typed rejection, zero writes (revision 0, gold 100, owned empty)',
    poor.ok === false && poor.message.includes('金币不足')
    && store.revision === 0 && store.profile.gold === 100 && store.profile.owned.length === 0);
  // Allocation beyond unspent points likewise writes nothing.
  const noPoints = casUpdate(store, (p) => applyAllocation(p, 'strength', 1));
  check('allocation with no unspent points: typed rejection, zero writes',
    noPoints.ok === false && noPoints.message.includes('未分配点数不足') && store.revision === 0);
}
{
  // Equip / unequip round-trip through the CAS path, and equipping an
  // unowned item rejects without a write.
  const store = makeCasStore({ ...makeProfile(), gold: 1000 });
  const unowned = casUpdate(store, (p) => applyEquip(p, swordDef));
  check('equip unowned item: typed rejection, zero writes',
    unowned.ok === false && unowned.message.includes('尚未拥有') && store.revision === 0);
  casUpdate(store, (p) => applyPurchase(p, swordDef));
  const equipped = casUpdate(store, (p) => applyEquip(p, swordDef));
  const unequipped = casUpdate(store, (p) => applyUnequip(p, 'weapon'));
  check('equip then unequip: slot reflects each persisted write',
    equipped.ok === true && unequipped.ok === true && store.profile.equipped.weapon === null && store.profile.owned.includes('iron_sword'));
  const emptyUnequip = casUpdate(store, (p) => applyUnequip(p, 'armor'));
  check('unequip an empty slot: typed rejection',
    emptyUnequip.ok === false && emptyUnequip.message.includes('本来就是空的'));
}
{
  // Stored-row parsing: the watermark round-trips, and a pre-watermark
  // row (no gold_ledger_sum field at all) reads as null so settleGame
  // takes the baseline-adoption path for it.
  const parsed = parseGameProfile({
    gold: 700, goldInitialized: 1, goldLedgerSum: 1234,
    attrsJson: JSON.stringify({ strength: 2 }), attrPointsEarned: 3,
    equipmentJson: JSON.stringify({ owned: ['iron_sword'], equipped: { weapon: 'iron_sword', armor: null, accessory: null } }),
  });
  check('parseGameProfile: gold, watermark, attributes and equipment survive the stored row',
    parsed.gold === 700 && parsed.goldLedgerSum === 1234 && parsed.attributes.strength === 2
    && parsed.owned.includes('iron_sword') && parsed.equipped.weapon === 'iron_sword');
  const legacy = parseGameProfile({ gold: 5, goldInitialized: 1, attrsJson: null, attrPointsEarned: 0, equipmentJson: null });
  check('parseGameProfile: pre-watermark row reads goldLedgerSum as null (baseline adoption)',
    legacy.gold === 5 && legacy.goldLedgerSum === null && defaultGameProfile().goldLedgerSum === null);
}

// ------------------------------------------------------------ gold reconciliation: failure-safe settlement (CWEB-SETTLE-001)
// Mirrors settleGame's gold arithmetic exactly: baseline = the stored
// watermark when present, else the gold of rows booked at or before the
// profile's last successful save (updatedAt); the new balance is
// max(0, balance + ledgerGoldSum − baseline); balance and watermark
// persist in ONE write — failSave leaves both untouched while the
// booked rows stay in the ledger.
function reconcileSettle(state, bookedRows, { failSave = false } = {}) {
  for (const row of bookedRows) state.ledger.set(row.key, row);
  const ledgerGoldSum = [...state.ledger.values()].reduce((sum, row) => sum + row.gold, 0);
  const baseline = state.profile.goldLedgerSum !== null
    ? state.profile.goldLedgerSum
    : [...state.ledger.values()].filter((row) => row.createdAt <= state.profile.updatedAt).reduce((sum, row) => sum + row.gold, 0);
  if (failSave) return false;
  state.profile.gold = Math.max(0, state.profile.gold + (ledgerGoldSum - baseline));
  state.profile.goldLedgerSum = ledgerGoldSum;
  state.profile.updatedAt = T3;
  return true;
}
{
  // Injected failure AFTER the ledger row booked: the row persists,
  // the balance does not move; the retry (row already booked, so the
  // ledger pass is a no-op) credits exactly the stranded gold, once.
  const state = { ledger: new Map(), profile: { gold: 0, goldLedgerSum: 0, updatedAt: T1 } };
  const booked = reconcileSettle(state, [{ key: `${DAY}|steps|`, gold: 10, createdAt: T2 }], { failSave: true });
  check('save failure after booking: write reports failure, ledger keeps the row, balance unmoved (the old leak state)',
    booked === false && state.ledger.size === 1 && state.profile.gold === 0 && state.profile.goldLedgerSum === 0);
  reconcileSettle(state, []);
  check('retry after the failed save: balance reconciles to the ledger (gold 10, watermark 10)',
    state.profile.gold === 10 && state.profile.goldLedgerSum === 10);
  reconcileSettle(state, []);
  check('second retry: no double mint (gold stays 10)',
    state.profile.gold === 10);
}
{
  // The PM's literal stranded state, produced by the PRE-fix code:
  // ledger gold 10 booked after the profile's last successful save,
  // balance 0, no watermark yet. The first post-fix settlement must
  // recover it (baseline adoption only covers rows booked at or before
  // that last save).
  const state = {
    ledger: new Map([[`${DAY}|steps|`, { key: `${DAY}|steps|`, gold: 10, createdAt: T2 }]]),
    profile: { gold: 0, goldLedgerSum: null, updatedAt: T1 },
  };
  reconcileSettle(state, []);
  check('pre-fix stranded gold: first post-fix settlement recovers it (balance 0 -> 10)',
    state.profile.gold === 10 && state.profile.goldLedgerSum === 10);
}
{
  // Baseline adoption must NOT re-mint history: rows booked before the
  // last save are already reflected in the balance (350 kept of 500
  // minted, 150 legitimately spent).
  const state = {
    ledger: new Map([[`${DAY}|steps|`, { key: `${DAY}|steps|`, gold: 500, createdAt: T1 }]]),
    profile: { gold: 350, goldLedgerSum: null, updatedAt: T2 },
  };
  reconcileSettle(state, []);
  check('baseline adoption: pre-watermark gold is adopted as accounted, not re-minted (gold stays 350)',
    state.profile.gold === 350 && state.profile.goldLedgerSum === 500);
  reconcileSettle(state, [{ key: `${TODAY}|steps|`, gold: 10, createdAt: T3 }]);
  check('after adoption: new bookings credit on top through the watermark (gold 360)',
    state.profile.gold === 360 && state.profile.goldLedgerSum === 510);
}
{
  // Daily-task double booking across two passes: the ledger PK keeps
  // one row and reconciliation pays its gold exactly once — the same
  // atomic claim caliber as the domain path.
  const state = { ledger: new Map(), profile: { gold: 0, goldLedgerSum: 0, updatedAt: T1 } };
  const taskRow = { key: `${TODAY}|daily_task|steps_10000`, gold: 40, createdAt: T2 };
  reconcileSettle(state, [taskRow]);
  reconcileSettle(state, [taskRow]);
  check('daily task booked by two passes: one ledger row, gold credited once (40)',
    state.ledger.size === 1 && state.profile.gold === 40);
}

// ------------------------------------------------------------ same-instant format variants (CWEB-SETTLE-001 item 3)
// PM repro: the same instant written `2026-10-02T01:00:00.000Z` and
// `2026-10-02T01:00:00Z` parses equal, but the old compareSourceVersions
// returned 1, so a same-version candidate re-priced a booked row
// (xp 5 -> 9). Equal instants are one version in both orders; strict
// sub-second order still resolves across formats; null stays oldest.
{
  const MS = '2026-10-02T01:00:00.000Z';
  const S = '2026-10-02T01:00:00Z';
  check('compareSourceVersions: same instant in millisecond vs second format is equal (0), both orders',
    compareSourceVersions(MS, S) === 0 && compareSourceVersions(S, MS) === 0);
  check('compareSourceVersions: sub-second strict order across formats, both directions',
    compareSourceVersions('2026-10-02T01:00:00.500Z', S) > 0 && compareSourceVersions(S, '2026-10-02T01:00:00.500Z') < 0
    && compareSourceVersions('2026-10-02T01:00:01.000Z', '2026-10-02T01:00:00.999Z') > 0
    && compareSourceVersions('2026-10-02T01:00:00.999Z', '2026-10-02T01:00:01.000Z') < 0);
  check('compareSourceVersions: null controls unchanged with format variants in play',
    compareSourceVersions(null, MS) < 0 && compareSourceVersions(MS, null) > 0 && compareSourceVersions(null, null) === 0);
  const bookedMs = { localDate: DAY, category: 'steps', detail: '', xp: 5, gold: 5, ruleVersion: GAME_RULE_VERSION, sourceDate: DAY, sourceUpdatedAt: MS };
  const bookedS = { ...bookedMs, sourceUpdatedAt: S };
  check('planLedgerAction: same-instant candidate in the other format skips even with a different value (no re-price), both stored formats',
    planLedgerAction(bookedMs, { localDate: DAY, category: 'steps', detail: '', xp: 9, gold: 9, sourceDate: DAY, sourceUpdatedAt: S }).kind === 'skip'
    && planLedgerAction(bookedS, { localDate: DAY, category: 'steps', detail: '', xp: 9, gold: 9, sourceDate: DAY, sourceUpdatedAt: MS }).kind === 'skip');
  // Model-level repeat open: the snapshot's updatedAt string changes
  // format but not instant — nothing re-prices, nothing double-mints.
  const ledger = new Map();
  const goldBox = { gold: 0 };
  settleCandidates(ledger, goldBox, buildGamePlan(makeHealth({ updatedAt: MS, daily: [{ date: DAY, steps: 5000 }] }), null, TODAY, makeProfile()).candidates);
  settleCandidates(ledger, goldBox, buildGamePlan(makeHealth({ updatedAt: S, daily: [{ date: DAY, steps: 6000 }] }), null, TODAY, makeProfile()).candidates);
  check('same-instant re-open in the other format: steps row stays 5 (not re-priced to 6), gold stays 5 (no double mint)',
    rowXp(ledger, DAY, 'steps') === 5 && goldBox.gold === 5);
  const noEqualInstant = buildFns(serverSrc.replace('if (timeA === timeB) return 0;', ''));
  check('mutation: dropping the equal-instant return restores the format bug (compares 1, not 0)',
    noEqualInstant.compareSourceVersions(MS, S) === 1 && compareSourceVersions(MS, S) === 0);
}

// ------------------------------------------------------------ adoption boundary model (CWEB-SETTLE-001 item 2, arithmetic)
// Same reconciliation shape as reconcileSettle above, but the baseline
// adoption reads the IMMUTABLE boundary (the profile's last successful
// save as captured by migration 0012) instead of the live updatedAt:
// a purchase landing between the failed save and the retry advances
// updatedAt and spends gold, yet cannot absorb the stranded row into
// the baseline. Run against the old updatedAt adoption (reconcileSettle
// itself), the identical interleave reproduces PM's lost 5 (700, not
// 705) — the sensitivity control for this section.
function reconcileBoundary(state, bookedRows, { failSave = false } = {}) {
  for (const row of bookedRows) state.ledger.set(row.key, row);
  const ledgerGoldSum = [...state.ledger.values()].reduce((sum, row) => sum + row.gold, 0);
  const baseline = state.profile.goldLedgerSum !== null
    ? state.profile.goldLedgerSum
    : [...state.ledger.values()].filter((row) => row.createdAt <= state.profile.boundary).reduce((sum, row) => sum + row.gold, 0);
  if (failSave) return false;
  state.profile.gold = Math.max(0, state.profile.gold + (ledgerGoldSum - baseline));
  state.profile.goldLedgerSum = ledgerGoldSum;
  return true;
}
{
  const state = { ledger: new Map(), profile: { gold: 1000, goldLedgerSum: null, boundary: T1, updatedAt: T1 } };
  const failed = reconcileBoundary(state, [{ key: `${DAY}|steps|`, gold: 5, createdAt: T2 }], { failSave: true });
  check('boundary model: failed save leaves balance and watermark untouched, ledger keeps the row',
    failed === false && state.profile.gold === 1000 && state.profile.goldLedgerSum === null && state.ledger.size === 1);
  // The purchase lands: 300 spent, updatedAt advances to T3 — the
  // boundary stays at T1 because no profile write can move it.
  state.profile.gold -= 300;
  state.profile.updatedAt = T3;
  reconcileBoundary(state, []);
  check('boundary model: purchase preserved and stranded 5 credited exactly once (1000 - 300 + 5 = 705)',
    state.profile.gold === 705 && state.profile.goldLedgerSum === 5);
  reconcileBoundary(state, []);
  check('boundary model: a further open credits nothing twice (705 stable)',
    state.profile.gold === 705);
  const legacy = { ledger: new Map(), profile: { gold: 1000, goldLedgerSum: null, updatedAt: T1 } };
  reconcileSettle(legacy, [{ key: `${DAY}|steps|`, gold: 5, createdAt: T2 }], { failSave: true });
  legacy.profile.gold = 700;
  legacy.profile.updatedAt = T3;
  reconcileSettle(legacy, []);
  check('sensitivity: the pre-fix updatedAt adoption absorbs the stranded row after the same purchase (700, not 705)',
    legacy.profile.gold === 700);
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

// ------------------------------------------------------------ real handlers on a controlled store (CWEB-SETTLE-001 follow-up)
// The sections above mirror settleGame's decision flow in memory. This
// section runs the PRODUCTION handlers themselves — settleLedgerRow,
// settleGame, updateGameProfile and their callees, extracted verbatim
// from server/src/actions.ts — against a real in-memory SQLite database
// built by applying this artifact's own migrations in order, with the
// production schema evaluated from server/src/schema.ts. Concurrency
// interleaves are controlled at the db seam: a gated insert/update
// parks one settlement between its read and its write while a second
// completes, and a failing game_state save is injected the same way —
// the shapes PM reproduced against the handlers, not pure-function
// stand-ins.
function findBodyStart(source, closeParen) {
  let angle = 0, paren = 0, bracket = 0;
  for (let i = closeParen + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '=' && source[i + 1] === '>') { i++; continue; }
    if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '{' && angle === 0 && paren === 0 && bracket === 0) {
      let prev = i - 1;
      while (prev > closeParen && /\s/.test(source[prev])) prev--;
      if (source[prev] === ':') { i = matchDelim(source, i, '{', '}'); continue; }
      return i;
    }
  }
  throw new Error('handler body not found');
}
function extractHandlerFunction(source, name) {
  const match = new RegExp(`(async )?function ${name}\\(`).exec(source);
  if (!match) throw new Error(`handler function ${name} not found`);
  const openParen = source.indexOf('(', match.index);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = findBodyStart(source, closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(match.index, bodyEnd + 1);
}

async function loadHarnessDeps() {
  try {
    return {
      orm: await import('drizzle-orm'),
      libsql: await import('drizzle-orm/libsql'),
      client: await import('@libsql/client'),
      core: await import('drizzle-orm/sqlite-core'),
    };
  } catch { /* not resolvable from here — fall back to the sibling artifact's install */ }
  // The repo copy of this script has no node_modules of its own; the
  // artifact it validates (ts-spaces/space-4, the same root the other
  // health-dashboard suites resolve) carries the drizzle/libsql
  // install. Anchor a require there so both copies run the full
  // handler section.
  const artifactPkg = new URL('../../../ts-spaces/space-4/package.json', import.meta.url);
  if (!existsSync(artifactPkg)) throw new Error('drizzle-orm / @libsql/client are not resolvable from this location');
  const { createRequire } = await import('node:module');
  const req = createRequire(artifactPkg);
  return { orm: req('drizzle-orm'), libsql: req('drizzle-orm/libsql'), client: req('@libsql/client'), core: req('drizzle-orm/sqlite-core') };
}

async function buildHandlerHarness() {
  const deps = await loadHarnessDeps();
  const { eq, and, sql, desc, asc, lte } = deps.orm;
  const { drizzle } = deps.libsql;
  const { createClient } = deps.client;
  const core = deps.core;
  const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
  const schemaCode = schemaSrc.replace(/^import[^;]+;/m, '').replace(/export const /g, 'const ');
  const schema = new Function('sqliteTable', 'integer', 'text', 'real', 'primaryKey',
    `${stripTypeScriptTypes(schemaCode)}\nreturn { healthSnapshot, strengthTrainingSnapshot, morningCheckin, readinessHistory, gameState, gameSettlements, syncLog };`)
    (core.sqliteTable, core.integer, core.text, core.real, core.primaryKey);
  const constNames = [...CONST_NAMES, 'GAME_XP_PER_LEVEL', 'GAME_POINTS_PER_LEVEL', 'GAME_DAILY_TASKS', 'PROFILE_CAS_ATTEMPTS'];
  const fnNames = [
    'timeInBedHours', 'totalSleepHours', 'shiftDate', 'sleepStartOrderKey',
    'selectMainSleep', 'stepsXpFor', 'sleepXpFor', 'attrBonusPct', 'equippedDefs',
    'equipBonusPct', 'boostedXp', 'compareSourceVersions', 'sourceVersionSqlBefore',
    'planLedgerAction', 'buildGamePlan', 'defaultGameProfile', 'parseGameProfile',
    'allocatedPoints', 'unspentPoints', 'applyAllocation', 'applyPurchase',
    'applyEquip', 'applyUnequip', 'loadGameStateRow', 'saveGameProfile',
    'updateGameProfile', 'bookLedgerRow', 'settleLedgerRow', 'evaluateDailyTasks',
    'settleGame',
  ];
  const code = [
    ...constNames.map((n) => extractConst(serverSrc, n)),
    ...fnNames.map((n) => extractHandlerFunction(serverSrc, n)),
  ].join('\n');
  const fns = new Function('schema', 'eq', 'and', 'sql', 'desc', 'asc', 'lte',
    `${stripTypeScriptTypes(code)}\nreturn { settleLedgerRow, settleGame, updateGameProfile, loadGameStateRow, applyPurchase, applyAllocation, applyEquip, applyUnequip, GAME_EQUIPMENT_BY_ID, GAME_RULE_VERSION };`)
    (schema, eq, and, sql, desc, asc, lte);
  const migrationFiles = readdirSync(new URL('./drizzle/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  async function makeDb(migrationCount) {
    const client = createClient({ url: ':memory:' });
    for (const file of migrationFiles.slice(0, migrationCount)) {
      await client.executeMultiple(readFileSync(new URL(`./drizzle/${file}`, import.meta.url), 'utf8'));
    }
    return { client, db: drizzle(client) };
  }
  return { ...fns, schema, makeDb, migrationFiles };
}

function wrapDb(db, hooks) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'insert' && hooks.insert) return hooks.insert((table) => target.insert(table));
      if (prop === 'update' && hooks.update) return hooks.update((table) => target.update(table));
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
// Park the first game_settlements INSERT between the handler's read and
// its write: the parked call signals, then executes the real insert
// only once released — the losing side of the first-insert race.
function parkFirstLedgerInsert(db, schema) {
  let release = () => {};
  let signalParked = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const parked = new Promise((resolve) => { signalParked = resolve; });
  let used = false;
  const wrapped = wrapDb(db, {
    insert: (realInsert) => (table) => {
      if (used || table !== schema.gameSettlements) return realInsert(table);
      const builder = realInsert(table);
      return {
        values: (values) => ({
          onConflictDoNothing: () => ({
            returning: (cols) => ({
              then: (onFulfilled, onRejected) => {
                used = true;
                signalParked();
                return gate.then(() => builder.values(values).onConflictDoNothing().returning(cols)).then(onFulfilled, onRejected);
              },
            }),
          }),
        }),
      };
    },
  });
  return { db: wrapped, parked, release: () => release() };
}
// Same parking seam for the first game_settlements UPDATE (the
// write-time guard race).
function parkFirstLedgerUpdate(db, schema) {
  let release = () => {};
  let signalParked = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const parked = new Promise((resolve) => { signalParked = resolve; });
  let used = false;
  const wrapped = wrapDb(db, {
    update: (realUpdate) => (table) => {
      if (used || table !== schema.gameSettlements) return realUpdate(table);
      const builder = realUpdate(table);
      return {
        set: (values) => ({
          where: (cond) => ({
            then: (onFulfilled, onRejected) => {
              used = true;
              signalParked();
              return gate.then(() => builder.set(values).where(cond)).then(onFulfilled, onRejected);
            },
          }),
        }),
      };
    },
  });
  return { db: wrapped, parked, release: () => release() };
}
// Every game_state UPDATE throws: a profile save that fails after the
// ledger rows were booked (PM's injected failure).
function failProfileSaves(db, schema) {
  return wrapDb(db, {
    update: (realUpdate) => (table) => {
      if (table !== schema.gameState) return realUpdate(table);
      return { set: () => ({ where: () => ({ returning: () => { throw new Error('injected profile save failure'); } }) }) };
    },
  });
}

let H = null;
let harnessError = null;
try {
  H = await buildHandlerHarness();
} catch (error) {
  harnessError = error;
}
check('handler harness: production settleLedgerRow/settleGame/updateGameProfile extracted and bound to a controlled store',
  H !== null, harnessError ? String(harnessError?.message ?? harnessError) : '');

if (H) {
  const ctxFor = (db) => ({ db: () => db });
  const EARLY = new Date('2026-09-01T00:00:00.000Z');
  const HEALTH_5000 = {
    dataDate: '2026-10-01', updatedAt: '2026-10-02T01:00:00.000Z', coverageIncomplete: false,
    morningReference: { date: '2026-10-02', hrvMs: null, avgHrBpm: null },
    historyDaily: [{ date: '2026-10-01', steps: 5000 }],
    historySleeps: [],
  };
  const swordDef = H.GAME_EQUIPMENT_BY_ID.get('iron_sword');
  async function scenario(name, fn) {
    try { await fn(); }
    catch (error) { check(`handler scenario ${name}: runs to completion`, false, error instanceof Error ? error.message : String(error)); }
  }
  async function waitParked(parked, label) {
    await Promise.race([
      parked,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} never parked`)), 5000)),
    ]);
  }
  // Raw-SQL seed (parameterized): the evaluated schema always carries
  // the 0012 column, but a store built through migration 0011 does not
  // have it yet — the seed must be able to write the pre-0012 row shape
  // exactly, so it names its columns explicitly instead of going
  // through the (newer) drizzle table definition.
  async function seedGameState(client, overrides = {}) {
    const values = {
      id: 1, totalXp: 0, settledThroughDate: null, gold: 0, goldInitialized: 1, goldLedgerSum: 0,
      attrsJson: JSON.stringify({ strength: 0, endurance: 0, spirit: 0, stamina: 0 }),
      attrPointsEarned: 0,
      equipmentJson: JSON.stringify({ owned: [], equipped: { weapon: null, armor: null, accessory: null } }),
      revision: 1, createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    };
    await client.execute({
      sql: 'INSERT INTO game_state (id, total_xp, settled_through_date, gold, gold_initialized, attrs_json, attr_points_earned, equipment_json, revision, gold_ledger_sum, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [values.id, values.totalXp, values.settledThroughDate, values.gold, values.goldInitialized, values.attrsJson, values.attrPointsEarned, values.equipmentJson, values.revision, values.goldLedgerSum, values.createdAt.getTime(), values.updatedAt.getTime()],
    });
  }
  async function ledgerFind(db, date, category, detail = '') {
    const rows = await db.select().from(H.schema.gameSettlements);
    return rows.find((row) => row.localDate === date && row.category === category && row.detail === detail);
  }
  async function seedLedgerRow(db, values) {
    await db.insert(H.schema.gameSettlements).values({
      localDate: '2026-10-01', category: 'steps', detail: '', xp: 5, gold: 5,
      ruleVersion: H.GAME_RULE_VERSION, sourceDate: '2026-10-01',
      sourceUpdatedAt: '2026-10-02T01:00:00.000Z', createdAt: new Date(),
      ...values,
    });
  }

  // ---- item 1: first-insert conflict, both completion orders
  await scenario('insert race, older completes first', async () => {
    const { client, db } = await H.makeDb(12);
    await seedGameState(client, { gold: 0, goldLedgerSum: 0 });
    const gate = parkFirstLedgerInsert(db, H.schema);
    const candNew = { localDate: '2026-10-01', category: 'steps', detail: '', xp: 10, gold: 10, sourceDate: '2026-10-01', sourceUpdatedAt: '2026-10-02T02:00:00Z' };
    const candOld = { ...candNew, xp: 5, gold: 5, sourceUpdatedAt: '2026-10-02T01:00:00Z' };
    // The newer candidate reads the key as missing and parks at its
    // insert; the older candidate then inserts and completes; the
    // newer resumes into the conflict.
    const pending = H.settleLedgerRow(ctxFor(gate.db), candNew);
    await waitParked(gate.parked, 'newer insert');
    await H.settleLedgerRow(ctxFor(db), candOld);
    gate.release();
    await pending;
    const row = await ledgerFind(db, '2026-10-01', 'steps');
    check('handler insert race (newer reads first, older inserts first): re-read keeps the newer source T2 (xp/gold 10)',
      row?.xp === 10 && row?.gold === 10 && row?.sourceUpdatedAt === '2026-10-02T02:00:00Z');
    const settled = await H.settleGame(ctxFor(db), null, null, '2026-10-02');
    check('handler insert race: balance and watermark reconcile to the ledger SUM (gold 10, watermark 10)',
      settled.profile.gold === 10 && settled.profile.goldLedgerSum === 10);
  });
  await scenario('insert order, newer completes first', async () => {
    const { client, db } = await H.makeDb(12);
    await seedGameState(client, { gold: 0, goldLedgerSum: 0 });
    const candNew = { localDate: '2026-10-01', category: 'steps', detail: '', xp: 10, gold: 10, sourceDate: '2026-10-01', sourceUpdatedAt: '2026-10-02T02:00:00Z' };
    const candOld = { ...candNew, xp: 5, gold: 5, sourceUpdatedAt: '2026-10-02T01:00:00Z' };
    await H.settleLedgerRow(ctxFor(db), candNew);
    await H.settleLedgerRow(ctxFor(db), candOld);
    const row = await ledgerFind(db, '2026-10-01', 'steps');
    check('handler insert order (newer first): the older T1 candidate is rejected, row stays T2 (xp/gold 10)',
      row?.xp === 10 && row?.gold === 10 && row?.sourceUpdatedAt === '2026-10-02T02:00:00Z');
    const first = await H.settleGame(ctxFor(db), null, null, '2026-10-02');
    const second = await H.settleGame(ctxFor(db), null, null, '2026-10-02');
    check('handler insert order: same-version repeats never double-mint (gold 10 after both opens, watermark 10)',
      first.profile.gold === 10 && second.profile.gold === 10 && second.profile.goldLedgerSum === 10);
  });

  // ---- item 3: same-instant format variants through the real handler
  await scenario('same-instant format variants', async () => {
    for (const [storedFmt, candFmt] of [['2026-10-02T01:00:00.000Z', '2026-10-02T01:00:00Z'], ['2026-10-02T01:00:00Z', '2026-10-02T01:00:00.000Z']]) {
      const { db } = await H.makeDb(12);
      await seedLedgerRow(db, { xp: 5, gold: 5, sourceUpdatedAt: storedFmt });
      await H.settleLedgerRow(ctxFor(db), { localDate: '2026-10-01', category: 'steps', detail: '', xp: 9, gold: 9, sourceDate: '2026-10-01', sourceUpdatedAt: candFmt });
      const row = await ledgerFind(db, '2026-10-01', 'steps');
      check(`handler same-instant (stored ${storedFmt.includes('.000') ? 'millis' : 'seconds'}, candidate ${candFmt.includes('.000') ? 'millis' : 'seconds'}): no re-price, row stays xp 5 with its original source string`,
        row?.xp === 5 && row?.gold === 5 && row?.sourceUpdatedAt === storedFmt);
    }
  });
  await scenario('write-time guard race at an equal instant', async () => {
    const { db } = await H.makeDb(12);
    await seedLedgerRow(db, { xp: 3, gold: 3, sourceUpdatedAt: '2026-10-02T00:00:00.000Z' });
    const gate = parkFirstLedgerUpdate(db, H.schema);
    // Candidate in the seconds format plans a revise against the older
    // row and parks at its UPDATE; a concurrent writer moves the row
    // to the candidate's own instant in the millisecond format (xp 7).
    const pending = H.settleLedgerRow(ctxFor(gate.db), { localDate: '2026-10-01', category: 'steps', detail: '', xp: 9, gold: 9, sourceDate: '2026-10-01', sourceUpdatedAt: '2026-10-02T01:00:00Z' });
    await waitParked(gate.parked, 'guarded update');
    await db.update(H.schema.gameSettlements).set({ xp: 7, gold: 7, sourceUpdatedAt: '2026-10-02T01:00:00.000Z' });
    gate.release();
    await pending;
    const row = await ledgerFind(db, '2026-10-01', 'steps');
    check('handler write-time guard: an equal instant in the other format blocks the parked revise (row stays xp 7)',
      row?.xp === 7 && row?.gold === 7 && row?.sourceUpdatedAt === '2026-10-02T01:00:00.000Z');
  });
  await scenario('write-time guard admits a sub-second revision', async () => {
    const { db } = await H.makeDb(12);
    await seedLedgerRow(db, { xp: 5, gold: 5, sourceUpdatedAt: '2026-10-02T01:00:00Z' });
    await H.settleLedgerRow(ctxFor(db), { localDate: '2026-10-01', category: 'steps', detail: '', xp: 9, gold: 9, sourceDate: '2026-10-01', sourceUpdatedAt: '2026-10-02T01:00:00.500Z' });
    const row = await ledgerFind(db, '2026-10-01', 'steps');
    check('handler write-time guard: candidate 500ms newer across formats revises (xp 5 -> 9); a raw string guard would have blocked it',
      row?.xp === 9 && row?.gold === 9 && row?.sourceUpdatedAt === '2026-10-02T01:00:00.500Z');
  });

  // ---- item 2: legacy null-watermark profile, failed settle x four
  // profile mutations x two orders, through the real handlers. The DB
  // is built through migration 0011, the legacy row is inserted in its
  // pre-0012 shape, and migration 0012 is applied on top — the exact
  // production upgrade path.
  async function legacyInterleave(label, seedOverrides, mutate, expectedGold, mutationKept) {
    for (const order of ['settle-fail-first', 'mutate-first']) {
      await scenario(`${label} (${order})`, async () => {
        const { client, db } = await H.makeDb(11);
        await seedGameState(client, {
          gold: 1000, goldInitialized: 1, goldLedgerSum: null,
          createdAt: EARLY, updatedAt: EARLY, ...seedOverrides,
        });
        await client.executeMultiple(readFileSync(new URL(`./drizzle/${H.migrationFiles[11]}`, import.meta.url), 'utf8'));
        const ctx = ctxFor(db);
        const stamped = await H.loadGameStateRow(ctx);
        check(`legacy ${label} (${order}): migration 0012 stamps the adoption boundary at the last pre-migration save`,
          stamped.goldAdoptionBoundary?.getTime() === EARLY.getTime());
        const runMutation = async () => {
          const result = await mutate(ctx);
          check(`legacy ${label} (${order}): profile mutation accepted`, result.ok === true);
        };
        const settleExpectFail = async () => {
          const before = await H.loadGameStateRow(ctx);
          let threw = false;
          try { await H.settleGame(ctxFor(failProfileSaves(db, H.schema)), HEALTH_5000, null, '2026-10-02'); }
          catch { threw = true; }
          const afterFail = await H.loadGameStateRow(ctx);
          const booked = await ledgerFind(db, '2026-10-01', 'steps');
          check(`legacy ${label} (${order}): injected save failure books the ledger row (gold 5) but leaves balance and watermark untouched`,
            threw && booked?.gold === 5 && afterFail.profile.gold === before.profile.gold && afterFail.profile.goldLedgerSum === null);
        };
        if (order === 'settle-fail-first') {
          await settleExpectFail();
          await runMutation();
        } else {
          await runMutation();
          const moved = await H.loadGameStateRow(ctx);
          check(`legacy ${label} (${order}): the profile write advances updatedAt but cannot move the adoption boundary`,
            moved.updatedAt?.getTime() !== EARLY.getTime() && moved.goldAdoptionBoundary?.getTime() === EARLY.getTime());
          await settleExpectFail();
        }
        const settled = await H.settleGame(ctx, HEALTH_5000, null, '2026-10-02');
        const after = await H.loadGameStateRow(ctx);
        check(`legacy ${label} (${order}): retry credits the stranded 5 exactly once (gold ${expectedGold}, watermark = ledger SUM 5)`,
          settled.profile.gold === expectedGold && after.profile.gold === expectedGold && after.profile.goldLedgerSum === 5);
        check(`legacy ${label} (${order}): the profile change and its spent gold survive the retry`,
          mutationKept(after.profile));
        const again = await H.settleGame(ctx, HEALTH_5000, null, '2026-10-02');
        check(`legacy ${label} (${order}): a further open changes nothing (no double credit)`,
          again.profile.gold === expectedGold);
      });
    }
  }
  await legacyInterleave('purchase',
    {},
    (ctx) => H.updateGameProfile(ctx, (p) => H.applyPurchase(p, swordDef)),
    705,
    (profile) => profile.owned.includes('iron_sword'));
  await legacyInterleave('allocation',
    { attrPointsEarned: 3 },
    (ctx) => H.updateGameProfile(ctx, (p) => H.applyAllocation(p, 'strength', 1)),
    1005,
    (profile) => profile.attributes.strength === 1);
  await legacyInterleave('equip',
    { equipmentJson: JSON.stringify({ owned: ['iron_sword'], equipped: { weapon: null, armor: null, accessory: null } }) },
    (ctx) => H.updateGameProfile(ctx, (p) => H.applyEquip(p, swordDef)),
    1005,
    (profile) => profile.equipped.weapon === 'iron_sword');
  await legacyInterleave('unequip',
    { equipmentJson: JSON.stringify({ owned: ['iron_sword'], equipped: { weapon: 'iron_sword', armor: null, accessory: null } }) },
    (ctx) => H.updateGameProfile(ctx, (p) => H.applyUnequip(p, 'weapon')),
    1005,
    (profile) => profile.equipped.weapon === null && profile.owned.includes('iron_sword'));

  // ---- item 2 controls: first open without failure, and a profile
  // whose watermark is already non-null (behavior unchanged).
  await scenario('legacy first open without failure', async () => {
    const { client, db } = await H.makeDb(11);
    await seedGameState(client, { gold: 1000, goldInitialized: 1, goldLedgerSum: null, createdAt: EARLY, updatedAt: EARLY });
    await client.executeMultiple(readFileSync(new URL(`./drizzle/${H.migrationFiles[11]}`, import.meta.url), 'utf8'));
    const first = await H.settleGame(ctxFor(db), HEALTH_5000, null, '2026-10-02');
    const second = await H.settleGame(ctxFor(db), HEALTH_5000, null, '2026-10-02');
    check('legacy control: first open settles normally (gold 1005, watermark adopted to 5) and stays stable',
      first.profile.gold === 1005 && first.profile.goldLedgerSum === 5 && second.profile.gold === 1005);
  });
  await scenario('watermark non-null control', async () => {
    const { client, db } = await H.makeDb(12);
    await seedGameState(client, { gold: 1005, goldInitialized: 1, goldLedgerSum: 5 });
    await seedLedgerRow(db, { xp: 5, gold: 5, sourceUpdatedAt: '2026-10-02T01:00:00.000Z' });
    const settled = await H.settleGame(ctxFor(db), HEALTH_5000, null, '2026-10-02');
    check('watermark control: a non-null watermark profile is untouched by the boundary path (gold 1005, no re-mint)',
      settled.profile.gold === 1005 && settled.profile.goldLedgerSum === 5);
  });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
