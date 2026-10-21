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

const ACTION_NAMES = ["getDashboard", "addActivity", "deleteActivity", "addType", "deleteType"];
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
  const add = actionSlice(serverSrc, "addActivity");
  check(
    "source: addActivity fresh save is one db.batch of builder statements (ledger claim + activity insert)",
    add.includes("db.batch") &&
      add.includes("insert(schema.familyRequestKeys)") &&
      add.includes("insert(schema.familyActivities)"),
  );
  check(
    "source: addActivity claim, activity insert and legacy backfill all use onConflictDoNothing",
    (add.match(/onConflictDoNothing/g) ?? []).length >= 3,
  );
  check(
    "source: the shared adjudication reports the existing row on duplicate",
    serverSrc.includes("async function adjudicateSave") && add.includes("adjudicateSave(db, args.requestKey, payload"),
  );
  check(
    "source: request_key carries a UNIQUE index in the migration",
    migrationSql.includes("CREATE UNIQUE INDEX") && migrationSql.includes("request_key"),
  );
  check(
    "source: unknown minutes stay NULL (no 0-fill anywhere in addActivity)",
    !/minutes\s*\?\?/.test(add) && !add.includes("|| 0"),
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
  clientSrc.includes("重复提交没有重复计数"),
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
  check(
    "source(save): addActivity adjudicates via the request-key ledger and can refuse as conflict/deleted",
    add.includes("familyRequestKeys") && add.includes("adjudicateSave") &&
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
  check(
    "source(init): preset seeding claims via a builder INSERT … ON CONFLICT DO NOTHING … RETURNING, then seeds all presets in one db.batch",
    dash.includes("insert(schema.ledgerMeta)") &&
      dash.includes("onConflictDoNothing") &&
      dash.includes("returning()") &&
      dash.includes("db.batch") &&
      dash.includes("insert(schema.activityTypes)"),
  );
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
check(
  "client(save): conflict keeps the draft and offers an explicit save-as-new action",
  clientSrc.includes("作为新的一条保存") && clientSrc.includes("res.conflict"),
);
check(
  "client(save): deleted retry is reported as deleted, not re-added",
  clientSrc.includes("这条记录已删除，未重新添加。"),
);
check(
  "client(date): future save shows the draft-preserving message and the date input is capped at today",
  clientSrc.includes("日期在今天之后，还没发生的事不能记为已完成；填写内容已保留。") && clientSrc.includes("max={data.today}"),
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

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
