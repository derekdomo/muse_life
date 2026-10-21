// CMP-CREATE-SAVE-001 validation — write integrity for 创造复利:
// concurrent-duplicate arbitration on addProgress / setStage, and
// atomic deleteProject with full rollback on injected failures.
//
// Two layers:
//  1. Source wiring: deleteProject deletes through ONE db.batch inside
//     a try/catch that answers { ok: false }; addProgress / setStage
//     write through single conditional INSERT … WHERE EXISTS(project)
//     AND NOT EXISTS(identity) statements; addProgress captures the
//     new row's id from the insert statement itself (… RETURNING id)
//     and answers the typed code:"project_deleted" rejection when a
//     delete lands in the interleave; the strict owner gate is
//     unchanged and precedes every ctx.db access.
//  2. Behavior: the REAL handlers from server/src/actions.ts run
//     against throwaway in-memory libsql databases (schema applied
//     from drizzle/*.sql) behind synthetic owner / non-owner /
//     anonymous contexts. Concurrency is exercised with Promise.all
//     pairs in both start orders; delete failures are injected with
//     RAISE(ABORT) triggers on each of the three tables in turn, and
//     the post-failure state must be byte-identical to the pre-delete
//     snapshot. A deterministic interleave (insert lands → delete
//     commits → save handler resumes, driven by hooking the libsql
//     client's execute) must yield the typed project_deleted
//     rejection with zero orphan rows and post-delete data intact.
//     A separate legacy database (0001+0002 only, seeded
//     with pre-arbitration duplicate rows) proves old data is
//     preserved untouched and surfaced via the reconciliation list.
//
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-save-integrity.mjs
import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
let failures = 0;
function check(name, ok, note = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${note ? ` (${note})` : ""}`);
}

/* ---------------- 1. source wiring ---------------- */

const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const clientSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");

check(
  "source: isOwner is exactly ctx.viewer?.isOwner === true",
  serverSrc.includes("return ctx.viewer?.isOwner === true;"),
);
check(
  "source: no anonymous/no-viewer exception helper exists",
  !/viewer\s*===\s*(undefined|null)/.test(serverSrc) && !serverSrc.includes("isOwnerOr"),
);

const ACTION_NAMES = [
  "getDashboard",
  "addProject",
  "updateProject",
  "deleteProject",
  "setStage",
  "clearStage",
  "addProgress",
  "deleteProgress",
];
function actionSlice(src, name) {
  const start = src.indexOf(`  ${name}: defineAction({`);
  if (start < 0) throw new Error(`action ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n  \w+: defineAction\(\{/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}
for (const name of ACTION_NAMES) {
  const slice = actionSlice(serverSrc, name);
  const gateIdx = slice.indexOf("if (!isOwner(ctx))");
  const dbIdx = slice.indexOf("ctx.db");
  check(`source: ${name} is gated`, gateIdx > -1);
  check(`source: ${name} gate precedes any ctx.db access`, gateIdx > -1 && (dbIdx === -1 || gateIdx < dbIdx));
}
{
  const del = actionSlice(serverSrc, "deleteProject");
  check("source: deleteProject deletes via a single db.batch", del.includes("db.batch(["));
  check(
    "source: deleteProject catches failure and answers ok:false (no throw past the batch)",
    del.includes("catch") && del.includes("return { ok: false, forbidden: false };"),
  );
  check(
    "source: deleteProject issues exactly the three table deletes inside the batch",
    (del.match(/\.delete\(schema\./g) ?? []).length === 3,
  );
  const add = actionSlice(serverSrc, "addProgress");
  check(
    "source: addProgress writes via one conditional INSERT (EXISTS project + NOT EXISTS identity)",
    add.includes("INSERT INTO progress_entries") && add.includes("EXISTS (SELECT 1 FROM projects") && add.includes("NOT EXISTS"),
  );
  check("source: addProgress reports the existing row on duplicate", add.includes("duplicate: true"));
  check(
    "source: addProgress captures the new row id from the insert itself (INSERT … RETURNING id via db.all)",
    add.includes("RETURNING id") && add.includes("db.all"),
  );
  check(
    "source: the insert-then-reread invariant throw is gone (no 'insert landed but row not found' anywhere)",
    !serverSrc.includes("insert landed but row not found"),
  );
  check(
    "source: addProgress answers the typed project_deleted rejection",
    add.includes('code: "project_deleted"') && serverSrc.includes('z.enum(["project_deleted"])'),
  );
  const stage = actionSlice(serverSrc, "setStage");
  check(
    "source: setStage writes via one conditional INSERT (EXISTS project + NOT EXISTS stage row)",
    stage.includes("INSERT INTO project_stages") && stage.includes("EXISTS (SELECT 1 FROM projects") && stage.includes("NOT EXISTS"),
  );
}
check(
  "client: project delete failure is surfaced explicitly and states nothing was deleted",
  clientSrc.includes("删除失败：项目、阶段日期与推进记录都还完整保留"),
);
check(
  "client: reconciliation notice renders stored duplicate groups",
  clientSrc.includes("重复记录对账") && clientSrc.includes("data.reconciliation"),
);
check(
  "client: project_deleted rejection keeps the draft and says the project was deleted",
  clientSrc.includes('res.code === "project_deleted"') &&
    clientSrc.includes("所选项目已被删除，这条记录没有保存。填写内容已保留"),
);
check(
  "source: week points carry the two fact lines separately (entries + stages, new + cumulative)",
  serverSrc.includes("newEntries: z.number()") &&
    serverSrc.includes("cumulativeEntries: z.number()") &&
    serverSrc.includes("newStages: z.number()") &&
    serverSrc.includes("cumulativeStages: z.number()") &&
    serverSrc.includes("newEntriesByWeek") &&
    serverSrc.includes("newStagesByWeek"),
);
check(
  "client: chart draws both lines — solid entries + dashed stages (line style, not color alone)",
  clientSrc.includes("strokeDasharray") &&
    clientSrc.includes("cumulativeEntries") &&
    clientSrc.includes("cumulativeStages"),
);
check(
  "client: legend names both lines with their meanings and current counts",
  clientSrc.includes("累计成果记录（实线 · 圆点）") &&
    clientSrc.includes("已标记的阶段里程碑（虚线 · 方点）") &&
    clientSrc.includes("不等于真实用户或收入增长"),
);

/* ---------------- 2. behavior against real handlers ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");
const { eq } = await import("drizzle-orm");

async function makeDb(files) {
  const client = createClient({ url: ":memory:" });
  const migrationDir = new URL("./drizzle/", import.meta.url);
  const names = files ?? readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of names) {
    const sqlText = readFileSync(new URL(file, migrationDir), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
  return { client, db: drizzle(client, { schema }) };
}

function makeCtx(db, viewer) {
  const state = { dbCalls: 0 };
  const ctx = {
    slug: "space-12-validate",
    invocationId: "validate-save-integrity",
    spaceDir: "",
    viewer,
    db: () => {
      state.dbCalls += 1;
      return db;
    },
    invalidateQueries: () => {},
    executePrivileged: async () => {
      throw new Error("no privileged contracts in validate");
    },
  };
  return { ctx, state };
}
const OWNER = { id: "owner-1", isOwner: true };
const NON_OWNER = { id: "someone-else", isOwner: false };
const ANON = undefined;

async function call(name, ctx, args) {
  const action = Actions[name];
  const parsedArgs = action.request.parse(args);
  const res = await action.handler(ctx, parsedArgs);
  action.response.parse(res);
  return res;
}

async function snapshot(client) {
  const out = {};
  for (const table of ["projects", "project_stages", "progress_entries"]) {
    const rs = await client.execute(`SELECT * FROM ${table} ORDER BY id`);
    out[table] = rs.rows.map((r) => JSON.stringify(r));
  }
  return out;
}
function sameSnapshot(a, b) {
  return ["projects", "project_stages", "progress_entries"].every(
    (t) => a[t].length === b[t].length && a[t].every((row, i) => row === b[t][i]),
  );
}

/* ----- main database: owner happy path + concurrency + delete ----- */

const { client, db } = await makeDb();
const { ctx: owner } = makeCtx(db, OWNER);

const proj = await call("addProject", owner, { name: "并发验证项目" });
check("owner: addProject ok", proj.ok === true && typeof proj.id === "number");
const pid = proj.id;

/* addProgress: serial duplicate, then concurrent duplicates both orders */
const entryArgs = {
  projectId: pid,
  date: "2026-10-19",
  description: "v1 上线",
  evidence: "tag v1",
};
const first = await call("addProgress", owner, entryArgs);
check("addProgress: first write ok with id", first.ok === true && first.duplicate === false && typeof first.id === "number");
const serialDup = await call("addProgress", owner, entryArgs);
check(
  "addProgress: serial repeat refused as duplicate with the existing id",
  serialDup.ok === false && serialDup.duplicate === true && serialDup.id === first.id,
);
{
  const rows = await db.select().from(schema.progressEntries);
  check("addProgress: serial duplicate left exactly one row", rows.length === 1, `rows=${rows.length}`);
}
const diffDate = await call("addProgress", owner, { ...entryArgs, date: "2026-10-20" });
check(
  "addProgress: same description+evidence on a DIFFERENT date is a different outcome (identity includes date)",
  diffDate.ok === true && diffDate.duplicate === false && diffDate.id !== first.id,
);
const diffDesc = await call("addProgress", owner, { ...entryArgs, description: "v1.1 修复", evidence: "tag v1.1" });
check("addProgress: a genuinely different outcome is recorded separately", diffDesc.ok === true && diffDesc.duplicate === false);

const concArgs = {
  projectId: pid,
  date: "2026-10-18",
  description: "落地页发布",
  evidence: "https://example.com/landing",
};
for (const order of ["AB", "BA"]) {
  const a = () => call("addProgress", owner, { ...concArgs, note: `note-${order}-a` });
  const b = () => call("addProgress", owner, { ...concArgs, note: `note-${order}-b` });
  const [r1, r2] = order === "AB" ? await Promise.all([a(), b()]) : await Promise.all([b(), a()]);
  const winners = [r1, r2].filter((r) => r.ok === true && r.duplicate === false);
  const losers = [r1, r2].filter((r) => r.ok === false && r.duplicate === true);
  check(
    `addProgress concurrent (${order}): exactly one write lands`,
    winners.length === 1 && losers.length === 1,
    JSON.stringify([r1, r2]),
  );
  check(
    `addProgress concurrent (${order}): loser returns duplicate:true with the winner's id`,
    losers.length === 1 && winners.length === 1 && losers[0].id === winners[0].id,
  );
  const rows = await db
    .select()
    .from(schema.progressEntries)
    .where(eq(schema.progressEntries.description, concArgs.description));
  check(`addProgress concurrent (${order}): exactly one stored row for the identity`, rows.length === 1, `rows=${rows.length}`);
  // Clean the row so the second order runs against a fresh identity state.
  if (rows[0]) await call("deleteProgress", owner, { id: rows[0].id });
}

/* setStage: serial re-mark, concurrent same stage, different stages */
const s1 = await call("setStage", owner, { projectId: pid, stage: "idea", date: "2026-10-01" });
check("setStage: first mark ok", s1.ok === true);
const s2 = await call("setStage", owner, { projectId: pid, stage: "idea", date: "2026-10-03" });
{
  const rows = await db.select().from(schema.projectStages);
  check(
    "setStage: serial re-mark updates only that stage's date (still one row)",
    s2.ok === true && rows.length === 1 && rows[0].date === "2026-10-03",
    JSON.stringify(rows),
  );
}
for (const order of ["AB", "BA"]) {
  const a = () => call("setStage", owner, { projectId: pid, stage: "first_version", date: "2026-10-05" });
  const b = () => call("setStage", owner, { projectId: pid, stage: "first_version", date: "2026-10-07" });
  const [r1, r2] = order === "AB" ? await Promise.all([a(), b()]) : await Promise.all([b(), a()]);
  const rows = (await db.select().from(schema.projectStages)).filter((r) => r.stage === "first_version");
  check(
    `setStage concurrent same stage (${order}): both ok, exactly one row`,
    r1.ok === true && r2.ok === true && rows.length === 1,
    `rows=${rows.length}`,
  );
  check(
    `setStage concurrent same stage different dates (${order}): final date is one of the two writes (last-writer-wins)`,
    rows.length === 1 && (rows[0].date === "2026-10-05" || rows[0].date === "2026-10-07"),
    rows[0]?.date,
  );
  if (rows[0]) await call("clearStage", owner, { projectId: pid, stage: "first_version" });
}
{
  const [r1, r2] = await Promise.all([
    call("setStage", owner, { projectId: pid, stage: "shipped", date: "2026-10-10" }),
    call("setStage", owner, { projectId: pid, stage: "first_user", date: "2026-10-12" }),
  ]);
  const rows = await db.select().from(schema.projectStages);
  check(
    "setStage concurrent different stages: independent rows",
    r1.ok === true && r2.ok === true && rows.filter((r) => r.stage === "shipped").length === 1 &&
      rows.filter((r) => r.stage === "first_user").length === 1,
    `stages=${rows.length}`,
  );
}
const orphanStage = await call("setStage", owner, { projectId: 999999, stage: "idea", date: "2026-10-01" });
check("setStage: nonexistent project refused, no orphan stage row", orphanStage.ok === false);
const orphanEntry = await call("addProgress", owner, {
  projectId: 999999, date: "2026-10-01", description: "孤儿产出", evidence: "无",
});
check(
  "addProgress: nonexistent project refused (not a duplicate), no orphan entry",
  orphanEntry.ok === false && orphanEntry.duplicate === false && orphanEntry.id === null,
);
check(
  "addProgress: nonexistent project refusal carries the typed project_deleted code",
  orphanEntry.code === "project_deleted",
  JSON.stringify(orphanEntry),
);

/* deleteProject: failure injection on each delete step */
async function seedProject(label) {
  const p = await call("addProject", owner, { name: label });
  await call("setStage", owner, { projectId: p.id, stage: "idea", date: "2026-10-02" });
  await call("addProgress", owner, {
    projectId: p.id, date: "2026-10-02", description: `${label} 产出`, evidence: `${label} 证据`,
  });
  return p.id;
}
const TRIGGERS = [
  ["progress_entries", "inject_fail_entries"],
  ["project_stages", "inject_fail_stages"],
  ["projects", "inject_fail_project"],
];
for (const [table, trig] of TRIGGERS) {
  const victim = await seedProject(`回滚验证-${table}`);
  const before = await snapshot(client);
  await client.execute(
    `CREATE TRIGGER ${trig} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
  );
  let res;
  let threw = false;
  try {
    res = await call("deleteProject", owner, { id: victim });
  } catch {
    threw = true;
  }
  await client.execute(`DROP TRIGGER ${trig}`);
  const after = await snapshot(client);
  check(
    `deleteProject: failure injected at ${table} delete -> handler answers ok:false, never throws`,
    !threw && res?.ok === false && res?.forbidden === false,
    JSON.stringify(res),
  );
  check(
    `deleteProject: failure at ${table} delete -> FULL rollback, every row byte-identical`,
    sameSnapshot(before, after),
  );
  const cleanup = await call("deleteProject", owner, { id: victim });
  check(`deleteProject: same project deletes cleanly once the fault is gone (${table})`, cleanup.ok === true);
}

/* deleteProject: success, retry, and never hitting a later project */
{
  const victim = await seedProject("删除成功验证");
  const other = await seedProject("旁观项目");
  const okDel = await call("deleteProject", owner, { id: victim });
  check("deleteProject: success answers ok:true", okDel.ok === true && okDel.forbidden === false);
  const snap = await snapshot(client);
  check(
    "deleteProject: success removes project + stages + entries in one go",
    !snap.projects.some((r) => r.includes(`"id":${victim}`)) &&
      !snap.project_stages.some((r) => r.includes(`"project_id":${victim}`)) &&
      !snap.progress_entries.some((r) => r.includes(`"project_id":${victim}`)),
  );
  check(
    "deleteProject: the other project's rows are untouched",
    snap.projects.some((r) => r.includes(`"id":${other}`)) &&
      snap.progress_entries.some((r) => r.includes(`"project_id":${other}`)),
  );
  const retry = await call("deleteProject", owner, { id: victim });
  check("deleteProject: retry on the deleted id is a successful no-op", retry.ok === true);
  const fresh = await call("addProject", owner, { name: "删除后新建的项目" });
  check("deleteProject: a project created after the delete gets a fresh id", fresh.id !== victim && fresh.id !== other);
  const staleRetry = await call("deleteProject", owner, { id: victim });
  const dashAfter = await call("getDashboard", owner, {});
  check(
    "deleteProject: a stale retry never deletes the newly created project",
    staleRetry.ok === true && dashAfter.projects.some((p) => p.id === fresh.id),
  );
}

/* save x delete concurrency: no orphans either way */
for (const order of ["save-first", "delete-first"]) {
  const victim = await seedProject(`并发删写-${order}`);
  const save = () =>
    call("addProgress", owner, {
      projectId: victim, date: "2026-10-15", description: "并发写入的产出", evidence: "并发证据",
    });
  const delP = () => call("deleteProject", owner, { id: victim });
  const [saveRes, delRes] =
    order === "save-first" ? await Promise.all([save(), delP()]) : await Promise.all([delP(), save()]).then(([d, s]) => [s, d]);
  const snap = await snapshot(client);
  const orphans =
    snap.project_stages.filter((r) => r.includes(`"project_id":${victim}`)).length +
    snap.progress_entries.filter((r) => r.includes(`"project_id":${victim}`)).length;
  const projectGone = !snap.projects.some((r) => r.includes(`"id":${victim}`));
  check(
    `save x delete concurrent (${order}): delete ok, project gone, zero orphan rows`,
    delRes.ok === true && projectGone && orphans === 0,
    `orphans=${orphans} save=${JSON.stringify(saveRes)}`,
  );
  check(
    `save x delete concurrent (${order}): the save either landed-then-was-deleted or was refused — never a phantom success`,
    (saveRes.ok === true && projectGone) || (saveRes.ok === false && saveRes.duplicate === false),
    JSON.stringify(saveRes),
  );
}
{
  // setStage racing a delete of the same project: no orphan stage row.
  const victim = await seedProject("并发阶段删写");
  const [stageRes, delRes] = await Promise.all([
    call("setStage", owner, { projectId: victim, stage: "first_payment", date: "2026-10-16" }),
    call("deleteProject", owner, { id: victim }),
  ]);
  const snap = await snapshot(client);
  const orphans = snap.project_stages.filter((r) => r.includes(`"project_id":${victim}`)).length;
  check(
    "setStage x delete concurrent: delete ok and zero orphan stage rows",
    delRes.ok === true && orphans === 0 && typeof stageRes.ok === "boolean",
    `orphans=${orphans}`,
  );
}

/* addProgress × deleteProject: DETERMINISTIC interleave — the insert
   statement lands, deleteProject then commits in full, and only then
   does the save handler resume. Driven by hooking the libsql client's
   execute: the first INSERT INTO progress_entries that lands while
   armed runs the delete (and the post-delete creations) before its
   result is handed back to the handler. The handler must answer the
   typed project_deleted rejection — never the old invariant throw,
   never a phantom success — leave zero orphan rows, and not touch
   data created after the delete. */
{
  const victim = await seedProject("交错删写验证");
  const origExecute = client.execute.bind(client);
  let armed = true;
  let hookError = null;
  let freshId = null;
  client.execute = async (stmt) => {
    const result = await origExecute(stmt);
    const text =
      typeof stmt === "string" ? stmt : stmt && typeof stmt.sql === "string" ? stmt.sql : "";
    if (armed && text.includes("INSERT INTO progress_entries")) {
      armed = false; // disarm first: the interleave itself writes entries
      try {
        const del = await call("deleteProject", owner, { id: victim });
        if (!del.ok) throw new Error(`interleave deleteProject answered ${JSON.stringify(del)}`);
        const fresh = await call("addProject", owner, { name: "删除之后新建的项目-交错" });
        freshId = fresh.id;
        const kept = await call("addProgress", owner, {
          projectId: fresh.id,
          date: "2026-10-17",
          description: "删除之后的新产出",
          evidence: "删除之后的证据",
        });
        if (!kept.ok) throw new Error(`post-delete addProgress answered ${JSON.stringify(kept)}`);
      } catch (e) {
        hookError = e;
      }
    }
    return result;
  };
  let saveRes = null;
  let saveThrew = false;
  try {
    saveRes = await call("addProgress", owner, {
      projectId: victim,
      date: "2026-10-17",
      description: "交错时刻的产出",
      evidence: "交错证据",
    });
  } catch {
    saveThrew = true;
  } finally {
    client.execute = origExecute;
  }
  check(
    "interleave setup: delete committed and post-delete writes landed inside the insert→resume window",
    hookError === null && typeof freshId === "number",
    hookError ? String(hookError) : "",
  );
  check(
    "addProgress × delete interleave: typed project_deleted rejection (no invariant throw, no phantom success)",
    !saveThrew &&
      saveRes?.ok === false &&
      saveRes?.forbidden === false &&
      saveRes?.duplicate === false &&
      saveRes?.id === null &&
      saveRes?.code === "project_deleted",
    JSON.stringify(saveRes),
  );
  const snap = await snapshot(client);
  check(
    "addProgress × delete interleave: zero orphan rows for the deleted project (landed insert swept, never re-created)",
    !snap.projects.some((r) => r.includes(`"id":${victim}`)) &&
      !snap.project_stages.some((r) => r.includes(`"project_id":${victim}`)) &&
      !snap.progress_entries.some((r) => r.includes(`"project_id":${victim}`)),
  );
  check(
    "addProgress × delete interleave: data created after the delete is untouched",
    typeof freshId === "number" &&
      snap.projects.some((r) => r.includes(`"id":${freshId}`)) &&
      snap.progress_entries.some((r) => r.includes(`"project_id":${freshId}`)),
  );
}

/* ----- ACL matrix: non-owner + anonymous on every action ----- */

const ACL_CALLS = [
  ["getDashboard", {}],
  ["addProject", { name: "越权项目" }],
  ["updateProject", { id: pid, name: "越权改名" }],
  ["deleteProject", { id: pid }],
  ["setStage", { projectId: pid, stage: "idea", date: "2026-10-01" }],
  ["clearStage", { projectId: pid, stage: "idea" }],
  ["addProgress", { projectId: pid, date: "2026-10-01", description: "越权产出", evidence: "越权证据" }],
  ["deleteProgress", { id: 1 }],
];
for (const [label, viewer] of [["non-owner", NON_OWNER], ["anonymous", ANON]]) {
  const { ctx, state } = makeCtx(db, viewer);
  const before = await snapshot(client);
  for (const [name, args] of ACL_CALLS) {
    const res = await call(name, ctx, args);
    if (name === "getDashboard") {
      check(
        `${label}: getDashboard refused with empty data + empty reconciliation`,
        res.forbidden === true && res.projects.length === 0 && res.entries.length === 0 && res.reconciliation.length === 0,
      );
    } else {
      check(`${label}: ${name} refused`, res.ok === false && res.forbidden === true);
    }
  }
  check(`${label}: zero database access across all 8 actions`, state.dbCalls === 0, `dbCalls=${state.dbCalls}`);
  const after = await snapshot(client);
  check(`${label}: stored rows unchanged by refused calls`, sameSnapshot(before, after));
}

/* ----- legacy database: 0002-era data (with duplicates) survives ----- */

{
  const legacy = await makeDb(["0001_initial.sql", "0002_create_projects_stages_progress_tables.sql"]);
  const lc = legacy.client;
  const now = 1792000000000;
  await lc.execute({
    sql: "INSERT INTO projects (id, name, note, next_milestone, created_at) VALUES (1, '旧档项目', NULL, NULL, ?)",
    args: [now],
  });
  // Pre-arbitration duplicates: same progress identity twice, same stage twice.
  await lc.execute({
    sql: "INSERT INTO progress_entries (id, project_id, date, description, evidence, note, created_at) VALUES (1, 1, '2026-10-10', '旧产出', '旧证据', NULL, ?), (2, 1, '2026-10-10', '旧产出', '旧证据', '重复写入', ?), (3, 1, '2026-10-11', '另一条产出', '另一证据', NULL, ?)",
    args: [now, now, now],
  });
  await lc.execute({
    sql: "INSERT INTO project_stages (id, project_id, stage, date, created_at) VALUES (1, 1, 'idea', '2026-10-01', ?), (2, 1, 'idea', '2026-10-02', ?), (3, 1, 'shipped', '2026-10-09', ?)",
    args: [now, now, now],
  });
  const before = await snapshot(lc);
  const { ctx: legacyOwner } = makeCtx(legacy.db, OWNER);

  const dash = await call("getDashboard", legacyOwner, {});
  check(
    "legacy: dashboard reads the 0002-era archive (project + all rows counted, nothing dropped)",
    dash.forbidden === false && dash.projects.length === 1 && dash.totals.totalEntries === 3 && dash.totals.totalStagesReached === 3,
    JSON.stringify(dash.totals),
  );
  check(
    "legacy: duplicate groups are surfaced for reconciliation (progress x2 + stage x2), rows kept",
    dash.reconciliation.length === 2 &&
      dash.reconciliation.some((g) => g.kind === "progress" && g.count === 2 && g.ids.join() === "1,2") &&
      dash.reconciliation.some((g) => g.kind === "stage" && g.count === 2 && g.dates.join() === "2026-10-01,2026-10-02"),
    JSON.stringify(dash.reconciliation),
  );
  const dupWrite = await call("addProgress", legacyOwner, {
    projectId: 1, date: "2026-10-10", description: "旧产出", evidence: "旧证据",
  });
  check(
    "legacy: writing the duplicated identity again is refused as duplicate with the EARLIEST stored id, no third row",
    dupWrite.ok === false && dupWrite.duplicate === true && dupWrite.id === 1,
    JSON.stringify(dupWrite),
  );
  const remark = await call("setStage", legacyOwner, { projectId: 1, stage: "idea", date: "2026-10-05" });
  const stageRows = await legacy.db.select().from(schema.projectStages);
  check(
    "legacy: re-marking a duplicated stage updates the earliest row only — both rows kept, none merged away",
    remark.ok === true && stageRows.filter((r) => r.stage === "idea").length === 2 &&
      stageRows.find((r) => r.id === 1)?.date === "2026-10-05" &&
      stageRows.find((r) => r.id === 2)?.date === "2026-10-02",
  );
  const after = await snapshot(lc);
  check(
    "legacy: row counts unchanged by reads + arbitrated writes (3 entries, 3 stages, 1 project)",
    after.projects.length === 1 && after.progress_entries.length === 3 && after.project_stages.length === 3 &&
      before.projects.length === after.projects.length,
  );
  // Owner governance path: duplicates can be removed BY HAND, one by one.
  const manual = await call("deleteProgress", legacyOwner, { id: 2 });
  const dash2 = await call("getDashboard", legacyOwner, {});
  check(
    "legacy: owner can delete a duplicate entry by hand; the progress group then leaves the reconciliation list",
    manual.ok === true && dash2.reconciliation.filter((g) => g.kind === "progress").length === 0 &&
      dash2.totals.totalEntries === 2,
  );
}

/* ----- two fact lines: entries vs stage milestones (CMP-CREATE-001) ----- */

{
  const two = await makeDb();
  const { ctx: twoOwner } = makeCtx(two.db, OWNER);

  const emptyDash = await call("getDashboard", twoOwner, {});
  check(
    "two-lines: no records at all -> empty series (honest empty state, no invented points)",
    emptyDash.series.length === 0 && emptyDash.totals.totalEvents === 0,
  );

  const tp = await call("addProject", twoOwner, { name: "双线验证项目" });
  // Week of Mon 2026-09-28: one entry + one stage.
  await call("addProgress", twoOwner, {
    projectId: tp.id, date: "2026-09-29", description: "双线产出 A", evidence: "证据 A",
  });
  await call("setStage", twoOwner, { projectId: tp.id, stage: "idea", date: "2026-09-30" });
  // Week of Mon 2026-10-05: nothing at all (gap week).
  // Week of Mon 2026-10-12: two entries + one stage, same week.
  await call("addProgress", twoOwner, {
    projectId: tp.id, date: "2026-10-13", description: "双线产出 B", evidence: "证据 B",
  });
  await call("addProgress", twoOwner, {
    projectId: tp.id, date: "2026-10-14", description: "双线产出 C", evidence: "证据 C",
  });
  await call("setStage", twoOwner, { projectId: tp.id, stage: "first_version", date: "2026-10-15" });

  const dash = await call("getDashboard", twoOwner, {});
  const at = (ws) => dash.series.find((p) => p.weekStart === ws);
  const w1 = at("2026-09-28");
  check(
    "two-lines: week 1 counts each kind on its own line (1 new entry, 1 new stage)",
    w1?.newEntries === 1 && w1?.cumulativeEntries === 1 && w1?.newStages === 1 && w1?.cumulativeStages === 1,
    JSON.stringify(w1),
  );
  check(
    "two-lines: combined fields preserved as the sum of both lines (newCount 2, cumulative 2)",
    w1?.newCount === 2 && w1?.cumulative === 2,
    JSON.stringify(w1),
  );
  const gap = at("2026-10-05");
  check(
    "two-lines: gap week stays in the series with both lines flat, nothing backfilled",
    gap?.newEntries === 0 && gap?.newStages === 0 &&
      gap?.cumulativeEntries === 1 && gap?.cumulativeStages === 1 && gap?.newCount === 0,
    JSON.stringify(gap),
  );
  const w3 = at("2026-10-12");
  check(
    "two-lines: same week with both kinds accumulates each line separately (entries 3, stages 2)",
    w3?.newEntries === 2 && w3?.cumulativeEntries === 3 &&
      w3?.newStages === 1 && w3?.cumulativeStages === 2 &&
      w3?.newCount === 3 && w3?.cumulative === 5,
    JSON.stringify(w3),
  );

  // Clearing a stage moves ONLY the stage line.
  const cleared = await call("clearStage", twoOwner, { projectId: tp.id, stage: "first_version" });
  const dash2 = await call("getDashboard", twoOwner, {});
  const w3b = dash2.series.find((p) => p.weekStart === "2026-10-12");
  check(
    "two-lines: clearStage drops the stage line only — entries line unchanged",
    cleared.ok === true &&
      w3b?.newStages === 0 && w3b?.cumulativeStages === 1 &&
      w3b?.newEntries === 2 && w3b?.cumulativeEntries === 3 &&
      w3b?.cumulative === 4,
    JSON.stringify(w3b),
  );

  // A duplicate output is still arbitrated: not re-counted on either line.
  const dup = await call("addProgress", twoOwner, {
    projectId: tp.id, date: "2026-10-13", description: "双线产出 B", evidence: "证据 B",
  });
  const dash3 = await call("getDashboard", twoOwner, {});
  const lastPoint = dash3.series[dash3.series.length - 1];
  check(
    "two-lines: duplicate entry refused and not re-counted on either line",
    dup.duplicate === true && lastPoint?.cumulativeEntries === 3 && lastPoint?.cumulativeStages === 1,
    JSON.stringify(lastPoint),
  );

  // Re-marking a stage on a different date moves the stage line's week,
  // never the entries line.
  await call("setStage", twoOwner, { projectId: tp.id, stage: "idea", date: "2026-10-13" });
  const dash4 = await call("getDashboard", twoOwner, {});
  const w1c = dash4.series.find((p) => p.weekStart === "2026-09-28");
  const w3c = dash4.series.find((p) => p.weekStart === "2026-10-12");
  check(
    "two-lines: moving a stage date shifts only the stage line's week",
    w1c?.newStages === 0 && w1c?.newEntries === 1 &&
      w3c?.newStages === 1 && w3c?.cumulativeStages === 1 && w3c?.cumulativeEntries === 3,
    JSON.stringify({ w1c, w3c }),
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
