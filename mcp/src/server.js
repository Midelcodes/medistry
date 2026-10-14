#!/usr/bin/env node
// Medistry triage MCP server (team-built). Stdio transport.
// Tools: score_triage_priority, flag_deterioration, queue_add_patient, queue_get, queue_call_next,
//        route_referral, get_emergency_summary (reads Medistry through its audited break-glass API).
// Data residency: the only network call is to MEDISTRY_URL, and only to hosts in MEDISTRY_ALLOWED_HOSTS
// (default localhost). Queues are in-process memory and use pseudonymous patient references.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { triage, detectDeterioration, CATEGORIES, EMERGENCY_SIGNS, VERY_URGENT_SIGNS } from "./tews.js";
import { FACILITIES, LEVEL_RANK, haversineKm } from "./facilities.js";
import { emergencySummary } from "./medistry-client.js";

const obs = {
  mobility: z.enum(["walking", "with_help", "immobile"]),
  respiratoryRate: z.number().min(0).max(80).describe("breaths/min"),
  heartRate: z.number().min(0).max(300).describe("beats/min"),
  systolicBP: z.number().min(0).max(300).describe("mmHg"),
  temperatureC: z.number().min(25).max(45),
  avpu: z.enum(["alert", "voice", "pain", "unresponsive"]),
  trauma: z.boolean().default(false),
};
const obsSchema = z.object(obs);
const signs = z.array(z.enum([...EMERGENCY_SIGNS, ...VERY_URGENT_SIGNS])).default([])
  .describe("Clinical discriminators that can override the numeric score");

const queues = new Map(FACILITIES.map((f) => [f.id, []]));
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const err = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });
const sortQueue = (q) =>
  q.sort((a, b) => CATEGORIES[a.category].rank - CATEGORIES[b.category].rank || a.arrivedAt.localeCompare(b.arrivedAt));

const server = new McpServer({ name: "medistry-triage-mcp", version: "0.2.0" });

server.registerTool("score_triage_priority", {
  title: "Score triage priority (SATS TEWS)",
  description: "Scores an adult patient (age >= 12) with the South African Triage Scale TEWS plus clinical discriminators. Returns colour category, target time to clinician, score breakdown and reasons. Decision support only.",
  inputSchema: { age: z.number().int().min(12).max(120), ...obs, signs },
}, async ({ age, signs: s, ...o }) => ok({ age, ...triage({ ...o, signs: s }) }));

server.registerTool("flag_deterioration", {
  title: "Flag clinical deterioration",
  description: "Takes 2-12 observation sets ordered oldest to newest and flags worsening TEWS trend, sudden jumps, threshold crossings or drops in consciousness.",
  inputSchema: { observations: z.array(obsSchema).min(2).max(12) },
}, async ({ observations }) => ok(detectDeterioration(observations)));

server.registerTool("queue_add_patient", {
  title: "Add triaged patient to a facility queue",
  description: "Adds a patient to a facility's emergency queue using their triage category. Use pseudonymous references only (for example the patientRef from get_emergency_summary). Never a name.",
  inputSchema: {
    facilityId: z.string(),
    patientId: z.string().describe("Pseudonymous reference, e.g. PT-1042. Never a name."),
    category: z.enum(["RED", "ORANGE", "YELLOW", "GREEN"]),
    arrivedAt: z.string().datetime().optional(),
  },
}, async ({ facilityId, patientId, category, arrivedAt }) => {
  const q = queues.get(facilityId);
  if (!q) return err(`Unknown facility ${facilityId}`);
  if (q.some((e) => e.patientId === patientId)) return err(`${patientId} already queued at ${facilityId}`);
  q.push({ patientId, category, arrivedAt: arrivedAt ?? new Date().toISOString() });
  return ok({ facilityId, position: sortQueue(q).findIndex((e) => e.patientId === patientId) + 1, queueLength: q.length });
});

server.registerTool("queue_get", {
  title: "Get a facility queue",
  description: "Returns the priority-ordered queue (RED first, then by arrival time) with target times and overdue flags.",
  inputSchema: { facilityId: z.string(), now: z.string().datetime().optional() },
}, async ({ facilityId, now }) => {
  const q = queues.get(facilityId);
  if (!q) return err(`Unknown facility ${facilityId}`);
  const t = new Date(now ?? Date.now()).getTime();
  const rows = sortQueue(q).map((e, i) => {
    const waited = Math.round((t - new Date(e.arrivedAt).getTime()) / 60000);
    const target = CATEGORIES[e.category].targetMinutes;
    return { position: i + 1, ...e, waitedMinutes: waited, targetMinutes: target, overdue: waited > target };
  });
  return ok({ facilityId, length: rows.length, queue: rows });
});

server.registerTool("queue_call_next", {
  title: "Call next patient",
  description: "Removes and returns the highest-priority patient from a facility queue.",
  inputSchema: { facilityId: z.string() },
}, async ({ facilityId }) => {
  const q = queues.get(facilityId);
  if (!q) return err(`Unknown facility ${facilityId}`);
  if (!q.length) return err("Queue empty");
  return ok({ called: sortQueue(q).shift() });
});

server.registerTool("route_referral", {
  title: "Route a referral to the best in-country facility",
  description: "Recommends up to 3 Nigerian facilities (synthetic dataset) for a patient, filtered by required capability, open emergency department and ICU bed availability, ranked by level of care, distance and current queue length.",
  inputSchema: {
    category: z.enum(["RED", "ORANGE", "YELLOW", "GREEN"]),
    requiredCapability: z.enum(["emergency", "icu", "cardiology", "trauma_surgery", "obstetrics", "neurology", "burns", "general_surgery", "haematology", "general"]),
    patientLat: z.number().min(-90).max(90),
    patientLon: z.number().min(-180).max(180),
    excludeFacilityId: z.string().optional().describe("Referring facility, excluded from results"),
  },
}, async ({ category, requiredCapability, patientLat, patientLon, excludeFacilityId }) => {
  const needsIcu = category === "RED" || requiredCapability === "icu";
  const loc = { lat: patientLat, lon: patientLon };
  const ranked = FACILITIES
    .filter((f) => f.id !== excludeFacilityId && f.edOpen && f.capabilities.includes(requiredCapability))
    .filter((f) => !needsIcu || f.icuBedsFree > 0)
    .map((f) => {
      const km = haversineKm(loc, f);
      const qlen = queues.get(f.id).length;
      const distW = category === "RED" || category === "ORANGE" ? 1.5 : 1;
      return { score: km * distW + qlen * 5 - LEVEL_RANK[f.level] * 15, f, km, qlen };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map(({ f, km, qlen }) => ({
      facilityId: f.id, name: f.name, state: f.state, level: f.level,
      distanceKm: Math.round(km), currentQueue: qlen, icuBedsFree: f.icuBedsFree,
      why: [`has ${requiredCapability}`, "ED open", needsIcu ? "ICU bed available" : null].filter(Boolean),
    }));
  if (!ranked.length) return ok({ recommendations: [], note: "No in-country facility meets the requirements. Escalate to the regional emergency coordinator." });
  return ok({ recommendations: ranked, dataNote: "Synthetic facility dataset. Replace with a live national facility registry." });
});

server.registerTool("get_emergency_summary", {
  title: "Get emergency summary from Medistry (break-glass)",
  description: "Starts a REAL, audited break-glass session in Medistry for the scanned emergency code and returns a minimised critical-info summary: blood group, genotype, allergies, chronic conditions, current medications, DNR flag and alerts. The patient and their contacts are notified and the access is logged. Use only when the patient cannot consent and treatment is urgent. Requires confirmBreakGlass=true.",
  inputSchema: {
    code: z.string().min(8).describe("Emergency code from the patient's card, wristband or QR (for example K7QM-4T9X-2HDP-8W2)"),
    reason: z.enum(["UNCONSCIOUS", "LIFE_THREATENING", "PATIENT_UNABLE_TO_CONSENT"]),
    confirmBreakGlass: z.literal(true).describe("Must be true. Confirms the clinician accepts that this access is audited and the patient is notified."),
  },
}, async ({ code, reason }) => {
  try { return ok(await emergencySummary({ code, reason })); }
  catch (e) { return err(e.message); }
});

await server.connect(new StdioServerTransport());
