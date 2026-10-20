// CMP-LEARN-SAVE-001 validation — atomic first-conversion arbitration
// and revocation tombstones on the saveOutput / markConverted write
// paths.
//
// Covers:
//   - source wiring: both conversion actions route through the shared
//     arbitrateConversion; the claim is a conditional UPDATE guarded
//     by converted_at IS NULL with .returning(); receipts are written
//     in the same batch; unmark tombstones receipts (revokedAt) and
//     never deletes them;
//   - concurrency: same/different requestId x same/different payload,
//     in both launch orders — exactly one first conversion wins, the
//     loser gets alreadyConverted with the winner's convertedAt and
//     output, and the stored row is always the winner's;
//   - saveOutput x markConverted racing on the same input;
//   - lost response: same key + same payload retry replays the
//     original result; same key + different payload is a conflict;
//   - revocation: unmark tombstones the receipt; a late retry with the
//     old key returns "revoked" and writes nothing; a fresh requestId
//     re-marks successfully as a new generation;
//   - write failures: a failing batch applies nothing and loses no
//     existing output; a failing unmark leaves the conversion intact;
//   - curve/cohort consistency: totals, series and cohorts all follow
//     the single first convertedAt through convert/revoke/re-mark;
//   - guest / anonymous: zero database access, zero rows anywhere;
//   - legacy rows (converted before receipts existed, with and without
//     a stored key): read back exactly as stored, never backfilled,
//     a new key only echoes alreadyConverted, unmark + fresh key
//     converts as a new generation;
//   - legacy KEYED rows revoked after the upgrade: unmark materializes
//     a revoked receipt for the stored key in the same atomic batch,
//     so late saveOutput/markConverted retries with that key are
//     rejected as "revoked" and never resurrect or re-count the
//     conversion; legacy KEYLESS rows get no fabricated key/receipt;
//     a failing unmark batch preserves the conversion, the stored key
//     and the absence of any tombstone.
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-conversion.mjs
import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
let failures = 0;
function check(name, ok, note = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${note ? ` (${note})` : ""}`);
}

/* ---------------- source wiring ---------------- */

const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");

function actionSlice(src, name) {
  const start = src.indexOf(`  ${name}: defineAction({`);
  if (start < 0) throw new Error(`action ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n  \w+: defineAction\(\{/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

check(
  "source: arbitrateConversion uses a conditional claim (converted_at IS NULL) with RETURNING",
  serverSrc.includes("isNull(schema.learningInputs.convertedAt)") &&
    serverSrc.includes(".returning()"),
);
check(
  "source: claim and receipt insert are one atomic batch",
  serverSrc.includes("db.batch([") &&
    serverSrc.includes("db.insert(schema.conversionReceipts)"),
);
check(
  "source: saveOutput routes through arbitrateConversion",
  actionSlice(serverSrc, "saveOutput").includes("arbitrateConversion"),
);
check(
  "source: markConverted routes through arbitrateConversion (shared path)",
  actionSlice(serverSrc, "markConverted").includes("arbitrateConversion"),
);
{
  const unmark = actionSlice(serverSrc, "unmarkConverted");
  check(
    "source: unmark tombstones receipts (revokedAt) and never deletes them",
    unmark.includes("revokedAt") && !unmark.includes("delete(schema.conversionReceipts"),
  );
  check(
    "source: unmark materializes a revoked receipt for a stored legacy key (payload fingerprint from the row itself)",
    unmark.includes("conversionPayloadHash") &&
      unmark.includes("onConflictDoNothing") &&
      unmark.includes("conversionRequestId"),
  );
}
check(
  "source: payload identity is a SHA-256 hash of (outputType, outputNote)",
  serverSrc.includes("conversionPayloadHash") && serverSrc.includes("sha256Hex"),
);

/* ---------------- harness ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");
const { eq } = await import("drizzle-orm");

async function freshDb() {
  const client = createClient({ url: ":memory:" });
  const migrationDir = new URL("./drizzle/", import.meta.url);
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file, migrationDir), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
  return drizzle(client, { schema });
}

const OWNER = { id: "owner-1", isOwner: true };
function makeCtx(db, viewer = OWNER, wrap) {
  const state = { dbCalls: 0 };
  const ctx = {
    slug: "space-10-validate-conversion",
    invocationId: "validate-conversion",
    spaceDir: "",
    viewer,
    db: () => {
      state.dbCalls += 1;
      return wrap ? wrap(db) : db;
    },
    invalidateQueries: () => {},
    executePrivileged: async () => {
      throw new Error("no privileged contracts in validate");
    },
  };
  return { ctx, state };
}

async function call(ctx, name, args) {
  const action = Actions[name];
  const parsedArgs = action.request.parse(args);
  const res = await action.handler(ctx, parsedArgs);
  action.response.parse(res);
  return res;
}

async function rowOf(db, id) {
  const rows = await db
    .select()
    .from(schema.learningInputs)
    .where(eq(schema.learningInputs.id, id))
    .limit(1);
  return rows[0];
}
async function receiptsOf(db, inputId) {
  return db
    .select()
    .from(schema.conversionReceipts)
    .where(eq(schema.conversionReceipts.inputId, inputId));
}
async function newInput(ctx, topic) {
  const rec = await call(ctx, "recordLearningInput", {
    sourceType: "article",
    topic,
    minutes: 10,
  });
  if (!rec.ok || rec.id == null) throw new Error("recordLearningInput failed");
  return rec.id;
}

/* ---------------- concurrency: key x payload, both orders ---------------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {}); // seed skills

  // Order A-then-B, different keys, different payloads.
  const idAB = await newInput(ctx, "并发 AB");
  const [a1, b1] = await Promise.all([
    call(ctx, "saveOutput", { inputId: idAB, requestId: "race-a", outputType: "note", outputNote: "产出 A" }),
    call(ctx, "saveOutput", { inputId: idAB, requestId: "race-b", outputType: "project", outputNote: "产出 B" }),
  ]);
  const rowAB = await rowOf(db, idAB);
  const winnersAB = [a1, b1].filter((r) => r.status === "converted");
  const losersAB = [a1, b1].filter((r) => r.status === "alreadyConverted");
  check(
    "race (A,B) diff keys/payloads: exactly one converts, the other alreadyConverted",
    winnersAB.length === 1 && losersAB.length === 1 && a1.ok && b1.ok,
    `a=${a1.status} b=${b1.status}`,
  );
  const winnerAB = winnersAB[0];
  const loserAB = losersAB[0];
  check(
    "race (A,B): loser echoes the winner's convertedAt and output",
    loserAB.convertedAt === winnerAB.convertedAt &&
      loserAB.outputNote === winnerAB.outputNote &&
      loserAB.outputType === winnerAB.outputType,
  );
  check(
    "race (A,B): stored row is the winner's (output, key, first convertedAt untouched by loser)",
    rowAB.outputNote === winnerAB.outputNote &&
      rowAB.outputType === winnerAB.outputType &&
      rowAB.conversionRequestId === (winnerAB === a1 ? "race-a" : "race-b") &&
      rowAB.convertedAt?.toISOString() === winnerAB.convertedAt,
  );

  // Order B-then-A on a fresh input: symmetric outcome.
  const idBA = await newInput(ctx, "并发 BA");
  const [b2, a2] = await Promise.all([
    call(ctx, "saveOutput", { inputId: idBA, requestId: "race-b2", outputType: "project", outputNote: "产出 B" }),
    call(ctx, "saveOutput", { inputId: idBA, requestId: "race-a2", outputType: "note", outputNote: "产出 A" }),
  ]);
  const rowBA = await rowOf(db, idBA);
  check(
    "race (B,A) diff keys/payloads: exactly one converts; row matches that winner",
    [a2, b2].filter((r) => r.status === "converted").length === 1 &&
      [a2, b2].filter((r) => r.status === "alreadyConverted").length === 1 &&
      rowBA.outputNote === (a2.status === "converted" ? a2 : b2).outputNote &&
      rowBA.convertedAt?.toISOString() === (a2.status === "converted" ? a2 : b2).convertedAt,
    `a=${a2.status} b=${b2.status}`,
  );

  // Same key + same payload concurrently (double-submit): one
  // converts, the other replays as alreadyConverted with identical
  // result; exactly one receipt exists.
  const idSame = await newInput(ctx, "同键并发");
  const [s1, s2] = await Promise.all([
    call(ctx, "saveOutput", { inputId: idSame, requestId: "race-same", outputType: "note", outputNote: "同一产出" }),
    call(ctx, "saveOutput", { inputId: idSame, requestId: "race-same", outputType: "note", outputNote: "同一产出" }),
  ]);
  const receiptsSame = await receiptsOf(db, idSame);
  check(
    "race same key+payload: one converted + one idempotent replay, one receipt",
    [s1, s2].filter((r) => r.status === "converted").length === 1 &&
      [s1, s2].filter((r) => r.status === "alreadyConverted").length === 1 &&
      s1.convertedAt === s2.convertedAt &&
      receiptsSame.length === 1,
    `s1=${s1.status} s2=${s2.status} receipts=${receiptsSame.length}`,
  );

  // Same key + different payloads concurrently: the key binds to one
  // payload only; the other is a conflict and never overwrites.
  const idDiff = await newInput(ctx, "同键异载荷并发");
  const [d1, d2] = await Promise.all([
    call(ctx, "saveOutput", { inputId: idDiff, requestId: "race-diff", outputType: "note", outputNote: "载荷一" }),
    call(ctx, "saveOutput", { inputId: idDiff, requestId: "race-diff", outputType: "note", outputNote: "载荷二" }),
  ]);
  const rowDiff = await rowOf(db, idDiff);
  const statuses = [d1.status, d2.status].sort().join("/");
  check(
    "race same key diff payloads: one converts, the other conflicts; row holds the converted payload",
    (statuses === "conflict/converted" || statuses === "alreadyConverted/conflict") &&
      rowDiff.outputNote === (d1.status === "converted" || d1.status === "alreadyConverted" ? d1 : d2).outputNote &&
      [d1, d2].filter((r) => r.status === "conflict").length === 1,
    `d1=${d1.status} d2=${d2.status}`,
  );
}

/* ---------------- saveOutput x markConverted race ---------------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {});
  const id = await newInput(ctx, "save 与 mark 并发");
  const [sv, mk] = await Promise.all([
    call(ctx, "saveOutput", { inputId: id, requestId: "x-save", outputType: "note", outputNote: "save 的产出" }),
    call(ctx, "markConverted", { id, requestId: "x-mark", outputType: "decision", outputNote: "mark 的产出" }),
  ]);
  const row = await rowOf(db, id);
  const dash = await call(ctx, "getDashboard", {});
  check(
    "save x mark race: exactly one conversion, counted once",
    (sv.status === "converted") !== (mk.status === "converted") &&
      (sv.status === "converted" ? mk.status : sv.status) === "alreadyConverted" &&
      dash.totals.totalConverted === 1 &&
      row.outputNote === (sv.status === "converted" ? "save 的产出" : "mark 的产出"),
    `save=${sv.status} mark=${mk.status}`,
  );
}

/* ---------------- lost response / idempotent replay / conflict ---------------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {});
  const id = await newInput(ctx, "丢响应重试");
  const first = await call(ctx, "saveOutput", {
    inputId: id, requestId: "lost-1", outputType: "experiment", outputNote: "原始产出",
  });
  check("lost-response setup: first save converts", first.status === "converted" && first.ok === true);
  const replay = await call(ctx, "saveOutput", {
    inputId: id, requestId: "lost-1", outputType: "experiment", outputNote: "原始产出",
  });
  check(
    "same key + same payload after lost response: idempotent replay of the original result",
    replay.ok === true && replay.status === "alreadyConverted" &&
      replay.convertedAt === first.convertedAt && replay.outputNote === "原始产出",
  );
  const conflict = await call(ctx, "saveOutput", {
    inputId: id, requestId: "lost-1", outputType: "experiment", outputNote: "改过的产出",
  });
  const rowAfter = await rowOf(db, id);
  check(
    "same key + different payload: conflict, rejected, stored output untouched",
    conflict.ok === false && conflict.status === "conflict" &&
      rowAfter.outputNote === "原始产出" && rowAfter.convertedAt?.toISOString() === first.convertedAt,
  );
  const crossInput = await newInput(ctx, "另一条输入");
  const reused = await call(ctx, "saveOutput", {
    inputId: crossInput, requestId: "lost-1", outputType: "experiment", outputNote: "原始产出",
  });
  check(
    "same key reused for a different input: conflict, that input stays unconverted",
    reused.ok === false && reused.status === "conflict" &&
      (await rowOf(db, crossInput)).convertedAt === null,
  );
}

/* ---------------- revocation tombstone / new generation ---------------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {});
  const id = await newInput(ctx, "撤销与重标");
  const saved = await call(ctx, "saveOutput", {
    inputId: id, requestId: "gen-1", outputType: "note", outputNote: "第一代产出",
  });
  check("revoke setup: generation 1 converts", saved.status === "converted");
  await call(ctx, "unmarkConverted", { id });
  const rowRevoked = await rowOf(db, id);
  const receipts = await receiptsOf(db, id);
  check(
    "unmark: row unconverted; receipt kept as a tombstone (revokedAt stamped, row not deleted)",
    rowRevoked.convertedAt === null && rowRevoked.conversionRequestId === null &&
      receipts.length === 1 && receipts[0].revokedAt != null && receipts[0].requestId === "gen-1",
  );
  const late = await call(ctx, "saveOutput", {
    inputId: id, requestId: "gen-1", outputType: "note", outputNote: "第一代产出",
  });
  const rowAfterLate = await rowOf(db, id);
  check(
    "late retry with the revoked key: status revoked, ok false, nothing written (no resurrection)",
    late.ok === false && late.status === "revoked" &&
      rowAfterLate.convertedAt === null && rowAfterLate.outputNote === null,
  );
  const lateMark = await call(ctx, "markConverted", {
    id, requestId: "gen-1", outputType: "note", outputNote: "第一代产出",
  });
  check(
    "late retry via markConverted with the revoked key: also revoked, still unconverted",
    lateMark.ok === false && lateMark.status === "revoked" &&
      (await rowOf(db, id)).convertedAt === null,
  );
  const remark = await call(ctx, "saveOutput", {
    inputId: id, requestId: "gen-2", outputType: "project", outputNote: "第二代产出",
  });
  const rowGen2 = await rowOf(db, id);
  check(
    "fresh requestId re-marks as a new generation with a new conversion instant",
    remark.ok === true && remark.status === "converted" &&
      rowGen2.outputNote === "第二代产出" && rowGen2.conversionRequestId === "gen-2" &&
      typeof remark.convertedAt === "string" && remark.convertedAt >= saved.convertedAt,
  );
  const receipts2 = await receiptsOf(db, id);
  check(
    "generations coexist: gen-1 tombstone + gen-2 live receipt",
    receipts2.length === 2 &&
      receipts2.find((r) => r.requestId === "gen-1")?.revokedAt != null &&
      receipts2.find((r) => r.requestId === "gen-2")?.revokedAt == null,
  );
}

/* ---------------- write failures lose nothing ---------------- */

{
  const db = await freshDb();
  const failBatch = (real) =>
    new Proxy(real, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (prop === "batch") {
          return async () => {
            throw new Error("injected batch failure");
          };
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const { ctx: okCtx } = makeCtx(db);
  const { ctx: failCtx } = makeCtx(db, OWNER, failBatch);
  await call(okCtx, "getDashboard", {});

  const idNew = await newInput(okCtx, "写失败的新输入");
  const failedSave = await call(failCtx, "saveOutput", {
    inputId: idNew, requestId: "fail-1", outputType: "note", outputNote: "不应落库",
  });
  check(
    "failed conversion write: status error, row stays unconverted, no receipt left behind",
    failedSave.ok === false && failedSave.status === "error" &&
      (await rowOf(db, idNew)).convertedAt === null &&
      (await receiptsOf(db, idNew)).length === 0,
  );
  const healed = await call(okCtx, "saveOutput", {
    inputId: idNew, requestId: "fail-1", outputType: "note", outputNote: "不应落库",
  });
  check(
    "same key succeeds once writes recover (the failed attempt reserved nothing)",
    healed.ok === true && healed.status === "converted",
  );

  const idOld = await newInput(okCtx, "已有产出的输入");
  const kept = await call(okCtx, "saveOutput", {
    inputId: idOld, requestId: "keep-1", outputType: "note", outputNote: "既有产出",
  });
  let unmarkThrew = false;
  try {
    await call(failCtx, "unmarkConverted", { id: idOld });
  } catch {
    unmarkThrew = true;
  }
  const rowKept = await rowOf(db, idOld);
  check(
    "failed unmark: error surfaces and the existing output survives intact",
    unmarkThrew === true &&
      rowKept.convertedAt?.toISOString() === kept.convertedAt &&
      rowKept.outputNote === "既有产出" && rowKept.conversionRequestId === "keep-1",
  );
  const failedSecond = await call(failCtx, "saveOutput", {
    inputId: idOld, requestId: "keep-2", outputType: "note", outputNote: "不该覆盖",
  });
  check(
    "failed write against a converted input: alreadyConverted echo, output intact",
    failedSecond.status === "alreadyConverted" &&
      (await rowOf(db, idOld)).outputNote === "既有产出",
  );
}

/* ---------------- curve / cohort follow the first convertedAt ---------------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  const dash0 = await call(ctx, "getDashboard", {});
  const today = dash0.today;
  const id = await newInput(ctx, "曲线口径");
  const saved = await call(ctx, "saveOutput", {
    inputId: id, requestId: "curve-1", outputType: "note", outputNote: "曲线产出",
  });
  const dash1 = await call(ctx, "getDashboard", {});
  const todayPoint = dash1.series.find((p) => p.date === today);
  const dashRow = dash1.inputs.find((r) => r.id === id);
  check(
    "curve/cohort: conversion lands on today's series point and in the cohort, stamped with the first convertedAt",
    dash1.totals.totalConverted === 1 && todayPoint?.converted === 1 &&
      dash1.totals.cohorts.all.convertedInputs === 1 &&
      dashRow?.convertedAt === saved.convertedAt,
    `row=${dashRow?.convertedAt} saved=${saved.convertedAt}`,
  );
  await call(ctx, "unmarkConverted", { id });
  const late = await call(ctx, "saveOutput", {
    inputId: id, requestId: "curve-1", outputType: "note", outputNote: "曲线产出",
  });
  const dash2 = await call(ctx, "getDashboard", {});
  check(
    "curve/cohort: revoked + late old-key retry leaves totals, series and cohort at zero converted",
    late.status === "revoked" && dash2.totals.totalConverted === 0 &&
      dash2.series.find((p) => p.date === today)?.converted === 0 &&
      dash2.totals.cohorts.all.convertedInputs === 0,
  );
  const remark = await call(ctx, "markConverted", {
    id, requestId: "curve-2", outputType: "note", outputNote: "曲线产出",
  });
  const dash3 = await call(ctx, "getDashboard", {});
  check(
    "curve/cohort: new-generation re-mark counts exactly once, on the new first convertedAt",
    remark.status === "converted" && dash3.totals.totalConverted === 1 &&
      dash3.series.find((p) => p.date === today)?.converted === 1 &&
      dash3.totals.cohorts.all.convertedInputs === 1 &&
      dash3.inputs.find((r) => r.id === id)?.convertedAt != null,
  );
}

/* ---------------- guest / anonymous: zero DB ---------------- */

{
  const db = await freshDb();
  for (const [label, viewer] of [
    ["non-owner", { id: "someone-else", isOwner: false }],
    ["anonymous", null], // null = no viewer at all (set below)
  ]) {
    const { ctx, state } = makeCtx(db, OWNER);
    if (viewer === null) ctx.viewer = undefined;
    else ctx.viewer = viewer;
    const save = await call(ctx, "saveOutput", {
      inputId: 1, requestId: "guest-1", outputType: "note", outputNote: "越权产出",
    });
    const mark = await call(ctx, "markConverted", {
      id: 1, requestId: "guest-1", outputType: "note", outputNote: "越权产出",
    });
    const unmark = await call(ctx, "unmarkConverted", { id: 1 });
    check(
      `${label}: conversion actions refused with status refused`,
      save.ok === false && save.forbidden === true && save.status === "refused" &&
        mark.ok === false && mark.forbidden === true && mark.status === "refused" &&
        unmark.ok === false && unmark.forbidden === true,
    );
    check(`${label}: zero database access`, state.dbCalls === 0, `dbCalls=${state.dbCalls}`);
  }
  const inputs = await db.select({ id: schema.learningInputs.id }).from(schema.learningInputs);
  const receipts = await db.select({ requestId: schema.conversionReceipts.requestId }).from(schema.conversionReceipts);
  check(
    "guest storm wrote zero rows (inputs and receipts both empty)",
    inputs.length === 0 && receipts.length === 0,
  );
}

/* ---------------- legacy rows: no fabricated keys, facts preserved ---------------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {});
  const legacyInstant = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  // Pre-receipts conversion WITHOUT any key (pre-0003 style fact).
  const legacyKeyless = await db
    .insert(schema.learningInputs)
    .values({
      date: "2026-10-10",
      sourceType: "article",
      topic: "旧档无键转化",
      minutes: 0,
      convertedAt: legacyInstant,
      outputType: "note",
      outputNote: "旧产出",
      conversionRequestId: null,
    })
    .returning({ id: schema.learningInputs.id });
  const keylessId = legacyKeyless[0].id;
  // Post-0003 / pre-0004 conversion WITH a stored key but no receipt.
  const legacyKeyed = await db
    .insert(schema.learningInputs)
    .values({
      date: "2026-10-11",
      sourceType: "video",
      topic: "旧档有键无回执",
      minutes: 25,
      convertedAt: legacyInstant,
      outputType: "experiment",
      outputNote: "旧键产出",
      conversionRequestId: "legacy-key",
    })
    .returning({ id: schema.learningInputs.id });
  const keyedId = legacyKeyed[0].id;

  const dash = await call(ctx, "getDashboard", {});
  check(
    "legacy rows read back exactly as stored (converted, original outputs, legacy 0 minutes kept)",
    dash.inputs.find((r) => r.id === keylessId)?.converted === true &&
      dash.inputs.find((r) => r.id === keylessId)?.outputNote === "旧产出" &&
      dash.inputs.find((r) => r.id === keylessId)?.minutes === 0 &&
      dash.inputs.find((r) => r.id === keyedId)?.outputNote === "旧键产出" &&
      dash.totals.totalConverted === 2,
  );
  const echo = await call(ctx, "saveOutput", {
    inputId: keylessId, requestId: "brand-new-key", outputType: "project", outputNote: "不该覆盖旧产出",
  });
  const keylessRow = await rowOf(db, keylessId);
  check(
    "legacy keyless row: a new key only echoes alreadyConverted with the original instant; nothing rewritten, no key fabricated",
    echo.ok === true && echo.status === "alreadyConverted" &&
      echo.convertedAt === legacyInstant.toISOString() && echo.outputNote === "旧产出" &&
      keylessRow.outputNote === "旧产出" && keylessRow.conversionRequestId === null &&
      keylessRow.convertedAt?.getTime() === legacyInstant.getTime(),
  );
  const echo2 = await call(ctx, "saveOutput", {
    inputId: keyedId, requestId: "another-new-key", outputType: "note", outputNote: "也不该覆盖",
  });
  const keyedRow = await rowOf(db, keyedId);
  check(
    "legacy keyed row: stored key preserved (not overwritten by the echoing call)",
    echo2.status === "alreadyConverted" && keyedRow.conversionRequestId === "legacy-key" &&
      keyedRow.outputNote === "旧键产出",
  );
  check(
    "no receipt was fabricated for either legacy conversion",
    (await receiptsOf(db, keylessId)).length === 0 && (await receiptsOf(db, keyedId)).length === 0,
  );
  await call(ctx, "unmarkConverted", { id: keyedId });
  const reGen = await call(ctx, "saveOutput", {
    inputId: keyedId, requestId: "post-legacy-gen", outputType: "note", outputNote: "撤销旧档后新转化",
  });
  check(
    "legacy row unmarked then re-marked with a fresh key: converts as a new generation",
    reGen.ok === true && reGen.status === "converted" &&
      (await rowOf(db, keyedId)).outputNote === "撤销旧档后新转化",
  );
}

/* -------- legacy KEYED rows: revocation must leave a tombstone -------- */
// A conversion recorded before the receipt table existed (pre-0004)
// carries its real request key on the input row but has NO receipt.
// Revoking it used to clear the row's key and tombstone nothing, so a
// late retry with the same key + payload found neither receipt nor
// conversion and silently resurrected (and re-counted) the conversion.
// The fix: unmark materializes the revocation fact for that stored key
// — a revoked receipt built only from the row's own key, payload and
// first-conversion instant — inside the same atomic batch.

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {});
  const legacyInstant = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const inserted = await db
    .insert(schema.learningInputs)
    .values({
      date: "2026-10-11",
      sourceType: "video",
      topic: "旧档有键撤销留墓碑",
      minutes: 25,
      convertedAt: legacyInstant,
      outputType: "experiment",
      outputNote: "旧键产出（撤销目标）",
      conversionRequestId: "legacy-revoke-key",
    })
    .returning({ id: schema.learningInputs.id });
  const id = inserted[0].id;

  await call(ctx, "unmarkConverted", { id });
  const rowAfterUnmark = await rowOf(db, id);
  const tombs = await receiptsOf(db, id);
  check(
    "legacy keyed: unmark materializes ONE revoked receipt for the stored key (key, payload, original instant all from the row)",
    rowAfterUnmark.convertedAt === null &&
      rowAfterUnmark.conversionRequestId === null &&
      tombs.length === 1 &&
      tombs[0].requestId === "legacy-revoke-key" &&
      tombs[0].revokedAt != null &&
      tombs[0].convertedAt === legacyInstant.getTime() &&
      tombs[0].outputType === "experiment" &&
      tombs[0].outputNote === "旧键产出（撤销目标）",
    `receipts=${tombs.length}`,
  );
  const lateSave = await call(ctx, "saveOutput", {
    inputId: id, requestId: "legacy-revoke-key", outputType: "experiment", outputNote: "旧键产出（撤销目标）",
  });
  const rowAfterLateSave = await rowOf(db, id);
  check(
    "legacy keyed: late saveOutput with the old key + same payload is rejected as revoked; the fact does not resurrect",
    lateSave.ok === false && lateSave.status === "revoked" &&
      rowAfterLateSave.convertedAt === null &&
      rowAfterLateSave.outputNote === null &&
      rowAfterLateSave.conversionRequestId === null,
  );
  const lateMark = await call(ctx, "markConverted", {
    id, requestId: "legacy-revoke-key", outputType: "experiment", outputNote: "旧键产出（撤销目标）",
  });
  check(
    "legacy keyed: late markConverted with the old key is also rejected as revoked",
    lateMark.ok === false && lateMark.status === "revoked" &&
      (await rowOf(db, id)).convertedAt === null,
  );
  const dash = await call(ctx, "getDashboard", {});
  const todayPoint = dash.series.find((p) => p.date === dash.today);
  check(
    "legacy keyed: after unmark + late retries, curve and cohort count zero converted for the input",
    dash.totals.totalConverted === 0 &&
      dash.totals.cohorts.all.convertedInputs === 0 &&
      todayPoint?.converted === 0 &&
      dash.inputs.find((r) => r.id === id)?.converted === false,
  );
  const remark = await call(ctx, "saveOutput", {
    inputId: id, requestId: "legacy-new-gen", outputType: "note", outputNote: "新代次产出",
  });
  const receiptsAfter = await receiptsOf(db, id);
  check(
    "legacy keyed: fresh requestId re-marks as a new generation; the materialized tombstone coexists",
    remark.ok === true && remark.status === "converted" &&
      (await rowOf(db, id)).conversionRequestId === "legacy-new-gen" &&
      receiptsAfter.length === 2 &&
      receiptsAfter.find((r) => r.requestId === "legacy-revoke-key")?.revokedAt != null &&
      receiptsAfter.find((r) => r.requestId === "legacy-new-gen")?.revokedAt == null,
  );
  const lateAgain = await call(ctx, "saveOutput", {
    inputId: id, requestId: "legacy-revoke-key", outputType: "experiment", outputNote: "旧键产出（撤销目标）",
  });
  check(
    "legacy keyed: the old key stays revoked even after the new generation converted",
    lateAgain.ok === false && lateAgain.status === "revoked" &&
      (await rowOf(db, id)).outputNote === "新代次产出",
  );
}

/* -------- legacy KEYLESS rows: unmark must not fabricate anything -------- */

{
  const db = await freshDb();
  const { ctx } = makeCtx(db);
  await call(ctx, "getDashboard", {});
  const legacyInstant = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  const inserted = await db
    .insert(schema.learningInputs)
    .values({
      date: "2026-10-09",
      sourceType: "article",
      topic: "旧档无键撤销",
      minutes: 0,
      convertedAt: legacyInstant,
      outputType: "note",
      outputNote: "无键旧产出",
      conversionRequestId: null,
    })
    .returning({ id: schema.learningInputs.id });
  const id = inserted[0].id;
  await call(ctx, "unmarkConverted", { id });
  const row = await rowOf(db, id);
  check(
    "legacy keyless: unmark fabricates no key and no receipt ('unknown' semantics preserved)",
    row.convertedAt === null && row.outputNote === null &&
      row.conversionRequestId === null &&
      (await receiptsOf(db, id)).length === 0,
  );
  const lateKeyed = await call(ctx, "saveOutput", {
    inputId: id, requestId: "never-seen-key", outputType: "note", outputNote: "无键旧产出",
  });
  check(
    "legacy keyless: after unmark, an arbitrary key is just a fresh conversion (no phantom tombstone blocks or revives)",
    lateKeyed.ok === true && lateKeyed.status === "converted" &&
      (await rowOf(db, id)).convertedAt !== null,
  );
}

/* -------- legacy KEYED rows: write-point failures preserve old state -------- */

{
  const db = await freshDb();
  const failBatch = (real) =>
    new Proxy(real, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (prop === "batch") {
          return async () => {
            throw new Error("injected batch failure");
          };
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const { ctx: okCtx } = makeCtx(db);
  const { ctx: failCtx } = makeCtx(db, OWNER, failBatch);
  await call(okCtx, "getDashboard", {});
  const failInstant = new Date(Date.now() - 24 * 3600 * 1000);
  const inserted = await db
    .insert(schema.learningInputs)
    .values({
      date: "2026-10-12",
      sourceType: "course",
      topic: "旧档有键撤销写失败",
      minutes: 40,
      convertedAt: failInstant,
      outputType: "project",
      outputNote: "失败注入下须保全的产出",
      conversionRequestId: "legacy-fail-key",
    })
    .returning({ id: schema.learningInputs.id });
  const id = inserted[0].id;

  let threw = false;
  try {
    await call(failCtx, "unmarkConverted", { id });
  } catch {
    threw = true;
  }
  const rowKept = await rowOf(db, id);
  check(
    "legacy keyed: failing unmark batch preserves the conversion, the stored key AND writes no tombstone",
    threw === true &&
      rowKept.convertedAt?.getTime() === failInstant.getTime() &&
      rowKept.outputNote === "失败注入下须保全的产出" &&
      rowKept.conversionRequestId === "legacy-fail-key" &&
      (await receiptsOf(db, id)).length === 0,
  );
  await call(okCtx, "unmarkConverted", { id });
  const lateFail = await call(failCtx, "saveOutput", {
    inputId: id, requestId: "legacy-fail-key", outputType: "project", outputNote: "失败注入下须保全的产出",
  });
  const rowAfterFail = await rowOf(db, id);
  const tombsAfterFail = await receiptsOf(db, id);
  check(
    "legacy keyed: after a healed unmark, the tombstone exists and a failing late retry still cannot resurrect",
    lateFail.ok === false && lateFail.status === "revoked" &&
      rowAfterFail.convertedAt === null &&
      tombsAfterFail.length === 1 && tombsAfterFail[0].revokedAt != null,
  );
  const failedNewGen = await call(failCtx, "saveOutput", {
    inputId: id, requestId: "legacy-fail-new", outputType: "note", outputNote: "新代次不应落库",
  });
  check(
    "legacy keyed: failing new-generation write after revocation applies nothing (row unconverted, tombstone untouched)",
    failedNewGen.ok === false && failedNewGen.status === "error" &&
      (await rowOf(db, id)).convertedAt === null &&
      (await receiptsOf(db, id)).length === 1,
  );
  const healedNewGen = await call(okCtx, "saveOutput", {
    inputId: id, requestId: "legacy-fail-new", outputType: "note", outputNote: "新代次不应落库",
  });
  check(
    "legacy keyed: the new-generation key converts once writes recover",
    healedNewGen.ok === true && healedNewGen.status === "converted" &&
      (await rowOf(db, id)).outputNote === "新代次不应落库",
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
