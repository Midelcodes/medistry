/**
 * MEDISTRY Offline Card Payload (schema v1)
 * Builds the compact, ES256-signed payload carried inside the offline emergency card QR.
 *
 * PRIVACY RULE: only the core triage fields are always on the card. Conditions, medications and the
 * most recent diagnosis can reveal sensitive diagnoses (for example antiretrovirals reveal HIV status),
 * so each one appears only if the patient opted it in (PatientEntity.card* fields).
 *
 * Compact key mapping (short keys keep the QR small):
 *   iss  issuer, always "medistry"           sub  patient id
 *   cv   card version (int, per patient)      v    payload schema version (1)
 *   iat  issued at (unix s)                   exp  expiry (unix s)
 *   c    country code (ISO 3166-1 alpha-2)
 *   e    emergency data:
 *        bg   blood group ("A+", "O-", ... or "unknown")      [core, always]
 *        gt   genotype ("AA", "SS", ... or "unknown")         [core, always]
 *        alg  severe allergies [{ s: substance, r: reaction }] [core, omitted when none]
 *        dnr  true when a DNR directive is on file           [core, omitted when false]
 *        od   true when an organ donor                       [core, omitted when false]
 *        ec   primary emergency contact { n: name, p: phone } [core, omitted when none]
 *        cond chosen chronic conditions [string]             [opt-in]
 *        med  chosen medications [{ n: name, d: dose }]      [opt-in]
 *        dx   most recent diagnosis { t: text, d: YYYY-MM-DD } [opt-in]
 * Empty arrays and false flags are omitted.
 */
import type { PatientEntity, BloodGroup } from '../patient/profile.ts';
import { signCompactJws } from '../crypto/cardKeys.ts';
import { OFFLINE_CARD_ISSUER } from '../code/deliverables.ts';

export const CARD_SCHEMA_VERSION = 1;
export const MAX_CARD_TOKEN_LENGTH = 1800;
export const DEFAULT_CARD_VALIDITY_DAYS = 180;

export interface CardDiagnosis { t: string; d: string }

export interface CompactCardPayload {
  iss: string;
  sub: string;
  cv: number;
  v: number;
  iat: number;
  exp: number;
  c: string;
  e: {
    bg: string;
    gt: string;
    alg?: Array<{ s: string; r: string }>;
    dnr?: true;
    od?: true;
    ec?: { n: string; p: string };
    cond?: string[];
    med?: Array<{ n: string; d: string }>;
    dx?: CardDiagnosis;
  };
}

export interface CardSelection {
  cardConditions?: unknown;
  cardMedicationIds?: unknown;
  cardIncludeRecentDiagnosis?: unknown;
}

const BLOOD_GROUP_SHORT: Record<BloodGroup, string> = {
  A_POSITIVE: 'A+', A_NEGATIVE: 'A-', B_POSITIVE: 'B+', B_NEGATIVE: 'B-',
  AB_POSITIVE: 'AB+', AB_NEGATIVE: 'AB-', O_POSITIVE: 'O+', O_NEGATIVE: 'O-', UNKNOWN: 'unknown',
};

/** Validity for newly issued cards: OFFLINE_CARD_VALIDITY_DAYS, default 180. */
export function cardValidityDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.OFFLINE_CARD_VALIDITY_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CARD_VALIDITY_DAYS;
}

/**
 * Validates a patient's card visibility choices. Every chosen condition and medication must already
 * exist on the patient: patients choose what is SHOWN, they never create or edit clinical content.
 * Returns only the fields that were provided; throws with a readable message otherwise.
 */
export function validateCardSelection(patient: PatientEntity, sel: CardSelection): {
  cardConditions?: string[];
  cardMedicationIds?: string[];
  cardIncludeRecentDiagnosis?: boolean;
} {
  const out: { cardConditions?: string[]; cardMedicationIds?: string[]; cardIncludeRecentDiagnosis?: boolean } = {};
  const stringList = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${field} must be a list of strings`);
    return [...new Set(v as string[])];
  };
  if (sel.cardConditions !== undefined) {
    const chosen = stringList(sel.cardConditions, 'cardConditions');
    const unknown = chosen.filter((c) => !patient.chronicConditions.includes(c));
    if (unknown.length) throw new Error(`cardConditions contains ${unknown.length} item(s) that are not on your record`);
    out.cardConditions = chosen;
  }
  if (sel.cardMedicationIds !== undefined) {
    const chosen = stringList(sel.cardMedicationIds, 'cardMedicationIds');
    const known = new Set(patient.activeMedications.map((m) => m.id));
    const unknown = chosen.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`cardMedicationIds contains ${unknown.length} id(s) that are not on your record`);
    out.cardMedicationIds = chosen;
  }
  if (sel.cardIncludeRecentDiagnosis !== undefined) {
    if (typeof sel.cardIncludeRecentDiagnosis !== 'boolean') throw new Error('cardIncludeRecentDiagnosis must be true or false');
    out.cardIncludeRecentDiagnosis = sel.cardIncludeRecentDiagnosis;
  }
  return out;
}

/**
 * Builds the compact payload. Opt-in items come only from the patient's current selection, in the
 * order they appear on the record; selections that no longer exist on the record are skipped.
 */
export function buildCardPayload(
  patient: PatientEntity,
  opts: { cardVersion: number; recentDiagnosis?: CardDiagnosis | null; validityDays?: number; nowSeconds?: number }
): CompactCardPayload {
  const iat = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (opts.validityDays ?? cardValidityDays()) * 86400;

  const e: CompactCardPayload['e'] = {
    bg: BLOOD_GROUP_SHORT[patient.bloodGroup] ?? 'unknown',
    gt: patient.genotype && patient.genotype !== 'UNKNOWN' ? patient.genotype : 'unknown',
  };
  const alg = patient.allergies.filter((a) => a.severity === 'severe').map((a) => ({ s: a.substance, r: a.reaction }));
  if (alg.length) e.alg = alg;
  if (patient.advanceDirectiveDnr) e.dnr = true;
  if (patient.organDonor) e.od = true;
  const primary = [...patient.emergencyContacts].sort((a, b) => a.priority - b.priority)[0];
  if (primary) e.ec = { n: primary.name, p: primary.phone };

  const cond = patient.chronicConditions.filter((c) => patient.cardConditions.includes(c));
  if (cond.length) e.cond = cond;
  const med = patient.activeMedications
    .filter((m) => patient.cardMedicationIds.includes(m.id))
    .map((m) => ({ n: m.medicationName, d: m.dose }));
  if (med.length) e.med = med;
  if (patient.cardIncludeRecentDiagnosis && opts.recentDiagnosis?.t) e.dx = { t: opts.recentDiagnosis.t, d: opts.recentDiagnosis.d };

  return {
    iss: OFFLINE_CARD_ISSUER,
    sub: patient.id,
    cv: opts.cardVersion,
    v: CARD_SCHEMA_VERSION,
    iat,
    exp,
    c: patient.countryCode || 'NG',
    e,
  };
}

/**
 * Signs the payload, then enforces the size guard: while the token is longer than maxLength, drop
 * opt-in items in this order: dx, then med (from the end), then cond (from the end). Core fields are
 * never dropped; if the core alone is too long the token is returned with a warning.
 */
export function signCardWithSizeGuard(
  payload: CompactCardPayload,
  opts: { maxLength?: number; sign?: (p: object) => string } = {}
): { token: string; payload: CompactCardPayload; warnings: string[] } {
  const maxLength = opts.maxLength ?? MAX_CARD_TOKEN_LENGTH;
  const sign = opts.sign ?? signCompactJws;
  const p: CompactCardPayload = structuredClone(payload);
  const warnings: string[] = [];
  let token = sign(p);

  while (token.length > maxLength) {
    if (p.e.dx) {
      warnings.push(`Dropped recent diagnosis "${p.e.dx.t}" to fit the card`);
      delete p.e.dx;
    } else if (p.e.med?.length) {
      const dropped = p.e.med.pop()!;
      warnings.push(`Dropped medication "${dropped.n}" to fit the card`);
      if (!p.e.med.length) delete p.e.med;
    } else if (p.e.cond?.length) {
      const dropped = p.e.cond.pop()!;
      warnings.push(`Dropped condition "${dropped}" to fit the card`);
      if (!p.e.cond.length) delete p.e.cond;
    } else {
      warnings.push(`Core emergency data alone is ${token.length} characters, above the ${maxLength}-character target; the QR may be hard to scan`);
      break;
    }
    token = sign(p);
  }
  return { token, payload: p, warnings };
}
