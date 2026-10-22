// CMP-FAMILY-001 validation — 陪伴复利 ledger integrity:
// strict owner gate, request-key idempotency, delete correction,
// unknown-duration accounting, backfill semantics, and reconciliation
// of the weekly series / calendar against the raw record set.
//
// Two layers:
//  1. Source wiring: every action's strict isOwner gate precedes any
//     ctx.db access; addActivity's fresh save and deleteActivity are
//     single db.batch writes over the request-key ledger and the
//     activities table, with a UNIQUE index on request_key and the
//     migration-0004 deleted-key insert trigger as storage backstops;
//     the client carries the honesty copy （没有记录不等于没陪伴 /
//     空账本空态 / 重复提交不重计） and the submitted-snapshot draft
//     protection in the record form.
//  2. Behavior: the REAL handlers from server/src/actions.ts run
//     against throwaway in-memory libsql databases (schema applied
//     from drizzle/*.sql) behind synthetic owner / non-owner /
//     anonymous contexts.
//
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-family-ledger.mjs
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
const decisionSrc = readFileSync(new URL("./client/src/saveOutcome.ts", import.meta.url), "utf8");
const clientAll = `${clientSrc}\n${decisionSrc}`;
const migrationSql = readdirSync(new URL("./drizzle/", import.meta.url))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(`./drizzle/${f}`, import.meta.url), "utf8"))
  .join("\n");

check(
  "source: isOwner is exactly ctx.viewer?.isOwner === true",
  serverSrc.includes("return ctx.viewer?.isOwner === true;"),
);
check(
  "source: no anonymous/no-viewer exception helper exists",
  !/viewer\s*===\s*(undefined|null)/.test(serverSrc) && !serverSrc.includes("isOwnerOr"),
);

const ACTION_NAMES = ["getDashboard", "addActivity", "recordFamilyActivityFromChat", "deleteActivity", "addType", "deleteType"];
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
  // CMP-FAMILY-AUTOLOG-001: the arbitration pipeline moved out of
  // addActivity into the shared saveActivityRecord, which BOTH write
  // paths delegate to — the wiring checks below target that shared
  // pipeline (same invariants: one atomic batch, conflict no-ops,
  // one adjudication), plus the two thin entry points themselves.
  const pipeStart = serverSrc.indexOf("async function saveActivityRecord");
  const pipeEnd = serverSrc.indexOf("/* ---------------- actions", pipeStart);
  const pipe = pipeStart >= 0 && pipeEnd > pipeStart ? serverSrc.slice(pipeStart, pipeEnd) : "";
  check(
    "source: the shared save pipeline's fresh save is one db.batch of builder statements (ledger claim + activity insert)",
    pipe.includes("db.batch") &&
      pipe.includes("insert(schema.familyRequestKeys)") &&
      pipe.includes("insert(schema.familyActivities)"),
  );
  check(
    "source: pipeline claim, activity insert and legacy backfill all use onConflictDoNothing",
    (pipe.match(/onConflictDoNothing/g) ?? []).length >= 3,
  );
  check(
    "source: the shared adjudication reports the existing row on duplicate",
    serverSrc.includes("async function adjudicateSave") && pipe.includes("adjudicateSave(db, input.requestKey, content"),
  );
  check(
    "source: request_key carries a UNIQUE index in the migration",
    migrationSql.includes("CREATE UNIQUE INDEX") && migrationSql.includes("request_key"),
  );
  check(
    "source: unknown minutes stay NULL (no 0-fill anywhere in the save pipeline)",
    !/minutes\s*\?\?/.test(pipe) && !pipe.includes("|| 0"),
  );
}
check(
  "client: calendar states plainly that no record does not mean no companionship",
  clientSrc.includes("不等于没有陪伴"),
);
check(
  "client: empty ledger has an honest empty state",
  clientSrc.includes("账本还是空的。记下第一条家庭活动，积累从这里开始。"),
);
check(
  "client: chart legend names the cumulative line with markers and total",
  clientSrc.includes("累计家庭活动（实线 · 圆点）共") && clientSrc.includes("没有记录的周曲线走平，不补数据"),
);
check(
  "client: duplicate save is surfaced as not double-counted",
  clientAll.includes("重复提交没有重复计数"),
);
check(
  "client: no score / streak / ranking language anywhere",
  !/连续(天数|打卡)|断签|排名|得分|评分/.test(clientSrc.replace("不打分、不排名、不算连续", "")),
);

/* ---- CMP-FAMILY-SAVE-001 / INIT-001 / DATE-001 source wiring ---- */
check(
  "source(save): migration creates the persistent family_request_keys ledger",
  migrationSql.includes("CREATE TABLE family_request_keys") &&
    migrationSql.includes("request_key TEXT PRIMARY KEY") &&
    migrationSql.includes("payload TEXT NOT NULL"),
);
{
  const add = actionSlice(serverSrc, "addActivity");
  const adjudStart = serverSrc.indexOf("async function adjudicateSave");
  const adjud = adjudStart >= 0 ? serverSrc.slice(adjudStart, serverSrc.indexOf("/* ---------------- actions", adjudStart)) : "";
  const pipeStart = serverSrc.indexOf("async function saveActivityRecord");
  const pipeEnd = serverSrc.indexOf("/* ---------------- actions", pipeStart);
  const pipe = pipeStart >= 0 && pipeEnd > pipeStart ? serverSrc.slice(pipeStart, pipeEnd) : "";
  check(
    "source(save): the shared pipeline adjudicates via the request-key ledger and can refuse as conflict/deleted",
    pipe.includes("familyRequestKeys") && pipe.includes("adjudicateSave") &&
      adjud.includes("familyRequestKeys") && adjud.includes("conflict: true") && adjud.includes("deleted: true"),
  );
  check(
    "source(date): addActivity refuses future dates with a typed future result",
    add.includes("future: true") && add.includes("todayKey()"),
  );
  const del = actionSlice(serverSrc, "deleteActivity");
  check(
    "source(save): deleteActivity is one db.batch (ledger tombstone upsert to 'deleted' + activity delete)",
    del.includes("db.batch") &&
      del.includes("insert(schema.familyRequestKeys)") &&
      del.includes("onConflictDoUpdate") &&
      del.includes('state: "deleted"'),
  );
  check(
    "source(save): migration 0004 adds the BEFORE INSERT deleted-key guard trigger on family_activities",
    migrationSql.includes("CREATE TRIGGER") &&
      migrationSql.includes("BEFORE INSERT ON family_activities") &&
      migrationSql.includes("state = 'deleted'") &&
      migrationSql.includes("RAISE(ABORT, 'request key deleted')"),
  );
  const dash = actionSlice(serverSrc, "getDashboard");
  {
    // CMP-FAMILY-INIT-001 (final fix round): the completion marker and
    // the seeds still share ONE atomic boundary — a single db.batch
    // containing BOTH the ledgerMeta claim insert and the preset type
    // inserts, gated by a prior meta read, with no separate claim
    // commit and no delete-the-claim rollback path. The seeds are now
    // guarded raw INSERT … SELECT statements whose WHERE EXISTS tests
    // the claim row for THIS attempt's token, so the batch segment
    // asserts the claim builder, the guarded seed SQL, and the token.
    const batchIdx = dash.indexOf("db.batch([");
    const batchEnd = batchIdx >= 0 ? dash.indexOf("]);", batchIdx) : -1;
    const batchSegment = batchIdx >= 0 && batchEnd > batchIdx ? dash.slice(batchIdx, batchEnd) : "";
    const seedBatchCount = (dash.match(/db\.batch\(/g) ?? []).length;
    check(
      "source(init): preset seeding is ONE db.batch containing both the ledgerMeta claim and the preset type inserts",
      batchSegment.includes("claimInsert") &&
        batchSegment.includes("presetInserts") &&
        dash.includes("insert(schema.ledgerMeta)") &&
        dash.includes("INSERT INTO activity_types") &&
        seedBatchCount === 1,
    );
    check(
      "source(init): every seed insert is gated on the real claim outcome (WHERE EXISTS on the claim row holding this attempt's seedToken)",
      dash.includes("seedToken") &&
        dash.includes("WHERE EXISTS") &&
        dash.includes("value = ${seedToken}") &&
        dash.includes("key = 'types_seeded'"),
    );
    check(
      "source(init): claim and every preset insert carry a conflict no-op (>= 2 across builder + SQL spellings), so a concurrent loser no-ops",
      (dash.match(/onConflictDoNothing/g) ?? []).length +
        (dash.match(/ON CONFLICT DO NOTHING/g) ?? []).length >= 2,
    );
    check(
      "source(init): seeding is gated by a prior ledgerMeta read and never deletes the claim (no two-step claim/rollback path)",
      dash.indexOf("from(schema.ledgerMeta)") > -1 &&
        dash.indexOf("from(schema.ledgerMeta)") < batchIdx &&
        !dash.includes("delete(schema.ledgerMeta)") &&
        !dash.includes(".returning()"),
    );
    check(
      "source(init): uniqueness is scoped to preset identity — the only UNIQUE index on activity_types is on preset_key, and no global UNIQUE index on name exists in any migration",
      migrationSql.includes("CREATE UNIQUE INDEX activity_types_preset_key_idx ON activity_types (preset_key)") &&
        !migrationSql.includes("CREATE UNIQUE INDEX activity_types_name_idx") &&
        !/CREATE UNIQUE INDEX[^;]*ON activity_types \(name\)/.test(migrationSql),
    );
  }
  check(
    "source(date): dashboard counts future-dated rows separately (futureRecordCount)",
    dash.includes("futureRecordCount") && serverSrc.includes("futureRecordCount: z.number()"),
  );
  const addT = actionSlice(serverSrc, "addType");
  check(
    "source(init): addType is one conditional INSERT … WHERE NOT EXISTS on the exact name",
    addT.includes("INSERT INTO activity_types") && addT.includes("NOT EXISTS") && addT.includes("activity_types WHERE name"),
  );
}
/* ---- CMP-FAMILY-AUTOLOG-001 source wiring ---- */
check(
  "source(autolog): migration 0007 adds the source column additively, with NO backfill of existing rows",
  migrationSql.includes("ALTER TABLE family_activities ADD COLUMN source TEXT") &&
    !/UPDATE\s+family_activities\s+SET\s+source/i.test(migrationSql),
);
{
  const add = actionSlice(serverSrc, "addActivity");
  const chat = actionSlice(serverSrc, "recordFamilyActivityFromChat");
  const addReq = add.slice(add.indexOf("request: z.object({"), add.indexOf("}),", add.indexOf("request: z.object({")));
  const chatReq = chat.slice(chat.indexOf("request: z.object({"), chat.indexOf("}),", chat.indexOf("request: z.object({")));
  check(
    "source(autolog): neither write path's request schema carries a source field (provenance is server-decided)",
    !addReq.includes("source") && !chatReq.includes("source"),
  );
  check(
    "source(autolog): manual path stamps SOURCE_MANUAL, chat path stamps SOURCE_CHAT, both via the one shared pipeline",
    add.includes("saveActivityRecord(ctx, args, schema.SOURCE_MANUAL)") &&
      chat.includes("saveActivityRecord(ctx, args, schema.SOURCE_CHAT)"),
  );
  check(
    "source(autolog): the canonical fingerprint includes the source, and adjudication compares it (payloadMatches)",
    serverSrc.includes("source: schema.ActivitySource") &&
      serverSrc.includes("function payloadMatches") &&
      serverSrc.includes('if ("source" in p) return p.source === incoming.source;'),
  );
  check(
    "source(autolog): the chat receipt schema carries the locatable fields (id, date, typeName, minutes, source)",
    serverSrc.includes("const chatRecordResponse = z.object({") &&
      serverSrc.includes('source: z.enum(["手动", "聊天记录"]).nullable()'),
  );
}
check(
  "client(autolog): every recent row shows a text source label （手动 / 聊天记录 / 旧来源未记录）",
  clientSrc.includes("来源：") && clientSrc.includes("旧来源未记录") && clientSrc.includes("row.source"),
);
check(
  "client(autolog): the empty ledger hints at chat auto-record WITHOUT claiming the channel is verified",
  clientSrc.includes("也可以在聊天里告诉 Muse，由 Muse 代记（来源会标为聊天记录）") &&
    !/已验证|已开通|已可用/.test(clientSrc),
);

check(
  "client(save): conflict keeps the draft and offers an explicit save-as-new action",
  clientSrc.includes("作为新的一条保存") && clientAll.includes("conflict"),
);
check(
  "client(save): deleted retry is reported as deleted, not re-added",
  clientAll.includes("这条记录已删除，未重新添加。"),
);
check(
  "client(save): deleted with a changed draft says plainly the new content is not saved yet",
  clientAll.includes("原记录已删除，未重新添加；你修改的新内容尚未保存"),
);
check(
  "client(save): the form routes every outcome through the shared snapshot-guarded decision (decideSaveOutcome + submittedSnapshot)",
  clientSrc.includes("decideSaveOutcome") &&
    clientSrc.includes("outcomeKindOfResult") &&
    clientSrc.includes("applySaveDecision") &&
    decisionSrc.includes("draftMatchesSnapshot") &&
    decisionSrc.includes('case "deleted"'),
);
check(
  "client(date): future save shows the draft-preserving message and the date input is capped at today",
  clientAll.includes("日期在今天之后，还没发生的事不能记为已完成；填写内容已保留。") && clientSrc.includes("max={data.today}"),
);
check(
  "client(date): future-dated records get a plain not-counted note",
  clientSrc.includes("条记录日期在今天之后，未计入累计"),
);
check(
  "client(date): the future-record note says the records count automatically once their date arrives (no re-recording)",
  clientSrc.includes("会在日期到达后自动计入累计，无需重新记录"),
);
check(
  "client(save): the success handler compares the live draft against the submittedSnapshot before clearing fields",
  clientSrc.includes("submittedSnapshot") && clientSrc.includes("draftMatchesSnapshot"),
);

/* ---------------- 2. behavior against real handlers ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");

async function makeDb() {
  const client = createClient({ url: ":memory:" });
  const migrationDir = new URL("./drizzle/", import.meta.url);
  const names = readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of names) {
    const sqlText = readFileSync(new URL(file, migrationDir), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
  return { client, db: drizzle(client, { schema }) };
}

// Apply only a chosen subset of migrations (by filename prefix), for
// legacy-database upgrade tests: build the old database first, then
// run the remaining migrations over it.
async function applyMigrations(client, prefixes) {
  const migrationDir = new URL("./drizzle/", import.meta.url);
  const names = readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => prefixes.some((p) => f.startsWith(p)));
  for (const file of names) {
    const sqlText = readFileSync(new URL(file, migrationDir), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
}
async function makeLegacyDb() {
  const client = createClient({ url: ":memory:" });
  await applyMigrations(client, ["0001", "0002", "0003", "0004"]);
  return { client, db: drizzle(client, { schema }) };
}
// A database current through 0006 — i.e. production-shaped BEFORE
// the source column existed (CMP-FAMILY-AUTOLOG-001 upgrade tests).
async function makePreSourceDb() {
  const client = createClient({ url: ":memory:" });
  await applyMigrations(client, ["0001", "0002", "0003", "0004", "0005", "0006"]);
  return { client, db: drizzle(client, { schema }) };
}

function makeCtx(db, viewer) {
  const state = { dbCalls: 0 };
  const ctx = {
    slug: "space-13-validate",
    invocationId: "validate-family-ledger",
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

/* date helpers (mirror server semantics, America/Los_Angeles) */
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
const TODAY = todayKey();

/* ---- empty ledger: honest empty state + one-time preset seeding ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const dash = await call("getDashboard", ctx, {});
  check("empty: dashboard is not forbidden for the owner", dash.forbidden === false);
  check("empty: totalCount is 0", dash.totalCount === 0);
  check("empty: known minutes 0 and unknown count 0", dash.totalKnownMinutes === 0 && dash.unknownMinutesCount === 0);
  check("empty: thisMonthCount 0 and lastActivityDate null", dash.thisMonthCount === 0 && dash.lastActivityDate === null);
  check("empty: series and calendar are empty (nothing invented)", dash.series.length === 0 && dash.calendar.length === 0);
  check("empty: recentActivities is empty", dash.recentActivities.length === 0);
  check(
    "empty: preset types materialize exactly once (7 presets)",
    dash.types.length === 7 &&
      dash.types.map((t) => t.name).join(",") === "一起吃饭,陪玩,户外,阅读,运动,旅行,其他" &&
      dash.types.every((t) => t.isPreset),
  );
  const dash2 = await call("getDashboard", ctx, {});
  check("empty: second read does not duplicate presets", dash2.types.length === 7);
}

/* ---- owner gate matrix: refusal + zero leakage + zero writes ---- */
{
  const { db, client } = await makeDb();
  for (const [label, viewer] of [["non-owner", NON_OWNER], ["anonymous", ANON]]) {
    const { ctx, state } = makeCtx(db, viewer);
    const dash = await call("getDashboard", ctx, {});
    check(
      `gate: ${label} getDashboard is forbidden with zero data`,
      dash.forbidden === true &&
        dash.totalCount === 0 &&
        dash.futureRecordCount === 0 &&
        dash.types.length === 0 &&
        dash.series.length === 0 &&
        dash.calendar.length === 0 &&
        dash.recentActivities.length === 0 &&
        dash.lastActivityDate === null,
    );
    check(`gate: ${label} getDashboard never touches the db`, state.dbCalls === 0);
    const add = await call("addActivity", ctx, {
      date: TODAY, typeName: "陪玩", minutes: 30, note: null, requestKey: `gate-${label}-0001`,
    });
    check(
      `gate: ${label} addActivity refused`,
      add.ok === false && add.forbidden === true && add.id === null &&
        add.conflict === false && add.deleted === false && add.future === false,
    );
    const del = await call("deleteActivity", ctx, { id: 1 });
    check(`gate: ${label} deleteActivity refused`, del.ok === false && del.forbidden === true);
    const addT = await call("addType", ctx, { name: "越权类型" });
    check(`gate: ${label} addType refused`, addT.ok === false && addT.forbidden === true);
    const delT = await call("deleteType", ctx, { id: 1 });
    check(`gate: ${label} deleteType refused`, delT.ok === false && delT.forbidden === true);
    check(`gate: ${label} write attempts never touch the db`, state.dbCalls === 0);
  }
  const typeCount = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  const actCount = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  check(
    "gate: refused calls seeded no presets and wrote no rows",
    Number(typeCount.rows[0].c) === 0 && Number(actCount.rows[0].c) === 0,
  );
}

/* ---- idempotency: same request key never double-counts ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("getDashboard", ctx, {}); // seed presets
  const args = { date: TODAY, typeName: "陪玩", minutes: 40, note: "积木", requestKey: "idem-key-0000001" };
  const first = await call("addActivity", ctx, args);
  const retry = await call("addActivity", ctx, args);
  check("idem: first save ok, not duplicate", first.ok === true && first.duplicate === false && first.id !== null);
  check("idem: retry reports duplicate with the same id", retry.ok === true && retry.duplicate === true && retry.id === first.id);
  let dash = await call("getDashboard", ctx, {});
  check("idem: ledger holds exactly one record after retry", dash.totalCount === 1 && dash.totalKnownMinutes === 40);
  const [c1, c2] = await Promise.all([
    call("addActivity", ctx, { ...args, requestKey: "idem-key-concurrent" }),
    call("addActivity", ctx, { ...args, requestKey: "idem-key-concurrent" }),
  ]);
  check(
    "idem: concurrent same-key saves land exactly one row",
    c1.ok && c2.ok && c1.id === c2.id && (c1.duplicate !== c2.duplicate || c1.id === c2.id),
  );
  dash = await call("getDashboard", ctx, {});
  check("idem: total is 2 after the concurrent pair", dash.totalCount === 2);
}

/* ---- unknown duration: counts as activity, never as minutes ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("addActivity", ctx, { date: TODAY, typeName: "一起吃饭", minutes: null, note: null, requestKey: "unk-key-00000001" });
  await call("addActivity", ctx, { date: TODAY, typeName: "阅读", minutes: 25, note: null, requestKey: "unk-key-00000002" });
  const dash = await call("getDashboard", ctx, {});
  check("unknown: both records count as activities", dash.totalCount === 2);
  check("unknown: known-minutes total excludes the unknown one (25, not 25+0-as-known)", dash.totalKnownMinutes === 25);
  check("unknown: unknownMinutesCount is 1, labeled separately", dash.unknownMinutesCount === 1);
  check(
    "unknown: the unknown record itself stores minutes null",
    dash.recentActivities.find((r) => r.typeName === "一起吃饭")?.minutes === null,
  );
  let threw = false;
  try {
    Actions.addActivity.request.parse({ date: TODAY, typeName: "陪玩", minutes: 0, note: null, requestKey: "unk-key-00000003" });
  } catch {
    threw = true;
  }
  check("unknown: minutes 0 is rejected at the request boundary (never stored as unknown or as 0)", threw);
}

/* ---- invalid date: shaped-like-a-date is not a date ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const bad = await call("addActivity", ctx, { date: "2026-02-30", typeName: "陪玩", minutes: null, note: null, requestKey: "bad-date-0000001" });
  const dash = await call("getDashboard", ctx, {});
  check("date: 2026-02-30 is refused and writes nothing", bad.ok === false && dash.totalCount === 0);
}

/* ---- backfill: past dates count in totals, never in this month ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const past = shiftDay(TODAY, -60);
  await call("addActivity", ctx, { date: past, typeName: "户外", minutes: 90, note: null, requestKey: "backfill-00000001" });
  await call("addActivity", ctx, { date: TODAY, typeName: "陪玩", minutes: null, note: null, requestKey: "backfill-00000002" });
  const dash = await call("getDashboard", ctx, {});
  check("backfill: past record counts toward the total", dash.totalCount === 2);
  check("backfill: thisMonthCount counts only this month's record", dash.thisMonthCount === 1);
  check("backfill: lastActivityDate is the latest record date (today)", dash.lastActivityDate === TODAY);
  check(
    "backfill: series starts at the backfilled record's week",
    dash.series.length > 0 && dash.series[0].weekStart <= past,
  );
}

/* ---- series + calendar reconciliation against the record set ---- */
{
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const dates = [shiftDay(TODAY, -21), shiftDay(TODAY, -21), shiftDay(TODAY, -7), TODAY, TODAY, TODAY];
  for (let i = 0; i < dates.length; i++) {
    await call("addActivity", ctx, {
      date: dates[i], typeName: "陪玩", minutes: i % 2 === 0 ? 30 : null, note: null,
      requestKey: `recon-key-00000${i}`,
    });
  }
  const dash = await call("getDashboard", ctx, {});
  const raw = await client.execute("SELECT date FROM family_activities");
  const rawDates = raw.rows.map((r) => String(r.date)).sort();
  check("recon: totalCount equals the raw row count", dash.totalCount === rawDates.length);
  const seriesSum = dash.series.reduce((s, p) => s + p.newCount, 0);
  check("recon: sum of weekly newCount equals totalCount", seriesSum === dash.totalCount);
  check(
    "recon: final cumulative equals totalCount and cumulative never decreases",
    dash.series[dash.series.length - 1]?.cumulative === dash.totalCount &&
      dash.series.every((p, i) => i === 0 || p.cumulative >= dash.series[i - 1].cumulative),
  );
  check(
    "recon: gap weeks are present with newCount 0 and a flat cumulative (walk-flat, never backfilled)",
    dash.series.some((p, i) => i > 0 && p.newCount === 0 && p.cumulative === dash.series[i - 1].cumulative),
  );
  check(
    "recon: week starts are Mondays, 7 days apart",
    dash.series.every((p) => new Date(`${p.weekStart}T00:00:00Z`).getUTCDay() === 1) &&
      dash.series.every((p, i) => i === 0 || shiftDay(dash.series[i - 1].weekStart, 7) === p.weekStart),
  );
  const calTotal = dash.calendar.reduce((s, m) => s + m.days.reduce((a, d) => a + d.count, 0), 0);
  check("recon: calendar day counts sum to totalCount", calTotal === dash.totalCount);
  const perDate = new Map();
  for (const d of rawDates) perDate.set(d, (perDate.get(d) ?? 0) + 1);
  const calMap = new Map();
  for (const m of dash.calendar) for (const d of m.days) calMap.set(d.date, d.count);
  check(
    "recon: every calendar count matches the record set, and unrecorded dates are absent",
    calMap.size === perDate.size && [...perDate.entries()].every(([d, c]) => calMap.get(d) === c),
  );
  const knownExpected = 30 * 3; // i even → 30 minutes, three of them
  check("recon: known minutes reconcile (3 × 30)", dash.totalKnownMinutes === knownExpected && dash.unknownMinutesCount === 3);
}

/* ---- delete: every number corrects itself ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const a = await call("addActivity", ctx, { date: TODAY, typeName: "运动", minutes: 50, note: null, requestKey: "del-key-000000001" });
  const b = await call("addActivity", ctx, { date: TODAY, typeName: "阅读", minutes: null, note: null, requestKey: "del-key-000000002" });
  let dash = await call("getDashboard", ctx, {});
  check("delete: baseline totals", dash.totalCount === 2 && dash.totalKnownMinutes === 50 && dash.unknownMinutesCount === 1);
  const del = await call("deleteActivity", ctx, { id: a.id });
  check("delete: delete reports ok", del.ok === true && del.forbidden === false);
  dash = await call("getDashboard", ctx, {});
  check(
    "delete: totals, minutes, series and calendar all correct after delete",
    dash.totalCount === 1 &&
      dash.totalKnownMinutes === 0 &&
      dash.unknownMinutesCount === 1 &&
      dash.series[dash.series.length - 1]?.cumulative === 1 &&
      dash.calendar.reduce((s, m) => s + m.days.reduce((x, d) => x + d.count, 0), 0) === 1 &&
      dash.lastActivityDate === TODAY,
  );
  const again = await call("deleteActivity", ctx, { id: a.id });
  check("delete: deleting the same id again reports ok:false (nothing left to delete)", again.ok === false);
  const delB = await call("deleteActivity", ctx, { id: b.id });
  dash = await call("getDashboard", ctx, {});
  check(
    "delete: removing the last record returns the ledger to the honest empty state",
    delB.ok === true && dash.totalCount === 0 && dash.series.length === 0 && dash.calendar.length === 0 && dash.lastActivityDate === null,
  );
}

/* ---- types: owner-managed, records keep their snapshot ---- */
{
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("getDashboard", ctx, {}); // seed presets
  const added = await call("addType", ctx, { name: "拼图" });
  check("types: addType ok", added.ok === true && added.duplicate === false && added.id !== null);
  const dup = await call("addType", ctx, { name: "拼图" });
  check("types: re-adding the same name reports duplicate, same id", dup.ok === true && dup.duplicate === true && dup.id === added.id);
  await call("addActivity", ctx, { date: TODAY, typeName: "拼图", minutes: 15, note: null, requestKey: "type-key-00000001" });
  const del = await call("deleteType", ctx, { id: added.id });
  let dash = await call("getDashboard", ctx, {});
  check(
    "types: deleted type leaves the list but the record keeps its type name",
    del.ok === true &&
      !dash.types.some((t) => t.name === "拼图") &&
      dash.recentActivities.some((r) => r.typeName === "拼图") &&
      dash.totalCount === 1,
  );
  for (const t of [...dash.types]) {
    await call("deleteType", ctx, { id: t.id });
  }
  dash = await call("getDashboard", ctx, {});
  check("types: deleting every type stays deleted (presets do not resurrect)", dash.types.length === 0);
  const readd = await call("addType", ctx, { name: "一起吃饭" });
  dash = await call("getDashboard", ctx, {});
  check("types: owner can re-add a type by hand afterwards", readd.ok === true && dash.types.length === 1);
}

/* ---- SAVE-001: request-key lifecycle survives deletion, detects edits ---- */
const TOMORROW = shiftDay(TODAY, 1);
{
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("getDashboard", ctx, {}); // seed presets
  const base = { date: TODAY, typeName: "陪玩", minutes: 30, note: "公园", requestKey: "save-key-00000001" };
  const first = await call("addActivity", ctx, base);
  check(
    "save: first save ok, all new flags false",
    first.ok === true && first.duplicate === false && first.conflict === false && first.deleted === false && first.future === false,
  );
  const retry = await call("addActivity", ctx, base);
  check(
    "save: same-key same-payload retry returns the original as duplicate",
    retry.ok === true && retry.duplicate === true && retry.id === first.id && retry.conflict === false,
  );
  // Response-lost-then-edit: the first save landed, the owner edited
  // the draft and resubmitted under the same key.
  const conflictMin = await call("addActivity", ctx, { ...base, minutes: 45 });
  check(
    "save: same-key different minutes is a typed conflict",
    conflictMin.ok === false && conflictMin.conflict === true && conflictMin.id === null && conflictMin.duplicate === false,
  );
  const conflictNote = await call("addActivity", ctx, { ...base, note: "改了备注" });
  check("save: same-key different note is a typed conflict", conflictNote.ok === false && conflictNote.conflict === true);
  let dash = await call("getDashboard", ctx, {});
  const stored = dash.recentActivities.find((r) => r.id === first.id);
  const rawCount = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  check(
    "save: conflicts wrote nothing and the original row is intact",
    dash.totalCount === 1 && dash.totalKnownMinutes === 30 &&
      stored?.minutes === 30 && stored?.note === "公园" && Number(rawCount.rows[0].c) === 1,
  );
  const retryAfter = await call("addActivity", ctx, base);
  check(
    "save: after conflicts, a same-payload retry still returns the original duplicate",
    retryAfter.ok === true && retryAfter.duplicate === true && retryAfter.id === first.id,
  );
  const del = await call("deleteActivity", ctx, { id: first.id });
  const late = await call("addActivity", ctx, base);
  check(
    "save: delete ok; late retry with the original key is typed deleted",
    del.ok === true && late.ok === false && late.deleted === true && late.conflict === false && late.id === null,
  );
  dash = await call("getDashboard", ctx, {});
  const rawAfter = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  check(
    "save: the late retry resurrects nothing — totals stay 0, no new row",
    dash.totalCount === 0 && dash.totalKnownMinutes === 0 && Number(rawAfter.rows[0].c) === 0,
  );
  const ledgerRow = await client.execute({
    sql: "SELECT state FROM family_request_keys WHERE request_key = ?",
    args: ["save-key-00000001"],
  });
  check(
    "save: the ledger row survives deletion in state 'deleted'",
    ledgerRow.rows.length === 1 && ledgerRow.rows[0].state === "deleted",
  );
}
{
  // Delete-then-save interleave: a brand-new key saves fine after a
  // delete, while the deleted key stays dead.
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const a = await call("addActivity", ctx, { date: TODAY, typeName: "阅读", minutes: 20, note: null, requestKey: "interleave-key-001" });
  await call("deleteActivity", ctx, { id: a.id });
  const b = await call("addActivity", ctx, { date: TODAY, typeName: "阅读", minutes: 20, note: null, requestKey: "interleave-key-002" });
  const lateA = await call("addActivity", ctx, { date: TODAY, typeName: "阅读", minutes: 20, note: null, requestKey: "interleave-key-001" });
  const dash = await call("getDashboard", ctx, {});
  check(
    "save: delete-then-save interleave — new key saves, old key stays deleted, one record total",
    b.ok === true && b.duplicate === false && lateA.ok === false && lateA.deleted === true && dash.totalCount === 1,
  );
}
{
  // Legacy pre-ledger row: activity exists with a request key but no
  // ledger entry. A retry backfills the ledger and compares payloads.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const ins = await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    args: [TODAY, "户外", 60, "骑行", "legacy-key-000001", Date.now()],
  });
  const legacyId = Number(ins.rows[0].id);
  const retry = await call("addActivity", ctx, { date: TODAY, typeName: "户外", minutes: 60, note: "骑行", requestKey: "legacy-key-000001" });
  check(
    "save: legacy row retry returns duplicate with the legacy id (no conflict)",
    retry.ok === true && retry.duplicate === true && retry.id === legacyId && retry.conflict === false,
  );
  const ledgerRow = await client.execute({
    sql: "SELECT state, activity_id FROM family_request_keys WHERE request_key = ?",
    args: ["legacy-key-000001"],
  });
  check(
    "save: the legacy retry backfilled the ledger row as 'saved'",
    ledgerRow.rows.length === 1 && ledgerRow.rows[0].state === "saved" && Number(ledgerRow.rows[0].activity_id) === legacyId,
  );
  const edited = await call("addActivity", ctx, { date: TODAY, typeName: "户外", minutes: 61, note: "骑行", requestKey: "legacy-key-000001" });
  check("save: an edited retry against the backfilled legacy row conflicts", edited.ok === false && edited.conflict === true);
  const dash = await call("getDashboard", ctx, {});
  check("save: the legacy row is still the only record, unmodified", dash.totalCount === 1 && dash.totalKnownMinutes === 60);
}

/* ---- INIT-001: concurrent-safe seeding and type creation ---- */
{
  const { db, client } = await makeDb();
  const o1 = makeCtx(db, OWNER);
  const o2 = makeCtx(db, OWNER);
  const [d1, d2] = await Promise.all([
    call("getDashboard", o1.ctx, {}),
    call("getDashboard", o2.ctx, {}),
  ]);
  const typeCount = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  const metaCount = await client.execute("SELECT COUNT(*) AS c FROM ledger_meta WHERE key = 'types_seeded'");
  check("init: two concurrent first getDashboard calls both succeed", d1.forbidden === false && d2.forbidden === false);
  check(
    "init: concurrent seeding lands exactly 7 preset types and one meta row",
    Number(typeCount.rows[0].c) === 7 && Number(metaCount.rows[0].c) === 1 &&
      d1.types.length === 7 && d2.types.length === 7,
  );
  const [t1, t2] = await Promise.all([
    call("addType", o1.ctx, { name: "拼图" }),
    call("addType", o2.ctx, { name: "拼图" }),
  ]);
  const namedCount = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM activity_types WHERE name = ?",
    args: ["拼图"],
  });
  check(
    "init: concurrent addType with the same name → exactly one row, both ok, one duplicate",
    t1.ok === true && t2.ok === true && t1.id === t2.id &&
      t1.duplicate !== t2.duplicate && Number(namedCount.rows[0].c) === 1,
  );
  const dashAll = await call("getDashboard", o1.ctx, {});
  for (const t of [...dashAll.types]) {
    await call("deleteType", o1.ctx, { id: t.id });
  }
  const [d3, d4] = await Promise.all([
    call("getDashboard", o1.ctx, {}),
    call("getDashboard", o2.ctx, {}),
  ]);
  const typeCountAfter = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  check(
    "init: delete-all-types then two reads → no resurrection",
    d3.types.length === 0 && d4.types.length === 0 && Number(typeCountAfter.rows[0].c) === 0,
  );
}

/* ---- DATE-001: future dates are not completed facts ---- */
{
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const fut = await call("addActivity", ctx, { date: TOMORROW, typeName: "陪玩", minutes: 30, note: null, requestKey: "future-key-000001" });
  const rawActs = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  const rawKeys = await client.execute("SELECT COUNT(*) AS c FROM family_request_keys");
  check(
    "date: tomorrow (America/Los_Angeles) is refused as future with zero writes",
    fut.ok === false && fut.future === true && fut.conflict === false && fut.deleted === false &&
      Number(rawActs.rows[0].c) === 0 && Number(rawKeys.rows[0].c) === 0,
  );
  const okToday = await call("addActivity", ctx, { date: TODAY, typeName: "陪玩", minutes: 30, note: null, requestKey: "future-key-000002" });
  const okYday = await call("addActivity", ctx, { date: shiftDay(TODAY, -1), typeName: "阅读", minutes: null, note: null, requestKey: "future-key-000003" });
  const okLeap = await call("addActivity", ctx, { date: "2024-02-29", typeName: "户外", minutes: 45, note: null, requestKey: "future-key-000004" });
  let dash = await call("getDashboard", ctx, {});
  check(
    "date: today, yesterday and leap day 2024-02-29 are accepted",
    okToday.ok === true && okYday.ok === true && okLeap.ok === true &&
      dash.totalCount === 3 && dash.totalKnownMinutes === 75 && dash.unknownMinutesCount === 1 && dash.futureRecordCount === 0,
  );
  const badFeb = await call("addActivity", ctx, { date: "2026-02-30", typeName: "陪玩", minutes: null, note: null, requestKey: "future-key-000005" });
  check("date: Feb 30 is refused as invalid (not flagged future)", badFeb.ok === false && badFeb.future === false);
  const before = dash;
  // A pre-seeded future-dated legacy row: stored, but counts toward
  // nothing until its date arrives.
  await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [TOMORROW, "旅行", 120, null, "future-legacy-001", Date.now()],
  });
  dash = await call("getDashboard", ctx, {});
  check(
    "date: future legacy row excluded from totals, counted in futureRecordCount",
    dash.totalCount === before.totalCount && dash.totalKnownMinutes === before.totalKnownMinutes &&
      dash.unknownMinutesCount === before.unknownMinutesCount && dash.thisMonthCount === before.thisMonthCount &&
      dash.lastActivityDate === before.lastActivityDate && dash.futureRecordCount === 1,
  );
  check(
    "date: future legacy row excluded from the weekly series and the calendar",
    JSON.stringify(dash.series) === JSON.stringify(before.series) &&
      JSON.stringify(dash.calendar) === JSON.stringify(before.calendar),
  );
  check(
    "date: future legacy row is still listed in recentActivities so the owner can delete it",
    dash.recentActivities.some((r) => r.date === TOMORROW && r.typeName === "旅行"),
  );
}

/* ---- SAVE-001 atomicity: races and interleaves over the batch writes ---- */
{
  // Concurrent same key, DIFFERENT payloads: exactly one save wins,
  // the loser is a typed conflict, and exactly one activity row —
  // holding the winner's payload — exists afterwards.
  const { db, client } = await makeDb();
  const o1 = makeCtx(db, OWNER);
  const o2 = makeCtx(db, OWNER);
  const key = "race-diff-payload-01";
  const [r1, r2] = await Promise.all([
    call("addActivity", o1.ctx, { date: TODAY, typeName: "陪玩", minutes: 30, note: null, requestKey: key }),
    call("addActivity", o2.ctx, { date: TODAY, typeName: "陪玩", minutes: 45, note: null, requestKey: key }),
  ]);
  const winnerMinutes = r1.ok ? 30 : 45;
  const rows = await client.execute({
    sql: "SELECT minutes FROM family_activities WHERE request_key = ?",
    args: [key],
  });
  check(
    "race: concurrent same-key different-payload → exactly one ok and one typed conflict",
    [r1, r2].filter((r) => r.ok).length === 1 && [r1, r2].filter((r) => r.conflict).length === 1,
  );
  check(
    "race: exactly one activity row exists and it holds the winner's payload",
    rows.rows.length === 1 && Number(rows.rows[0].minutes) === winnerMinutes,
  );
}
{
  // Concurrent same key, SAME payload: both calls succeed with the
  // same id and exactly one activity row exists.
  const { db, client } = await makeDb();
  const o1 = makeCtx(db, OWNER);
  const o2 = makeCtx(db, OWNER);
  const args = { date: TODAY, typeName: "阅读", minutes: 20, note: "绘本", requestKey: "race-same-payload-01" };
  const [r1, r2] = await Promise.all([
    call("addActivity", o1.ctx, args),
    call("addActivity", o2.ctx, args),
  ]);
  const count = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  check(
    "race: concurrent same-key same-payload → both ok with the same id, exactly one row",
    r1.ok === true && r2.ok === true && r1.id !== null && r1.id === r2.id && Number(count.rows[0].c) === 1,
  );
}
{
  // Save → delete → same-key retry: typed deleted, zero activities,
  // and the tombstone + delete landed together (no half state).
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const args = { date: TODAY, typeName: "运动", minutes: 35, note: null, requestKey: "race-del-retry-0001" };
  const saved = await call("addActivity", ctx, args);
  const del = await call("deleteActivity", ctx, { id: saved.id });
  const retry = await call("addActivity", ctx, args);
  const acts = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  const led = await client.execute({
    sql: "SELECT state FROM family_request_keys WHERE request_key = ?",
    args: ["race-del-retry-0001"],
  });
  check(
    "race: save → delete → same-key retry is typed deleted with zero activities and a committed tombstone",
    del.ok === true && retry.ok === false && retry.deleted === true &&
      Number(acts.rows[0].c) === 0 && led.rows.length === 1 && led.rows[0].state === "deleted",
  );
}
{
  // A 'deleted' tombstone written directly (simulating a delete batch
  // that has already committed) blocks a later save of the same key:
  // the handler refuses typed-deleted, and at the storage level the
  // migration-0004 trigger aborts a direct activity insert outright.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const key = "tombstone-first-0001";
  const payload = JSON.stringify({ date: TODAY, typeName: "陪玩", minutes: 30, note: null });
  const nowTs = Date.now();
  await client.execute({
    sql: "INSERT INTO family_request_keys (request_key, payload, activity_id, state, created_at, updated_at) VALUES (?, ?, NULL, 'deleted', ?, ?)",
    args: [key, payload, nowTs, nowTs],
  });
  const res = await call("addActivity", ctx, { date: TODAY, typeName: "陪玩", minutes: 30, note: null, requestKey: key });
  let triggerBlocked = false;
  try {
    await client.execute({
      sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [TODAY, "陪玩", 30, null, key, Date.now()],
    });
  } catch {
    triggerBlocked = true;
  }
  const acts = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  check(
    "race: pre-written deleted tombstone → save refused as deleted, zero activities",
    res.ok === false && res.deleted === true && Number(acts.rows[0].c) === 0,
  );
  check(
    "race: migration 0004 trigger aborts a direct activity insert under a deleted key",
    triggerBlocked === true && Number(acts.rows[0].c) === 0,
  );
}
{
  // Legacy pre-ledger row under two concurrent same-key retries: the
  // ON CONFLICT DO NOTHING backfill means neither call throws, both
  // replay the legacy row as duplicates, and exactly one ledger row
  // exists afterwards.
  const { db, client } = await makeDb();
  const o1 = makeCtx(db, OWNER);
  const o2 = makeCtx(db, OWNER);
  const ins = await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    args: [TODAY, "户外", 60, "骑行", "legacy-race-000001", Date.now()],
  });
  const legacyId = Number(ins.rows[0].id);
  const args = { date: TODAY, typeName: "户外", minutes: 60, note: "骑行", requestKey: "legacy-race-000001" };
  const [r1, r2] = await Promise.all([
    call("addActivity", o1.ctx, args),
    call("addActivity", o2.ctx, args),
  ]);
  const ledgerCount = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM family_request_keys WHERE request_key = ?",
    args: ["legacy-race-000001"],
  });
  check(
    "race: legacy row, two concurrent same-key retries → both duplicate with the legacy id, no error, exactly one ledger row",
    r1.ok === true && r2.ok === true && r1.duplicate === true && r2.duplicate === true &&
      r1.id === legacyId && r2.id === legacyId && Number(ledgerCount.rows[0].c) === 1,
  );
}
{
  // Deleting a legacy row (activity with a key but no ledger row)
  // writes its tombstone in the same batch as the delete, and a later
  // retry of that key is typed deleted.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const ins = await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    args: [TODAY, "旅行", 90, null, "legacy-del-0000001", Date.now()],
  });
  const legacyId = Number(ins.rows[0].id);
  const del = await call("deleteActivity", ctx, { id: legacyId });
  const acts = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  const led = await client.execute({
    sql: "SELECT state FROM family_request_keys WHERE request_key = ?",
    args: ["legacy-del-0000001"],
  });
  const retry = await call("addActivity", ctx, { date: TODAY, typeName: "旅行", minutes: 90, note: null, requestKey: "legacy-del-0000001" });
  check(
    "race: legacy-row delete commits tombstone + row removal together; later retry is typed deleted",
    del.ok === true && Number(acts.rows[0].c) === 0 &&
      led.rows.length === 1 && led.rows[0].state === "deleted" &&
      retry.ok === false && retry.deleted === true,
  );
}

/* ---- SAVE-001 (re-review): the REAL client callback decision ----
   The record form's onSuccess/onError delegate to decideSaveOutcome
   in client/src/saveOutcome.ts; the same module is imported here and
   run directly, fed with typed results produced by the REAL server
   handlers above, so the deleted-branch draft protection is verified
   end to end: server verdict → outcome kind → form decision. */
const { decideSaveOutcome, draftsEqual, outcomeKindOfResult } = await import("./client/src/saveOutcome.ts");
{
  // Reproduce the PM scenario with the real handlers: a save lands,
  // its record is deleted, and the (response-lost / late) retry of
  // the same submission comes back typed `deleted`.
  const { db } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("getDashboard", ctx, {}); // seed presets
  const submitted = { date: TODAY, typeName: "陪玩", minutes: 15, note: "备注 A", requestKey: "cb-deleted-key-0001" };
  const saved = await call("addActivity", ctx, submitted);
  await call("deleteActivity", ctx, { id: saved.id });
  const late = await call("addActivity", ctx, submitted);
  check(
    "client-cb: the real retry of a deleted record returns typed deleted",
    late.ok === false && late.deleted === true && outcomeKindOfResult(late) === "deleted",
  );
  const snapshot = { date: submitted.date, typeName: submitted.typeName, minutes: 15, note: "备注 A" };
  // While the deleted verdict was in flight the owner edited the
  // draft to 25 minutes / 备注 B — the deleted branch must NOT clear
  // it, must NOT auto-resubmit, and must say it is unsaved.
  const editedDraft = { ...snapshot, minutes: 25, note: "备注 B" };
  const decEdited = decideSaveOutcome("deleted", draftsEqual(editedDraft, snapshot));
  check(
    "client-cb: deleted + edited draft (25 分钟/备注 B) → nothing cleared, explicit unsaved message, key rotated for a future explicit save only",
    draftsEqual(editedDraft, snapshot) === false &&
      decEdited.clearFlexibleFields === false &&
      decEdited.statusMessage === "原记录已删除，未重新添加；你修改的新内容尚未保存" &&
      decEdited.errorMessage === null &&
      decEdited.conflictPending === false &&
      decEdited.rotateKey === true,
  );
  // Unchanged draft → the deleted outcome is resolved like any other
  // resolved save: fields clear, resolved message shown.
  const decSame = decideSaveOutcome("deleted", draftsEqual(snapshot, snapshot));
  check(
    "client-cb: deleted + unchanged draft → resolved (fields clear, '这条记录已删除，未重新添加。')",
    decSame.clearFlexibleFields === true &&
      decSame.statusMessage === "这条记录已删除，未重新添加。" &&
      decSame.rotateKey === true,
  );
  // Per-field matrix: changing ANY single field (minutes / note /
  // date / type) before the deleted verdict returns flips the branch
  // to full preservation; changing none keeps it resolved.
  const fieldVariants = [
    ["minutes", { ...snapshot, minutes: 25 }],
    ["note", { ...snapshot, note: "备注 B" }],
    ["date", { ...snapshot, date: shiftDay(TODAY, -1) }],
    ["type", { ...snapshot, typeName: "户外" }],
    ["none", { ...snapshot }],
  ];
  for (const [field, draft] of fieldVariants) {
    const matches = draftsEqual(draft, snapshot);
    const dec = decideSaveOutcome("deleted", matches);
    if (field === "none") {
      check(
        "client-cb: deleted matrix — no field changed → resolved branch",
        matches === true && dec.clearFlexibleFields === true,
      );
    } else {
      check(
        `client-cb: deleted matrix — only ${field} changed → draft fully preserved`,
        matches === false &&
          dec.clearFlexibleFields === false &&
          dec.statusMessage === "原记录已删除，未重新添加；你修改的新内容尚未保存",
      );
    }
  }
  // Read-back: the deleted key stays dead — 0 activities, 0 totals.
  const dash = await call("getDashboard", ctx, {});
  check(
    "client-cb: read-back after the deleted verdict — activities 0, totals 0",
    dash.totalCount === 0 && dash.totalKnownMinutes === 0 && dash.unknownMinutesCount === 0,
  );
  // Explicit-save path: ONLY an explicit new submission (fresh
  // requestId, as the rotated key provides) stores the edited draft
  // as a brand-new record.
  const explicit = await call("addActivity", ctx, {
    date: editedDraft.date, typeName: editedDraft.typeName,
    minutes: editedDraft.minutes, note: editedDraft.note,
    requestKey: "cb-deleted-key-0002",
  });
  const dash2 = await call("getDashboard", ctx, {});
  check(
    "client-cb: an explicit save under a fresh key stores the edited draft as a new record (25 分钟/备注 B)",
    explicit.ok === true && explicit.duplicate === false &&
      dash2.totalCount === 1 && dash2.totalKnownMinutes === 25 &&
      dash2.recentActivities[0]?.note === "备注 B",
  );
}
{
  // Old outcome matrix, no regression: every other branch keeps its
  // snapshot guard exactly as before.
  const okSame = decideSaveOutcome("ok", true);
  const okDiff = decideSaveOutcome("ok", false);
  check(
    "client-cb: ok — unchanged draft clears with '已记下。'; changed draft is preserved with an unsaved note",
    okSame.clearFlexibleFields === true && okSame.statusMessage === "已记下。" &&
      okDiff.clearFlexibleFields === false && (okDiff.statusMessage ?? "").includes("还没保存"),
  );
  const dupSame = decideSaveOutcome("duplicate", true);
  const dupDiff = decideSaveOutcome("duplicate", false);
  check(
    "client-cb: duplicate — unchanged clears, changed preserved, both surface 不重复计数",
    dupSame.clearFlexibleFields === true && (dupSame.statusMessage ?? "").includes("重复提交没有重复计数") &&
      dupDiff.clearFlexibleFields === false && (dupDiff.statusMessage ?? "").includes("还没保存"),
  );
  const conflict = decideSaveOutcome("conflict", false);
  check(
    "client-cb: conflict — draft AND request key preserved, save-as-new offered (conflictPending)",
    conflict.clearFlexibleFields === false && conflict.rotateKey === false && conflict.conflictPending === true,
  );
  const net = decideSaveOutcome("networkError", false);
  check(
    "client-cb: network failure — draft AND request key preserved (same-key retry cannot double-count)",
    net.clearFlexibleFields === false && net.rotateKey === false &&
      (net.errorMessage ?? "").includes("填写内容已保留"),
  );
  const future = decideSaveOutcome("future", false);
  const forbidden = decideSaveOutcome("forbidden", false);
  const invalid = decideSaveOutcome("invalid", false);
  check(
    "client-cb: future / forbidden / invalid refusals all preserve the draft and the key",
    [future, forbidden, invalid].every((d) => d.clearFlexibleFields === false && d.rotateKey === false),
  );
  check(
    "client-cb: outcomeKindOfResult maps each typed server result to exactly its kind",
    outcomeKindOfResult({ ok: true, duplicate: false, conflict: false, deleted: false, future: false, forbidden: false }) === "ok" &&
      outcomeKindOfResult({ ok: true, duplicate: true, conflict: false, deleted: false, future: false, forbidden: false }) === "duplicate" &&
      outcomeKindOfResult({ ok: false, duplicate: false, conflict: true, deleted: false, future: false, forbidden: false }) === "conflict" &&
      outcomeKindOfResult({ ok: false, duplicate: false, conflict: false, deleted: true, future: false, forbidden: false }) === "deleted" &&
      outcomeKindOfResult({ ok: false, duplicate: false, conflict: false, deleted: false, future: true, forbidden: false }) === "future" &&
      outcomeKindOfResult({ ok: false, duplicate: false, conflict: false, deleted: false, future: false, forbidden: true }) === "forbidden" &&
      outcomeKindOfResult({ ok: false, duplicate: false, conflict: false, deleted: false, future: false, forbidden: false }) === "invalid",
  );
}

/* ---- INIT-001 (re-review): atomic claim+seed under slow reads ----
   The seed batch is intercepted through a db proxy that can pause it
   (a slow first read caught mid-seed by a second reader) or fail it
   (an interruption mid-seed). Because claim and seeds are one batch,
   neither schedule can expose or persist a half-initialized ledger. */
function wrapDbBatch(db, { delayMs = 0, failFirstBatch = false } = {}) {
  let failed = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements) => {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (failFirstBatch && !failed) {
            failed = true;
            throw new Error("simulated interruption inside the seed batch");
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
for (const slowFirst of [true, false]) {
  const { db, client } = await makeDb();
  const slowCtx = makeCtx(wrapDbBatch(db, { delayMs: 80 }), OWNER);
  const fastCtx = makeCtx(db, OWNER);
  const [first, second] = slowFirst ? [slowCtx, fastCtx] : [fastCtx, slowCtx];
  const [d1, d2] = await Promise.all([
    call("getDashboard", first.ctx, {}),
    call("getDashboard", second.ctx, {}),
  ]);
  const typeCount = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  const metaCount = await client.execute("SELECT COUNT(*) AS c FROM ledger_meta WHERE key = 'types_seeded'");
  check(
    `init-gap: slow first read (${slowFirst ? "first" : "second"} reader's seed batch paused 80ms) — both readers return exactly 7 presets`,
    d1.types.length === 7 && d2.types.length === 7 &&
      d1.types.map((t) => t.name).join(",") === "一起吃饭,陪玩,户外,阅读,运动,旅行,其他" &&
      d2.types.map((t) => t.name).join(",") === "一起吃饭,陪玩,户外,阅读,运动,旅行,其他",
  );
  check(
    `init-gap: slow first read (${slowFirst ? "first" : "second"} delayed) — storage holds exactly 7 types and exactly 1 meta row`,
    Number(typeCount.rows[0].c) === 7 && Number(metaCount.rows[0].c) === 1,
  );
}
{
  // Interruption inside the seed batch: the whole batch rolls back,
  // so no completion marker and no partial types survive; the next
  // read seeds cleanly from scratch.
  const { db, client } = await makeDb();
  const flakyCtx = makeCtx(wrapDbBatch(db, { failFirstBatch: true }), OWNER);
  let threw = false;
  try {
    await call("getDashboard", flakyCtx.ctx, {});
  } catch {
    threw = true;
  }
  const metaAfter = await client.execute("SELECT COUNT(*) AS c FROM ledger_meta");
  const typesAfter = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  check(
    "init-gap: interrupted seed batch propagates the failure",
    threw === true,
  );
  check(
    "init-gap: interruption leaves NO false completion marker and NO partial types (atomic rollback)",
    Number(metaAfter.rows[0].c) === 0 && Number(typesAfter.rows[0].c) === 0,
  );
  const { ctx } = makeCtx(db, OWNER);
  const dash = await call("getDashboard", ctx, {});
  const metaFinal = await client.execute("SELECT COUNT(*) AS c FROM ledger_meta WHERE key = 'types_seeded'");
  const typesFinal = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  check(
    "init-gap: the next read after an interruption seeds cleanly — exactly 7 types, exactly 1 meta",
    dash.types.length === 7 && Number(typesFinal.rows[0].c) === 7 && Number(metaFinal.rows[0].c) === 1,
  );
}
{
  // Owner deletes every type, then two reads (one slow): the meta row
  // still gates seeding, so the list stays empty — never reseeded.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const seeded = await call("getDashboard", ctx, {});
  for (const t of [...seeded.types]) {
    await call("deleteType", ctx, { id: t.id });
  }
  const slowCtx = makeCtx(wrapDbBatch(db, { delayMs: 40 }), OWNER);
  const [d1, d2] = await Promise.all([
    call("getDashboard", slowCtx.ctx, {}),
    call("getDashboard", ctx, {}),
  ]);
  const typeCount = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  const metaCount = await client.execute("SELECT COUNT(*) AS c FROM ledger_meta WHERE key = 'types_seeded'");
  check(
    "init-gap: owner-deleted-all + double read (one slow) → types stay empty, meta stays exactly 1, no reseeding",
    d1.types.length === 0 && d2.types.length === 0 &&
      Number(typeCount.rows[0].c) === 0 && Number(metaCount.rows[0].c) === 1,
  );
}

/* ---- INIT-001 (final fix): a late stale first read cannot resurrect
   owner-deleted types ----
   The genuine interleave the token guard closes: reader A's pre-check
   reads an EMPTY claim, then A is paused inside its seed batch;
   reader B's first read seeds all 7 presets and commits the marker;
   the owner deletes every type; A finally resumes. A's claim insert
   no-ops against B's stored token and every guarded seed insert sees
   a foreign token, so A writes ZERO seed rows: the type list stays
   empty and the marker keeps B's claim. Run in both directions
   (whichever reader is the late one). */
function wrapDbGateBatch(db, { beforeBatch } = {}) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements) => {
          if (beforeBatch) await beforeBatch();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function makeGate() {
  let release;
  const promise = new Promise((r) => { release = r; });
  let armed = true;
  return {
    release,
    beforeBatch: async () => {
      if (armed) { armed = false; await promise; }
    },
  };
}
async function lateInterleaveScenario(mode) {
  const { db, client } = await makeDb();
  const winnerCtx = makeCtx(db, OWNER);
  if (mode === "single-gate") {
    // One gated (late) reader + one ungated winner.
    const gate = makeGate();
    const lateCtx = makeCtx(wrapDbGateBatch(db, gate), OWNER);
    const latePromise = call("getDashboard", lateCtx.ctx, {});
    await new Promise((r) => setTimeout(r, 50)); // late reader parks in its batch
    const winnerDash = await call("getDashboard", winnerCtx.ctx, {});
    const markerBefore = await client.execute("SELECT value FROM ledger_meta WHERE key = 'types_seeded'");
    for (const t of [...winnerDash.types]) {
      await call("deleteType", winnerCtx.ctx, { id: t.id });
    }
    gate.release();
    const lateDash = await latePromise;
    return { db, client, winnerCtx, winnerDash, lateDash, markerBefore };
  }
  // Both readers pre-check an empty claim and park inside their seed
  // batches; the second-parked reader is released first and wins.
  const gateA = makeGate();
  const gateB = makeGate();
  const ctxA = makeCtx(wrapDbGateBatch(db, gateA), OWNER);
  const ctxB = makeCtx(wrapDbGateBatch(db, gateB), OWNER);
  const promiseA = call("getDashboard", ctxA.ctx, {});
  const promiseB = call("getDashboard", ctxB.ctx, {});
  await new Promise((r) => setTimeout(r, 50)); // both readers park in their batches
  gateB.release();
  const dashB = await promiseB;
  const markerBefore = await client.execute("SELECT value FROM ledger_meta WHERE key = 'types_seeded'");
  for (const t of [...dashB.types]) {
    await call("deleteType", winnerCtx.ctx, { id: t.id });
  }
  gateA.release();
  const lateDash = await promiseA;
  return { db, client, winnerCtx, winnerDash: dashB, lateDash, markerBefore };
}
for (const mode of ["single-gate", "both-gated"]) {
  const { client, winnerCtx, winnerDash, lateDash, markerBefore } = await lateInterleaveScenario(mode);
  check(
    `init-late (${mode}): the winning first read seeds exactly 7 presets`,
    winnerDash.types.length === 7,
  );
  const typesAfter = await client.execute("SELECT COUNT(*) AS c FROM activity_types");
  const markerAfter = await client.execute("SELECT value FROM ledger_meta WHERE key = 'types_seeded'");
  check(
    `init-late (${mode}): the late stale reader writes ZERO seed rows — deleted types are NOT resurrected`,
    lateDash.types.length === 0 && Number(typesAfter.rows[0].c) === 0,
  );
  check(
    `init-late (${mode}): the completion marker still holds the winner's claim (seeded stays seeded)`,
    markerAfter.rows.length === 1 && markerAfter.rows[0].value === markerBefore.rows[0].value,
  );
  const reread = await call("getDashboard", winnerCtx.ctx, {});
  check(
    `init-late (${mode}): a further read still sees the empty type list (no deferred resurrection)`,
    reread.types.length === 0,
  );
}

/* ---- INIT-001 (final fix): legacy databases with duplicate type
   names upgrade cleanly (migration 0005/0006 conflict policy) ----
   A database that lived through 0001–0004 may legally hold two
   activity_types rows with the exact same name. The upgrade must
   succeed, preserve BOTH rows and the history that references the
   name, and leave seeding / add / delete behavior normal. Neither
   duplicate is deleted or silently merged; the stable preset_key is
   backfilled only where a preset identity exists. */
{
  const { client, db } = await makeLegacyDb();
  const nowTs = Date.now();
  // Two exact-same-name custom types, plus one activity recorded
  // under that name (records snapshot the name — history by label).
  const ins1 = await client.execute({
    sql: "INSERT INTO activity_types (name, is_preset, created_at) VALUES ('拼图', 0, ?) RETURNING id",
    args: [nowTs],
  });
  const ins2 = await client.execute({
    sql: "INSERT INTO activity_types (name, is_preset, created_at) VALUES ('拼图', 0, ?) RETURNING id",
    args: [nowTs + 1],
  });
  const dupA = Number(ins1.rows[0].id);
  const dupB = Number(ins2.rows[0].id);
  await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, '拼图', 25, NULL, 'legacy-dup-hist-01', ?)",
    args: [TODAY, nowTs],
  });
  let upgradeError = null;
  try {
    await applyMigrations(client, ["0005", "0006", "0007"]);
  } catch (e) {
    upgradeError = e;
  }
  check(
    "upgrade-dup: a 0001–0004 database with two exact-same-name types upgrades through 0005–0007 without error",
    upgradeError === null,
    upgradeError ? String(upgradeError) : "",
  );
  const dupRows = await client.execute({
    sql: "SELECT id, preset_key FROM activity_types WHERE name = '拼图' ORDER BY id",
  });
  check(
    "upgrade-dup: BOTH duplicate rows are preserved with their original ids (nothing deleted, nothing merged)",
    dupRows.rows.length === 2 &&
      Number(dupRows.rows[0].id) === dupA && Number(dupRows.rows[1].id) === dupB,
  );
  check(
    "upgrade-dup: custom duplicates carry no preset identity (preset_key NULL on both)",
    dupRows.rows.every((r) => r.preset_key === null),
  );
  const hist = await client.execute("SELECT type_name, minutes FROM family_activities WHERE request_key = 'legacy-dup-hist-01'");
  check(
    "upgrade-dup: recorded history referencing the duplicated name is preserved untouched",
    hist.rows.length === 1 && hist.rows[0].type_name === "拼图" && Number(hist.rows[0].minutes) === 25,
  );
  const idxRows = await client.execute(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity_types'",
  );
  check(
    "upgrade-dup: after upgrade the only unique index is on preset_key; no global name unique index exists",
    idxRows.rows.some((r) => r.name === "activity_types_preset_key_idx") &&
      !idxRows.rows.some((r) => /UNIQUE/i.test(String(r.sql ?? "")) && /\(name\)/.test(String(r.sql ?? ""))),
  );
  // Post-upgrade behavior is normal: first read seeds the 7 presets,
  // addType works, an exact-name add returns a duplicate winner, and
  // deleting one duplicate leaves the other standing.
  const { ctx } = makeCtx(db, OWNER);
  const dash = await call("getDashboard", ctx, {});
  check(
    "upgrade-dup: first post-upgrade read seeds the 7 presets alongside the preserved duplicates",
    dash.types.filter((t) => t.isPreset).length === 7 && dash.types.length === 9 && dash.totalCount === 1,
  );
  const addNew = await call("addType", ctx, { name: "新类型" });
  const addDupName = await call("addType", ctx, { name: "拼图" });
  check(
    "upgrade-dup: addType still works after upgrade, and an exact-name add resolves to a duplicate winner row",
    addNew.ok === true && addNew.duplicate === false &&
      addDupName.ok === true && addDupName.duplicate === true &&
      (addDupName.id === dupA || addDupName.id === dupB),
  );
  const delOne = await call("deleteType", ctx, { id: dupA });
  const remaining = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM activity_types WHERE name = '拼图'",
  });
  check(
    "upgrade-dup: deleting one duplicate leaves the other row standing",
    delOne.ok === true && Number(remaining.rows[0].c) === 1,
  );
}
{
  // The other upgrade path: a database that DID apply the original
  // 0005 (global UNIQUE index on name). Recreate that state by hand
  // (the published 0005 file is the revised one), then run 0006: the
  // global index must be swapped for the preset_key index with all
  // rows preserved, and preset identities backfilled.
  const { client, db } = await makeLegacyDb();
  const nowTs = Date.now();
  await client.execute("CREATE UNIQUE INDEX activity_types_name_idx ON activity_types (name)");
  await client.execute({
    sql: "INSERT INTO activity_types (name, is_preset, created_at) VALUES ('陪玩', 1, ?), ('拼图', 0, ?)",
    args: [nowTs, nowTs + 1],
  });
  let upgradeError = null;
  try {
    await applyMigrations(client, ["0006", "0007"]);
  } catch (e) {
    upgradeError = e;
  }
  check(
    "upgrade-0005: a database that applied the original global-index 0005 upgrades through 0006+0007 without error",
    upgradeError === null,
    upgradeError ? String(upgradeError) : "",
  );
  const idxRows = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity_types'",
  );
  const idxNames = idxRows.rows.map((r) => String(r.name));
  check(
    "upgrade-0005: the global name index is gone and the preset_key unique index exists",
    !idxNames.includes("activity_types_name_idx") && idxNames.includes("activity_types_preset_key_idx"),
  );
  const keyed = await client.execute({
    sql: "SELECT name, preset_key FROM activity_types ORDER BY id",
  });
  check(
    "upgrade-0005: rows preserved; the preset row is backfilled with its stable preset_key, the custom row keeps NULL",
    keyed.rows.length === 2 &&
      keyed.rows[0].name === "陪玩" && keyed.rows[0].preset_key === "陪玩" &&
      keyed.rows[1].name === "拼图" && keyed.rows[1].preset_key === null,
  );
  // After the swap, custom duplicates no longer hit a global unique
  // failure at the storage layer, while preset identity stays unique.
  await client.execute({
    sql: "INSERT INTO activity_types (name, is_preset, created_at) VALUES ('拼图', 0, ?)",
    args: [nowTs + 2],
  });
  let presetBlocked = false;
  try {
    await client.execute({
      sql: "INSERT INTO activity_types (name, is_preset, preset_key, created_at) VALUES ('陪玩二', 1, '陪玩', ?)",
      args: [nowTs + 3],
    });
  } catch {
    presetBlocked = true;
  }
  check(
    "upgrade-0005: custom same-name rows are storable again, but a second row claiming the same preset_key is refused",
    presetBlocked === true,
  );
  const { ctx } = makeCtx(db, OWNER);
  const dash = await call("getDashboard", ctx, {});
  check(
    "upgrade-0005: post-upgrade read is normal — the pre-existing 陪玩 preset is not duplicated by seeding",
    dash.types.filter((t) => t.name === "陪玩").length === 1 &&
      dash.types.filter((t) => t.isPreset).length === 7,
  );
}
{
  // Rollback control: withdrawing ONLY the new preset_key unique
  // index (DROP INDEX) changes no data at all — every row of every
  // table is byte-identical before and after.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("getDashboard", ctx, {}); // seed presets
  await call("addType", ctx, { name: "拼图" });
  await call("addActivity", ctx, { date: TODAY, typeName: "拼图", minutes: 15, note: null, requestKey: "rollback-ctl-00001" });
  const snapshot = async () => {
    const types = await client.execute("SELECT id, name, is_preset, preset_key, created_at FROM activity_types ORDER BY id");
    const acts = await client.execute("SELECT id, date, type_name, minutes, note, request_key, created_at FROM family_activities ORDER BY id");
    const meta = await client.execute("SELECT key, value FROM ledger_meta ORDER BY key");
    const keys = await client.execute("SELECT request_key, payload, activity_id, state, created_at, updated_at FROM family_request_keys ORDER BY request_key");
    return JSON.stringify([types.rows, acts.rows, meta.rows, keys.rows]);
  };
  const before = await snapshot();
  await client.execute("DROP INDEX IF EXISTS activity_types_preset_key_idx");
  const after = await snapshot();
  const idxGone = await client.execute(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = 'activity_types_preset_key_idx'",
  );
  check(
    "rollback-ctl: dropping only the new preset_key index leaves every row of every table byte-identical",
    before === after && Number(idxGone.rows[0].c) === 0,
  );
}

/* ---- AUTOLOG-001: chat auto-record — provenance, shared arbitration,
   strict owner gate, and the pre-source upgrade ---- */
{
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  await call("getDashboard", ctx, {}); // seed presets
  const chatArgs = { date: TODAY, typeName: "陪玩", minutes: 35, note: "搭乐高", requestKey: "chat-rec-key-00001" };
  const rec = await call("recordFamilyActivityFromChat", ctx, chatArgs);
  check(
    "autolog: chat record succeeds with a locatable receipt (id, date, type, minutes, source fixed 聊天记录）",
    rec.ok === true && rec.duplicate === false && rec.id !== null &&
      rec.date === TODAY && rec.typeName === "陪玩" && rec.minutes === 35 && rec.source === "聊天记录" &&
      rec.conflict === false && rec.deleted === false && rec.future === false && rec.forbidden === false,
  );
  const storedSrc = await client.execute({
    sql: "SELECT source FROM family_activities WHERE id = ?",
    args: [rec.id],
  });
  check(
    "autolog: the stored row itself carries source 聊天记录 (server-stamped, not echoed)",
    storedSrc.rows.length === 1 && storedSrc.rows[0].source === "聊天记录",
  );
  let dash = await call("getDashboard", ctx, {});
  check(
    "autolog: the chat record counts exactly once and shows its source in recentActivities",
    dash.totalCount === 1 && dash.totalKnownMinutes === 35 &&
      dash.recentActivities.find((r) => r.id === rec.id)?.source === "聊天记录",
  );
  const replay = await call("recordFamilyActivityFromChat", ctx, chatArgs);
  dash = await call("getDashboard", ctx, {});
  check(
    "autolog: same-key same-content chat retry replays as duplicate — still exactly one row",
    replay.ok === true && replay.duplicate === true && replay.id === rec.id && dash.totalCount === 1,
  );
  const edited = await call("recordFamilyActivityFromChat", ctx, { ...chatArgs, minutes: 40 });
  check(
    "autolog: same-key different content via chat is a typed conflict, receipt fields nulled",
    edited.ok === false && edited.conflict === true && edited.id === null && edited.source === null,
  );
  // Cross-path: identical content under the same key through the
  // MANUAL path differs only in source → conflict, never a merge.
  const cross = await call("addActivity", ctx, chatArgs);
  const rawCount = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  check(
    "autolog: same key + same content via the manual path conflicts on source alone (no silent merge, still one row)",
    cross.ok === false && cross.conflict === true && Number(rawCount.rows[0].c) === 1,
  );
  // And the mirror: a manual record replayed through chat conflicts.
  const manArgs = { date: TODAY, typeName: "阅读", minutes: 20, note: null, requestKey: "chat-rec-key-00002" };
  const man = await call("addActivity", ctx, manArgs);
  const manStored = await client.execute({
    sql: "SELECT source FROM family_activities WHERE id = ?",
    args: [man.id],
  });
  const crossBack = await call("recordFamilyActivityFromChat", ctx, manArgs);
  check(
    "autolog: manual saves stamp 手动； the same key replayed via chat conflicts on source",
    man.ok === true && manStored.rows[0].source === "手动" &&
      crossBack.ok === false && crossBack.conflict === true,
  );
  dash = await call("getDashboard", ctx, {});
  check(
    "autolog: dashboard labels the manual row 手动 and the chat row 聊天记录 (text, not color)",
    dash.recentActivities.find((r) => r.id === man.id)?.source === "手动" &&
      dash.recentActivities.find((r) => r.id === rec.id)?.source === "聊天记录",
  );
}
{
  // minutes null = unknown: stored NULL, counted as an activity,
  // never folded into the known-duration total as 0.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const rec = await call("recordFamilyActivityFromChat", ctx, {
    date: TODAY, typeName: "一起吃饭", minutes: null, note: null, requestKey: "chat-null-min-0001",
  });
  const stored = await client.execute({
    sql: "SELECT minutes FROM family_activities WHERE id = ?",
    args: [rec.id],
  });
  const dash = await call("getDashboard", ctx, {});
  check(
    "autolog: minutes=null is stored as NULL (unknown) and counted as an activity, not as 0 minutes",
    rec.ok === true && rec.minutes === null && stored.rows[0].minutes === null &&
      dash.totalCount === 1 && dash.totalKnownMinutes === 0 && dash.unknownMinutesCount === 1 &&
      dash.recentActivities[0]?.minutes === null && dash.recentActivities[0]?.source === "聊天记录",
  );
}
{
  // Future date + invalid date via chat: typed refusals, zero writes.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const fut = await call("recordFamilyActivityFromChat", ctx, {
    date: TOMORROW, typeName: "陪玩", minutes: 30, note: null, requestKey: "chat-future-00001",
  });
  const bad = await call("recordFamilyActivityFromChat", ctx, {
    date: "2026-02-30", typeName: "陪玩", minutes: 30, note: null, requestKey: "chat-baddate-0001",
  });
  const acts = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  const keys = await client.execute("SELECT COUNT(*) AS c FROM family_request_keys");
  check(
    "autolog: future date refused as future via chat, invalid date refused plainly — zero rows, zero ledger entries",
    fut.ok === false && fut.future === true && fut.id === null &&
      bad.ok === false && bad.future === false && bad.conflict === false &&
      Number(acts.rows[0].c) === 0 && Number(keys.rows[0].c) === 0,
  );
  let threw = false;
  try {
    Actions.recordFamilyActivityFromChat.request.parse({
      date: TODAY, typeName: "陪玩", minutes: 30, note: null, requestKey: "short",
    });
  } catch {
    threw = true;
  }
  check("autolog: a requestKey shorter than 8 chars is rejected at the request boundary", threw);
}
{
  // Delete a chat-recorded entry, then the chat retry arrives late:
  // typed deleted, nothing resurrects; a manual retry of the same
  // key is likewise refused (source conflict against the tombstone).
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const args = { date: TODAY, typeName: "户外", minutes: 50, note: null, requestKey: "chat-del-key-00001" };
  const rec = await call("recordFamilyActivityFromChat", ctx, args);
  const del = await call("deleteActivity", ctx, { id: rec.id });
  const late = await call("recordFamilyActivityFromChat", ctx, args);
  const lateManual = await call("addActivity", ctx, args);
  const acts = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  const led = await client.execute({
    sql: "SELECT state FROM family_request_keys WHERE request_key = ?",
    args: ["chat-del-key-00001"],
  });
  const dash = await call("getDashboard", ctx, {});
  check(
    "autolog: deleted chat record — late chat retry is typed deleted and resurrects nothing",
    del.ok === true && late.ok === false && late.deleted === true && late.id === null &&
      Number(acts.rows[0].c) === 0 && dash.totalCount === 0 &&
      led.rows.length === 1 && led.rows[0].state === "deleted",
  );
  check(
    "autolog: a manual retry of the deleted chat key is also refused (no cross-path resurrection)",
    lateManual.ok === false && lateManual.id === null && Number(acts.rows[0].c) === 0,
  );
}
{
  // Forgery: the manual request schema has no source field — a
  // client that sends source:'聊天记录' anyway gets it stripped;
  // the stored row is stamped 手动 by the server.
  const { db, client } = await makeDb();
  const { ctx } = makeCtx(db, OWNER);
  const forged = await call("addActivity", ctx, {
    date: TODAY, typeName: "陪玩", minutes: 15, note: null,
    requestKey: "forge-key-0000001", source: "聊天记录",
  });
  const stored = await client.execute({
    sql: "SELECT source FROM family_activities WHERE id = ?",
    args: [forged.id],
  });
  const parsed = Actions.addActivity.request.parse({
    date: TODAY, typeName: "陪玩", minutes: 15, note: null,
    requestKey: "forge-key-0000002", source: "聊天记录",
  });
  check(
    "autolog: a forged source in a manual request is stripped by the schema and the row is stamped 手动",
    forged.ok === true && stored.rows[0].source === "手动" && !("source" in parsed),
  );
}
{
  // Strict owner gate on the chat path: non-owner, anonymous and
  // missing (null) viewers are all refused BEFORE any db access,
  // with zero rows and zero ledger entries afterwards.
  const { db, client } = await makeDb();
  for (const [label, viewer] of [["non-owner", NON_OWNER], ["anonymous", ANON], ["null viewer", null]]) {
    const { ctx, state } = makeCtx(db, viewer);
    const res = await call("recordFamilyActivityFromChat", ctx, {
      date: TODAY, typeName: "陪玩", minutes: 30, note: null, requestKey: `chat-gate-${label.replace(/\s/g, "")}-01`,
    });
    check(
      `autolog-gate: ${label} chat record is forbidden with a fully nulled receipt`,
      res.ok === false && res.forbidden === true && res.id === null && res.source === null &&
        res.date === null && res.typeName === null,
    );
    check(`autolog-gate: ${label} chat record never touches the db`, state.dbCalls === 0);
  }
  const acts = await client.execute("SELECT COUNT(*) AS c FROM family_activities");
  const keys = await client.execute("SELECT COUNT(*) AS c FROM family_request_keys");
  check(
    "autolog-gate: refused chat records wrote zero rows and zero ledger entries",
    Number(acts.rows[0].c) === 0 && Number(keys.rows[0].c) === 0,
  );
}
{
  // Pre-source production shape (migrations through 0006) upgrades
  // additively: rows, dates, minutes, deletion state and totals are
  // untouched; old rows read source NULL → 旧来源未记录； a
  // same-content retry of a pre-source key still replays as a
  // duplicate (its fingerprint predates provenance); deleting a
  // pre-source row tombstones it and its key stays dead; and
  // withdrawing the migration (dropping the column) loses nothing.
  const { client, db } = await makePreSourceDb();
  const nowTs = Date.now();
  const legacyPayload = JSON.stringify({ date: TODAY, typeName: "陪玩", minutes: 45, note: "老记录" });
  const insA = await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, '陪玩', 45, '老记录', 'pre-src-key-00001', ?) RETURNING id",
    args: [TODAY, nowTs],
  });
  const idA = Number(insA.rows[0].id);
  await client.execute({
    sql: "INSERT INTO family_request_keys (request_key, payload, activity_id, state, created_at, updated_at) VALUES ('pre-src-key-00001', ?, ?, 'saved', ?, ?)",
    args: [legacyPayload, idA, nowTs, nowTs],
  });
  const insB = await client.execute({
    sql: "INSERT INTO family_activities (date, type_name, minutes, note, request_key, created_at) VALUES (?, '阅读', NULL, NULL, 'pre-src-key-00002', ?) RETURNING id",
    args: [shiftDay(TODAY, -2), nowTs],
  });
  const idB = Number(insB.rows[0].id);
  const rowsBefore = await client.execute(
    "SELECT id, date, type_name, minutes, note, request_key, created_at FROM family_activities ORDER BY id",
  );
  let upgradeError = null;
  try {
    await applyMigrations(client, ["0007"]);
  } catch (e) {
    upgradeError = e;
  }
  check("autolog-upgrade: a through-0006 database upgrades through 0007 without error", upgradeError === null, upgradeError ? String(upgradeError) : "");
  const rowsAfter = await client.execute(
    "SELECT id, date, type_name, minutes, note, request_key, created_at, source FROM family_activities ORDER BY id",
  );
  check(
    "autolog-upgrade: every pre-source row is preserved field-for-field and its source stays NULL (never backfilled)",
    JSON.stringify(rowsAfter.rows.map((r) => [r.id, r.date, r.type_name, r.minutes, r.note, r.request_key, r.created_at])) ===
      JSON.stringify(rowsBefore.rows.map((r) => [r.id, r.date, r.type_name, r.minutes, r.note, r.request_key, r.created_at])) &&
      rowsAfter.rows.every((r) => r.source === null),
  );
  const { ctx } = makeCtx(db, OWNER);
  const dash = await call("getDashboard", ctx, {});
  check(
    "autolog-upgrade: totals unchanged after upgrade (2 records, 45 known minutes, 1 unknown) and old rows read source null （旧来源未记录）",
    dash.totalCount === 2 && dash.totalKnownMinutes === 45 && dash.unknownMinutesCount === 1 &&
      dash.recentActivities.every((r) => r.source === null) && dash.recentActivities.length === 2,
  );
  const retryA = await call("addActivity", ctx, {
    date: TODAY, typeName: "陪玩", minutes: 45, note: "老记录", requestKey: "pre-src-key-00001",
  });
  check(
    "autolog-upgrade: a same-content retry of a pre-source key still replays as duplicate (legacy fingerprint has no source to conflict on)",
    retryA.ok === true && retryA.duplicate === true && retryA.id === idA && retryA.conflict === false,
  );
  const delB = await call("deleteActivity", ctx, { id: idB });
  const retryB = await call("addActivity", ctx, {
    date: shiftDay(TODAY, -2), typeName: "阅读", minutes: null, note: null, requestKey: "pre-src-key-00002",
  });
  const ledB = await client.execute({
    sql: "SELECT state FROM family_request_keys WHERE request_key = 'pre-src-key-00002'",
  });
  check(
    "autolog-upgrade: deleting a pre-source row tombstones it; a late retry is typed deleted, not resurrected",
    delB.ok === true && ledB.rows.length === 1 && ledB.rows[0].state === "deleted" &&
      retryB.ok === false && retryB.deleted === true,
  );
  // Rollback readability: dropping ONLY the new column loses no data.
  const snapAll = async (withSource) => {
    const types = await client.execute("SELECT id, name, is_preset, preset_key, created_at FROM activity_types ORDER BY id");
    const acts = await client.execute(
      withSource
        ? "SELECT id, date, type_name, minutes, note, request_key, created_at, source FROM family_activities ORDER BY id"
        : "SELECT id, date, type_name, minutes, note, request_key, created_at FROM family_activities ORDER BY id",
    );
    const meta = await client.execute("SELECT key, value FROM ledger_meta ORDER BY key");
    const keys = await client.execute("SELECT request_key, payload, activity_id, state, created_at, updated_at FROM family_request_keys ORDER BY request_key");
    return { types: types.rows, acts: acts.rows, meta: meta.rows, keys: keys.rows };
  };
  const beforeDrop = await snapAll(true);
  await client.execute("ALTER TABLE family_activities DROP COLUMN source");
  const afterDrop = await snapAll(false);
  const stripped = beforeDrop.acts.map(({ source, ...rest }) => rest);
  check(
    "autolog-upgrade: rollback (drop only the source column) preserves every row of every table",
    JSON.stringify(afterDrop.acts) === JSON.stringify(stripped) &&
      JSON.stringify(afterDrop.types) === JSON.stringify(beforeDrop.types) &&
      JSON.stringify(afterDrop.meta) === JSON.stringify(beforeDrop.meta) &&
      JSON.stringify(afterDrop.keys) === JSON.stringify(beforeDrop.keys),
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
