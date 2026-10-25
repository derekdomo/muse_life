// F0.2 validation: parseDashboardPayload never throws on a corrupt
// payload, and both actions route payload reads through it.
// The function is extracted from the real server source; the zod
// schema is replaced by a controlled stub with the same contract
// (safeParse -> {success:true,data} | {success:false}), because the
// real schema pulls in the full module graph. Wiring assertions run
// against the real source text.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- wiring (real source) ---
check("no bare JSON.parse(state.payload) remains", !src.includes("JSON.parse(state.payload)"));
check("parseDashboardPayload exported", /export function parseDashboardPayload/.test(src));
check("getDashboard + ingest use parseDashboardPayload", (src.match(/parseDashboardPayload\(state\.payload\)/g) ?? []).length >= 2);
check("corrupt message present", src.includes("已保存数据损坏，重新更新可恢复"));
check("payloadCorrupted drives error status", src.includes('payloadCorrupted ? "error"'));

// --- behaviour (extracted real function + stub schema) ---
const start = src.indexOf("export function parseDashboardPayload");
const end = src.indexOf("\n}\n", start) + 3;
const fnText = src.slice(start, end)
  .replace("export function", "function")
  .replace("payload: string", "payload")
  .replace("let raw: unknown;", "let raw;")
  .replace(": DashboardPayloadParseResult", "");
const dashboardSchema = {
  safeParse(value) {
    const ok = value != null && typeof value === "object" && !Array.isArray(value)
      && value.live != null && typeof value.live === "object";
    return ok ? { success: true, data: value } : { success: false };
  },
};
const parseDashboardPayload = new Function("dashboardSchema", `${fnText}; return parseDashboardPayload;`)(dashboardSchema);

const valid = JSON.stringify({ live: { netWorth: 1 } });
const r1 = parseDashboardPayload(valid);
check("valid payload ok", r1.ok === true && r1.data.live.netWorth === 1);
let threw = false, r2;
try { r2 = parseDashboardPayload("{not json"); } catch { threw = true; }
check("syntax-corrupt payload does not throw", !threw);
check("syntax-corrupt payload ok:false", r2 && r2.ok === false);
const r3 = parseDashboardPayload(JSON.stringify({ nope: 1 }));
check("schema-mismatch payload ok:false", r3.ok === false);
const r4 = parseDashboardPayload("");
check("empty payload ok:false, no throw", r4.ok === false);
const r5 = parseDashboardPayload("null");
check("null payload ok:false", r5.ok === false);
// mutation sensitivity: a version without try/catch must throw on corrupt input
const noGuard = (p) => { const x = dashboardSchema.safeParse(JSON.parse(p)); return x.success ? { ok: true, data: x.data } : { ok: false }; };
let mutThrew = false;
try { noGuard("{not json"); } catch { mutThrew = true; }
check("mutation: removing the guard reintroduces the throw", mutThrew);

// --- F0.7: refresh generation / settlement decisions ---
// Behaviour runs against the REAL pure decision functions
// (AST-extracted from server/src/actions.ts); the fixed matrix
// covers callbacks before the spawn returns, cross-generation
// late spawns, old / duplicate / future asOf, late failures,
// settled generations, legacy rows and the stale threshold. The
// real-handler concurrency matrix (claim arbitration, spawn-tail
// CAS) lives in validate-refresh-chain.ts.
import ts from "typescript";
import { readFileSync as readMigrationSync, readdirSync } from "node:fs";
const astFile = ts.createSourceFile("actions.ts", src, ts.ScriptTarget.ES2022, true);
function extractAstFn(name) {
  for (const node of astFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      return ts.transpileModule(node.getText(astFile), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
    }
  }
  throw new Error(`function not found: ${name}`);
}
const thresholdMatch = src.match(/export const staleRefreshThresholdMs = ([0-9 *]+);/);
check("stale threshold exported at 2h", thresholdMatch != null && eval(thresholdMatch[1]) === 2 * 60 * 60 * 1000);
const decisionBundle = ["isStaleRunningState", "decideIngestCallback", "decideGenerationGate"].map(extractAstFn).join("\n");
const decisionApi = new Function(
  `const exports = {};\nconst staleRefreshThresholdMs = ${eval(thresholdMatch[1])};\n${decisionBundle}; return { isStaleRunningState, decideIngestCallback, decideGenerationGate };`,
)();
const { isStaleRunningState, decideIngestCallback, decideGenerationGate } = decisionApi;
const dNow = new Date("2026-10-18T12:00:00Z");
const dAgo = (ms) => new Date(dNow.getTime() - ms);
check("stale: running 1h59m not stale", isStaleRunningState("running", dAgo(119 * 60 * 1000), dNow) === false);
check("stale: running exactly 2h not stale (strict >)", isStaleRunningState("running", dAgo(2 * 60 * 60 * 1000), dNow) === false);
check("stale: running 2h+1ms stale (retry path opens)", isStaleRunningState("running", dAgo(2 * 60 * 60 * 1000 + 1), dNow) === true);
check("stale: idle/error/null never stale", isStaleRunningState("idle", dAgo(9 * 60 * 60 * 1000), dNow) === false
  && isStaleRunningState("error", dAgo(9 * 60 * 60 * 1000), dNow) === false
  && isStaleRunningState("running", null, dNow) === false && isStaleRunningState(null, dAgo(1), dNow) === false);
// generation gate
const G = (over) => decideGenerationGate({ refreshStatus: "running", storedGeneration: "gen-A", incomingGeneration: "gen-A", ...over });
check("gate: running + matching generation passes", G({}) === "pass");
check("gate: running + missing generation ignored (old failure callback shape)", G({ incomingGeneration: null }) === "ignore");
check("gate: running + foreign generation ignored", G({ incomingGeneration: "gen-OLD" }) === "ignore");
check("gate: settled idle + same generation ignored (a generation settles once)", G({ refreshStatus: "idle" }) === "ignore");
check("gate: settled error + same generation ignored", G({ refreshStatus: "error" }) === "ignore");
check("gate: settled + foreign generation ignored", G({ refreshStatus: "idle", incomingGeneration: "gen-OLD" }) === "ignore");
check("gate: legacy row (stored null) passes ungated in every state (old payload compatibility)",
  G({ storedGeneration: null, incomingGeneration: null }) === "pass"
  && G({ storedGeneration: null, incomingGeneration: "gen-X", refreshStatus: "idle" }) === "pass"
  && G({ storedGeneration: null, incomingGeneration: null, refreshStatus: null }) === "pass");
// ingest decision
const D = (over) => decideIngestCallback({
  refreshStatus: "running", refreshUpdatedAt: new Date("2026-10-18T11:00:00-07:00"),
  latestPayloadAsOf: "2026-10-10T12:00:00-07:00", incomingSuccess: true,
  incomingAsOf: "2026-10-18T12:00:00-07:00", ...over,
});
check("decide: running + fresh success applies", D({}) === "apply");
check("decide: running + failure eligible to settle", D({ incomingSuccess: false, incomingAsOf: null }) === "apply");
check("decide: success asOf older than the stored payload ignored (no regression)",
  D({ incomingAsOf: "2026-10-03T12:00:00-07:00" }) === "ignore");
check("decide: success asOf equal to the stored payload ignored (no duplicate)",
  D({ incomingAsOf: "2026-10-10T12:00:00-07:00" }) === "ignore");
check("decide: success stamped before this refresh started ignored (previous generation's late task)",
  D({ incomingAsOf: "2026-10-18T10:30:00-07:00", latestPayloadAsOf: null }) === "ignore");
check("decide: future asOf applies (not silently dropped)", D({ incomingAsOf: "2099-10-18T12:00:00-07:00" }) === "apply");
check("decide: settled idle + late failure ignored (never flips a success to error)",
  D({ refreshStatus: "idle", incomingSuccess: false, incomingAsOf: null }) === "ignore");
check("decide: settled error + late failure ignored", D({ refreshStatus: "error", incomingSuccess: false, incomingAsOf: null }) === "ignore");
check("decide: settled idle + duplicate success ignored, newer success applies (legacy/import path)",
  D({ refreshStatus: "idle", incomingAsOf: "2026-10-10T12:00:00-07:00" }) === "ignore" && D({ refreshStatus: "idle" }) === "apply");
check("decide: no state row + failure ignored, success applies",
  D({ refreshStatus: null, incomingSuccess: false, incomingAsOf: null }) === "ignore"
  && D({ refreshStatus: null, latestPayloadAsOf: null }) === "apply");
// mutation sensitivity
const gateMutated = decisionBundle.replace(
  'input.incomingGeneration === input.storedGeneration ? "pass" : "ignore"',
  'input.incomingGeneration === input.storedGeneration ? "ignore" : "pass"',
);
const gateMutApi = new Function(`const exports = {};\nconst staleRefreshThresholdMs = 1;\n${gateMutated}; return { decideGenerationGate };`)();
check("mutation: inverted gate equality flips the matching-generation case",
  gateMutApi.decideGenerationGate({ refreshStatus: "running", storedGeneration: "gen-A", incomingGeneration: "gen-A" }) === "ignore");
const failMutated = decisionBundle.replace(
  'if (input.refreshStatus === "running")\n        return "apply";',
  'if (input.refreshStatus !== "running")\n        return "apply";',
);
const failMutApi = new Function(`const exports = {};\nconst staleRefreshThresholdMs = 1;\n${failMutated}; return { decideIngestCallback };`)();
check("mutation: inverted failure eligibility flips the settled late-failure case",
  failMutApi.decideIngestCallback({ refreshStatus: "idle", refreshUpdatedAt: null, latestPayloadAsOf: null, incomingSuccess: false, incomingAsOf: null }) === "apply");

// --- F0.7 wiring: mint -> prompt echo -> CAS tails -> gate/claim/settle ---
const refreshSection = src.slice(src.indexOf("refreshFinanceData: defineAction"), src.indexOf("ingestFinanceData: defineAction"));
const ingestSection = src.slice(src.indexOf("ingestFinanceData: defineAction"));
check("wiring: generation minted and stored BEFORE the spawn, claim cleared, attempt start stamped",
  refreshSection.indexOf("const generation = newGenerationId();") > -1
  && refreshSection.indexOf("const generation = newGenerationId();") < refreshSection.indexOf("ctx.agent.spawnTask")
  && refreshSection.includes("claimedGeneration: null") && refreshSection.includes("startedAt: new Date()"));
check("wiring: spawn prompt requires echoing the generation verbatim on success AND failure",
  src.includes("generation 字段，值固定为 ${generation}") && src.includes("成功与失败两种回传都必须带"));
check("wiring: both spawn tails go through the generation+running CAS, never an unconditional writeState",
  (refreshSection.match(/casSpawnTailState\(ctx, generation,/g) ?? []).length === 2
  && !refreshSection.includes('writeState(ctx, { status: "running", taskId: task.taskId'));
check("wiring: spawn-tail CAS matches id + generation + still-running and returns a row count",
  src.includes("eq(schema.financeState.generation, generation)")
  && src.includes('eq(schema.financeState.status, "running")')
  && src.includes("return rows.length === 1;"));
check("wiring: ingest schema accepts an optional generation on BOTH branches (legacy callers compatible)",
  (src.match(/generation: z\.string\(\)\.min\(1\)\.max\(128\)\.optional\(\)/g) ?? []).length === 2);
check("wiring: gate + decision are consulted before any claim attempt",
  ingestSection.indexOf("gateFor(firstRead.state)") > -1
  && ingestSection.indexOf("gateFor(firstRead.state)") < ingestSection.indexOf("await tryClaim(firstRead.state)"));
check("wiring: claim stamps a token conditional on the read snapshot + unclaimed",
  src.includes("claimedGeneration: token")
  && src.includes("eq(schema.financeState.updatedAt, snapshot.updatedAt)")
  && src.includes("isNull(schema.financeState.claimedGeneration)"));
check("wiring: claim loser re-reads once and an already-claimed generation is a hard stop",
  ingestSection.includes("const secondRead = await readIngestInputs();")
  && ingestSection.includes("if (secondRead.state.claimedGeneration != null) return ignoredResult();"));
check("wiring: settle is bound to the claim token + generation, payload written in the same write",
  src.includes("eq(schema.financeState.claimedGeneration, claimToken)")
  && ingestSection.includes("const published = await settleClaimed({"));
check("wiring: refresh start is an atomic conditional claim on the read snapshot (status + updatedAt + generation), insert-if-absent otherwise",
  refreshSection.includes("eq(schema.financeState.updatedAt, snapshot.updatedAt)")
  && refreshSection.includes("eq(schema.financeState.status, snapshot.status)")
  && refreshSection.includes(".onConflictDoNothing()")
  && !refreshSection.includes("writeState"));
check("wiring: only the start-claim winner spawns (claim failure re-reads and answers already_running before any spawn)",
  refreshSection.indexOf("if (!claimed)") > -1
  && refreshSection.indexOf("if (!claimed)") < refreshSection.indexOf("ctx.agent.spawnTask")
  && refreshSection.includes('return { ok: true, status: "already_running", message: "更新正在进行中" };'));
check("wiring: spawn-tail CAS additionally requires claimedGeneration IS NULL (an in-flight claim is never stolen)",
  src.includes("isNull(schema.financeState.claimedGeneration)")
  && src.slice(src.indexOf("async function casSpawnTailState"), src.indexOf("export const Actions")).includes("isNull(schema.financeState.claimedGeneration)"));
check("wiring: identity unchanged — finance stays strictly owner, no viewer-less channel admitted",
  (src.match(/if \(!isOwner\(ctx\)\)/g) ?? []).length >= 3
  && !src.includes("space-task-return") && !src.includes("isTaskReturnCallback") && !src.includes("isScheduledPlatformCall"));
const migrationFile = readdirSync(new URL("./drizzle/", import.meta.url)).find((f) => f.startsWith("0003_"));
const migrationSql = migrationFile ? readMigrationSync(new URL(`./drizzle/${migrationFile}`, import.meta.url), "utf8") : "";
check("migration 0003: additive generation / claimed_generation / started_at columns only",
  migrationSql.includes("ALTER TABLE finance_state ADD COLUMN generation TEXT")
  && migrationSql.includes("ALTER TABLE finance_state ADD COLUMN claimed_generation TEXT")
  && migrationSql.includes("ALTER TABLE finance_state ADD COLUMN started_at INTEGER")
  && !migrationSql.includes("DROP TABLE") && !migrationSql.includes("DELETE FROM"));

console.log(`validate-payload: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
