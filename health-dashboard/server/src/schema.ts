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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const gameSettlements = sqliteTable("game_settlements", {
  localDate: text("local_date").notNull(),
  category: text("category", { enum: ["steps", "sleep", "strength", "quest_steps", "daily_task"] }).notNull(),
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

export const syncLog = sqliteTable("sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", { enum: ["health", "strength", "system"] }).notNull(),
  status: text("status", { enum: ["saved", "failed", "diagnosed"] }).notNull(),
  itemCount: integer("item_count").notNull(),
  note: text("note").notNull(),
  sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
