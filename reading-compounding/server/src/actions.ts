// 读书复利 actions.
//
// Core rule: the compounding metric is knowledge-card REUSE, not pages
// read. Snippets （原文） become knowledge cards; a card earns interest
// only when it is actually reused in a decision, project, or discussion
// and that reuse is registered in card_reuses. No scores, no KPI
// framing, no streak punishment.
//
// ACL: every action is owner-only. Each handler runs the strict
// isOwner gate BEFORE any database read/write and before seed
// initialization; refused calls return a typed rejection and touch zero
// rows. There is deliberately NO anonymous/internal-channel exception
// in this app (the L0.1 exception does not extend here).
// recordKnowledgeCardFromChat / recordCardReuse are the agent-callable
// write paths Muse uses when delivering chat work — they obey the
// exact same gate and fail honestly (ok:false, forbidden:true) without
// a verifiable owner viewer.
//
// Save safety (CMP-READ-SAVE-001): every create carries a requestId
// recorded in the immutable request_keys ledger with a payload
// fingerprint covering ALL saved content and provenance fields. The
// created row(s), their tag rows and the ledger row commit as ONE
// db.batch — a single atomic unit — so a failure at any write point
// (or a lost response, or a same-key race lost to the ledger's
// primary key) never leaves a body row without its ledger entry or
// vice versa: the outcome is the full commit, or the untouched
// pre-save state, and the same key can simply be retried.
//   same key + same payload  → the original row is returned (replay)
//   same key + other payload → typed "conflict", nothing written
//   key whose row was deleted → typed "deleted", never resurrected
// Replay/deleted arbitration reads the persisted ledger AND the
// created row's own visibility (its deleted_at), never a cached
// claim — so even a row deleted before deletes became atomic is
// answered "deleted" truthfully. Deletes are atomic too: the
// soft-delete and the ledger tombstone stamp commit in one batch.
// Edits carry an optimistic `version`: a stale save conflicts and the
// newer row is never overwritten.
//
// Pinned citations (CMP-READ-001 closure): every successful
// askSnippetQuestion response consumes and returns the binding of
// exactly that ask (questionRequestId + snippet id + the stored
// version actually read + the response-time 原文/出处 snapshot).
// The client pins it on the turn; a card distilled from that turn
// passes the same binding to createCard, which re-verifies it
// against the stored snippet row before writing — a source that
// changed since the discussion makes the save a typed conflict
// with zero writes, never a silent re-pointing — and then stores
// the binding on the card row itself (migration 0005), so the
// card's citation survives every later library update.
//
// Import generations (CMP-READ-IMPORT-001): an import is a GENERATION
// identified by its beginImport requestId, bound through every later
// write (uploadImportFile / saveImportChapters / finishImport carry
// the same key as `importId`). beginImport arbitrates through the
// request ledger on BOTH paths (new book and existingBookId): a
// same-key replay returns the original result and writes NOTHING —
// it can never wipe a finished import back to "processing" — and a
// same-key/different-payload call is a typed conflict. A fresh begin
// only claims the book's staging area (books.import_gen): the new
// generation's chapters stage in import_staged_chapters and its file
// in a per-generation blob key, while readers keep seeing the live
// book_chapters and blob_key untouched. finishImport validates the
// staged generation, then promotes it — delete live chapters, copy
// staged chapters in, flip the file pointer, mark ready, reset the
// reading position — as ONE guarded db.batch, so a read at any moment
// sees the complete old version or the complete new one. Writes from
// a superseded generation (late begin/chapters/finish) are refused
// with a typed conflict and change nothing. A failed finish keeps
// the live chapters, file pointer, reading position and excerpts
// exactly as they were.

import { defineAction, z, type ActionsModule, type Ctx, type SpaceDb } from "@hatch/space-sdk";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem as DrizzleBatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";

function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

const TZ = "America/Los_Angeles";
const dateKeyRe = /^\d{4}-\d{2}-\d{2}$/;

function todayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function laDateKey(instant: Date): string {
  return todayKey(instant);
}

function shiftDay(key: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function streakEndingAt(dates: Set<string>, endKey: string): number {
  let streak = 0;
  let cursor = endKey;
  while (dates.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

// A streak is "current" if it reaches today, or yesterday (today not
// yet logged does not break it yet). Informational only — nothing in
// this app punishes a broken streak.
function currentStreak(dates: Set<string>, today: string): number {
  if (dates.has(today)) return streakEndingAt(dates, today);
  const yesterday = shiftDay(today, -1);
  if (dates.has(yesterday)) return streakEndingAt(dates, yesterday);
  return 0;
}

// FNV-1a fingerprint of the canonical payload. Not cryptographic — it
// only needs to distinguish "same save retried" from "same key, other
// content" deterministically.
function payloadHash(payload: unknown): string {
  const s = JSON.stringify(payload) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

type Db = SpaceDb<typeof schema>;

// One statement of an atomic db.batch write set (sqlite dialect).
type BatchItem = DrizzleBatchItem<"sqlite">;

type Claim =
  | { state: "fresh" }
  | { state: "replay"; resultId: number | null }
  | { state: "conflict"; resultId: number | null }
  | { state: "deleted"; resultId: number | null };

// Tables a ledger row can point at (the ledger's result_table values).
const RESULT_TABLE_SQL = {
  books: "books",
  reading_sessions: "reading_sessions",
  snippets: "snippets",
  knowledge_cards: "knowledge_cards",
  card_reuses: "card_reuses",
} as const;

type ResultTableName = keyof typeof RESULT_TABLE_SQL;

// SQL fragment resolving, inside the same batch, the id of the row a
// create just inserted — every created row carries its requestId, so
// the ledger backfill and dependent rows (tags, a chat card's
// snippet) reference the ACTUAL stored row, never a guessed id.
function idByRequestId(resultTable: ResultTableName, requestId: string) {
  return sql`(SELECT id FROM ${sql.raw(RESULT_TABLE_SQL[resultTable])} WHERE request_id = ${requestId})`;
}

function ledgerInsertStmt(
  db: Db,
  requestId: string,
  kind: string,
  hash: string,
  resultTable: ResultTableName,
): BatchItem {
  return db.insert(schema.requestKeys).values({
    requestId,
    kind,
    payloadHash: hash,
    resultTable,
    resultId: null,
  });
}

function ledgerResultStmt(
  db: Db,
  requestId: string,
  resultTable: ResultTableName,
): BatchItem {
  return db
    .update(schema.requestKeys)
    .set({ resultId: idByRequestId(resultTable, requestId) })
    .where(eq(schema.requestKeys.requestId, requestId));
}

// Is the row a ledger entry points at still there and not deleted?
// The ledger records what was committed; the row itself is the
// authority on whether it is still alive. card_reuses has no
// tombstone column of its own — a reuse dies with its card, exactly
// as the read paths already filter it.
async function entityAlive(
  db: Db,
  resultTable: string | null,
  resultId: number | null,
): Promise<boolean> {
  if (resultTable == null || resultId == null) return false;
  switch (resultTable) {
    case "books": {
      const rows = await db
        .select({ deletedAt: schema.books.deletedAt })
        .from(schema.books)
        .where(eq(schema.books.id, resultId))
        .limit(1);
      const r = rows[0];
      return r != null && r.deletedAt == null;
    }
    case "reading_sessions": {
      const rows = await db
        .select({ deletedAt: schema.readingSessions.deletedAt })
        .from(schema.readingSessions)
        .where(eq(schema.readingSessions.id, resultId))
        .limit(1);
      const r = rows[0];
      return r != null && r.deletedAt == null;
    }
    case "snippets": {
      const rows = await db
        .select({ deletedAt: schema.snippets.deletedAt })
        .from(schema.snippets)
        .where(eq(schema.snippets.id, resultId))
        .limit(1);
      const r = rows[0];
      return r != null && r.deletedAt == null;
    }
    case "knowledge_cards": {
      const rows = await db
        .select({ deletedAt: schema.knowledgeCards.deletedAt })
        .from(schema.knowledgeCards)
        .where(eq(schema.knowledgeCards.id, resultId))
        .limit(1);
      const r = rows[0];
      return r != null && r.deletedAt == null;
    }
    case "card_reuses": {
      const rows = await db
        .select({ cardId: schema.cardReuses.cardId })
        .from(schema.cardReuses)
        .where(eq(schema.cardReuses.id, resultId))
        .limit(1);
      const reuse = rows[0];
      if (!reuse) return false;
      const cards = await db
        .select({ deletedAt: schema.knowledgeCards.deletedAt })
        .from(schema.knowledgeCards)
        .where(eq(schema.knowledgeCards.id, reuse.cardId))
        .limit(1);
      const card = cards[0];
      return card != null && card.deletedAt == null;
    }
    default:
      return false;
  }
}

// Authoritative arbitration for one create key, from persisted state
// only: the ledger row plus the created row's own visibility. A
// committed row that has since been deleted is answered "deleted"
// even if its tombstone stamp is missing (rows deleted before
// deletes became atomic) — a replay never reports a false success
// and never resurrects anything.
async function arbitrateCreate(
  db: Db,
  requestId: string,
  kind: string,
  hash: string,
): Promise<Claim> {
  const rows = await db
    .select()
    .from(schema.requestKeys)
    .where(eq(schema.requestKeys.requestId, requestId))
    .limit(1);
  const row = rows[0];
  if (!row) return { state: "fresh" };
  if (row.kind !== kind || row.payloadHash !== hash) return { state: "conflict", resultId: row.resultId };
  if (row.deleted === 1) return { state: "deleted", resultId: row.resultId };
  if (!(await entityAlive(db, row.resultTable, row.resultId))) {
    return { state: "deleted", resultId: row.resultId };
  }
  return { state: "replay", resultId: row.resultId };
}

function claimToResult(claim: Claim): z.infer<typeof createResult> | null {
  switch (claim.state) {
    case "conflict":
      // The ledger's recorded resultId IS the authoritative result
      // for this key (the row the original save actually committed).
      // Clients locate that exact row by id — never by guessing
      // from a snippet or a list position.
      return { ok: false, forbidden: false, status: "conflict", id: null, resultId: claim.resultId };
    case "deleted":
      return { ok: false, forbidden: false, status: "deleted", id: null, resultId: claim.resultId };
    case "replay":
      return { ok: true, forbidden: false, status: "replayed", id: claim.resultId, resultId: claim.resultId };
    default:
      return null;
  }
}

// Commit one create's ENTIRE write set — created row(s), dependent
// rows (tags, a chat card's source snippet) and the ledger row — as
// one db.batch. The runtime executes a batch as a single atomic
// unit, so any failure (a rejected ledger insert, a rejected tag
// insert, a crash before the response) commits nothing at all: the
// pre-save state stands and the same key retries cleanly. When the
// batch fails because a concurrent save with the same key committed
// first (the ledger primary key rejects ours, body included), the
// persisted ledger arbitrates the real outcome instead of surfacing
// a spurious error.
async function commitCreate(
  db: Db,
  requestId: string,
  kind: string,
  hash: string,
  items: BatchItem[],
): Promise<{ committed: true; results: unknown } | { committed: false; claim: Claim }> {
  try {
    const results: unknown = await db.batch(items as [BatchItem, ...BatchItem[]]);
    return { committed: true, results };
  } catch (err) {
    const claim = await arbitrateCreate(db, requestId, kind, hash);
    if (claim.state === "fresh") throw err;
    return { committed: false, claim };
  }
}

// The new row's id from a committed batch: `index` is the position of
// the body's `.returning({ id })` insert within the batch items.
function batchInsertId(results: unknown, index: number): number {
  const per = (results as unknown[])[index] as Array<{ id: number }> | undefined;
  const row = per?.[0];
  if (!row) throw new Error("atomic save: batch body insert returned no row");
  return row.id;
}

// The tombstone half of a delete, batched WITH the delete itself:
// stamp every ledger row that created this entity, in one UPDATE.
// Delete + tombstone commit together or not at all, so a failed
// tombstone can no longer leave a deleted row answering "replayed".
function tombstoneStmt(
  db: Db,
  resultTable: ResultTableName,
  resultId: number,
): BatchItem {
  return db
    .update(schema.requestKeys)
    .set({ deleted: 1 })
    .where(
      and(
        eq(schema.requestKeys.resultTable, resultTable),
        eq(schema.requestKeys.resultId, resultId),
      ),
    );
}

// Run a soft-delete update and its ledger tombstone as one atomic
// batch. Returns true when the row was actually deleted by this call.
async function commitDelete(
  db: Db,
  deleteStmt: BatchItem,
  resultTable: ResultTableName,
  resultId: number,
): Promise<boolean> {
  const results: unknown = await db.batch([
    deleteStmt,
    tombstoneStmt(db, resultTable, resultId),
  ] as [BatchItem, ...BatchItem[]]);
  const rows = (results as unknown[])[0] as Array<{ id: number }> | undefined;
  return (rows?.length ?? 0) > 0;
}

// The one user-supplied seed row (verbatim build request): the owner's
// own first book. importStatus "pending" — the brief states the
// official free EPUB is staged on the owner's machine awaiting import;
// nothing here claims the full text is imported.
const SEED_BOOK = {
  title: "纳瓦尔宝典",
  author: "Eric Jorgenson",
  source: "owner" as const,
  status: "want" as const,
  note: "The Almanack of Naval Ravikant。官方免费 EPUB 已暂存于所有者本地，待导入。",
  importStatus: "pending" as const,
};

let seedInFlight: Promise<void> | null = null;
async function ensureSeeded(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .limit(1);
  if (existing.length > 0) return;
  if (!seedInFlight) {
    seedInFlight = (async () => {
      const again = await db
        .select({ id: schema.books.id })
        .from(schema.books)
        .limit(1);
      if (again.length === 0) {
        await db.insert(schema.books).values(SEED_BOOK);
      }
    })().finally(() => {
      seedInFlight = null;
    });
  }
  await seedInFlight;
}

// ---------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------

const saveStatus = z.enum([
  "saved",
  "replayed",
  "conflict",
  "deleted",
  "notFound",
  "refused",
]);

const createResult = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  status: saveStatus,
  id: z.number().nullable(),
  // The ledger's recorded result id for this request key: on a
  // replay it equals id; on a payload conflict it is the id of the
  // row the ORIGINAL save committed (null when the ledger has no
  // recorded result), so the client can locate exactly that row
  // instead of guessing one by snippet or list position.
  resultId: z.number().nullable(),
});

const okResult = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  status: saveStatus,
});

function refusedCreate(): z.infer<typeof createResult> {
  return { ok: false, forbidden: true, status: "refused", id: null, resultId: null };
}
function refusedOk(): z.infer<typeof okResult> {
  return { ok: false, forbidden: true, status: "refused" };
}

// beginImport's result: createResult plus the generation binding.
// `gen` echoes the generation this call owns (== the requestId on a
// fresh save; the ledger's original key on a replay), so the client
// binds every later import write to exactly this generation.
const importBeginResult = createResult.extend({ gen: z.string().nullable() });

type ImportBeginResult = z.infer<typeof importBeginResult>;

function refusedImportBegin(): ImportBeginResult {
  return { ok: false, forbidden: true, status: "refused", id: null, resultId: null, gen: null };
}

function importBeginFromClaim(claim: Claim, gen: string | null): ImportBeginResult | null {
  const mapped = claimToResult(claim);
  if (!mapped) return null;
  return { ...mapped, gen };
}

// askSnippetQuestion's response: the answer PLUS the pinned
// citation binding of exactly this ask (CMP-READ-001 closure). The
// binding fields are null on every non-answered response — a
// refused/notFound ask binds nothing.
const askSnippetResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  status: z.enum(["answered", "refused", "notFound"]),
  answer: z.string(),
  // Model-suggested one-line core for the knowledge card. Always
  // labeled 建议 in the UI and owner-editable before saving.
  suggestedCore: z.string().nullable(),
  // Fixed provenance snapshot of the snippet being discussed,
  // taken from the stored row at response time.
  sourceText: z.string(),
  sourceLabel: z.string(),
  // The questionRequestId this response consumed (echoed verbatim
  // from the request; null when the caller sent none), and the
  // snippet id + stored version the answer was actually produced
  // against. Together with sourceText/sourceLabel these pin the
  // turn's citation: the client stores them on the turn and shows
  // THIS snapshot via 「查看本次原文」, even after the library row
  // moves on.
  questionRequestId: z.string().nullable(),
  snippetId: z.number().nullable(),
  snippetVersion: z.number().nullable(),
});

const bookSchema = z.object({
  id: z.number(),
  title: z.string(),
  author: z.string().nullable(),
  source: z.enum(["owner", "claude"]),
  status: z.enum(["want", "reading", "done"]),
  note: z.string().nullable(),
  importStatus: z.enum(["none", "pending", "processing", "failed", "ready"]),
  importError: z.string().nullable(),
  versionLabel: z.string().nullable(),
  curChapter: z.number(),
  curOffset: z.number(),
  progressValue: z.number().nullable(),
  progressUnit: z.enum(["page", "chapter"]).nullable(),
  chapterCount: z.number(),
  version: z.number(),
  createdAt: z.string(),
});

const sessionSchema = z.object({
  id: z.number(),
  bookId: z.number().nullable(),
  bookTitle: z.string().nullable(),
  date: z.string(),
  minutes: z.number().nullable(),
  progressValue: z.number().nullable(),
  progressUnit: z.enum(["page", "chapter"]).nullable(),
  note: z.string().nullable(),
});

const tagPairSchema = z.object({
  tag: z.string(),
  origin: z.enum(["owner", "suggested"]),
});

const snippetSchema = z.object({
  id: z.number(),
  bookId: z.number().nullable(),
  bookTitle: z.string(),
  versionLabel: z.string().nullable(),
  chapterLabel: z.string().nullable(),
  chapterIdx: z.number().nullable(),
  charOffset: z.number().nullable(),
  text: z.string(),
  source: z.enum(["reader", "paste", "ocr", "chat"]),
  status: z.enum(["draft", "saved"]),
  thinkPrompt: z.string().nullable(),
  reflection: z.string().nullable(),
  internalized: z.boolean(),
  tags: z.array(tagPairSchema),
  cardIds: z.array(z.number()),
  version: z.number(),
  createdAt: z.string(),
});

const cardSchema = z.object({
  id: z.number(),
  core: z.string(),
  snippetId: z.number().nullable(),
  sourceLabel: z.string().nullable(),
  // Q&A discussion binding: the pinned citation of the ONE ask this
  // card was distilled from (all null for cards not made from a
  // Q&A turn). Read back verbatim from the stored row — the panel
  // and the cards tab show the citation the card actually carries.
  qaQuestionRequestId: z.string().nullable(),
  qaSnippetVersion: z.number().nullable(),
  qaSourceText: z.string().nullable(),
  qaSourceLabel: z.string().nullable(),
  annotation: z.string().nullable(),
  origin: z.enum(["ui", "chat"]),
  tags: z.array(tagPairSchema),
  reuseCount: z.number(),
  lastReuseDate: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
});

const reuseSchema = z.object({
  id: z.number(),
  cardId: z.number(),
  cardCore: z.string(),
  date: z.string(),
  scene: z.string(),
  outcome: z.string(),
  createdAt: z.string(),
});

type BookRow = typeof schema.books.$inferSelect;
type SnippetRow = typeof schema.snippets.$inferSelect;
type CardRow = typeof schema.knowledgeCards.$inferSelect;

function toBook(row: BookRow, chapterCount: number): z.infer<typeof bookSchema> {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    source: row.source,
    status: row.status,
    note: row.note,
    importStatus: row.importStatus,
    importError: row.importError,
    versionLabel: row.versionLabel,
    curChapter: row.curChapter,
    curOffset: row.curOffset,
    progressValue: row.progressValue,
    progressUnit: row.progressUnit,
    chapterCount,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSnippet(
  row: SnippetRow,
  tags: Array<{ tag: string; origin: "owner" | "suggested" }>,
  cardIds: number[],
): z.infer<typeof snippetSchema> {
  return {
    id: row.id,
    bookId: row.bookId,
    bookTitle: row.bookTitle,
    versionLabel: row.versionLabel,
    chapterLabel: row.chapterLabel,
    chapterIdx: row.chapterIdx,
    charOffset: row.charOffset,
    text: row.text,
    source: row.source,
    status: row.status,
    thinkPrompt: row.thinkPrompt,
    reflection: row.reflection,
    internalized: row.internalizedAt != null,
    tags,
    cardIds,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

function toCard(
  row: CardRow,
  tags: Array<{ tag: string; origin: "owner" | "suggested" }>,
  reuseCount: number,
  lastReuseDate: string | null,
): z.infer<typeof cardSchema> {
  return {
    id: row.id,
    core: row.core,
    snippetId: row.snippetId,
    sourceLabel: row.sourceLabel,
    qaQuestionRequestId: row.qaQuestionRequestId,
    qaSnippetVersion: row.qaSnippetVersion,
    qaSourceText: row.qaSourceText,
    qaSourceLabel: row.qaSourceLabel,
    annotation: row.annotation,
    origin: row.origin,
    tags,
    reuseCount,
    lastReuseDate,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadTags(
  db: Db,
): Promise<{
  bySnippet: Map<number, Array<{ tag: string; origin: "owner" | "suggested" }>>;
  byCard: Map<number, Array<{ tag: string; origin: "owner" | "suggested" }>>;
}> {
  const sTags = await db.select().from(schema.snippetTags);
  const cTags = await db.select().from(schema.cardTags);
  const bySnippet = new Map<number, Array<{ tag: string; origin: "owner" | "suggested" }>>();
  for (const t of sTags) {
    const arr = bySnippet.get(t.snippetId) ?? [];
    arr.push({ tag: t.tag, origin: t.origin });
    bySnippet.set(t.snippetId, arr);
  }
  const byCard = new Map<number, Array<{ tag: string; origin: "owner" | "suggested" }>>();
  for (const t of cTags) {
    const arr = byCard.get(t.cardId) ?? [];
    arr.push({ tag: t.tag, origin: t.origin });
    byCard.set(t.cardId, arr);
  }
  return { bySnippet, byCard };
}

// ---------------------------------------------------------------------
// Dashboard / library reads
// ---------------------------------------------------------------------

const dashboardResponse = z.object({
  forbidden: z.boolean(),
  today: z.string(),
  totals: z.object({
    cardTotal: z.number(),
    reusedCardCount: z.number(),
    reuseTotal: z.number(),
    streakDays: z.number(),
    readingDays: z.number(),
    knownMinutes: z.number(),
    unknownMinutesCount: z.number(),
  }),
  // Cumulative knowledge cards by real save day (LA). Never backfilled.
  series: z.array(z.object({ date: z.string(), cards: z.number() })),
  savor: snippetSchema.nullable(),
  recentCards: z.array(cardSchema),
  recentReuses: z.array(reuseSchema),
});

type Dashboard = z.infer<typeof dashboardResponse>;

function forbiddenDashboard(): Dashboard {
  return {
    forbidden: true,
    today: todayKey(),
    totals: {
      cardTotal: 0,
      reusedCardCount: 0,
      reuseTotal: 0,
      streakDays: 0,
      readingDays: 0,
      knownMinutes: 0,
      unknownMinutesCount: 0,
    },
    series: [],
    savor: null,
    recentCards: [],
    recentReuses: [],
  };
}

const libraryResponse = z.object({
  forbidden: z.boolean(),
  today: z.string(),
  books: z.array(bookSchema),
  sessions: z.array(sessionSchema),
  snippets: z.array(snippetSchema),
  cards: z.array(cardSchema),
  reuses: z.array(reuseSchema),
});

function forbiddenLibrary(): z.infer<typeof libraryResponse> {
  return {
    forbidden: true,
    today: todayKey(),
    books: [],
    sessions: [],
    snippets: [],
    cards: [],
    reuses: [],
  };
}

async function loadAll(db: Db) {
  const [bookRows, chapterRows, sessionRows, snippetRows, cardRows, reuseRows, tags] =
    await Promise.all([
      db
        .select()
        .from(schema.books)
        .where(isNull(schema.books.deletedAt))
        .orderBy(asc(schema.books.id)),
      db
        .select({ bookId: schema.bookChapters.bookId, idx: schema.bookChapters.idx })
        .from(schema.bookChapters),
      db
        .select()
        .from(schema.readingSessions)
        .where(isNull(schema.readingSessions.deletedAt))
        .orderBy(asc(schema.readingSessions.id)),
      db
        .select()
        .from(schema.snippets)
        .where(isNull(schema.snippets.deletedAt))
        .orderBy(asc(schema.snippets.id)),
      db
        .select()
        .from(schema.knowledgeCards)
        .where(isNull(schema.knowledgeCards.deletedAt))
        .orderBy(asc(schema.knowledgeCards.id)),
      db
        .select()
        .from(schema.cardReuses)
        .orderBy(asc(schema.cardReuses.id)),
      loadTags(db),
    ]);
  return { bookRows, chapterRows, sessionRows, snippetRows, cardRows, reuseRows, tags };
}

function assembleLibrary(data: Awaited<ReturnType<typeof loadAll>>, today: string) {
  const chapterCounts = new Map<number, number>();
  for (const c of data.chapterRows) {
    chapterCounts.set(c.bookId, (chapterCounts.get(c.bookId) ?? 0) + 1);
  }
  const bookTitleById = new Map(data.bookRows.map((b) => [b.id, b.title]));
  const cardCoreById = new Map(data.cardRows.map((c) => [c.id, c.core]));
  const cardIdsBySnippet = new Map<number, number[]>();
  for (const c of data.cardRows) {
    if (c.snippetId != null) {
      const arr = cardIdsBySnippet.get(c.snippetId) ?? [];
      arr.push(c.id);
      cardIdsBySnippet.set(c.snippetId, arr);
    }
  }
  const reuseCountByCard = new Map<number, number>();
  const lastReuseByCard = new Map<number, string>();
  for (const r of data.reuseRows) {
    reuseCountByCard.set(r.cardId, (reuseCountByCard.get(r.cardId) ?? 0) + 1);
    const prev = lastReuseByCard.get(r.cardId);
    if (!prev || r.date > prev) lastReuseByCard.set(r.cardId, r.date);
  }
  return {
    forbidden: false,
    today,
    books: data.bookRows.map((b) => toBook(b, chapterCounts.get(b.id) ?? 0)),
    sessions: data.sessionRows.map((s) => ({
      id: s.id,
      bookId: s.bookId,
      bookTitle: s.bookId != null ? (bookTitleById.get(s.bookId) ?? null) : null,
      date: s.date,
      minutes: s.minutes,
      progressValue: s.progressValue,
      progressUnit: s.progressUnit,
      note: s.note,
    })),
    snippets: data.snippetRows.map((s) =>
      toSnippet(s, data.tags.bySnippet.get(s.id) ?? [], cardIdsBySnippet.get(s.id) ?? []),
    ),
    cards: data.cardRows.map((c) =>
      toCard(
        c,
        data.tags.byCard.get(c.id) ?? [],
        reuseCountByCard.get(c.id) ?? 0,
        lastReuseByCard.get(c.id) ?? null,
      ),
    ),
    reuses: data.reuseRows
      .filter((r) => cardCoreById.has(r.cardId))
      .map((r) => ({
        id: r.id,
        cardId: r.cardId,
        cardCore: cardCoreById.get(r.cardId) ?? "",
        date: r.date,
        scene: r.scene,
        outcome: r.outcome,
        createdAt: r.createdAt.toISOString(),
      })),
  };
}

// Generation binding for the import write points (CMP-READ-IMPORT-001).
// A call carrying `importId` (the beginImport requestId that opened
// the generation) binds ONLY to that generation: it must still own
// the book, otherwise the write is a late arrival from a superseded
// generation and is refused with a typed conflict — zero DB writes,
// zero blob writes. A call WITHOUT importId is a legacy client: it
// binds to the book's current generation when one exists (the only
// generation it can mean), and to the legacy direct-write path
// (gen === null) for books whose import predates generations.
type ImportBinding =
  | { bound: true; book: BookRow; gen: string | null }
  | { bound: false; result: z.infer<typeof okResult> };

async function resolveImportBinding(
  db: Db,
  bookId: number,
  importId: string | undefined,
): Promise<ImportBinding> {
  const found = await db
    .select()
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), isNull(schema.books.deletedAt)))
    .limit(1);
  const book = found[0];
  if (!book) {
    return { bound: false, result: { ok: false, forbidden: false, status: "notFound" } };
  }
  if (importId !== undefined && book.importGen !== importId) {
    // Bound to a generation that no longer owns this book (or never
    // did): refuse explicitly, touch nothing.
    return { bound: false, result: { ok: false, forbidden: false, status: "conflict" } };
  }
  return { bound: true, book, gen: importId ?? book.importGen };
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<Dashboard> {
      if (!isOwner(ctx)) return forbiddenDashboard();
      await ensureSeeded(ctx);
      const db = ctx.db<typeof schema>();
      const today = todayKey();
      const data = await loadAll(db);
      const lib = assembleLibrary(data, today);

      // Reading days/minutes come ONLY from explicit reading sessions.
      const readingDates = new Set(data.sessionRows.map((s) => s.date));
      let knownMinutes = 0;
      let unknownMinutesCount = 0;
      for (const s of data.sessionRows) {
        if (s.minutes == null) unknownMinutesCount += 1;
        else knownMinutes += s.minutes;
      }

      // Cumulative cards by the LA day of each card's real save time.
      const perDay = new Map<string, number>();
      let firstDay: string | null = null;
      for (const c of data.cardRows) {
        const day = laDateKey(c.createdAt);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
        if (firstDay == null || day < firstDay) firstDay = day;
      }
      const series: Array<{ date: string; cards: number }> = [];
      if (firstDay != null) {
        let cum = 0;
        let cursor = firstDay;
        for (let i = 0; i < 3700 && cursor <= today; i += 1) {
          cum += perDay.get(cursor) ?? 0;
          series.push({ date: cursor, cards: cum });
          cursor = shiftDay(cursor, 1);
        }
      }

      // 片刻回味 rotation: deterministic by LA day over saved,
      // non-deleted snippets. Viewing it changes nothing anywhere.
      const savedSnippets = data.snippetRows.filter((s) => s.status === "saved");
      let savor: z.infer<typeof snippetSchema> | null = null;
      if (savedSnippets.length > 0) {
        const dayNumber = Math.floor(
          Date.UTC(
            Number(today.slice(0, 4)),
            Number(today.slice(5, 7)) - 1,
            Number(today.slice(8, 10)),
          ) / 86400000,
        );
        const pick = savedSnippets[dayNumber % savedSnippets.length];
        if (pick) {
          const cardIds = data.cardRows
            .filter((c) => c.snippetId === pick.id)
            .map((c) => c.id);
          savor = toSnippet(pick, data.tags.bySnippet.get(pick.id) ?? [], cardIds);
        }
      }

      const liveCardIds = new Set(data.cardRows.map((c) => c.id));
      const liveReuses = data.reuseRows.filter((r) => liveCardIds.has(r.cardId));
      return {
        forbidden: false,
        today,
        totals: {
          cardTotal: data.cardRows.length,
          reusedCardCount: new Set(liveReuses.map((r) => r.cardId)).size,
          reuseTotal: liveReuses.length,
          streakDays: currentStreak(readingDates, today),
          readingDays: readingDates.size,
          knownMinutes,
          unknownMinutesCount,
        },
        series,
        savor,
        recentCards: [...lib.cards].slice(-5).reverse(),
        recentReuses: [...lib.reuses].slice(-5).reverse(),
      };
    },
  }),

  getLibrary: defineAction({
    request: z.object({}),
    response: libraryResponse,
    async handler(ctx): Promise<z.infer<typeof libraryResponse>> {
      if (!isOwner(ctx)) return forbiddenLibrary();
      await ensureSeeded(ctx);
      const db = ctx.db<typeof schema>();
      const data = await loadAll(db);
      return assembleLibrary(data, todayKey());
    },
  }),

  // -------------------------------------------------------------------
  // Books
  // -------------------------------------------------------------------

  addBook: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(300),
      author: z.string().trim().max(200).optional(),
      source: z.enum(["owner", "claude"]),
      status: z.enum(["want", "reading", "done"]).default("want"),
      note: z.string().trim().max(1000).optional(),
      // "none" for list-only entries (e.g. WeRead shelf by 口述）;
      // "pending" when the owner has the EPUB and will import it.
      importStatus: z.enum(["none", "pending"]).default("none"),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const hash = payloadHash({
        k: "book",
        title: args.title,
        author: args.author || null,
        source: args.source,
        status: args.status,
        note: args.note || null,
        importStatus: args.importStatus,
      });
      const claim = await arbitrateCreate(db, args.requestId, "book", hash);
      const early = claimToResult(claim);
      if (early) return early;
      const outcome = await commitCreate(db, args.requestId, "book", hash, [
        db
          .insert(schema.books)
          .values({
            title: args.title,
            author: args.author || null,
            source: args.source,
            status: args.status,
            note: args.note || null,
            importStatus: args.importStatus,
            requestId: args.requestId,
          })
          .returning({ id: schema.books.id }),
        ledgerInsertStmt(db, args.requestId, "book", hash, "books"),
        ledgerResultStmt(db, args.requestId, "books"),
      ]);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("addBook: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),

  updateBook: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      version: z.number().int().positive(),
      title: z.string().trim().min(1).max(300).optional(),
      author: z.string().trim().max(200).nullable().optional(),
      status: z.enum(["want", "reading", "done"]).optional(),
      note: z.string().trim().max(1000).nullable().optional(),
      progressValue: z.number().min(0).nullable().optional(),
      progressUnit: z.enum(["page", "chapter"]).nullable().optional(),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const patch: Partial<typeof schema.books.$inferInsert> = {
        updatedAt: new Date(),
        version: args.version + 1,
      };
      if (args.title !== undefined) patch.title = args.title;
      if (args.author !== undefined) patch.author = args.author || null;
      if (args.status !== undefined) patch.status = args.status;
      if (args.note !== undefined) patch.note = args.note || null;
      if (args.progressValue !== undefined) patch.progressValue = args.progressValue;
      if (args.progressUnit !== undefined) patch.progressUnit = args.progressUnit;
      const updated = await db
        .update(schema.books)
        .set(patch)
        .where(
          and(
            eq(schema.books.id, args.id),
            eq(schema.books.version, args.version),
            isNull(schema.books.deletedAt),
          ),
        )
        .returning({ id: schema.books.id });
      if (updated.length === 0) {
        const exists = await db
          .select({ id: schema.books.id })
          .from(schema.books)
          .where(and(eq(schema.books.id, args.id), isNull(schema.books.deletedAt)))
          .limit(1);
        return {
          ok: false,
          forbidden: false,
          status: exists.length > 0 ? "conflict" : "notFound",
        };
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  deleteBook: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const deleted = await commitDelete(
        db,
        db
          .update(schema.books)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.books.id, args.id), isNull(schema.books.deletedAt)))
          .returning({ id: schema.books.id }),
        "books",
        args.id,
      );
      if (!deleted) return { ok: false, forbidden: false, status: "notFound" };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // -------------------------------------------------------------------
  // Reading sessions — the ONLY rows that count as reading days.
  // -------------------------------------------------------------------

  logReading: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      bookId: z.number().int().positive().nullable().optional(),
      date: z.string().regex(dateKeyRe, "date must be YYYY-MM-DD").optional(),
      // Omitted/null = duration unknown. Never backfilled.
      minutes: z.number().int().min(0).max(1440).nullable().optional(),
      progressValue: z.number().min(0).nullable().optional(),
      progressUnit: z.enum(["page", "chapter"]).nullable().optional(),
      note: z.string().trim().max(500).optional(),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const date = args.date ?? todayKey();
      const hash = payloadHash({
        k: "reading",
        bookId: args.bookId ?? null,
        date,
        minutes: args.minutes ?? null,
        progressValue: args.progressValue ?? null,
        progressUnit: args.progressUnit ?? null,
        note: args.note || null,
      });
      const claim = await arbitrateCreate(db, args.requestId, "reading", hash);
      const early = claimToResult(claim);
      if (early) return early;
      let bookId = args.bookId ?? null;
      if (bookId != null) {
        const found = await db
          .select({ id: schema.books.id })
          .from(schema.books)
          .where(and(eq(schema.books.id, bookId), isNull(schema.books.deletedAt)))
          .limit(1);
        if (found.length === 0) bookId = null;
      }
      // The session row, its ledger entry and the book's progress
      // marker commit as one batch — a failure anywhere leaves none
      // of them behind.
      const items: BatchItem[] = [
        db
          .insert(schema.readingSessions)
          .values({
            bookId,
            date,
            minutes: args.minutes ?? null,
            progressValue: args.progressValue ?? null,
            progressUnit: args.progressUnit ?? null,
            note: args.note || null,
            requestId: args.requestId,
          })
          .returning({ id: schema.readingSessions.id }),
        ledgerInsertStmt(db, args.requestId, "reading", hash, "reading_sessions"),
        ledgerResultStmt(db, args.requestId, "reading_sessions"),
      ];
      // A progress report on the session also moves the book's own
      // progress marker (same unit, owner's number verbatim).
      if (bookId != null && args.progressValue != null) {
        items.push(
          db
            .update(schema.books)
            .set({
              progressValue: args.progressValue,
              progressUnit: args.progressUnit ?? null,
              updatedAt: new Date(),
            })
            .where(eq(schema.books.id, bookId)),
        );
      }
      const outcome = await commitCreate(db, args.requestId, "reading", hash, items);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("logReading: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),

  deleteReadingSession: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const deleted = await commitDelete(
        db,
        db
          .update(schema.readingSessions)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(schema.readingSessions.id, args.id),
              isNull(schema.readingSessions.deletedAt),
            ),
          )
          .returning({ id: schema.readingSessions.id }),
        "reading_sessions",
        args.id,
      );
      if (!deleted) return { ok: false, forbidden: false, status: "notFound" };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // -------------------------------------------------------------------
  // EPUB import. The browser parses the file; the server only stores
  // what the browser extracted (sanitized chapter HTML) plus the
  // original bytes in a private blob. No book text is ever fetched
  // from, or uploaded to, any external service.
  //
  // Generation discipline (CMP-READ-IMPORT-001): see the header
  // comment. The flow is beginImport (ledger-arbitrated generation
  // claim) → uploadImportFile + saveImportChapters (staged under the
  // generation, invisible to readers) → finishImport (validate the
  // staged generation, then promote it atomically). Every write
  // point can fail or lose its response and be retried under the
  // original key without touching the live copy.
  // -------------------------------------------------------------------

  beginImport: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(300),
      author: z.string().trim().max(200).optional(),
      source: z.enum(["owner", "claude"]).default("owner"),
      versionLabel: z.string().trim().max(200).optional(),
      // Set when re-importing into an existing book row (retry after a
      // failed import must not create a duplicate book).
      existingBookId: z.number().int().positive().nullable().optional(),
    }),
    response: importBeginResult,
    async handler(ctx, args): Promise<ImportBeginResult> {
      if (!isOwner(ctx)) return refusedImportBegin();
      const db = ctx.db<typeof schema>();
      // Ledger arbitration comes FIRST on both paths, with a
      // fingerprint of the full effective payload (CMP-READ-IMPORT-001:
      // the existing-book path used to skip the ledger entirely, so a
      // replayed begin wiped a finished import's chapters and flipped
      // it back to "processing"). Same key + same payload → the
      // original result, zero writes. Same key + other payload →
      // typed conflict. Key of a since-deleted book → typed deleted.
      if (args.existingBookId != null) {
        const hash = payloadHash({
          k: "import-book",
          existingBookId: args.existingBookId,
          versionLabel: args.versionLabel || null,
        });
        const claim = await arbitrateCreate(db, args.requestId, "import-book", hash);
        const early = importBeginFromClaim(claim, args.requestId);
        if (early) return early;
        const found = await db
          .select()
          .from(schema.books)
          .where(
            and(eq(schema.books.id, args.existingBookId), isNull(schema.books.deletedAt)),
          )
          .limit(1);
        const book = found[0];
        if (!book) {
          return { ok: false, forbidden: false, status: "notFound", id: null, resultId: null, gen: null };
        }
        // Fresh generation claim, committed WITH the ledger row as
        // one batch: claim the staging area (importGen = this key),
        // drop any superseded generations' staged chapters, and mark
        // the book processing. The LIVE chapters, file pointer and
        // reading position are NOT touched — the previous good copy
        // stays fully readable until this generation is promoted by
        // finishImport.
        const outcome = await commitCreate(db, args.requestId, "import-book", hash, [
          db
            .delete(schema.importStagedChapters)
            .where(eq(schema.importStagedChapters.bookId, book.id)),
          db
            .update(schema.books)
            .set({
              importStatus: "processing",
              importError: null,
              importGen: args.requestId,
              importBlobKey: null,
              versionLabel: args.versionLabel || book.versionLabel,
              updatedAt: new Date(),
            })
            .where(and(eq(schema.books.id, book.id), isNull(schema.books.deletedAt))),
          db.insert(schema.requestKeys).values({
            requestId: args.requestId,
            kind: "import-book",
            payloadHash: hash,
            resultTable: "books",
            resultId: book.id,
          }),
        ]);
        if (!outcome.committed) {
          const mapped = importBeginFromClaim(outcome.claim, args.requestId);
          if (mapped) return mapped;
          throw new Error("beginImport: arbitration returned fresh after a failed commit");
        }
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, status: "saved", id: book.id, resultId: book.id, gen: args.requestId };
      }
      const hash = payloadHash({
        k: "import-book",
        title: args.title,
        author: args.author || null,
        source: args.source,
        versionLabel: args.versionLabel || null,
      });
      const claim = await arbitrateCreate(db, args.requestId, "import-book", hash);
      const early = importBeginFromClaim(claim, args.requestId);
      if (early) return early;
      const outcome = await commitCreate(db, args.requestId, "import-book", hash, [
        db
          .insert(schema.books)
          .values({
            title: args.title,
            author: args.author || null,
            source: args.source,
            status: "want",
            importStatus: "processing",
            versionLabel: args.versionLabel || null,
            importGen: args.requestId,
            requestId: args.requestId,
          })
          .returning({ id: schema.books.id }),
        ledgerInsertStmt(db, args.requestId, "import-book", hash, "books"),
        ledgerResultStmt(db, args.requestId, "books"),
      ]);
      if (!outcome.committed) {
        const mapped = importBeginFromClaim(outcome.claim, args.requestId);
        if (mapped) return mapped;
        throw new Error("beginImport: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id, gen: args.requestId };
    },
  }),

  uploadImportFile: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      // The beginImport requestId that opened this import generation.
      // Optional for legacy clients (see resolveImportBinding).
      importId: z.string().trim().min(1).max(120).optional(),
      dataBase64: z.string().min(1),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      // Binding arbitration precedes ANY blob write: a stale
      // generation's file never lands anywhere.
      const binding = await resolveImportBinding(db, args.bookId, args.importId);
      if (!binding.bound) return binding.result;
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (binding.gen == null) {
        // Legacy path (book predates generations): the historical
        // direct write to the live key.
        const key = `epub/${args.bookId}.epub`;
        await ctx.blobs.put(key, bytes, { contentType: "application/epub+zip" });
        await db
          .update(schema.books)
          .set({ blobKey: key, updatedAt: new Date() })
          .where(eq(schema.books.id, args.bookId));
        return { ok: true, forbidden: false, status: "saved" };
      }
      // Generation path: the file stages under a per-generation key
      // and is recorded as this generation's staged pointer. The
      // LIVE blobKey (the previous good copy's file) is untouched
      // until finishImport promotes this generation.
      const key = `epub-stage/${args.bookId}/${binding.gen}`;
      await ctx.blobs.put(key, bytes, { contentType: "application/epub+zip" });
      const updated = await db
        .update(schema.books)
        .set({ importBlobKey: key, updatedAt: new Date() })
        .where(
          and(
            eq(schema.books.id, args.bookId),
            eq(schema.books.importGen, binding.gen),
            isNull(schema.books.deletedAt),
          ),
        )
        .returning({ id: schema.books.id });
      if (updated.length === 0) {
        // The generation lost ownership between the binding check
        // and this write (a newer begin committed first). The staged
        // blob is orphaned under its generation key — never pointed
        // at by any row — and the write is refused honestly.
        return { ok: false, forbidden: false, status: "conflict" };
      }
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  saveImportChapters: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      // The beginImport requestId that opened this import generation.
      // Optional for legacy clients (see resolveImportBinding).
      importId: z.string().trim().min(1).max(120).optional(),
      chapters: z
        .array(
          z.object({
            idx: z.number().int().min(0),
            title: z.string().max(300).nullable(),
            html: z.string(),
          }),
        )
        .min(1)
        .max(12),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const binding = await resolveImportBinding(db, args.bookId, args.importId);
      if (!binding.bound) return binding.result;
      const { book } = binding;
      if (book.importStatus !== "processing") {
        return { ok: false, forbidden: false, status: "conflict" };
      }
      // Duplicate idx inside one payload is arbitrated explicitly:
      // the LAST occurrence wins, so a chunk never carries two rival
      // versions of the same chapter position.
      const byIdx = new Map<number, { idx: number; title: string | null; html: string }>();
      for (const ch of args.chapters) byIdx.set(ch.idx, ch);
      const chunk = [...byIdx.values()];
      // The whole chunk commits as one batch: a failure mid-chunk
      // stores none of it, so a retry re-sends the same chunk whole.
      const items: BatchItem[] = [];
      if (binding.gen == null) {
        // Legacy path (book predates generations): chapters land
        // directly in the live table, as imports always did.
        const existing = await db
          .select({ id: schema.bookChapters.id, idx: schema.bookChapters.idx })
          .from(schema.bookChapters)
          .where(eq(schema.bookChapters.bookId, args.bookId));
        const existingByIdx = new Map(existing.map((r) => [r.idx, r.id]));
        for (const ch of chunk) {
          const values = {
            bookId: args.bookId,
            idx: ch.idx,
            title: ch.title,
            html: ch.html,
            charCount: ch.html.length,
          };
          const existingId = existingByIdx.get(ch.idx);
          if (existingId != null) {
            items.push(
              db.update(schema.bookChapters).set(values).where(eq(schema.bookChapters.id, existingId)),
            );
          } else {
            items.push(db.insert(schema.bookChapters).values(values));
          }
        }
      } else {
        // Generation path: chapters stage in isolation under
        // (book, gen). The live chapters are never touched here, so
        // a half-saved or superseded generation is invisible to the
        // reader. A re-sent idx upserts the one staged row (the
        // unique (book, gen, idx) index backs this arbitration).
        const gen = binding.gen;
        const existing = await db
          .select({ id: schema.importStagedChapters.id, idx: schema.importStagedChapters.idx })
          .from(schema.importStagedChapters)
          .where(
            and(
              eq(schema.importStagedChapters.bookId, args.bookId),
              eq(schema.importStagedChapters.gen, gen),
            ),
          );
        const existingByIdx = new Map(existing.map((r) => [r.idx, r.id]));
        for (const ch of chunk) {
          const values = {
            bookId: args.bookId,
            gen,
            idx: ch.idx,
            title: ch.title,
            html: ch.html,
            charCount: ch.html.length,
          };
          const existingId = existingByIdx.get(ch.idx);
          if (existingId != null) {
            items.push(
              db
                .update(schema.importStagedChapters)
                .set(values)
                .where(eq(schema.importStagedChapters.id, existingId)),
            );
          } else {
            items.push(db.insert(schema.importStagedChapters).values(values));
          }
        }
      }
      if (items.length > 0) {
        await db.batch(items as [BatchItem, ...BatchItem[]]);
      }
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  finishImport: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      // The beginImport requestId that opened this import generation.
      // Optional for legacy clients (see resolveImportBinding).
      importId: z.string().trim().min(1).max(120).optional(),
      ok: z.boolean(),
      error: z.string().trim().max(500).optional(),
      chapterCount: z.number().int().min(0).optional(),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const binding = await resolveImportBinding(db, args.bookId, args.importId);
      if (!binding.bound) return binding.result;
      const { book } = binding;

      if (binding.gen == null) {
        // Legacy path (book predates generations): the historical
        // direct behavior against the live chapters.
        if (args.ok) {
          const chapters = await db
            .select({ id: schema.bookChapters.id })
            .from(schema.bookChapters)
            .where(eq(schema.bookChapters.bookId, args.bookId));
          if (chapters.length === 0) {
            await db
              .update(schema.books)
              .set({
                importStatus: "failed",
                importError: "未存入任何章节",
                updatedAt: new Date(),
              })
              .where(eq(schema.books.id, args.bookId));
            ctx.invalidateQueries();
            return { ok: false, forbidden: false, status: "conflict" };
          }
          await db
            .update(schema.books)
            .set({
              importStatus: "ready",
              importError: null,
              curChapter: 0,
              curOffset: 0,
              updatedAt: new Date(),
            })
            .where(eq(schema.books.id, args.bookId));
        } else {
          await db
            .update(schema.books)
            .set({
              importStatus: "failed",
              importError: args.error || "导入失败",
              updatedAt: new Date(),
            })
            .where(eq(schema.books.id, args.bookId));
        }
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, status: "saved" };
      }

      const gen = binding.gen;

      // Idempotent replays of THIS generation's own finish (the
      // original response was lost in transit): the outcome is
      // already recorded, so answer from it and write nothing. A
      // finish claiming the OPPOSITE outcome for a generation that
      // already closed is a conflict — a late "success" must not
      // resurrect a failed generation, and a late "failure" must
      // never destroy a promoted good copy.
      if (book.importStatus === "ready") {
        return args.ok
          ? { ok: true, forbidden: false, status: "saved" }
          : { ok: false, forbidden: false, status: "conflict" };
      }
      if (book.importStatus === "failed") {
        return !args.ok
          ? { ok: true, forbidden: false, status: "saved" }
          : { ok: false, forbidden: false, status: "conflict" };
      }
      if (book.importStatus !== "processing") {
        return { ok: false, forbidden: false, status: "conflict" };
      }

      if (!args.ok) {
        // Failure of the CURRENT generation: only the status moves.
        // The live chapters, the live file pointer, the reading
        // position and every excerpt stay exactly as they were; the
        // staged generation is kept so the failure can be inspected
        // or the import retried under a new key.
        await db
          .update(schema.books)
          .set({
            importStatus: "failed",
            importError: args.error || "导入失败",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.books.id, args.bookId),
              eq(schema.books.importGen, gen),
              eq(schema.books.importStatus, "processing"),
            ),
          );
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, status: "saved" };
      }

      // Validate the staged generation BEFORE anything live moves:
      // it must contain every chapter position 0..max contiguously
      // (a lost chunk in the middle would promote a book with a
      // hole), and when the client reports how many chapters it
      // parsed, the staged count must equal that report exactly.
      const staged = await db
        .select({ idx: schema.importStagedChapters.idx })
        .from(schema.importStagedChapters)
        .where(
          and(
            eq(schema.importStagedChapters.bookId, args.bookId),
            eq(schema.importStagedChapters.gen, gen),
          ),
        )
        .orderBy(asc(schema.importStagedChapters.idx));
      const idxs = new Set(staged.map((r) => r.idx));
      let complete = staged.length > 0;
      for (let i = 0; complete && i < staged.length; i += 1) {
        if (!idxs.has(i)) complete = false;
      }
      if (args.chapterCount != null && args.chapterCount !== staged.length) {
        complete = false;
      }
      if (!complete) {
        // Claiming ready over an incomplete generation would publish
        // a broken book; record THIS generation as failed instead.
        // The live copy is untouched, and the staged rows stay for
        // inspection / a retry under a new key.
        await db
          .update(schema.books)
          .set({
            importStatus: "failed",
            importError:
              staged.length === 0 ? "未存入任何章节" : "导入不完整：章节缺失或数量不符",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.books.id, args.bookId),
              eq(schema.books.importGen, gen),
              eq(schema.books.importStatus, "processing"),
            ),
          );
        ctx.invalidateQueries();
        return { ok: false, forbidden: false, status: "conflict" };
      }

      // Atomic promotion, ONE batch, every statement guarded on this
      // generation still owning the book in "processing": if a newer
      // generation claimed the book after the binding check, every
      // statement matches zero rows, nothing live changes, and the
      // post-check below answers conflict. The reader therefore only
      // ever sees the complete old version or the complete new one.
      const ownsBook = sql`(SELECT id FROM books WHERE id = ${args.bookId} AND import_gen = ${gen} AND import_status = 'processing')`;
      const promotedBlobKey = book.importBlobKey ?? book.blobKey;
      const results: unknown = await db.batch([
        db
          .delete(schema.bookChapters)
          .where(sql`${schema.bookChapters.bookId} IN ${ownsBook}`),
        // Raw-SQL insert-select (columns in the live table's own
        // order): NULL id lets the live table assign fresh ids —
        // staged ids belong to the staging table's sequence and could
        // collide with other books' live chapter ids.
        db
          .insert(schema.bookChapters)
          .select(
            sql`SELECT NULL, book_id, idx, title, html, char_count FROM import_staged_chapters WHERE book_id IN ${ownsBook} AND gen = ${gen}`,
          ),
        db
          .delete(schema.importStagedChapters)
          .where(
            and(
              eq(schema.importStagedChapters.bookId, args.bookId),
              eq(schema.importStagedChapters.gen, gen),
            ),
          ),
        db
          .update(schema.books)
          .set({
            importStatus: "ready",
            importError: null,
            blobKey: promotedBlobKey,
            importBlobKey: null,
            curChapter: 0,
            curOffset: 0,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.books.id, args.bookId),
              eq(schema.books.importGen, gen),
              eq(schema.books.importStatus, "processing"),
            ),
          )
          .returning({ id: schema.books.id }),
      ] as [BatchItem, ...BatchItem[]]);
      const bookUpdate = (results as unknown[])[3] as Array<{ id: number }> | undefined;
      if ((bookUpdate?.length ?? 0) === 0) {
        // The generation was superseded mid-finish; the guarded
        // statements changed nothing live.
        return { ok: false, forbidden: false, status: "conflict" };
      }
      // Best-effort cleanup of the PREVIOUS generation's staged file
      // (its pointer was just replaced). A cleanup failure never
      // fails the promotion: the old blob is simply orphaned.
      if (book.blobKey && book.blobKey !== promotedBlobKey) {
        try {
          await ctx.blobs.delete(book.blobKey);
        } catch {
          /* orphaned staged blob is harmless */
        }
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // -------------------------------------------------------------------
  // Reader
  // -------------------------------------------------------------------

  getChapter: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      idx: z.number().int().min(0),
    }),
    response: z.object({
      forbidden: z.boolean(),
      found: z.boolean(),
      title: z.string().nullable(),
      html: z.string(),
      toc: z.array(z.object({ idx: z.number(), title: z.string() })),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { forbidden: true, found: false, title: null, html: "", toc: [] };
      const db = ctx.db<typeof schema>();
      const book = await db
        .select({ id: schema.books.id })
        .from(schema.books)
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .limit(1);
      if (book.length === 0) return { forbidden: false, found: false, title: null, html: "", toc: [] };
      const rows = await db
        .select()
        .from(schema.bookChapters)
        .where(eq(schema.bookChapters.bookId, args.bookId))
        .orderBy(asc(schema.bookChapters.idx));
      const toc = rows.map((r) => ({ idx: r.idx, title: r.title ?? `第 ${r.idx + 1} 节` }));
      const chapter = rows.find((r) => r.idx === args.idx);
      if (!chapter) return { forbidden: false, found: false, title: null, html: "", toc };
      return {
        forbidden: false,
        found: true,
        title: chapter.title,
        html: chapter.html,
        toc,
      };
    },
  }),

  savePosition: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      chapterIdx: z.number().int().min(0),
      charOffset: z.number().int().min(0),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.books)
        .set({
          curChapter: args.chapterIdx,
          curOffset: args.charOffset,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .returning({ id: schema.books.id });
      if (updated.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // -------------------------------------------------------------------
  // Snippets
  // -------------------------------------------------------------------

  createSnippet: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      bookId: z.number().int().positive(),
      text: z.string().trim().min(1).max(4000),
      chapterIdx: z.number().int().min(0).nullable().optional(),
      chapterLabel: z.string().trim().max(300).nullable().optional(),
      charOffset: z.number().int().min(0).nullable().optional(),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      // The fingerprint covers EVERY stored field, provenance
      // included: chapterLabel is part of the saved source, so the
      // same key re-sent with a different chapter is a conflict, not
      // a silent replay (CMP-READ-SAVE-001 repro ④).
      const hash = payloadHash({
        k: "snippet",
        bookId: args.bookId,
        text: args.text,
        chapterLabel: args.chapterLabel || null,
        chapterIdx: args.chapterIdx ?? null,
        charOffset: args.charOffset ?? null,
      });
      const claim = await arbitrateCreate(db, args.requestId, "snippet", hash);
      const early = claimToResult(claim);
      if (early) return early;
      const bookRows = await db
        .select()
        .from(schema.books)
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .limit(1);
      const book = bookRows[0];
      if (!book) return { ok: false, forbidden: false, status: "notFound", id: null, resultId: null };
      const outcome = await commitCreate(db, args.requestId, "snippet", hash, [
        db
          .insert(schema.snippets)
          .values({
            bookId: book.id,
            bookTitle: book.title,
            versionLabel: book.versionLabel,
            chapterLabel: args.chapterLabel || null,
            chapterIdx: args.chapterIdx ?? null,
            charOffset: args.charOffset ?? null,
            text: args.text,
            source: "reader",
            status: "saved",
            requestId: args.requestId,
          })
          .returning({ id: schema.snippets.id }),
        ledgerInsertStmt(db, args.requestId, "snippet", hash, "snippets"),
        ledgerResultStmt(db, args.requestId, "snippets"),
      ]);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("createSnippet: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),

  // 微信读书片段入口： pasted text (or OCR output) lands as a DRAFT.
  // It becomes a snippet only when the owner confirms the exact text
  // and provenance in confirmSnippetDraft. Nothing here touches any
  // WeRead API, cookie, or unofficial scraping.
  createSnippetDraft: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      source: z.enum(["paste", "ocr"]),
      text: z.string().trim().min(1).max(4000),
      bookTitle: z.string().trim().max(300).optional(),
      chapterLabel: z.string().trim().max(300).optional(),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const hash = payloadHash({
        k: "snippet-draft",
        source: args.source,
        text: args.text,
        bookTitle: args.bookTitle || null,
        chapterLabel: args.chapterLabel || null,
      });
      const claim = await arbitrateCreate(db, args.requestId, "snippet-draft", hash);
      const early = claimToResult(claim);
      if (early) return early;
      const outcome = await commitCreate(db, args.requestId, "snippet-draft", hash, [
        db
          .insert(schema.snippets)
          .values({
            bookId: null,
            bookTitle: args.bookTitle || "出处待确认",
            chapterLabel: args.chapterLabel || null,
            text: args.text,
            source: args.source,
            status: "draft",
            requestId: args.requestId,
          })
          .returning({ id: schema.snippets.id }),
        ledgerInsertStmt(db, args.requestId, "snippet-draft", hash, "snippets"),
        ledgerResultStmt(db, args.requestId, "snippets"),
      ]);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("createSnippetDraft: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),

  confirmSnippetDraft: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      version: z.number().int().positive(),
      text: z.string().trim().min(1).max(4000),
      bookTitle: z.string().trim().min(1).max(300),
      // Empty chapter label stays NULL and renders as 章节不详 — the
      // owner confirming "unknown" is a fact, not a gap to fill.
      chapterLabel: z.string().trim().max(300).nullable().optional(),
      bookId: z.number().int().positive().nullable().optional(),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.snippets)
        .set({
          text: args.text,
          bookTitle: args.bookTitle,
          chapterLabel: args.chapterLabel || null,
          bookId: args.bookId ?? null,
          status: "saved",
          version: args.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.snippets.id, args.id),
            eq(schema.snippets.version, args.version),
            eq(schema.snippets.status, "draft"),
            isNull(schema.snippets.deletedAt),
          ),
        )
        .returning({ id: schema.snippets.id });
      if (updated.length === 0) {
        const exists = await db
          .select({ id: schema.snippets.id, status: schema.snippets.status })
          .from(schema.snippets)
          .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
          .limit(1);
        return {
          ok: false,
          forbidden: false,
          status: exists.length > 0 ? "conflict" : "notFound",
        };
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  updateSnippetReflection: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      version: z.number().int().positive(),
      reflection: z.string().trim().max(2000),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.snippets)
        .set({
          reflection: args.reflection || null,
          version: args.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.snippets.id, args.id),
            eq(schema.snippets.version, args.version),
            isNull(schema.snippets.deletedAt),
          ),
        )
        .returning({ id: schema.snippets.id });
      if (updated.length === 0) {
        const exists = await db
          .select({ id: schema.snippets.id })
          .from(schema.snippets)
          .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
          .limit(1);
        return {
          ok: false,
          forbidden: false,
          status: exists.length > 0 ? "conflict" : "notFound",
        };
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // Display state only: never a reuse, never reading time.
  setSnippetInternalized: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      internalized: z.boolean(),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.snippets)
        .set({
          internalizedAt: args.internalized ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
        .returning({ id: schema.snippets.id });
      if (updated.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  deleteSnippet: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      // Soft-deleted rows are filtered from every read, so a removed
      // snippet can never resurface in 片刻回味. Delete + tombstone
      // commit atomically (commitDelete).
      const deleted = await commitDelete(
        db,
        db
          .update(schema.snippets)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
          .returning({ id: schema.snippets.id }),
        "snippets",
        args.id,
      );
      if (!deleted) return { ok: false, forbidden: false, status: "notFound" };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  setSnippetTags: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const found = await db
        .select({ id: schema.snippets.id })
        .from(schema.snippets)
        .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
        .limit(1);
      if (found.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      const existing = await db
        .select()
        .from(schema.snippetTags)
        .where(eq(schema.snippetTags.snippetId, args.id));
      const suggested = existing.filter((t) => t.origin === "suggested");
      const wanted = [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))];
      // The whole tag rewrite commits as one batch: no half-applied
      // tag set is ever visible.
      const items: BatchItem[] = [
        db
          .delete(schema.snippetTags)
          .where(
            and(
              eq(schema.snippetTags.snippetId, args.id),
              eq(schema.snippetTags.origin, "owner"),
            ),
          ),
      ];
      // Applying a suggested tag adopts it as an owner tag.
      for (const t of suggested) {
        if (wanted.includes(t.tag)) {
          items.push(
            db
              .delete(schema.snippetTags)
              .where(
                and(
                  eq(schema.snippetTags.snippetId, args.id),
                  eq(schema.snippetTags.tag, t.tag),
                  eq(schema.snippetTags.origin, "suggested"),
                ),
              ),
          );
        }
      }
      for (const tag of wanted) {
        items.push(
          db.insert(schema.snippetTags).values({ snippetId: args.id, tag, origin: "owner" }),
        );
      }
      await db.batch(items as [BatchItem, ...BatchItem[]]);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // Model suggestions for one snippet: a think prompt + candidate
  // tags. Suggestions are stored labeled as suggestions; the original
  // text is never touched.
  suggestSnippetMeta: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      forbidden: z.boolean(),
      thinkPrompt: z.string().nullable(),
      tags: z.array(z.string()),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, thinkPrompt: null, tags: [] as string[] };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.snippets)
        .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
        .limit(1);
      const snip = rows[0];
      if (!snip) return { ok: false, forbidden: false, thinkPrompt: null, tags: [] as string[] };
      const out = await ctx.inference.complete(
        `下面是一句书摘，出自《${snip.bookTitle}》${snip.chapterLabel ? `（${snip.chapterLabel}）` : ""}：「${snip.text}」\n请给出一句能促使读者把这句话和自己的生活/工作联系起来的思考提示（一个问题，简短中文），并建议 1-3 个简短中文主题标签。`,
        {
          schema: z.object({
            tags: z.array(z.string()).min(1).max(3),
            thinkPrompt: z.string(),
          }),
        },
      );
      const tags = out.tags.map((t) => t.trim()).filter(Boolean).slice(0, 3);
      const ownerTags = await db
        .select()
        .from(schema.snippetTags)
        .where(
          and(
            eq(schema.snippetTags.snippetId, args.id),
            eq(schema.snippetTags.origin, "owner"),
          ),
        );
      const ownerSet = new Set(ownerTags.map((t) => t.tag));
      // Think prompt + suggested-tag rewrite commit as one batch;
      // the 原文 itself is never part of the write set.
      const items: BatchItem[] = [
        db
          .update(schema.snippets)
          .set({ thinkPrompt: out.thinkPrompt, updatedAt: new Date() })
          .where(eq(schema.snippets.id, args.id)),
        db
          .delete(schema.snippetTags)
          .where(
            and(
              eq(schema.snippetTags.snippetId, args.id),
              eq(schema.snippetTags.origin, "suggested"),
            ),
          ),
      ];
      for (const tag of tags) {
        if (!ownerSet.has(tag)) {
          items.push(
            db
              .insert(schema.snippetTags)
              .values({ snippetId: args.id, tag, origin: "suggested" }),
          );
        }
      }
      await db.batch(items as [BatchItem, ...BatchItem[]]);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, thinkPrompt: out.thinkPrompt, tags };
    },
  }),

  // In-app Q&A about ONE saved snippet (CMP-READ-001, this slice).
  // The snippet's 原文 and provenance are loaded server-side from the
  // stored row and returned as a fixed snapshot with the answer, so
  // the panel's 「原文」 block always shows the real source location
  // and can never be edited into, or confused with, the model's words.
  // The exchange itself is NOT persisted: no half-written discussion
  // rows exist, and a failed/timed-out ask writes nothing at all —
  // the client keeps the question draft and offers a retry. Only the
  // owner's explicit 「沉淀为知识卡」 (existing createCard, with its
  // request-key ledger) turns a conclusion into a stored card.
  //
  // Pinned-citation binding (CMP-READ-001 closure): the response
  // CONSUMES and RETURNS the binding of exactly this ask — the
  // questionRequestId it was sent with, the snippet id, the snippet
  // VERSION actually read, and the 原文/出处 snapshot taken from
  // that stored row. The client pins all of it on the turn, so a
  // later library update can never graft an old answer onto a newer
  // source, and a card distilled from the turn can carry the same
  // binding into storage (createCard re-verifies it — see there).
  askSnippetQuestion: defineAction({
    request: z.object({
      snippetId: z.number().int().positive(),
      question: z.string().trim().min(1).max(1000),
      // The panel's per-question request id: one id per question the
      // owner actually asked (retries of the same question — e.g.
      // after a lost response — reuse it), so an answer can always be
      // traced to exactly one ask. Asks persist nothing server-side;
      // the id is the binding, not a storage key.
      questionRequestId: z.string().trim().min(1).max(120).optional(),
      // The version of the snippet row the panel pinned as 原文. When
      // given, the stored row must still BE that version: answering
      // against a silently newer 原文 than the pinned one would mix
      // two different source texts into one discussion.
      snippetVersion: z.number().int().positive().optional(),
      // Prior turns of THIS panel session, newest last, so follow-ups
      // stay a discussion. Bounded; never stored server-side.
      history: z
        .array(
          z.object({
            question: z.string().trim().min(1).max(1000),
            answer: z.string().trim().min(1).max(6000),
          }),
        )
        .max(6)
        .optional(),
    }),
    response: askSnippetResponse,
    async handler(ctx, args): Promise<z.infer<typeof askSnippetResponse>> {
      // Owner gate BEFORE any database read: a non-owner learns
      // nothing about the snippet and triggers no inference.
      if (!isOwner(ctx)) {
        return {
          ok: false,
          forbidden: true,
          status: "refused",
          answer: "",
          suggestedCore: null,
          sourceText: "",
          sourceLabel: "",
          questionRequestId: null,
          snippetId: null,
          snippetVersion: null,
        };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.snippets)
        .where(and(eq(schema.snippets.id, args.snippetId), isNull(schema.snippets.deletedAt)))
        .limit(1);
      const snip = rows[0];
      // Only confirmed （已保存） snippets can be discussed; drafts are
      // unconfirmed text and tombstoned rows never resurface. A stale
      // version reference is refused the same way: the pinned 原文
      // the owner is looking at is no longer the stored one, and no
      // inference runs against the wrong text.
      if (!snip || snip.status !== "saved") {
        return {
          ok: false,
          forbidden: false,
          status: "notFound",
          answer: "",
          suggestedCore: null,
          sourceText: "",
          sourceLabel: "",
          questionRequestId: null,
          snippetId: null,
          snippetVersion: null,
        };
      }
      if (args.snippetVersion != null && args.snippetVersion !== snip.version) {
        return {
          ok: false,
          forbidden: false,
          status: "notFound",
          answer: "",
          suggestedCore: null,
          sourceText: "",
          sourceLabel: "",
          questionRequestId: null,
          snippetId: null,
          snippetVersion: null,
        };
      }
      const chapter = snip.chapterLabel ?? "章节不详";
      const sourceLabel = snip.versionLabel
        ? `《${snip.bookTitle}》 · ${snip.versionLabel} · ${chapter}`
        : `《${snip.bookTitle}》 · ${chapter}`;
      const historyText = (args.history ?? [])
        .map((t) => `读者问：${t.question}\nMuse 答：${t.answer}`)
        .join("\n\n");
      const out = await ctx.inference.complete(
        [
          "你正在帮助这本书的读者理解并讨论一段书摘。读者就下面这段原文提问，你的回答是「解释/讨论」，不是原文的一部分，措辞上要让读者能分清哪些是原文的意思、哪些是你的引申。",
          "",
          `【原文】出自${sourceLabel}：`,
          `「${snip.text}」`,
          historyText ? `\n【之前的讨论】\n${historyText}` : "",
          "",
          `【读者的问题】${args.question}`,
          "",
          "要求：用中文回答，先扣住原文解释，再展开讨论，可以联系读者的生活与工作，但不要编造原文之外的书中内容（不要虚构作者在书里还写过什么），原文没讲清的地方就明说不确定。回答控制在约 450 字内，纯文本，可分段，不要用 Markdown 标题或列表符号。另外再给出一句话核心（不超过 60 字）：把这段原文与本次讨论的结论提炼成一句可沉淀为知识卡的话，只依据原文与讨论，不添加新事实。",
        ]
          .filter(Boolean)
          .join("\n"),
        {
          schema: z.object({
            answer: z.string(),
            suggestedCore: z.string(),
          }),
        },
      );
      return {
        ok: true,
        forbidden: false,
        status: "answered",
        answer: out.answer.trim(),
        suggestedCore: out.suggestedCore.trim() || null,
        sourceText: snip.text,
        sourceLabel,
        // The binding of THIS ask: the id it was sent with and the
        // stored row version actually answered against.
        questionRequestId: args.questionRequestId ?? null,
        snippetId: snip.id,
        snippetVersion: snip.version,
      };
    },
  }),

  // OCR for a WeRead screenshot the owner picked. Returns candidate
  // text ONLY — the client puts it into the draft form, and nothing is
  // saved until the owner confirms it via createSnippetDraft +
  // confirmSnippetDraft.
  ocrExtract: defineAction({
    request: z.object({
      dataBase64: z.string().min(1),
      mimeType: z.enum(["image/jpeg", "image/png"]),
    }),
    response: z.object({
      ok: z.boolean(),
      forbidden: z.boolean(),
      text: z.string(),
    }),
    async handler(ctx, args) {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, text: "" };
      const out = await ctx.inference.complete(
        "这是一张读书应用的截图。请逐字转录截图中被划线或正文展示的书摘文字，只输出原文，不要加引号、不要解释、不要补全截图之外的文字。如果有多段，保留原有分段。",
        {
          schema: z.object({ text: z.string() }),
          images: [
            {
              dataBase64: args.dataBase64,
              mimeType: args.mimeType,
              filename: "weread-screenshot",
              caption: "微信读书截图，待转录的片段",
            },
          ],
        },
      );
      return { ok: true, forbidden: false, text: out.text.trim() };
    },
  }),

  // -------------------------------------------------------------------
  // Knowledge cards + reuse ledger
  // -------------------------------------------------------------------

  createCard: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      core: z.string().trim().min(1).max(300),
      snippetId: z.number().int().positive().nullable().optional(),
      annotation: z.string().trim().max(2000).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
      // Q&A discussion binding (CMP-READ-001 pinned-citation
      // closure): when the card is distilled from ONE Q&A turn, the
      // panel passes that turn's pinned citation — the ask's
      // questionRequestId, the snippet version answered against,
      // and the response-time 原文/出处 snapshot. All four travel
      // together or not at all; the handler re-verifies them
      // against the stored snippet row before anything is written.
      qaQuestionRequestId: z.string().trim().min(1).max(120).optional(),
      qaSnippetVersion: z.number().int().positive().optional(),
      qaSourceText: z.string().trim().min(1).max(8000).optional(),
      qaSourceLabel: z.string().trim().min(1).max(600).optional(),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const qa = {
        questionRequestId: args.qaQuestionRequestId ?? null,
        snippetVersion: args.qaSnippetVersion ?? null,
        sourceText: args.qaSourceText ?? null,
        sourceLabel: args.qaSourceLabel ?? null,
      };
      const qaGiven =
        qa.questionRequestId != null ||
        qa.snippetVersion != null ||
        qa.sourceText != null ||
        qa.sourceLabel != null;
      const qaComplete =
        qa.questionRequestId != null &&
        qa.snippetVersion != null &&
        qa.sourceText != null &&
        qa.sourceLabel != null;
      const hash = payloadHash({
        k: "card",
        core: args.core,
        snippetId: args.snippetId ?? null,
        annotation: args.annotation || null,
        tags: [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))],
        qa,
      });
      const claim = await arbitrateCreate(db, args.requestId, "card", hash);
      const early = claimToResult(claim);
      if (early) return early;
      let sourceLabel: string | null = null;
      let snippetId: number | null = null;
      if (args.snippetId != null) {
        const rows = await db
          .select()
          .from(schema.snippets)
          .where(
            and(eq(schema.snippets.id, args.snippetId), isNull(schema.snippets.deletedAt)),
          )
          .limit(1);
        const snip = rows[0];
        // A card may claim a source only from a confirmed （已保存）
        // snippet that is still there. A missing, draft or deleted
        // snippet never lends its provenance to a card — the save is
        // refused as notFound and nothing is written under this key.
        if (!snip || snip.status !== "saved") {
          return { ok: false, forbidden: false, status: "notFound", id: null, resultId: null };
        }
        snippetId = snip.id;
        sourceLabel = snip.chapterLabel
          ? `${snip.bookTitle} · ${snip.chapterLabel}`
          : snip.bookTitle;
        if (qaGiven) {
          // A Q&A binding must be COMPLETE and must still describe
          // the stored snippet EXACTLY: same version, same 原文，
          // same 出处 label (rebuilt from the stored row the same
          // way askSnippetQuestion builds it). If the source moved
          // since the discussion — edited, re-versioned — the save
          // is a typed conflict and NOTHING is written under this
          // key: the panel keeps the draft, shows the old pinned
          // citation next to the current snippet, and only the
          // owner's explicit choice re-binds the save to the
          // current version. The binding is never silently
          // re-pointed at a newer source.
          const chapter = snip.chapterLabel ?? "章节不详";
          const currentQaLabel = snip.versionLabel
            ? `《${snip.bookTitle}》 · ${snip.versionLabel} · ${chapter}`
            : `《${snip.bookTitle}》 · ${chapter}`;
          if (
            !qaComplete ||
            qa.snippetVersion !== snip.version ||
            qa.sourceText !== snip.text ||
            qa.sourceLabel !== currentQaLabel
          ) {
            return { ok: false, forbidden: false, status: "conflict", id: null, resultId: null };
          }
        }
      } else if (qaGiven) {
        // A discussion binding without the snippet it discusses is
        // meaningless — refuse rather than store a dangling claim.
        return { ok: false, forbidden: false, status: "conflict", id: null, resultId: null };
      }
      // Card row + tag rows + ledger entry commit as ONE batch: any
      // failure leaves no card, no tags and no ledger row behind.
      const tagValues = [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))];
      const items: BatchItem[] = [
        db
          .insert(schema.knowledgeCards)
          .values({
            core: args.core,
            snippetId,
            sourceLabel,
            // The verified discussion binding, pinned on the card
            // forever (nulls for cards not made from a Q&A turn).
            qaQuestionRequestId: qaGiven ? qa.questionRequestId : null,
            qaSnippetVersion: qaGiven ? qa.snippetVersion : null,
            qaSourceText: qaGiven ? qa.sourceText : null,
            qaSourceLabel: qaGiven ? qa.sourceLabel : null,
            annotation: args.annotation || null,
            origin: "ui",
            requestId: args.requestId,
          })
          .returning({ id: schema.knowledgeCards.id }),
        ledgerInsertStmt(db, args.requestId, "card", hash, "knowledge_cards"),
        ledgerResultStmt(db, args.requestId, "knowledge_cards"),
      ];
      for (const tag of tagValues) {
        items.push(
          db.insert(schema.cardTags).values({
            cardId: idByRequestId("knowledge_cards", args.requestId),
            tag,
            origin: "owner",
          }),
        );
      }
      const outcome = await commitCreate(db, args.requestId, "card", hash, items);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("createCard: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),

  // Agent-callable: when a chat discussion distills a book quote into a
  // card, Muse records it here instead of the owner re-typing it. The
  // quote (when given) is stored as a snippet with source "chat" so the
  // card can always be traced back to its 原文.
  recordKnowledgeCardFromChat: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      core: z.string().trim().min(1).max(300),
      snippetText: z.string().trim().max(4000).optional(),
      bookTitle: z.string().trim().max(300).optional(),
      chapterLabel: z.string().trim().max(300).optional(),
      annotation: z.string().trim().max(2000).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const hash = payloadHash({
        k: "card-chat",
        core: args.core,
        snippetText: args.snippetText ?? null,
        bookTitle: args.bookTitle ?? null,
        chapterLabel: args.chapterLabel ?? null,
        annotation: args.annotation || null,
        tags: [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))],
      });
      const claim = await arbitrateCreate(db, args.requestId, "card-chat", hash);
      const early = claimToResult(claim);
      if (early) return early;
      let sourceLabel: string | null = null;
      if (args.snippetText) {
        sourceLabel = args.chapterLabel
          ? `${args.bookTitle ?? "出处待确认"} · ${args.chapterLabel}`
          : (args.bookTitle ?? null);
      } else if (args.bookTitle) {
        sourceLabel = args.chapterLabel
          ? `${args.bookTitle} · ${args.chapterLabel}`
          : args.bookTitle;
      }
      // Source snippet + card + tags + ledger commit as ONE batch:
      // a failure can never strand a source snippet without its card
      // (or a card without its ledger entry). The snippet row carries
      // this requestId so the card's snippetId resolves to the actual
      // stored row inside the same batch.
      const items: BatchItem[] = [];
      if (args.snippetText) {
        items.push(
          db.insert(schema.snippets).values({
            bookId: null,
            bookTitle: args.bookTitle || "出处待确认",
            chapterLabel: args.chapterLabel || null,
            text: args.snippetText,
            source: "chat",
            status: "saved",
            requestId: args.requestId,
          }),
        );
      }
      const cardIndex = items.length;
      items.push(
        db
          .insert(schema.knowledgeCards)
          .values({
            core: args.core,
            snippetId: args.snippetText
              ? idByRequestId("snippets", args.requestId)
              : null,
            sourceLabel,
            annotation: args.annotation || null,
            origin: "chat",
            requestId: args.requestId,
          })
          .returning({ id: schema.knowledgeCards.id }),
      );
      items.push(ledgerInsertStmt(db, args.requestId, "card-chat", hash, "knowledge_cards"));
      items.push(ledgerResultStmt(db, args.requestId, "knowledge_cards"));
      for (const tag of [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))]) {
        items.push(
          db.insert(schema.cardTags).values({
            cardId: idByRequestId("knowledge_cards", args.requestId),
            tag,
            origin: "owner",
          }),
        );
      }
      const outcome = await commitCreate(db, args.requestId, "card-chat", hash, items);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("recordKnowledgeCardFromChat: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, cardIndex);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),

  updateCard: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      version: z.number().int().positive(),
      core: z.string().trim().min(1).max(300).optional(),
      annotation: z.string().trim().max(2000).nullable().optional(),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const patch: Partial<typeof schema.knowledgeCards.$inferInsert> = {
        updatedAt: new Date(),
        version: args.version + 1,
      };
      if (args.core !== undefined) patch.core = args.core;
      if (args.annotation !== undefined) patch.annotation = args.annotation || null;
      const updated = await db
        .update(schema.knowledgeCards)
        .set(patch)
        .where(
          and(
            eq(schema.knowledgeCards.id, args.id),
            eq(schema.knowledgeCards.version, args.version),
            isNull(schema.knowledgeCards.deletedAt),
          ),
        )
        .returning({ id: schema.knowledgeCards.id });
      if (updated.length === 0) {
        const exists = await db
          .select({ id: schema.knowledgeCards.id })
          .from(schema.knowledgeCards)
          .where(
            and(eq(schema.knowledgeCards.id, args.id), isNull(schema.knowledgeCards.deletedAt)),
          )
          .limit(1);
        return {
          ok: false,
          forbidden: false,
          status: exists.length > 0 ? "conflict" : "notFound",
        };
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  deleteCard: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const deleted = await commitDelete(
        db,
        db
          .update(schema.knowledgeCards)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.knowledgeCards.id, args.id),
              isNull(schema.knowledgeCards.deletedAt),
            ),
          )
          .returning({ id: schema.knowledgeCards.id }),
        "knowledge_cards",
        args.id,
      );
      if (!deleted) return { ok: false, forbidden: false, status: "notFound" };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  setCardTags: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const found = await db
        .select({ id: schema.knowledgeCards.id })
        .from(schema.knowledgeCards)
        .where(
          and(eq(schema.knowledgeCards.id, args.id), isNull(schema.knowledgeCards.deletedAt)),
        )
        .limit(1);
      if (found.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      // Delete + re-insert commits as one batch: the card never
      // shows a half-rewritten tag set.
      const items: BatchItem[] = [
        db.delete(schema.cardTags).where(eq(schema.cardTags.cardId, args.id)),
      ];
      for (const tag of [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))]) {
        items.push(
          db.insert(schema.cardTags).values({ cardId: args.id, tag, origin: "owner" }),
        );
      }
      await db.batch(items as [BatchItem, ...BatchItem[]]);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // The interest entry. Only a REAL reuse counts — "could use this
  // later" is not a reuse and must never be recorded here. The
  // requestId makes a re-delivered or re-run registration of the same
  // event count exactly once; different cards in the same event each
  // get their own requestId and their own row.
  recordCardReuse: defineAction({
    request: z.object({
      requestId: z.string().trim().min(1).max(120),
      cardId: z.number().int().positive(),
      date: z.string().regex(dateKeyRe, "date must be YYYY-MM-DD").optional(),
      scene: z.string().trim().min(1).max(500),
      outcome: z.string().trim().min(1).max(1000),
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const date = args.date ?? todayKey();
      const hash = payloadHash({
        k: "reuse",
        cardId: args.cardId,
        date,
        scene: args.scene,
        outcome: args.outcome,
      });
      const claim = await arbitrateCreate(db, args.requestId, "reuse", hash);
      const early = claimToResult(claim);
      if (early) return early;
      const cardRows = await db
        .select({ id: schema.knowledgeCards.id })
        .from(schema.knowledgeCards)
        .where(
          and(
            eq(schema.knowledgeCards.id, args.cardId),
            isNull(schema.knowledgeCards.deletedAt),
          ),
        )
        .limit(1);
      if (cardRows.length === 0) return { ok: false, forbidden: false, status: "notFound", id: null, resultId: null };
      const outcome = await commitCreate(db, args.requestId, "reuse", hash, [
        db
          .insert(schema.cardReuses)
          .values({
            cardId: args.cardId,
            date,
            scene: args.scene,
            outcome: args.outcome,
            requestId: args.requestId,
          })
          .returning({ id: schema.cardReuses.id }),
        ledgerInsertStmt(db, args.requestId, "reuse", hash, "card_reuses"),
        ledgerResultStmt(db, args.requestId, "card_reuses"),
      ]);
      if (!outcome.committed) {
        const mapped = claimToResult(outcome.claim);
        if (mapped) return mapped;
        throw new Error("recordCardReuse: arbitration returned fresh after a failed commit");
      }
      const id = batchInsertId(outcome.results, 0);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id, resultId: id };
    },
  }),
} satisfies ActionsModule;
