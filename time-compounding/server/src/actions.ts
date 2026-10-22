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
// - Every read and write requires the owner (ctx.viewer?.isOwner === true).
//   Guests / anonymous / missing viewer get a typed forbidden with zero data.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
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

const entryDto = z.object({
  id: z.number(),
  category: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  note: z.string(),
});

type EntryDto = z.infer<typeof entryDto>;

function toDto(row: typeof schema.timeEntries.$inferSelect): EntryDto {
  return {
    id: row.id,
    category: row.category,
    startMs: row.startMs,
    endMs: row.endMs,
    note: row.note,
  };
}

const mutationResponse = z.object({
  ok: z.boolean(),
  // null on success; otherwise one of: forbidden | conflict | deleted |
  // future_interval | invalid_range | invalid_category | not_found
  error: z.string().nullable(),
  entry: entryDto.nullable(),
});

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
        if (key.deleted === 1 || key.entryId == null) {
          return { ok: false, error: "deleted", entry: null };
        }
        const rows = await db
          .select()
          .from(schema.timeEntries)
          .where(eq(schema.timeEntries.id, key.entryId))
          .limit(1);
        const row = rows[0];
        if (!row) return { ok: false, error: "deleted", entry: null };
        return { ok: true, error: null, entry: toDto(row) }; // idempotent replay
      }

      const inserted = await db
        .insert(schema.timeEntries)
        .values({
          category: args.category,
          startMs: args.startMs,
          endMs: args.endMs,
          note: args.note,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("addEntry: insert returned no rows");
      await db.insert(schema.requestLedger).values({
        requestId: args.requestId,
        fingerprint: fp,
        entryId: row.id,
        deleted: 0,
      });
      ctx.invalidateQueries();
      return { ok: true, error: null, entry: toDto(row) };
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
      });
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
        if (key.deleted === 1) {
          return { ok: false, error: "deleted", entry: null };
        }
        // Replay of an already-applied update: report the entry as it now
        // stands without writing again.
        const rows = await db
          .select()
          .from(schema.timeEntries)
          .where(eq(schema.timeEntries.id, args.entryId))
          .limit(1);
        const row = rows[0];
        if (!row) return { ok: false, error: "deleted", entry: null };
        return { ok: true, error: null, entry: toDto(row) };
      }

      const rows = await db
        .select()
        .from(schema.timeEntries)
        .where(eq(schema.timeEntries.id, args.entryId))
        .limit(1);
      if (!rows[0]) {
        // The entry is gone: if the ledger remembers it, it was deleted;
        // otherwise the id never existed.
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

      await db
        .update(schema.timeEntries)
        .set({
          category: args.category,
          startMs: args.startMs,
          endMs: args.endMs,
          note: args.note,
          updatedAt: new Date(),
        })
        .where(eq(schema.timeEntries.id, args.entryId));
      await db.insert(schema.requestLedger).values({
        requestId: args.requestId,
        fingerprint: fp,
        entryId: args.entryId,
        deleted: 0,
      });
      const after = await db
        .select()
        .from(schema.timeEntries)
        .where(eq(schema.timeEntries.id, args.entryId))
        .limit(1);
      ctx.invalidateQueries();
      return { ok: true, error: null, entry: after[0] ? toDto(after[0]) : null };
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
