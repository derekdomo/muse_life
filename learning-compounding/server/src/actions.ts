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

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
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
  // true when the input was already converted before this call (a
  // same-requestId retry, or a conversion recorded another way): the
  // call changed nothing and counted nothing new.
  alreadyConverted: z.boolean(),
  convertedAt: z.string().nullable(),
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
      outputType: z.enum(OUTPUT_TYPES),
      outputNote: z.string().trim().max(500).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ convertedAt: schema.learningInputs.convertedAt })
        .from(schema.learningInputs)
        .where(eq(schema.learningInputs.id, args.id))
        .limit(1);
      const row = existing[0];
      if (!row) return { ok: false, forbidden: false };
      // First conversion is idempotent: an already-converted input
      // keeps its original convertedAt and output — a repeated mark
      // counts nothing new and rewrites no history. To change the
      // output, unmark first, then mark again.
      if (row.convertedAt != null) {
        ctx.invalidateQueries();
        return { ok: true, forbidden: false };
      }
      await db
        .update(schema.learningInputs)
        .set({
          convertedAt: new Date(),
          outputType: args.outputType,
          outputNote: args.outputNote || null,
        })
        .where(eq(schema.learningInputs.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  unmarkConverted: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      // Revoking returns the input to unconverted: conversion time,
      // output, and the conversion's idempotency key are cleared. A
      // later re-mark is a brand-new conversion stamped with the new
      // conversion time — it never resurrects the old one. The attempt
      // state is kept: having tried is a fact, not a conversion.
      await db
        .update(schema.learningInputs)
        .set({
          convertedAt: null,
          outputType: null,
          outputNote: null,
          conversionRequestId: null,
        })
        .where(eq(schema.learningInputs.id, args.id));
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
  // Only this call converts, exactly once per input: the conversion is
  // stamped with the current instant (its LA day is what the curve
  // counts — backfilling an old input never credits a past day, and a
  // conversion alone never creates a learning streak day). Retries
  // carry the same requestId and are idempotent no-ops; a second,
  // different output for the same input likewise counts nothing new.
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
        return { ok: false, forbidden: true, alreadyConverted: false, convertedAt: null };
      }
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          convertedAt: schema.learningInputs.convertedAt,
          conversionRequestId: schema.learningInputs.conversionRequestId,
        })
        .from(schema.learningInputs)
        .where(eq(schema.learningInputs.id, args.inputId))
        .limit(1);
      const row = existing[0];
      if (!row) {
        return { ok: false, forbidden: false, alreadyConverted: false, convertedAt: null };
      }
      if (row.convertedAt != null) {
        return {
          ok: true,
          forbidden: false,
          alreadyConverted: true,
          convertedAt: row.convertedAt.toISOString(),
        };
      }
      const now = new Date();
      await db
        .update(schema.learningInputs)
        .set({
          convertedAt: now,
          outputType: args.outputType,
          outputNote: args.outputNote,
          conversionRequestId: args.requestId,
        })
        .where(eq(schema.learningInputs.id, args.inputId));
      ctx.invalidateQueries();
      return {
        ok: true,
        forbidden: false,
        alreadyConverted: false,
        convertedAt: now.toISOString(),
      };
    },
  }),

  deleteInput: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.learningInputs)
        .where(eq(schema.learningInputs.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),
} satisfies ActionsModule;
