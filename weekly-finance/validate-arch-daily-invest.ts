// CAL-METRICS-001 daily investment gain/loss validation: drives
// the REAL ingestArchDailyInvest handler against an in-memory
// DB, same harness style as validate-arch-daily-spend.ts.
// Caliber: pnl = the day's investment value change minus the
// day's net investment flow. Daily granularity exists only from
// INVEST_DAILY_ERA_START (2026-10-24) — days before it are
// rejected (before_daily_era) and never stored; earlier months
// stay monthly in the Firance archive and are never split.
// Run: bun validate-arch-daily-invest.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, INVEST_DAILY_ERA_START, pickCurrentDailyInvestVersion } = await import(join(APP_DIR, "server/src/actions.ts"));

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

function applyMigrationFile(sqlite: Database, file: string) {
  const sql = readFileSync(join(APP_DIR, "drizzle", file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}
function migrationFiles(): string[] {
  return readdirSync(join(APP_DIR, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
}
function freshDb() {
  const sqlite = new Database(":memory:");
  for (const f of migrationFiles()) applyMigrationFile(sqlite, f);
  return { sqlite, db: drizzle(sqlite, { schema }) as any };
}
function investRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_invest").get() as any).n;
}
function makeCtx(db: any, opts: { viewer?: any }) {
  return {
    slug: "space-3",
    invocationId: "browser-harness",
    spaceDir: APP_DIR,
    viewer: opts.viewer,
    db: () => db,
    blobs: undefined,
    invalidateQueries: () => {},
    agent: { spawnTask: async () => ({ ok: true, taskId: "task-harness" }) },
    executePrivileged: async () => { throw new Error("not used"); },
  } as any;
}
const ownerCtx = (db: any) => makeCtx(db, { viewer: { isOwner: true } });
const guestCtx = (db: any) => makeCtx(db, { viewer: { isOwner: false } });

const PULLED_AT = "2026-10-25T15:00:00.000Z";
const DAY1 = { date: "2026-10-24", valueChange: 1500, netFlow: 300, pnl: 1200 };
const DAY2 = { date: "2026-10-25", valueChange: -500, netFlow: -200, pnl: -300 };
const DAY_LOSS = { date: "2026-10-26", valueChange: -900, netFlow: 100, pnl: -1000 };

function request(days: any[], overrides: any = {}) {
  return {
    arch: "F-ARCH-001" as const,
    version: 1 as const,
    pulledAt: PULLED_AT,
    days,
    ...overrides,
  };
}

check("era constant is 2026-10-24 (the arch daily era)", INVEST_DAILY_ERA_START === "2026-10-24");

{
  const { sqlite, db } = freshDb();
  const denied = await Actions.ingestArchDailyInvest.handler(guestCtx(db), request([DAY1, DAY2]));
  check("guest is forbidden and writes nothing", denied.ok === false && denied.issue === "forbidden" && investRowCount(sqlite) === 0);
  const res = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY1, DAY2]));
  check("owner ingest ok + read-back verified + day count", res.ok === true && res.readBackVerified === true && res.days === 2);
  check("exactly one stored row", investRowCount(sqlite) === 1);
  const rows = (sqlite.query("SELECT id, payload, pulled_at FROM arch_daily_invest").all() as any[])
    .map((r) => ({ id: r.id, payload: r.payload, pulledAt: new Date(r.pulled_at) }));
  const current = pickCurrentDailyInvestVersion(rows);
  check("stored payload: pnl identity holds per day (valueChange - netFlow); coverage spans the days array",
    current !== null && current.parsed.days.length === 2
    && current.parsed.days.every((d: any) => Math.abs(d.pnl - (d.valueChange - d.netFlow)) < 0.005)
    && current.parsed.days[0]?.date === "2026-10-24" && current.parsed.days[1]?.date === "2026-10-25");
  check("stored payload: a loss day keeps its sign (DAY2 pnl -300, valueChange -500)",
    current !== null && current.parsed.days[1]?.pnl === -300 && current.parsed.days[1]?.netFlow === -200);
  const again = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY1, DAY2]));
  check("same-version identical resend is idempotent (still 1 row)", again.ok === true && investRowCount(sqlite) === 1);
  const conflict = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY1, DAY_LOSS]));
  check("same version, different content -> version_conflict", conflict.ok === false && conflict.issue === "version_conflict" && investRowCount(sqlite) === 1);
  const stale = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY1], { pulledAt: "2026-10-24T15:00:00.000Z" }));
  check("older pulledAt -> stale_version, no write", stale.ok === false && stale.issue === "stale_version" && investRowCount(sqlite) === 1);
  const newer = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY1, DAY2, DAY_LOSS], { pulledAt: "2026-10-26T15:00:00.000Z" }));
  check("newer pulledAt publishes (2 rows, append-only) and read-back verifies", newer.ok === true && investRowCount(sqlite) === 2);
  const rows2 = (sqlite.query("SELECT id, payload, pulled_at FROM arch_daily_invest").all() as any[])
    .map((r) => ({ id: r.id, payload: r.payload, pulledAt: new Date(r.pulled_at) }));
  const current2 = pickCurrentDailyInvestVersion(rows2);
  check("current version after the newer publish is the 3-day one", current2 !== null && current2.parsed.days.length === 3 && current2.parsed.days[2]?.date === "2026-10-26");
}

{
  const { sqlite, db } = freshDb();
  const badPnl = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([{ date: "2026-10-24", valueChange: 1500, netFlow: 300, pnl: 1201 }]));
  check("pnl that does not equal valueChange - netFlow -> pnl_mismatch, zero rows",
    badPnl.ok === false && badPnl.issue === "pnl_mismatch" && investRowCount(sqlite) === 0);
  const beforeEra = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([
    { date: "2026-10-23", valueChange: 100, netFlow: 0, pnl: 100 },
    { date: "2026-10-24", valueChange: 100, netFlow: 0, pnl: 100 },
  ]));
  check("a day before the daily era (2026-10-23) -> before_daily_era: monthly values are never smuggled in as days",
    beforeEra.ok === false && beforeEra.issue === "before_daily_era" && investRowCount(sqlite) === 0);
  const outOfOrder = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY2, DAY1]));
  check("non-increasing dates -> dates_not_increasing", outOfOrder.ok === false && outOfOrder.issue === "dates_not_increasing");
  const dupDate = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([DAY1, DAY1]));
  check("duplicate date -> dates_not_increasing", dupDate.ok === false && dupDate.issue === "dates_not_increasing");
  const invalid = await Actions.ingestArchDailyInvest.handler(ownerCtx(db), request([{ date: "2026-02-30", valueChange: 1, netFlow: 0, pnl: 1 }]));
  check("impossible calendar date -> invalid_date", invalid.ok === false && invalid.issue === "invalid_date");
}

console.log(`validate-arch-daily-invest: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
