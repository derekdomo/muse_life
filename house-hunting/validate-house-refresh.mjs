// HH0.1 / HH0.2 (+AUDIT-04/05, L0.2 wiring) validation.
// Behaviour runs against the REAL pure functions extracted from
// server/src/actions.ts (types stripped with node:module); wiring
// assertions run against the real client/server source text.
// All fixtures are synthetic. Pure Node, no deps.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const clientSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real server pure functions ---
function extractFn(name) {
  const start = serverSrc.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`function not found: ${name}`);
  const end = serverSrc.indexOf("\n}\n", start) + 3;
  if (end < 3) throw new Error(`function end not found: ${name}`);
  return serverSrc.slice(start, end).replace(/^export /, "");
}
const NAMES = ["isStaleRunningState", "decideIngestCallback"];
const bundle = NAMES.map((n) => stripTypeScriptTypes(extractFn(n))).join("\n");
const thresholdMatch = serverSrc.match(/export const staleRefreshThresholdMs = ([0-9 *]+);/);
if (!thresholdMatch) throw new Error("staleRefreshThresholdMs not found");
const staleRefreshThresholdMs = eval(thresholdMatch[1]);
const api = new Function(`const staleRefreshThresholdMs = ${staleRefreshThresholdMs}; ${bundle}; return { ${NAMES.join(", ")} };`)();
const { isStaleRunningState, decideIngestCallback } = api;

// --- HH0.2 stale threshold & predicate ---
check("threshold is 2h", staleRefreshThresholdMs === 2 * 60 * 60 * 1000);
const now = new Date("2026-10-17T12:00:00Z");
const ago = (ms) => new Date(now.getTime() - ms);
check("running 1h59m not stale", isStaleRunningState("running", ago(119 * 60 * 1000), now) === false);
check("running exactly 2h not stale (strict >)", isStaleRunningState("running", ago(2 * 60 * 60 * 1000), now) === false);
check("running 2h+1ms stale", isStaleRunningState("running", ago(2 * 60 * 60 * 1000 + 1), now) === true);
check("running 3h stale", isStaleRunningState("running", ago(3 * 60 * 60 * 1000), now) === true);
check("idle old not stale", isStaleRunningState("idle", ago(5 * 60 * 60 * 1000), now) === false);
check("error old not stale", isStaleRunningState("error", ago(5 * 60 * 60 * 1000), now) === false);
check("running null updatedAt not stale", isStaleRunningState("running", null, now) === false);
check("running undefined updatedAt not stale", isStaleRunningState("running", undefined, now) === false);
check("null status not stale", isStaleRunningState(null, ago(5 * 60 * 60 * 1000), now) === false);

// --- HH0.2 ingest idempotency decision ---
const D = (over) => decideIngestCallback({ refreshStatus: "running", latestReportAsOf: "2026-10-10T12:00:00-07:00", incomingSuccess: true, incomingAsOf: "2026-10-17T12:00:00-07:00", ...over });
check("running + success applies", D({}) === "apply");
check("running + failure applies", D({ incomingSuccess: false, incomingAsOf: null }) === "apply");
check("settled idle + duplicate same asOf ignored", D({ refreshStatus: "idle", incomingAsOf: "2026-10-10T12:00:00-07:00" }) === "ignore");
check("settled idle + older asOf ignored", D({ refreshStatus: "idle", incomingAsOf: "2026-10-03T12:00:00-07:00" }) === "ignore");
check("settled idle + newer asOf applies", D({ refreshStatus: "idle" }) === "apply");
check("settled error + late failure ignored", D({ refreshStatus: "error", incomingSuccess: false, incomingAsOf: null }) === "ignore");
check("settled idle + late failure ignored", D({ refreshStatus: "idle", incomingSuccess: false, incomingAsOf: null }) === "ignore");
check("settled + no latest report + success applies", D({ refreshStatus: "idle", latestReportAsOf: null }) === "apply");
check("settled + unparseable asOf applies (no silent drop)", D({ refreshStatus: "idle", incomingAsOf: "not-a-date" }) === "apply");
check("no state row + failure ignored (settled semantics)", D({ refreshStatus: null, incomingSuccess: false, incomingAsOf: null }) === "ignore");

// --- HH0.2 wiring: getReport maps stale, refreshReport restarts, ingest ignores ---
check("getReport uses presentRefreshState in both paths", (serverSrc.match(/presentRefreshState\(state, owner\)/g) ?? []).length === 2);
check("presentRefreshState maps stale to retryable error message", serverSrc.includes("上次刷新未完成，可以重新刷新") && serverSrc.includes('stale ? ("error" as const)'));
check("refreshReport only blocks on non-stale running", serverSrc.includes('currentState?.status === "running" && !isStaleRunningState('));
check("ingest consults decideIngestCallback before any insert", (() => { const sec = serverSrc.slice(serverSrc.indexOf("ingestResearch: defineAction")); return sec.indexOf("decideIngestCallback({") > -1 && sec.indexOf("decideIngestCallback({") < sec.indexOf("db.insert(schema.reports)"); })());
check("ingest ignore returns saved 0 without state write in branch", /if \(ingestDecision === "ignore"\) \{\s*return args\.success \? \{ ok: true, saved: 0 \} : \{ ok: false, saved: 0 \};\s*\}/.test(serverSrc));

// --- L0.2 wiring (builder-delivered alongside HH0.2) ---
check("refreshReport admits owner or scheduled platform call only", serverSrc.includes("if (!isOwner(ctx) && !isScheduledPlatformCall(ctx))"));
check("ingest admits owner or task-return callback only", serverSrc.includes("if (!isOwner(ctx) && !isTaskReturnCallback(ctx)) return { ok: false, saved: 0 };"));
check("initializeReport is owner-only", serverSrc.includes("if (!isOwner(ctx)) return { ok: false, created: false };"));
check("getReport withholds taskId from non-owner", serverSrc.includes("taskId: owner ? (state?.taskId ?? null) : null"));

// --- HH0.1 wiring: hero never falls back to global listings ---
check("client top is filtered[0] only", clientSrc.includes("const top = filtered[0];"));
check("client has no global fallback", !clientSrc.includes("?? report.listings[0]"));
check("empty hero renders when no top", clientSrc.includes("hero hero-empty") && clientSrc.includes("这个筛选下没有房源"));
check("empty hero shows no listing link/payment", (() => { const s = clientSrc.indexOf("hero hero-empty"); const seg = clientSrc.slice(s, s + 600); return !seg.includes("top.url") && !seg.includes("topPayment") && !seg.includes("top.address"); })());
check("non-empty hero label unchanged", clientSrc.includes("当前筛选首选 · {top.city}"));
check("results no-results empty state retained", clientSrc.includes("这个筛选下没有房源") && clientSrc.includes("清除筛选"));

// --- mutation sensitivity: flipping the stale comparison must flip results ---
const mutated = bundle.replace("now.getTime() - updatedAt.getTime() > staleRefreshThresholdMs", "now.getTime() - updatedAt.getTime() < staleRefreshThresholdMs");
const mApi = new Function(`const staleRefreshThresholdMs = ${staleRefreshThresholdMs}; ${mutated}; return { isStaleRunningState };`)();
check("mutation: inverted stale comparison flips 3h case", mApi.isStaleRunningState("running", ago(3 * 60 * 60 * 1000), now) === false);

console.log(`validate-house-refresh: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
