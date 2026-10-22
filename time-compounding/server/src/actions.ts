// Actions for 时间复利 (space-14).
//
// Design contract (PM spec CMP-TIME-001):
// - Manual interval records only (category + start + end). No external data,
//   no inference from other apps, no background collection.
// - Weeks are Los Angeles local weeks, Monday 00:00 → next Monday 00:00.
//   A DST-transition week is really 167h or 169h; the total comes from the
//   actual local window, never a hardcoded 168.
// - Coverage is the UNION of intervals on the timeline. Per-category totals
//   are raw sums (an overlapped minute counts in each of its categories) and
//   the difference is reported as overlap; category totals must not be added
//   up into coverage.
// - Shares use recorded time as the denominator only — never the full week.
// - Writes are idempotent via a durable requestId ledger that survives entry
//   deletion: same key + same payload replays the original result, same key +
//   different payload is a typed conflict, and any key whose entry was deleted
//   returns typed "deleted" forever (no resurrection).
// - Every mutation applies its body change AND its ledger row in ONE atomic
//   db.batch: if any write point fails (or a concurrent same-key write wins
//   the ledger primary key) the whole batch rolls back, so a failed or lost
//   write never leaves a body row without its ledger key — a retry with the
//   original key can therefore never duplicate a time fact. A batch failure
//   is re-resolved against the committed ledger (replay / conflict / deleted)
//   before surfacing, and only a failure that left no ledger trace rethrows.
// - Updates additionally carry a BASE: the revision (entryDto.version) of
//   the entry as the editor read it. The revision is a persistent integer
//   that increments on EVERY successful mutation and never regresses, so
//   it distinguishes states a content fingerprint cannot (an A→B→A edit
//   cycle returns the content to A but at a strictly higher revision —
//   content equality is not version equality). The server applies an edit
//   only while the stored row still carries that base revision, arbitrated
//   atomically inside the batch (base revision in the UPDATE's WHERE,
//   ledger INSERT gated on the post-update revision in the same batch, so
//   the CAS check and the ledger success record commit or roll back
//   together). A base that has moved — or a legacy caller carrying no base
//   at all — gets a typed "stale_conflict" with the current stored row
//   attached and ZERO writes, so a failed edit retried late can never roll
//   a newer saved edit back. Only a key already in the ledger replays
//   without writing (resolveCommittedKey above).
// - Every read and write requires the owner (ctx.viewer?.isOwner === true).
//   Guests / anonymous / missing viewer get a typed forbidden with zero data.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, eq, sql } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------- categories

export const CATEGORIES = [
  "工作",
  "家庭陪伴",
  "学习",
  "创造",
  "健康运动",
  "休息睡眠",
  "社交",
  "其他",
] as const;

const categorySchema = z.enum(CATEGORIES);

// ------------------------------------------------------------------- authz

function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

// Mutations additionally refuse delegated / scheduled / scripted callers:
// only the owner's own live session may write the ledger.
function canMutate(ctx: Ctx): boolean {
  if (!isOwner(ctx)) return false;
  const viewer = ctx.viewer as { delegate?: string } | undefined;
  if (viewer?.delegate === "agent" || viewer?.delegate === "schedule") {
    return false;
  }
  const loose = ctx as unknown as {
    requestMeta?: { via?: string };
    headers?: { get?: (name: string) => string | null };
  };
  if (loose.requestMeta?.via === "cron") return false;
  try {
    const ua = loose.headers?.get?.("user-agent") ?? "";
    if (ua.includes("Bun/")) return false;
  } catch {
    // No headers surface on this runtime; the viewer checks above stand.
  }
  return true;
}

// ------------------------------------------------------- Los Angeles weeks

const LA_TZ = "America/Los_Angeles";
const laDtf = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LaParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function laParts(ms: number): LaParts {
  const p: Record<string, string> = {};
  for (const part of laDtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour),
    mm: Number(p.minute),
    ss: Number(p.second),
  };
}

// Epoch ms of Los Angeles local midnight on the given LA calendar date.
function laMidnightMs(y: number, m: number, d: number): number {
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = laParts(guess);
    const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    const target = Date.UTC(y, m - 1, d, 0, 0, 0);
    guess += target - wallAsUtc;
  }
  return guess;
}

interface WeekWindow {
  startMs: number;
  endMs: number;
  totalHours: number;
  startLabel: string; // LA date of the Monday, YYYY-MM-DD
  endLabel: string; // LA date of the Sunday, YYYY-MM-DD
}

function fmtDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function weekWindowContaining(ms: number): WeekWindow {
  const p = laParts(ms);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // days since Monday
  const mon = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  const sy = mon.getUTCFullYear();
  const sm = mon.getUTCMonth() + 1;
  const sd = mon.getUTCDate();
  const startMs = laMidnightMs(sy, sm, sd);
  const next = new Date(Date.UTC(sy, sm - 1, sd + 7));
  const endMs = laMidnightMs(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
  const sun = new Date(Date.UTC(sy, sm - 1, sd + 6));
  return {
    startMs,
    endMs,
    totalHours: (endMs - startMs) / 3_600_000,
    startLabel: fmtDate(sy, sm, sd),
    endLabel: fmtDate(
      sun.getUTCFullYear(),
      sun.getUTCMonth() + 1,
      sun.getUTCDate(),
    ),
  };
}

// ------------------------------------------------------------ interval math

interface Interval {
  startMs: number;
  endMs: number;
}

// Total minutes covered by the union of the intervals (timeline coverage).
function unionMinutes(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let curStart = sorted[0]!.startMs;
  let curEnd = sorted[0]!.endMs;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i]!;
    if (iv.startMs <= curEnd) {
      curEnd = Math.max(curEnd, iv.endMs);
    } else {
      total += curEnd - curStart;
      curStart = iv.startMs;
      curEnd = iv.endMs;
    }
  }
  total += curEnd - curStart;
  return total / 60_000;
}

function clip(iv: Interval, lo: number, hi: number): Interval | null {
  const startMs = Math.max(iv.startMs, lo);
  const endMs = Math.min(iv.endMs, hi);
  return endMs > startMs ? { startMs, endMs } : null;
}

// --------------------------------------------------------------- validation

const MAX_DURATION_MS = 31 * 24 * 3_600_000; // one record spans at most 31 days
const FUTURE_TOLERANCE_MS = 60_000; // clock-skew allowance for "already happened"

type Validation =
  | { ok: true }
  | { ok: false; error: "invalid_range" | "future_interval" };

function validateInterval(startMs: number, endMs: number, nowMs: number): Validation {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    endMs - startMs > MAX_DURATION_MS
  ) {
    return { ok: false, error: "invalid_range" };
  }
  if (endMs > nowMs + FUTURE_TOLERANCE_MS || startMs > nowMs + FUTURE_TOLERANCE_MS) {
    return { ok: false, error: "future_interval" };
  }
  return { ok: true };
}

async function fingerprint(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ------------------------------------------------------------------- DTOs

// Version of an entry: its persistent, monotonically non-regressing
// revision, rendered as an opaque token. The client reads it with the
// entry (entryDto.version) when it opens the editor and echoes it back as
// updateEntry's baseVersion; the server applies the edit only while the
// stored row still carries that exact revision. Because the revision
// increments on every successful mutation, two states with IDENTICAL
// content (an edit cycle that returns a field to an earlier value) still
// carry different versions — a content fingerprint cannot tell them apart
// and must never be used as the version. Exported so the offline
// validators can name the base of a row they seeded directly in SQL.
export function entryVersion(row: { revision: number }): string {
  return `rev-${row.revision}`;
}

const entryDto = z.object({
  id: z.number(),
  category: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  note: z.string(),
  version: z.string(),
});

type EntryDto = z.infer<typeof entryDto>;

function toDto(row: typeof schema.timeEntries.$inferSelect): EntryDto {
  return {
    id: row.id,
    category: row.category,
    startMs: row.startMs,
    endMs: row.endMs,
    note: row.note,
    version: entryVersion(row),
  };
}

const mutationResponse = z.object({
  ok: z.boolean(),
  // null on success; otherwise one of: forbidden | conflict | deleted |
  // stale_conflict | future_interval | invalid_range | invalid_category |
  // not_found. On stale_conflict, entry carries the CURRENT stored row so
  // the page can show it next to the preserved draft.
  error: z.string().nullable(),
  entry: entryDto.nullable(),
});

// ------------------------------------------------------- ledger resolution

function getDb(ctx: Ctx) {
  return ctx.db<typeof schema>();
}
type Db = ReturnType<typeof getDb>;

// How a requestId resolves against the COMMITTED ledger. Used both as the
// pre-write fast path and to re-resolve after an atomic batch failure (a
// concurrent same-key write may have committed while this one rolled back).
type KeyResolution =
  | { kind: "replay"; entry: EntryDto }
  | { kind: "conflict" }
  | { kind: "deleted" }
  | { kind: "absent" };

async function resolveCommittedKey(
  db: Db,
  requestId: string,
  fp: string,
): Promise<KeyResolution> {
  const existing = await db
    .select()
    .from(schema.requestLedger)
    .where(eq(schema.requestLedger.requestId, requestId))
    .limit(1);
  const key = existing[0];
  if (!key) return { kind: "absent" };
  if (key.fingerprint !== fp) return { kind: "conflict" };
  if (key.deleted === 1 || key.entryId == null) return { kind: "deleted" };
  const rows = await db
    .select()
    .from(schema.timeEntries)
    .where(eq(schema.timeEntries.id, key.entryId))
    .limit(1);
  const row = rows[0];
  if (!row) return { kind: "deleted" };
  return { kind: "replay", entry: toDto(row) };
}

function resolutionToResponse(
  res: KeyResolution,
): { ok: boolean; error: string | null; entry: EntryDto | null } | null {
  switch (res.kind) {
    case "replay":
      return { ok: true, error: null, entry: res.entry };
    case "conflict":
      return { ok: false, error: "conflict", entry: null };
    case "deleted":
      return { ok: false, error: "deleted", entry: null };
    case "absent":
      return null;
  }
}

// An update target that is not in time_entries: "deleted" when the ledger
// remembers the entry (a tombstone exists for it), "not_found" when the id
// never existed.
async function entryGoneResponse(
  db: Db,
  entryId: number,
): Promise<{ ok: boolean; error: string; entry: null }> {
  const tombstone = await db
    .select()
    .from(schema.requestLedger)
    .where(eq(schema.requestLedger.entryId, entryId))
    .limit(1);
  return {
    ok: false,
    error: tombstone[0] ? "deleted" : "not_found",
    entry: null,
  };
}

// ------------------------------------------------------------- week summary

const categoryMinutes = z.object({
  category: z.string(),
  minutes: z.number(),
});

const weekSummary = z.object({
  weekStartMs: z.number(),
  startLabel: z.string(),
  endLabel: z.string(),
  totalHours: z.number(), // actual local week length: 167 / 168 / 169
  coverageMinutes: z.number(), // union of intervals inside the week window
  categorySumMinutes: z.number(), // raw per-category sum (may exceed coverage)
  overlapMinutes: z.number(), // categorySum - coverage, >= 0
  byCategory: z.array(categoryMinutes),
  hasRecords: z.boolean(),
});

type WeekSummary = z.infer<typeof weekSummary>;

interface EntryRow {
  category: string;
  startMs: number;
  endMs: number;
}

function summarizeWeek(win: WeekWindow, entries: EntryRow[]): WeekSummary {
  const clipped: Interval[] = [];
  const perCat = new Map<string, number>();
  let categorySum = 0;
  for (const e of entries) {
    const c = clip(e, win.startMs, win.endMs);
    if (!c) continue;
    clipped.push(c);
    const mins = (c.endMs - c.startMs) / 60_000;
    perCat.set(e.category, (perCat.get(e.category) ?? 0) + mins);
    categorySum += mins;
  }
  const coverage = unionMinutes(clipped);
  return {
    weekStartMs: win.startMs,
    startLabel: win.startLabel,
    endLabel: win.endLabel,
    totalHours: win.totalHours,
    coverageMinutes: coverage,
    categorySumMinutes: categorySum,
    overlapMinutes: Math.max(0, categorySum - coverage),
    byCategory: CATEGORIES.filter((c) => (perCat.get(c) ?? 0) > 0).map((c) => ({
      category: c,
      minutes: perCat.get(c) ?? 0,
    })),
    hasRecords: clipped.length > 0,
  };
}

// ------------------------------------------------------------------ actions

const HISTORY_WEEKS = 12;

export const Actions = {
  getDashboard: defineAction({
    request: z.object({
      // Monday (epoch ms) of the week to detail; omitted = current LA week.
      weekStartMs: z.number().int().optional(),
    }),
    response: z.object({
      forbidden: z.boolean(),
      nowMs: z.number(),
      currentWeekStartMs: z.number(),
      priorities: z.array(z.string()),
      detail: z
        .object({
          summary: weekSummary,
          // Minutes of the detail week already past with no record coverage.
          // null when the week has not started (unknown, not zero).
          uncoveredElapsedMinutes: z.number().nullable(),
          // Minutes of the detail week still in the future (never "unrecorded").
          notYetMinutes: z.number(),
          entries: z.array(entryDto),
          priorityMinutes: z.array(categoryMinutes),
        })
        .nullable(),
      weeks: z.array(weekSummary),
      cumulativeCoverageMinutes: z.number(),
      weeksWithRecords: z.number(),
    }),
    async handler(ctx, args) {
      const nowMs = Date.now();
      const currentWin = weekWindowContaining(nowMs);
      const empty = {
        forbidden: true,
        nowMs,
        currentWeekStartMs: currentWin.startMs,
        priorities: [] as string[],
        detail: null,
        weeks: [] as WeekSummary[],
        cumulativeCoverageMinutes: 0,
        weeksWithRecords: 0,
      };
      if (!isOwner(ctx)) return empty;

      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.timeEntries)
        .orderBy(asc(schema.timeEntries.startMs));
      const entries: EntryRow[] = rows.map((r) => ({
        category: r.category,
        startMs: r.startMs,
        endMs: r.endMs,
      }));

      const prefRow = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "priorities"))
        .limit(1);
      let priorities: string[] = [];
      if (prefRow[0]) {
        try {
          const parsed: unknown = JSON.parse(prefRow[0].value);
          if (Array.isArray(parsed)) {
            priorities = parsed.filter(
              (v): v is string =>
                typeof v === "string" &&
                (CATEGORIES as readonly string[]).includes(v),
            );
          }
        } catch {
          priorities = [];
        }
      }

      // Trailing HISTORY_WEEKS week windows, oldest → newest.
      const windows: WeekWindow[] = [];
      let cursor = currentWin;
      for (let i = 0; i < HISTORY_WEEKS; i++) {
        windows.unshift(cursor);
        cursor = weekWindowContaining(cursor.startMs - 1);
      }
      const weeks = windows.map((w) => summarizeWeek(w, entries));

      // All-time accumulation: union over every record ever kept, and the
      // number of distinct weeks that hold at least one record.
      const cumulativeCoverageMinutes = unionMinutes(entries);
      const recordedWeeks = new Set<number>();
      for (const e of entries) {
        let w = weekWindowContaining(e.startMs);
        while (w.startMs < e.endMs) {
          if (clip(e, w.startMs, w.endMs)) recordedWeeks.add(w.startMs);
          if (w.endMs >= e.endMs) break;
          w = weekWindowContaining(w.endMs + 1);
        }
      }

      // Detail week: requested Monday snapped into its own window.
      let detailWin = currentWin;
      if (args.weekStartMs != null) {
        const snapped = weekWindowContaining(args.weekStartMs);
        if (snapped.startMs <= currentWin.startMs) detailWin = snapped;
      }
      const summary = summarizeWeek(detailWin, entries);
      const elapsedEnd = Math.min(nowMs, detailWin.endMs);
      const elapsedStarted = nowMs >= detailWin.startMs;
      const uncoveredElapsedMinutes = elapsedStarted
        ? Math.max(
            0,
            (elapsedEnd - detailWin.startMs) / 60_000 -
              unionMinutes(
                rows
                  .map((r) => clip(r, detailWin.startMs, elapsedEnd))
                  .filter((c): c is Interval => c !== null),
              ),
          )
        : null;
      const notYetMinutes = Math.max(
        0,
        (detailWin.endMs - Math.max(nowMs, detailWin.startMs)) / 60_000,
      );
      const detailEntries = rows
        .filter((r) => clip(r, detailWin.startMs, detailWin.endMs) !== null)
        .map(toDto);
      const prioMap = new Map(summary.byCategory.map((c) => [c.category, c.minutes]));
      const priorityMinutes = priorities.map((category) => ({
        category,
        minutes: prioMap.get(category) ?? 0,
      }));

      return {
        forbidden: false,
        nowMs,
        currentWeekStartMs: currentWin.startMs,
        priorities,
        detail: {
          summary,
          uncoveredElapsedMinutes,
          notYetMinutes,
          entries: detailEntries,
          priorityMinutes,
        },
        weeks,
        cumulativeCoverageMinutes,
        weeksWithRecords: recordedWeeks.size,
      };
    },
  }),

  addEntry: defineAction({
    request: z.object({
      requestId: z.string().min(8).max(128),
      category: categorySchema,
      startMs: z.number().int(),
      endMs: z.number().int(),
      note: z.string().max(500).default(""),
    }),
    response: mutationResponse,
    async handler(ctx, args) {
      if (!canMutate(ctx)) return { ok: false, error: "forbidden", entry: null };
      const valid = validateInterval(args.startMs, args.endMs, Date.now());
      if (!valid.ok) return { ok: false, error: valid.error, entry: null };

      const fp = await fingerprint({
        op: "add",
        category: args.category,
        startMs: args.startMs,
        endMs: args.endMs,
        note: args.note,
      });
      const db = getDb(ctx);
      const prior = resolutionToResponse(
        await resolveCommittedKey(db, args.requestId, fp),
      );
      if (prior) return prior; // replay / conflict / deleted — no write

      // Body row + ledger key in ONE atomic batch. The ledger's entry_id is
      // last_insert_rowid() of the entry insert in the same batch, so the
      // two rows commit together or not at all: a failure at either write
      // point leaves zero rows, and a concurrent same-key batch that loses
      // the ledger primary-key race rolls its entry insert back with it.
      try {
        await db.batch([
          db.insert(schema.timeEntries).values({
            category: args.category,
            startMs: args.startMs,
            endMs: args.endMs,
            note: args.note,
          }),
          db.insert(schema.requestLedger).values({
            requestId: args.requestId,
            fingerprint: fp,
            entryId: sql`last_insert_rowid()`,
            deleted: 0,
          }),
        ]);
      } catch (err) {
        // Rolled back. If a concurrent same-key write committed first, this
        // call resolves against that committed key instead of erroring.
        const after = resolutionToResponse(
          await resolveCommittedKey(db, args.requestId, fp),
        );
        if (after) {
          if (after.ok) ctx.invalidateQueries();
          return after;
        }
        throw err; // genuine failure, zero partial state (batch rolled back)
      }
      const committed = resolutionToResponse(
        await resolveCommittedKey(db, args.requestId, fp),
      );
      if (!committed || !committed.ok || !committed.entry) {
        throw new Error("addEntry: batch committed but ledger row missing");
      }
      ctx.invalidateQueries();
      return committed;
    },
  }),

  updateEntry: defineAction({
    request: z.object({
      requestId: z.string().min(8).max(128),
      entryId: z.number().int().positive(),
      category: categorySchema,
      startMs: z.number().int(),
      endMs: z.number().int(),
      note: z.string().max(500).default(""),
      // The revision of the entry as the editor read it
      // (entryDto.version at open time): the edit applies only while the
      // stored row still carries this base revision. Optional in the
      // schema ONLY so pre-version clients still parse — a base-less
      // update is rejected as stale_conflict below and can never silently
      // overwrite a stored row that may have moved since that client last
      // read it.
      baseVersion: z.string().min(1).max(64).optional(),
    }),
    response: mutationResponse,
    async handler(ctx, args) {
      if (!canMutate(ctx)) return { ok: false, error: "forbidden", entry: null };
      const valid = validateInterval(args.startMs, args.endMs, Date.now());
      if (!valid.ok) return { ok: false, error: valid.error, entry: null };

      const fp = await fingerprint({
        op: "update",
        entryId: args.entryId,
        category: args.category,
        startMs: args.startMs,
        endMs: args.endMs,
        note: args.note,
        base: args.baseVersion ?? null,
      });
      const db = getDb(ctx);
      // Replay of an already-committed key reports the entry as it NOW
      // stands (a newer edit may have superseded this payload) and never
      // writes again — the only no-write replay path, kept for committed
      // keys regardless of base.
      const prior = resolutionToResponse(
        await resolveCommittedKey(db, args.requestId, fp),
      );
      if (prior) return prior;

      const rows = await db
        .select()
        .from(schema.timeEntries)
        .where(eq(schema.timeEntries.id, args.entryId))
        .limit(1);
      const current = rows[0];
      if (!current) return entryGoneResponse(db, args.entryId);

      // Base arbitration, pre-check: the edit intent names the exact
      // revision it was drafted against. Arrival order is NOT intent
      // order: a retry of an edit that FAILED earlier carries the base from
      // before a newer edit was saved, and must not win just for arriving
      // last — even when the newer edits cycled the content back to
      // exactly what the stale base saw (A→B→A), because the revision has
      // moved on even though the content has not. A moved base — or no
      // base at all (legacy caller) — is a typed stale_conflict carrying
      // the current stored row, with zero body writes and zero ledger
      // writes for this key.
      if (
        args.baseVersion == null ||
        entryVersion(current) !== args.baseVersion
      ) {
        return { ok: false, error: "stale_conflict", entry: toDto(current) };
      }

      // Atomic arbitration inside ONE batch, closing the race between the
      // pre-check above and the write: the body UPDATE is a compare-and-
      // swap that only matches while the stored row still carries the
      // verified base revision, and as part of the same statement bumps the
      // revision to base+1; the ledger INSERT is an INSERT ... SELECT that
      // only lands when the row now carries exactly base+1 — i.e. only
      // when THIS batch's CAS is the write that produced the new revision.
      // The CAS and the ledger success record therefore commit or roll back
      // together: no interleaving can leave one without the other. If the
      // base moved — or the entry was deleted — inside that window, both
      // statements write zero rows and the batch still commits clean; if
      // either write point fails, the batch rolls both back.
      const baseRevision = current.revision;
      const now = new Date();
      const nowMs = now.getTime();
      try {
        await db.batch([
          db
            .update(schema.timeEntries)
            .set({
              category: args.category,
              startMs: args.startMs,
              endMs: args.endMs,
              note: args.note,
              revision: sql`${schema.timeEntries.revision} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.timeEntries.id, args.entryId),
                eq(schema.timeEntries.revision, baseRevision),
              ),
            ),
          db.run(sql`
            INSERT INTO request_ledger (request_id, fingerprint, entry_id, deleted, created_at)
            SELECT ${args.requestId}, ${fp}, id, 0, ${nowMs}
            FROM time_entries
            WHERE id = ${args.entryId}
              AND revision = ${baseRevision + 1}
              AND category = ${args.category}
              AND start_ms = ${args.startMs}
              AND end_ms = ${args.endMs}
              AND note = ${args.note}
          `),
        ]);
      } catch (err) {
        // Rolled back. If a concurrent same-key write committed first, this
        // call resolves against that committed key instead of erroring.
        const after = resolutionToResponse(
          await resolveCommittedKey(db, args.requestId, fp),
        );
        if (after) {
          if (after.ok) ctx.invalidateQueries();
          return after;
        }
        throw err; // genuine failure, zero partial state (batch rolled back)
      }
      const committed = resolutionToResponse(
        await resolveCommittedKey(db, args.requestId, fp),
      );
      if (committed) {
        if (committed.ok) ctx.invalidateQueries();
        return committed;
      }
      // The batch committed with zero writes: the base moved (or the entry
      // was deleted) inside the race window. Report against the row as it
      // now stands — still zero body writes, zero ledger writes.
      const afterRows = await db
        .select()
        .from(schema.timeEntries)
        .where(eq(schema.timeEntries.id, args.entryId))
        .limit(1);
      if (!afterRows[0]) return entryGoneResponse(db, args.entryId);
      return {
        ok: false,
        error: "stale_conflict",
        entry: toDto(afterRows[0]),
      };
    },
  }),

  deleteEntry: defineAction({
    request: z.object({
      requestId: z.string().min(8).max(128),
      entryId: z.number().int().positive(),
    }),
    response: mutationResponse,
    async handler(ctx, args) {
      if (!canMutate(ctx)) return { ok: false, error: "forbidden", entry: null };
      const fp = await fingerprint({ op: "delete", entryId: args.entryId });
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.requestLedger)
        .where(eq(schema.requestLedger.requestId, args.requestId))
        .limit(1);
      const key = existing[0];
      if (key) {
        if (key.fingerprint !== fp) {
          return { ok: false, error: "conflict", entry: null };
        }
        return { ok: true, error: null, entry: null }; // already deleted; replay
      }

      const rows = await db
        .select()
        .from(schema.timeEntries)
        .where(eq(schema.timeEntries.id, args.entryId))
        .limit(1);
      if (!rows[0]) {
        const tombstone = await db
          .select()
          .from(schema.requestLedger)
          .where(eq(schema.requestLedger.entryId, args.entryId))
          .limit(1);
        return {
          ok: false,
          error: tombstone[0] ? "deleted" : "not_found",
          entry: null,
        };
      }

      // Delete + tombstone flags + this key's ledger row in ONE atomic
      // batch: a failure at any write point leaves the entry and every
      // ledger flag untouched, so no half-deleted state can exist.
      try {
        await db.batch([
          db
            .delete(schema.timeEntries)
            .where(eq(schema.timeEntries.id, args.entryId)),
          // Flag every key that ever touched this entry: a late retry of the
          // original create (or of an update) must resolve to "deleted",
          // never resurrect the row.
          db
            .update(schema.requestLedger)
            .set({ deleted: 1 })
            .where(eq(schema.requestLedger.entryId, args.entryId)),
          db.insert(schema.requestLedger).values({
            requestId: args.requestId,
            fingerprint: fp,
            entryId: args.entryId,
            deleted: 1,
          }),
        ]);
      } catch (err) {
        // Rolled back. A concurrent same-key delete may have committed:
        // resolve against the committed ledger before surfacing.
        const existing = await db
          .select()
          .from(schema.requestLedger)
          .where(eq(schema.requestLedger.requestId, args.requestId))
          .limit(1);
        const key = existing[0];
        if (key) {
          if (key.fingerprint !== fp) {
            return { ok: false, error: "conflict", entry: null };
          }
          ctx.invalidateQueries();
          return { ok: true, error: null, entry: null };
        }
        throw err; // genuine failure, zero partial state (batch rolled back)
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, entry: null };
    },
  }),

  setPriorities: defineAction({
    request: z.object({
      priorities: z.array(categorySchema).max(CATEGORIES.length),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    async handler(ctx, args) {
      if (!canMutate(ctx)) return { ok: false, error: "forbidden" };
      const db = ctx.db<typeof schema>();
      const value = JSON.stringify([...new Set(args.priorities)]);
      await db
        .insert(schema.settings)
        .values({ key: "priorities", value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value, updatedAt: new Date() },
        });
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),
} satisfies ActionsModule;
