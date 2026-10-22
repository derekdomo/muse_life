import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const healthSnapshot = sqliteTable("health_snapshot", {
  id: integer("id").primaryKey(),
  payload: text("payload").notNull(),
  sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const strengthTrainingSnapshot = sqliteTable("strength_training_snapshot", {
  id: integer("id").primaryKey(),
  payload: text("payload").notNull(),
  sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const morningCheckin = sqliteTable("morning_checkin", {
  date: text("date").primaryKey(),
  feeling: integer("feeling").notNull(),
  // Persistent monotonic input revision (H-ARCHIVE-SAFE-001 follow-up):
  // incremented atomically inside the saveMorningCheckin upsert itself
  // (first insert = 1, conflict update = COALESCE(revision, 0) + 1), so
  // two successful saves within the same millisecond still get distinct,
  // ordered versions — updated_at cannot provide that. Nullable because
  // rows saved before this column existed carry no revision; a null (or
  // legacy 0) revision is treated as the OLDEST input version by the
  // readiness archive arbitration.
  revision: integer("revision"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Readiness score archive (H-LOAD-001, owner-approved 2026-10-18): one row
// per readiness date, written whenever getDashboard computes that date's
// readiness. Scores are archived exactly as computed at the time — history
// is never backfilled or recomputed, so dates before this table existed
// simply have no row and render as gaps. `score` is null when the day's
// readiness was 数据不足. `snapshotVersion` records the health snapshot
// version (its payload updatedAt, the read-start instant) the score was
// computed from.
export const readinessHistory = sqliteTable("readiness_history", {
  date: text("date").primaryKey(),
  score: real("score"),
  components: text("components").notNull(),
  confidence: text("confidence", { enum: ["高", "中", "低"] }).notNull(),
  snapshotVersion: text("snapshot_version"),
  // Morning check-in input version, TEXT form (H-ARCHIVE-SAFE-001 race
  // fix): the morning_checkin.updated_at (ISO instant) of the check-in
  // row the score was computed from, bound at read time. Kept for
  // compatibility, but arbitration NO LONGER judges freshness from it:
  // two saves in the same millisecond share an updated_at while their
  // feelings differ, so the text version cannot order them. Freshness is
  // judged by `checkinRevision` below.
  checkinVersion: text("checkin_version"),
  // Morning check-in input version, NUMERIC form (H-ARCHIVE-SAFE-001
  // follow-up): the morning_checkin.revision bound at the same read as
  // the feeling. The archive arbitration compares this integer: at equal
  // health snapshot version an incoming write is accepted only when its
  // checkin_revision is not older than the stored one; an incoming null
  // never overwrites a stored non-null; a stored null (every row archived
  // before this column existed, including rows that carry only the legacy
  // text checkin_version) counts as the OLDEST and stays overwritable —
  // legacy rows are never deleted or recomputed.
  checkinRevision: integer("checkin_revision"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// LIFE-C1 人生游戏 (CWEB-MVP-001·S1/S2) game-side state. These two tables
// hold ONLY game state and settlement metadata — never health raw values.
// The ledger records, per settled day, category, and detail, the XP and
// gold awarded, the rule version that produced it, and a source reference
// (the source calendar date plus the source snapshot's updatedAt) so every
// award stays explainable without duplicating the health record it was
// derived from. The (local_date, category, detail) primary key is the
// idempotency identity: owner + LA local date + category + detail settles
// at most once, enforced by the database itself (inserts use ON CONFLICT
// DO NOTHING). `detail` is "" for the base categories; for daily_task rows
// it is the task id (3 tasks share one date and category). S2 (migration
// 0010) rebuilt this table with the detail/gold columns; S1 rows were
// copied across with detail "" and gold 0 — their gold was folded into
// the one-time initial gold balance (= cumulative XP at first S2 read),
// never minted twice.
// game_state additionally carries the S2 character system: gold balance,
// the four attribute allocations (attrs_json), attribute points ever
// earned, and owned/equipped equipment (equipment_json) — all game
// state, stored as one row.
export const gameState = sqliteTable("game_state", {
  id: integer("id").primaryKey(),
  totalXp: integer("total_xp").notNull().default(0),
  settledThroughDate: text("settled_through_date"),
  gold: integer("gold").notNull().default(0),
  goldInitialized: integer("gold_initialized").notNull().default(0),
  attrsJson: text("attrs_json"),
  attrPointsEarned: integer("attr_points_earned").notNull().default(0),
  equipmentJson: text("equipment_json"),
  // Persistent write revision (CWEB-PROFILE-SAFE-001): incremented inside
  // the profile write statement itself, and every profile write is
  // conditional on the revision the writer read (compare-and-swap), so a
  // stale snapshot can never overwrite a newer profile. Nullable because
  // rows written before this column existed carry no revision; a null
  // revision is read as 0 (the oldest version).
  revision: integer("revision"),
  // Gold reconciliation watermark (CWEB-SETTLE-001): the game_settlements
  // gold SUM that the stored `gold` balance already accounts for, written
  // in the SAME statement as the balance itself. Settlement derives the
  // balance as stored balance + (current ledger gold SUM − watermark),
  // so ledger rows booked by an attempt whose profile save failed are
  // credited exactly once by the next settlement instead of leaking, and
  // rows already reflected in the balance are never minted twice.
  // Nullable because rows written before this column existed have no
  // watermark; the first settlement afterwards adopts a baseline (see
  // settleGame) instead of re-minting history.
  goldLedgerSum: integer("gold_ledger_sum"),
  // Immutable baseline-adoption boundary (CWEB-SETTLE-001 follow-up,
  // migration 0012): for a legacy row whose goldLedgerSum is still null,
  // the first settlement adopts as its baseline the gold of ledger rows
  // booked at or before this instant. The value is the row's updated_at
  // captured by the 0012 backfill (the profile's last successful save at
  // migration time) and is NEVER written by saveGameProfile or any
  // profile mutation — purchases, allocations and equips advance
  // updated_at but cannot move this boundary, so a ledger row stranded
  // by a failed settlement save (booked after the boundary) can no
  // longer be adopted as already-accounted by a later profile write;
  // the next settlement credits it exactly once. Once the watermark
  // turns non-null the boundary is never consulted again. Rollback:
  // dropping this column restores the 0011 shape; every other column
  // and row is untouched.
  goldAdoptionBoundary: integer("gold_adoption_boundary", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const gameSettlements = sqliteTable("game_settlements", {
  localDate: text("local_date").notNull(),
  // reward_redeem (S3): a redemption books its gold flow into this same
  // ledger with xp 0 and NEGATIVE gold (detail = the reward id), so the
  // balance/watermark reconciliation in settleGame accounts for spent
  // gold exactly like earned gold. The category is a plain text column
  // in SQLite (no CHECK constraint in any migration); the enum here is
  // the type-level contract.
  category: text("category", { enum: ["steps", "sleep", "strength", "quest_steps", "daily_task", "reward_redeem"] }).notNull(),
  detail: text("detail").notNull().default(""),
  xp: integer("xp").notNull(),
  gold: integer("gold").notNull().default(0),
  ruleVersion: integer("rule_version").notNull(),
  sourceDate: text("source_date").notNull(),
  sourceUpdatedAt: text("source_updated_at"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.localDate, table.category, table.detail] }),
]);

// LIFE-C1 人生游戏 S3 (CWEB-MVP-001·S3) personal rewards: the owner's
// own reward list (name + gold price) and the redemption receipts
// issued against it. Additive only (migration 0013) — no existing table
// or row is touched. A reward carries a `revision` that increments on
// every save of its name/price, so a redemption preview can pin exactly
// the version the owner saw. A redemption receipt is an immutable
// snapshot: the reward name/price/revision at redemption time, the
// balance version the preview pinned, the gold actually spent, the
// saved balance right after, and the LA local date — later price edits
// or late source revisions never rewrite it. `request_id` is UNIQUE:
// it is the idempotency identity of one redemption intent, so a retry
// with the same id resolves to the original receipt instead of charging
// twice. The gold itself moves through the EXISTING ledger/balance
// caliber (a reward_redeem row in game_settlements plus the profile
// CAS write) — these tables hold no balance of their own.
export const gameRewards = sqliteTable("game_rewards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const gameRewardRedemptions = sqliteTable("game_reward_redemptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull().unique(),
  rewardId: integer("reward_id").notNull(),
  rewardName: text("reward_name").notNull(),
  rewardPrice: integer("reward_price").notNull(),
  rewardRevision: integer("reward_revision").notNull(),
  balanceVersion: integer("balance_version").notNull(),
  goldSpent: integer("gold_spent").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  localDate: text("local_date").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // Per-request completion proof (CWEB-REDEEM-SAFE-001 follow-up,
  // migration 0015): the gold-ledger watermark the atomic redemption
  // batch produced for THIS request, written by the receipt insert
  // inside that same batch — so the value exists only when the
  // deduction, the watermark advance, and the ledger flow committed
  // with the receipt. Receipts issued before this column existed (or
  // by any half-completed legacy write) carry NULL: they cannot be
  // proven complete per-request — not from the current balance and
  // not from any per-day ledger aggregate, since reward_redeem flows
  // accumulate per (date, reward) — and every surface (lookup, list,
  // replay, UI) must present them as 未核实, never as a completed
  // redemption. The column is only ever written at issuance; legacy
  // rows are never backfilled, re-based, or deleted.
  completionProof: integer("completion_proof"),
});

// LIFE-C1 S3 余项 (CWEB-MVP-001·S3): the owner's single "next reward"
// preference — one row (id = 1) naming the rewardId the owner explicitly
// chose as their next goal. Additive only (migration 0014). It is a
// display preference, never an economic input: it does not affect
// prices, balances, settlement, or redemption, and it is never
// auto-populated (no default reward is invented when no row exists).
// Deleting or renaming the target reward never rewrites receipts; the
// goal simply reads against the reward's current row.
export const gameRewardGoal = sqliteTable("game_reward_goal", {
  id: integer("id").primaryKey(),
  rewardId: integer("reward_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const syncLog = sqliteTable("sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", { enum: ["health", "strength", "system"] }).notNull(),
  status: text("status", { enum: ["saved", "failed", "diagnosed"] }).notNull(),
  itemCount: integer("item_count").notNull(),
  note: text("note").notNull(),
  sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
