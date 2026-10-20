// 学习复利 schema: skills (技能) + learning inputs (每日学习输入账本).
//
// A skill is a long-lived asset the owner is building. Each learning input
// is one dated entry in the ledger, optionally linked to a skill, and can
// later be marked as converted into a concrete output (note / experiment /
// project progress / decision). Nothing here touches external accounts.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const skills = sqliteTable("skills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const learningInputs = sqliteTable("learning_inputs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Local calendar date of the learning, "YYYY-MM-DD" (America/Los_Angeles).
  date: text("date").notNull(),
  sourceType: text("source_type", {
    enum: ["article", "video", "research", "practice", "course"],
  }).notNull(),
  topic: text("topic").notNull(),
  skillId: integer("skill_id").references(() => skills.id),
  // Minutes are nullable since migration 0003: NULL means "duration
  // unknown" (the field was left blank). Rows written before that keep
  // their stored value untouched — a legacy 0 stays 0 and is displayed
  // as 来源不明 (provenance unknown); it is never bulk-rewritten to NULL.
  minutes: integer("minutes"),
  // Conversion: when set, this input has been turned into an output.
  // This is the FIRST conversion instant: re-marking never overwrites
  // it, and the accumulation curve buckets the output on the
  // America/Los_Angeles calendar day of this instant — never on the
  // input's own date.
  convertedAt: integer("converted_at", { mode: "timestamp_ms" }),
  outputType: text("output_type", {
    enum: ["note", "experiment", "project", "decision"],
  }),
  outputNote: text("output_note"),
  // 「挑一条去用」 attempt state: set when the owner starts trying to
  // apply this input. An attempt is NOT a conversion and never touches
  // convertedAt. NULL for rows that predate the feature (no fabricated
  // attempts).
  attemptStartedAt: integer("attempt_started_at", { mode: "timestamp_ms" }),
  // Idempotency key of the saveOutput call that performed the current
  // conversion; a retry carrying the same requestId is a no-op. The
  // immutable receipt for that key lives in conversion_receipts (below)
  // and survives revocation; this column is only the live pointer.
  conversionRequestId: text("conversion_request_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Immutable per-request conversion receipts (CMP-LEARN-SAVE-001). One
// row per first-conversion request, written in the same atomic batch as
// the conversion itself. Rows are NEVER deleted and NEVER rewritten:
// when the conversion they recorded is revoked, only revokedAt is
// stamped, turning the row into a tombstone — a late retry carrying
// that requestId is answered "revoked" instead of resurrecting the
// conversion, and re-marking requires a fresh requestId (a new
// generation). Legacy conversions that predate this table simply have
// no receipt; nothing is backfilled or fabricated for them. One narrow
// exception at revocation time only: if such a legacy row still stores
// a real request key (conversionRequestId) for its live conversion,
// unmarkConverted writes the revocation fact for that exact key as an
// already-revoked receipt built solely from the row's own stored key,
// payload and first-conversion instant — otherwise the cleared key
// would leave no tombstone and a late retry could resurrect the
// conversion. Keyless legacy rows get no receipt, ever.
export const conversionReceipts = sqliteTable("conversion_receipts", {
  requestId: text("request_id").primaryKey(),
  inputId: integer("input_id")
    .notNull()
    .references(() => learningInputs.id),
  // Hash of the exact conversion payload (outputType + outputNote) the
  // request carried. A retry with the same key but a different payload
  // is rejected, not applied.
  payloadHash: text("payload_hash").notNull(),
  // The first-conversion instant this request produced (ms epoch).
  convertedAt: integer("converted_at").notNull(),
  outputType: text("output_type", {
    enum: ["note", "experiment", "project", "decision"],
  }).notNull(),
  outputNote: text("output_note"),
  // Set when unmarkConverted revoked this request's conversion.
  revokedAt: integer("revoked_at"),
});
