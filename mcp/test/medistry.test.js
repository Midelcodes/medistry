// Integration: boots a real Medistry server (demo mode) and exercises get_emergency_summary over MCP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 32000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
let medistry, client, code;

const mcp = (env = {}) => new Client({ name: "it", version: "0.2.0" }).connect(
  new StdioClientTransport({ command: "node", args: ["src/server.js"], env: { ...process.env, MEDISTRY_URL: BASE, MEDISTRY_DEMO: "1", ...env } })
);
const connectClient = async (env) => { const c = new Client({ name: "it", version: "0.2.0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.js"], env: { ...process.env, MEDISTRY_URL: BASE, MEDISTRY_DEMO: "1", ...env } })); return c; };

before(async () => {
  medistry = spawn("node", ["--experimental-strip-types", "../src/server.ts"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const loc = (await fetch(`${BASE}/demo`, { redirect: "manual" })).headers.get("location");
  code = decodeURIComponent(loc.slice(3));
  client = await connectClient();
});
after(async () => { await client?.close(); medistry?.kill(); });

const call = (c, args) => c.callTool({ name: "get_emergency_summary", arguments: args });

test("returns critical info and alerts for the synthetic sickle-cell patient", async () => {
  const res = await call(client, { code, reason: "UNCONSCIOUS", confirmBreakGlass: true });
  assert.ok(!res.isError, res.content[0].text);
  const d = JSON.parse(res.content[0].text);
  assert.equal(d.genotype, "SS");
  assert.ok(d.bloodGroup);
  assert.ok(d.drugAllergies.some((a) => /penicillin/i.test(a.substance)), "penicillin allergy present");
  assert.ok(d.alerts.some((a) => /Sickle cell/.test(a)));
  assert.match(d.patientRef, /^PT-[0-9a-f]{8}$/);
  assert.equal(d.grant.readOnly, true);
});

test("data minimisation: no name, contacts, photo, DOB or the emergency code in the output", async () => {
  const res = await call(client, { code, reason: "LIFE_THREATENING", confirmBreakGlass: true });
  const text = res.content[0].text;
  for (const banned of ["Okonkwo", "Amara", "emergencyContacts", "photoUrl", "dateOfBirth", code, code.replace(/-/g, "")]) {
    assert.ok(!text.includes(banned), `output must not contain ${banned}`);
  }
});

test("break-glass is audited: the Medistry audit chain grows and stays valid", async () => {
  const before = (await (await fetch(`${BASE}/api/stats`)).json()).auditEntries;
  await call(client, { code, reason: "UNCONSCIOUS", confirmBreakGlass: true });
  const after = await (await fetch(`${BASE}/api/stats`)).json();
  assert.ok(after.auditEntries > before);
  assert.equal(after.auditChainValid, true);
});

test("unknown emergency code is an error, not data", async () => {
  const res = await call(client, { code: "ZZZZ-ZZZZ-ZZZZ-ZZZ", reason: "UNCONSCIOUS", confirmBreakGlass: true });
  assert.equal(res.isError, true);
});

test("residency guard: refuses to request patient data from a non-allowlisted host", async () => {
  const c = await connectClient({ MEDISTRY_URL: "http://example.com:3000" });
  try {
    const res = await call(c, { code, reason: "UNCONSCIOUS", confirmBreakGlass: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /data-residency/);
  } finally { await c.close(); }
});

test("sign-in failure is reported, not hidden", async () => {
  const c = await connectClient({ MEDISTRY_DEMO: "0", MEDISTRY_CLINICIAN_ID: "", MEDISTRY_TOTP: "" });
  try {
    const res = await call(c, { code, reason: "UNCONSCIOUS", confirmBreakGlass: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /sign-in not configured/i);
  } finally { await c.close(); }
});
