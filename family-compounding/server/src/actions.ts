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
// - Preset seeding (CMP-FAMILY-INIT-001) is gated on the REAL claim
//   outcome inside the same atomic batch: the claim row carries a
//   fresh per-attempt token as its value, and every preset insert is a
//   guarded INSERT … SELECT that fires only while the stored claim
//   holds THIS attempt's token. A reader whose pre-check saw an empty
//   claim but whose batch lands after another reader already seeded
//   (and the owner then deleted every type) therefore writes zero
//   seed rows — its claim no-ops against the winner's token and every
//   guard fails — so deleted types can never be resurrected by a late
//   stale first read.
// - Type-name uniqueness is scoped to preset identity, never global
//   (migrations 0005/0006): the only UNIQUE index on activity_types
//   is on the stable preset_key column (the earliest preset row of
//   each name carries it; custom types and legacy same-name rows
//   keep preset_key NULL). Legacy databases holding two exact-same-
//   name types upgrade cleanly with both rows and their history
//   preserved — nothing is deleted or silently merged, and preset
//   seeding still dedupes by name (concurrent same-name seeding
//   lands exactly one row; addType's duplicate returns the winner).
// - Future dates are not completed facts (CMP-FAMILY-DATE-001): a save
//   dated after today (America/Los_Angeles) is refused with a typed
//   'future' result, and pre-existing future-dated rows are excluded
//   from every total/series/calendar figure — counted separately as
//   futureRecordCount and still listed so the owner can delete them.
// - Chat auto-record (CMP-FAMILY-AUTOLOG-001): besides the manual
//   form, Muse can record an activity the owner mentioned in chat
//   through recordFamilyActivityFromChat. Provenance is decided
//   SERVER-SIDE and is never a request field: manual saves stamp
//   '手动', chat saves stamp '聊天记录', and rows saved before the
//   source column existed keep NULL (旧来源未记录, never backfilled).
//   The source is part of the canonical payload fingerprint, so the
//   same request key carrying the other source is a conflict, and
//   both write paths run the exact same arbitration pipeline and the
//   same strict owner gate before any database access. If the
//   runtime caller is not recognized as the owner the action refuses
//   honestly (forbidden, zero writes) — no service identity is
//   invented and no anonymous/sync exception is widened.

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
// request key stands for, provenance included (CMP-FAMILY-AUTOLOG-001).
// Stored in the request-key ledger so a retry can be compared
// field-for-field against what was originally saved — and a retry of
// the same key through the OTHER write path (different source) is a
// conflict, never a silent merge or duplicate.
function canonicalPayload(
  date: string,
  typeName: string,
  minutes: number | null,
  note: string | null,
  source: schema.ActivitySource,
): string {
  return JSON.stringify({ date, typeName, minutes, note, source });
}

// Normalize a stored source value to the two known values; anything
// else (including the NULL of pre-source rows) reads as unknown/null.
function knownSource(value: string | null | undefined): schema.ActivitySource | null {
  return value === schema.SOURCE_MANUAL || value === schema.SOURCE_CHAT ? value : null;
}

// The payload a stored row stands for, used when backfilling the
// ledger from a pre-ledger row and when writing a delete tombstone.
// Rows saved before the source column existed carry no source: their
// fingerprint uses the legacy 4-field shape (no source key), so a
// ledger row backfilled or tombstoned back then stays comparable
// with fingerprints stored in that era. A row WITH a known source
// fingerprints with it, matching what its save stored.
function legacyPayloadOf(row: {
  date: string;
  typeName: string;
  minutes: number | null;
  note: string | null;
  source: string | null;
}): string {
  const source = knownSource(row.source);
  if (source === null) {
    return JSON.stringify({
      date: row.date,
      typeName: row.typeName,
      minutes: row.minutes,
      note: row.note,
    });
  }
  return canonicalPayload(row.date, row.typeName, row.minutes, row.note, source);
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
  // '手动' | '聊天记录' | null (null = pre-source row, 旧来源未记录).
  source: z.enum(["手动", "聊天记录"]).nullable(),
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

// Chat auto-record receipt (CMP-FAMILY-AUTOLOG-001 / RECEIPT-001):
// on success the caller gets a locatable receipt — the new (or
// replayed) record's id plus its content READ BACK FROM THE STORED
// ROW by the shared adjudication, source included — so the agent can
// report back precisely what stands in the ledger. The receipt is
// never assembled from the request or from the entry point's source
// constant: a replay that resolves to a pre-source row (source NULL)
// reports source null (旧来源未记录), exactly as the dashboard shows
// it — the retrying path's stamp is never projected onto a row that
// does not carry it. Failures are the same typed refusals the manual
// path uses, plus the receipt fields nulled.
const chatRecordResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  id: z.number().nullable(),
  duplicate: z.boolean(),
  conflict: z.boolean(),
  deleted: z.boolean(),
  future: z.boolean(),
  date: z.string().nullable(),
  typeName: z.string().nullable(),
  minutes: z.number().nullable(),
  source: z.enum(["手动", "聊天记录"]).nullable(),
});

type ChatRecordResult = z.infer<typeof chatRecordResponse>;

function chatRefusal(flags: Partial<ChatRecordResult>): ChatRecordResult {
  return {
    ok: false,
    forbidden: false,
    id: null,
    duplicate: false,
    conflict: false,
    deleted: false,
    future: false,
    date: null,
    typeName: null,
    minutes: null,
    source: null,
    ...flags,
  };
}

/* ---------------- request-key adjudication ---------------- */

type Db = SpaceDb<typeof schema>;

// The content a save stands for, provenance included.
interface SaveContent {
  date: string;
  typeName: string;
  minutes: number | null;
  note: string | null;
  source: schema.ActivitySource;
}

// Does a stored ledger fingerprint match an incoming save? The four
// content fields must always match exactly. A fingerprint stored
// WITH a source (every save since CMP-FAMILY-AUTOLOG-001) must also
// match on source: the same key arriving through the other write
// path is a different draft. A legacy fingerprint carries no source
// key at all — that row's provenance is unrecorded, not '手动', so
// it cannot conflict on source and the content fields decide. An
// unparseable fingerprint matches nothing (typed conflict upstream).
function payloadMatches(stored: string, incoming: SaveContent): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  if (
    p.date !== incoming.date ||
    p.typeName !== incoming.typeName ||
    p.minutes !== incoming.minutes ||
    p.note !== incoming.note
  ) {
    return false;
  }
  if ("source" in p) return p.source === incoming.source;
  return true;
}

// The stored record a successful save resolved to, read back from
// family_activities itself: the row's id plus its exact stored
// content, provenance included (normalized through knownSource, so a
// pre-source row reads source null — 旧来源未记录 — never a guessed
// stamp). Receipts are built from THIS row and nothing else.
interface StoredActivity {
  id: number;
  date: string;
  typeName: string;
  minutes: number | null;
  note: string | null;
  source: schema.ActivitySource | null;
}

// A save's verdict plus, on success, the actual stored row it
// resolved to (stored is non-null exactly when result.ok).
interface SaveOutcome {
  result: AddActivityResult;
  stored: StoredActivity | null;
}

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
//   'saved' with the row     → ok, the row's id, and the row itself
//                              read back in full; `duplicate` comes
//                              from the caller (the fast paths always
//                              replay an earlier save → true; the fresh
//                              path passes whether its activity row
//                              already existed before its batch ran)
async function adjudicateSave(
  db: Db,
  requestKey: string,
  incoming: SaveContent,
  duplicate: boolean,
): Promise<SaveOutcome | null> {
  const ledgerRows = await db
    .select()
    .from(schema.familyRequestKeys)
    .where(eq(schema.familyRequestKeys.requestKey, requestKey));
  const ledger = ledgerRows[0];
  if (!ledger) return null;
  if (!payloadMatches(ledger.payload, incoming)) {
    return { result: addRefusal({ conflict: true }), stored: null };
  }
  if (ledger.state === "deleted") {
    return { result: addRefusal({ deleted: true }), stored: null };
  }
  const activityRows = await db
    .select()
    .from(schema.familyActivities)
    .where(eq(schema.familyActivities.requestKey, requestKey));
  const activity = activityRows[0];
  if (!activity) return { result: addRefusal({ deleted: true }), stored: null };
  return {
    result: {
      ok: true,
      forbidden: false,
      id: activity.id,
      duplicate,
      conflict: false,
      deleted: false,
      future: false,
    },
    stored: {
      id: activity.id,
      date: activity.date,
      typeName: activity.typeName,
      minutes: activity.minutes,
      note: activity.note,
      source: knownSource(activity.source),
    },
  };
}

/* ---------------- shared save pipeline ---------------- */

// The ONE save pipeline, shared by the manual form (addActivity,
// source '手动') and the chat auto-record action
// (recordFamilyActivityFromChat, source '聊天记录'). The source is a
// server-side constant chosen by the entry point — it is never read
// from the request — and it is part of the canonical payload, so the
// two paths arbitrate against each other exactly like two saves of
// one path do. Callers run their owner gate and request validation
// BEFORE calling this; everything from the ledger fast path down is
// identical for both paths.
async function saveActivityRecord(
  ctx: Ctx,
  input: {
    date: string;
    typeName: string;
    minutes: number | null;
    note: string | null;
    requestKey: string;
  },
  source: schema.ActivitySource,
): Promise<SaveOutcome> {
  const db = ctx.db<typeof schema>();
  const note = input.note && input.note.length > 0 ? input.note : null;
  const content: SaveContent = {
    date: input.date,
    typeName: input.typeName,
    minutes: input.minutes,
    note,
    source,
  };
  const payload = canonicalPayload(input.date, input.typeName, input.minutes, note, source);
  const now = Date.now();

  // (a) Ledger fast path: a stored ledger row already decides this
  // key — payload conflict, deleted refusal, or the original save
  // replayed as a duplicate. A 'saved' ledger row whose activity
  // row no longer exists converges to the deleted refusal.
  const fastPath = await adjudicateSave(db, input.requestKey, content, true);
  if (fastPath) return fastPath;

  // (b) No ledger row, but a pre-ledger activity already carries
  // this key: backfill the ledger from the stored row's own
  // fields (ON CONFLICT DO NOTHING — a concurrent backfill of the
  // same key is a no-op, never a UNIQUE error), then re-read and
  // adjudicate against the ledger row that actually landed.
  const legacyRows = await db
    .select()
    .from(schema.familyActivities)
    .where(eq(schema.familyActivities.requestKey, input.requestKey));
  const legacy = legacyRows[0];
  if (legacy) {
    const storedPayload = legacyPayloadOf(legacy);
    await db
      .insert(schema.familyRequestKeys)
      .values({
        requestKey: input.requestKey,
        payload: storedPayload,
        activityId: legacy.id,
        state: "saved",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const verdict = await adjudicateSave(db, input.requestKey, content, true);
    // A vanished verdict (no ledger row at all) cannot happen after
    // a successful backfill; refuse plainly rather than guess.
    return verdict ?? { result: addRefusal({}), stored: null };
  }

  // (c) Fresh key: ONE db.batch, two builder statements —
  //   1. claim the request key in the ledger
  //      (INSERT … ON CONFLICT DO NOTHING, activityId filled by
  //      nobody — the activity row is found by its unique
  //      request_key on re-read);
  //   2. insert the activity, stamped with this path's source
  //      (INSERT … ON CONFLICT DO NOTHING on the request_key
  //      UNIQUE index).
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
    .where(eq(schema.familyActivities.requestKey, input.requestKey));
  const existedBefore = preExisting.length > 0;
  let batchThrew = false;
  try {
    await db.batch([
      db
        .insert(schema.familyRequestKeys)
        .values({
          requestKey: input.requestKey,
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
          date: input.date,
          typeName: input.typeName,
          minutes: input.minutes,
          note,
          source,
          requestKey: input.requestKey,
          createdAt: new Date(now),
        })
        .onConflictDoNothing(),
    ]);
  } catch {
    batchThrew = true;
  }
  const verdict = await adjudicateSave(db, input.requestKey, content, existedBefore);
  if (verdict) {
    if (verdict.result.ok && !verdict.result.duplicate) ctx.invalidateQueries();
    return verdict;
  }
  // No ledger row after the batch: either the batch threw before
  // anything landed (rolled back — nothing half-written), or a
  // concurrent delete removed… the ledger is never deleted, so in
  // practice this is the thrown-batch case. Plain refusal.
  void batchThrew;
  return { result: addRefusal({}), stored: null };
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
      // The completion marker and the seeds share ONE atomic boundary,
      // and the seeds are gated on the REAL claim outcome inside that
      // boundary — not on the pre-check above, whose result can go
      // stale while this call is paused:
      //   - the claim INSERT … ON CONFLICT DO NOTHING stores a fresh
      //     per-attempt token as the marker's value;
      //   - each preset insert is a guarded INSERT … SELECT … WHERE
      //     EXISTS (claim row still holding THIS attempt's token),
      //     with ON CONFLICT DO NOTHING against the preset_key UNIQUE
      //     index as the storage-level backstop.
      // All 8 statements go out as a single db.batch — one transaction
      // that commits or rolls back as a unit. The reader that actually
      // claims sees its own token mid-batch and seeds; any other
      // reader's batch either runs before the winner's (and becomes
      // the winner) or after it commits, in which case its claim
      // no-ops, every guard sees the winner's token, and it writes
      // ZERO seed rows. That closes the stale-first-read resurrection:
      // reader A pre-checks an empty claim and pauses; reader B seeds
      // fully; the owner deletes every type; A resumes — A's seeds are
      // all guarded off, the type list stays empty, and the marker
      // keeps B's token (seeded stays seeded). An interruption mid-seed
      // likewise leaves neither a false completion marker nor partial
      // types behind: the next read simply seeds again. Once the meta
      // row exists, seeding is never attempted again: after the owner
      // deletes every type, later reads keep the list empty — an empty
      // type list never refills itself.
      const seedClaim = await db
        .select({ key: schema.ledgerMeta.key })
        .from(schema.ledgerMeta)
        .where(eq(schema.ledgerMeta.key, "types_seeded"));
      if (seedClaim.length === 0) {
        const now = Date.now();
        const seedToken = `seed:${now}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
        const claimInsert = db
          .insert(schema.ledgerMeta)
          .values({ key: "types_seeded", value: seedToken })
          .onConflictDoNothing();
        const presetInserts = schema.PRESET_TYPES.map((name, i) =>
          db.run(sql`
            INSERT INTO activity_types (name, is_preset, preset_key, created_at)
            SELECT ${name}, 1, ${name}, ${now + i}
            WHERE EXISTS (
              SELECT 1 FROM ledger_meta
              WHERE key = 'types_seeded' AND value = ${seedToken}
            )
            ON CONFLICT DO NOTHING
          `),
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
          source: knownSource(r.source),
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
    // Manual entry. The request deliberately has NO source field:
    // provenance is the server's decision ('手动' for this path), and
    // a client that sends one anyway gets it stripped by the schema —
    // a forged '聊天记录' can never reach the stored row.
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
      const { result } = await saveActivityRecord(ctx, args, schema.SOURCE_MANUAL);
      return result;
    },
  }),

  recordFamilyActivityFromChat: defineAction({
    // Chat auto-record (CMP-FAMILY-AUTOLOG-001): Muse records an
    // activity the owner stated in chat. Same strict owner gate
    // BEFORE any database access — a caller the runtime does not
    // recognize as the owner gets an honest forbidden refusal with
    // zero writes; no service identity is claimed. Minutes may be
    // null (the owner didn't say how long): unknown stays unknown,
    // never 0 and never guessed. The request key is generated by the
    // caller from the originating message and carried persistently,
    // so a retry of the same message replays instead of duplicating.
    // Source is fixed '聊天记录' server-side.
    request: z.object({
      date: z.string().regex(dateKeyRe),
      typeName: z.string().trim().min(1).max(20),
      minutes: z.number().int().min(1).max(1440).nullable(),
      note: z.string().trim().max(80).nullable(),
      requestKey: z.string().min(8).max(64),
    }),
    response: chatRecordResponse,
    async handler(ctx, args): Promise<ChatRecordResult> {
      if (!isOwner(ctx)) return chatRefusal({ forbidden: true });
      if (!isRealDateKey(args.date)) return chatRefusal({});
      if (args.date > todayKey()) return chatRefusal({ future: true });
      const { result, stored } = await saveActivityRecord(ctx, args, schema.SOURCE_CHAT);
      if (!result.ok || !stored) {
        return chatRefusal({
          forbidden: result.forbidden,
          conflict: result.conflict,
          deleted: result.deleted,
          future: result.future,
        });
      }
      // The receipt quotes the STORED row the shared adjudication
      // read back — id, date, type and minutes as they actually
      // stand, and the source as it actually stands. A fresh chat
      // save reads 聊天记录 because that is what was stored; a
      // replay that resolved to a pre-source row reads null
      // (旧来源未记录) — the receipt never upgrades an unrecorded
      // provenance into this path's stamp, and the stored row is
      // never edited to match the receipt.
      return {
        ok: true,
        forbidden: false,
        id: stored.id,
        duplicate: result.duplicate,
        conflict: false,
        deleted: false,
        future: false,
        date: stored.date,
        typeName: stored.typeName,
        minutes: stored.minutes,
        source: stored.source,
      };
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
              payload: legacyPayloadOf(target),
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
