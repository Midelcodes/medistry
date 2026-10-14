#!/usr/bin/env node
// Orchestrator: LangGraph (open-source) state graph that drives
//   1. OUR MCP server (src/server.js): Medistry emergency summary, triage, queue, routing
//   2. EXTERNAL MCP server (@modelcontextprotocol/server-filesystem, not built by us): writes the handover report
// Scenario: an unconscious patient is scanned (Medistry code) -> critical history -> triage -> referral -> handover.
// Needs a running Medistry (default http://localhost:3000, demo mode). No LLM and no internet needed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("output");
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.MEDISTRY_URL || "http://localhost:3000").replace(/\/$/, "");

async function connect(name, command, args, env) {
  const c = new Client({ name, version: "0.2.0" });
  await c.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
  return c;
}
const triageMcp = await connect("orchestrator->triage", "node", ["src/server.js"], { MEDISTRY_DEMO: "1" });
const fsMcp = await connect("orchestrator->filesystem", "node",
  ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", OUT]);

const call = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};

// Demo only: the demo server's /demo route redirects to the priority synthetic patient's emergency gate.
async function demoCode() {
  if (process.env.MEDISTRY_DEMO_CODE) return process.env.MEDISTRY_DEMO_CODE;
  const r = await fetch(`${BASE}/demo`, { redirect: "manual" });
  const loc = r.headers.get("location") || "";
  if (!loc.startsWith("/e/")) throw new Error(`Could not find a demo code at ${BASE}/demo. Is Medistry running in demo mode?`);
  return decodeURIComponent(loc.slice(3));
}

const HOME = "NG-LAG-003";
// Synthetic observations for the unconscious patient on arrival
const VITALS = { mobility: "with_help", respiratoryRate: 26, heartRate: 118, systolicBP: 98, temperatureC: 38.7, avpu: "voice", trauma: false };
const SIGNS = ["severe_pain", "reduced_consciousness"];

const State = Annotation.Root({
  summary: Annotation({ reducer: (_, b) => b, default: () => null }),
  triage: Annotation({ reducer: (_, b) => b, default: () => null }),
  referral: Annotation({ reducer: (_, b) => b, default: () => [] }),
  report: Annotation({ reducer: (_, b) => b, default: () => "" }),
});

async function scanNode() {
  const summary = await call(triageMcp, "get_emergency_summary", {
    code: await demoCode(), reason: "UNCONSCIOUS", confirmBreakGlass: true,
  });
  return { summary };
}

async function triageNode({ summary }) {
  const t = await call(triageMcp, "score_triage_priority", { age: summary.age, ...VITALS, signs: SIGNS });
  await call(triageMcp, "queue_add_patient", { facilityId: HOME, patientId: summary.patientRef, category: t.category });
  return { triage: t };
}

async function routeNode({ summary, triage }) {
  // A haematology need is suggested only when the record documents a sickle cell genotype.
  const cap = ["SS", "SC"].includes(summary.genotype) ? "haematology" : "emergency";
  const ref = await call(triageMcp, "route_referral", {
    category: triage.category, requiredCapability: cap, patientLat: 6.5, patientLon: 3.35, excludeFacilityId: HOME,
  });
  return { referral: ref.recommendations };
}

async function handoverNode({ summary, triage, referral }) {
  const L = ["# Emergency handover (SYNTHETIC DEMO DATA)", "",
    `Patient ref: ${summary.patientRef} (${summary.age}y ${summary.gender})`,
    `Blood group: ${summary.bloodGroup} | Genotype: ${summary.genotype}`, "", "## Alerts from Medistry record"];
  for (const a of summary.alerts) L.push(`- ${a}`);
  if (summary.chronicConditions.length) L.push("", `Chronic conditions: ${summary.chronicConditions.join(", ")}`);
  if (summary.activeMedications.length) L.push(`Current medications: ${summary.activeMedications.map((m) => `${m.name} ${m.dose}`).join("; ")}`);
  L.push("", "## Triage", `${triage.category} (TEWS ${triage.tews}). ${triage.reasons.join("; ")}`, `Target time to clinician: ${triage.targetMinutes} min`);
  L.push("", "## Referral options");
  for (const r of referral) L.push(`- ${r.name} (${r.distanceKm} km, ${r.level}, ICU beds free: ${r.icuBedsFree})`);
  L.push("", `Medistry break-glass grant ${summary.grant.id.slice(0, 8)} (read-only, expires ${summary.grant.expiresAt}). Access is in the audit chain and the patient was notified.`,
    "", "_Decision support only. A clinician makes every clinical decision. Data stayed on this machine._");
  const report = L.join("\n");
  await call(fsMcp, "write_file", { path: `${OUT}/handover.md`, content: report }); // EXTERNAL MCP server
  return { report };
}

const graph = new StateGraph(State)
  .addNode("scan_step", scanNode).addNode("triage_step", triageNode).addNode("route_step", routeNode).addNode("handover_step", handoverNode)
  .addEdge(START, "scan_step").addEdge("scan_step", "triage_step").addEdge("triage_step", "route_step").addEdge("route_step", "handover_step").addEdge("handover_step", END)
  .compile();

const final = await graph.invoke({});
console.log(final.report);
console.log(`\nWritten via external filesystem MCP server -> ${OUT}/handover.md`);
await triageMcp.close(); await fsMcp.close();
