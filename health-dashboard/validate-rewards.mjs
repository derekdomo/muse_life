// CWEB-MVP-001·S3 personal rewards validation, extended by
// CWEB-REDEEM-SAFE-001 (atomic redemption adjudication) and the S3
// 余项 (next-reward goal + balance three-state). Runs the REAL
// production handler cores (handleGetRewards /
// handleSaveReward / handleRedeemReward / handleGetRedemptionReceipt
// / handleSetRewardGoal
// and their callees — settleGame, saveGameProfile, loadGameStateRow,
// the ledger writers) extracted verbatim from server/src/actions.ts,
// against a real in-memory SQLite database built by applying this
// artifact's own migrations in order, with the production schema
// evaluated from server/src/schema.ts. Covers the S3 acceptance
// matrix: owner gate matrix (owner / guest / no viewer — the L0.1
// sync-channel exception must NOT open rewards), reward create/edit
// with revision increments, insufficient-funds zero-write rejection,
// stale price / stale reward revision / stale balance version
// rejections (zero writes), a successful atomic redemption (deduct +
// watermark + ledger flow + receipt snapshot in one batch), replay
// with the same requestId + same content returning the original
// receipt without a second charge, same-key different-content
// conflict, price edits never rewriting an old receipt, a second
// same-day redemption accumulating into one ledger flow row, missing
// sources keeping list + receipts readable, and a late source revision
// neither deleting the receipt nor re-pricing it (and never posing
// the redemption day as settled-through). The REDEEM-SAFE extension
// adds: failure injection at the batch and at each inner write point
// (only the fully old state or the same-key-recoverable committed
// state survives), a lost response after the commit landed, different-
// key concurrency (at most one success, exact balance), same-key
// concurrency (exactly one charge, one receipt), price AND balance
// changes landing after the final pre-read (old confirmation
// rejected, fresh preview charges the new values exactly), the
// receipt proving the actual deduction/watermark/flow, preservation
// of a seeded legacy half-completed state (never silently rewritten),
// and the goal matrix (gates, persistence across reopen, failed save
// keeps the previous goal, rename/reprice reads current values while
// old receipts keep snapshots, goal readable with sources missing).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

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
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
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

// ------------------------------------------------------------ source checks
check('source: schema carries the rewards + redemptions tables',
  schemaSrc.includes('export const gameRewards = sqliteTable("game_rewards"')
  && schemaSrc.includes('export const gameRewardRedemptions = sqliteTable("game_reward_redemptions"')
  && schemaSrc.includes('requestId: text("request_id").notNull().unique()'));
check('source: schema carries the additive next-reward goal preference (rewardId only)',
  schemaSrc.includes('export const gameRewardGoal = sqliteTable("game_reward_goal"'));
check('source: ledger category enum includes reward_redeem',
  schemaSrc.includes('"reward_redeem"') && serverSrc.includes('const gameCategorySchema = z.enum(["steps", "sleep", "strength", "quest_steps", "daily_task", "reward_redeem"])'));
const migration0013 = './drizzle/0013_add_game_rewards_and_redemptions.sql';
check('source: migration 0013 creates both tables and the unique request_id index',
  existsSync(new URL(migration0013, import.meta.url))
  && readFileSync(new URL(migration0013, import.meta.url), 'utf8').includes('CREATE TABLE `game_rewards`')
  && readFileSync(new URL(migration0013, import.meta.url), 'utf8').includes('CREATE TABLE `game_reward_redemptions`')
  && readFileSync(new URL(migration0013, import.meta.url), 'utf8').includes('CREATE UNIQUE INDEX `game_reward_redemptions_request_id_unique`'));
const migration0014 = './drizzle/0014_add_game_reward_goal.sql';
check('source: migration 0014 additively creates the goal table (no existing table touched)',
  existsSync(new URL(migration0014, import.meta.url))
  && readFileSync(new URL(migration0014, import.meta.url), 'utf8').includes('CREATE TABLE `game_reward_goal`')
  && !/ALTER TABLE|DROP TABLE|DELETE FROM/.test(readFileSync(new URL(migration0014, import.meta.url), 'utf8')));
check('source: redemption books its flow into the shared ledger (reward_redeem, detail = reward id, negative gold)',
  serverSrc.includes("'reward_redeem'") && serverSrc.includes('${String(freshReward.id)}') && serverSrc.includes('${-args.price}'));
check('source: settled-through MAX excludes reward_redeem rows',
  serverSrc.includes("<> 'reward_redeem' THEN"));
check('source: redeem handler checks the replay before any write and pins before settling',
  serverSrc.indexOf('const existing = await loadRedemptionByRequestId(ctx, args.requestId);') > 0
  && serverSrc.indexOf('const existing = await loadRedemptionByRequestId(ctx, args.requestId);') < serverSrc.indexOf('// (2) Pre-validation against stored state')
  && serverSrc.indexOf('// (2) Pre-validation against stored state') < serverSrc.indexOf('// (4) The redemption itself, as ONE atomic batch'));
check('source: the redemption commit is a single atomic batch (guarded receipt insert + chained CAS deduction + changes()-gated ledger flow)',
  serverSrc.includes('db.batch([receiptInsert, casDeduction, ledgerInsert])')
  && serverSrc.includes('const receiptInsert = db.insert(schema.gameRewardRedemptions).select(sql`')
  && serverSrc.includes('const ledgerInsert = db.insert(schema.gameSettlements).select(sql`')
  && serverSrc.includes('COALESCE(${schema.gameState.revision}, 0) = ${readRevision}')
  && serverSrc.includes('EXISTS (SELECT 1 FROM ${schema.gameRewards}')
  && serverSrc.includes('EXISTS (SELECT 1 FROM ${schema.gameRewardRedemptions} WHERE ${schema.gameRewardRedemptions.requestId} = ${args.requestId})')
  && serverSrc.includes('(SELECT changes()) > 0'));
check('source: the redeem handler never writes a receipt ahead of the deduction and never floors the balance',
  !extractHandlerFunction(serverSrc, 'handleRedeemReward').includes('onConflictDoNothing().returning({ id: schema.gameRewardRedemptions.id })')
  && !extractHandlerFunction(serverSrc, 'handleRedeemReward').includes('Math.max(0'));
check('source: reward actions are wired with the strict owner gate only (no sync-channel exception)',
  serverSrc.includes('handler: handleGetRewards') && serverSrc.includes('handler: handleRedeemReward')
  && serverSrc.includes('handler: handleSetRewardGoal')
  && !/handle(Redeem|Save)Reward[\s\S]{0,200}isOwnerOrSyncChannel/.test(serverSrc)
  && !/handleSetRewardGoal[\s\S]{0,200}isOwnerOrSyncChannel/.test(serverSrc));
check('source: client states the receipt-only proof and the no-purchase line',
  clientSrc.includes('兑换只记个人回执，不代购、不下单') && clientSrc.includes('只证明金币已兑换，不证明现实奖励已经享用'));
check('source: client carries the unconfirmed-result state resolved by the same requestId',
  clientSrc.includes('兑换结果未确认') && clientSrc.includes('用同一请求重试兑换') && clientSrc.includes('api.getRedemptionReceipt'));
check('source: client treats typed busy as unconfirmed (identity kept), never as a plain rejection',
  clientSrc.includes('result.status === "busy"') && clientSrc.includes('setStage({ kind: "unconfirmed", draft, lookupNote: result.message })'));
check('source: client persists the pending redemption identity across reopens and never re-keys it',
  clientSrc.includes('PENDING_REDEMPTION_KEY') && clientSrc.includes('loadPendingRedemption') && clientSrc.includes('storePendingRedemption(draft)') && clientSrc.includes('继续确认'));
check('source: a not-found lookup says 未确认 and never claims the gold did not move',
  clientSrc.includes('结果仍未确认') && !clientSrc.includes('它没有入账'));
check('source: client shows the shortfall as text, never color alone',
  clientSrc.includes('还差 ${numberLabel(shortfall)} 金币'));
check('source: client keeps the three balance states distinct (还差 N / 可兑换 / 余额暂不可核实) and pauses writes when unverified',
  clientSrc.includes('余额暂不可核实') && clientSrc.includes('✓ 可兑换') && clientSrc.includes('暂时不能发起兑换')
  && clientSrc.includes('const balanceVerified = !!data && data.ok'));
check('source: client offers 设为下一奖励 per reward, the character-screen goal strip, and the receipt goal choices',
  clientSrc.includes('设为下一奖励') && clientSrc.includes('选一项你想先实现的奖励')
  && clientSrc.includes('<NextRewardGoal />') && clientSrc.includes('查看奖励')
  && clientSrc.includes('保留该目标') && clientSrc.includes('选择下一项')
  && clientSrc.includes('api.setRewardGoal'));

// ------------------------------------------------------------ harness
async function loadHarnessDeps() {
  try {
    return {
      orm: await import('drizzle-orm'),
      libsql: await import('drizzle-orm/libsql'),
      client: await import('@libsql/client'),
      core: await import('drizzle-orm/sqlite-core'),
      zod: await import('zod'),
    };
  } catch { /* fall back to the artifact install anchored at package.json */ }
  const artifactPkg = new URL('./package.json', import.meta.url);
  const { createRequire } = await import('node:module');
  const req = createRequire(artifactPkg);
  return { orm: req('drizzle-orm'), libsql: req('drizzle-orm/libsql'), client: req('@libsql/client'), core: req('drizzle-orm/sqlite-core'), zod: req('zod') };
}

async function buildHarness() {
  const deps = await loadHarnessDeps();
  const { eq, and, sql, desc, asc, lte } = deps.orm;
  const { drizzle } = deps.libsql;
  const { createClient } = deps.client;
  const core = deps.core;
  const z = deps.zod.z;
  const schemaCode = schemaSrc.replace(/^import[^;]+;/m, '').replace(/export const /g, 'const ');
  const schema = new Function('sqliteTable', 'integer', 'text', 'real', 'primaryKey',
    `${stripTypeScriptTypes(schemaCode)}\nreturn { healthSnapshot, strengthTrainingSnapshot, morningCheckin, readinessHistory, gameState, gameSettlements, gameRewards, gameRewardRedemptions, gameRewardGoal, syncLog };`)
    (core.sqliteTable, core.integer, core.text, core.real, core.primaryKey);
  const constNames = [
    'statusSchema', 'trendPointSchema', 'dailySchema', 'workoutSchema', 'sleepHistorySchema',
    'strengthSetSchema', 'strengthExerciseSchema', 'strengthWorkoutSchema', 'strengthWeekSchema',
    'strengthTrainingSchema', 'snapshotSchema', 'EMPTY_STRENGTH',
    'GAME_RULE_VERSION', 'GAME_XP_PER_LEVEL', 'GAME_POINTS_PER_LEVEL',
    'GAME_QUEST_TARGET_STEPS', 'GAME_QUEST_REWARD_XP', 'GAME_STRENGTH_SESSION_XP',
    'GAME_ATTR_XP_PCT_PER_POINT', 'GAME_ATTR_DOMAIN_CAP_PCT',
    'GAME_ATTRIBUTES', 'GAME_ATTRIBUTE_DOMAIN', 'GAME_EQUIPMENT', 'GAME_EQUIPMENT_BY_ID',
    'GAME_DAILY_TASKS', 'PROFILE_CAS_ATTEMPTS',
  ];
  const fnNames = [
    'isOwner', 'laTodayString', 'shiftDate', 'clamp', 'round', 'totalSleepHours', 'timeInBedHours',
    'normalizeSleepSnapshot', 'normalizeStoredSnapshot', 'normalizeStoredStrength',
    'loadHealthSnapshot', 'loadStrengthSnapshot', 'effectiveStrength',
    'defaultGameProfile', 'parseGameProfile', 'loadGameStateRow', 'saveGameProfile',
    'allocatedPoints', 'unspentPoints', 'attrBonusPct', 'equippedDefs', 'equipBonusPct', 'boostedXp',
    'stepsXpFor', 'sleepXpFor', 'sleepStartOrderKey', 'selectMainSleep',
    'compareSourceVersions', 'sourceVersionSqlBefore', 'planLedgerAction', 'buildGamePlan',
    'bookLedgerRow', 'settleLedgerRow', 'evaluateDailyTasks', 'settleGame',
    'rewardItemFromRow', 'rewardReceiptFromRow', 'loadRedemptionByRequestId', 'loadRewardGoalId', 'sameRedemptionContent',
    'handleGetRewards', 'handleSaveReward', 'handleRedeemReward', 'handleGetRedemptionReceipt', 'handleSetRewardGoal',
  ];
  const code = [
    ...constNames.map((n) => extractConst(serverSrc, n)),
    ...fnNames.map((n) => extractHandlerFunction(serverSrc, n)),
  ].join('\n');
  const fns = new Function('schema', 'eq', 'and', 'sql', 'desc', 'asc', 'lte', 'z',
    `${stripTypeScriptTypes(code)}\nreturn { handleGetRewards, handleSaveReward, handleRedeemReward, handleGetRedemptionReceipt, handleSetRewardGoal, settleGame, loadHealthSnapshot, loadGameStateRow };`)
    (schema, eq, and, sql, desc, asc, lte, z);
  const migrationFiles = readdirSync(new URL('./drizzle/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  async function makeDb() {
    const client = createClient({ url: ':memory:' });
    for (const file of migrationFiles) {
      await client.executeMultiple(readFileSync(new URL(`./drizzle/${file}`, import.meta.url), 'utf8'));
    }
    return { client, db: drizzle(client) };
  }
  return { ...fns, schema, makeDb, migrationFiles };
}

function laTodayString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

let H = null;
let harnessError = null;
try {
  H = await buildHarness();
} catch (error) {
  harnessError = error;
}
check('harness: production reward handlers extracted and bound to a migration-built in-memory store',
  H !== null, harnessError ? String(harnessError?.message ?? harnessError) : '');

if (H) {
  const OWNER = { isOwner: true };
  const GUEST = { isOwner: false };
  const ctxFor = (db, viewer) => ({ viewer, db: () => db, invalidateQueries: () => {} });
  const TODAY = laTodayString();
  async function scenario(name, fn) {
    try { await fn(); }
    catch (error) { check(`scenario ${name}: runs to completion`, false, error instanceof Error ? error.message : String(error)); }
  }
  async function rawState(db) {
    const gs = await db.select().from(H.schema.gameState);
    const redemptions = await db.select().from(H.schema.gameRewardRedemptions);
    const ledger = await db.select().from(H.schema.gameSettlements);
    const redeemRows = ledger.filter((row) => row.category === 'reward_redeem');
    return {
      gold: gs[0]?.gold ?? null,
      revision: gs[0]?.revision ?? null,
      goldLedgerSum: gs[0]?.goldLedgerSum ?? null,
      redemptionCount: redemptions.length,
      redeemGoldSum: redeemRows.reduce((sum, row) => sum + row.gold, 0),
      redeemRowCount: redeemRows.length,
    };
  }
  async function seedFundedProfile(client, gold = 1000) {
    const now = Date.now();
    await client.execute({
      sql: 'INSERT INTO game_state (id, total_xp, settled_through_date, gold, gold_initialized, attrs_json, attr_points_earned, equipment_json, revision, gold_ledger_sum, created_at, updated_at) VALUES (1, 0, NULL, ?, 1, ?, 0, ?, 1, 0, ?, ?)',
      args: [gold, JSON.stringify({ strength: 0, endurance: 0, spirit: 0, stamina: 0 }), JSON.stringify({ owned: [], equipped: { weapon: null, armor: null, accessory: null } }), now, now],
    });
  }

  // ---------------------------------------------------------- gate matrix
  await scenario('owner gate matrix', async () => {
    const { db } = await H.makeDb();
    const guest = ctxFor(db, GUEST);
    const anon = ctxFor(db, undefined);
    const listGuest = await H.handleGetRewards(guest);
    check('gate: guest getRewards is forbidden with zero data',
      listGuest.forbidden === true && listGuest.rewards.length === 0 && listGuest.receipts.length === 0 && listGuest.balance === 0);
    const listAnon = await H.handleGetRewards(anon);
    check('gate: no-viewer getRewards is forbidden (no sync-channel exception for rewards)',
      listAnon.forbidden === true && listAnon.rewards.length === 0);
    const saveGuest = await H.handleSaveReward(guest, { id: null, name: 'x', price: 10 });
    const saveAnon = await H.handleSaveReward(anon, { id: null, name: 'x', price: 10 });
    check('gate: guest/no-viewer saveReward forbidden, nothing written',
      saveGuest.forbidden === true && saveAnon.forbidden === true
      && (await db.select().from(H.schema.gameRewards)).length === 0);
    const redeemGuest = await H.handleRedeemReward(guest, { requestId: 'gate-req-0001', rewardId: 1, rewardRevision: 1, price: 10, expectedBalanceVersion: 0 });
    const lookupGuest = await H.handleGetRedemptionReceipt(guest, { requestId: 'gate-req-0001' });
    const state = await rawState(db);
    check('gate: guest redeemReward forbidden and zero writes anywhere (no profile row, no receipt, no ledger flow)',
      redeemGuest.forbidden === true && redeemGuest.status === 'forbidden'
      && lookupGuest.forbidden === true && lookupGuest.found === false
      && state.redemptionCount === 0 && state.redeemRowCount === 0 && state.gold === null);
  });

  // ---------------------------------------------------------- main flow
  await scenario('reward CRUD, redemption, idempotency', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);

    const created = await H.handleSaveReward(owner, { id: null, name: ' 电影票 ', price: 300 });
    check('create: trims the name, starts at revision 1',
      created.ok === true && created.reward?.name === '电影票' && created.reward?.price === 300 && created.reward?.revision === 1);
    const rewardId = created.reward.id;
    const edited1 = await H.handleSaveReward(owner, { id: rewardId, name: '电影票（两张）', price: 450 });
    const edited2 = await H.handleSaveReward(owner, { id: rewardId, name: '电影票（两张）', price: 500 });
    check('edit: every save increments the revision (1 -> 2 -> 3) and stores the latest price',
      edited1.reward?.revision === 2 && edited1.reward?.price === 450
      && edited2.reward?.revision === 3 && edited2.reward?.price === 500 && edited2.reward?.name === '电影票（两张）');
    const blank = await H.handleSaveReward(owner, { id: null, name: '   ', price: 10 });
    const ghost = await H.handleSaveReward(owner, { id: 999, name: '不存在', price: 10 });
    check('create/edit guards: blank name and unknown id are typed non-ok with no row written',
      blank.ok === false && ghost.ok === false && (await db.select().from(H.schema.gameRewards)).length === 1);

    await seedFundedProfile(client, 1000);
    const list = await H.handleGetRewards(owner);
    const V = list.balanceVersion;
    check('list: saved balance and version come from the settled profile; missing source is stated, list still readable',
      list.forbidden === false && list.balance === 1000 && list.healthState === 'missing'
      && list.rewards.length === 1 && list.rewards[0]?.price === 500 && list.rewards[0]?.revision === 3);

    const pricey = await H.handleSaveReward(owner, { id: null, name: '贵重奖励', price: 2000 });
    const beforeIns = await rawState(db);
    const insufficient = await H.handleRedeemReward(owner, { requestId: 'req-insufficient-1', rewardId: pricey.reward.id, rewardRevision: 1, price: 2000, expectedBalanceVersion: V });
    const afterIns = await rawState(db);
    check('insufficient: typed rejection, zero writes (gold, revision, watermark, receipts, ledger all identical)',
      insufficient.status === 'insufficient_funds' && insufficient.receipt === null
      && JSON.stringify(beforeIns) === JSON.stringify(afterIns));

    const beforeStale = await rawState(db);
    const stalePrice = await H.handleRedeemReward(owner, { requestId: 'req-stale-price-1', rewardId, rewardRevision: 3, price: 450, expectedBalanceVersion: V });
    const staleRevision = await H.handleRedeemReward(owner, { requestId: 'req-stale-rev-001', rewardId, rewardRevision: 2, price: 500, expectedBalanceVersion: V });
    const staleVersion = await H.handleRedeemReward(owner, { requestId: 'req-stale-ver-001', rewardId, rewardRevision: 3, price: 500, expectedBalanceVersion: V + 99 });
    const afterStale = await rawState(db);
    check('stale: preview-then-edit price, old revision, and wrong balance version all reject as stale with zero writes',
      stalePrice.status === 'stale' && staleRevision.status === 'stale' && staleVersion.status === 'stale'
      && JSON.stringify(beforeStale) === JSON.stringify(afterStale));

    const REQ1 = 'req-redeem-main-01';
    const redeemed = await H.handleRedeemReward(owner, { requestId: REQ1, rewardId, rewardRevision: 3, price: 500, expectedBalanceVersion: V });
    check('redeem: success returns a real receipt with the snapshot (name/price/spent/balance-after/pinned version)',
      redeemed.status === 'redeemed' && redeemed.receipt !== null
      && redeemed.receipt.rewardName === '电影票（两张）' && redeemed.receipt.price === 500
      && redeemed.receipt.goldSpent === 500 && redeemed.receipt.balanceAfter === 500
      && redeemed.receipt.balanceVersion === V && redeemed.receipt.localDate === TODAY
      && redeemed.balance === 500);
    const afterRedeem = await rawState(db);
    check('redeem: profile gold and watermark both drop by the price; one reward_redeem ledger flow of -500 (xp 0)',
      afterRedeem.gold === 500 && afterRedeem.goldLedgerSum === -500
      && afterRedeem.redeemGoldSum === -500 && afterRedeem.redeemRowCount === 1 && afterRedeem.redemptionCount === 1);
    const settledAgain = await H.settleGame(owner, null, null, TODAY);
    check('redeem: a later settlement does not re-credit or re-charge the spent gold (balance stays 500)',
      settledAgain.profile.gold === 500 && settledAgain.profile.goldLedgerSum === -500);

    const beforeReplay = await rawState(db);
    const replay = await H.handleRedeemReward(owner, { requestId: REQ1, rewardId, rewardRevision: 3, price: 500, expectedBalanceVersion: V });
    const afterReplay = await rawState(db);
    check('replay: same requestId + same content returns the original receipt (already_resolved), no second charge, zero writes',
      replay.status === 'already_resolved' && replay.receipt?.id === redeemed.receipt.id
      && JSON.stringify(beforeReplay) === JSON.stringify(afterReplay));
    const conflictPrice = await H.handleRedeemReward(owner, { requestId: REQ1, rewardId, rewardRevision: 3, price: 501, expectedBalanceVersion: V });
    const conflictVersion = await H.handleRedeemReward(owner, { requestId: REQ1, rewardId, rewardRevision: 3, price: 500, expectedBalanceVersion: V + 1 });
    const afterConflict = await rawState(db);
    check('conflict: same requestId with different price or balance version is rejected, zero writes',
      conflictPrice.status === 'request_conflict' && conflictVersion.status === 'request_conflict'
      && JSON.stringify(beforeReplay) === JSON.stringify(afterConflict));

    const repriced = await H.handleSaveReward(owner, { id: rewardId, name: '电影票（改价版）', price: 200 });
    check('edit after redeem: the reward moves to revision 4 at the new price',
      repriced.ok === true && repriced.reward?.revision === 4 && repriced.reward?.price === 200);
    const oldReceipt = await H.handleGetRedemptionReceipt(owner, { requestId: REQ1 });
    check('receipt snapshot: the price edit never rewrites the issued receipt (name/price/spent/balance-after frozen)',
      oldReceipt.found === true && oldReceipt.receipt?.rewardName === '电影票（两张）'
      && oldReceipt.receipt?.price === 500 && oldReceipt.receipt?.goldSpent === 500 && oldReceipt.receipt?.balanceAfter === 500);
    const missingLookup = await H.handleGetRedemptionReceipt(owner, { requestId: 'req-never-existed' });
    check('lookup: an unknown requestId reports found=false (the unconfirmed-state resolution path)',
      missingLookup.forbidden === false && missingLookup.found === false && missingLookup.receipt === null);

    const list2 = await H.handleGetRewards(owner);
    const second = await H.handleRedeemReward(owner, { requestId: 'req-redeem-main-02', rewardId, rewardRevision: 4, price: 200, expectedBalanceVersion: list2.balanceVersion });
    const afterSecond = await rawState(db);
    check('second redemption: same reward again the same day accumulates into ONE ledger flow row (-700 total), balance 300',
      second.status === 'redeemed' && second.receipt?.balanceAfter === 300
      && afterSecond.gold === 300 && afterSecond.redeemGoldSum === -700 && afterSecond.redeemRowCount === 1
      && afterSecond.redemptionCount === 2);
    const finalList = await H.handleGetRewards(owner);
    check('list after redemptions: rewards and BOTH receipts remain readable with the settled balance (source still missing)',
      finalList.balance === 300 && finalList.receipts.length === 2 && finalList.rewards.length === 2
      && finalList.receipts[0]?.id === second.receipt.id && finalList.healthState === 'missing');
  });

  // ---------------------------------------------------------- source revision
  await scenario('late source revision keeps receipts intact', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    const makeSnapshot = (updatedAt, steps) => ({
      dataDate: '2026-10-01', updatedAt, timezone: 'America/Los_Angeles', coverageIncomplete: false,
      steps: { value: steps, baseline: 8000, usualMin: 5000, usualMax: 11000, distanceKm: 8, flights: 2, basalKcal: 1600, status: '正常' },
      restingHr: { value: 60, baseline: 60, usualMin: 55, usualMax: 65, status: '正常' },
      hrv: { value: 40, baseline: 40, usualMin: 30, usualMax: 50, status: '正常' },
      respiratoryRate: { value: 14, status: '正常' },
      sleep: { bedtime: '23:00', wakeTime: '07:00', inBedHours: 8, coreHours: 5, deepHours: 1.5, remHours: 1.5, awakeMinutes: 10, quality: 85, efficiency: 95, awakenings: 1, status: '正常' },
      morningReference: { date: '2026-10-02', hrvMs: 40, avgHrBpm: 60 },
      strengthTraining: { updatedAt: null, displayUnit: 'lb', workouts: [], weeklyTrend: [], note: '无' },
      workouts: { count7d: 0, baselinePerWeek: 2, note: '无' },
      trends: [{ date: '2026-10-01', stepCount: steps, restingHrBpm: 60, hrvMs: 40 }],
      historyDaily: [{ date: '2026-10-01', steps, activeKcal: 300, exerciseMinutes: 30, restingHr: 60, hrvMs: 40, respiratoryRate: 14, weightKg: 80, swimMeters: null, hrMax: 120 }],
      historyWorkouts: [],
      historySleeps: [{ date: '2026-10-02', start: '23:00', end: '07:00', totalHours: 8, coreHours: 5, deepHours: 1.5, remHours: 1.5, awakeMinutes: 10, quality: 85, awakenings: 1, efficiency: 95 }],
    });
    const seedSnapshot = async (snap) => {
      await client.execute({ sql: 'DELETE FROM health_snapshot', args: [] });
      await client.execute({
        sql: 'INSERT INTO health_snapshot (id, payload, source_updated_at, created_at, updated_at) VALUES (1, ?, ?, ?, ?)',
        args: [JSON.stringify(snap), Date.parse(snap.updatedAt), Date.now(), Date.now()],
      });
    };
    await seedSnapshot(makeSnapshot('2026-10-02T01:00:00.000Z', 20000));
    const funded = await H.handleGetRewards(owner);
    const G0 = funded.balance;
    check('funding: settlement over the seeded snapshot mints the saved balance (steps 20 + quest 10 + sleep 10 = 40)',
      funded.healthState === 'ok' && G0 === 40, `balance=${G0}`);
    const created = await H.handleSaveReward(owner, { id: null, name: '庆祝餐', price: 10 });
    const redeemed = await H.handleRedeemReward(owner, { requestId: 'req-revision-001', rewardId: created.reward.id, rewardRevision: 1, price: 10, expectedBalanceVersion: funded.balanceVersion });
    check('redeem before revision: succeeds against the settled balance',
      redeemed.status === 'redeemed' && redeemed.receipt?.balanceAfter === G0 - 10, `status=${redeemed.status}`);

    await seedSnapshot(makeSnapshot('2026-10-03T01:00:00.000Z', 3000));
    const revised = await H.handleGetRewards(owner);
    check('source revision: steps 20000 -> 3000 revises XP by -17 and the balance follows (40 - 10 - 17 = 13)',
      revised.balance === G0 - 27, `balance=${revised.balance}`);
    const receiptAfter = await H.handleGetRedemptionReceipt(owner, { requestId: 'req-revision-001' });
    check('source revision: the receipt is neither deleted nor re-priced (still 10 spent, balance-after frozen at issue time)',
      receiptAfter.found === true && receiptAfter.receipt?.goldSpent === 10 && receiptAfter.receipt?.balanceAfter === G0 - 10);
    const healthLoad = await H.loadHealthSnapshot(owner);
    const settled = await H.settleGame(owner, healthLoad.snapshot, null, TODAY);
    check('source revision: settled-through stays at the last settled source day, never the redemption day',
      settled.settledThroughDate === '2026-10-02', `through=${settled.settledThroughDate}`);
  });

  // -------------------------------------------- atomic commit (REDEEM-SAFE-001)
  function wrapDb(db, overrides) {
    return new Proxy(db, {
      get(t, p) {
        if (Object.prototype.hasOwnProperty.call(overrides, p)) return overrides[p];
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }

  await scenario('atomic commit: failure injection at the batch write point', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '原子测试', price: 60 });
    const list = await H.handleGetRewards(owner);
    const args = { requestId: 'req-atomic-fail-1', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion };
    const failingDb = wrapDb(db, { batch: async () => { throw new Error('injected batch failure'); } });
    const failed = await H.handleRedeemReward(ctxFor(failingDb, OWNER), args);
    const stateAfterFail = await rawState(db);
    check('atomic: an injected batch failure returns busy (unconfirmed) and leaves the fully old state — no receipt, no flow, no deduction',
      failed.status === 'busy' && failed.receipt === null
      && stateAfterFail.gold === 100 && stateAfterFail.goldLedgerSum === 0
      && stateAfterFail.redemptionCount === 0 && stateAfterFail.redeemRowCount === 0, `status=${failed.status}`);
    const retry = await H.handleRedeemReward(owner, args);
    const state = await rawState(db);
    check('atomic: the same requestId retry after the failed commit succeeds exactly once',
      retry.status === 'redeemed' && state.gold === 40 && state.redemptionCount === 1 && state.redeemGoldSum === -60);
    check('atomic: the issued receipt proves the actual commit (balanceAfter == stored gold, watermark == ledger redeem sum, goldSpent == -flow)',
      retry.receipt !== null && retry.receipt.balanceAfter === state.gold
      && state.goldLedgerSum === state.redeemGoldSum && retry.receipt.goldSpent === -state.redeemGoldSum);
  });

  await scenario('atomic commit: failure injection at each inner write point rolls back everything', async () => {
    for (const [table, bak] of [['game_settlements', 'game_settlements_sab'], ['game_reward_redemptions', 'game_reward_redemptions_sab']]) {
      const { client, db } = await H.makeDb();
      const owner = ctxFor(db, OWNER);
      await seedFundedProfile(client, 100);
      const reward = await H.handleSaveReward(owner, { id: null, name: '写点注入', price: 60 });
      const list = await H.handleGetRewards(owner);
      const sabotageDb = wrapDb(db, {
        batch: async (stmts) => {
          await client.execute(`ALTER TABLE ${table} RENAME TO ${bak}`);
          try { return await db.batch(stmts); }
          finally { await client.execute(`ALTER TABLE ${bak} RENAME TO ${table}`); }
        },
      });
      const res = await H.handleRedeemReward(ctxFor(sabotageDb, OWNER), { requestId: `req-sabotage-${table}`, rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion });
      const state = await rawState(db);
      check(`atomic: breaking ${table} mid-commit leaves the fully old state (busy, gold 100, watermark 0, zero receipts, zero flows)`,
        res.status === 'busy' && state.gold === 100 && state.goldLedgerSum === 0
        && state.redemptionCount === 0 && state.redeemRowCount === 0, `status=${res.status}`);
    }
  });

  await scenario('atomic commit: response lost after the commit landed', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '丢响应', price: 60 });
    const list = await H.handleGetRewards(owner);
    const args = { requestId: 'req-lost-response', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion };
    let committed = false;
    let dropReads = true;
    const lossyDb = wrapDb(db, {
      batch: async (stmts) => { const result = await db.batch(stmts); committed = true; return result; },
      select: (...a) => { if (committed && dropReads) throw new Error('response lost in transit'); return db.select(...a); },
    });
    const lost = await H.handleRedeemReward(ctxFor(lossyDb, OWNER), args);
    check('lost response: the handler reports busy (unconfirmed), never a false typed rejection',
      lost.status === 'busy' && lost.receipt === null, `status=${lost.status}`);
    dropReads = false;
    const stateAfterLoss = await rawState(db);
    const lookup = await H.handleGetRedemptionReceipt(owner, { requestId: 'req-lost-response' });
    const retry = await H.handleRedeemReward(owner, args);
    const state = await rawState(db);
    check('lost response: the commit had in fact landed once (gold 40, one -60 flow); lookup finds the receipt and the same-key retry returns it with no second charge',
      stateAfterLoss.gold === 40 && stateAfterLoss.redeemGoldSum === -60
      && lookup.found === true && retry.status === 'already_resolved'
      && retry.receipt?.id === lookup.receipt?.id
      && state.gold === 40 && state.redemptionCount === 1 && state.redeemGoldSum === -60);
  });

  await scenario('atomic commit: concurrent different keys cannot overdraw', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '并发奖励', price: 60 });
    const list = await H.handleGetRewards(owner);
    const base = { rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion };
    const [r1, r2] = await Promise.all([
      H.handleRedeemReward(owner, { ...base, requestId: 'req-race-key-a01' }),
      H.handleRedeemReward(owner, { ...base, requestId: 'req-race-key-b01' }),
    ]);
    const statuses = [r1.status, r2.status];
    const state = await rawState(db);
    check('race different keys: exactly one success and one typed rejection; one receipt; gold exactly 40 (winner state), ledger -60, watermark -60 — no overdraft, no floor',
      statuses.filter((s) => s === 'redeemed').length === 1
      && statuses.every((s) => s === 'redeemed' || s === 'stale' || s === 'insufficient_funds' || s === 'busy')
      && state.redemptionCount === 1 && state.gold === 40 && state.redeemGoldSum === -60 && state.goldLedgerSum === -60,
      `statuses=${statuses.join(',')}`);
  });

  await scenario('atomic commit: concurrent same key charges exactly once', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '同键并发', price: 60 });
    const list = await H.handleGetRewards(owner);
    const args = { requestId: 'req-race-same-key', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion };
    const [s1, s2] = await Promise.all([
      H.handleRedeemReward(owner, args),
      H.handleRedeemReward(owner, args),
    ]);
    const state = await rawState(db);
    check('race same key: both submits resolve to the SAME single receipt; exactly one deduction (gold 40, one -60 flow)',
      s1.receipt !== null && s2.receipt !== null && s1.receipt.id === s2.receipt.id
      && [s1.status, s2.status].every((s) => s === 'redeemed' || s === 'already_resolved')
      && state.redemptionCount === 1 && state.gold === 40 && state.redeemGoldSum === -60,
      `statuses=${s1.status},${s2.status}`);
  });

  await scenario('atomic commit: price change after the final pre-read rejects the old confirmation', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '改价测试', price: 60 });
    const list = await H.handleGetRewards(owner);
    let armed = true;
    const raceDb = wrapDb(db, {
      batch: async (stmts) => {
        if (armed) {
          armed = false;
          await client.execute({ sql: 'UPDATE game_rewards SET price = 70, revision = revision + 1 WHERE id = ?', args: [reward.reward.id] });
        }
        return db.batch(stmts);
      },
    });
    const res = await H.handleRedeemReward(ctxFor(raceDb, OWNER), { requestId: 'req-race-price-01', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion });
    const state = await rawState(db);
    check('race price change: the in-batch pin guard rejects the old confirmation as stale with zero redemption writes (charged at neither 60 nor 70)',
      res.status === 'stale' && state.gold === 100 && state.redemptionCount === 0 && state.redeemGoldSum === 0, `status=${res.status}`);
    const list2 = await H.handleGetRewards(owner);
    const ok = await H.handleRedeemReward(owner, { requestId: 'req-race-price-02', rewardId: reward.reward.id, rewardRevision: 2, price: 70, expectedBalanceVersion: list2.balanceVersion });
    const state2 = await rawState(db);
    check('race price change: a fresh preview at the new price redeems at exactly 70',
      ok.status === 'redeemed' && ok.receipt?.price === 70 && state2.gold === 30 && state2.redeemGoldSum === -70);
  });

  await scenario('atomic commit: balance change after the final pre-read rejects the old confirmation', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '改余额测试', price: 60 });
    const list = await H.handleGetRewards(owner);
    let armed = true;
    const raceDb = wrapDb(db, {
      batch: async (stmts) => {
        if (armed) {
          armed = false;
          // A competing redemption (different key) commits first.
          await H.handleRedeemReward(owner, { requestId: 'req-race-balance-0', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion });
        }
        return db.batch(stmts);
      },
    });
    const res = await H.handleRedeemReward(ctxFor(raceDb, OWNER), { requestId: 'req-race-balance-1', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: list.balanceVersion });
    const state = await rawState(db);
    check('race balance change: the moved balance rejects the old confirmation (stale or insufficient) with zero writes by the loser — only the winner receipt exists, gold exactly 40',
      (res.status === 'stale' || res.status === 'insufficient_funds') && res.receipt === null
      && state.redemptionCount === 1 && state.gold === 40 && state.redeemGoldSum === -60, `status=${res.status}`);
  });

  await scenario('legacy half-completed state is preserved, never silently rewritten', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    await seedFundedProfile(client, 100);
    const reward = await H.handleSaveReward(owner, { id: null, name: '旧回执', price: 60 });
    // A pre-fix half-completed state, seeded directly: a receipt
    // claiming 60 spent / 40 after, but no ledger flow and no
    // deduction ever landed.
    await client.execute({
      sql: 'INSERT INTO game_reward_redemptions (request_id, reward_id, reward_name, reward_price, reward_revision, balance_version, gold_spent, balance_after, local_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: ['req-legacy-half-1', reward.reward.id, '旧回执', 60, 1, 1, 60, 40, TODAY, Date.now()],
    });
    const list = await H.handleGetRewards(owner);
    check('legacy: the stored receipt stays listed and the balance is NOT silently re-based to match it',
      list.receipts.length === 1 && list.balance === 100);
    const retry = await H.handleRedeemReward(owner, { requestId: 'req-legacy-half-1', rewardId: reward.reward.id, rewardRevision: 1, price: 60, expectedBalanceVersion: 1 });
    const state = await rawState(db);
    check('legacy: a same-key retry resolves to the stored receipt as-is (already_resolved) — no retroactive deduction, no deletion, no compensating flow',
      retry.status === 'already_resolved' && retry.receipt?.goldSpent === 60
      && state.gold === 100 && state.redemptionCount === 1 && state.redeemRowCount === 0, `status=${retry.status}`);
  });

  // ---------------------------------------------------------- next-reward goal
  await scenario('next-reward goal preference', async () => {
    const { client, db } = await H.makeDb();
    const owner = ctxFor(db, OWNER);
    const guest = ctxFor(db, GUEST);
    await seedFundedProfile(client, 500);
    const setGuest = await H.handleSetRewardGoal(guest, { rewardId: 1 });
    const setAnon = await H.handleSetRewardGoal(ctxFor(db, undefined), { rewardId: 1 });
    check('goal gate: guest/no-viewer setRewardGoal forbidden, nothing written',
      setGuest.forbidden === true && setAnon.forbidden === true
      && (await db.select().from(H.schema.gameRewardGoal)).length === 0);
    const initial = await H.handleGetRewards(owner);
    check('goal: no preference saved -> goalRewardId null (no default reward invented)',
      initial.goalRewardId === null);
    const a = await H.handleSaveReward(owner, { id: null, name: '目标甲', price: 100 });
    const b = await H.handleSaveReward(owner, { id: null, name: '目标乙', price: 200 });
    const setA = await H.handleSetRewardGoal(owner, { rewardId: a.reward.id });
    const listA = await H.handleGetRewards(owner);
    check('goal: setting a goal persists and reads back identically on the next open',
      setA.ok === true && setA.goalRewardId === a.reward.id && listA.goalRewardId === a.reward.id);
    const setB = await H.handleSetRewardGoal(owner, { rewardId: b.reward.id });
    const failed = await H.handleSetRewardGoal(owner, { rewardId: 999 });
    const listB = await H.handleGetRewards(owner);
    check('goal: switching works; a failed save (unknown reward) keeps and reports the previous goal',
      setB.ok === true && failed.ok === false && failed.goalRewardId === b.reward.id && listB.goalRewardId === b.reward.id);
    const list2 = await H.handleGetRewards(owner);
    const redeemed = await H.handleRedeemReward(owner, { requestId: 'req-goal-keep-01', rewardId: a.reward.id, rewardRevision: 1, price: 100, expectedBalanceVersion: list2.balanceVersion });
    await H.handleSaveReward(owner, { id: b.reward.id, name: '目标乙（改名）', price: 260 });
    const list3 = await H.handleGetRewards(owner);
    const goalNow = list3.rewards.find((r) => r.id === list3.goalRewardId);
    check('goal: redeeming another reward and renaming/repricing the goal keep the goal; it reads the CURRENT name/price while the old receipt keeps its snapshot',
      redeemed.status === 'redeemed' && list3.goalRewardId === b.reward.id
      && goalNow?.name === '目标乙（改名）' && goalNow?.price === 260
      && list3.receipts[0]?.rewardName === '目标甲' && list3.receipts[0]?.price === 100);
    check('goal: the goal stays readable with the health source missing (list shows goal + rewards, healthState missing)',
      list3.healthState === 'missing' && list3.goalRewardId === b.reward.id && list3.rewards.length === 2);
  });
}

console.log(`\nvalidate-rewards: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
