/**
 * MEDISTRY Offline Scan Accountability
 * Makes every offline card scan by a signed-in clinician an audited break-glass event, even with no network.
 *
 * - Clinician pass: an ES256 token signed by the server at sign-in, valid 7 days, naming the clinician,
 *   facility, licence, country and the RFC 7638 thumbprint (dk) of the device key it is bound to.
 * - Device key: a non-extractable ECDSA P-256 key created in the scanner's WebCrypto; only its public JWK
 *   is sent here. Each scan event is signed by that key, so a copied pass alone cannot create events.
 * - Upload: events are verified (pass signature and expiry AT scan time, device signature, clinician still
 *   VERIFIED, time window), de-duplicated by eventId, written to the audit chain and notified to the patient.
 *
 * Honest limits: the server cannot prove that a card was physically scanned. An event is the clinician
 * device's signed statement that it scanned card (sub, version, kid). The card QR is signed, not encrypted;
 * see docs/THREAT_MODEL.md.
 */
import crypto from 'node:crypto';
import { verifyCompactJws, getPublicJwks, jwkThumbprint } from '../crypto/cardKeys.ts';
import { keyProvider } from '../crypto/keyProvider.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { PatientEntity } from '../patient/profile.ts';
import type { SeedClinician, SeedFacility } from '../../../prisma/seed.ts';
import type { OfflineCardStore } from './offlineCardStore.ts';
import { eventSigningInput, SCAN_REASONS, MAX_BATCH } from '../../../site/js/lib/offlineScan.js';
import { t, SUPPORTED_LOCALES, type SupportedLocale } from '../i18n/translations.ts';
import type { OfflineScanRepo, DeviceKeyEntity } from '../data/repositories.ts';

export const PASS_TYPE = 'clinician-pass';
export const PASS_VALIDITY_SECONDS = 7 * 24 * 3600;
export const MAX_SCAN_AGE_SECONDS = 30 * 24 * 3600;
export const MAX_SCAN_FUTURE_SECONDS = 5 * 60;
export { MAX_BATCH };

export type ScanReason = 'UNCONSCIOUS' | 'LIFE_THREATENING' | 'PATIENT_UNABLE_TO_CONSENT' | 'OTHER';
export type CardStatus = 'current' | 'superseded' | 'revoked';

export interface OfflineScanEventRecord {
  id: string;               // = eventId from the device
  patientId: string;
  cardVersion: number;
  cardKid: string;
  clinicianId: string;
  facilityId: string;
  clinicianCountry: string; // where the scanning clinician is licensed (from the signed pass)
  cardCountry: string;      // the card's country (the patient's record); scans may cross borders
  reason: ScanReason;
  details?: string;
  scannedAt: string;
  receivedAt: string;
  deviceKeyThumbprint: string;
  status: 'ACCEPTED' | 'DISPUTED';
  auditLogId: string;
  deviceSig: string;        // kept to tell a genuine re-upload (duplicate) from a reused eventId
}

export interface ScanEventResult {
  eventId: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  cardStatus?: CardStatus;
}

export interface OfflineScanDeps {
  auditManager: AuditChainManager;
  dispatcher: NotificationDispatcher;
  cardStore: OfflineCardStore;
  clinicians: SeedClinician[];   // live objects: a status change (e.g. SUSPENDED) applies immediately
  facilities: SeedFacility[];
  patientsById: Map<string, PatientEntity>;
}

interface DeviceKeyRecord { clinicianId: string; thumbprint: string; publicJwk: JsonWebKey; boundAt: string }


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

export class OfflineScanService {
  private events = new Map<string, OfflineScanEventRecord>();
  private deviceKeys = new Map<string, DeviceKeyRecord>(); // `${clinicianId}:${thumbprint}`

  private deps: OfflineScanDeps;
  /** Write-through repository (no-op in memory storage). */
  persistence?: OfflineScanRepo;

  constructor(deps: OfflineScanDeps) {
    this.deps = deps;
  }

  /** Rebuilds scan events and device keys from storage (start-up). */
  hydrate(events: OfflineScanEventRecord[], deviceKeys: DeviceKeyEntity[]): void {
    for (const e of events) this.events.set(e.id, e);
    for (const k of deviceKeys) this.deviceKeys.set(`${k.clinicianId}:${k.thumbprint}`, { ...k });
  }

  // ---------- Device keys and passes ----------

  /** Binds a device's public key to a clinician. Rejects anything that is not a public EC P-256 JWK. */
  bindDeviceKey(clinicianId: string, publicJwk: unknown): string {
    const j = publicJwk as Record<string, unknown> | null;
    if (!j || typeof j !== 'object' || j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') {
      throw new Error('Device key must be a public EC P-256 JWK');
    }
    if ('d' in j) throw new Error('Never send a private key: the device key must stay on the device');
    const clean = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y } as JsonWebKey;
    crypto.createPublicKey({ key: clean, format: 'jwk' }); // throws if the point is not on the curve
    const thumbprint = jwkThumbprint(clean);
    const key = `${clinicianId}:${thumbprint}`;
    if (!this.deviceKeys.has(key)) {
      const record = { clinicianId, thumbprint, publicJwk: clean, boundAt: new Date().toISOString() };
      this.deviceKeys.set(key, record);
      this.persistence?.saveDeviceKey(record);
      this.deps.auditManager.appendEntry({
        actorId: this.clinician(clinicianId)?.userId || clinicianId,
        action: 'CLINICIAN_DEVICE_KEY_BOUND',
        accessType: 'SYSTEM_ADMIN',
        resourceType: 'ClinicianDeviceKey',
        resourceId: thumbprint,
        facilityId: this.clinician(clinicianId)?.facilityId,
        ipAddress: '127.0.0.1',
        userAgent: 'EmergencyScanner/1.0',
        reason: `Scanner device key ${thumbprint.slice(0, 12)} bound for offline scans`,
      });
    }
    return thumbprint;
  }

  /** Issues a 7-day clinician pass bound to a device key. Only VERIFIED clinicians get one. */
  issuePass(clinicianId: string, deviceThumbprint: string, nowSeconds = Math.floor(Date.now() / 1000)): { pass: string; expiresAt: string } {
    const c = this.clinician(clinicianId);
    if (!c) throw new Error('Clinician not found');
    if (c.status !== 'VERIFIED') throw new Error('Only verified clinicians can receive an offline pass');
    if (!this.deviceKeys.has(`${clinicianId}:${deviceThumbprint}`)) throw new Error('Device key is not bound to this clinician');
    const exp = nowSeconds + PASS_VALIDITY_SECONDS;
    const pass = keyProvider().signPass({
      typ: PASS_TYPE,
      iss: 'medistry',
      sub: c.id,
      name: c.fullName,
      fac: c.facilityId,
      lic: c.licenseNumber,
      country: c.countryCode || this.deps.facilities.find((f) => f.id === c.facilityId)?.countryCode || 'NG',
      iat: nowSeconds,
      exp,
      dk: deviceThumbprint,
    });
    return { pass, expiresAt: new Date(exp * 1000).toISOString() };
  }

  // ---------- Upload ----------

  /** Verifies and records a batch. Each event gets its own result; one bad event never blocks the others. */
  processBatch(events: unknown, meta: { ipAddress: string; userAgent: string; nowMs?: number }): ScanEventResult[] {
    if (!Array.isArray(events) || events.length === 0) throw new Error('events must be a non-empty array');
    if (events.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} events per batch`);
    return events.map((e) => this.processOne(e, meta));
  }

  private processOne(raw: unknown, meta: { ipAddress: string; userAgent: string; nowMs?: number }): ScanEventResult {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
    const eventId = typeof e.eventId === 'string' ? e.eventId : '';
    const reject = (reason: string): ScanEventResult => ({ eventId, status: 'rejected', reason });

    // 1. Shape
    if (!UUID.test(eventId)) return reject('eventId must be a UUID');
    if (typeof e.cardSub !== 'string' || !e.cardSub) return reject('cardSub is required');
    if (!Number.isInteger(e.cardVersion) || e.cardVersion < 1) return reject('cardVersion must be a positive integer');
    if (typeof e.cardKid !== 'string' || !e.cardKid) return reject('cardKid is required');
    if (!SCAN_REASONS.includes(e.reason)) return reject(`reason must be one of ${SCAN_REASONS.join(', ')}`);
    if (e.details !== undefined && (typeof e.details !== 'string' || e.details.length > 500)) return reject('details must be text up to 500 characters');
    if (e.reason === 'OTHER' && (typeof e.details !== 'string' || e.details.trim().length < 5)) return reject('details (at least 5 characters) are required for OTHER');
    if (typeof e.pass !== 'string' || typeof e.deviceSig !== 'string' || !B64URL.test(e.deviceSig)) return reject('pass and deviceSig are required');
    const scannedMs = typeof e.scannedAt === 'string' ? Date.parse(e.scannedAt) : NaN;
    if (!Number.isFinite(scannedMs)) return reject('scannedAt must be an ISO date-time');

    // 2. Idempotency: the same signed event again is a duplicate; a reused id with other content is rejected
    const existing = this.events.get(eventId);
    if (existing) {
      if (existing.deviceSig === e.deviceSig) return { eventId, status: 'duplicate', cardStatus: this.cardStatus(existing.patientId, existing.cardVersion) };
      return reject('eventId was already used for a different event');
    }

    // 3. Time window (relative to upload time)
    const nowMs = meta.nowMs ?? Date.now();
    if (scannedMs < nowMs - MAX_SCAN_AGE_SECONDS * 1000) return reject('scannedAt is more than 30 days old');
    if (scannedMs > nowMs + MAX_SCAN_FUTURE_SECONDS * 1000) return reject('scannedAt is more than 5 minutes in the future');

    // 4. Pass: genuine, and valid AT SCAN TIME (a pass that expired after the scan is fine)
    const scannedSec = Math.floor(scannedMs / 1000);
    const pass = verifyCompactJws(e.pass, getPublicJwks(), scannedSec);
    if (!pass.valid || !pass.payload) return reject(`pass rejected: ${pass.error}`);
    const p = pass.payload;
    if (p.typ !== PASS_TYPE || p.iss !== 'medistry' || typeof p.sub !== 'string' || typeof p.dk !== 'string') return reject('pass rejected: not a clinician pass');

    // 5. Clinician must still be verified now
    const clinician = this.clinician(p.sub);
    if (!clinician) return reject('clinician not found');
    if (clinician.status !== 'VERIFIED') return reject(`clinician is ${clinician.status.toLowerCase()}, not verified`);

    // 6. Device signature by the key bound into the pass
    const device = this.deviceKeys.get(`${clinician.id}:${p.dk}`);
    if (!device) return reject('device key is not bound to this clinician');
    let sigOk = false;
    try {
      sigOk = crypto.verify('sha256', Buffer.from(eventSigningInput(e)), {
        key: crypto.createPublicKey({ key: device.publicJwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      }, Buffer.from(e.deviceSig, 'base64url'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return reject('device signature does not match');

    // 7. Card subject must be a known patient
    const patient = this.deps.patientsById.get(e.cardSub);
    if (!patient) return reject('card subject is not a known patient');

    // 8. Accept: audit, store, notify
    const facility = this.deps.facilities.find((f) => f.id === (p.fac || clinician.facilityId));
    const facilityName = facility?.name || p.fac || clinician.facilityId;
    const reasonSummary = e.reason === 'OTHER' ? `OTHER: ${e.details.trim()}` : e.reason;
    // Emergencies cross borders: a clinician licensed elsewhere may scan; both countries are recorded.
    const clinicianCountry = typeof p.country === 'string' && /^[A-Z]{2}$/.test(p.country) ? p.country : clinician.countryCode || 'NG';
    const cardCountry = patient.countryCode || 'NG';
    const crossBorder = clinicianCountry !== cardCountry ? ` (cross-border: clinician ${clinicianCountry}, card ${cardCountry})` : '';
    const scannedIso = new Date(scannedMs).toISOString();
    const audit = this.deps.auditManager.appendEntry({
      actorId: clinician.userId,
      subjectId: patient.id,
      action: 'OFFLINE_EMERGENCY_SCAN',
      accessType: 'EMERGENCY_BREAK_GLASS',
      resourceType: 'OfflineScanEvent',
      resourceId: eventId,
      facilityId: facility?.id || clinician.facilityId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      countryCode: cardCountry,
      reason: `Offline card v${e.cardVersion} scanned by ${clinician.fullName} at ${facilityName} on ${scannedIso}: ${reasonSummary}; device ${p.dk.slice(0, 12)}${crossBorder}`,
    });

    this.events.set(eventId, {
      id: eventId,
      patientId: patient.id,
      cardVersion: e.cardVersion,
      cardKid: e.cardKid,
      clinicianId: clinician.id,
      facilityId: facility?.id || clinician.facilityId,
      clinicianCountry,
      cardCountry,
      reason: e.reason,
      details: typeof e.details === 'string' && e.details.trim() ? e.details.trim() : undefined,
      scannedAt: scannedIso,
      receivedAt: new Date(nowMs).toISOString(),
      deviceKeyThumbprint: p.dk,
      status: 'ACCEPTED',
      auditLogId: audit.id,
      deviceSig: e.deviceSig,
    });
    this.persistence?.saveScanEvent(this.events.get(eventId)!);

    const locale: SupportedLocale = SUPPORTED_LOCALES.includes(patient.preferredLocale as SupportedLocale) ? patient.preferredLocale as SupportedLocale : 'en';
    const when = new Date(scannedMs).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    // Fire and forget: a notification outage must not lose the audit record that was already written.
    this.deps.dispatcher.notifyUser(patient.id, t('notify_scan_title', locale), t('notify_card_scanned', locale, {
      name: clinician.fullName, facility: facilityName, when, reason: t(`notify_reason_${e.reason}`, locale),
    })).catch(() => { /* delivery failures are visible in the provider logs */ });

    return { eventId, status: 'accepted', cardStatus: this.cardStatus(patient.id, e.cardVersion) };
  }

  /** current | superseded | revoked for a patient's card version, from the card registry. */
  cardStatus(patientId: string, version: number): CardStatus {
    const row = this.deps.cardStore.list(patientId).find((c) => c.version === version);
    if (row?.revokedAt) return 'revoked';
    if (row?.supersededById) return 'superseded';
    const latest = this.deps.patientsById.get(patientId)?.cardVersion || 0;
    return version < latest ? 'superseded' : 'current';
  }

  getEvent(eventId: string): OfflineScanEventRecord | undefined {
    const ev = this.events.get(eventId);
    return ev ? { ...ev } : undefined;
  }

  markDisputed(eventId: string): void {
    const ev = this.events.get(eventId);
    if (ev) {
      ev.status = 'DISPUTED';
      this.persistence?.saveScanEvent(ev);
    }
  }

  private clinician(id: string): SeedClinician | undefined {
    return this.deps.clinicians.find((c) => c.id === id);
  }
}
