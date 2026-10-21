// 陪伴复利 schema: family activity records (家庭活动记录) + owner-managed
// activity types (活动类型).
//
// 口径 (CMP-FAMILY-001): 只让积累可见,不 KPI 化——没有分数、没有排名、
// 没有连续天数/断签概念。日期是所有者本地日 "YYYY-MM-DD";时长可空
// (NULL = 未知,永不按 0 处理);类型是所有者自选的短标签,不是任何
// 第三方姓名。不读外部日历,不接任何外部账户——全部数据由所有者
// 手动自记。空账本开始,不预置任何记录行。

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Preset activity types, materialized exactly once on the first
// dashboard read: the "types_seeded" ledger-meta claim and all 7
// preset inserts commit as ONE atomic db.batch (CMP-FAMILY-INIT-001),
// so the completion marker can never exist without its types. The
// owner can change the set freely afterwards (add / delete); presets
// carry no special behavior beyond the flag.
//
// Type-name uniqueness is scoped to preset identity, never global:
// legacy databases may legally hold two types with the exact same
// name (custom duplicates, or a preset duplicated by a pre-batch
// seeding race), and those rows are always preserved. Each preset
// row carries a stable preset_key (its canonical name); the only
// UNIQUE index on this table is on preset_key (migration 0006,
// backfilled onto the earliest preset row of each name — later
// same-name rows keep preset_key NULL). Custom types always have
// preset_key NULL, so custom same-name rows never collide.
export const PRESET_TYPES = [
  "一起吃饭",
  "陪玩",
  "户外",
  "阅读",
  "运动",
  "旅行",
  "其他",
] as const;

export const activityTypes = sqliteTable("activity_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  isPreset: integer("is_preset").notNull().default(0),
  // Stable preset identity (migration 0006): for a preset row this is
  // its canonical preset name; NULL for custom types and for legacy
  // duplicate preset rows beyond the earliest of their name. The
  // UNIQUE index on this column is what the seed inserts conflict
  // against — names themselves are never globally unique.
  presetKey: text("preset_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Tiny key/value table for one-time ledger bookkeeping. Currently one
// key: "types_seeded" — set once the preset activity types have been
// materialized, so an owner who deletes every type does not see the
// presets resurrect on the next read.
export const ledgerMeta = sqliteTable("ledger_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Persistent request-key ledger (CMP-FAMILY-SAVE-001). One row per
// client request key ever used to save an activity: the canonical
// payload fingerprint, the activity it produced, and its lifecycle
// state. Rows here are NEVER deleted when an activity is deleted —
// deleting an activity flips its key to 'deleted', so a late retry of
// that save is recognized and refused instead of resurrecting the
// record, and a retry carrying different content under the same key
// is recognized as a conflict instead of silently passing as a
// duplicate.
export const familyRequestKeys = sqliteTable("family_request_keys", {
  requestKey: text("request_key").primaryKey(),
  // Canonical JSON fingerprint of (date, typeName, minutes, note).
  payload: text("payload").notNull(),
  activityId: integer("activity_id"),
  state: text("state", { enum: ["saved", "deleted"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const familyActivities = sqliteTable("family_activities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Local calendar date of the activity, "YYYY-MM-DD" (owner's local
  // day). Past dates are allowed (补记); the date is whatever the owner
  // says it is — never guessed or shifted.
  date: text("date").notNull(),
  // The activity type label as chosen at save time (snapshot of the
  // type name, so deleting a type later never rewrites history).
  typeName: text("type_name").notNull(),
  // Optional duration in minutes. NULL = unknown — excluded from the
  // known-duration total, but the record still counts as an activity.
  minutes: integer("minutes"),
  // Optional one-line note.
  note: text("note"),
  // Client-generated idempotency key: a retry of the same save carries
  // the same key and must not create a second record. Unique index in
  // the migration enforces it at the storage layer too.
  requestKey: text("request_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
