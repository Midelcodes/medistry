// Agent loop tests: a mocked Gemini client drives the real MCP server over stdio. No network, no API key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runAgent, redact, breakGlassAllowed, MAX_ITERATIONS, DEFAULT_TASK } from "../src/agent.js";
import { createGeminiProvider, toFunctionDeclarations } from "../src/llm/gemini.js";

let mcp;
before(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GEMINI_/.test(k)));
  mcp = new Client({ name: "agent-test", version: "0.2.0" });
  await mcp.connect(new StdioClientTransport({ command: "node", args: ["src/server.js"], env }));
});
after(() => mcp.close());

// Fake @google/genai client: replies come from a script; every request is recorded.
function mockGenai(script) {
  const requests = [];
  const client = { models: { generateContent: async (req) => {
    requests.push(structuredClone(req));
    const r = typeof script === "function" ? script(requests.length) : script[requests.length - 1];
    const parts = r.calls ? r.calls.map((c) => ({ functionCall: c })) : [{ text: r.text }];
    return { functionCalls: r.calls, text: r.text, candidates: [{ content: { role: "model", parts } }] };
  } } };
  return { client, requests };
}
const provider = (client) => createGeminiProvider({ apiKey: "unused-in-tests", model: "mock-model", client });

const VITALS = { age: 58, mobility: "with_help", respiratoryRate: 28, heartRate: 130, systolicBP: 90, temperatureC: 37.2, avpu: "alert", trauma: false, signs: ["chest_pain"] };

test("MCP tool schemas convert to Gemini function declarations", async () => {
  const { tools } = await mcp.listTools();
  const decls = toFunctionDeclarations(tools);
  assert.equal(decls.length, tools.length);
  const json = JSON.stringify(decls);
  for (const banned of ["additionalProperties", "$schema", "\"default\"", "\"const\""]) assert.ok(!json.includes(banned), banned);
  const triage = decls.find((d) => d.name === "score_triage_priority").parameters;
  assert.equal(triage.type, "OBJECT");
  assert.deepEqual(triage.properties.avpu.enum, ["alert", "voice", "pain", "unresponsive"]);
  assert.equal(triage.properties.signs.type, "ARRAY");
  const bg = decls.find((d) => d.name === "get_emergency_summary").parameters.properties.confirmBreakGlass;
  assert.equal(bg.type, "BOOLEAN");
  assert.match(bg.description, /Must be true/);
});

test("loop executes tool calls, feeds results back and stops at final text", async () => {
  const { client, requests } = mockGenai([
    { calls: [{ id: "c1", name: "score_triage_priority", args: VITALS }] },
    { calls: [{ id: "c2", name: "route_referral", args: { category: "ORANGE", requiredCapability: "cardiology", patientLat: 6.5, patientLon: 3.35, excludeFacilityId: "NG-LAG-003" } }] },
    { text: "Final: triaged and referred. Decision support only; clinician must validate." },
  ]);
  const logs = [];
  const out = await runAgent({ llm: provider(client), mcp, task: DEFAULT_TASK, log: (s) => logs.push(s) });

  assert.equal(out.stoppedReason, "final");
  assert.equal(out.iterations, 3);
  assert.match(out.text, /clinician must validate/);
  assert.deepEqual(out.steps.map((s) => [s.name, s.ok]), [["score_triage_priority", true], ["route_referral", true]]);
  assert.equal(logs.length, 2);

  // Request 1: task + tool declarations + system prompt.
  assert.equal(requests[0].model, "mock-model");
  assert.match(requests[0].config.systemInstruction, /do not invent clinical values/i);
  for (const rule of [/only values given in the task or returned by a tool/, /Do not add diagnoses/, /room air/, /"not provided"/, /"clinician to decide"/]) {
    assert.match(requests[0].config.systemInstruction, rule);
  }
  assert.equal(requests[0].config.tools[0].functionDeclarations.length, (await mcp.listTools()).tools.length);
  assert.equal(requests[0].contents[0].parts[0].text, DEFAULT_TASK);

  // Request 2: model's call replayed, then the real tool result as a function response.
  const [, modelTurn, toolTurn] = requests[1].contents;
  assert.equal(modelTurn.role, "model");
  assert.equal(modelTurn.parts[0].functionCall.name, "score_triage_priority");
  const fr = toolTurn.parts[0].functionResponse;
  assert.equal(fr.name, "score_triage_priority");
  assert.equal(fr.id, "c1");
  assert.equal(fr.response.category, out.steps[0].result.category);
  assert.ok(["RED", "ORANGE", "YELLOW", "GREEN"].includes(fr.response.category));

  // Request 3 carries the referral result.
  const recs = requests[2].contents.at(-1).parts[0].functionResponse.response.recommendations;
  assert.ok(recs.length >= 1 && recs.every((r) => r.facilityId !== "NG-LAG-003"));
});

test("tool errors are fed back to the model as error responses", async () => {
  const { client, requests } = mockGenai([
    { calls: [{ id: "e1", name: "queue_get", args: { facilityId: "NG-NOPE-999" } }] },
    { text: "done" },
  ]);
  const out = await runAgent({ llm: provider(client), mcp, task: "check queue" });
  assert.equal(out.steps[0].ok, false);
  assert.match(requests[1].contents.at(-1).parts[0].functionResponse.response.error, /Unknown facility/);
});

test("enforces the 8-iteration cap", async () => {
  const { client, requests } = mockGenai((n) => ({ calls: [{ id: `q${n}`, name: "queue_get", args: { facilityId: "NG-LAG-001" } }] }));
  const out = await runAgent({ llm: provider(client), mcp, task: "loop forever" });
  assert.equal(MAX_ITERATIONS, 8);
  assert.equal(requests.length, 8);
  assert.equal(out.stoppedReason, "max_iterations");
  assert.equal(out.text, null);
  assert.equal(out.steps.length, 8);
});

test("get_emergency_summary is blocked unless unconscious + code in task + confirmBreakGlass", async () => {
  const args = { code: "K7QM-4T9X-2HDP-8W2", reason: "UNCONSCIOUS", confirmBreakGlass: true };
  const { client, requests } = mockGenai([{ calls: [{ id: "b1", name: "get_emergency_summary", args }] }, { text: "ok" }]);
  const out = await runAgent({ llm: provider(client), mcp, task: DEFAULT_TASK });
  assert.equal(out.steps[0].ok, false);
  assert.match(requests[1].contents.at(-1).parts[0].functionResponse.response.error, /Blocked by agent policy/);

  assert.equal(breakGlassAllowed("Patient is unconscious. Code K7QM-4T9X-2HDP-8W2.", args), true);
  assert.equal(breakGlassAllowed("Patient is unconscious. Code K7QM-4T9X-2HDP-8W2.", { ...args, confirmBreakGlass: false }), false);
  assert.equal(breakGlassAllowed("Patient is alert. Code K7QM-4T9X-2HDP-8W2.", args), false);
  assert.equal(breakGlassAllowed("Patient is unconscious.", args), false);
});

test("redact removes the key and key-shaped strings", () => {
  const fake = "fake-test-key-123456";
  const s = redact(`failed ${fake} at https://x/y?key=${fake}&a=1 and AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0`, [fake]);
  assert.ok(!s.includes(fake));
  assert.ok(!s.includes("AIza"));
  assert.match(s, /\[REDACTED\]/);
});

test("CLI exits with a clear message when GEMINI_API_KEY or GEMINI_MODEL is unset", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GEMINI_/.test(k)));
  const r = spawnSync(process.execPath, ["src/agent.js", "test"], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GEMINI_API_KEY, GEMINI_MODEL/);
  const r2 = spawnSync(process.execPath, ["src/agent.js"], { env: { ...env, GEMINI_API_KEY: "x-not-real" }, encoding: "utf8" });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /GEMINI_MODEL/);
  assert.ok(!r2.stderr.includes("x-not-real"));
});
