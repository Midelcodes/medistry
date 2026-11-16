// Medistry calls have a time limit and one safe retry; failures are reported, never invented.
import { test } from "node:test";
import assert from "node:assert/strict";

test("An unreachable Medistry is retried once, then reported clearly", async () => {
  process.env.MEDISTRY_URL = "http://127.0.0.1:59999";
  process.env.MEDISTRY_ALLOWED_HOSTS = "127.0.0.1";
  process.env.MEDISTRY_CLINICIAN_TOKEN = "t";
  const { emergencySummary } = await import(`../src/medistry-client.js?fresh=${Date.now()}`);
  await assert.rejects(emergencySummary({ code: "K7QM-4T9X-2HDP-8W2", reason: "UNCONSCIOUS" }), /unreachable after 2 attempts/);
});
