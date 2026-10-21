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
//
// Write integrity (CMP-CREATE-SAVE-001):
// - A progress entry's identity is (projectId, date, description,
//   evidence); a stage's identity is (projectId, stage). Both writes go
//   through a single conditional INSERT … SELECT … WHERE EXISTS(project)
//   AND NOT EXISTS(identity) statement. SQLite serializes writers, so
//   the existence check and the insert are one atomic step: two
//   concurrent identical writes can never both land — the loser affects
//   zero rows, re-reads, and reports the existing row instead. The
//   EXISTS(project) guard in the same statement also means a write
//   racing deleteProject can never leave an orphan row behind.
// - deleteProject removes the project's entries, stages, and the
//   project row itself in ONE db.batch (a single transaction): any
//   failure rolls all three deletes back and the handler answers
//   { ok: false } with every row intact — never a half-deleted project.
// - addProgress captures the new row's id from the SAME statement via
//   INSERT … RETURNING — never a post-insert SELECT — so there is no
//   window in which a committed deleteProject can strand the handler
//   between "insert landed" and "row not found". If a delete commits
//   in that interleave (sweeping the just-landed entry away with its
//   project), the handler answers the typed rejection
//   { ok: false, code: "project_deleted" } instead of reporting a
//   phantom success, and never re-inserts a replacement row.
// - Legacy duplicate rows (written before this arbitration existed) are
//   NEVER auto-deleted or merged. getDashboard surfaces them in the
//   `reconciliation` list so the owner can see exactly which identities
//   are duplicated and govern them by hand.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, eq, sql } from "drizzle-orm";
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
  // The two fact lines, counted separately on the same week axis:
  // progress entries (成果记录) and marked stage dates (阶段里程碑).
  // newCount = newEntries + newStages and cumulative =
  // cumulativeEntries + cumulativeStages, kept for existing consumers.
  newEntries: z.number(),
  cumulativeEntries: z.number(),
  newStages: z.number(),
  cumulativeStages: z.number(),
});

// One duplicated identity found in the stored rows. Duplicates can only
// predate the atomic write arbitration; they are reported, never
// auto-removed, so the owner decides how to govern them.
const reconciliationSchema = z.object({
  kind: z.enum(["progress", "stage"]),
  projectId: z.number(),
  projectName: z.string(),
  // Progress identity fields (null on stage groups).
  date: z.string().nullable(),
  description: z.string().nullable(),
  evidence: z.string().nullable(),
  // Stage identity (null on progress groups).
  stage: z.enum(STAGE_KEYS).nullable(),
  // Every stored value in the group: row dates for stages (they can
  // differ), the shared date repeated for progress rows.
  dates: z.array(z.string()),
  ids: z.array(z.number()),
  count: z.number(),
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
  reconciliation: z.array(reconciliationSchema),
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
    reconciliation: [],
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
  // Typed refusal reason. "project_deleted" means the target project
  // is gone — deleted concurrently with the save, or before it — so
  // nothing was (or could stay) recorded. Null on every other outcome.
  code: z.enum(["project_deleted"]).nullable(),
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
      // event's week through the current week, with TWO fact lines on
      // the same week axis — progress entries and marked stage dates
      // accumulate separately (a stage mark is a project marker, never
      // an entry). Weeks with no events stay in the series with 0 new
      // and flat cumulatives on both lines — real gaps, never
      // backfilled with invented data. Clearing a stage removes its
      // row, so the stage line falls back while the entries line is
      // untouched. The combined newCount/cumulative fields are the sum
      // of the two lines, kept for existing consumers.
      const eventDates: string[] = [
        ...entryRows.map((e) => e.date),
        ...stageRows.map((s) => s.date),
      ].sort();
      const series: Dashboard["series"] = [];
      if (eventDates.length > 0) {
        const newEntriesByWeek = new Map<string, number>();
        for (const e of entryRows) {
          const ws = weekStartOf(e.date);
          newEntriesByWeek.set(ws, (newEntriesByWeek.get(ws) ?? 0) + 1);
        }
        const newStagesByWeek = new Map<string, number>();
        for (const s of stageRows) {
          const ws = weekStartOf(s.date);
          newStagesByWeek.set(ws, (newStagesByWeek.get(ws) ?? 0) + 1);
        }
        let cursor = weekStartOf(eventDates[0] ?? today);
        let cumulativeEntries = 0;
        let cumulativeStages = 0;
        // Cap the walk so a stray far-future date cannot spin forever.
        for (let i = 0; i < 520 && cursor <= weekStart; i += 1) {
          const newEntries = newEntriesByWeek.get(cursor) ?? 0;
          const newStages = newStagesByWeek.get(cursor) ?? 0;
          cumulativeEntries += newEntries;
          cumulativeStages += newStages;
          series.push({
            weekStart: cursor,
            newCount: newEntries + newStages,
            cumulative: cumulativeEntries + cumulativeStages,
            newEntries,
            cumulativeEntries,
            newStages,
            cumulativeStages,
          });
          cursor = shiftDay(cursor, 7);
        }
      }

      // Reconciliation: identities stored more than once (only possible
      // for rows written before the atomic arbitration). They stay
      // exactly as stored — listed here so the owner can see them and
      // delete extras by hand; nothing is merged or removed for them.
      const reconciliation: Dashboard["reconciliation"] = [];
      {
        const byIdentity = new Map<
          string,
          { projectId: number; date: string; description: string; evidence: string; ids: number[] }
        >();
        for (const e of entryRows) {
          const key = `${e.projectId}|${e.date}|${e.description}|${e.evidence}`;
          const group = byIdentity.get(key) ?? {
            projectId: e.projectId,
            date: e.date,
            description: e.description,
            evidence: e.evidence,
            ids: [],
          };
          group.ids.push(e.id);
          byIdentity.set(key, group);
        }
        for (const g of byIdentity.values()) {
          if (g.ids.length > 1) {
            reconciliation.push({
              kind: "progress",
              projectId: g.projectId,
              projectName: nameById.get(g.projectId) ?? "(已删除项目)",
              date: g.date,
              description: g.description,
              evidence: g.evidence,
              stage: null,
              dates: g.ids.map(() => g.date),
              ids: g.ids,
              count: g.ids.length,
            });
          }
        }
        const byStage = new Map<
          string,
          { projectId: number; stage: schema.StageKey; dates: string[]; ids: number[] }
        >();
        for (const s of stageRows) {
          const key = `${s.projectId}|${s.stage}`;
          const group = byStage.get(key) ?? {
            projectId: s.projectId,
            stage: s.stage,
            dates: [],
            ids: [],
          };
          group.dates.push(s.date);
          group.ids.push(s.id);
          byStage.set(key, group);
        }
        for (const g of byStage.values()) {
          if (g.ids.length > 1) {
            reconciliation.push({
              kind: "stage",
              projectId: g.projectId,
              projectName: nameById.get(g.projectId) ?? "(已删除项目)",
              date: null,
              description: null,
              evidence: null,
              stage: g.stage,
              dates: g.dates,
              ids: g.ids,
              count: g.ids.length,
            });
          }
        }
        reconciliation.sort(
          (a, b) => a.projectId - b.projectId || (a.ids[0] ?? 0) - (b.ids[0] ?? 0),
        );
      }

      return {
        forbidden: false,
        today,
        weekStart,
        projects,
        entries,
        thisWeekEntries: entries.filter((e) => inThisWeek(e.date)),
        reconciliation,
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

  // Delete a project with its stages and progress entries. The three
  // deletes run as ONE db.batch — a single transaction — so a failure
  // at any step rolls the whole delete back: the handler answers
  // { ok: false } and the project, its stages, and its entries are all
  // still there (CMP-CREATE-SAVE-001). Deleting an already-deleted id
  // is a successful no-op (safe retry), and because ids are
  // AUTOINCREMENT a stale delete can never hit a project created later.
  deleteProject: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      try {
        await db.batch([
          db
            .delete(schema.progressEntries)
            .where(eq(schema.progressEntries.projectId, args.id)),
          db
            .delete(schema.projectStages)
            .where(eq(schema.projectStages.projectId, args.id)),
          db.delete(schema.projects).where(eq(schema.projects.id, args.id)),
        ]);
      } catch {
        return { ok: false, forbidden: false };
      }
      ctx.invalidateQueries();
      return { ok: true, forbidden: false };
    },
  }),

  // Mark one stage reached on its own date. Re-marking the same stage
  // updates only that stage's date; stages are never merged or backfilled
  // from each other. The (projectId, stage) identity is arbitrated by a
  // single conditional INSERT … WHERE EXISTS(project) AND NOT
  // EXISTS(stage row): two concurrent marks of the same stage land
  // exactly one row, and when both carry different dates the later
  // write's date wins through the update path below — the same outcome
  // as marking them one after another.
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
      const identity = and(
        eq(schema.projectStages.projectId, args.projectId),
        eq(schema.projectStages.stage, args.stage),
      );
      const existing = await db
        .select({ id: schema.projectStages.id })
        .from(schema.projectStages)
        .where(identity)
        .orderBy(asc(schema.projectStages.id))
        .limit(1);
      const found = existing[0];
      if (found) {
        await db
          .update(schema.projectStages)
          .set({ date: args.date })
          .where(eq(schema.projectStages.id, found.id));
        ctx.invalidateQueries();
        return { ok: true, forbidden: false };
      }
      const inserted = await db.run(sql`
        INSERT INTO project_stages (project_id, stage, date, created_at)
        SELECT ${args.projectId}, ${args.stage}, ${args.date}, ${Date.now()}
        WHERE EXISTS (SELECT 1 FROM projects WHERE id = ${args.projectId})
          AND NOT EXISTS (
            SELECT 1 FROM project_stages
            WHERE project_id = ${args.projectId} AND stage = ${args.stage}
          )
      `);
      if (inserted.rowsAffected === 1) {
        ctx.invalidateQueries();
        return { ok: true, forbidden: false };
      }
      // Zero rows landed: either the project does not exist (possibly
      // deleted concurrently — no orphan stage row was written), or a
      // concurrent mark of the same stage won the insert. In the second
      // case this call is the later write, so its date wins.
      const winner = await db
        .select({ id: schema.projectStages.id })
        .from(schema.projectStages)
        .where(identity)
        .orderBy(asc(schema.projectStages.id))
        .limit(1);
      const winnerRow = winner[0];
      if (!winnerRow) return { ok: false, forbidden: false };
      await db
        .update(schema.projectStages)
        .set({ date: args.date })
        .where(eq(schema.projectStages.id, winnerRow.id));
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

  // One weekly progress entry. The same output must not be counted
  // twice: an entry's identity is (projectId, date, description,
  // evidence), and the insert is a single conditional statement —
  // INSERT … SELECT … WHERE EXISTS(project) AND NOT EXISTS(identity)
  // RETURNING id — so the duplicate check, the write, and the capture
  // of the new row's id are one atomic step. Two concurrent
  // submissions of the same output land exactly one row; the loser
  // (and any serial repeat) is answered duplicate:true with the
  // existing row's id instead of being inserted again. Because the id
  // comes back with the insert itself, there is no post-insert SELECT
  // for a concurrent deleteProject to strand: if a delete commits
  // right after the insert lands, it sweeps the new entry away with
  // its project, the handler detects the missing project, and answers
  // the typed rejection code:"project_deleted" — never an internal
  // error, never a phantom success, and never a replacement row
  // written into the void.
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
      if (!isOwner(ctx)) {
        return { ok: false, forbidden: true, id: null, duplicate: false, code: null };
      }
      const db = ctx.db<typeof schema>();
      const identity = and(
        eq(schema.progressEntries.projectId, args.projectId),
        eq(schema.progressEntries.date, args.date),
        eq(schema.progressEntries.description, args.description),
        eq(schema.progressEntries.evidence, args.evidence),
      );
      const projectAlive = async (): Promise<boolean> => {
        const rows = await db
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, args.projectId))
          .limit(1);
        return rows.length > 0;
      };
      const note = args.note || null;
      const inserted = await db.all<{ id: number }>(sql`
        INSERT INTO progress_entries (project_id, date, description, evidence, note, created_at)
        SELECT ${args.projectId}, ${args.date}, ${args.description}, ${args.evidence}, ${note}, ${Date.now()}
        WHERE EXISTS (SELECT 1 FROM projects WHERE id = ${args.projectId})
          AND NOT EXISTS (
            SELECT 1 FROM progress_entries
            WHERE project_id = ${args.projectId}
              AND date = ${args.date}
              AND description = ${args.description}
              AND evidence = ${args.evidence}
          )
        RETURNING id
      `);
      const newRow = inserted[0];
      if (newRow) {
        // The row landed and its id came back with the statement. A
        // deleteProject that committed in the interleave has already
        // removed both the project and this entry (one batch), so the
        // save no longer exists: answer the typed rejection rather
        // than reporting success for a swept-away row.
        if (!(await projectAlive())) {
          return { ok: false, forbidden: false, id: null, duplicate: false, code: "project_deleted" };
        }
        ctx.invalidateQueries();
        return { ok: true, forbidden: false, id: newRow.id, duplicate: false, code: null };
      }
      // Zero rows landed. If an identical entry already exists (serial
      // repeat, or the winner of a concurrent race), report it as a
      // duplicate with the earliest stored id.
      const dup = await db
        .select({ id: schema.progressEntries.id })
        .from(schema.progressEntries)
        .where(identity)
        .orderBy(asc(schema.progressEntries.id))
        .limit(1);
      const dupRow = dup[0];
      if (dupRow) {
        return { ok: false, forbidden: false, id: dupRow.id, duplicate: true, code: null };
      }
      // No duplicate either: the EXISTS(project) guard is what refused
      // the write — the project itself is gone (deleted concurrently,
      // or it never existed), and no orphan entry was written.
      if (!(await projectAlive())) {
        return { ok: false, forbidden: false, id: null, duplicate: false, code: "project_deleted" };
      }
      // The project exists and no identical entry is stored, yet the
      // insert landed zero rows — a concurrent winner's row was itself
      // removed between the two statements. Plain refusal; the owner
      // can simply retry.
      return { ok: false, forbidden: false, id: null, duplicate: false, code: null };
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
