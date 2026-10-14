// End-to-end evaluation of the MCP server over stdio against eval/tasks.json.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tasks = JSON.parse(readFileSync(new URL("../eval/tasks.json", import.meta.url)));
let client;
before(async () => {
  client = new Client({ name: "eval", version: "0.2.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["src/server.js"] }));
});
after(() => client.close());

test("server exposes >= 3 distinct tools including the three required kinds", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(tools.length >= 3);
  for (const n of ["score_triage_priority", "flag_deterioration", "route_referral", "get_emergency_summary"]) assert.ok(names.includes(n), n);
});

for (const t of tasks) {
  test(`${t.id}: ${t.desc}`, async () => {
    let res;
    try { res = await client.callTool({ name: t.tool, arguments: t.args }); }
    catch (e) { if (t.expectError) return; throw e; } // schema errors may surface as protocol errors
    if (t.expectError) return assert.equal(res.isError, true);
    assert.ok(!res.isError, res.content?.[0]?.text);
    const data = JSON.parse(res.content[0].text);
    if (t.expect) for (const [k, v] of Object.entries(t.expect)) assert.equal(data[k], v);
    if (t.expectFirst) for (const [k, v] of Object.entries(t.expectFirst)) assert.equal(data.recommendations[0][k], v);
    if (t.expectNotIn) assert.ok(!data.recommendations.some((r) => r.facilityId === t.expectNotIn));
  });
}
