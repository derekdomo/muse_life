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
// fingerprint, in the same batch as the row it creates.
//   same key + same payload  → the original row is returned (replay)
//   same key + other payload → typed "conflict", nothing written
//   key whose row was deleted → typed "deleted", never resurrected
// Edits carry an optimistic `version`: a stale save conflicts and the
// newer row is never overwritten.

import { defineAction, z, type ActionsModule, type Ctx, type SpaceDb } from "@hatch/space-sdk";
import { and, asc, eq, isNull } from "drizzle-orm";
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

type Claim =
  | { state: "fresh" }
  | { state: "replay"; resultId: number | null }
  | { state: "conflict" }
  | { state: "deleted" };

// Look up a requestId in the ledger. Fresh keys return "fresh" and the
// caller inserts the ledger row in the same batch as the created row.
async function claimRequest(
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
  if (row.kind !== kind || row.payloadHash !== hash) return { state: "conflict" };
  if (row.deleted === 1) return { state: "deleted" };
  return { state: "replay", resultId: row.resultId };
}

// Stamp the ledger row(s) for a deleted entity so late retries with the
// original creation key are answered "deleted" forever.
async function tombstoneByResult(
  db: Db,
  resultTable: string,
  resultId: number,
): Promise<void> {
  const rows = await db
    .select({ requestId: schema.requestKeys.requestId })
    .from(schema.requestKeys)
    .where(
      and(
        eq(schema.requestKeys.resultTable, resultTable),
        eq(schema.requestKeys.resultId, resultId),
      ),
    );
  for (const r of rows) {
    await db
      .update(schema.requestKeys)
      .set({ deleted: 1 })
      .where(eq(schema.requestKeys.requestId, r.requestId));
  }
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
});

const okResult = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  status: saveStatus,
});

function refusedCreate(): z.infer<typeof createResult> {
  return { ok: false, forbidden: true, status: "refused", id: null };
}
function refusedOk(): z.infer<typeof okResult> {
  return { ok: false, forbidden: true, status: "refused" };
}

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
        author: args.author ?? null,
        source: args.source,
        status: args.status,
        note: args.note ?? null,
        importStatus: args.importStatus,
      });
      const claim = await claimRequest(db, args.requestId, "book", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
      const inserted = await db
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
        .returning({ id: schema.books.id });
      const row = inserted[0];
      if (!row) throw new Error("addBook: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "book",
        payloadHash: hash,
        resultTable: "books",
        resultId: row.id,
      });
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
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
      const updated = await db
        .update(schema.books)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.books.id, args.id), isNull(schema.books.deletedAt)))
        .returning({ id: schema.books.id });
      if (updated.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      await tombstoneByResult(db, "books", args.id);
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
        note: args.note ?? null,
      });
      const claim = await claimRequest(db, args.requestId, "reading", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
      let bookId = args.bookId ?? null;
      if (bookId != null) {
        const found = await db
          .select({ id: schema.books.id })
          .from(schema.books)
          .where(and(eq(schema.books.id, bookId), isNull(schema.books.deletedAt)))
          .limit(1);
        if (found.length === 0) bookId = null;
      }
      const inserted = await db
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
        .returning({ id: schema.readingSessions.id });
      const row = inserted[0];
      if (!row) throw new Error("logReading: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "reading",
        payloadHash: hash,
        resultTable: "reading_sessions",
        resultId: row.id,
      });
      // A progress report on the session also moves the book's own
      // progress marker (same unit, owner's number verbatim).
      if (bookId != null && args.progressValue != null) {
        await db
          .update(schema.books)
          .set({
            progressValue: args.progressValue,
            progressUnit: args.progressUnit ?? null,
            updatedAt: new Date(),
          })
          .where(eq(schema.books.id, bookId));
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
    },
  }),

  deleteReadingSession: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.readingSessions)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(schema.readingSessions.id, args.id),
            isNull(schema.readingSessions.deletedAt),
          ),
        )
        .returning({ id: schema.readingSessions.id });
      if (updated.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      await tombstoneByResult(db, "reading_sessions", args.id);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  // -------------------------------------------------------------------
  // EPUB import. The browser parses the file; the server only stores
  // what the browser extracted (sanitized chapter HTML) plus the
  // original bytes in a private blob. No book text is ever fetched
  // from, or uploaded to, any external service.
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
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      if (args.existingBookId != null) {
        const found = await db
          .select()
          .from(schema.books)
          .where(
            and(eq(schema.books.id, args.existingBookId), isNull(schema.books.deletedAt)),
          )
          .limit(1);
        const book = found[0];
        if (!book) return { ok: false, forbidden: false, status: "notFound", id: null };
        await db.delete(schema.bookChapters).where(eq(schema.bookChapters.bookId, book.id));
        await db
          .update(schema.books)
          .set({
            importStatus: "processing",
            importError: null,
            versionLabel: args.versionLabel || book.versionLabel,
            updatedAt: new Date(),
          })
          .where(eq(schema.books.id, book.id));
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, status: "saved", id: book.id };
      }
      const hash = payloadHash({
        k: "import-book",
        title: args.title,
        author: args.author ?? null,
        source: args.source,
        versionLabel: args.versionLabel ?? null,
      });
      const claim = await claimRequest(db, args.requestId, "import-book", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
      const inserted = await db
        .insert(schema.books)
        .values({
          title: args.title,
          author: args.author || null,
          source: args.source,
          status: "want",
          importStatus: "processing",
          versionLabel: args.versionLabel || null,
          requestId: args.requestId,
        })
        .returning({ id: schema.books.id });
      const row = inserted[0];
      if (!row) throw new Error("beginImport: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "import-book",
        payloadHash: hash,
        resultTable: "books",
        resultId: row.id,
      });
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
    },
  }),

  uploadImportFile: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      dataBase64: z.string().min(1),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const found = await db
        .select({ id: schema.books.id })
        .from(schema.books)
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .limit(1);
      if (found.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      const key = `epub/${args.bookId}.epub`;
      const bytes = Buffer.from(args.dataBase64, "base64");
      await ctx.blobs.put(key, bytes, { contentType: "application/epub+zip" });
      await db
        .update(schema.books)
        .set({ blobKey: key, updatedAt: new Date() })
        .where(eq(schema.books.id, args.bookId));
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  saveImportChapters: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
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
      const found = await db
        .select({ id: schema.books.id, importStatus: schema.books.importStatus })
        .from(schema.books)
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .limit(1);
      const book = found[0];
      if (!book) return { ok: false, forbidden: false, status: "notFound" };
      if (book.importStatus !== "processing") {
        return { ok: false, forbidden: false, status: "conflict" };
      }
      for (const ch of args.chapters) {
        const existing = await db
          .select({ id: schema.bookChapters.id })
          .from(schema.bookChapters)
          .where(
            and(
              eq(schema.bookChapters.bookId, args.bookId),
              eq(schema.bookChapters.idx, ch.idx),
            ),
          )
          .limit(1);
        const values = {
          bookId: args.bookId,
          idx: ch.idx,
          title: ch.title,
          html: ch.html,
          charCount: ch.html.length,
        };
        if (existing.length > 0) {
          await db
            .update(schema.bookChapters)
            .set(values)
            .where(eq(schema.bookChapters.id, existing[0]?.id ?? -1));
        } else {
          await db.insert(schema.bookChapters).values(values);
        }
      }
      return { ok: true, forbidden: false, status: "saved" };
    },
  }),

  finishImport: defineAction({
    request: z.object({
      bookId: z.number().int().positive(),
      ok: z.boolean(),
      error: z.string().trim().max(500).optional(),
      chapterCount: z.number().int().min(0).optional(),
    }),
    response: okResult,
    async handler(ctx, args): Promise<z.infer<typeof okResult>> {
      if (!isOwner(ctx)) return refusedOk();
      const db = ctx.db<typeof schema>();
      const found = await db
        .select({ id: schema.books.id })
        .from(schema.books)
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .limit(1);
      if (found.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      if (args.ok) {
        const chapters = await db
          .select({ id: schema.bookChapters.id })
          .from(schema.bookChapters)
          .where(eq(schema.bookChapters.bookId, args.bookId));
        if (chapters.length === 0) {
          // Claiming ready with zero stored chapters would be a false
          // state; record it as the failure it is instead.
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
        // Failure keeps the original blob and the previous reading
        // position untouched; only the status changes.
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
      const hash = payloadHash({
        k: "snippet",
        bookId: args.bookId,
        text: args.text,
        chapterIdx: args.chapterIdx ?? null,
        charOffset: args.charOffset ?? null,
      });
      const claim = await claimRequest(db, args.requestId, "snippet", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
      const bookRows = await db
        .select()
        .from(schema.books)
        .where(and(eq(schema.books.id, args.bookId), isNull(schema.books.deletedAt)))
        .limit(1);
      const book = bookRows[0];
      if (!book) return { ok: false, forbidden: false, status: "notFound", id: null };
      const inserted = await db
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
        .returning({ id: schema.snippets.id });
      const row = inserted[0];
      if (!row) throw new Error("createSnippet: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "snippet",
        payloadHash: hash,
        resultTable: "snippets",
        resultId: row.id,
      });
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
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
        bookTitle: args.bookTitle ?? null,
        chapterLabel: args.chapterLabel ?? null,
      });
      const claim = await claimRequest(db, args.requestId, "snippet-draft", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
      const inserted = await db
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
        .returning({ id: schema.snippets.id });
      const row = inserted[0];
      if (!row) throw new Error("createSnippetDraft: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "snippet-draft",
        payloadHash: hash,
        resultTable: "snippets",
        resultId: row.id,
      });
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
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
      const updated = await db
        .update(schema.snippets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.snippets.id, args.id), isNull(schema.snippets.deletedAt)))
        .returning({ id: schema.snippets.id });
      if (updated.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      // Soft-deleted rows are filtered from every read, so a removed
      // snippet can never resurface in 片刻回味.
      await tombstoneByResult(db, "snippets", args.id);
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
      await db
        .delete(schema.snippetTags)
        .where(
          and(
            eq(schema.snippetTags.snippetId, args.id),
            eq(schema.snippetTags.origin, "owner"),
          ),
        );
      const wanted = [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))];
      // Applying a suggested tag adopts it as an owner tag.
      for (const t of suggested) {
        if (wanted.includes(t.tag)) {
          await db
            .delete(schema.snippetTags)
            .where(
              and(
                eq(schema.snippetTags.snippetId, args.id),
                eq(schema.snippetTags.tag, t.tag),
                eq(schema.snippetTags.origin, "suggested"),
              ),
            );
        }
      }
      for (const tag of wanted) {
        await db
          .insert(schema.snippetTags)
          .values({ snippetId: args.id, tag, origin: "owner" });
      }
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
      await db
        .update(schema.snippets)
        .set({ thinkPrompt: out.thinkPrompt, updatedAt: new Date() })
        .where(eq(schema.snippets.id, args.id));
      await db
        .delete(schema.snippetTags)
        .where(
          and(
            eq(schema.snippetTags.snippetId, args.id),
            eq(schema.snippetTags.origin, "suggested"),
          ),
        );
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
      for (const tag of tags) {
        if (!ownerSet.has(tag)) {
          await db
            .insert(schema.snippetTags)
            .values({ snippetId: args.id, tag, origin: "suggested" });
        }
      }
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
  askSnippetQuestion: defineAction({
    request: z.object({
      snippetId: z.number().int().positive(),
      question: z.string().trim().min(1).max(1000),
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
    response: z.object({
      ok: z.boolean(),
      forbidden: z.boolean(),
      status: z.enum(["answered", "refused", "notFound"]),
      answer: z.string(),
      // Model-suggested one-line core for the knowledge card. Always
      // labeled 建议 in the UI and owner-editable before saving.
      suggestedCore: z.string().nullable(),
      // Fixed provenance snapshot of the snippet being discussed.
      sourceText: z.string(),
      sourceLabel: z.string(),
    }),
    async handler(ctx, args): Promise<{
      ok: boolean;
      forbidden: boolean;
      status: "answered" | "refused" | "notFound";
      answer: string;
      suggestedCore: string | null;
      sourceText: string;
      sourceLabel: string;
    }> {
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
      // unconfirmed text and tombstoned rows never resurface.
      if (!snip || snip.status !== "saved") {
        return {
          ok: false,
          forbidden: false,
          status: "notFound",
          answer: "",
          suggestedCore: null,
          sourceText: "",
          sourceLabel: "",
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
    }),
    response: createResult,
    async handler(ctx, args): Promise<z.infer<typeof createResult>> {
      if (!isOwner(ctx)) return refusedCreate();
      const db = ctx.db<typeof schema>();
      const hash = payloadHash({
        k: "card",
        core: args.core,
        snippetId: args.snippetId ?? null,
        annotation: args.annotation ?? null,
        tags: args.tags ?? [],
      });
      const claim = await claimRequest(db, args.requestId, "card", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
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
        if (snip) {
          snippetId = snip.id;
          sourceLabel = snip.chapterLabel
            ? `${snip.bookTitle} · ${snip.chapterLabel}`
            : snip.bookTitle;
        }
      }
      const inserted = await db
        .insert(schema.knowledgeCards)
        .values({
          core: args.core,
          snippetId,
          sourceLabel,
          annotation: args.annotation || null,
          origin: "ui",
          requestId: args.requestId,
        })
        .returning({ id: schema.knowledgeCards.id });
      const row = inserted[0];
      if (!row) throw new Error("createCard: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "card",
        payloadHash: hash,
        resultTable: "knowledge_cards",
        resultId: row.id,
      });
      for (const tag of [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))]) {
        await db.insert(schema.cardTags).values({ cardId: row.id, tag, origin: "owner" });
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
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
        annotation: args.annotation ?? null,
        tags: args.tags ?? [],
      });
      const claim = await claimRequest(db, args.requestId, "card-chat", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
      let snippetId: number | null = null;
      let sourceLabel: string | null = null;
      if (args.snippetText) {
        const snipInserted = await db
          .insert(schema.snippets)
          .values({
            bookId: null,
            bookTitle: args.bookTitle || "出处待确认",
            chapterLabel: args.chapterLabel || null,
            text: args.snippetText,
            source: "chat",
            status: "saved",
          })
          .returning({ id: schema.snippets.id });
        snippetId = snipInserted[0]?.id ?? null;
        sourceLabel = args.chapterLabel
          ? `${args.bookTitle ?? "出处待确认"} · ${args.chapterLabel}`
          : (args.bookTitle ?? null);
      } else if (args.bookTitle) {
        sourceLabel = args.chapterLabel
          ? `${args.bookTitle} · ${args.chapterLabel}`
          : args.bookTitle;
      }
      const inserted = await db
        .insert(schema.knowledgeCards)
        .values({
          core: args.core,
          snippetId,
          sourceLabel,
          annotation: args.annotation || null,
          origin: "chat",
          requestId: args.requestId,
        })
        .returning({ id: schema.knowledgeCards.id });
      const row = inserted[0];
      if (!row) throw new Error("recordKnowledgeCardFromChat: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "card-chat",
        payloadHash: hash,
        resultTable: "knowledge_cards",
        resultId: row.id,
      });
      for (const tag of [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))]) {
        await db.insert(schema.cardTags).values({ cardId: row.id, tag, origin: "owner" });
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
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
      const updated = await db
        .update(schema.knowledgeCards)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(schema.knowledgeCards.id, args.id), isNull(schema.knowledgeCards.deletedAt)),
        )
        .returning({ id: schema.knowledgeCards.id });
      if (updated.length === 0) return { ok: false, forbidden: false, status: "notFound" };
      await tombstoneByResult(db, "knowledge_cards", args.id);
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
      await db.delete(schema.cardTags).where(eq(schema.cardTags.cardId, args.id));
      for (const tag of [...new Set(args.tags.map((t) => t.trim()).filter(Boolean))]) {
        await db.insert(schema.cardTags).values({ cardId: args.id, tag, origin: "owner" });
      }
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
      const claim = await claimRequest(db, args.requestId, "reuse", hash);
      if (claim.state === "conflict") return { ok: false, forbidden: false, status: "conflict", id: null };
      if (claim.state === "deleted") return { ok: false, forbidden: false, status: "deleted", id: null };
      if (claim.state === "replay") return { ok: true, forbidden: false, status: "replayed", id: claim.resultId };
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
      if (cardRows.length === 0) return { ok: false, forbidden: false, status: "notFound", id: null };
      const inserted = await db
        .insert(schema.cardReuses)
        .values({
          cardId: args.cardId,
          date,
          scene: args.scene,
          outcome: args.outcome,
          requestId: args.requestId,
        })
        .returning({ id: schema.cardReuses.id });
      const row = inserted[0];
      if (!row) throw new Error("recordCardReuse: insert returned no rows");
      await db.insert(schema.requestKeys).values({
        requestId: args.requestId,
        kind: "reuse",
        payloadHash: hash,
        resultTable: "card_reuses",
        resultId: row.id,
      });
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, status: "saved", id: row.id };
    },
  }),
} satisfies ActionsModule;
