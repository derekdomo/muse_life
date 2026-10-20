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

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

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

const skillStatSchema = z.object({
  id: z.number(),
  name: z.string(),
  note: z.string().nullable(),
  totalMinutes: z.number(),
  inputCount: z.number(),
  convertedCount: z.number(),
  conversionRate: z.number().nullable(),
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
  minutes: z.number(),
  converted: z.boolean(),
  convertedAt: z.string().nullable(),
  outputType: z.enum(OUTPUT_TYPES).nullable(),
  outputNote: z.string().nullable(),
});

const dashboardResponse = z.object({
  today: z.string(),
  skills: z.array(skillStatSchema),
  inputs: z.array(inputRowSchema),
  totals: z.object({
    totalInputs: z.number(),
    totalConverted: z.number(),
    totalMinutes: z.number(),
    conversionRate: z.number().nullable(),
    streakDays: z.number(),
    activeDays: z.number(),
    unconvertedCount: z.number(),
  }),
  series: z.array(pointSchema),
});

type Dashboard = z.infer<typeof dashboardResponse>;

const okResponse = z.object({ ok: z.literal(true) });

function buildSeries(
  rows: Array<{ date: string; convertedAt: Date | null; minutes: number }>,
  today: string,
): z.infer<typeof pointSchema>[] {
  if (rows.length === 0) return [];
  const byDay = new Map<string, { inputs: number; converted: number; minutes: number }>();
  for (const row of rows) {
    const cur = byDay.get(row.date) ?? { inputs: 0, converted: 0, minutes: 0 };
    cur.inputs += 1;
    if (row.convertedAt) cur.converted += 1;
    cur.minutes += row.minutes;
    byDay.set(row.date, cur);
  }
  const first = rows[0]?.date ?? today;
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

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}),
    response: dashboardResponse,
    async handler(ctx): Promise<Dashboard> {
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
          totalMinutes: mine.reduce((sum, r) => sum + r.minutes, 0),
          inputCount: mine.length,
          convertedCount,
          conversionRate:
            mine.length > 0 ? convertedCount / mine.length : null,
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
          minutes: r.minutes,
          converted: r.convertedAt != null,
          convertedAt: r.convertedAt ? r.convertedAt.toISOString() : null,
          outputType: r.outputType ?? null,
          outputNote: r.outputNote ?? null,
        }));

      const totalConverted = inputRows.filter((r) => r.convertedAt).length;
      return {
        today,
        skills,
        inputs,
        totals: {
          totalInputs: inputRows.length,
          totalConverted,
          totalMinutes: inputRows.reduce((sum, r) => sum + r.minutes, 0),
          conversionRate:
            inputRows.length > 0 ? totalConverted / inputRows.length : null,
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
    response: z.object({ id: z.number(), name: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.skills)
        .values({ name: args.name, note: args.note || null })
        .returning({ id: schema.skills.id });
      const row = inserted[0];
      if (!row) throw new Error("addSkill: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id, name: args.name };
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
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.skills)
        .set({ name: args.name, note: args.note ? args.note : null })
        .where(eq(schema.skills.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteSkill: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      // Ledger rows survive a deleted skill; they just lose the link.
      await db
        .update(schema.learningInputs)
        .set({ skillId: null })
        .where(eq(schema.learningInputs.skillId, args.id));
      await db.delete(schema.skills).where(eq(schema.skills.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
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
      minutes: z.number().int().min(0).max(1440).default(0),
      converted: z.boolean().default(false),
      outputType: z.enum(OUTPUT_TYPES).optional(),
      outputNote: z.string().trim().max(500).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
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
          minutes: args.minutes,
          convertedAt: converted ? new Date() : null,
          outputType: converted ? (args.outputType ?? null) : null,
          outputNote: converted ? args.outputNote || null : null,
        })
        .returning({ id: schema.learningInputs.id });
      const row = inserted[0];
      if (!row) throw new Error("recordLearningInput: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
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
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.learningInputs)
        .set({
          convertedAt: new Date(),
          outputType: args.outputType,
          outputNote: args.outputNote || null,
        })
        .where(eq(schema.learningInputs.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  unmarkConverted: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.learningInputs)
        .set({ convertedAt: null, outputType: null, outputNote: null })
        .where(eq(schema.learningInputs.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteInput: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.learningInputs)
        .where(eq(schema.learningInputs.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
