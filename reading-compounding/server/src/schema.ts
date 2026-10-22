// 读书复利 schema.
//
// The compounding asset here is the knowledge card and its REUSE, not
// pages read. Model:
//   books            — the shelf: 想读/在读/读完, source (owner/claude),
//                      EPUB import state, stable reading position
//                      (chapter index + char offset, never a page number),
//                      and progress kept in the owner's own unit.
//   book_chapters    — sanitized chapter HTML of an imported EPUB,
//                      stored only in this app's private runtime DB.
//   reading_sessions — explicit reading records; ONLY these rows count
//                      toward reading days / streaks / minutes. Imports,
//                      savor views and internalized marks never create one.
//   snippets         — saved quotes (原文) with provenance (book, version,
//                      chapter or 章节不详, stable position), a Muse
//                      think prompt kept separate from the original text,
//                      and the owner's own reflection. Paste/OCR items
//                      start as drafts and become snippets only after
//                      the owner confirms the exact text + provenance.
//   knowledge_cards  — one-line core + source snippet + owner annotation.
//   card_reuses      — the interest ledger: one row per real reuse of a
//                      card in a decision / project / discussion.
//   request_keys     — immutable idempotency ledger (CMP-READ-SAVE-001):
//                      one row per save requestId with a payload
//                      fingerprint; rows are never deleted, and deleting
//                      the target row only stamps `deleted` here, so a
//                      late retry is answered "deleted" and can never
//                      resurrect the row.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const books = sqliteTable("books", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  author: text("author"),
  // Where the book came from: the owner picked it, or Muse recommended it.
  source: text("source", { enum: ["owner", "claude"] }).notNull(),
  status: text("status", { enum: ["want", "reading", "done"] }).notNull(),
  note: text("note"),
  // EPUB import lifecycle. "none" = no import expected (e.g. a WeRead
  // shelf entry added by screenshot/口述 — listed, never claimed read
  // or imported). "pending" = an import is expected but not started.
  importStatus: text("import_status", {
    enum: ["none", "pending", "processing", "failed", "ready"],
  }).notNull(),
  importError: text("import_error"),
  // ctx.blobs key of the original owner-supplied EPUB bytes, kept so a
  // failed import can be retried against the same book row.
  blobKey: text("blob_key"),
  // Edition/version label of the imported file (e.g. EPUB filename or
  // the version the owner names), snapshotted onto snippets.
  versionLabel: text("version_label"),
  // Stable reading position: chapter index + char offset inside it.
  curChapter: integer("cur_chapter").notNull().default(0),
  curOffset: integer("cur_offset").notNull().default(0),
  // Progress in the owner's own unit; NULL = unknown. No percentage is
  // ever derived when a total is unknown.
  progressValue: real("progress_value"),
  progressUnit: text("progress_unit", { enum: ["page", "chapter"] }),
  // requestId that created this row; tombstoned in request_keys on delete.
  requestId: text("request_id"),
  // Optimistic-lock generation for edits: a stale save conflicts and
  // never overwrites a newer row.
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bookChapters = sqliteTable("book_chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id),
  idx: integer("idx").notNull(),
  title: text("title"),
  // Sanitized chapter HTML (scripts, event handlers and remote
  // resources stripped client-side before upload; re-sanitized by the
  // reader's inert rendering — no remote loads, ever).
  html: text("html").notNull(),
  charCount: integer("char_count").notNull().default(0),
});

export const readingSessions = sqliteTable("reading_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookId: integer("book_id").references(() => books.id),
  // America/Los_Angeles local calendar day, "YYYY-MM-DD".
  date: text("date").notNull(),
  // NULL = duration unknown (never conflated with 0).
  minutes: integer("minutes"),
  progressValue: real("progress_value"),
  progressUnit: text("progress_unit", { enum: ["page", "chapter"] }),
  note: text("note"),
  requestId: text("request_id"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const snippets = sqliteTable("snippets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookId: integer("book_id").references(() => books.id),
  // Provenance snapshots: kept even if the book row is later removed.
  bookTitle: text("book_title").notNull(),
  versionLabel: text("version_label"),
  // NULL chapter label is displayed as 章节不详 — never invented.
  chapterLabel: text("chapter_label"),
  chapterIdx: integer("chapter_idx"),
  charOffset: integer("char_offset"),
  // The original quote, verbatim. Model output never rewrites this.
  text: text("text").notNull(),
  source: text("source", { enum: ["reader", "paste", "ocr", "chat"] }).notNull(),
  // Paste/OCR items are drafts until the owner confirms them.
  status: text("status", { enum: ["draft", "saved"] }).notNull(),
  // Muse's one-line thinking prompt — a separate field from the
  // original text and from the owner's words, rendered separately.
  thinkPrompt: text("think_prompt"),
  // The owner's own later reflection （补记感悟 from 片刻回味）.
  reflection: text("reflection"),
  // Marking internalized is a display state only: it is NOT a card
  // reuse, NOT reading time, and never moves any curve.
  internalizedAt: integer("internalized_at", { mode: "timestamp_ms" }),
  requestId: text("request_id"),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const snippetTags = sqliteTable("snippet_tags", {
  snippetId: integer("snippet_id")
    .notNull()
    .references(() => snippets.id),
  tag: text("tag").notNull(),
  // "suggested" rows come from the model and are labeled 建议 until the
  // owner applies them (which rewrites origin to "owner").
  origin: text("origin", { enum: ["owner", "suggested"] }).notNull(),
});

export const knowledgeCards = sqliteTable("knowledge_cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // One-line core of the card.
  core: text("core").notNull(),
  snippetId: integer("snippet_id").references(() => snippets.id),
  // Human-readable source snapshot （书名 · 章节）, kept even if the
  // snippet is later removed.
  sourceLabel: text("source_label"),
  // The owner's annotation, in the owner's words.
  annotation: text("annotation"),
  origin: text("origin", { enum: ["ui", "chat"] }).notNull(),
  requestId: text("request_id"),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const cardTags = sqliteTable("card_tags", {
  cardId: integer("card_id")
    .notNull()
    .references(() => knowledgeCards.id),
  tag: text("tag").notNull(),
  origin: text("origin", { enum: ["owner", "suggested"] }).notNull(),
});

export const cardReuses = sqliteTable("card_reuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => knowledgeCards.id),
  // America/Los_Angeles local calendar day the reuse happened.
  date: text("date").notNull(),
  // Where the card was actually used (decision / project / discussion).
  scene: text("scene").notNull(),
  // What it helped resolve.
  outcome: text("outcome").notNull(),
  requestId: text("request_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Immutable per-request save ledger. One row per requestId, written in
// the same batch as the row it created. Never deleted, never rewritten
// except stamping `deleted` when the created row is deleted — a late
// retry with that key is then answered "deleted" instead of recreating
// the row. payloadHash is a fingerprint of the exact save payload: the
// same key with a different payload is a typed conflict, and the
// caller's draft is preserved (nothing is written).
export const requestKeys = sqliteTable("request_keys", {
  requestId: text("request_id").primaryKey(),
  kind: text("kind").notNull(),
  payloadHash: text("payload_hash").notNull(),
  resultTable: text("result_table"),
  resultId: integer("result_id"),
  deleted: integer("deleted").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
