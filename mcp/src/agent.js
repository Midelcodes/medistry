#!/usr/bin/env node
// LLM agent: the model chooses and calls OUR MCP server's tools (src/server.js over stdio).
// Provider: Gemini via src/llm/gemini.js (swap in another provider with the same generate() interface).
// Usage: npm run agent -- "<task text>"   (needs GEMINI_API_KEY and GEMINI_MODEL in the environment)
// Synthetic data only. Outputs are decision support and need clinician validation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

export const MAX_ITERATIONS = 8;

export const SYSTEM_PROMPT = `You are a triage and referral assistant for emergency care in Nigeria.
- Use the provided tools for every triage score, queue action and referral. Do not compute these yourself.
- Do not invent clinical values. Use only values stated in the task or returned by a tool. If a required value is missing, say which one and stop rather than guessing.
- Never call get_emergency_summary unless the task explicitly says the patient is unconscious AND provides a break-glass emergency code, and then only with confirmBreakGlass set to true. It is an audited break-glass that notifies the patient.
- Use pseudonymous patient references only, never names.
- Handover note rules: use only values given in the task or returned by a tool. Do not add diagnoses, differential diagnoses, oxygen or treatment targets, oxygen delivery details such as "room air", or any other value that was not provided. Write "not provided" for any field without a given value. For treatment, write only "clinician to decide".
- All data is synthetic. Finish with a concise answer (triage category and reasons, referral options, and a short handover note when asked) and state clearly that the output is decision support that must be validated by a clinician.`;

// Default task. The task brief fixed the chest pain and vitals; age, temperature, AVPU, mobility and
// location are added synthetic values so the tools have every required input.
export const DEFAULT_TASK = `Synthetic patient PT-DEMO-01, 58 years old, at Demo Primary Health Centre Surulere (facility NG-LAG-003, lat 6.50, lon 3.35).
Complaint: chest pain. Observations: SpO2 88%, heart rate 130, systolic BP 90, respiratory rate 28, temperature 37.2 C, alert, walking with help, no trauma.
1. Triage the patient.
2. Find the nearest suitable facility with the needed capability (cardiology), excluding NG-LAG-003.
3. Write a short referral handover note.`;

const GEMINI_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;

// Removes the API key (and anything shaped like a Google API key or key= parameter) from text.
export function redact(value, secrets = [process.env.GEMINI_API_KEY]) {
  let s = typeof value === "string" ? value : String(value);
  for (const k of secrets) if (k && k.length >= 4) s = s.split(k).join("[REDACTED]");
  return s.replace(GEMINI_KEY_PATTERN, "[REDACTED]").replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED]");
}

const short = (v, n = 140) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n - 3)}...` : s; };

// Code-level guard on top of the system prompt: break-glass only for an unconscious patient whose
// emergency code appears in the task, with explicit confirmation.
export function breakGlassAllowed(task, args = {}) {
  return /\bunconscious\b/i.test(task) && typeof args.code === "string" && args.code.length >= 8
    && task.includes(args.code) && args.confirmBreakGlass === true;
}

// Calls an MCP tool and returns { ok, result } where result is always a JSON object (Gemini needs one).
async function execTool(mcp, name, args) {
  try {
    const res = await mcp.callTool({ name, arguments: args });
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (res.isError) return { ok: false, result: { error: text || "tool error" } };
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: true, result: data && typeof data === "object" && !Array.isArray(data) ? data : { output: data } };
  } catch (e) {
    return { ok: false, result: { error: redact(e.message) } };
  }
}

function summarise({ ok, result }) {
  if (!ok) return `ERROR ${short(result.error, 120)}`;
  if (result.category) return `${result.category}${result.tews !== undefined ? ` (TEWS ${result.tews})` : ""}`;
  if (Array.isArray(result.recommendations)) {
    return result.recommendations.length
      ? `${result.recommendations.length} option(s): ${result.recommendations.map((r) => `${r.facilityId} ${r.distanceKm}km`).join(", ")}`
      : short(result.note ?? "no recommendations", 120);
  }
  return short(result, 120);
}

// The agent loop. llm: { generate }, mcp: MCP client (listTools, callTool). Returns
// { text, iterations, steps, stoppedReason: "final" | "max_iterations" }.
export async function runAgent({ llm, mcp, task, system = SYSTEM_PROMPT, maxIterations = MAX_ITERATIONS, log = () => {} }) {
  const { tools } = await mcp.listTools();
  const messages = [{ role: "user", text: task }];
  const steps = [];
  for (let i = 1; i <= maxIterations; i++) {
    const { text, toolCalls = [], raw } = await llm.generate({ system, messages, tools });
    if (!toolCalls.length) {
      return { text: text ?? "", iterations: i, steps, stoppedReason: "final" };
    }
    messages.push({ role: "assistant", text, toolCalls, raw });
    const results = [];
    for (const call of toolCalls) {
      let out;
      if (call.name === "get_emergency_summary" && !breakGlassAllowed(task, call.args)) {
        out = { ok: false, result: { error: "Blocked by agent policy: break-glass needs an unconscious patient, an emergency code given in the task, and confirmBreakGlass=true." } };
      } else {
        out = await execTool(mcp, call.name, call.args);
      }
      steps.push({ iteration: i, name: call.name, args: call.args, ok: out.ok, result: out.result });
      log(`[${i}] ${call.name} ${short(call.args, 110)}\n    -> ${summarise(out)}`);
      results.push({ id: call.id, name: call.name, result: out.result });
    }
    messages.push({ role: "tool", results });
  }
  return { text: null, iterations: maxIterations, steps, stoppedReason: "max_iterations" };
}

async function main() {
  const missing = ["GEMINI_API_KEY", "GEMINI_MODEL"].filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.error(`Missing environment variable(s): ${missing.join(", ")}.\n`
      + `Set them first, for example in PowerShell:\n  $env:GEMINI_API_KEY="<your key>"\n  $env:GEMINI_MODEL="<model id>"\nthen run: npm run agent -- "<task>"`);
    process.exit(1);
  }
  const { createGeminiProvider } = await import("./llm/gemini.js");
  const llm = createGeminiProvider({ apiKey: process.env.GEMINI_API_KEY.trim(), model: process.env.GEMINI_MODEL.trim() });
  const task = process.argv.slice(2).join(" ").trim() || DEFAULT_TASK;

  // The MCP server child process never receives the LLM credentials.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !/^GEMINI_/.test(k) && v !== undefined));
  const here = dirname(fileURLToPath(import.meta.url));
  const mcp = new Client({ name: "medistry-agent", version: "0.2.0" });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve(here, "server.js")], cwd: resolve(here, ".."), env: childEnv,
  }));

  console.log(`Task:\n${task}\n\nModel: ${process.env.GEMINI_MODEL.trim()} | max ${MAX_ITERATIONS} iterations\n`);
  try {
    const out = await runAgent({ llm, mcp, task, log: (s) => console.log(redact(s)) });
    console.log("\n=== Final answer ===");
    console.log(out.text ? redact(out.text) : `(no final answer: stopped after ${out.iterations} iterations)`);
    console.log("\nDecision support only, synthetic data. A clinician must validate every output.");
    if (out.stoppedReason !== "final") process.exitCode = 2;
  } finally {
    await mcp.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`Agent failed: ${redact(e?.message ?? e)}`); process.exit(1); });
}
