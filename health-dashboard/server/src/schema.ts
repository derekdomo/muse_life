import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const syncLog = sqliteTable("sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", { enum: ["health", "strength", "system"] }).notNull(),
  status: text("status", { enum: ["saved", "failed", "diagnosed"] }).notNull(),
  itemCount: integer("item_count").notNull(),
  note: text("note").notNull(),
  sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
