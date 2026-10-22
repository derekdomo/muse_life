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
//                      This is the LIVE copy: readers only ever see
//                      these rows, and an import replaces them in one
//                      atomic promotion (CMP-READ-IMPORT-001).
//   import_staged_chapters
//                    — one import generation's chapters, staged in
//                      isolation under (book_id, gen) where gen is the
//                      beginImport requestId. Invisible to readers;
//                      promoted into book_chapters by finishImport
//                      only after the whole generation validates.
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
  // failed import can be retried against the same book row. This is
  // the LIVE file pointer: it moves only when a generation is
  // promoted by a successful finishImport.
  blobKey: text("blob_key"),
  // CMP-READ-IMPORT-001 generation binding: the requestId of the
  // import generation that currently owns this book's staging area
  // (set by beginImport, cleared never — a finished generation stays
  // recorded so its late writes are recognized as ITS, and refused
  // once a newer generation owns the book). NULL for books whose
  // import predates generations; their old unbound writes follow the
  // documented legacy path.
  importGen: text("import_gen"),
  // ctx.blobs key of the CURRENT generation's staged original file
  // (epub-stage/<bookId>/<gen>). Promoted into blobKey by a
  // successful finishImport; a failed import leaves blobKey — the
  // previous good file — untouched.
  importBlobKey: text("import_blob_key"),
  // Edition/version label of the LIVE imported file (e.g. EPUB
  // filename or the version the owner names), snapshotted onto
  // snippets. This moves ONLY when a generation is promoted by a
  // successful finishImport — never at beginImport — so a snippet
  // saved from the still-live old body is always stamped with the
  // label of the version it was actually read from.
  versionLabel: text("version_label"),
  // The PENDING edition label, staged with the current generation
  // by beginImport (migration 0006). Invisible to provenance: it is
  // promoted into versionLabel atomically with the body/file at
  // finishImport and cleared there; a failed import leaves it
  // recorded so the UI can name the version that did not replace
  // the live copy.
  importVersionLabel: text("import_version_label"),
  // Content fingerprint of the original-file bytes belonging to
  // generation import_gen (migration 0006): the staged file while
  // the generation is processing, the LIVE file once that
  // generation has been promoted. Recorded by uploadImportFile in
  // the same guarded update that moves the pointer, cleared by the
  // next beginImport. It makes a generation's file immutable:
  // a same-generation upload retry carrying the same bytes is an
  // idempotent no-op, and one carrying different bytes is a typed
  // conflict with zero blob/pointer writes — even after the
  // generation has closed, when its staged key IS the live key.
  importFileHash: text("import_file_hash"),
  // Finish freeze (migration 0007, CMP-READ-IMPORT-001 remainder):
  // while finishImport promotes a generation it first stamps the
  // validated staged manifest here; every same-generation write
  // point (upload / staged chapters) refuses while a freeze is
  // held, and the promotion batch itself is guarded on the freeze
  // value, so the set that was validated is the set that can be
  // promoted — nothing can join, leave or change in between.
  // NULL whenever no finish is in flight; cleared by the promotion
  // itself and by the next beginImport claim.
  importFrozenManifest: text("import_frozen_manifest"),
  // The generation whose body/file/label are LIVE right now
  // (migration 0007). Set ONLY by a successful promotion — unlike
  // importGen, which a new beginImport moves immediately while the
  // old body is still live. This is the live-version token reader
  // writes are bound to: getChapter returns it, savePosition /
  // createSnippet must carry it back, and a token from a superseded
  // live version is a typed conflict with zero writes. NULL for
  // books whose live copy predates generations (version unknown,
  // never guessed).
  liveGen: text("live_gen"),
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

// One import generation's staged chapters (CMP-READ-IMPORT-001).
// Written only by saveImportChapters calls bound to the generation
// that currently owns the book; never read by the reader. The unique
// (book_id, gen, idx) index makes a chapter position unambiguous
// within a generation — a duplicate idx upserts the one staged row
// instead of creating a rival.
export const importStagedChapters = sqliteTable("import_staged_chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id),
  // The generation: the beginImport requestId that opened it.
  gen: text("gen").notNull(),
  idx: integer("idx").notNull(),
  title: text("title"),
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
  // The live-version token (books.live_gen) this snippet was read
  // from (migration 0007). Together with versionLabel it pins the
  // snippet's provenance to ONE live version: when the book's live
  // version moves on, the UI can say honestly "原文版本已替换"
  // instead of pretending the saved position still locates the
  // quote. NULL for snippets saved before live versions existed or
  // from books with no recorded live version — "无法确认", never
  // backfilled by guessing.
  liveGen: text("live_gen"),
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
  // Q&A discussion binding (CMP-READ-001 pinned-citation closure):
  // when a card is distilled from ONE in-app Q&A turn, these four
  // columns pin exactly which discussion produced it — the ask's
  // questionRequestId, the snippet version that was answered
  // against, and the response-time 原文/出处 snapshot. All NULL for
  // cards not made from a Q&A turn. The snapshot is immutable once
  // saved: later snippet edits never rewrite what this card came
  // from. Written only after the server verifies the snapshot still
  // matches the stored snippet row (see createCard).
  qaQuestionRequestId: text("qa_question_request_id"),
  qaSnippetVersion: integer("qa_snippet_version"),
  qaSourceText: text("qa_source_text"),
  qaSourceLabel: text("qa_source_label"),
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
