// The minimiser in front of the LLM: names, contacts, ids and free-text notes never reach the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMinimiser } from "../src/minimise.js";
import { runAgent, SYSTEM_PROMPT } from "../src/agent.js";

const TOKEN = `eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.${"eyJpc3MiOiJtZWRpc3RyeSJ9".repeat(4)}.${"S".repeat(86)}`;

test("free text: tokens, codes and refs become placeholders; contacts and titled names are removed; clinical values stay", () => {
  const m = createMinimiser();
  const input = `Unconscious synthetic patient PT-DEMO-07. Card: https://demo.example/s#${TOKEN}. Code K7QM-4T9X-2HDP-8W2. `
    + `Brought in by Mrs. Ada Synthetic (+234 803 444 5566, 0803 444 5566, ada@example.ng). Seen 2026-10-01. HR 130, SBP 90, SpO2 88%. `
    + `Record id 3f2a1c9e-1111-4222-8333-944455556666.`;
  const out = m.text(input);
  assert.ok(out.includes("[REF_1]") && out.includes("[CARD_1]") && out.includes("[CODE_1]") && out.includes("[ID_1]"));
  for (const gone of ["PT-DEMO-07", TOKEN, "K7QM-4T9X-2HDP-8W2", "Ada Synthetic", "+234", "0803 444", "ada@example.ng", "3f2a1c9e"]) {
    assert.ok(!out.includes(gone), `should not contain ${gone}`);
  }
  for (const kept of ["2026-10-01", "HR 130", "SBP 90", "SpO2 88%", "Unconscious"]) assert.ok(out.includes(kept), `should keep ${kept}`);
  // [CARD_1] stands for the whole card link (verify_offline_card accepts the link or the bare token)
  assert.equal(m.restore(`verify [CARD_1] for [REF_1]`), `verify https://demo.example/s#${TOKEN} for PT-DEMO-07`);
});

test("structured results: person fields dropped, ids pseudonymised, facility names kept", () => {
  const m = createMinimiser();
  const out = m.value({
    patientRef: "PT-1a2b3c4d", age: 27, bloodGroup: "O+",
    emergencyContacts: [{ name: "Synthetic Contact", phone: "+234 800 000 0000" }],
    ec: { n: "x", p: "y" }, fullName: "Synthetic Person", notes: ["free text that may hold anything"], details: "found by Mr. Synthetic",
    grant: { id: "3f2a1c9e-1111-4222-8333-944455556666", readOnly: true },
    recommendations: [{ facilityId: "NG-LAG-001", name: "Demo General Hospital Ikeja", distanceKm: 12 }],
    token: TOKEN, pass: "a.b.c",
  });
  assert.deepEqual(Object.keys(out).sort(), ["age", "bloodGroup", "grant", "patientRef", "recommendations"]);
  assert.match(out.patientRef, /^\[REF_\d+\]$/);
  assert.match(out.grant.id, /^\[ID_\d+\]$/);
  assert.equal(out.recommendations[0].name, "Demo General Hospital Ikeja");
  assert.equal(m.restore({ patientId: out.patientRef }).patientId, "PT-1a2b3c4d");
});

test("agent: the model sees only placeholders and minimised results; tools get the real values", async () => {
  const calls = [];
  const mcp = {
    listTools: async () => ({ tools: [{ name: "verify_offline_card", description: "verify", inputSchema: { type: "object", properties: { token: { type: "string" } } } }] }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify({ verified: true, cardRef: "CARD-1a2b3c4d", bloodGroup: "O+", notes: ["Signature verified"], emergencyContacts: [{ name: "Synthetic Contact", phone: "+234 800 000 0000" }] }) }] };
    },
  };
  const seen = [];
  const llm = {
    generate: async ({ messages }) => {
      seen.push(JSON.stringify(messages));
      return seen.length === 1
        ? { toolCalls: [{ id: "c1", name: "verify_offline_card", args: { token: "[CARD_1]" } }] }
        : { text: "Verified card [REF_1]. Decision support only." };
    },
  };
  const task = `Unconscious patient brought in by Dr. Synthetic Okafor, phone +234 803 444 5566. Card link: https://demo.example/s#${TOKEN}`;
  const out = await runAgent({ llm, mcp, task });

  assert.equal(calls[0].args.token, `https://demo.example/s#${TOKEN}`, "the tool receives the real card link");
  const sent = seen.join("\n");
  for (const banned of [TOKEN, "Okafor", "+234", "Synthetic Contact", "CARD-1a2b3c4d", "Signature verified"]) {
    assert.ok(!sent.includes(banned), `model must not see ${banned}`);
  }
  assert.ok(sent.includes("[CARD_1]") && sent.includes("[REF_1]"));
  assert.equal(out.stoppedReason, "final");
});

test("system prompt and code state the refusal rule and the lawful-basis warning", () => {
  assert.match(SYSTEM_PROMPT, /If verify_offline_card returns verified: false, do not use any data from that card/);
  const src = readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(src, /must not be sent to a foreign-hosted LLM[\s\S]*without a lawful basis/);
  assert.match(src, /Production should use an in-country or self-hosted model/);
});
