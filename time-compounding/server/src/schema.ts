// Drizzle schema for 时间复利 (space-14).
//
// Tables:
//   time_entries   — user-recorded time intervals (category + start/end epoch ms,
//                    instants in UTC; week bucketing happens in America/Los_Angeles).
//   request_ledger — durable idempotency ledger keyed by client requestId.
//                    Rows NEVER disappear when an entry is deleted; a deleted
//                    entry's key is flagged so a late retry can never resurrect it.
//   settings       — small key/value store (self-stated weekly priorities).

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const timeEntries = sqliteTable("time_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  note: text("note").notNull().default(""),
  // Monotonic per-entry revision: starts at 1 on insert and increments by
  // exactly 1 on every successful update. It NEVER regresses and is never
  // reused, so two states of an entry with identical content still carry
  // different revisions (content equality is not version equality).
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const requestLedger = sqliteTable("request_ledger", {
  requestId: text("request_id").primaryKey(),
  // SHA-256 hex of the canonical mutation payload the key was first used with.
  fingerprint: text("fingerprint").notNull(),
  // The entry this key created (kept after deletion so retries resolve to it).
  entryId: integer("entry_id"),
  // 1 once the entry created by this key has been deleted; a retry with this
  // key then returns a typed "deleted" and never recreates the row.
  deleted: integer("deleted").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
