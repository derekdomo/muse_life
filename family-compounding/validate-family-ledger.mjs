// CMP-FAMILY-001 validation — 陪伴复利 ledger integrity:
// strict owner gate, request-key idempotency, delete correction,
// unknown-duration accounting, backfill semantics, and reconciliation
// of the weekly series / calendar against the raw record set.
//
// Two layers:
//  1. Source wiring: every action's strict isOwner gate precedes any
//     ctx.db access; addActivity writes through one conditional
//     INSERT … WHERE NOT EXISTS(request_key) with a UNIQUE index on
//     request_key in the migration; the client carries the honesty
//     copy （没有记录不等于没陪伴 / 空账本空态 / 重复提交不重计）.
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
    "source: addActivity writes via one conditional INSERT (NOT EXISTS on request_key)",
    add.includes("INSERT INTO family_activities") && add.includes("NOT EXISTS") && add.includes("request_key"),
  );
  check("source: addActivity reports the existing row on duplicate", add.includes("duplicate: true"));
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
    check(`gate: ${label} addActivity refused`, add.ok === false && add.forbidden === true && add.id === null);
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

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
