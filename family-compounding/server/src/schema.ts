// 陪伴复利 schema: family activity records (家庭活动记录) + owner-managed
// activity types (活动类型).
//
// 口径 (CMP-FAMILY-001): 只让积累可见,不 KPI 化——没有分数、没有排名、
// 没有连续天数/断签概念。日期是所有者本地日 "YYYY-MM-DD";时长可空
// (NULL = 未知,永不按 0 处理);类型是所有者自选的短标签,不是任何
// 第三方姓名。不读外部日历,不接任何外部账户——全部数据由所有者
// 手动自记。空账本开始,不预置任何记录行。

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Preset activity types, materialized on first dashboard read when the
// types table is empty. The owner can rename the set freely afterwards
// (add / delete); presets carry no special behavior beyond the flag.
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
