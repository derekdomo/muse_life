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
  minutes: integer("minutes").notNull().default(0),
  // Conversion: when set, this input has been turned into an output.
  convertedAt: integer("converted_at", { mode: "timestamp_ms" }),
  outputType: text("output_type", {
    enum: ["note", "experiment", "project", "decision"],
  }),
  outputNote: text("output_note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
