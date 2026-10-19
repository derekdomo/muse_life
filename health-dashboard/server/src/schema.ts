import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  // Morning check-in input version (H-ARCHIVE-SAFE-001 race fix): the
  // morning_checkin.updated_at (ISO instant) of the check-in row the score
  // was computed from, bound at read time. Null when no check-in existed
  // for the date — and on every row archived before this column existed;
  // a null stored checkin_version is treated as the OLDEST version by the
  // archive arbitration, so legacy rows stay overwritable and are never
  // deleted or recomputed.
  checkinVersion: text("checkin_version"),
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
