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
// - The request-key lifecycle lives in family_request_keys, a ledger
//   that survives deletion (CMP-FAMILY-SAVE-001): each key remembers
//   the canonical payload it saved and whether its record is 'saved'
//   or 'deleted'. A same-key retry with different content is a typed
//   conflict (nothing written, the stored record untouched); a retry
//   of a deleted record is typed 'deleted' and can never resurrect it.
// - A record stores a snapshot of its type name, so deleting a type from
//   the type list never rewrites or drops recorded history.
// - deleteActivity removes exactly one row by id; every total, the
//   weekly series, and the calendar counts are recomputed from the live
//   record set on each read, so a deletion corrects all of them.
// - Future dates are not completed facts (CMP-FAMILY-DATE-001): a save
//   dated after today (America/Los_Angeles) is refused with a typed
//   'future' result, and pre-existing future-dated rows are excluded
//   from every total/series/calendar figure — counted separately as
//   futureRecordCount and still listed so the owner can delete them.

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

// Canonical payload fingerprint for a save: the exact content a
// request key stands for. Stored in the request-key ledger so a retry
// can be compared field-for-field against what was originally saved.
function canonicalPayload(
  date: string,
  typeName: string,
  minutes: number | null,
  note: string | null,
): string {
  return JSON.stringify({ date, typeName, minutes, note });
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
  futureRecordCount: z.number(),
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
    futureRecordCount: 0,
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
  conflict: z.boolean(),
  deleted: z.boolean(),
  future: z.boolean(),
});

type AddActivityResult = z.infer<typeof addActivityResponse>;

// Every non-success addActivity outcome, fully typed: callers branch on
// exactly one flag (forbidden / conflict / deleted / future) or on the
// plain invalid-date refusal where all flags stay false.
function addRefusal(flags: Partial<AddActivityResult>): AddActivityResult {
  return {
    ok: false,
    forbidden: false,
    id: null,
    duplicate: false,
    conflict: false,
    deleted: false,
    future: false,
    ...flags,
  };
}

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

      // Materialize the preset types exactly once, claimed atomically
      // (CMP-FAMILY-INIT-001): the claim is a single
      // INSERT … ON CONFLICT DO NOTHING … RETURNING, so of any number
      // of concurrent first reads exactly one caller wins the claim
      // and inserts the 7 presets — there is no check-then-write
      // window. If the preset insert fails, the claim row is removed
      // before rethrowing so a retry can seed cleanly (no half-seeded
      // state). Once claimed, the meta row stays forever: after the
      // owner deletes every type, later reads never resurrect presets.
      const claimed = await db.all<{ key: string }>(sql`
        INSERT INTO ledger_meta (key, value) VALUES ('types_seeded', '1')
        ON CONFLICT(key) DO NOTHING
        RETURNING key
      `);
      if (claimed.length > 0) {
        try {
          const now = Date.now();
          await db.insert(schema.activityTypes).values(
            schema.PRESET_TYPES.map((name, i) => ({
              name,
              isPreset: 1,
              createdAt: new Date(now + i),
            })),
          );
        } catch (err) {
          await db
            .delete(schema.ledgerMeta)
            .where(eq(schema.ledgerMeta.key, "types_seeded"));
          throw err;
        }
      }

      const typeRows = await db
        .select()
        .from(schema.activityTypes)
        .orderBy(asc(schema.activityTypes.id));
      const allRows = await db
        .select()
        .from(schema.familyActivities)
        .orderBy(asc(schema.familyActivities.date), asc(schema.familyActivities.id));

      // Future-dated rows (only possible from before the future-date
      // refusal existed) are not completed facts: they are excluded
      // from every total, the weekly series and the calendar, counted
      // separately as futureRecordCount, and still listed in
      // recentActivities below so the owner can see and delete them.
      // They are never silently deleted or edited here.
      const rows = allRows.filter((r) => r.date <= today);
      const futureRecordCount = allRows.length - rows.length;

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

      // Recent list spans ALL rows, future-dated ones included: the
      // owner must be able to see (and delete) a future-dated record
      // even though it counts toward nothing yet.
      const recentActivities: Dashboard["recentActivities"] = [...allRows]
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
        futureRecordCount,
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
    async handler(ctx, args): Promise<AddActivityResult> {
      if (!isOwner(ctx)) return addRefusal({ forbidden: true });
      if (!isRealDateKey(args.date)) return addRefusal({});
      // A future date is not a completed fact: refuse, write nothing.
      if (args.date > todayKey()) return addRefusal({ future: true });
      const db = ctx.db<typeof schema>();
      const note = args.note && args.note.length > 0 ? args.note : null;
      const payload = canonicalPayload(args.date, args.typeName, args.minutes, note);
      const now = Date.now();

      // (a) The request-key ledger is the authority on this key's
      // lifecycle. A stored payload that differs from the incoming one
      // means the same submission was edited after its first save:
      // typed conflict, nothing written, the stored record untouched.
      // A matching payload replays the original outcome: the original
      // id while 'saved', a typed refusal once 'deleted'.
      const ledgerRows = await db
        .select()
        .from(schema.familyRequestKeys)
        .where(eq(schema.familyRequestKeys.requestKey, args.requestKey));
      const ledger = ledgerRows[0];
      if (ledger) {
        if (ledger.payload !== payload) return addRefusal({ conflict: true });
        if (ledger.state === "deleted") return addRefusal({ deleted: true });
        return {
          ok: true,
          forbidden: false,
          id: ledger.activityId,
          duplicate: true,
          conflict: false,
          deleted: false,
          future: false,
        };
      }

      // (b) No ledger row, but a pre-ledger activity already carries
      // this key: backfill the ledger from the stored row's own
      // fields, then apply the same payload comparison.
      const legacyRows = await db
        .select()
        .from(schema.familyActivities)
        .where(eq(schema.familyActivities.requestKey, args.requestKey));
      const legacy = legacyRows[0];
      if (legacy) {
        const storedPayload = canonicalPayload(
          legacy.date,
          legacy.typeName,
          legacy.minutes,
          legacy.note,
        );
        await db.insert(schema.familyRequestKeys).values({
          requestKey: args.requestKey,
          payload: storedPayload,
          activityId: legacy.id,
          state: "saved",
          createdAt: now,
          updatedAt: now,
        });
        if (storedPayload !== payload) return addRefusal({ conflict: true });
        return {
          ok: true,
          forbidden: false,
          id: legacy.id,
          duplicate: true,
          conflict: false,
          deleted: false,
          future: false,
        };
      }

      // (c) Fresh key: one conditional statement — the existence check
      // on the request key and the insert are a single atomic step,
      // and the UNIQUE index on request_key backs it at the storage
      // layer. The ledger row is written with the new activity id, so
      // the two always agree; a same-key same-payload retry is
      // answered by step (a) with the original row, never a second
      // record.
      const inserted = await db.all<{ id: number }>(sql`
        INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at)
        SELECT ${args.date}, ${args.typeName}, ${args.minutes}, ${note}, ${args.requestKey}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM family_activities WHERE request_key = ${args.requestKey})
        RETURNING id
      `);
      const row = inserted[0];
      if (row) {
        await db.insert(schema.familyRequestKeys).values({
          requestKey: args.requestKey,
          payload,
          activityId: row.id,
          state: "saved",
          createdAt: now,
          updatedAt: now,
        });
        ctx.invalidateQueries();
        return {
          ok: true,
          forbidden: false,
          id: row.id,
          duplicate: false,
          conflict: false,
          deleted: false,
          future: false,
        };
      }
      // The conditional insert lost a race: another save with this key
      // landed first. Answer with that row as a duplicate.
      const raced = await db
        .select({ id: schema.familyActivities.id })
        .from(schema.familyActivities)
        .where(eq(schema.familyActivities.requestKey, args.requestKey));
      const found = raced[0];
      if (found) {
        return {
          ok: true,
          forbidden: false,
          id: found.id,
          duplicate: true,
          conflict: false,
          deleted: false,
          future: false,
        };
      }
      return addRefusal({});
    },
  }),

  deleteActivity: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      const targets = await db
        .select()
        .from(schema.familyActivities)
        .where(eq(schema.familyActivities.id, args.id));
      const target = targets[0];
      if (!target) return { ok: false, forbidden: false };
      // Tombstone the record's request key in the ledger BEFORE the
      // row goes away: the ledger row is upserted to 'deleted'
      // (created from the activity's stored key and fields when none
      // exists), so a late retry of that save is typed-rejected and
      // can never resurrect the record. The ledger row itself is
      // never deleted. Records with a NULL/legacy missing request key
      // have no key to tombstone and delete exactly as before.
      if (target.requestKey !== null) {
        const now = Date.now();
        await db.all(sql`
          INSERT INTO family_request_keys (request_key, payload, activity_id, state, created_at, updated_at)
          VALUES (
            ${target.requestKey},
            ${canonicalPayload(target.date, target.typeName, target.minutes, target.note)},
            ${target.id},
            'deleted',
            ${now},
            ${now}
          )
          ON CONFLICT(request_key) DO UPDATE SET
            state = 'deleted',
            updated_at = ${now}
        `);
      }
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
      // One conditional statement (CMP-FAMILY-INIT-001): the
      // same-exact-name check and the insert are a single atomic step,
      // so two concurrent adds of the same name produce exactly one
      // type row — the loser inserts zero rows and reads back the
      // existing type as a duplicate.
      const inserted = await db.all<{ id: number }>(sql`
        INSERT INTO activity_types (name, is_preset, created_at)
        SELECT ${args.name}, 0, ${Date.now()}
        WHERE NOT EXISTS (SELECT 1 FROM activity_types WHERE name = ${args.name})
        RETURNING id
      `);
      const row = inserted[0];
      if (row) {
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, id: row.id, duplicate: false };
      }
      const existing = await db
        .select({ id: schema.activityTypes.id })
        .from(schema.activityTypes)
        .where(eq(schema.activityTypes.name, args.name));
      const found = existing[0];
      if (found) {
        return { ok: true, forbidden: false, id: found.id, duplicate: true };
      }
      return { ok: false, forbidden: false, id: null, duplicate: false };
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
