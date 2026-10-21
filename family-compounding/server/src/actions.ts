// 陪伴复利 actions.
//
// Data model: a flat ledger of family activities the owner records by
// hand — a local date, a self-chosen type label, an optional duration in
// minutes (NULL = unknown, never treated as 0), and an optional one-line
// note — plus the owner's own activity-type list (presets materialized
// once, then fully owner-managed).
//
// 口径 (CMP-FAMILY-001): 只让积累可见。这本账不打分、不排名、不算连续
// 天数、不断签惩罚;未知时长只标注条数,永不折算进时长合计;没有记录
// 的日期就是没有记录,不推断"没陪伴"。不读外部日历,不接任何外部
// 账户,不存第三方姓名。
//
// ACL: every action is owner-only. Each handler runs the strict isOwner
// gate BEFORE any database read/write; refused calls return a typed
// rejection ({ ok: false, forbidden: true } / a forbidden dashboard
// carrying zero rows) and touch zero rows. There is no anonymous or
// sync-channel exception here.
//
// Write integrity:
// - addActivity carries a client-generated request key. The write is a
//   single conditional INSERT … SELECT … WHERE NOT EXISTS(same key)
//   statement, and request_key has a UNIQUE index: a retried save with
//   the same key can never create a second record — the handler reports
//   the existing row with duplicate: true instead.
// - A record stores a snapshot of its type name, so deleting a type from
//   the type list never rewrites or drops recorded history.
// - deleteActivity removes exactly one row by id; every total, the
//   weekly series, and the calendar counts are recomputed from the live
//   record set on each read, so a deletion corrects all of them.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "./schema";

// Strict owner gate: only a verified owner viewer passes. Identified
// non-owners and anonymous calls (no viewer at all) are both refused.
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

function shiftDay(key: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Weeks run Monday..Sunday. Returns the Monday of the week containing key.
function weekStartOf(key: string): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = (dow + 6) % 7;
  return shiftDay(key, -sinceMonday);
}

// A date key must be a real calendar date, not just shaped like one.
function isRealDateKey(key: string): boolean {
  if (!dateKeyRe.test(key)) return false;
  const [y = 0, m = 0, d = 0] = key.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/* ---------------- response schemas ---------------- */

const activitySchema = z.object({
  id: z.number(),
  date: z.string(),
  typeName: z.string(),
  minutes: z.number().nullable(),
  note: z.string().nullable(),
});

const typeSchema = z.object({
  id: z.number(),
  name: z.string(),
  isPreset: z.boolean(),
});

const weekPointSchema = z.object({
  weekStart: z.string(),
  newCount: z.number(),
  cumulative: z.number(),
});

const monthDaysSchema = z.object({
  month: z.string(), // "YYYY-MM"
  days: z.array(z.object({ date: z.string(), count: z.number() })),
});

const dashboardResponse = z.object({
  forbidden: z.boolean(),
  today: z.string(),
  totalCount: z.number(),
  totalKnownMinutes: z.number(),
  unknownMinutesCount: z.number(),
  thisMonthCount: z.number(),
  thisMonth: z.string(), // "YYYY-MM" of today
  lastActivityDate: z.string().nullable(),
  types: z.array(typeSchema),
  series: z.array(weekPointSchema),
  calendar: z.array(monthDaysSchema),
  recentActivities: z.array(activitySchema),
});

type Dashboard = z.infer<typeof dashboardResponse>;

// A refused dashboard carries zero data: no counts, no rows, no types —
// nothing about the ledger leaks to a non-owner.
function forbiddenDashboard(): Dashboard {
  return {
    forbidden: true,
    today: todayKey(),
    totalCount: 0,
    totalKnownMinutes: 0,
    unknownMinutesCount: 0,
    thisMonthCount: 0,
    thisMonth: todayKey().slice(0, 7),
    lastActivityDate: null,
    types: [],
    series: [],
    calendar: [],
    recentActivities: [],
  };
}

const okResponse = z.object({ ok: z.boolean(), forbidden: z.boolean() });

const addActivityResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  id: z.number().nullable(),
  duplicate: z.boolean(),
});

const addTypeResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  id: z.number().nullable(),
  duplicate: z.boolean(),
});

/* ---------------- actions ---------------- */

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<Dashboard> {
      if (!isOwner(ctx)) return forbiddenDashboard();
      const db = ctx.db<typeof schema>();
      const today = todayKey();
      const thisMonth = today.slice(0, 7);

      // Materialize the preset types exactly once (guarded by the
      // ledger_meta flag, in one batch). After that the type list is
      // entirely the owner's: deleting every type stays deleted.
      const seeded = await db
        .select()
        .from(schema.ledgerMeta)
        .where(eq(schema.ledgerMeta.key, "types_seeded"));
      if (seeded.length === 0) {
        const now = Date.now();
        await db.batch([
          db.insert(schema.activityTypes).values(
            schema.PRESET_TYPES.map((name, i) => ({
              name,
              isPreset: 1,
              createdAt: new Date(now + i),
            })),
          ),
          db
            .insert(schema.ledgerMeta)
            .values({ key: "types_seeded", value: "1" }),
        ]);
      }

      const typeRows = await db
        .select()
        .from(schema.activityTypes)
        .orderBy(asc(schema.activityTypes.id));
      const rows = await db
        .select()
        .from(schema.familyActivities)
        .orderBy(asc(schema.familyActivities.date), asc(schema.familyActivities.id));

      // Totals are plain facts over the live record set. Unknown
      // durations (minutes NULL) count as activities but contribute
      // nothing to the known-duration total — never 0-filled.
      let totalKnownMinutes = 0;
      let unknownMinutesCount = 0;
      let thisMonthCount = 0;
      for (const r of rows) {
        if (r.minutes === null) unknownMinutesCount += 1;
        else totalKnownMinutes += r.minutes;
        if (r.date.slice(0, 7) === thisMonth) thisMonthCount += 1;
      }
      const lastRow = rows[rows.length - 1];

      // Weekly accumulation series: one point per week from the first
      // record's week through the current week (or the last record's
      // week, if that is later). Weeks with no records stay in the
      // series with newCount 0 and a flat cumulative — real gaps, never
      // backfilled, and the cumulative never decreases.
      const byWeek = new Map<string, number>();
      for (const r of rows) {
        const ws = weekStartOf(r.date);
        byWeek.set(ws, (byWeek.get(ws) ?? 0) + 1);
      }
      const series: Dashboard["series"] = [];
      if (rows.length > 0) {
        const firstWeek = weekStartOf(rows[0]?.date ?? today);
        const currentWeek = weekStartOf(today);
        const lastWeek = weekStartOf(lastRow?.date ?? today);
        const endWeek = lastWeek > currentWeek ? lastWeek : currentWeek;
        let cumulative = 0;
        for (let w = firstWeek; w <= endWeek; w = shiftDay(w, 7)) {
          const n = byWeek.get(w) ?? 0;
          cumulative += n;
          series.push({ weekStart: w, newCount: n, cumulative });
        }
      }

      // Calendar counts: only dates that actually have records appear.
      // A date with no entry is absent — it means "not recorded",
      // nothing more.
      const byMonth = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const month = r.date.slice(0, 7);
        const days = byMonth.get(month) ?? new Map<string, number>();
        days.set(r.date, (days.get(r.date) ?? 0) + 1);
        byMonth.set(month, days);
      }
      const calendar: Dashboard["calendar"] = [...byMonth.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, days]) => ({
          month,
          days: [...days.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([date, count]) => ({ date, count })),
        }));

      const recentActivities: Dashboard["recentActivities"] = [...rows]
        .sort((a, b) => b.id - a.id)
        .slice(0, 30)
        .map((r) => ({
          id: r.id,
          date: r.date,
          typeName: r.typeName,
          minutes: r.minutes ?? null,
          note: r.note ?? null,
        }));

      return {
        forbidden: false,
        today,
        totalCount: rows.length,
        totalKnownMinutes,
        unknownMinutesCount,
        thisMonthCount,
        thisMonth,
        lastActivityDate: lastRow ? lastRow.date : null,
        types: typeRows.map((t) => ({
          id: t.id,
          name: t.name,
          isPreset: t.isPreset === 1,
        })),
        series,
        calendar,
        recentActivities,
      };
    },
  }),

  addActivity: defineAction({
    request: z.object({
      date: z.string().regex(dateKeyRe),
      typeName: z.string().trim().min(1).max(20),
      minutes: z.number().int().min(1).max(1440).nullable(),
      note: z.string().trim().max(80).nullable(),
      requestKey: z.string().min(8).max(64),
    }),
    response: addActivityResponse,
    async handler(ctx, args): Promise<z.infer<typeof addActivityResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, id: null, duplicate: false };
      if (!isRealDateKey(args.date)) {
        return { ok: false, forbidden: false, id: null, duplicate: false };
      }
      const db = ctx.db<typeof schema>();
      const note = args.note && args.note.length > 0 ? args.note : null;
      // One conditional statement: the existence check on the request
      // key and the insert are a single atomic step, and the UNIQUE
      // index on request_key backs it at the storage layer. A retry
      // with the same key affects zero rows and is answered with the
      // existing record's id.
      const inserted = await db.all<{ id: number }>(sql`
        INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at)
        SELECT ${args.date}, ${args.typeName}, ${args.minutes}, ${note}, ${args.requestKey}, ${Date.now()}
        WHERE NOT EXISTS (SELECT 1 FROM family_activities WHERE request_key = ${args.requestKey})
        RETURNING id
      `);
      const row = inserted[0];
      if (row) {
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, id: row.id, duplicate: false };
      }
      const existing = await db
        .select({ id: schema.familyActivities.id })
        .from(schema.familyActivities)
        .where(eq(schema.familyActivities.requestKey, args.requestKey));
      const found = existing[0];
      if (found) {
        return { ok: true, forbidden: false, id: found.id, duplicate: true };
      }
      return { ok: false, forbidden: false, id: null, duplicate: false };
    },
  }),

  deleteActivity: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      const removed = await db
        .delete(schema.familyActivities)
        .where(eq(schema.familyActivities.id, args.id))
        .returning({ id: schema.familyActivities.id });
      if (removed.length > 0) ctx.invalidateQueries();
      return { ok: removed.length > 0, forbidden: false };
    },
  }),

  addType: defineAction({
    request: z.object({ name: z.string().trim().min(1).max(20) }),
    response: addTypeResponse,
    async handler(ctx, args): Promise<z.infer<typeof addTypeResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, id: null, duplicate: false };
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.activityTypes.id })
        .from(schema.activityTypes)
        .where(eq(schema.activityTypes.name, args.name));
      const found = existing[0];
      if (found) {
        return { ok: true, forbidden: false, id: found.id, duplicate: true };
      }
      const inserted = await db
        .insert(schema.activityTypes)
        .values({ name: args.name, isPreset: 0 })
        .returning({ id: schema.activityTypes.id });
      const row = inserted[0];
      if (!row) return { ok: false, forbidden: false, id: null, duplicate: false };
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, id: row.id, duplicate: false };
    },
  }),

  deleteType: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      // Only the type-list entry goes away. Records keep the type name
      // they were saved with (snapshot), so history is never rewritten.
      const removed = await db
        .delete(schema.activityTypes)
        .where(eq(schema.activityTypes.id, args.id))
        .returning({ id: schema.activityTypes.id });
      if (removed.length > 0) ctx.invalidateQueries();
      return { ok: removed.length > 0, forbidden: false };
    },
  }),
} satisfies ActionsModule;
