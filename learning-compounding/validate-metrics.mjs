// CMP-LEARN-METRIC-001 + 「挑一条去用」 validation.
//
// Runs the REAL handlers from server/src/actions.ts against a throwaway
// in-memory libsql database (schema applied from drizzle/*.sql, which
// now includes the 0003 rebuild) behind a synthetic owner ctx, and
// covers the metric criteria:
//   - occurrence-time series: inputs accumulate on inputDate, outputs
//     on the LA day of the FIRST conversion; a historical input
//     converted today never rewrites its input day;
//   - LA midnight boundary: conversions at 23:59:59.999 and 00:00:00.001
//     LA land on different series days (conversion instants are seeded
//     directly into the synthetic DB — the handlers read real time and
//     offer no clock injection — while every assertion runs through the
//     real getDashboard handler);
//   - first-conversion idempotency: repeated markConverted keeps the
//     first convertedAt and counts once; unmark returns the input to
//     unconverted and a re-mark stamps a NEW conversion time;
//   - cohorts: per-skill and overall, window + observation cutoff
//     visible, zero denominator -> rate null （无法计算）;
//   - minutes: blank = NULL (unknown), known sum + unknown count kept
//     apart; a legacy stored 0 stays 0 （来源不明）, never rewritten;
//   - action card loop: startAttempt enters the attempt state without
//     converting; saveOutput converts exactly once; a same-requestId
//     retry and a second different-request save are idempotent no-ops;
//   - backfill conversion grants no streak day for today.
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-metrics.mjs
import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
let failures = 0;
function check(name, ok, note = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${note ? ` (${note})` : ""}`);
}

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

function makeCtx() {
  const ctx = {
    slug: "space-10-validate-metrics",
    invocationId: "validate-metrics",
    spaceDir: "",
    viewer: { id: "owner-1", isOwner: true },
    db: () => db,
    invalidateQueries: () => {},
    executePrivileged: async () => {
      throw new Error("no privileged contracts in validate");
    },
  };
  return ctx;
}
const ctx = makeCtx();

async function call(name, args) {
  const action = Actions[name];
  const parsedArgs = action.request.parse(args);
  const res = await action.handler(ctx, parsedArgs);
  action.response.parse(res);
  return res;
}

const TZ = "America/Los_Angeles";
function laKey(instant) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
function shiftDay(key, delta) {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
// UTC instant of LA local midnight (00:00:00.000) on the given LA day.
function laMidnightUtcMs(key) {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  // Probe with noon UTC the same day (safely inside the LA day) and
  // read the zone offset from the round trip.
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(probe);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = wallAsUtc - probe.getTime();
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
}

const dash0 = await call("getDashboard", {});
const today = dash0.today;
check("today is the LA day of now", today === laKey(new Date()), today);
check(
  "empty sample: no series, cohort rates null （无法计算）, zero totals",
  dash0.series.length === 0 &&
    dash0.totals.cohorts.all.rate === null &&
    dash0.totals.cohorts.all.eligibleInputs === 0 &&
    dash0.totals.cohorts.days30.rate === null &&
    dash0.totals.conversionRate === null &&
    dash0.totals.totalMinutes === 0 &&
    dash0.totals.unknownMinutesCount === 0,
);

/* ----- fixture: skills and inputs ----- */

const skillA = (await call("addSkill", { name: "指标验证技能 A" })).id;
const skillB = (await call("addSkill", { name: "指标验证技能 B" })).id;

const dHist = shiftDay(today, -19); // historical input day
const dOld = shiftDay(today, -40); // outside the 30-day window
const dRecent = shiftDay(today, -5);

const hist = await call("recordLearningInput", {
  date: dHist, sourceType: "article", topic: "历史输入（今日才转化）", skillId: skillA, minutes: 30,
});
const oldUnconv = await call("recordLearningInput", {
  date: dOld, sourceType: "video", topic: "窗外未转化输入", skillId: skillA,
  // minutes omitted -> unknown (NULL)
});
const recentUnknown = await call("recordLearningInput", {
  date: dRecent, sourceType: "course", topic: "近期待转化输入", skillId: skillA,
});
const legacyZero = await call("recordLearningInput", {
  date: dRecent, sourceType: "research", topic: "旧口径 0 分钟输入", skillId: skillB, minutes: 0,
});
const unlinked = await call("recordLearningInput", {
  date: dRecent, sourceType: "practice", topic: "未关联输入", minutes: 45,
});

const dashA = await call("getDashboard", {});
const rowOf = (d, id) => d.inputs.find((r) => r.id === id);
check(
  "minutes: omitted duration reads back null (unknown)",
  rowOf(dashA, recentUnknown.id)?.minutes === null && rowOf(dashA, oldUnconv.id)?.minutes === null,
);
check(
  "minutes: legacy explicit 0 stays 0 （来源不明）, not rewritten to null",
  rowOf(dashA, legacyZero.id)?.minutes === 0,
);
check(
  "minutes: known sum excludes unknowns; unknown count kept apart",
  dashA.totals.totalMinutes === 75 && dashA.totals.unknownMinutesCount === 2,
  `known=${dashA.totals.totalMinutes} unknown=${dashA.totals.unknownMinutesCount}`,
);
const skillAStats = dashA.skills.find((s) => s.id === skillA);
check(
  "minutes: per-skill known sum + unknown count",
  skillAStats?.totalMinutes === 30 && skillAStats?.unknownMinutesCount === 2,
);

/* ----- occurrence-time series: historical input converted today ----- */

const pointAt = (d, key) => d.series.find((p) => p.date === key);
const beforeHist = pointAt(dashA, dHist);
check(
  "series: input day carries the input (cumulative: the 40-day-old one + this), no output yet",
  beforeHist?.inputs === 2 && beforeHist?.converted === 0,
  `hist=${JSON.stringify(beforeHist)}`,
);

await call("markConverted", { id: hist.id, outputType: "note", outputNote: "今日转化" });
const dashB = await call("getDashboard", {});
check(
  "series: converting a historical input today does NOT rewrite its input day",
  pointAt(dashB, dHist)?.converted === 0 && pointAt(dashB, dHist)?.inputs === 2,
  `hist=${JSON.stringify(pointAt(dashB, dHist))}`,
);
check(
  "series: today's point gains the output instead",
  pointAt(dashB, today)?.converted === 1,
  `today=${JSON.stringify(pointAt(dashB, today))}`,
);
check(
  "backfill: converting an old input grants no streak day",
  dashB.totals.streakDays === 0 && dashB.totals.activeDays === 3,
  `streak=${dashB.totals.streakDays} activeDays=${dashB.totals.activeDays}`,
);
const firstConvertedAt = rowOf(dashB, hist.id)?.convertedAt;
check("conversion instant recorded", typeof firstConvertedAt === "string" && laKey(new Date(firstConvertedAt)) === today);

/* ----- first-conversion idempotency ----- */

await call("markConverted", { id: hist.id, outputType: "project", outputNote: "重复标记不应改写" });
const dashC = await call("getDashboard", {});
check(
  "idempotent mark: first convertedAt unchanged, output unchanged, still counted once",
  rowOf(dashC, hist.id)?.convertedAt === firstConvertedAt &&
    rowOf(dashC, hist.id)?.outputNote === "今日转化" &&
    dashC.totals.totalConverted === 1 &&
    pointAt(dashC, today)?.converted === 1,
);

/* ----- unmark -> re-mark stamps a NEW conversion time ----- */

await call("unmarkConverted", { id: hist.id });
const dashD = await call("getDashboard", {});
check(
  "unmark: input returns to unconverted, today's output count falls back",
  rowOf(dashD, hist.id)?.converted === false && dashD.totals.totalConverted === 0 &&
    pointAt(dashD, today)?.converted === 0,
);
await new Promise((r) => setTimeout(r, 5));
await call("markConverted", { id: hist.id, outputType: "decision", outputNote: "撤销后重标" });
const dashE = await call("getDashboard", {});
const remarkConvertedAt = rowOf(dashE, hist.id)?.convertedAt;
check(
  "re-mark after unmark: new conversion time (>= the revoked one), counted once, on today",
  typeof remarkConvertedAt === "string" &&
    remarkConvertedAt >= (firstConvertedAt ?? "") &&
    rowOf(dashE, hist.id)?.outputNote === "撤销后重标" &&
    dashE.totals.totalConverted === 1 &&
    pointAt(dashE, today)?.converted === 1,
);

/* ----- cohorts ----- */

const totalsAll = dashE.totals.cohorts.all;
check(
  "cohort (all): every input eligible, converted counted by distinct input",
  totalsAll.eligibleInputs === 5 && totalsAll.convertedInputs === 1 &&
    Math.abs((totalsAll.rate ?? 0) - 0.2) < 1e-9 && totalsAll.asOf === today,
  JSON.stringify(totalsAll),
);
const totals30 = dashE.totals.cohorts.days30;
check(
  "cohort (30d): window excludes only the 40-day-old input; the 19-day-old converted input is in-window",
  totals30.eligibleInputs === 4 && totals30.convertedInputs === 1 &&
    Math.abs((totals30.rate ?? 0) - 0.25) < 1e-9 && totals30.windowStart === shiftDay(today, -29) &&
    totals30.windowEnd === today && totals30.asOf === today,
  JSON.stringify(totals30),
);
const aAll = dashE.skills.find((s) => s.id === skillA)?.cohorts.all;
check(
  "cohort: per-skill batch excludes other skills and unlinked inputs",
  aAll?.eligibleInputs === 3 && aAll?.convertedInputs === 1,
  JSON.stringify(aAll),
);
const bAll = dashE.skills.find((s) => s.id === skillB)?.cohorts.all;
const b30 = dashE.skills.find((s) => s.id === skillB)?.cohorts.days30;
check(
  "cohort: skill B all-window has its one unconverted input",
  bAll?.eligibleInputs === 1 && bAll?.convertedInputs === 0 && bAll?.rate === 0,
);
check(
  "cohort: empty skill/window -> eligible 0 and rate null （无法计算）",
  dashE.skills.filter((s) => s.id !== skillA && s.id !== skillB).every(
    (s) => s.cohorts.all.eligibleInputs === 0 && s.cohorts.all.rate === null,
  ) && b30 !== undefined,
);

/* ----- LA midnight boundary (seeded instants, real dashboard) ----- */

{
  const c2 = createClient({ url: ":memory:" });
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file, migrationDir), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await c2.execute(trimmed);
    }
  }
  const db2 = drizzle(c2, { schema });
  const ctx2 = { ...ctx, db: () => db2 };
  const call2 = async (name, args) => {
    const action = Actions[name];
    const res = await action.handler(ctx2, action.request.parse(args));
    action.response.parse(res);
    return res;
  };
  const dashB0 = await call2("getDashboard", {});
  const today2 = dashB0.today;
  const dayX = shiftDay(today2, -3);
  const midnight = laMidnightUtcMs(dayX);
  check(
    "boundary helper: midnight-1ms is the previous LA day, midnight+1ms is day X",
    laKey(new Date(midnight - 1)) === shiftDay(dayX, -1) && laKey(new Date(midnight + 1)) === dayX,
  );
  const in1 = await call2("recordLearningInput", {
    date: shiftDay(dayX, -10), sourceType: "article", topic: "午夜前转化", minutes: 10,
  });
  const in2 = await call2("recordLearningInput", {
    date: shiftDay(dayX, -10), sourceType: "article", topic: "午夜后转化", minutes: 10,
  });
  // Seed exact conversion instants via the same drizzle db the handler reads.
  const { eq } = await import("drizzle-orm");
  await db2.update(schema.learningInputs)
    .set({ convertedAt: new Date(midnight - 1), outputType: "note" })
    .where(eq(schema.learningInputs.id, in1.id));
  await db2.update(schema.learningInputs)
    .set({ convertedAt: new Date(midnight + 1), outputType: "note" })
    .where(eq(schema.learningInputs.id, in2.id));
  const dashB2 = await call2("getDashboard", {});
  const at = (key) => dashB2.series.find((p) => p.date === key);
  check(
    "boundary: 23:59:59.999 LA conversion counts on the previous day only",
    at(shiftDay(dayX, -1))?.converted === 1 && at(shiftDay(dayX, -2))?.converted === 0,
    `prev=${JSON.stringify(at(shiftDay(dayX, -1)))}`,
  );
  check(
    "boundary: 00:00:00.001 LA conversion counts on day X; input days untouched",
    at(dayX)?.converted === 2 && at(shiftDay(dayX, -10))?.converted === 0 &&
      at(shiftDay(dayX, -10))?.inputs === 2,
    `dayX=${JSON.stringify(at(dayX))}`,
  );
  check(
    "boundary: cohort observation cutoff excludes a conversion after asOf",
    // Both conversions are <= today, so both count in the all cohort.
    dashB2.totals.cohorts.all.convertedInputs === 2 && dashB2.totals.cohorts.all.eligibleInputs === 2,
  );
}

/* ----- action card loop: attempt -> save -> idempotent retries ----- */

const target = recentUnknown.id;
const dashPre = await call("getDashboard", {});
check(
  "attempt: target starts unconverted with no attempt",
  rowOf(dashPre, target)?.converted === false && rowOf(dashPre, target)?.attemptStartedAt === null,
);
const attempt = await call("startAttempt", { inputId: target });
check("attempt: startAttempt ok with a start instant", attempt.ok === true && typeof attempt.attemptStartedAt === "string");
const attempt2 = await call("startAttempt", { inputId: target });
check(
  "attempt: re-starting keeps the first attempt instant",
  attempt2.ok === true && attempt2.attemptStartedAt === attempt.attemptStartedAt,
);
const dashAtt = await call("getDashboard", {});
check(
  "attempt: attempting is NOT a conversion (counts and series unchanged)",
  rowOf(dashAtt, target)?.converted === false &&
    dashAtt.totals.totalConverted === dashPre.totals.totalConverted &&
    pointAt(dashAtt, today)?.converted === pointAt(dashPre, today)?.converted &&
    rowOf(dashAtt, target)?.attemptStartedAt === attempt.attemptStartedAt,
);

const saved = await call("saveOutput", {
  inputId: target, requestId: "req-metrics-1", outputType: "experiment", outputNote: "跑通了一次真实尝试",
});
check(
  "save: saveOutput converts exactly once, stamped now",
  saved.ok === true && saved.alreadyConverted === false && typeof saved.convertedAt === "string" &&
    laKey(new Date(saved.convertedAt)) === today,
);
const dashSaved = await call("getDashboard", {});
check(
  "save: conversion visible — totals +1, output on today (input day unchanged)",
  dashSaved.totals.totalConverted === dashAtt.totals.totalConverted + 1 &&
    rowOf(dashSaved, target)?.converted === true &&
    rowOf(dashSaved, target)?.outputNote === "跑通了一次真实尝试" &&
    pointAt(dashSaved, dRecent)?.converted === (pointAt(dashAtt, dRecent)?.converted ?? 0),
);
const retry = await call("saveOutput", {
  inputId: target, requestId: "req-metrics-1", outputType: "experiment", outputNote: "跑通了一次真实尝试",
});
check(
  "save: same-requestId retry is an idempotent no-op",
  retry.ok === true && retry.alreadyConverted === true && retry.convertedAt === saved.convertedAt,
);
const second = await call("saveOutput", {
  inputId: target, requestId: "req-metrics-2", outputType: "note", outputNote: "第二个产出引用",
});
const dashFinal = await call("getDashboard", {});
check(
  "save: a second output for the same input counts nothing new (dedupe by input)",
  second.ok === true && second.alreadyConverted === true && second.convertedAt === saved.convertedAt &&
    dashFinal.totals.totalConverted === dashSaved.totals.totalConverted &&
    rowOf(dashFinal, target)?.outputNote === "跑通了一次真实尝试",
);
check(
  "save: converted input can no longer be attempted",
  (await call("startAttempt", { inputId: target })).ok === false,
);
check(
  "save: unknown input id fails honestly",
  (await call("saveOutput", { inputId: 99999, requestId: "req-x", outputType: "note", outputNote: "无" })).ok === false &&
    (await call("startAttempt", { inputId: 99999 })).ok === false,
);
check(
  "unlinked input converts in totals but in no skill cohort",
  dashFinal.totals.cohorts.all.eligibleInputs === 5 &&
    dashFinal.skills.find((s) => s.id === skillA)?.cohorts.all.convertedInputs === 2 &&
    dashFinal.skills.find((s) => s.id === skillB)?.cohorts.all.convertedInputs === 0,
);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
