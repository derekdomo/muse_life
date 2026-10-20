// 学习复利 actions.
//
// Data model: skills are long-lived assets; learning_inputs are the daily
// ledger. Every read the UI needs is aggregated server-side in
// getDashboard (per-skill totals, conversion rates, streaks, and daily
// cumulative series) so the client renders numbers, never recomputes them.
//
// recordLearningInput is the shared write path: the quick-add form calls
// it, and Muse calls it directly when delivering a research report, an
// idea scan, or a Xiaohongshu digest, so those inputs land in the ledger
// without the owner re-typing them.
//
// ACL (CMP-LEARN-ACL-001): every action below is owner-only. Each handler
// runs the strict isOwner gate BEFORE any database read/write and before
// seed initialization; refused calls return a typed rejection and touch
// zero rows. There is deliberately no anonymous or sync-channel exception
// in this app — the L0.1 exception covers only the named space-4/space-6
// entry points. recordLearningInput therefore fails honestly (ok:false)
// whenever it is called without a verifiable owner identity.

import { defineAction, z, type ActionsModule, type Ctx, type SpaceDb } from "@hatch/space-sdk";
import { and, asc, eq, isNull } from "drizzle-orm";
import * as schema from "./schema";

// Strict owner gate: only a verified owner viewer passes. Identified
// non-owners and anonymous calls (no viewer at all) are both refused.
function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

const TZ = "America/Los_Angeles";

const SOURCE_TYPES = ["article", "video", "research", "practice", "course"] as const;
const OUTPUT_TYPES = ["note", "experiment", "project", "decision"] as const;

const dateKeyRe = /^\d{4}-\d{2}-\d{2}$/;

function todayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// The America/Los_Angeles calendar day an instant falls on. Conversion
// outputs are accumulated on this day (of the FIRST conversion), never
// on the input's own date.
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

// A streak is "current" if it reaches today, or yesterday (today not yet
// logged does not break it yet).
function currentStreak(dates: Set<string>, today: string): number {
  if (dates.has(today)) return streakEndingAt(dates, today);
  const yesterday = shiftDay(today, -1);
  if (dates.has(yesterday)) return streakEndingAt(dates, yesterday);
  return 0;
}

const PRESET_SKILLS: Array<{ name: string; note: string }> = [
  {
    name: "单板 Snowboard",
    note: "蓝道进阶，为 2026/27 Tahoe 雪季做准备",
  },
  {
    name: "AI / 多智能体工作流",
    note: "多智能体协作与 agent 工作流的实操积累",
  },
];

// Seed the two skills the owner is really learning, exactly once, on first
// read. Guarded so concurrent first loads cannot double-insert.
let seedInFlight: Promise<void> | null = null;
async function ensureSeeded(ctx: Ctx): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .limit(1);
  if (existing.length > 0) return false;
  if (!seedInFlight) {
    seedInFlight = (async () => {
      const again = await db
        .select({ id: schema.skills.id })
        .from(schema.skills)
        .limit(1);
      if (again.length === 0) {
        await db.insert(schema.skills).values(PRESET_SKILLS);
      }
    })().finally(() => {
      seedInFlight = null;
    });
  }
  await seedInFlight;
  return true;
}

const pointSchema = z.object({
  date: z.string(),
  inputs: z.number(),
  converted: z.number(),
  minutes: z.number(),
});

// One input-batch (cohort) view: inputs whose inputDate falls inside
// [windowStart, windowEnd], observed as of `asOf`. rate is null when
// the denominator is 0 — the UI renders that as 无法计算, never 0%/100%.
const cohortSchema = z.object({
  windowStart: z.string(),
  windowEnd: z.string(),
  asOf: z.string(),
  eligibleInputs: z.number(),
  convertedInputs: z.number(),
  rate: z.number().nullable(),
});

const cohortsSchema = z.object({
  all: cohortSchema,
  days30: cohortSchema,
});

const skillStatSchema = z.object({
  id: z.number(),
  name: z.string(),
  note: z.string().nullable(),
  // Known minutes only (rows with a recorded duration). Rows whose
  // duration is unknown (NULL) are counted in unknownMinutesCount and
  // contribute nothing here.
  totalMinutes: z.number(),
  unknownMinutesCount: z.number(),
  inputCount: z.number(),
  convertedCount: z.number(),
  conversionRate: z.number().nullable(),
  cohorts: cohortsSchema,
  streakDays: z.number(),
  lastInputDate: z.string().nullable(),
  series: z.array(pointSchema),
});

const inputRowSchema = z.object({
  id: z.number(),
  date: z.string(),
  sourceType: z.enum(SOURCE_TYPES),
  topic: z.string(),
  skillId: z.number().nullable(),
  skillName: z.string().nullable(),
  // null = duration unknown (left blank). A stored 0 is a legacy value
  // of unknown provenance and is shown as 来源不明, not as unknown.
  minutes: z.number().nullable(),
  converted: z.boolean(),
  convertedAt: z.string().nullable(),
  outputType: z.enum(OUTPUT_TYPES).nullable(),
  outputNote: z.string().nullable(),
  attemptStartedAt: z.string().nullable(),
});

const dashboardResponse = z.object({
  // Repo-standard refusal flag: true means the caller is not the owner
  // and every data field below is empty (no learning data is returned).
  forbidden: z.boolean(),
  today: z.string(),
  skills: z.array(skillStatSchema),
  inputs: z.array(inputRowSchema),
  totals: z.object({
    totalInputs: z.number(),
    totalConverted: z.number(),
    totalMinutes: z.number(),
    unknownMinutesCount: z.number(),
    conversionRate: z.number().nullable(),
    cohorts: cohortsSchema,
    streakDays: z.number(),
    activeDays: z.number(),
    unconvertedCount: z.number(),
  }),
  series: z.array(pointSchema),
});

type Dashboard = z.infer<typeof dashboardResponse>;

function emptyCohort(today: string): z.infer<typeof cohortSchema> {
  return {
    windowStart: today,
    windowEnd: today,
    asOf: today,
    eligibleInputs: 0,
    convertedInputs: 0,
    rate: null,
  };
}

// The dashboard a refused caller gets: forbidden flag set, and every
// data field empty/zero. Built without touching the database.
function forbiddenDashboard(): Dashboard {
  const today = todayKey();
  const empty = emptyCohort(today);
  return {
    forbidden: true,
    today,
    skills: [],
    inputs: [],
    totals: {
      totalInputs: 0,
      totalConverted: 0,
      totalMinutes: 0,
      unknownMinutesCount: 0,
      conversionRate: null,
      cohorts: { all: empty, days30: empty },
      streakDays: 0,
      activeDays: 0,
      unconvertedCount: 0,
    },
    series: [],
  };
}

// Mutation responses: ok reports whether the write happened; forbidden
// reports an owner-gate refusal (ok is then false and nothing was
// written). Matches the { ok, forbidden } shape used across the repo.
const okResponse = z.object({ ok: z.boolean(), forbidden: z.boolean() });

const addSkillResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  id: z.number().nullable(),
  name: z.string().nullable(),
});

const recordInputResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  id: z.number().nullable(),
});

const startAttemptResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  attemptStartedAt: z.string().nullable(),
});

const saveOutputResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  // How this call resolved (CMP-LEARN-SAVE-001):
  //   "converted"        — this call performed the first conversion;
  //   "alreadyConverted" — the input was already converted (same-key
  //                        retry, or another conversion won the race);
  //                        nothing was written or re-counted;
  //   "revoked"          — this requestId's conversion was revoked; a
  //                        late retry with the same key must not
  //                        resurrect it (nothing written);
  //   "conflict"         — the requestId (or input) is bound to a
  //                        different payload; rejected, nothing written;
  //   "notFound"         — no such input;
  //   "refused"          — owner gate refused (forbidden=true);
  //   "error"            — a write failed; nothing was applied.
  status: z.enum([
    "converted",
    "alreadyConverted",
    "revoked",
    "conflict",
    "notFound",
    "refused",
    "error",
  ]),
  // true when the input was already converted before this call (a
  // same-requestId retry, or a conversion recorded another way): the
  // call changed nothing and counted nothing new.
  alreadyConverted: z.boolean(),
  convertedAt: z.string().nullable(),
  // The winner's output, echoed on alreadyConverted so a losing caller
  // can show what the input actually converted into.
  outputType: z.enum(OUTPUT_TYPES).nullable(),
  outputNote: z.string().nullable(),
});

const markConvertedResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  status: z.enum([
    "converted",
    "alreadyConverted",
    "revoked",
    "conflict",
    "notFound",
    "refused",
    "error",
  ]),
});

// Occurrence-time accumulation. Inputs accumulate on their inputDate;
// outputs accumulate on the America/Los_Angeles day of the FIRST
// conversion instant (convertedAt). A historical input converted today
// therefore raises only today's output count — past days never change.
// Minutes accumulate on the input day and count known durations only.
function buildSeries(
  rows: Array<{ date: string; convertedAt: Date | null; minutes: number | null }>,
  today: string,
): z.infer<typeof pointSchema>[] {
  if (rows.length === 0) return [];
  const byDay = new Map<string, { inputs: number; converted: number; minutes: number }>();
  const bump = (key: string) => {
    const cur = byDay.get(key) ?? { inputs: 0, converted: 0, minutes: 0 };
    byDay.set(key, cur);
    return cur;
  };
  let first = today;
  for (const row of rows) {
    const inDay = bump(row.date);
    inDay.inputs += 1;
    if (row.minutes != null) inDay.minutes += row.minutes;
    if (row.date < first) first = row.date;
    if (row.convertedAt) {
      const convKey = laDateKey(row.convertedAt);
      bump(convKey).converted += 1;
      if (convKey < first) first = convKey;
    }
  }
  const points: z.infer<typeof pointSchema>[] = [];
  let cumInputs = 0;
  let cumConverted = 0;
  let cumMinutes = 0;
  let cursor = first;
  // Cap the walk so a stray far-future date cannot spin forever.
  for (let i = 0; i < 3700 && cursor <= today; i += 1) {
    const day = byDay.get(cursor);
    if (day) {
      cumInputs += day.inputs;
      cumConverted += day.converted;
      cumMinutes += day.minutes;
    }
    points.push({
      date: cursor,
      inputs: cumInputs,
      converted: cumConverted,
      minutes: cumMinutes,
    });
    cursor = shiftDay(cursor, 1);
  }
  return points;
}

// Input-batch (cohort) conversion: among the distinct inputs whose
// inputDate falls in [windowStart, asOf], how many have been converted
// (first conversion on or before the observation cutoff `asOf`). This
// answers "of this batch of inputs, how much became output" — it is
// NOT a per-day output curve and is never presented as one. A zero
// denominator yields rate null (无法计算), never 0% or 100%.
function buildCohort(
  rows: Array<{ date: string; convertedAt: Date | null }>,
  windowStart: string,
  asOf: string,
): z.infer<typeof cohortSchema> {
  const inWindow = rows.filter((r) => r.date >= windowStart && r.date <= asOf);
  const converted = inWindow.filter(
    (r) => r.convertedAt != null && laDateKey(r.convertedAt) <= asOf,
  ).length;
  return {
    windowStart,
    windowEnd: asOf,
    asOf,
    eligibleInputs: inWindow.length,
    convertedInputs: converted,
    rate: inWindow.length > 0 ? converted / inWindow.length : null,
  };
}

function buildCohorts(
  rows: Array<{ date: string; convertedAt: Date | null }>,
  today: string,
): z.infer<typeof cohortsSchema> {
  const firstDate = rows.length
    ? rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0]?.date ?? today)
    : today;
  return {
    all: buildCohort(rows, firstDate, today),
    days30: buildCohort(rows, shiftDay(today, -29), today),
  };
}

type ConversionStatus =
  | "converted"
  | "alreadyConverted"
  | "revoked"
  | "conflict"
  | "notFound"
  | "error";

interface ConversionOutcome {
  status: ConversionStatus;
  convertedAt: Date | null;
  outputType: (typeof OUTPUT_TYPES)[number] | null;
  outputNote: string | null;
}

type LearningInputRow = typeof schema.learningInputs.$inferSelect;

function rowOutcome(
  status: ConversionStatus,
  row: LearningInputRow,
): ConversionOutcome {
  return {
    status,
    convertedAt: row.convertedAt ?? null,
    outputType: row.outputType ?? null,
    outputNote: row.outputNote ?? null,
  };
}

// SHA-256 (FIPS 180-4) over the UTF-8 bytes of a string, hex-encoded.
// Implemented inline because action code may not import host crypto
// modules; used only to fingerprint conversion payloads for the
// receipt table (idempotency identity), never for security purposes.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Int32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
      const s1 = rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

// The exact payload a conversion request carries: same key + same
// payload on retry is idempotent; same key + different payload is a
// conflict and is rejected.
function conversionPayloadHash(
  outputType: string,
  outputNote: string | null,
): string {
  return sha256Hex(JSON.stringify([outputType, outputNote]));
}

async function readInputRow(
  db: SpaceDb<typeof schema>,
  inputId: number,
): Promise<LearningInputRow | undefined> {
  const rows = await db
    .select()
    .from(schema.learningInputs)
    .where(eq(schema.learningInputs.id, inputId))
    .limit(1);
  return rows[0];
}

// First-conversion arbitration, shared by saveOutput and markConverted
// (CMP-LEARN-SAVE-001). The first conversion of an input is decided by
// ONE atomic conditional UPDATE ... WHERE converted_at IS NULL: under
// concurrency exactly one caller wins; every loser re-reads the
// winner's row and reports alreadyConverted with the winner's
// convertedAt/output — the winner's output, request key, and first
// conversion instant are never overwritten.
//
// Each first conversion also writes an immutable receipt keyed by the
// caller's requestId in the same batch. The receipt carries the
// payload hash and survives revocation (unmarkConverted only stamps
// revokedAt), so:
//   - same key + same payload, not revoked -> idempotent replay of the
//     original result (covers a lost response);
//   - same key + different payload -> conflict, rejected, no write;
//   - same key after revocation -> "revoked", no write: the conversion
//     is never resurrected by a late retry; re-marking must present a
//     fresh requestId (a new generation).
// Legacy rows converted before receipts existed have no receipt and no
// key; they are read and reported exactly as stored, never backfilled.
async function arbitrateConversion(
  db: SpaceDb<typeof schema>,
  args: {
    inputId: number;
    requestId: string;
    outputType: (typeof OUTPUT_TYPES)[number];
    outputNote: string | null;
  },
): Promise<ConversionOutcome> {
  const hash = conversionPayloadHash(args.outputType, args.outputNote);

  const receiptRows = await db
    .select()
    .from(schema.conversionReceipts)
    .where(eq(schema.conversionReceipts.requestId, args.requestId))
    .limit(1);
  const receipt = receiptRows[0];
  if (receipt) {
    if (receipt.inputId !== args.inputId || receipt.payloadHash !== hash) {
      const row = await readInputRow(db, args.inputId);
      return row
        ? rowOutcome("conflict", row)
        : { status: "conflict", convertedAt: null, outputType: null, outputNote: null };
    }
    if (receipt.revokedAt != null) {
      // Tombstone: this generation was revoked. A late retry must not
      // resurrect it — answer plainly and write nothing.
      const row = await readInputRow(db, args.inputId);
      return row
        ? rowOutcome("revoked", row)
        : { status: "revoked", convertedAt: null, outputType: null, outputNote: null };
    }
    // Live receipt with a matching payload: the original conversion
    // result, replayed. If the input row was since re-converted under
    // a newer generation, the current row still wins the echo.
    const row = await readInputRow(db, args.inputId);
    if (!row) {
      return { status: "notFound", convertedAt: null, outputType: null, outputNote: null };
    }
    if (row.convertedAt != null) return rowOutcome("alreadyConverted", row);
    return {
      status: "alreadyConverted",
      convertedAt: new Date(receipt.convertedAt),
      outputType: receipt.outputType,
      outputNote: receipt.outputNote ?? null,
    };
  }

  const before = await readInputRow(db, args.inputId);
  if (!before) {
    return { status: "notFound", convertedAt: null, outputType: null, outputNote: null };
  }
  if (before.convertedAt != null) {
    // Already converted by another key/path (possibly a legacy row
    // with no receipt). Nothing new is counted or rewritten.
    return rowOutcome("alreadyConverted", before);
  }

  const now = new Date();
  let claimed: LearningInputRow[] = [];
  try {
    const batchResult = await db.batch([
      db
        .update(schema.learningInputs)
        .set({
          convertedAt: now,
          outputType: args.outputType,
          outputNote: args.outputNote,
          conversionRequestId: args.requestId,
        })
        .where(
          and(
            eq(schema.learningInputs.id, args.inputId),
            isNull(schema.learningInputs.convertedAt),
          ),
        )
        .returning(),
      db.insert(schema.conversionReceipts).values({
        requestId: args.requestId,
        inputId: args.inputId,
        payloadHash: hash,
        convertedAt: now.getTime(),
        outputType: args.outputType,
        outputNote: args.outputNote,
        revokedAt: null,
      }),
    ]);
    claimed = (batchResult[0] ?? []) as LearningInputRow[];
  } catch {
    // The batch is atomic: either the conversion AND its receipt both
    // landed, or neither did — an existing output is never lost to a
    // failed write. Re-read to tell the causes apart, in the same
    // order as the main path: a raced receipt for this requestId
    // (a concurrent claim of the same key) decides first — payload
    // mismatch is a conflict, a match replays as alreadyConverted.
    let raced: typeof schema.conversionReceipts.$inferSelect | undefined;
    try {
      const racedRows = await db
        .select()
        .from(schema.conversionReceipts)
        .where(eq(schema.conversionReceipts.requestId, args.requestId))
        .limit(1);
      raced = racedRows[0];
    } catch {
      raced = undefined;
    }
    const after = await readInputRow(db, args.inputId).catch(() => undefined);
    if (raced) {
      if (raced.inputId !== args.inputId || raced.payloadHash !== hash) {
        return after
          ? rowOutcome("conflict", after)
          : { status: "conflict", convertedAt: null, outputType: null, outputNote: null };
      }
      if (raced.revokedAt != null) {
        return after
          ? rowOutcome("revoked", after)
          : { status: "revoked", convertedAt: null, outputType: null, outputNote: null };
      }
      if (after?.convertedAt != null) return rowOutcome("alreadyConverted", after);
      return {
        status: "alreadyConverted",
        convertedAt: new Date(raced.convertedAt),
        outputType: raced.outputType,
        outputNote: raced.outputNote ?? null,
      };
    }
    if (after?.convertedAt != null) return rowOutcome("alreadyConverted", after);
    return after
      ? rowOutcome("error", after)
      : { status: "error", convertedAt: null, outputType: null, outputNote: null };
  }

  const winner = claimed[0];
  if (!winner) {
    // Lost the race: the conditional update matched nothing because a
    // concurrent caller converted first. Echo the winner, never
    // overwrite it. (This call's receipt insert still landed inside
    // the batch; it is inert — replay resolves receipts against the
    // live row, and revocation tombstones every live receipt of the
    // input, this one included.)
    const after = await readInputRow(db, args.inputId);
    if (after?.convertedAt != null) return rowOutcome("alreadyConverted", after);
    return {
      status: "error",
      convertedAt: null,
      outputType: null,
      outputNote: null,
    };
  }
  return {
    status: "converted",
    convertedAt: winner.convertedAt ?? now,
    outputType: winner.outputType ?? args.outputType,
    outputNote: winner.outputNote ?? args.outputNote,
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

      const skillRows = await db
        .select()
        .from(schema.skills)
        .orderBy(asc(schema.skills.id));
      const inputRows = await db
        .select()
        .from(schema.learningInputs)
        .orderBy(asc(schema.learningInputs.date), asc(schema.learningInputs.id));

      const skillNameById = new Map(skillRows.map((s) => [s.id, s.name]));

      const allDates = new Set(inputRows.map((r) => r.date));

      const skills: Dashboard["skills"] = skillRows.map((skill) => {
        const mine = inputRows.filter((r) => r.skillId === skill.id);
        const dates = new Set(mine.map((r) => r.date));
        const convertedCount = mine.filter((r) => r.convertedAt).length;
        return {
          id: skill.id,
          name: skill.name,
          note: skill.note ?? null,
          totalMinutes: mine.reduce((sum, r) => sum + (r.minutes ?? 0), 0),
          unknownMinutesCount: mine.filter((r) => r.minutes == null).length,
          inputCount: mine.length,
          convertedCount,
          conversionRate:
            mine.length > 0 ? convertedCount / mine.length : null,
          cohorts: buildCohorts(mine, today),
          streakDays: currentStreak(dates, today),
          lastInputDate: mine.length
            ? (mine[mine.length - 1]?.date ?? null)
            : null,
          series: buildSeries(mine, today),
        };
      });

      const inputs: Dashboard["inputs"] = [...inputRows]
        .sort((a, b) => b.id - a.id)
        .map((r) => ({
          id: r.id,
          date: r.date,
          sourceType: r.sourceType,
          topic: r.topic,
          skillId: r.skillId ?? null,
          skillName:
            r.skillId != null ? (skillNameById.get(r.skillId) ?? null) : null,
          minutes: r.minutes ?? null,
          converted: r.convertedAt != null,
          convertedAt: r.convertedAt ? r.convertedAt.toISOString() : null,
          outputType: r.outputType ?? null,
          outputNote: r.outputNote ?? null,
          attemptStartedAt: r.attemptStartedAt
            ? r.attemptStartedAt.toISOString()
            : null,
        }));

      const totalConverted = inputRows.filter((r) => r.convertedAt).length;
      return {
        forbidden: false,
        today,
        skills,
        inputs,
        totals: {
          totalInputs: inputRows.length,
          totalConverted,
          totalMinutes: inputRows.reduce((sum, r) => sum + (r.minutes ?? 0), 0),
          unknownMinutesCount: inputRows.filter((r) => r.minutes == null).length,
          conversionRate:
            inputRows.length > 0 ? totalConverted / inputRows.length : null,
          cohorts: buildCohorts(inputRows, today),
          streakDays: currentStreak(allDates, today),
          activeDays: allDates.size,
          unconvertedCount: inputRows.length - totalConverted,
        },
        series: buildSeries(inputRows, today),
      };
    },
  }),

  addSkill: defineAction({
    request: z.object({
      name: z.string().trim().min(1).max(80),
      note: z.string().trim().max(200).optional(),
    }),
    response: addSkillResponse,
    async handler(ctx, args): Promise<z.infer<typeof addSkillResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, id: null, name: null };
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.skills)
        .values({ name: args.name, note: args.note || null })
        .returning({ id: schema.skills.id });
      const row = inserted[0];
      if (!row) throw new Error("addSkill: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, id: row.id, name: args.name };
    },
  }),

  updateSkill: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(80),
      note: z.string().trim().max(200).nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.skills)
        .set({ name: args.name, note: args.note ? args.note : null })
        .where(eq(schema.skills.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  deleteSkill: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      // Ledger rows survive a deleted skill; they just lose the link.
      await db
        .update(schema.learningInputs)
        .set({ skillId: null })
        .where(eq(schema.learningInputs.skillId, args.id));
      await db.delete(schema.skills).where(eq(schema.skills.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  // Shared write path for the quick-add form AND for Muse logging inputs
  // on the owner's behalf (research reports, idea scans, digests).
  recordLearningInput: defineAction({
    request: z.object({
      date: z
        .string()
        .regex(dateKeyRe, "date must be YYYY-MM-DD")
        .optional(),
      sourceType: z.enum(SOURCE_TYPES),
      topic: z.string().trim().min(1).max(300),
      skillId: z.number().int().positive().nullable().optional(),
      skillName: z.string().trim().min(1).max(80).optional(),
      // Omitted or null = duration unknown, stored as NULL. An explicit
      // 0 is stored as 0 (legacy rows also hold 0 and are shown as
      // 来源不明); the two are never conflated.
      minutes: z.number().int().min(0).max(1440).nullable().optional(),
      converted: z.boolean().default(false),
      outputType: z.enum(OUTPUT_TYPES).optional(),
      outputNote: z.string().trim().max(500).optional(),
    }),
    response: recordInputResponse,
    async handler(ctx, args): Promise<z.infer<typeof recordInputResponse>> {
      // No identity exception for this shared write path: without a
      // verifiable owner viewer the call fails honestly and writes
      // nothing (no row, and no skill auto-created from skillName).
      if (!isOwner(ctx)) return { ok: false, forbidden: true, id: null };
      const db = ctx.db<typeof schema>();
      let skillId: number | null = args.skillId ?? null;
      if (skillId == null && args.skillName) {
        const found = await db
          .select({ id: schema.skills.id })
          .from(schema.skills)
          .where(eq(schema.skills.name, args.skillName))
          .limit(1);
        if (found[0]) {
          skillId = found[0].id;
        } else {
          const created = await db
            .insert(schema.skills)
            .values({ name: args.skillName })
            .returning({ id: schema.skills.id });
          skillId = created[0]?.id ?? null;
        }
      }
      if (skillId != null) {
        const exists = await db
          .select({ id: schema.skills.id })
          .from(schema.skills)
          .where(eq(schema.skills.id, skillId))
          .limit(1);
        if (exists.length === 0) skillId = null;
      }
      const converted = args.converted === true;
      const inserted = await db
        .insert(schema.learningInputs)
        .values({
          date: args.date ?? todayKey(),
          sourceType: args.sourceType,
          topic: args.topic,
          skillId,
          minutes: args.minutes ?? null,
          convertedAt: converted ? new Date() : null,
          outputType: converted ? (args.outputType ?? null) : null,
          outputNote: converted ? args.outputNote || null : null,
        })
        .returning({ id: schema.learningInputs.id });
      const row = inserted[0];
      if (!row) throw new Error("recordLearningInput: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, id: row.id };
    },
  }),

  markConverted: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      // Optional idempotency key. The ledger form sends one per
      // confirm; legacy callers that omit it get a fresh server-side
      // key (a new generation each call — safe because the atomic
      // claim still lets only the first conversion through).
      requestId: z.string().trim().min(1).max(120).optional(),
      outputType: z.enum(OUTPUT_TYPES),
      outputNote: z.string().trim().max(500).optional(),
    }),
    response: markConvertedResponse,
    async handler(ctx, args): Promise<z.infer<typeof markConvertedResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, status: "refused" };
      const db = ctx.db<typeof schema>();
      // Shares the exact arbitration path with saveOutput: one atomic
      // conditional claim, receipts, tombstones (CMP-LEARN-SAVE-001).
      const outcome = await arbitrateConversion(db, {
        inputId: args.id,
        requestId:
          args.requestId ?? `mark-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        outputType: args.outputType,
        outputNote: args.outputNote || null,
      });
      ctx.invalidateQueries();
      return {
        ok: outcome.status === "converted" || outcome.status === "alreadyConverted",
        forbidden: false,
        status: outcome.status,
      };
    },
  }),

  unmarkConverted: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      // Revoking returns the input to unconverted: conversion time,
      // output, and the conversion's live idempotency key are cleared.
      // The immutable receipts of the revoked conversion are NOT
      // deleted — they are tombstoned (revokedAt stamped) in the same
      // batch, so a late retry carrying an old requestId is answered
      // "revoked" and can never resurrect this conversion; a genuine
      // re-mark must use a fresh requestId (a new generation). The
      // attempt state is kept: having tried is a fact, not a
      // conversion.
      await db.batch([
        db
          .update(schema.learningInputs)
          .set({
            convertedAt: null,
            outputType: null,
            outputNote: null,
            conversionRequestId: null,
          })
          .where(eq(schema.learningInputs.id, args.id)),
        db
          .update(schema.conversionReceipts)
          .set({ revokedAt: Date.now() })
          .where(
            and(
              eq(schema.conversionReceipts.inputId, args.id),
              isNull(schema.conversionReceipts.revokedAt),
            ),
          ),
      ]);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  // 「挑一条去用」 step 1: enter the attempting state for one input.
  // This records only that an attempt started — it is NOT a conversion
  // and touches neither convertedAt nor any count. Re-starting keeps
  // the first attempt instant.
  startAttempt: defineAction({
    request: z.object({ inputId: z.number().int().positive() }),
    response: startAttemptResponse,
    async handler(ctx, args): Promise<z.infer<typeof startAttemptResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, attemptStartedAt: null };
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          attemptStartedAt: schema.learningInputs.attemptStartedAt,
          convertedAt: schema.learningInputs.convertedAt,
        })
        .from(schema.learningInputs)
        .where(eq(schema.learningInputs.id, args.inputId))
        .limit(1);
      const row = existing[0];
      if (!row) return { ok: false, forbidden: false, attemptStartedAt: null };
      if (row.convertedAt != null) {
        // Already an output — there is nothing to attempt.
        return {
          ok: false,
          forbidden: false,
          attemptStartedAt: row.attemptStartedAt
            ? row.attemptStartedAt.toISOString()
            : null,
        };
      }
      const started = row.attemptStartedAt ?? new Date();
      if (row.attemptStartedAt == null) {
        await db
          .update(schema.learningInputs)
          .set({ attemptStartedAt: started })
          .where(eq(schema.learningInputs.id, args.inputId));
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, attemptStartedAt: started.toISOString() };
    },
  }),

  // 「挑一条去用」 step 2: save a real result as this input's output.
  // Only this call converts, exactly once per input: the first
  // conversion is arbitrated atomically (see arbitrateConversion) and
  // stamped with the current instant — its LA day is what the curve
  // counts, so backfilling an old input never credits a past day and a
  // conversion alone never creates a learning streak day. Retries
  // carry the same requestId: same key + same payload replays the
  // original result even after a lost response; same key + different
  // payload is a conflict; a key whose conversion was revoked is a
  // tombstone and never resurrects it.
  saveOutput: defineAction({
    request: z.object({
      inputId: z.number().int().positive(),
      requestId: z.string().trim().min(1).max(120),
      outputType: z.enum(OUTPUT_TYPES),
      outputNote: z.string().trim().min(1).max(500),
    }),
    response: saveOutputResponse,
    async handler(ctx, args): Promise<z.infer<typeof saveOutputResponse>> {
      if (!isOwner(ctx)) {
        return {
          ok: false,
          forbidden: true,
          status: "refused",
          alreadyConverted: false,
          convertedAt: null,
          outputType: null,
          outputNote: null,
        };
      }
      const db = ctx.db<typeof schema>();
      const outcome = await arbitrateConversion(db, {
        inputId: args.inputId,
        requestId: args.requestId,
        outputType: args.outputType,
        outputNote: args.outputNote,
      });
      ctx.invalidateQueries();
      return {
        ok: outcome.status === "converted" || outcome.status === "alreadyConverted",
        forbidden: false,
        status: outcome.status,
        alreadyConverted: outcome.status === "alreadyConverted",
        convertedAt: outcome.convertedAt ? outcome.convertedAt.toISOString() : null,
        outputType: outcome.outputType,
        outputNote: outcome.outputNote,
      };
    },
  }),

  deleteInput: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      // Receipts reference the input; remove them with the row so no
      // dangling foreign keys survive the delete.
      await db.batch([
        db
          .delete(schema.conversionReceipts)
          .where(eq(schema.conversionReceipts.inputId, args.id)),
        db
          .delete(schema.learningInputs)
          .where(eq(schema.learningInputs.id, args.id)),
      ]);
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),
} satisfies ActionsModule;
