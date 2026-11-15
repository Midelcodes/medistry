// Offline Medistry card verification for the verify_offline_card MCP tool.
// - Public keys come ONLY from MEDISTRY_URL/.well-known/medistry-keys.json, after the data-residency
//   host check (MEDISTRY_ALLOWED_HOSTS), and are cached in memory.
// - The ES256 signature is verified locally with node:crypto. No card data is sent anywhere.
// - The result is a MINIMISED triage view: never the emergency contact, never the patient id.
//   If the signature is not genuine, no medical data is returned at all.
// Note: verifying a card here does not create the Phase 5 audit event; that is recorded by the Medistry
// scanner app with a clinician pass. The QR data is signed, not encrypted (see docs/THREAT_MODEL.md).
import crypto from "node:crypto";
import { assertAllowedHost } from "./medistry-client.js";

const BASE = (process.env.MEDISTRY_URL || "http://localhost:3000").replace(/\/$/, "");
const JWKS_PATH = "/.well-known/medistry-keys.json";
const CACHE_MS = 60 * 60 * 1000;      // matches the server's Cache-Control (1 hour)
const REFETCH_MIN_MS = 60 * 1000;     // unknown kid: refetch at most once a minute
const MAX_IAT_SKEW = 5 * 60;
const B64URL = /^[A-Za-z0-9_-]+$/;

let cache = { keys: null, at: 0 };

/** Accepts a bare token or the card link (${APP_URL}/s#<token>). Returns "" if nothing token-shaped. */
export function extractCardToken(input) {
  let text = String(input || "").trim();
  const hash = text.indexOf("#");
  if (hash >= 0) text = text.slice(hash + 1);
  try { text = decodeURIComponent(text); } catch { /* keep */ }
  text = text.replace(/\s+/g, "");
  const parts = text.split(".");
  return parts.length === 3 && parts.every((p) => B64URL.test(p)) ? text : "";
}

async function fetchJwks() {
  assertAllowedHost(); // throws before any request if MEDISTRY_URL is not an allowed host
  const res = await fetch(BASE + JWKS_PATH, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not fetch Medistry public keys (${res.status})`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys.filter((k) => k && k.kty === "EC" && k.crv === "P-256" && typeof k.kid === "string" && !("d" in k)) : [];
  if (!keys.length) throw new Error("Medistry returned no usable public keys");
  cache = { keys, at: Date.now() };
  return keys;
}

async function keysFor(kid) {
  const fresh = cache.keys && Date.now() - cache.at < CACHE_MS;
  let keys = fresh ? cache.keys : await fetchJwks();
  if (!keys.some((k) => k.kid === kid) && Date.now() - cache.at > REFETCH_MIN_MS) keys = await fetchJwks();
  return keys;
}

/** Test hook: forget cached keys. */
export function clearKeyCache() { cache = { keys: null, at: 0 }; }

/**
 * Verifies a card token. Returns { status: valid|expired|invalid|unknown_key|future|unsupported, payload? }.
 * payload is present only for valid and expired (genuine signature).
 */
export async function verifyCardToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || parts.some((p) => !B64URL.test(p))) return { status: "invalid", error: "Not a card token" };
  const [h, p, s] = parts;
  let header;
  try { header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")); } catch { return { status: "invalid", error: "Unreadable header" }; }
  if (header.alg !== "ES256") return { status: "invalid", error: "Only ES256 is accepted" };
  if (typeof header.kid !== "string") return { status: "invalid", error: "No key id" };

  const jwk = (await keysFor(header.kid)).find((k) => k.kid === header.kid);
  if (!jwk) return { status: "unknown_key", error: "Signing key not published by this Medistry" };
  const sig = Buffer.from(s, "base64url");
  if (sig.length !== 64) return { status: "invalid", error: "Signature has the wrong length" };
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch { ok = false; }
  if (!ok) return { status: "invalid", error: "Signature does not match: the card was altered or not issued by Medistry" };

  let payload;
  try { payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return { status: "invalid", error: "Unreadable payload" }; }
  if (payload.iss !== "medistry") return { status: "invalid", error: "Not issued by Medistry" };
  if (payload.v !== 1 || !payload.e) return { status: "unsupported", error: "Card format not supported" };
  if (typeof payload.exp !== "number") return { status: "invalid", error: "Card has no expiry" };
  if (typeof payload.iat === "number" && payload.iat > nowSeconds + MAX_IAT_SKEW) return { status: "future", error: "Card issue time is in the future" };
  return { status: nowSeconds >= payload.exp ? "expired" : "valid", payload };
}

const day = (sec) => (typeof sec === "number" ? new Date(sec * 1000).toISOString().slice(0, 10) : null);

/**
 * The minimised triage view returned by the tool. Allowlist only: anything not named here (emergency
 * contact, patient id, organ donor, country) is never returned.
 */
export function minimisedView(result, token) {
  const genuine = result.status === "valid" || result.status === "expired";
  const base = {
    verified: genuine,
    expired: result.status === "expired",
    status: result.status,
  };
  if (!genuine) {
    return {
      ...base,
      refusal: result.status === "invalid"
        ? "CARD NOT GENUINE: the signature does not verify. Do not use any data from this card."
        : `Cannot verify this card (${result.status}). Do not rely on its data.`,
      reason: result.error,
    };
  }
  const e = result.payload.e || {};
  return {
    ...base,
    // Pseudonymous reference for queueing, derived from the signature: not the patient id, and
    // different for every card version.
    cardRef: "CARD-" + crypto.createHash("sha256").update(token.split(".")[2]).digest("hex").slice(0, 8),
    cardVersion: result.payload.cv,
    issuedOn: day(result.payload.iat),
    expiresOn: day(result.payload.exp),
    bloodGroup: e.bg ?? "unknown",
    genotype: e.gt ?? "unknown",
    allergies: (e.alg || []).map((a) => ({ substance: a.s, reaction: a.r, ...(a.pr ? { patientReported: true } : {}) })),
    dnr: e.dnr === true,
    conditions: Array.isArray(e.cond) ? [...e.cond] : [],
    medications: (e.med || []).map((m) => ({ name: m.n, dose: m.d })),
    recentDiagnosis: e.dx ? { text: e.dx.t, date: e.dx.d } : null,
    notes: [
      result.status === "expired"
        ? `Card expired on ${day(result.payload.exp)}: genuine when issued, may be out of date.`
        : "Signature verified against Medistry's published key.",
      "Offline cards cannot show whether a newer card exists. Emergency contact and patient id are deliberately not returned.",
      "Decision support only. A clinician makes every clinical decision.",
    ],
  };
}

export async function verifyOfflineCard(input) {
  const token = extractCardToken(input);
  if (!token) return { verified: false, expired: false, status: "invalid", refusal: "Input is not a Medistry card token or link." };
  return minimisedView(await verifyCardToken(token), token);
}
