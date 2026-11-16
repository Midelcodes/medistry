// Phase 19: the "Triage scoring not clinically validated" banner shows at start-up and on every scoring result
// until CLINICAL_VALIDATION_SIGNED=1. Drives the real MCP server over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VALIDATION_BANNER } from "../src/validation.js";

const VITALS = { age: 40, mobility: "walking", respiratoryRate: 16, heartRate: 80, systolicBP: 120, temperatureC: 37, avpu: "alert", trauma: false };

async function startServer(signed) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLINICAL_VALIDATION_SIGNED"));
  if (signed !== undefined) env.CLINICAL_VALIDATION_SIGNED = signed;
  const transport = new StdioClientTransport({ command: "node", args: ["src/server.js"], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr.on("data", (d) => { stderr += d; });
  const client = new Client({ name: "validation-test", version: "0.2.0" });
  await client.connect(transport);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { client, call, stderr: () => stderr };
}

for (const [label, signed, shown] of [["unset", undefined, true], ["0", "0", true], ["yes (not exactly 1)", "yes", true], ["1", "1", false]]) {
  test(`CLINICAL_VALIDATION_SIGNED=${label}: banner ${shown ? "shown" : "hidden"}`, async () => {
    const s = await startServer(signed);
    try {
      const t = await s.call("score_triage_priority", VITALS);
      const d = await s.call("flag_deterioration", { observations: [VITALS, { ...VITALS, heartRate: 135 }] });
      assert.equal(t.category, "GREEN", "scoring itself is unchanged");
      assert.equal(t.validationBanner, shown ? VALIDATION_BANNER : undefined);
      assert.equal(d.validationBanner, shown ? VALIDATION_BANNER : undefined);
      assert.equal(s.stderr().includes(VALIDATION_BANNER), shown, "start-up log");
    } finally {
      await s.client.close();
    }
  });
}

test("A fractional respiratory rate is refused by the tool (it would otherwise fall outside every band)", async () => {
  const s = await startServer(undefined);
  try {
    const r = await s.client.callTool({ name: "score_triage_priority", arguments: { ...VITALS, respiratoryRate: 8.5 } });
    assert.equal(r.isError, true);
  } finally {
    await s.client.close();
  }
});
