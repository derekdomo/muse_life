// CMP-LEARN-ACL-001 validation — strict owner gate on all 8 actions.
//
// Two layers:
//  1. Source wiring: in server/src/actions.ts, every action handler's
//     first statement-level step is the isOwner gate, positioned BEFORE
//     any ctx.db access and before ensureSeeded; the gate is exactly
//     `ctx.viewer?.isOwner === true` (no anonymous / sync-channel /
//     no-viewer exception anywhere in the file).
//  2. Behavior: the REAL handlers from server/src/actions.ts run
//     against a throwaway in-memory libsql database (schema applied
//     from drizzle/*.sql) behind a synthetic ctx, for three caller
//     identities — owner (viewer.isOwner === true), identified
//     non-owner (isOwner === false), and anonymous (no viewer).
//     Refused calls must return the typed rejection, must never invoke
//     ctx.db (zero database access, counted), and must leave both
//     tables byte-identical (in particular: no seed rows are created
//     by a refused getDashboard). The owner path must round-trip:
//     every write reads back through getDashboard exactly as written.
//
// Synthetic data only; the real app.db is never opened (the handlers
// only ever see the ctx this script hands them).
// Run with: bun validate-acl.mjs
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
  "addSkill",
  "updateSkill",
  "deleteSkill",
  "recordLearningInput",
  "markConverted",
  "unmarkConverted",
  "deleteInput",
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
  const seedIdx = slice.indexOf("ensureSeeded(ctx)");
  check(`source: ${name} is gated`, gateIdx > -1);
  check(
    `source: ${name} gate precedes any ctx.db access`,
    gateIdx > -1 && (dbIdx === -1 || gateIdx < dbIdx),
  );
  if (seedIdx > -1) {
    check(`source: ${name} gate precedes ensureSeeded`, gateIdx > -1 && gateIdx < seedIdx);
  }
}

/* ---------------- 2. behavior against real handlers ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");

const client = createClient({ url: ":memory:" });
const migrationDir = new URL("./drizzle/", import.meta.url);
for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = readFileSync(new URL(file, migrationDir), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) await client.execute(trimmed);
  }
}
const db = drizzle(client, { schema });

// Identity contexts. dbCalls counts ctx.db() invocations: a refused
// handler must never reach for the database at all.
function makeCtx(viewer) {
  const state = { dbCalls: 0 };
  const ctx = {
    slug: "space-10-validate",
    invocationId: "validate-acl",
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
  // Every response must satisfy the action's declared response schema.
  action.response.parse(res);
  return res;
}

async function tableCounts() {
  const s = await db.select({ id: schema.skills.id }).from(schema.skills);
  const i = await db.select({ id: schema.learningInputs.id }).from(schema.learningInputs);
  return { skills: s.length, inputs: i.length };
}

/* ----- refused identities on an empty database (no seeding!) ----- */

for (const [label, viewer] of [["non-owner", NON_OWNER], ["anonymous", ANON]]) {
  const { ctx, state } = makeCtx(viewer);

  const dash = await call("getDashboard", ctx, {});
  check(
    `${label}: getDashboard refused with empty data`,
    dash.forbidden === true &&
      dash.skills.length === 0 &&
      dash.inputs.length === 0 &&
      dash.series.length === 0 &&
      dash.totals.totalInputs === 0 &&
      dash.totals.totalMinutes === 0,
  );

  const add = await call("addSkill", ctx, { name: "不应存在的技能" });
  check(`${label}: addSkill refused (ok:false, no id)`, add.ok === false && add.forbidden === true && add.id === null);

  const upd = await call("updateSkill", ctx, { id: 1, name: "改名" });
  check(`${label}: updateSkill refused`, upd.ok === false && upd.forbidden === true);

  const delSkill = await call("deleteSkill", ctx, { id: 1 });
  check(`${label}: deleteSkill refused`, delSkill.ok === false && delSkill.forbidden === true);

  const rec = await call("recordLearningInput", ctx, {
    sourceType: "research",
    topic: "不应被记入的输入",
    skillName: "不应被自动创建的技能",
    minutes: 15,
  });
  check(
    `${label}: recordLearningInput refused honestly (no row, no auto-created skill)`,
    rec.ok === false && rec.forbidden === true && rec.id === null,
  );

  const mark = await call("markConverted", ctx, { id: 1, outputType: "note" });
  check(`${label}: markConverted refused`, mark.ok === false && mark.forbidden === true);

  const unmark = await call("unmarkConverted", ctx, { id: 1 });
  check(`${label}: unmarkConverted refused`, unmark.ok === false && unmark.forbidden === true);

  const delInput = await call("deleteInput", ctx, { id: 1 });
  check(`${label}: deleteInput refused`, delInput.ok === false && delInput.forbidden === true);

  check(`${label}: zero database access across all 8 actions`, state.dbCalls === 0, `dbCalls=${state.dbCalls}`);
  const counts = await tableCounts();
  check(
    `${label}: zero writes — no seed rows, no skills, no inputs`,
    counts.skills === 0 && counts.inputs === 0,
    JSON.stringify(counts),
  );
}

/* ----- owner happy path: writes read back consistently ----- */

{
  const { ctx } = makeCtx(OWNER);

  const dash0 = await call("getDashboard", ctx, {});
  check(
    "owner: first getDashboard seeds exactly the two preset skills",
    dash0.forbidden === false && dash0.skills.length === 2 && dash0.inputs.length === 0,
    `skills=${dash0.skills.map((s) => s.name).join("/")}`,
  );
  const dash0b = await call("getDashboard", ctx, {});
  check("owner: seeding is idempotent (second read still 2 skills)", dash0b.skills.length === 2);

  const added = await call("addSkill", ctx, { name: "验证技能", note: "合成数据" });
  check("owner: addSkill ok with id", added.ok === true && added.forbidden === false && typeof added.id === "number");
  const skillId = added.id;

  const renamed = await call("updateSkill", ctx, { id: skillId, name: "验证技能·改", note: null });
  check("owner: updateSkill ok", renamed.ok === true && renamed.forbidden === false);
  const dash1 = await call("getDashboard", ctx, {});
  const renamedRow = dash1.skills.find((s) => s.id === skillId);
  check("owner: rename reads back", renamedRow?.name === "验证技能·改" && dash1.skills.length === 3);

  const rec = await call("recordLearningInput", ctx, {
    date: "2026-10-19",
    sourceType: "article",
    topic: "验证输入一",
    skillId,
    minutes: 45,
  });
  check("owner: recordLearningInput ok with id", rec.ok === true && rec.forbidden === false && typeof rec.id === "number");
  const inputId = rec.id;

  const rec2 = await call("recordLearningInput", ctx, {
    date: "2026-10-20",
    sourceType: "practice",
    topic: "验证输入二",
    skillName: "自动建技能",
    minutes: 20,
    converted: true,
    outputType: "experiment",
    outputNote: "合成产出",
  });
  check("owner: recordLearningInput with new skillName ok", rec2.ok === true && typeof rec2.id === "number");

  const dash2 = await call("getDashboard", ctx, {});
  const row1 = dash2.inputs.find((r) => r.id === inputId);
  const row2 = dash2.inputs.find((r) => r.id === rec2.id);
  check(
    "owner: inputs read back as written",
    row1?.topic === "验证输入一" && row1?.skillId === skillId && row1?.minutes === 45 && row1?.converted === false &&
      row2?.topic === "验证输入二" && row2?.skillName === "自动建技能" && row2?.converted === true && row2?.outputType === "experiment",
  );
  check(
    "owner: dashboard aggregates match the writes",
    dash2.totals.totalInputs === 2 && dash2.totals.totalConverted === 1 && dash2.totals.totalMinutes === 65 &&
      dash2.skills.find((s) => s.id === skillId)?.inputCount === 1,
    JSON.stringify(dash2.totals),
  );
  const autoSkillId = row2?.skillId ?? null;
  check("owner: skillName auto-created exactly one skill", autoSkillId !== null && dash2.skills.length === 4);

  const mark = await call("markConverted", ctx, { id: inputId, outputType: "note", outputNote: "合成笔记" });
  check("owner: markConverted ok", mark.ok === true && mark.forbidden === false);
  const dash3 = await call("getDashboard", ctx, {});
  check(
    "owner: conversion reads back",
    dash3.inputs.find((r) => r.id === inputId)?.converted === true && dash3.totals.totalConverted === 2,
  );

  const unmark = await call("unmarkConverted", ctx, { id: inputId });
  check("owner: unmarkConverted ok", unmark.ok === true && unmark.forbidden === false);
  const dash4 = await call("getDashboard", ctx, {});
  check(
    "owner: un-conversion reads back",
    dash4.inputs.find((r) => r.id === inputId)?.converted === false && dash4.totals.totalConverted === 1,
  );

  const delInput = await call("deleteInput", ctx, { id: inputId });
  check("owner: deleteInput ok", delInput.ok === true && delInput.forbidden === false);
  const dash5 = await call("getDashboard", ctx, {});
  check(
    "owner: deleted input is gone, the other survives",
    !dash5.inputs.some((r) => r.id === inputId) && dash5.inputs.length === 1 && dash5.totals.totalInputs === 1,
  );

  const delSkill = await call("deleteSkill", ctx, { id: autoSkillId });
  check("owner: deleteSkill ok", delSkill.ok === true && delSkill.forbidden === false);
  const dash6 = await call("getDashboard", ctx, {});
  const orphan = dash6.inputs.find((r) => r.id === rec2.id);
  check(
    "owner: skill deleted; its ledger row survives unlinked",
    !dash6.skills.some((s) => s.id === autoSkillId) && orphan?.skillId === null && orphan?.topic === "验证输入二",
  );
}

/* ----- refused identities against a populated database (no leak, no damage) ----- */

for (const [label, viewer] of [["non-owner", NON_OWNER], ["anonymous", ANON]]) {
  const { ctx, state } = makeCtx(viewer);
  const before = await tableCounts();

  const dash = await call("getDashboard", ctx, {});
  check(
    `${label}: populated DB still returns forbidden + zero data (no leak)`,
    dash.forbidden === true && dash.skills.length === 0 && dash.inputs.length === 0 && dash.totals.totalInputs === 0,
  );
  const rec = await call("recordLearningInput", ctx, { sourceType: "video", topic: "越权写入", minutes: 5 });
  check(`${label}: populated DB record refused`, rec.ok === false && rec.id === null);
  const delInput = await call("deleteInput", ctx, { id: 1 });
  const delSkill = await call("deleteSkill", ctx, { id: 1 });
  check(
    `${label}: populated DB deletes refused`,
    delInput.ok === false && delSkill.ok === false && delInput.forbidden === true && delSkill.forbidden === true,
  );
  check(`${label}: populated DB — zero database access`, state.dbCalls === 0, `dbCalls=${state.dbCalls}`);
  const after = await tableCounts();
  check(
    `${label}: populated DB unchanged by refused calls`,
    after.skills === before.skills && after.inputs === before.inputs,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
}

// Owner data survived the refused storm intact.
{
  const { ctx } = makeCtx(OWNER);
  const dash = await call("getDashboard", ctx, {});
  check(
    "owner: data intact after refused calls from other identities",
    dash.forbidden === false && dash.skills.length === 3 && dash.inputs.length === 1 &&
      dash.inputs[0]?.topic === "验证输入二",
    `skills=${dash.skills.length} inputs=${dash.inputs.length}`,
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
