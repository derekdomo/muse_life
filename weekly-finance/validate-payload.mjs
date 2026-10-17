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

console.log(`validate-payload: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
