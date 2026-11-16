#!/usr/bin/env node
// LLM agent: the model chooses and calls OUR MCP server's tools (src/server.js over stdio).
// Provider: Gemini via src/llm/gemini.js (swap in another provider with the same generate() interface).
// Usage: npm run agent -- "<task text>"   (needs GEMINI_API_KEY and GEMINI_MODEL in the environment)
// Synthetic data only. Outputs are decision support and need clinician validation.
//
// DATA PROTECTION: real patient data must not be sent to a foreign-hosted LLM (such as a cloud Gemini
// endpoint outside the patient's country) without a lawful basis under the applicable law (for example the
// Nigeria Data Protection Act 2023). Everything sent to the model goes through src/minimise.js first, which
// strips names, contacts, ids and free-text notes, but minimisation alone is not a lawful basis.
// Production should use an in-country or self-hosted model behind the same generate() interface.
import { normaliseReason } from "./reasons.js";
import { createMinimiser } from "./minimise.js";
import { validationBanner } from "./validation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pricesFromEnv, modelCostUsd, totals, fmtUsd, fmtInt } from "./metrics.js";

export const MAX_ITERATIONS = 10;

export const SYSTEM_PROMPT = `You are a triage and referral assistant for emergency care in Nigeria.
- Use the provided tools for every triage score, queue action and referral. Do not compute these yourself.
- Do not invent clinical values. Use only values stated in the task or returned by a tool. If a required value is missing, say which one and stop rather than guessing.
- Never call get_emergency_summary unless the task explicitly says the patient is unconscious AND provides a break-glass emergency code, and then only with confirmBreakGlass set to true. It is an audited break-glass that notifies the patient.
- Use pseudonymous patient references only, never names.
- Values written like [CARD_1], [CODE_1], [REF_1] or [ID_1] are placeholders for sensitive values that are kept off this conversation. Pass them to tools exactly as written.
- If verify_offline_card returns verified: false, do not use any data from that card. Say clearly that the card could not be verified and that its data was not used.
- Handover note rules: use only values given in the task or returned by a tool. Do not add diagnoses, differential diagnoses, oxygen or treatment targets, oxygen delivery details such as "room air", or any other value that was not provided. Write "not provided" for any field without a given value. For treatment, write only "clinician to decide".
- If two or more sets of observations are given (for example on arrival and later), call flag_deterioration with them, oldest first.
- When get_emergency_summary was used, after triage and referral call post_triage_to_board with the grantId it returned and a short handover note as handoverText, so the care team sees the result. The board's colour, score, reasons and referral options are filled from the tool results, not from you.
- If a tool returns an error, do not invent its result. Continue with the steps that do not need it, and say clearly what failed.
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

// Builds the board payload from the TOOL RESULTS of this run (never from the model's own text), so the colour,
// score, reasons, essentials and referral options on the board are exactly what the tools returned.
export function boardPayload(truth, args, metrics) {
  const t = truth.triage;
  if (!t) return { error: "Score the patient with score_triage_priority before posting to the board." };
  const grantId = args.grantId || truth.summary?.grant?.id;
  if (!grantId) return { error: "No break-glass grant in this run: post_triage_to_board needs get_emergency_summary first." };
  const obs = truth.triageInput || {};
  const value = (k) => String(k === "temperature" ? `${obs.temperatureC ?? ""} C` : obs[k] ?? "");
  const s = truth.summary || {};
  return {
    payload: {
      grantId,
      patientRef: s.patientRef || "PT-UNKNOWN",
      colour: t.category, tews: t.tews,
      factors: Object.entries(t.tewsBreakdown || {}).map(([name, points]) => ({ name, value: value(name), points })),
      reasons: t.reasons || [],
      essentials: { age: s.age ?? null, gender: s.gender ?? null, bloodGroup: s.bloodGroup ?? null, genotype: s.genotype ?? null, alerts: s.alerts || [] },
      referralOptions: (truth.referral || []).map((r) => ({ facilityId: r.facilityId, name: r.name, distanceKm: r.distanceKm, level: r.level, icuBedsFree: r.icuBedsFree })),
      handoverText: String(args.handoverText || "").slice(0, 8000),
      deterioration: truth.deterioration ? { deteriorating: !!truth.deterioration.deteriorating, flags: truth.deterioration.flags || [] } : null,
      agentRunId: metrics.runId,
      agentMetrics: metrics,
    },
  };
}

// The agent loop. llm: { generate }, mcp: MCP client (listTools, callTool). Returns
// { text, iterations, steps, modelCalls, stoppedReason: "final" | "max_iterations" }.
// The model only ever sees minimised text and tool results; placeholders in its tool arguments are mapped
// back to the real values here, on this machine, before the MCP call.
// approve({ name, args }) is the human-in-the-loop gate for consequential actions (break-glass): it must
// resolve true before the call is made. prices: USD per 1M tokens (null = tokens only).
export async function runAgent({ llm, mcp, task, system = SYSTEM_PROMPT, maxIterations = MAX_ITERATIONS, log = () => {},
  minimiser = createMinimiser(), approve = async () => true, prices = null, runId = randomUUID() }) {
  const { tools } = await mcp.listTools();
  const messages = [{ role: "user", text: minimiser.text(task) }];
  const steps = [];
  const modelCalls = [];
  const truth = {};
  const metricsNow = () => {
    const tt = totals(modelCalls);
    return { runId, model: llm.model || modelCalls[0]?.model || "unknown", modelCalls: tt.calls, toolCalls: steps.length,
      inputTokens: tt.inputTokens, outputTokens: tt.outputTokens, costUsd: modelCostUsd(tt, prices) };
  };
  for (let i = 1; i <= maxIterations; i++) {
    const t0 = Date.now();
    const { text, toolCalls = [], raw, usage, model } = await llm.generate({ system, messages, tools });
    const mc = { n: i, model, ms: Date.now() - t0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
    modelCalls.push(mc);
    if (usage && (usage.inputTokens || usage.outputTokens)) log(`  model call ${i}: ${fmtInt(mc.inputTokens)} in / ${fmtInt(mc.outputTokens)} out tokens, ${(mc.ms / 1000).toFixed(1)} s`);
    if (!toolCalls.length) {
      return { text: text ?? "", iterations: i, steps, modelCalls, stoppedReason: "final", metrics: metricsNow() };
    }
    messages.push({ role: "assistant", text, toolCalls, raw });
    const results = [];
    for (const call of toolCalls) {
      let out;
      let realArgs = minimiser.restore(call.args);
      if (call.name === "get_emergency_summary" && call.args && typeof call.args === "object") {
        call.args = { ...call.args, reason: normaliseReason(call.args.reason) };
        realArgs = { ...realArgs, reason: normaliseReason(realArgs.reason) };
      }
      const started = Date.now();
      if (call.name === "get_emergency_summary" && !breakGlassAllowed(task, realArgs)) {
        out = { ok: false, result: { error: "Blocked by agent policy: break-glass needs an unconscious patient, an emergency code given in the task, and confirmBreakGlass=true." } };
      } else if (call.name === "get_emergency_summary" && !(await approve({ name: call.name, args: call.args }))) {
        out = { ok: false, result: { error: "The clinician did not approve the break-glass. No record was opened. Continue without the record." } };
      } else if (call.name === "post_triage_to_board") {
        const built = boardPayload(truth, realArgs, metricsNow());
        out = built.error ? { ok: false, result: { error: built.error } } : await execTool(mcp, call.name, built.payload);
      } else {
        out = await execTool(mcp, call.name, realArgs);
      }
      const ms = Date.now() - started;
      if (out.ok) {
        if (call.name === "get_emergency_summary") truth.summary = out.result;
        if (call.name === "score_triage_priority") { truth.triage = out.result; truth.triageInput = realArgs; }
        if (call.name === "route_referral") truth.referral = out.result.recommendations || [];
        if (call.name === "flag_deterioration") truth.deterioration = out.result;
        if (call.name === "post_triage_to_board") truth.board = out.result;
      }
      const shared = minimiser.value(out.result); // what the model is allowed to see
      steps.push({ iteration: i, name: call.name, args: call.args, ok: out.ok, ms, result: out.result, sentToModel: shared });
      log(`[${i}] ${call.name} ${short(call.args, 110)}\n    -> ${summarise({ ok: out.ok, result: shared })} (${ms} ms)`);
      results.push({ id: call.id, name: call.name, result: shared });
    }
    messages.push({ role: "tool", results });
  }
  return { text: null, iterations: maxIterations, steps, modelCalls, stoppedReason: "max_iterations", metrics: metricsNow() };
}

/** Saves the run's tool-call and token log (minimised arguments only, as the model saw them). */
export function saveRunLog(dir, { runId, task, out, prices, minimiser }) {
  mkdirSync(dir, { recursive: true });
  const tt = totals(out.modelCalls || []);
  const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${runId.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({
    runId, savedAt: new Date().toISOString(), model: out.metrics?.model, stoppedReason: out.stoppedReason, task: minimiser.text(task),
    modelCalls: out.modelCalls, toolCalls: out.steps.map((s) => ({ iteration: s.iteration, name: s.name, args: s.args, ok: s.ok, ms: s.ms,
      result: s.ok ? summarise({ ok: true, result: s.sentToModel }) : s.sentToModel?.error })),
    totals: { ...tt, toolCalls: out.steps.length, toolErrors: out.steps.filter((s) => !s.ok).length },
    prices, modelCostUsd: modelCostUsd(tt, prices), outcomeCompleted: out.stoppedReason === "final",
    postedToBoard: out.steps.some((s) => s.name === "post_triage_to_board" && s.ok),
  }, null, 2));
  return file;
}

/**
 * Real data (DEMO_MODE=0) must not go to an LLM outside the deployment country (docs/DEPLOYMENT.md). The agent
 * refuses unless LLM_IN_COUNTRY_APPROVED=1 records that the model endpoint is in-country and approved.
 */
export function llmAllowed(env = process.env) {
  return env.DEMO_MODE !== "0" || env.LLM_IN_COUNTRY_APPROVED === "1";
}

async function main() {
  if (!llmAllowed()) {
    console.error("Refusing to run: DEMO_MODE=0 means real data, and the LLM path is disabled for real data unless the model "
      + "runs in-country and is approved (set LLM_IN_COUNTRY_APPROVED=1 only then). See docs/DEPLOYMENT.md.");
    process.exit(1);
  }
  const missing = ["GEMINI_API_KEY", "GEMINI_MODEL"].filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.error(`Missing environment variable(s): ${missing.join(", ")}.\n`
      + `Set them first, for example in PowerShell:\n  $env:GEMINI_API_KEY="<your key>"\n  $env:GEMINI_MODEL="<model id>"\nthen run: npm run agent -- "<task>"`);
    process.exit(1);
  }
  const { createGeminiProvider } = await import("./llm/gemini.js");
  const llm = createGeminiProvider({ apiKey: process.env.GEMINI_API_KEY.trim(), model: process.env.GEMINI_MODEL.trim() });
  llm.model = process.env.GEMINI_MODEL.trim();
  const prices = pricesFromEnv(process.env, llm.model);
  const task = process.argv.slice(2).join(" ").trim() || DEFAULT_TASK;

  // The MCP server child process never receives the LLM credentials.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !/^GEMINI_/.test(k) && v !== undefined));
  const here = dirname(fileURLToPath(import.meta.url));
  const mcp = new Client({ name: "medistry-agent", version: "0.2.0" });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve(here, "server.js")], cwd: resolve(here, ".."), env: childEnv,
  }));

  console.log(`Task:\n${task}\n\nModel: ${llm.model} | max ${MAX_ITERATIONS} iterations | prices: ${prices ? `$${prices.inputPerM} in / $${prices.outputPerM} out per 1M tokens` : "not set"}\n`);
  // Human in the loop: the clinician approves every break-glass at this terminal before it happens.
  const approve = async ({ args }) => {
    const what = `break-glass for emergency code ${args.code} (reason: ${args.reason}). It is audited and the patient is notified.`;
    if (process.env.AGENT_AUTO_APPROVE === "1") { console.log(`\n  APPROVAL: ${what}\n  -> auto-approved (AGENT_AUTO_APPROVE=1)\n`); return true; }
    if (!process.stdin.isTTY) { console.log(`\n  APPROVAL needed for ${what}\n  -> declined: no clinician at this terminal\n`); return false; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\n  APPROVAL NEEDED: the agent wants to open a ${what}\n  Clinician, approve? (y/n) `);
    rl.close();
    const ok = /^y(es)?$/i.test(answer.trim());
    console.log(ok ? "  -> approved by the clinician\n" : "  -> declined by the clinician\n");
    return ok;
  };
  try {
    const minimiser = createMinimiser();
    const runId = randomUUID();
    const out = await runAgent({ llm, mcp, task, minimiser, prices, runId, approve, log: (s) => console.log(redact(s)) });
    console.log("\n=== Final answer ===");
    console.log(out.text ? redact(out.text) : `(no final answer: stopped after ${out.iterations} iterations)`);
    // Local legend only: what the placeholders the model saw stand for (card tokens are not printed).
    const legend = [...minimiser.placeholders()].filter(([p]) => !p.startsWith("[CARD_")).map(([p, v]) => `${p} = ${v}`);
    if (legend.length) console.log(`\nPlaceholders (local only, never sent to the model): ${legend.join(", ")}`);
    const tt = totals(out.modelCalls);
    const errors = out.steps.filter((s) => !s.ok).length;
    console.log("\n=== Run summary (measured from this run's API usage) ===");
    console.log(`Model: ${llm.model} | model calls: ${tt.calls} | tool calls: ${out.steps.length}${errors ? ` (${errors} returned an error)` : ""}`);
    console.log(`Tokens: ${fmtInt(tt.inputTokens)} in + ${fmtInt(tt.outputTokens)} out = ${fmtInt(tt.totalTokens)} | per model call: ${fmtInt(Math.round(tt.totalTokens / Math.max(1, tt.calls)))}`);
    console.log(`Model cost of this outcome: ${fmtUsd(modelCostUsd(tt, prices))}`);
    const board = out.steps.find((s) => s.name === "post_triage_to_board" && s.ok);
    if (board) console.log(`Posted to the triage board -> ${board.result.boardUrl}`);
    const logFile = saveRunLog(resolve(here, "..", "output", "runs"), { runId, task, out, prices, minimiser });
    console.log(`Tool-call and token log: ${logFile}`);
    const banner = validationBanner();
    if (banner) console.log(`\n${banner}.`);
    console.log("\nDecision support only, synthetic data. A clinician must validate every output.");
    if (out.stoppedReason !== "final") process.exitCode = 2;
  } finally {
    await mcp.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`Agent failed: ${redact(e?.message ?? e)}`); process.exit(1); });
}
