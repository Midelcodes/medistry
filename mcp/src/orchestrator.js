#!/usr/bin/env node
// Orchestrator: LangGraph (open-source) state graph that drives
//   1. OUR MCP server (src/server.js): Medistry emergency summary or offline card, triage, queue, routing
//   2. EXTERNAL MCP server (@modelcontextprotocol/server-filesystem, not built by us): writes the handover report
// Scenario: an unconscious patient is identified -> critical history -> triage -> referral -> handover
//   -> triage board (the result appears on the Medistry clinician triage board, decision support only).
// `npm run demo:deteriorate` re-triages the same patient with worse observations and runs flag_deterioration,
// so the board shows the Deteriorating badge.
//   - Emergency code (default): get_emergency_summary, an audited break-glass in Medistry.
//   - Offline card token or link (argv[2] or MEDISTRY_CARD): verify_offline_card, checked locally.
// Needs a running Medistry (default http://localhost:3000, demo mode). No LLM and no internet needed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractCardToken } from "./offline-card.js";
import { reportBannerLines } from "./validation.js";

const BASE = (process.env.MEDISTRY_URL || "http://localhost:3000").replace(/\/$/, "");

async function connect(name, command, args, env) {
  const c = new Client({ name, version: "0.2.0" });
  await c.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
  return c;
}

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

export const isCardInput = (input) => !!extractCardToken(input);

const HOME = "NG-LAG-003";
// Synthetic observations for the unconscious patient on arrival
const VITALS = { mobility: "with_help", respiratoryRate: 26, heartRate: 118, systolicBP: 98, temperatureC: 38.7, avpu: "voice", trauma: false };
const SIGNS = ["severe_pain", "reduced_consciousness"];
// Synthetic observations 20 minutes later, for the deterioration scenario
const WORSE_VITALS = { mobility: "immobile", respiratoryRate: 32, heartRate: 134, systolicBP: 84, temperatureC: 39.2, avpu: "pain", trauma: false };
const FACTOR_VALUE = (v, name) => String(name === "temperature" ? `${v.temperatureC} C` : v[name] ?? "");
// Offline cards carry no date of birth. The adult scale (age >= 12) is used once the clinician judges the
// patient to be an adult; this value only satisfies that check and is never reported as the patient's age.
const ADULT_SCALE_AGE = 18;

const State = Annotation.Root({
  summary: Annotation({ reducer: (_, b) => b, default: () => null }),
  triage: Annotation({ reducer: (_, b) => b, default: () => null }),
  referral: Annotation({ reducer: (_, b) => b, default: () => [] }),
  report: Annotation({ reducer: (_, b) => b, default: () => "" }),
  deterioration: Annotation({ reducer: (_, b) => b, default: () => null }),
  board: Annotation({ reducer: (_, b) => b, default: () => null }),
});

/** Builds and runs the graph. input: an emergency code, or an offline card token / link. */
export async function runScenario({ input, triageMcp, fsMcp, outDir, scenario = process.env.MEDISTRY_SCENARIO || "arrival" }) {
  const card = isCardInput(input);
  const deteriorate = scenario === "deteriorate";
  const vitals = deteriorate ? WORSE_VITALS : VITALS;

  async function scanNode() {
    if (card) {
      const v = await call(triageMcp, "verify_offline_card", { token: input });
      return { summary: { source: "card", ...v } };
    }
    const summary = await call(triageMcp, "get_emergency_summary", { code: input, reason: "UNCONSCIOUS", confirmBreakGlass: true });
    return { summary: { source: "code", ...summary } };
  }

  async function triageNode({ summary }) {
    const age = summary.source === "card" ? ADULT_SCALE_AGE : summary.age;
    const ref = summary.source === "card" ? (summary.cardRef || "CARD-UNVERIFIED") : summary.patientRef;
    const t = await call(triageMcp, "score_triage_priority", { age, ...vitals, signs: SIGNS });
    await call(triageMcp, "queue_add_patient", { facilityId: HOME, patientId: ref, category: t.category });
    // Re-assessment: compare the arrival observations with the new ones.
    const deterioration = deteriorate ? await call(triageMcp, "flag_deterioration", { observations: [VITALS, WORSE_VITALS] }) : null;
    return { triage: t, deterioration };
  }

  async function routeNode({ summary, triage }) {
    // A haematology need is suggested only when VERIFIED data documents a sickle cell genotype.
    const usable = summary.source === "code" || summary.verified;
    const cap = usable && ["SS", "SC"].includes(summary.genotype) ? "haematology" : "emergency";
    const ref = await call(triageMcp, "route_referral", {
      category: triage.category, requiredCapability: cap, patientLat: 6.5, patientLon: 3.35, excludeFacilityId: HOME,
    });
    return { referral: ref.recommendations };
  }

  async function handoverNode({ summary, triage, referral, deterioration }) {
    const L = ["# Emergency handover (SYNTHETIC DEMO DATA)", "", ...reportBannerLines()];
    if (summary.source === "card") {
      if (summary.verified) {
        L.push(`Source: offline Medistry card v${summary.cardVersion}, signature verified`);
        if (summary.expired) L.push(`WARNING: card expired on ${summary.expiresOn}. Genuine when issued, may be out of date.`);
        L.push(`Card ref: ${summary.cardRef} | Age: not on card (adult triage scale used)`,
          `Blood group: ${summary.bloodGroup} | Genotype: ${summary.genotype}`, "", "## Alerts from the card");
        if (summary.dnr) L.push("- Advance directive (DNR) on the card. Confirm with the treating clinician before resuscitation decisions.");
        for (const a of summary.allergies) L.push(`- Severe allergy: ${a.substance} (${a.reaction})${a.patientReported ? " [patient-reported, not clinician-verified]" : ""}`);
        if (["SS", "SC"].includes(summary.genotype)) L.push(`- Sickle cell genotype ${summary.genotype} on the card.`);
        if (summary.conditions.length) L.push("", `Conditions: ${summary.conditions.join(", ")}`);
        if (summary.medications.length) L.push(`Medications: ${summary.medications.map((m) => `${m.name} ${m.dose}`).join("; ")}`);
        if (summary.recentDiagnosis) L.push(`Recent diagnosis: ${summary.recentDiagnosis.text} (${summary.recentDiagnosis.date})`);
      } else {
        L.push("Source: offline Medistry card, NOT VERIFIED",
          `${summary.refusal || "The card could not be verified."} Card data was not used; treat the patient as having no known record.`);
      }
    } else {
      L.push(`Patient ref: ${summary.patientRef} (${summary.age}y ${summary.gender})`,
        `Blood group: ${summary.bloodGroup} | Genotype: ${summary.genotype}`, "", "## Alerts from Medistry record");
      for (const a of summary.alerts) L.push(`- ${a}`);
      if (summary.chronicConditions.length) L.push("", `Chronic conditions: ${summary.chronicConditions.join(", ")}`);
      if (summary.activeMedications.length) L.push(`Current medications: ${summary.activeMedications.map((m) => `${m.name} ${m.dose}`).join("; ")}`);
    }
    L.push("", "## Triage", `${triage.category} (TEWS ${triage.tews}). ${triage.reasons.join("; ")}`, `Target time to clinician: ${triage.targetMinutes} min`);
    if (deterioration) {
      L.push("", "## Deterioration", deterioration.deteriorating ? `DETERIORATING. ${deterioration.flags.join("; ")}` : "No deterioration flagged.", deterioration.action);
    }
    L.push("", "## Referral options");
    for (const r of referral) L.push(`- ${r.name} (${r.distanceKm} km, ${r.level}, ICU beds free: ${r.icuBedsFree})`);
    if (summary.source === "code") {
      L.push("", `Medistry break-glass grant ${summary.grant.id.slice(0, 8)} (read-only, expires ${summary.grant.expiresAt}). Access is in the audit chain and the patient was notified.`);
    } else {
      L.push("", "Offline card read locally: no Medistry break-glass was opened. Record the scan in the Medistry scanner so it is audited and the patient is notified.");
    }
    L.push("", "_Decision support only. A clinician makes every clinical decision. Data stayed on this machine._");
    const report = L.join("\n");
    await call(fsMcp, "write_file", { path: `${outDir}/handover.md`, content: report }); // EXTERNAL MCP server
    return { report };
  }

  // Shows the result on the Medistry clinician triage board, through our MCP server. Needs the break-glass grant
  // (code path). A failure is reported but never stops the handover, which is already written.
  async function boardNode({ summary, triage, referral, report, deterioration }) {
    if (summary.source !== "code") return { board: { posted: false, note: "Offline card read locally: nothing posted to the triage board." } };
    try {
      const factors = Object.entries(triage.tewsBreakdown || {}).map(([name, points]) => ({ name, value: FACTOR_VALUE(vitals, name), points }));
      const posted = await call(triageMcp, "post_triage_to_board", {
        grantId: summary.grant.id, patientRef: summary.patientRef, colour: triage.category, tews: triage.tews, factors, reasons: triage.reasons,
        essentials: { age: summary.age, gender: summary.gender, bloodGroup: summary.bloodGroup, genotype: summary.genotype, alerts: summary.alerts },
        referralOptions: referral.map((r) => ({ facilityId: r.facilityId, name: r.name, distanceKm: r.distanceKm, level: r.level, icuBedsFree: r.icuBedsFree })),
        handoverText: report,
        deterioration: deterioration ? { deteriorating: deterioration.deteriorating, flags: deterioration.flags } : null,
      });
      return { board: { posted: true, ...posted } };
    } catch (e) {
      return { board: { posted: false, note: `Not posted to the triage board: ${e.message}` } };
    }
  }

  const graph = new StateGraph(State)
    .addNode("scan_step", scanNode).addNode("triage_step", triageNode).addNode("route_step", routeNode).addNode("handover_step", handoverNode)
    .addNode("board_step", boardNode)
    .addEdge(START, "scan_step").addEdge("scan_step", "triage_step").addEdge("triage_step", "route_step").addEdge("route_step", "handover_step")
    .addEdge("handover_step", "board_step").addEdge("board_step", END)
    .compile();
  return graph.invoke({});
}

/** Starts both MCP servers (ours and the external filesystem server) for an output directory. */
export async function connectServers(outDir, env = {}) {
  const triageMcp = await connect("orchestrator->triage", "node", ["src/server.js"], { MEDISTRY_DEMO: "1", ...env });
  const fsMcp = await connect("orchestrator->filesystem", "node",
    ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", outDir], env);
  return { triageMcp, fsMcp };
}

async function main() {
  const OUT = resolve("output");
  mkdirSync(OUT, { recursive: true });
  const { triageMcp, fsMcp } = await connectServers(OUT);
  try {
    const args = process.argv.slice(2);
    const scenario = args.includes("--deteriorate") ? "deteriorate" : (process.env.MEDISTRY_SCENARIO || "arrival");
    const input = args.find((a) => !a.startsWith("--")) || process.env.MEDISTRY_CARD || await demoCode();
    const final = await runScenario({ input, triageMcp, fsMcp, outDir: OUT, scenario });
    console.log(final.report);
    console.log(`\nWritten via external filesystem MCP server -> ${OUT}/handover.md`);
    if (final.board?.posted) console.log(`Posted to the Medistry triage board (${final.board.colour}, TEWS ${final.board.tews}) -> ${final.board.boardUrl}`);
    else if (final.board?.note) console.log(final.board.note);
  } finally {
    await triageMcp.close(); await fsMcp.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
