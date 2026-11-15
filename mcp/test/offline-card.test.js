// verify_offline_card and the offline-card orchestrator flows (eval tasks T11, T12), against a real Medistry.
// Medistry gets a signing key generated here, so the test can also mint expired and wrong-alg tokens.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runScenario, connectServers } from "../src/orchestrator.js";

const PORT = 34000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
const KID = crypto.createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload, header = { alg: "ES256", typ: "JWT", kid: KID }, key = privateKey) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
const tasks = JSON.parse(readFileSync(new URL("../eval/tasks.json", import.meta.url))).filter((t) => t.kind === "offline_card_flow");

let medistry, client, card, patient;
const connect = async (env) => {
  const c = new Client({ name: "card-test", version: "0.2.0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.js"], env: { ...process.env, MEDISTRY_URL: BASE, ...env } }));
  return c;
};
const verify = async (c, token) => {
  const res = await c.callTool({ name: "verify_offline_card", arguments: { token } });
  return { isError: !!res.isError, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
};
const tamper = (t) => { const [h, p, s] = t.split("."); const i = Math.floor(p.length / 2); return `${h}.${p.slice(0, i)}${p[i] === "A" ? "B" : "A"}${p.slice(i + 1)}.${s}`; };

before(async () => {
  medistry = spawn("node", ["--experimental-strip-types", "../src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), OFFLINE_CARD_PRIVATE_KEY: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const { patients } = await (await fetch(`${BASE}/api/patients`)).json();
  patient = patients[0]; // synthetic: sickle cell SS, penicillin allergy; opted in one condition and one medicine
  card = await (await fetch(`${BASE}/api/patients/${patient.id}/offline-card`)).json();
  client = await connect();
});
after(async () => { await client?.close(); medistry?.kill(); });

test("valid card: verified, minimised triage view; the card link works too", async () => {
  const { data } = await verify(client, card.token);
  assert.equal(data.verified, true);
  assert.equal(data.expired, false);
  assert.equal(data.cardVersion, 1);
  assert.equal(data.bloodGroup, "O+");
  assert.equal(data.genotype, "SS");
  assert.ok(data.allergies.some((a) => a.substance === "Penicillin"));
  assert.equal(data.dnr, false);
  assert.deepEqual(data.conditions, ["Sickle Cell Anemia (HbSS)"]);
  assert.deepEqual(data.medications.map((m) => m.name), ["Hydroxyurea"]);
  assert.match(data.cardRef, /^CARD-[0-9a-f]{8}$/);

  const viaLink = await verify(client, `${BASE}/s#${card.token}`);
  assert.deepEqual(viaLink.data, data);
});

test("output never contains the emergency contact, the patient id or the emergency code", async () => {
  const { text, data } = await verify(client, card.token);
  const { patient: full } = await (await fetch(`${BASE}/api/patients/${patient.id}`)).json();
  const contact = full.emergencyContacts.sort((a, b) => a.priority - b.priority)[0];
  for (const banned of [patient.id, contact.name, contact.phone, full.emergencyCode, full.firstName, full.lastName, '"ec"', '"sub"', '"phone"', '"contact']) {
    assert.ok(!text.includes(banned), `output must not contain ${banned}`);
  }
  assert.deepEqual(Object.keys(data).sort(), ["allergies", "bloodGroup", "cardRef", "cardVersion", "conditions", "dnr", "expired", "expiresOn", "genotype", "issuedOn", "medications", "notes", "recentDiagnosis", "status", "verified"]);
});

test("tampered card: not verified, refusal, and no medical data at all", async () => {
  const { data } = await verify(client, tamper(card.token));
  assert.equal(data.verified, false);
  assert.equal(data.status, "invalid");
  assert.match(data.refusal, /CARD NOT GENUINE/);
  for (const k of ["bloodGroup", "genotype", "allergies", "conditions", "medications", "dnr", "recentDiagnosis", "cardRef"]) assert.ok(!(k in data), k);
  assert.equal((await verify(client, "not a card at all, just text")).data.verified, false);
});

test("expired, unknown-key and wrong-alg cards", async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "medistry", sub: "synthetic", cv: 3, v: 1, iat: now - 400 * 86400, exp: now - 86400, c: "NG", e: { bg: "A-", gt: "AA", ec: { n: "Synthetic Contact", p: "+234 800 000 0000" } } };
  const expired = (await verify(client, sign(claims))).data;
  assert.deepEqual([expired.verified, expired.expired, expired.bloodGroup], [true, true, "A-"]);
  assert.match(expired.notes[0], /expired/);
  assert.ok(!JSON.stringify(expired).includes("Synthetic Contact"));

  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const unknown = (await verify(client, sign({ ...claims, exp: now + 86400 }, { alg: "ES256", typ: "JWT", kid: "not-a-published-kid" }, other))).data;
  assert.deepEqual([unknown.verified, unknown.status], [false, "unknown_key"]);

  const [, p, s] = card.token.split(".");
  const hs = (await verify(client, `${b64({ alg: "HS256", typ: "JWT", kid: KID })}.${p}.${s}`)).data;
  assert.deepEqual([hs.verified, hs.status], [false, "invalid"]);
});

test("disallowed host: refuses before any request (data-residency guard)", async () => {
  const outside = await connect({ MEDISTRY_URL: "http://medistry.example.org:9", MEDISTRY_ALLOWED_HOSTS: "localhost,127.0.0.1" });
  try {
    const r = await verify(outside, card.token);
    assert.equal(r.isError, true);
    assert.match(r.text, /Refusing to request patient data from "medistry\.example\.org".*MEDISTRY_ALLOWED_HOSTS/);
  } finally {
    await outside.close();
  }
});

for (const t of tasks) {
  test(`${t.id}: ${t.desc}`, async () => {
    const out = mkdtempSync(join(tmpdir(), "mcp-card-"));
    const { triageMcp, fsMcp } = await connectServers(out, { MEDISTRY_URL: BASE });
    try {
      const input = t.card === "tampered" ? tamper(card.token) : `${BASE}/s#${card.token}`;
      const final = await runScenario({ input, triageMcp, fsMcp, outDir: out });
      for (const s of t.expectHandover) assert.ok(final.report.includes(s), `handover should include: ${s}\n---\n${final.report}`);
      for (const s of t.expectHandoverNot) assert.ok(!final.report.includes(s), `handover must not include: ${s}`);
      assert.equal(readFileSync(join(out, "handover.md"), "utf8"), final.report, "written by the external filesystem MCP server");
      assert.ok(final.referral.length > 0);
      assert.ok(final.referral.every((r) => r.why.includes(`has ${t.expectCapability}`)), `referral routed for ${t.expectCapability}`);
    } finally {
      await triageMcp.close(); await fsMcp.close();
      rmSync(out, { recursive: true, force: true });
    }
  });
}
