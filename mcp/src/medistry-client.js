// Thin client for the Medistry API. Used only by the get_emergency_summary tool.
// Data residency guard: patient data is only requested from hosts listed in MEDISTRY_ALLOWED_HOSTS
// (default: localhost). Add your in-country host explicitly to use a remote Medistry.
import crypto from "node:crypto";

const BASE = (process.env.MEDISTRY_URL || "http://localhost:3000").replace(/\/$/, "");
const ALLOWED = (process.env.MEDISTRY_ALLOWED_HOSTS || "localhost,127.0.0.1")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function assertAllowedHost() {
  const host = new URL(BASE).hostname.toLowerCase();
  if (!ALLOWED.includes(host)) {
    throw new Error(`Refusing to request patient data from "${host}": not in MEDISTRY_ALLOWED_HOSTS (data-residency guard).`);
  }
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Medistry ${method} ${path} -> ${res.status}: ${data.error || "request failed"}`);
  return data;
}

let session = null;
async function signIn() {
  if (process.env.MEDISTRY_CLINICIAN_TOKEN) return process.env.MEDISTRY_CLINICIAN_TOKEN;
  if (session && session.exp > Date.now() + 10_000) return session.token;
  const demo = process.env.MEDISTRY_DEMO === "1";
  let id = process.env.MEDISTRY_CLINICIAN_ID;
  if (!id && demo) id = (await api("/api/clinicians")).clinicians?.[0]?.id;
  let totp = process.env.MEDISTRY_TOTP;
  if (!totp && demo && id) totp = (await api(`/api/demo/totp/${id}`)).code; // exists on demo servers only
  if (!id || !totp) {
    throw new Error("Medistry sign-in not configured. Set MEDISTRY_CLINICIAN_TOKEN, or MEDISTRY_CLINICIAN_ID + MEDISTRY_TOTP (or MEDISTRY_DEMO=1 on a demo server).");
  }
  const r = await api("/api/clinician/login", { method: "POST", body: { clinicianId: id, totp } });
  session = { token: r.token, exp: Date.now() + (r.expiresInSeconds || 900) * 1000 };
  return r.token;
}

// Starts an audited, patient-notified, 60-minute break-glass session, then returns a MINIMISED summary:
// no name, contacts or photo, and a salted pseudonymous reference instead of the emergency code.
export async function emergencySummary({ code, reason }) {
  assertAllowedHost();
  const token = await signIn();
  const grant = await api("/api/emergency/break-glass", { method: "POST", token, body: { code, reason } });
  const { summary } = await api(`/api/emergency/grants/${grant.grantId}/summary`, { token });
  const t = summary.triageEssentials, c = summary.chronicCare;
  const drugAllergies = summary.triageEssentials.drugAllergiesFirst.map((a) => ({ substance: a.substance, reaction: a.reaction, severity: a.severity }));
  const alerts = [];
  if (summary.legalDirectives.advanceDirectiveDnr) alerts.push("Advance directive (DNR) on file. Confirm with the treating clinician before resuscitation decisions.");
  for (const a of drugAllergies) alerts.push(`Drug allergy on record: ${a.substance} (${a.severity}; ${a.reaction}).`);
  if (["SS", "SC"].includes(t.genotype)) alerts.push(`Sickle cell genotype ${t.genotype} on record.`);
  return {
    patientRef: "PT-" + crypto.createHash("sha256").update(String(code).replace(/[^A-Za-z0-9]/g, "").toUpperCase()).digest("hex").slice(0, 8),
    age: summary.patient.age,
    gender: summary.patient.gender,
    bloodGroup: t.bloodGroup,
    genotype: t.genotype,
    drugAllergies,
    otherAllergies: t.allergies.filter((a) => a.category !== "drug").map((a) => ({ substance: a.substance, reaction: a.reaction, severity: a.severity })),
    chronicConditions: c.chronicConditions,
    activeMedications: c.activeMedications.map((m) => ({ name: m.medicationName, dose: m.dose, route: m.route })),
    advanceDirectiveDnr: summary.legalDirectives.advanceDirectiveDnr,
    alerts,
    grant: { id: grant.grantId, expiresAt: summary.grantMeta.expiresAt, readOnly: true },
    notes: [
      "Break-glass was recorded in the Medistry audit chain and the patient was notified.",
      "Encounter history is intentionally not returned (not reliable in this build).",
      "Decision support only. A clinician makes every clinical decision.",
    ],
  };
}
