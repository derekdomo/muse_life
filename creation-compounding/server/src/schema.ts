// 创造复利 schema: projects (自有产品/项目) + project stage dates (阶段标尺)
// + progress entries (每周推进记录).
//
// 口径与「学习复利」严格分开:这里只记产出里程碑与可验证产出,不记学习
// 输入。阶段是每个项目独立的五级标尺,每级单独记日期;推进记录每条必须
// 有日期、产出描述与成果/证据引用,工作时长只是备注,永不折算进度。
// 没有任何外部连接:全部数据由所有者手动自记。

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const STAGES = [
  "idea",
  "first_version",
  "shipped",
  "first_user",
  "first_payment",
] as const;

export type StageKey = (typeof STAGES)[number];

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  // The project's own "next milestone" note (free text); the stage ruler
  // itself is data in project_stages.
  nextMilestone: text("next_milestone"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const projectStages = sqliteTable("project_stages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  stage: text("stage", { enum: STAGES }).notNull(),
  // Local calendar date the stage was reached, "YYYY-MM-DD"
  // (America/Los_Angeles). One row per (project, stage); re-marking a
  // stage updates its own date only — stages are never merged.
  date: text("date").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const progressEntries = sqliteTable("progress_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  // Local calendar date of the output, "YYYY-MM-DD".
  date: text("date").notNull(),
  // What verifiable output was produced.
  description: text("description").notNull(),
  // Evidence reference: a link, or one sentence pointing at the artifact
  // of work. Required — an entry without evidence is not countable.
  evidence: text("evidence").notNull(),
  // Optional note only (e.g. hours spent). Never converted into value or
  // progress anywhere in the app.
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
