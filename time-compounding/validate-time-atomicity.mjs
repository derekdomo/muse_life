#!/usr/bin/env bun
// validate-time-atomicity.mjs — CMP-TIME-SAVE-001 原子性/幂等验证。
//
// 用真实 handler（server/src/actions.ts）+ 实际 drizzle 迁移建的内存库
// （:memory: libsql）验证 add/update/delete 的原子性判据：
//   S1 add 在 ledger 写点失败 → 零半包（entries=0/ledger=0），原键重试只落一行
//   S2 add 在 entry 写点失败 → 零半包，原键重试成功
//   S3 同键并发（查询屏障让两边都读到空 ledger）：同 payload 只产一行且双 replay；
//      异 payload 一成一冲突、只落赢家一行；update 同键并发同理
//   S4 update 每个写点失败（entry UPDATE 触发器 / ledger INSERT 触发器）→
//      条目与 ledger 均不变，原键重试干净成功
//   S5 旧键重试与较新编辑交错：旧 update 重试不得回滚新稿；add 原键重试不复活旧值
//   S6 delete 墓碑：删除后原 add/update 键晚重试恒为 deleted、delete 键 replay、
//      新键改已删条目为 deleted；新键同 payload 可正常新建（墓碑按条目不按内容）
//   S7 guest / 非所有者 / agent 委托：零读写（forbidden 且行数逐行不变）
//   S8 统计三值一致：逐行/SQL 独立复算的覆盖并集、分类和、重叠与 getDashboard
//      一致；含相邻（零重叠）、交叠、跨周裁剪、DST 周长 167/169 的独立口径断言；
//      真实零（空库）时 hasRecords=false 且覆盖/分类和/重叠同为 0
//   S9 迁移保行：迁移前风格的旧记录（无 ledger 行）迁移后逐行保留、可被
//      dashboard 读到、可被新键 update（与 ledger 同批落行）
//
// 只用内存库 + SYNTHETIC 数据，绝不触碰生产 app.db。
// 用法：bun validate-time-atomicity.mjs；退出码 0 = 全部通过。

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./server/src/schema.ts";
import { Actions } from "./server/src/actions.ts";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
  }
}
function eq(name, actual, expected) {
  check(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);
}

// ------------------------------------------------------------ world factory
const here = dirname(fileURLToPath(import.meta.url));

async function makeWorld() {
  const client = createClient({ url: ":memory:" });
  const migDir = join(here, "drizzle");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const text = readFileSync(join(migDir, f), "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await client.executeMultiple(s);
    }
  }
  const db = drizzle(client, { schema });
  return { client, db };
}

function makeCtx(db, { owner = true, delegate } = {}) {
  const viewer = {
    source: "local",
    authenticated: true,
    spaceSlug: "space-14",
    userId: "owner-1",
    ownerUserId: "owner-1",
    isOwner: owner,
  };
  if (delegate) viewer.delegate = delegate;
  return { viewer, db: () => db, invalidateQueries() {}, slug: "space-14" };
}

async function count(client, table) {
  const r = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(r.rows[0].c);
}
async function entryRows(client) {
  const r = await client.execute(
    "SELECT id, category, start_ms AS startMs, end_ms AS endMs, note FROM time_entries ORDER BY id",
  );
  return r.rows.map((x) => ({ ...x, id: Number(x.id), startMs: Number(x.startMs), endMs: Number(x.endMs) }));
}
async function ledgerRow(client, requestId) {
  const r = await client.execute({
    sql: "SELECT request_id AS requestId, entry_id AS entryId, deleted FROM request_ledger WHERE request_id = ?",
    args: [requestId],
  });
  const row = r.rows[0];
  return row ? { ...row, entryId: row.entryId == null ? null : Number(row.entryId), deleted: Number(row.deleted) } : null;
}

// Fixed past interval (Mon 2026-10-19 16:00–16:30 UTC), mirrors the PM repro.
const T0 = Date.UTC(2026, 9, 19, 16, 0, 0);
const T1 = Date.UTC(2026, 9, 19, 16, 30, 0);
const ADD = { category: "学习", startMs: T0, endMs: T1, note: "SYNTHETIC" };

// Concurrency barrier: wrap a ctx's db so its FIRST request_ledger select in
// each handler waits until every party has arrived — both handlers provably
// read an empty ledger before either writes (the PM's race construction).
function barrierDb(realDb, gate) {
  const wrapBuilder = (builder, state) =>
    new Proxy(builder, {
      get(t, prop) {
        if (prop === "then") {
          return (onF, onR) =>
            (async () => {
              if (state.table === schema.requestLedger && !gate.used) {
                gate.used = true;
                await gate.wait();
              }
              return await t;
            })().then(onF, onR);
        }
        const v = Reflect.get(t, prop, t);
        if (typeof v === "function") {
          return (...a) => {
            if (prop === "from") state.table = a[0];
            const r = v.apply(t, a);
            return r && typeof r === "object" ? wrapBuilder(r, state) : r;
          };
        }
        return v;
      },
    });
  return {
    select: (...a) => wrapBuilder(realDb.select(...a), { table: null }),
    insert: (...a) => realDb.insert(...a),
    update: (...a) => realDb.update(...a),
    delete: (...a) => realDb.delete(...a),
    batch: (...a) => realDb.batch(...a),
    run: (...a) => realDb.run(...a),
    all: (...a) => realDb.all(...a),
    get: (...a) => realDb.get(...a),
  };
}
function makeGate(n, timeoutMs = 5000) {
  let arrived = 0;
  let release;
  const p = new Promise((r) => (release = r));
  const timer = setTimeout(() => release(), timeoutMs);
  const wait = async () => {
    arrived++;
    if (arrived >= n) {
      clearTimeout(timer);
      release();
    }
    await p;
  };
  return () => ({ used: false, wait });
}

// ------------------------------------------------------------ S1: add fails at ledger write point
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  await client.execute(
    "CREATE TRIGGER fail_ledger BEFORE INSERT ON request_ledger BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END;",
  );
  let threw = false;
  try {
    await Actions.addEntry.handler(ctx, { requestId: "SYNTHETIC-time-key", ...ADD });
  } catch {
    threw = true;
  }
  eq("S1 ledger 写点失败时 handler 抛错", threw, true);
  eq("S1 失败后 time_entries 零半包", await count(client, "time_entries"), 0);
  eq("S1 失败后 request_ledger 零半包", await count(client, "request_ledger"), 0);
  await client.execute("DROP TRIGGER fail_ledger");
  const res = await Actions.addEntry.handler(ctx, { requestId: "SYNTHETIC-time-key", ...ADD });
  eq("S1 去触发器后原键重试 ok", res.ok, true);
  eq("S1 重试后 entries 恰 1 行（不重复落行）", await count(client, "time_entries"), 1);
  eq("S1 重试后 ledger 恰 1 行", await count(client, "request_ledger"), 1);
  const rows = await entryRows(client);
  eq("S1 落行内容与请求一致", rows[0]?.note, "SYNTHETIC");
  const led = await ledgerRow(client, "SYNTHETIC-time-key");
  eq("S1 ledger.entry_id 指向落行", led?.entryId, rows[0]?.id);
  const replay = await Actions.addEntry.handler(ctx, { requestId: "SYNTHETIC-time-key", ...ADD });
  eq("S1 同键同 payload replay ok", replay.ok, true);
  eq("S1 replay 返回同一条目 id", replay.entry?.id, rows[0]?.id);
  eq("S1 replay 后 entries 仍 1 行", await count(client, "time_entries"), 1);
  const conflict = await Actions.addEntry.handler(ctx, {
    requestId: "SYNTHETIC-time-key",
    ...ADD,
    note: "DIFFERENT",
  });
  eq("S1 同键异 payload 为 conflict", conflict.error, "conflict");
  eq("S1 conflict 不改已落行", (await entryRows(client))[0]?.note, "SYNTHETIC");
  eq("S1 conflict 后 entries 仍 1 行", await count(client, "time_entries"), 1);
}

// ------------------------------------------------------------ S2: add fails at entry write point
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  await client.execute(
    "CREATE TRIGGER fail_entry BEFORE INSERT ON time_entries BEGIN SELECT RAISE(ABORT, 'synthetic entry failure'); END;",
  );
  let threw = false;
  try {
    await Actions.addEntry.handler(ctx, { requestId: "s2-add-key-0001", ...ADD });
  } catch {
    threw = true;
  }
  eq("S2 entry 写点失败时 handler 抛错", threw, true);
  eq("S2 失败后 entries 零半包", await count(client, "time_entries"), 0);
  eq("S2 失败后 ledger 零半包", await count(client, "request_ledger"), 0);
  await client.execute("DROP TRIGGER fail_entry");
  const res = await Actions.addEntry.handler(ctx, { requestId: "s2-add-key-0001", ...ADD });
  eq("S2 原键重试 ok", res.ok, true);
  eq("S2 重试后 entries 恰 1 行", await count(client, "time_entries"), 1);
  eq("S2 重试后 ledger 恰 1 行", await count(client, "request_ledger"), 1);
}

// ------------------------------------------------------------ S3: same-key concurrency behind a read barrier
{
  // S3a: same key + same payload, both read empty ledger first.
  const { client, db } = await makeWorld();
  const newGate = makeGate(2);
  const ctxA = makeCtx(barrierDb(db, newGate()));
  const ctxB = makeCtx(barrierDb(db, newGate()));
  const args = { requestId: "s3-conc-same-01", ...ADD };
  const settled = await Promise.allSettled([
    Actions.addEntry.handler(ctxA, args),
    Actions.addEntry.handler(ctxB, args),
  ]);
  const oks = settled.filter((s) => s.status === "fulfilled" && s.value.ok);
  eq("S3a 并发同键同 payload 两边都 ok（胜者+replay）", oks.length, 2);
  eq("S3a entries 恰 1 行", await count(client, "time_entries"), 1);
  eq("S3a ledger 恰 1 行", await count(client, "request_ledger"), 1);
  const ids = new Set(oks.map((s) => s.value.entry?.id));
  eq("S3a 两边返回同一条目 id", ids.size, 1);
}
{
  // S3b: same key + different payload concurrently.
  const { client, db } = await makeWorld();
  const newGate = makeGate(2);
  const ctxA = makeCtx(barrierDb(db, newGate()));
  const ctxB = makeCtx(barrierDb(db, newGate()));
  const settled = await Promise.allSettled([
    Actions.addEntry.handler(ctxA, { requestId: "s3-conc-diff-01", ...ADD, note: "PAYLOAD-A" }),
    Actions.addEntry.handler(ctxB, { requestId: "s3-conc-diff-01", ...ADD, note: "PAYLOAD-B" }),
  ]);
  const results = settled.map((s) => (s.status === "fulfilled" ? s.value : { ok: false, error: "threw" }));
  eq("S3b 并发同键异 payload 恰一方 ok", results.filter((r) => r.ok).length, 1);
  eq("S3b 另一方为 typed conflict", results.filter((r) => !r.ok && r.error === "conflict").length, 1);
  eq("S3b entries 恰 1 行", await count(client, "time_entries"), 1);
  eq("S3b ledger 恰 1 行", await count(client, "request_ledger"), 1);
  const winner = results.find((r) => r.ok);
  eq("S3b 落行内容为赢家 payload", (await entryRows(client))[0]?.note, winner?.entry?.note);
}
{
  // S3c: same update key + same payload concurrently behind the barrier.
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  const add = await Actions.addEntry.handler(ctx, { requestId: "s3c-add-key-001", ...ADD });
  const entryId = add.entry.id;
  const newGate = makeGate(2);
  const ctxA = makeCtx(barrierDb(db, newGate()));
  const ctxB = makeCtx(barrierDb(db, newGate()));
  const upd = { requestId: "s3c-upd-key-001", entryId, ...ADD, note: "UPDATED" };
  const settled = await Promise.allSettled([
    Actions.updateEntry.handler(ctxA, upd),
    Actions.updateEntry.handler(ctxB, upd),
  ]);
  const oks = settled.filter((s) => s.status === "fulfilled" && s.value.ok);
  eq("S3c 并发同键 update 两边都 ok", oks.length, 2);
  eq("S3c entries 仍 1 行", await count(client, "time_entries"), 1);
  eq("S3c 该 update 键 ledger 恰 1 行", (await ledgerRow(client, "s3c-upd-key-001")) != null, true);
  eq("S3c ledger 总行数 = add+update 两行", await count(client, "request_ledger"), 2);
  eq("S3c 更新内容已落行", (await entryRows(client))[0]?.note, "UPDATED");
}

// ------------------------------------------------------------ S4: update fails at each write point
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  const add = await Actions.addEntry.handler(ctx, { requestId: "s4-add-key-0001", ...ADD });
  const entryId = add.entry.id;

  // S4a: failure at the body-update write point.
  await client.execute(
    "CREATE TRIGGER fail_upd BEFORE UPDATE ON time_entries BEGIN SELECT RAISE(ABORT, 'synthetic update failure'); END;",
  );
  let threw = false;
  try {
    await Actions.updateEntry.handler(ctx, { requestId: "s4-upd-key-0001", entryId, ...ADD, note: "V2" });
  } catch {
    threw = true;
  }
  eq("S4a update 写点失败时 handler 抛错", threw, true);
  eq("S4a 条目内容未变", (await entryRows(client))[0]?.note, "SYNTHETIC");
  eq("S4a 失败键未落 ledger", await ledgerRow(client, "s4-upd-key-0001"), null);
  await client.execute("DROP TRIGGER fail_upd");
  const retry = await Actions.updateEntry.handler(ctx, { requestId: "s4-upd-key-0001", entryId, ...ADD, note: "V2" });
  eq("S4a 原键重试 ok", retry.ok, true);
  eq("S4a 重试后内容为 V2", (await entryRows(client))[0]?.note, "V2");
  eq("S4a ledger 总行数 2", await count(client, "request_ledger"), 2);

  // S4b: failure at the ledger write point — the body update must roll back
  // with it (the old code applied the update first, then wrote the ledger).
  await client.execute(
    "CREATE TRIGGER fail_led2 BEFORE INSERT ON request_ledger BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END;",
  );
  threw = false;
  try {
    await Actions.updateEntry.handler(ctx, { requestId: "s4-upd-key-0002", entryId, ...ADD, note: "V3" });
  } catch {
    threw = true;
  }
  eq("S4b ledger 写点失败时 handler 抛错", threw, true);
  eq("S4b 条目内容仍为 V2（更新已回滚）", (await entryRows(client))[0]?.note, "V2");
  eq("S4b 失败键未落 ledger", await ledgerRow(client, "s4-upd-key-0002"), null);
  await client.execute("DROP TRIGGER fail_led2");
  const retry2 = await Actions.updateEntry.handler(ctx, { requestId: "s4-upd-key-0002", entryId, ...ADD, note: "V3" });
  eq("S4b 原键重试 ok", retry2.ok, true);
  eq("S4b 重试后内容为 V3", (await entryRows(client))[0]?.note, "V3");
  eq("S4b entries 仍 1 行", await count(client, "time_entries"), 1);
  eq("S4b ledger 总行数 3", await count(client, "request_ledger"), 3);
}

// ------------------------------------------------------------ S5: stale retry vs newer edit
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  const add = await Actions.addEntry.handler(ctx, { requestId: "s5-add-key-0001", ...ADD, note: "V1" });
  const entryId = add.entry.id;
  await Actions.updateEntry.handler(ctx, { requestId: "s5-upd-key-0001", entryId, ...ADD, note: "V2" });
  await Actions.updateEntry.handler(ctx, { requestId: "s5-upd-key-0002", entryId, ...ADD, note: "V3" });
  eq("S5 较新编辑已落行", (await entryRows(client))[0]?.note, "V3");
  // Late retry of the OLDER update (its response was lost): must resolve as
  // replay of the current state and must NOT roll the entry back to V2.
  const stale = await Actions.updateEntry.handler(ctx, { requestId: "s5-upd-key-0001", entryId, ...ADD, note: "V2" });
  eq("S5 旧 update 重试 ok（replay）", stale.ok, true);
  eq("S5 旧重试返回当前稿 V3", stale.entry?.note, "V3");
  eq("S5 旧重试未回滚新稿", (await entryRows(client))[0]?.note, "V3");
  // Late retry of the original add likewise returns the current稿, no dup.
  const staleAdd = await Actions.addEntry.handler(ctx, { requestId: "s5-add-key-0001", ...ADD, note: "V1" });
  eq("S5 原 add 重试 ok（replay）", staleAdd.ok, true);
  eq("S5 原 add 重试返回当前稿", staleAdd.entry?.note, "V3");
  eq("S5 entries 仍 1 行", await count(client, "time_entries"), 1);
  eq("S5 ledger 仍 3 行", await count(client, "request_ledger"), 3);
}

// ------------------------------------------------------------ S6: delete tombstone / late retries
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  const add = await Actions.addEntry.handler(ctx, { requestId: "s6-add-key-0001", ...ADD });
  const entryId = add.entry.id;
  await Actions.updateEntry.handler(ctx, { requestId: "s6-upd-key-0001", entryId, ...ADD, note: "EDITED" });
  const del = await Actions.deleteEntry.handler(ctx, { requestId: "s6-del-key-0001", entryId });
  eq("S6 delete ok", del.ok, true);
  eq("S6 删除后 entries 0 行", await count(client, "time_entries"), 0);
  eq("S6 ledger 三键保行（墓碑不删账本）", await count(client, "request_ledger"), 3);
  eq("S6 原 add 键已打墓碑标记", (await ledgerRow(client, "s6-add-key-0001"))?.deleted, 1);
  eq("S6 update 键已打墓碑标记", (await ledgerRow(client, "s6-upd-key-0001"))?.deleted, 1);

  const lateAdd = await Actions.addEntry.handler(ctx, { requestId: "s6-add-key-0001", ...ADD });
  eq("S6 已删条目原 add 键晚重试为 deleted", lateAdd.error, "deleted");
  eq("S6 晚重试不复活条目", await count(client, "time_entries"), 0);
  const lateUpd = await Actions.updateEntry.handler(ctx, { requestId: "s6-upd-key-0001", entryId, ...ADD, note: "EDITED" });
  eq("S6 已删条目 update 键晚重试为 deleted", lateUpd.error, "deleted");
  const lateDel = await Actions.deleteEntry.handler(ctx, { requestId: "s6-del-key-0001", entryId });
  eq("S6 delete 键 replay 仍 ok", lateDel.ok, true);
  const newKeyUpd = await Actions.updateEntry.handler(ctx, { requestId: "s6-upd-key-0002", entryId, ...ADD, note: "GHOST" });
  eq("S6 新键改已删条目为 deleted（非 not_found）", newKeyUpd.error, "deleted");
  eq("S6 墓碑判定不落新 ledger 行", await ledgerRow(client, "s6-upd-key-0002"), null);
  const ghostAdd = await Actions.addEntry.handler(ctx, { requestId: "s6-add-key-0002", ...ADD });
  eq("S6 新键同 payload 可正常新建（墓碑按条目不按内容）", ghostAdd.ok, true);
  eq("S6 新建后 entries 1 行", await count(client, "time_entries"), 1);
  const missing = await Actions.updateEntry.handler(ctx, { requestId: "s6-upd-key-0003", entryId: 999999, ...ADD });
  eq("S6 从不存在的 id 为 not_found", missing.error, "not_found");
}

// ------------------------------------------------------------ S7: guest / non-owner / delegate — zero read & write
{
  const { client, db } = await makeWorld();
  const owner = makeCtx(db);
  const seed = await Actions.addEntry.handler(owner, { requestId: "s7-add-key-0001", ...ADD });
  const entryId = seed.entry.id;
  const beforeEntries = await count(client, "time_entries");
  const beforeLedger = await count(client, "request_ledger");

  const guest = makeCtx(db, { owner: false });
  const dash = await Actions.getDashboard.handler(guest, {});
  eq("S7 guest getDashboard forbidden", dash.forbidden, true);
  eq("S7 guest getDashboard 零数据（detail 空）", dash.detail, null);
  eq("S7 guest getDashboard 零数据（weeks 空）", dash.weeks.length, 0);
  eq("S7 guest add 为 forbidden", (await Actions.addEntry.handler(guest, { requestId: "s7-guest-add-01", ...ADD })).error, "forbidden");
  eq("S7 guest update 为 forbidden", (await Actions.updateEntry.handler(guest, { requestId: "s7-guest-upd-01", entryId, ...ADD, note: "X" })).error, "forbidden");
  eq("S7 guest delete 为 forbidden", (await Actions.deleteEntry.handler(guest, { requestId: "s7-guest-del-01", entryId })).error, "forbidden");
  eq("S7 guest setPriorities 为 forbidden", (await Actions.setPriorities.handler(guest, { priorities: ["学习"] })).error, "forbidden");

  const agent = makeCtx(db, { delegate: "agent" });
  eq("S7 agent 委托 add 为 forbidden（manual-only）", (await Actions.addEntry.handler(agent, { requestId: "s7-agent-add-01", ...ADD })).error, "forbidden");
  const sched = makeCtx(db, { delegate: "schedule" });
  eq("S7 schedule 委托 update 为 forbidden（manual-only）", (await Actions.updateEntry.handler(sched, { requestId: "s7-sched-upd-01", entryId, ...ADD, note: "X" })).error, "forbidden");

  eq("S7 全部拒绝后 entries 行数不变", await count(client, "time_entries"), beforeEntries);
  eq("S7 全部拒绝后 ledger 行数不变", await count(client, "request_ledger"), beforeLedger);
  eq("S7 条目内容未被改动", (await entryRows(client))[0]?.note, "SYNTHETIC");
}

// ------------------------------------------------------------ S8 helpers: independent LA week math (no prod imports)
const laDtf = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function laParts(ms) {
  const p = {};
  for (const part of laDtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute), ss: Number(p.second) };
}
function laMidnightMs(y, m, d) {
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = laParts(guess);
    guess += Date.UTC(y, m - 1, d, 0, 0, 0) - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  }
  return guess;
}
function weekWindowContaining(ms) {
  const p = laParts(ms);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  const back = (dow + 6) % 7;
  const mon = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  const sy = mon.getUTCFullYear(), sm = mon.getUTCMonth() + 1, sd = mon.getUTCDate();
  const startMs = laMidnightMs(sy, sm, sd);
  const next = new Date(Date.UTC(sy, sm - 1, sd + 7));
  const endMs = laMidnightMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { startMs, endMs, totalHours: (endMs - startMs) / 3_600_000 };
}
function clipMin(iv, lo, hi) {
  const s = Math.max(iv.startMs, lo), e = Math.min(iv.endMs, hi);
  return e > s ? (e - s) / 60_000 : 0;
}
function unionMinutes(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0, cs = sorted[0].startMs, ce = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.startMs <= ce) ce = Math.max(ce, iv.endMs);
    else { total += ce - cs; cs = iv.startMs; ce = iv.endMs; }
  }
  return (total + ce - cs) / 60_000;
}

// ------------------------------------------------------------ S8: stats triple consistency (real zero / adjacent / overlap / cross-week / DST)
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  const H = 3_600_000;

  // Real zero: empty book is a true zero state, not missing data.
  const empty = await Actions.getDashboard.handler(ctx, {});
  eq("S8 空库 hasRecords=false", empty.detail.summary.hasRecords, false);
  eq("S8 空库 coverage=0", empty.detail.summary.coverageMinutes, 0);
  eq("S8 空库 categorySum=0", empty.detail.summary.categorySumMinutes, 0);
  eq("S8 空库 overlap=0", empty.detail.summary.overlapMinutes, 0);
  eq("S8 空库 cumulativeCoverage=0", empty.cumulativeCoverageMinutes, 0);
  eq("S8 空库 weeksWithRecords=0", empty.weeksWithRecords, 0);
  check("S8 空库当前周未覆盖为正数（真实流逝，非缺失）", empty.detail.uncoveredElapsedMinutes > 0);

  // Anchor the plan in the current LA week, or the previous one when run
  // early Monday before the planned hours have actually happened.
  let win = weekWindowContaining(Date.now());
  let detailArg = {};
  if (Date.now() < win.startMs + 14 * H) {
    win = weekWindowContaining(win.startMs - 1);
    detailArg = { weekStartMs: win.startMs };
  }
  const base = win.startMs + 10 * H; // Monday 10:00 LA of the anchor week
  const plan = [
    { requestId: "s8-add-key-0001", category: "学习", startMs: base, endMs: base + 60 * 60_000, note: "A" }, // 60m
    { requestId: "s8-add-key-0002", category: "工作", startMs: base + 60 * 60_000, endMs: base + 150 * 60_000, note: "B" }, // adjacent to A, 90m
    { requestId: "s8-add-key-0003", category: "创造", startMs: base + 120 * 60_000, endMs: base + 180 * 60_000, note: "C" }, // overlaps B by 30m
  ];
  for (const p of plan) {
    const r = await Actions.addEntry.handler(ctx, p);
    eq(`S8 落行 ${p.note} ok`, r.ok, true);
  }
  const dash = await Actions.getDashboard.handler(ctx, detailArg);
  const s = dash.detail.summary;
  eq("S8 相邻+交叠 coverage（并集 180）", s.coverageMinutes, 180);
  eq("S8 相邻+交叠 categorySum（60+90+60=210）", s.categorySumMinutes, 210);
  eq("S8 相邻+交叠 overlap（30）", s.overlapMinutes, 30);
  // Independent recomputation from raw SQL rows + ledger agreement.
  const rows = await entryRows(client);
  const clipped = rows
    .map((r) => ({ startMs: Math.max(r.startMs, win.startMs), endMs: Math.min(r.endMs, win.endMs) }))
    .filter((iv) => iv.endMs > iv.startMs);
  eq("S8 独立复算 coverage 与 handler 一致", unionMinutes(clipped), s.coverageMinutes);
  eq("S8 独立复算 categorySum 与 handler 一致", clipped.reduce((a, iv) => a + (iv.endMs - iv.startMs) / 60_000, 0), s.categorySumMinutes);
  eq("S8 逐行数 == ledger 行数（无孤儿/无重复）", rows.length, await count(client, "request_ledger"));
  eq("S8 锚定周 totalHours 与独立周窗一致", s.totalHours, win.totalHours);
  const catOf = Object.fromEntries(s.byCategory.map((c) => [c.category, c.minutes]));
  eq("S8 分类和逐项：学习 60", catOf["学习"], 60);
  eq("S8 分类和逐项：工作 90", catOf["工作"], 90);
  eq("S8 分类和逐项：创造 60", catOf["创造"], 60);

  // Cross-week entry: 2h before → 2h after this week's Monday boundary.
  const cross = await Actions.addEntry.handler(ctx, {
    requestId: "s8-add-key-0004", category: "休息睡眠",
    startMs: win.startMs - 2 * H, endMs: win.startMs + 2 * H, note: "CROSS",
  });
  eq("S8 跨周落行 ok", cross.ok, true);
  const dash2 = await Actions.getDashboard.handler(ctx, detailArg);
  const prev = dash2.weeks.find((w) => w.weekStartMs === weekWindowContaining(win.startMs - 1).startMs);
  const cur = dash2.weeks.find((w) => w.weekStartMs === win.startMs);
  eq("S8 跨周上周裁剪 coverage=120", prev?.coverageMinutes, 120);
  eq("S8 跨周本周 coverage=180+120", cur?.coverageMinutes, 300);
}
{
  // DST week lengths via independent math (same definition the handler uses;
  // the read-side validator pins the same values through the UI口径).
  eq("S8 春季 DST 周长 167h", weekWindowContaining(Date.UTC(2026, 2, 4, 12)).totalHours, 167);
  eq("S8 秋季 DST 周长 169h", weekWindowContaining(Date.UTC(2026, 9, 28, 12)).totalHours, 169);
  eq("S8 普通周周长 168h", weekWindowContaining(Date.UTC(2026, 9, 21, 12)).totalHours, 168);
}

// ------------------------------------------------------------ S9: migration preserves pre-ledger rows
{
  const { client, db } = await makeWorld();
  const ctx = makeCtx(db);
  // A row in the style of a record that predates the ledger (direct SQL, no
  // ledger row): migrations + new code must keep it byte-for-byte.
  const legacyStart = Date.UTC(2026, 9, 20, 15, 0, 0);
  await client.execute({
    sql: "INSERT INTO time_entries (category, start_ms, end_ms, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: ["家庭陪伴", legacyStart, legacyStart + 45 * 60_000, "LEGACY", legacyStart, legacyStart],
  });
  const beforeRows = await entryRows(client);
  eq("S9 旧记录落库 1 行", beforeRows.length, 1);
  const dash = await Actions.getDashboard.handler(ctx, {});
  check("S9 旧记录可被 dashboard 读到", dash.detail.entries.some((e) => e.note === "LEGACY"));
  const legacyId = beforeRows[0].id;
  const upd = await Actions.updateEntry.handler(ctx, {
    requestId: "s9-upd-key-0001", entryId: legacyId,
    category: "家庭陪伴", startMs: legacyStart, endMs: legacyStart + 45 * 60_000, note: "LEGACY-EDITED",
  });
  eq("S9 旧记录可被新键 update", upd.ok, true);
  eq("S9 update 后仍 1 行（不新增）", await count(client, "time_entries"), 1);
  eq("S9 update 的 ledger 与主体同批落行", (await ledgerRow(client, "s9-upd-key-0001"))?.entryId, legacyId);
  const afterRows = await entryRows(client);
  eq("S9 旧记录时间段未被改动", afterRows[0]?.startMs, legacyStart);
  eq("S9 旧记录分类未被改动", afterRows[0]?.category, "家庭陪伴");
}

// ------------------------------------------------------------ report
const total = passed + failed;
console.log(`validate-time-atomicity: ${passed}/${total} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
