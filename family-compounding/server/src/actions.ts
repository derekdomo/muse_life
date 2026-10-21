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
// - ctx.db has no transaction method; db.batch is the only atomic
//   primitive (one transaction, any statement failing rolls the whole
//   batch back, and batch elements must be drizzle query builders).
//   Every multi-row write below is therefore ONE db.batch of builder
//   statements, followed by a re-read that adjudicates the outcome
//   from the stored state — never from assumptions about which
//   statement "won".
// - addActivity carries a client-generated request key. A fresh save
//   is one batch: claim the key in the request-key ledger
//   (INSERT … ON CONFLICT DO NOTHING) and insert the activity
//   (INSERT … ON CONFLICT DO NOTHING, backed by the UNIQUE index on
//   request_key). After the batch the handler re-reads the ledger row
//   and the activity row and adjudicates: a stored payload differing
//   from the incoming one is a typed conflict (nothing of this call
//   survives); a 'deleted' ledger row is a typed deleted refusal; an
//   existing activity row is success (duplicate iff the row already
//   existed before this call's batch); a 'saved' ledger row with no
//   activity row converges to the deleted refusal. If the batch itself
//   throws, the same re-read adjudication runs once; only when it
//   cannot decide does the call return a plain refusal — the rolled
//   back batch guarantees no half-written pair is left behind.
// - The request-key lifecycle lives in family_request_keys, a ledger
//   that survives deletion (CMP-FAMILY-SAVE-001): each key remembers
//   the canonical payload it saved and whether its record is 'saved'
//   or 'deleted'. A same-key retry with different content is a typed
//   conflict (nothing written, the stored record untouched); a retry
//   of a deleted record is typed 'deleted' and can never resurrect it.
// - Storage-level backstop (migration 0004): a BEFORE INSERT trigger
//   on family_activities aborts any insert whose request key already
//   has a 'deleted' ledger row, so a save batch that lands after a
//   delete batch has committed rolls back whole and is adjudicated
//   deleted on re-read — a deleted record cannot be resurrected by an
//   interleaved save.
// - deleteActivity is one batch too: the ledger tombstone upsert and
//   the activity delete commit or roll back together, so the ledger
//   can never say 'deleted' while the record still exists.
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

import {
defineAction,
z,
type ActionsModule,
type Ctx,
type SpaceDb,
} from "@hatch/space-sdk";
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

/* ---------------- request-key adjudication ---------------- */

type Db = SpaceDb<typeof schema>;

// The one adjudication rule, applied identically by every addActivity
// path (ledger fast path, legacy backfill, fresh-save re-read, and the
// re-read after a failed batch): the stored ledger row and the stored
// activity row decide the outcome, in this order —
//   no ledger row            → (only after a failed fresh batch) plain
//                              refusal; callers on other paths handle
//                              the missing-row case themselves
//   payload mismatch         → typed conflict, nothing of ours written
//   ledger state 'deleted'   → typed deleted
//   'saved' but no activity  → typed deleted (converged: the record is
//                              gone, whatever removed it)
//   'saved' with the row     → ok, the row's id; `duplicate` comes from
//                              the caller (the fast paths always replay
//                              an earlier save → true; the fresh path
//                              passes whether its activity row already
//                              existed before its batch ran)
async function adjudicateSave(
  db: Db,
  requestKey: string,
  payload: string,
  duplicate: boolean,
): Promise<AddActivityResult | null> {
  const ledgerRows = await db
    .select()
    .from(schema.familyRequestKeys)
    .where(eq(schema.familyRequestKeys.requestKey, requestKey));
  const ledger = ledgerRows[0];
  if (!ledger) return null;
  if (ledger.payload !== payload) return addRefusal({ conflict: true });
  if (ledger.state === "deleted") return addRefusal({ deleted: true });
  const activityRows = await db
    .select({ id: schema.familyActivities.id })
    .from(schema.familyActivities)
    .where(eq(schema.familyActivities.requestKey, requestKey));
  const activity = activityRows[0];
  if (!activity) return addRefusal({ deleted: true });
  return {
    ok: true,
    forbidden: false,
    id: activity.id,
    duplicate,
    conflict: false,
    deleted: false,
    future: false,
  };
}

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

      // Materialize the preset types exactly once (CMP-FAMILY-INIT-001).
      // The completion marker and the seeds share ONE atomic boundary:
      // when the "types_seeded" meta row is absent, the claim INSERT …
      // ON CONFLICT DO NOTHING and all 7 preset INSERTs … ON CONFLICT
      // DO NOTHING go out as a single db.batch — one transaction that
      // commits or rolls back as a unit. There is therefore no instant
      // at which any reader can observe "claimed but not yet seeded",
      // and an interruption mid-seed leaves neither a false completion
      // marker nor partial types behind: the next read simply seeds
      // again. Concurrent first reads all attempt the same batch; the
      // loser's statements no-op on their conflict targets (the meta
      // primary key, the UNIQUE index on activity_types.name), so
      // exactly 7 presets and exactly 1 meta row land whoever commits
      // first, and both readers re-read the same committed state.
      // Once the meta row exists, seeding is never attempted again:
      // after the owner deletes every type, later reads keep the list
      // empty — an empty type list never refills itself.
      const seedClaim = await db
        .select({ key: schema.ledgerMeta.key })
        .from(schema.ledgerMeta)
        .where(eq(schema.ledgerMeta.key, "types_seeded"));
      if (seedClaim.length === 0) {
        const now = Date.now();
        const claimInsert = db
          .insert(schema.ledgerMeta)
          .values({ key: "types_seeded", value: "1" })
          .onConflictDoNothing();
        const presetInserts = schema.PRESET_TYPES.map((name, i) =>
          db
            .insert(schema.activityTypes)
            .values({ name, isPreset: 1, createdAt: new Date(now + i) })
            .onConflictDoNothing(),
        );
        await db.batch([claimInsert, ...presetInserts]);
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

      // (a) Ledger fast path: a stored ledger row already decides this
      // key — payload conflict, deleted refusal, or the original save
      // replayed as a duplicate. A 'saved' ledger row whose activity
      // row no longer exists converges to the deleted refusal.
      const fastPath = await adjudicateSave(db, args.requestKey, payload, true);
      if (fastPath) return fastPath;

      // (b) No ledger row, but a pre-ledger activity already carries
      // this key: backfill the ledger from the stored row's own
      // fields (ON CONFLICT DO NOTHING — a concurrent backfill of the
      // same key is a no-op, never a UNIQUE error), then re-read and
      // adjudicate against the ledger row that actually landed.
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
        await db
          .insert(schema.familyRequestKeys)
          .values({
            requestKey: args.requestKey,
            payload: storedPayload,
            activityId: legacy.id,
            state: "saved",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        const verdict = await adjudicateSave(db, args.requestKey, payload, true);
        // A vanished verdict (no ledger row at all) cannot happen after
        // a successful backfill; refuse plainly rather than guess.
        return verdict ?? addRefusal({});
      }

      // (c) Fresh key: ONE db.batch, two builder statements —
      //   1. claim the request key in the ledger
      //      (INSERT … ON CONFLICT DO NOTHING, activityId filled by
      //      nobody — the activity row is found by its unique
      //      request_key on re-read);
      //   2. insert the activity (INSERT … ON CONFLICT DO NOTHING on
      //      the request_key UNIQUE index).
      // Whichever statement a concurrent same-key save beats us to
      // simply no-ops; the batch commits or rolls back as a unit, so
      // the ledger and the activity can never half-exist. Whether the
      // activity row already existed before this batch decides the
      // duplicate flag. After the batch (or after it throws — e.g. the
      // migration-0004 trigger aborting our activity insert because a
      // delete committed first), re-read and adjudicate from stored
      // state; only an undecidable re-read after a thrown batch is a
      // plain refusal.
      const preExisting = await db
        .select({ id: schema.familyActivities.id })
        .from(schema.familyActivities)
        .where(eq(schema.familyActivities.requestKey, args.requestKey));
      const existedBefore = preExisting.length > 0;
      let batchThrew = false;
      try {
        await db.batch([
          db
            .insert(schema.familyRequestKeys)
            .values({
              requestKey: args.requestKey,
              payload,
              activityId: null,
              state: "saved",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing(),
          db
            .insert(schema.familyActivities)
            .values({
              date: args.date,
              typeName: args.typeName,
              minutes: args.minutes,
              note,
              requestKey: args.requestKey,
              createdAt: new Date(now),
            })
            .onConflictDoNothing(),
        ]);
      } catch {
        batchThrew = true;
      }
      const verdict = await adjudicateSave(db, args.requestKey, payload, existedBefore);
      if (verdict) {
        if (verdict.ok && !verdict.duplicate) ctx.invalidateQueries();
        return verdict;
      }
      // No ledger row after the batch: either the batch threw before
      // anything landed (rolled back — nothing half-written), or a
      // concurrent delete removed… the ledger is never deleted, so in
      // practice this is the thrown-batch case. Plain refusal.
      void batchThrew;
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
      // ONE db.batch: the ledger tombstone upsert and the activity
      // delete commit or roll back together — there is no state where
      // the tombstone is committed but the record still exists (or the
      // reverse). The tombstone flips the record's request key to
      // 'deleted' in the ledger (created from the activity's stored
      // key and fields when none exists), so a late retry of that save
      // is typed-rejected and can never resurrect the record; the
      // migration-0004 trigger additionally aborts any activity insert
      // that tries. The ledger row itself is never deleted. Records
      // with a NULL request key have no key to tombstone: the batch is
      // just the delete.
      const deleteStatement = db
        .delete(schema.familyActivities)
        .where(eq(schema.familyActivities.id, args.id))
        .returning({ id: schema.familyActivities.id });
      let removed: { id: number }[];
      if (target.requestKey !== null) {
        const now = Date.now();
        const [, deletedRows] = await db.batch([
          db
            .insert(schema.familyRequestKeys)
            .values({
              requestKey: target.requestKey,
              payload: canonicalPayload(
                target.date,
                target.typeName,
                target.minutes,
                target.note,
              ),
              activityId: target.id,
              state: "deleted",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.familyRequestKeys.requestKey,
              set: { state: "deleted", updatedAt: now },
            }),
          deleteStatement,
        ]);
        removed = deletedRows;
      } else {
        const [deletedRows] = await db.batch([deleteStatement]);
        removed = deletedRows;
      }
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
