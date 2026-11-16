// Unit economics and human-in-the-loop: measured tokens, cost per outcome, margin table, break-glass approval,
// board values taken from tool results, and resilient Medistry calls. No network, no API key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runAgent, boardPayload } from "../src/agent.js";
import { createGeminiProvider } from "../src/llm/gemini.js";
import { modelCostUsd, marginTable, pricesFromEnv, totals } from "../src/metrics.js";

let mcp;
before(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GEMINI_/.test(k)));
  mcp = new Client({ name: "economics-test", version: "0.2.0" });
  await mcp.connect(new StdioClientTransport({ command: "node", args: ["src/server.js"], env }));
});
after(() => mcp.close());

function mockGenai(script, usage = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50, totalTokenCount: 1150 }) {
  const requests = [];
  return { requests, client: { models: { generateContent: async (req) => {
    requests.push(req);
    const r = script[requests.length - 1];
    const parts = r.calls ? r.calls.map((c) => ({ functionCall: c })) : [{ text: r.text }];
    return { functionCalls: r.calls, text: r.text, usageMetadata: usage, candidates: [{ content: { role: "model", parts } }] };
  } } } };
}
const VITALS = { age: 40, mobility: "walking", respiratoryRate: 28, heartRate: 130, systolicBP: 90, temperatureC: 37.2, avpu: "alert", trauma: false, signs: [] };

test("Token use is measured per model call (thinking counted as output) and costed with the model's price", async () => {
  const { client } = mockGenai([{ calls: [{ id: "a", name: "score_triage_priority", args: VITALS }] }, { text: "Done. Decision support only." }]);
  const llm = createGeminiProvider({ apiKey: "x", model: "gemini-3.5-flash", client });
  const prices = pricesFromEnv({}, "gemini-3.5-flash");
  const out = await runAgent({ llm, mcp, task: "triage", prices });
  assert.equal(out.modelCalls.length, 2);
  assert.deepEqual(out.modelCalls.map((c) => [c.inputTokens, c.outputTokens]), [[1000, 150], [1000, 150]]);
  const t = totals(out.modelCalls);
  assert.deepEqual([t.inputTokens, t.outputTokens, t.calls], [2000, 300, 2]);
  assert.ok(Math.abs(modelCostUsd(t, prices) - (2000 * 1.5 + 300 * 9) / 1e6) < 1e-12);
  assert.equal(out.metrics.toolCalls, 1);
});

test("Break-glass needs the clinician's approval; a declined approval opens nothing", async () => {
  const code = "K7QM-4T9X-2HDP-8W2";
  const { client } = mockGenai([{ calls: [{ id: "b", name: "get_emergency_summary", args: { code, reason: "UNCONSCIOUS", confirmBreakGlass: true } }] }, { text: "Not opened." }]);
  const asked = [];
  const out = await runAgent({ llm: createGeminiProvider({ apiKey: "x", model: "m", client }), mcp, task: `Unconscious patient, emergency code ${code}.`,
    approve: async (req) => { asked.push(req.name); return false; } });
  assert.deepEqual(asked, ["get_emergency_summary"]);
  assert.equal(out.steps[0].ok, false);
  assert.match(out.steps[0].result.error, /did not approve/);
});

test("The board payload comes from tool results, never from the model's own values", () => {
  const truth = {
    summary: { patientRef: "PT-1", age: 28, gender: "FEMALE", bloodGroup: "O+", genotype: "SS", alerts: ["a"], grant: { id: "grant-123" } },
    triage: { category: "RED", tews: 9, tewsBreakdown: { heartRate: 2, avpu: 1 }, reasons: ["TEWS 9 >= 7"] },
    triageInput: { heartRate: 118, avpu: "voice" },
    referral: [{ facilityId: "NG-LAG-001", name: "Ikeja", distanceKm: 11, level: "tertiary", icuBedsFree: 2 }],
  };
  const { payload } = boardPayload(truth, { colour: "GREEN", tews: 0, handoverText: "note" }, { model: "m", modelCalls: 3, toolCalls: 4, inputTokens: 1, outputTokens: 1, costUsd: 0 });
  assert.deepEqual([payload.colour, payload.tews, payload.grantId], ["RED", 9, "grant-123"]);
  assert.deepEqual(payload.factors, [{ name: "heartRate", value: "118", points: 2 }, { name: "avpu", value: "voice", points: 1 }]);
  assert.equal(payload.referralOptions[0].name, "Ikeja");
  assert.ok(boardPayload({}, {}, {}).error, "no triage, no post");
});

test("Margin table: hosting per outcome falls with volume; model and SMS stay linear", () => {
  const t = marginTable({ modelCostPerOutcome: 0.02, smsPerOutcome: 2, smsPrice: 0.01, hostingPerMonth: 5, hostingStep: 20, pilotVolume: 600, price: 1 });
  assert.deepEqual(t.map((r) => r.volume), [600, 6000, 60000]);
  assert.ok(t[0].hostingPer > t[1].hostingPer && t[1].hostingPer > t[2].hostingPer);
  assert.ok(t.every((r) => Math.abs(r.sms - 0.02) < 1e-12 && r.model === 0.02));
  assert.ok(t.every((r) => r.margin > 0));
});

import { normaliseReason } from "../src/reasons.js";
test("break-glass reason typos are mapped to the allowed value", () => {
  assert.equal(normaliseReason("UNCONCONSCIOUS"), "UNCONSCIOUS");
  assert.equal(normaliseReason("unconscious patient"), "UNCONSCIOUS");
  assert.equal(normaliseReason("life threatening"), "LIFE_THREATENING");
  assert.equal(normaliseReason("UNABLE TO CONSENT"), "PATIENT_UNABLE_TO_CONSENT");
  assert.equal(normaliseReason("BORED"), "BORED");
});
