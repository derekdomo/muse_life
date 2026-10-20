// 创造复利 actions.
//
// Data model: projects are the owner's own products/projects; each project
// has an independent five-step stage ruler (idea → first version → shipped
// → first real user → first payment), each stage with its own date; and a
// ledger of weekly progress entries, each requiring a date, a verifiable
// output description, and an evidence reference. Work duration lives only
// in the free-text note and is never converted into value or progress.
//
// 口径 with 学习复利 strictly separate: this app records creation outputs
// only, never learning inputs. No external accounts, repos, or services
// are read — every row is owner-entered by hand.
//
// ACL: every action is owner-only. Each handler runs the strict isOwner
// gate BEFORE any database read/write; refused calls return a typed
// rejection ({ ok: false, forbidden: true } / a forbidden dashboard) and
// touch zero rows. There is no anonymous or sync-channel exception here.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

// Strict owner gate: only a verified owner viewer passes. Identified
// non-owners and anonymous calls (no viewer at all) are both refused.
function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

const TZ = "America/Los_Angeles";

const STAGE_KEYS = schema.STAGES;
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

/* ---------------- response schemas ---------------- */

const stageDateSchema = z.object({
  stage: z.enum(STAGE_KEYS),
  date: z.string(),
});

const projectSchema = z.object({
  id: z.number(),
  name: z.string(),
  note: z.string().nullable(),
  nextMilestone: z.string().nullable(),
  stages: z.array(stageDateSchema),
  // Index into STAGE_KEYS of the first unreached stage (= STAGE_KEYS.length
  // when every stage is reached); the reached count is the current stage.
  currentStageIndex: z.number(),
  nextStage: z.enum(STAGE_KEYS).nullable(),
  entryCount: z.number(),
  lastEntryDate: z.string().nullable(),
  thisWeekCount: z.number(),
});

const entrySchema = z.object({
  id: z.number(),
  projectId: z.number(),
  projectName: z.string(),
  date: z.string(),
  description: z.string(),
  evidence: z.string(),
  note: z.string().nullable(),
});

const weekPointSchema = z.object({
  weekStart: z.string(),
  // New countable events that week (progress entries + stage dates).
  newCount: z.number(),
  // Cumulative total at end of that week.
  cumulative: z.number(),
});

const dashboardResponse = z.object({
  // Repo-standard refusal flag: true means the caller is not the owner
  // and every data field below is empty (no creation data is returned).
  forbidden: z.boolean(),
  today: z.string(),
  weekStart: z.string(),
  projects: z.array(projectSchema),
  entries: z.array(entrySchema),
  thisWeekEntries: z.array(entrySchema),
  totals: z.object({
    projectCount: z.number(),
    totalEntries: z.number(),
    totalStagesReached: z.number(),
    // Every countable accumulation event: progress entries + stage dates.
    totalEvents: z.number(),
    thisWeekCount: z.number(),
    activeWeeks: z.number(),
  }),
  series: z.array(weekPointSchema),
});

type Dashboard = z.infer<typeof dashboardResponse>;

function forbiddenDashboard(): Dashboard {
  const today = todayKey();
  return {
    forbidden: true,
    today,
    weekStart: weekStartOf(today),
    projects: [],
    entries: [],
    thisWeekEntries: [],
    totals: {
      projectCount: 0,
      totalEntries: 0,
      totalStagesReached: 0,
      totalEvents: 0,
      thisWeekCount: 0,
      activeWeeks: 0,
    },
    series: [],
  };
}

// Mutation responses: ok reports whether the write happened; forbidden
// reports an owner-gate refusal (ok is then false and nothing was
// written). Matches the { ok, forbidden } shape used across the repo.
const okResponse = z.object({ ok: z.boolean(), forbidden: z.boolean() });

const addProjectResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  id: z.number().nullable(),
});

const addEntryResponse = z.object({
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
      const weekStart = weekStartOf(today);
      const weekEnd = shiftDay(weekStart, 6);

      const projectRows = await db
        .select()
        .from(schema.projects)
        .orderBy(asc(schema.projects.id));
      const stageRows = await db
        .select()
        .from(schema.projectStages)
        .orderBy(asc(schema.projectStages.id));
      const entryRows = await db
        .select()
        .from(schema.progressEntries)
        .orderBy(asc(schema.progressEntries.date), asc(schema.progressEntries.id));

      const nameById = new Map(projectRows.map((p) => [p.id, p.name]));
      const stagesByProject = new Map<number, Array<{ stage: schema.StageKey; date: string }>>();
      for (const s of stageRows) {
        const list = stagesByProject.get(s.projectId) ?? [];
        list.push({ stage: s.stage, date: s.date });
        stagesByProject.set(s.projectId, list);
      }
      const inThisWeek = (date: string) => date >= weekStart && date <= weekEnd;

      const projects: Dashboard["projects"] = projectRows.map((p) => {
        const stages = stagesByProject.get(p.id) ?? [];
        const reached = new Set(stages.map((s) => s.stage));
        const firstUnreached = STAGE_KEYS.findIndex((k) => !reached.has(k));
        const mine = entryRows.filter((e) => e.projectId === p.id);
        return {
          id: p.id,
          name: p.name,
          note: p.note ?? null,
          nextMilestone: p.nextMilestone ?? null,
          stages,
          currentStageIndex: firstUnreached === -1 ? STAGE_KEYS.length : firstUnreached,
          nextStage: firstUnreached === -1 ? null : (STAGE_KEYS[firstUnreached] ?? null),
          entryCount: mine.length,
          lastEntryDate: mine.length ? (mine[mine.length - 1]?.date ?? null) : null,
          thisWeekCount: mine.filter((e) => inThisWeek(e.date)).length,
        };
      });

      const entries: Dashboard["entries"] = [...entryRows]
        .sort((a, b) => b.id - a.id)
        .map((e) => ({
          id: e.id,
          projectId: e.projectId,
          projectName: nameById.get(e.projectId) ?? "(已删除项目)",
          date: e.date,
          description: e.description,
          evidence: e.evidence,
          note: e.note ?? null,
        }));

      // Weekly accumulation series: one point per week from the first
      // event's week through the current week. Weeks with no events stay
      // in the series with newCount 0 and a flat cumulative — real gaps,
      // never backfilled with invented data.
      const eventDates: string[] = [
        ...entryRows.map((e) => e.date),
        ...stageRows.map((s) => s.date),
      ].sort();
      const series: Dashboard["series"] = [];
      if (eventDates.length > 0) {
        const newByWeek = new Map<string, number>();
        for (const d of eventDates) {
          const ws = weekStartOf(d);
          newByWeek.set(ws, (newByWeek.get(ws) ?? 0) + 1);
        }
        let cursor = weekStartOf(eventDates[0] ?? today);
        let cumulative = 0;
        // Cap the walk so a stray far-future date cannot spin forever.
        for (let i = 0; i < 520 && cursor <= weekStart; i += 1) {
          const added = newByWeek.get(cursor) ?? 0;
          cumulative += added;
          series.push({ weekStart: cursor, newCount: added, cumulative });
          cursor = shiftDay(cursor, 7);
        }
      }

      return {
        forbidden: false,
        today,
        weekStart,
        projects,
        entries,
        thisWeekEntries: entries.filter((e) => inThisWeek(e.date)),
        totals: {
          projectCount: projectRows.length,
          totalEntries: entryRows.length,
          totalStagesReached: stageRows.length,
          totalEvents: entryRows.length + stageRows.length,
          thisWeekCount: entries.filter((e) => inThisWeek(e.date)).length,
          activeWeeks: series.filter((p) => p.newCount > 0).length,
        },
        series,
      };
    },
  }),

  addProject: defineAction({
    request: z.object({
      name: z.string().trim().min(1).max(80),
      note: z.string().trim().max(300).optional(),
      nextMilestone: z.string().trim().max(300).optional(),
    }),
    response: addProjectResponse,
    async handler(ctx, args): Promise<z.infer<typeof addProjectResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, id: null };
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.projects)
        .values({
          name: args.name,
          note: args.note || null,
          nextMilestone: args.nextMilestone || null,
        })
        .returning({ id: schema.projects.id });
      const row = inserted[0];
      if (!row) throw new Error("addProject: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, id: row.id };
    },
  }),

  updateProject: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(80),
      note: z.string().trim().max(300).nullable().optional(),
      nextMilestone: z.string().trim().max(300).nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.projects)
        .set({
          name: args.name,
          note: args.note ? args.note : null,
          nextMilestone: args.nextMilestone ? args.nextMilestone : null,
        })
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  deleteProject: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.progressEntries)
        .where(eq(schema.progressEntries.projectId, args.id));
      await db
        .delete(schema.projectStages)
        .where(eq(schema.projectStages.projectId, args.id));
      await db.delete(schema.projects).where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  // Mark one stage reached on its own date. Re-marking the same stage
  // updates only that stage's date; stages are never merged or backfilled
  // from each other.
  setStage: defineAction({
    request: z.object({
      projectId: z.number().int().positive(),
      stage: z.enum(STAGE_KEYS),
      date: z.string().regex(dateKeyRe, "date must be YYYY-MM-DD"),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projectStages)
        .where(eq(schema.projectStages.projectId, args.projectId));
      const found = rows.find((r) => r.stage === args.stage);
      if (found) {
        await db
          .update(schema.projectStages)
          .set({ date: args.date })
          .where(eq(schema.projectStages.id, found.id));
      } else {
        await db.insert(schema.projectStages).values({
          projectId: args.projectId,
          stage: args.stage,
          date: args.date,
        });
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  clearStage: defineAction({
    request: z.object({
      projectId: z.number().int().positive(),
      stage: z.enum(STAGE_KEYS),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projectStages)
        .where(eq(schema.projectStages.projectId, args.projectId));
      const found = rows.find((r) => r.stage === args.stage);
      if (found) {
        await db
          .delete(schema.projectStages)
          .where(eq(schema.projectStages.id, found.id));
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  // One weekly progress entry. The same output must not be counted twice:
  // an entry for the same project with identical description AND evidence
  // is refused as a duplicate instead of being inserted again.
  addProgress: defineAction({
    request: z.object({
      projectId: z.number().int().positive(),
      date: z.string().regex(dateKeyRe, "date must be YYYY-MM-DD"),
      description: z.string().trim().min(1).max(500),
      evidence: z.string().trim().min(1).max(500),
      note: z.string().trim().max(300).optional(),
    }),
    response: addEntryResponse,
    async handler(ctx, args): Promise<z.infer<typeof addEntryResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, id: null, duplicate: false };
      const db = ctx.db<typeof schema>();
      const project = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, args.projectId))
        .limit(1);
      if (project.length === 0) {
        return { ok: false, forbidden: false, id: null, duplicate: false };
      }
      const siblings = await db
        .select()
        .from(schema.progressEntries)
        .where(eq(schema.progressEntries.projectId, args.projectId));
      const dup = siblings.find(
        (e) => e.description === args.description && e.evidence === args.evidence,
      );
      if (dup) {
        return { ok: false, forbidden: false, id: dup.id, duplicate: true };
      }
      const inserted = await db
        .insert(schema.progressEntries)
        .values({
          projectId: args.projectId,
          date: args.date,
          description: args.description,
          evidence: args.evidence,
          note: args.note || null,
        })
        .returning({ id: schema.progressEntries.id });
      const row = inserted[0];
      if (!row) throw new Error("addProgress: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, forbidden: false, id: row.id, duplicate: false };
    },
  }),

  deleteProgress: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.progressEntries)
        .where(eq(schema.progressEntries.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),
} satisfies ActionsModule;
