/**
 * MEDISTRY Portal API
 * JSON endpoints behind the patient portal, clinician console, emergency gate
 * and contact form. All data is synthetic and held in memory.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import type { SeedDatabasePayload, SeedClinician } from '../../../prisma/seed.ts';
import { decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { ClinicalDataStore } from '../clinical/store.ts';
import type { ClinicalTimelineEngine, TimelineFilterOptions } from '../clinical/timeline.ts';
import type { ConsentLifecycleManager, ConsentDurationPreset } from '../consent/consentManager.ts';
import type { PatientAccessLogManager } from '../audit/accessLogManager.ts';
import type { EmergencyBreakGlassEngine } from '../emergency/breakGlassEngine.ts';
import type { ConsoleNotificationProvider } from '../notifications/dispatcher.ts';
import { generatePatientUniqueCode, normalizePatientCode } from '../code/crockford.ts';
import { generateSessionToken, generateTotp, generateTotpSecret, verifyTotp } from '../auth/security.ts';
import { getSecurityHttpHeaders, sanitizeClinicalText } from '../security/rateLimiter.ts';
import type { ActorContext } from '../policy/enforcer.ts';

export interface PortalContext {
  seedData: SeedDatabasePayload;
  patientsById: Map<string, PatientEntity>;
  patientsByCode: Map<string, PatientEntity>;
  codeByPatient: Map<string, { rawCode: string; formattedCode: string }>;
  auditManager: AuditChainManager;
  clinicalStore: ClinicalDataStore;
  timelineEngine: ClinicalTimelineEngine;
  consentManager: ConsentLifecycleManager;
  accessLogManager: PatientAccessLogManager;
  emergencyEngine: EmergencyBreakGlassEngine;
  notifications: ConsoleNotificationProvider;
  dataDir: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_EMERGENCY_ATTEMPTS || '5', 10);
const LOCKOUT_MS = parseInt(process.env.EMERGENCY_LOCKOUT_SECONDS || '3600', 10) * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export function createPortalApi(ctx: PortalContext) {
  // ---- Clinician authentication state (in memory) ----
  const totpSecrets = new Map<string, string>();
  for (const c of ctx.seedData.clinicians) totpSecrets.set(c.id, generateTotpSecret());
  const sessions = new Map<string, { clinicianId: string; expiresAt: number }>();
  const loginFailures = new Map<string, { count: number; lockedUntil: number }>();
  const contactMessages: Array<Record<string, string>> = [];

  // ---- Helpers ----
  function sendJson(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...getSecurityHttpHeaders() });
    res.end(JSON.stringify(data));
  }

  function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          reject(new HttpError(413, 'Payload too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const text = (v: unknown, max: number) => sanitizeClinicalText(typeof v === 'string' ? v : '').slice(0, max);

  function getPatient(id: string): PatientEntity {
    const patient = ctx.patientsById.get(id);
    if (!patient) throw new HttpError(404, 'Patient not found');
    return patient;
  }

  const patientActor = (p: PatientEntity): ActorContext => ({ userId: p.id, role: 'PATIENT' });

  function facilityName(id: string): string {
    return ctx.seedData.facilities.find((f) => f.id === id)?.name || id;
  }

  function currentClinician(req: http.IncomingMessage): SeedClinician {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt < Date.now()) {
      if (token) sessions.delete(token);
      throw new HttpError(401, 'Clinician sign-in required');
    }
    const clinician = ctx.seedData.clinicians.find((c) => c.id === session.clinicianId);
    if (!clinician) throw new HttpError(401, 'Clinician sign-in required');
    return clinician;
  }

  const clinicianActor = (c: SeedClinician): ActorContext => ({
    userId: c.userId,
    role: 'DOCTOR',
    clinicianId: c.id,
    facilityId: c.facilityId,
    isVerifiedClinician: true,
  });

  function publicClinician(c: SeedClinician) {
    return {
      id: c.id,
      fullName: c.fullName,
      licenseNumber: c.licenseNumber,
      specialty: c.specialty,
      facilityId: c.facilityId,
      facilityName: facilityName(c.facilityId),
    };
  }

  function ageOf(dob: string): number {
    return Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  }

  function profileOf(p: PatientEntity) {
    const demo = decryptPatientDemographics(p);
    const code = ctx.codeByPatient.get(p.id);
    return {
      id: p.id,
      firstName: demo.firstName,
      lastName: demo.lastName,
      dateOfBirth: demo.dateOfBirth,
      age: ageOf(demo.dateOfBirth),
      gender: demo.gender,
      bloodGroup: p.bloodGroup.replace('_', ' '),
      genotype: p.genotype,
      dnr: p.advanceDirectiveDnr,
      organDonor: p.organDonor,
      publicEmergencyOptIn: p.publicEmergencyOptIn,
      primaryFacilityName: p.primaryFacilityId ? facilityName(p.primaryFacilityId) : null,
      emergencyContacts: p.emergencyContacts,
      allergies: p.allergies,
      chronicConditions: p.chronicConditions,
      activeMedications: p.activeMedications,
      emergencyCode: code?.formattedCode || null,
    };
  }

  function parseFilters(url: URL): TimelineFilterOptions {
    const filters: TimelineFilterOptions = {};
    const type = url.searchParams.get('resourceType');
    const facility = url.searchParams.get('facilityId');
    if (type) filters.resourceType = type;
    if (facility) filters.facilityId = facility;
    return filters;
  }

  function lookupByCode(input: string): PatientEntity | undefined {
    return ctx.patientsByCode.get(normalizePatientCode(input));
  }

  function slimTimeline(items: ReturnType<ClinicalTimelineEngine['getTimeline']>) {
    return items.map((i) => ({
      id: i.id,
      resourceType: i.resourceType,
      category: i.category,
      title: i.title,
      summary: i.summary,
      effectiveDate: i.effectiveDate,
      facilityId: i.provenance.originFacilityId,
      facilityName: i.provenance.facilityName,
      authorName: i.provenance.authorName,
      badge: i.provenance.badgeStatement,
    }));
  }

  // ---- Router ----
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return false;

    try {
      const result = await route(req, method, pathname, url);
      if (result === undefined) return false;
      sendJson(res, 200, result);
      return true;
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : /Forbidden|Unauthorized/.test(err?.message || '') ? 403 : 400;
      sendJson(res, status, { error: err?.message || 'Request failed' });
      return true;
    }
  }

  async function route(req: http.IncomingMessage, method: string, pathname: string, url: URL): Promise<unknown | undefined> {
    let m: RegExpMatchArray | null;

    // ---------- Public ----------
    if (method === 'GET' && pathname === '/api/stats') {
      const chain = ctx.auditManager.verifyChain();
      return {
        patients: ctx.seedData.patients.length,
        facilities: ctx.seedData.facilities.length,
        clinicians: ctx.seedData.clinicians.length,
        auditEntries: ctx.auditManager.getEntries().length,
        auditChainValid: chain.valid,
      };
    }

    if (method === 'GET' && pathname === '/api/audit/verify') {
      const chain = ctx.auditManager.verifyChain();
      const latest = ctx.auditManager.getLatestEntry();
      return {
        valid: chain.valid,
        error: chain.error,
        entries: ctx.auditManager.getEntries().length,
        latestHash: latest?.currentHash,
        latestSequence: latest?.sequenceNumber,
      };
    }

    if (method === 'POST' && pathname === '/api/contact') {
      const body = await readBody(req);
      const name = text(body.name, 120);
      const email = text(body.email, 160);
      const role = text(body.role, 60);
      const facility = text(body.facility, 160);
      const message = text(body.message, 4000);
      if (!name || !message) throw new HttpError(400, 'Name and message are required');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'A valid email address is required');
      const entry = { id: crypto.randomUUID(), receivedAt: new Date().toISOString(), name, email, role, facility, message };
      contactMessages.push(entry);
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      fs.appendFileSync(path.join(ctx.dataDir, 'contact-messages.jsonl'), JSON.stringify(entry) + '\n');
      return { success: true, reference: entry.id.slice(0, 8).toUpperCase() };
    }

    // Emergency gate (what an anonymous scanner sees)
    if (method === 'GET' && (m = pathname.match(/^\/api\/emergency\/gate\/([^/]+)$/))) {
      const patient = lookupByCode(decodeURIComponent(m[1]));
      if (!patient) return { valid: false };
      const gate = ctx.emergencyEngine.evaluatePublicScanGate(patient);
      return { valid: true, requiresLogin: gate.requiresLogin, publicCard: gate.publicCard || null };
    }

    // ---------- Patient portal (demo: synthetic patient selected on the page) ----------
    if ((m = pathname.match(/^\/api\/patients\/([^/]+)(?:\/(.*))?$/)) && m[1] !== '') {
      const patient = ctx.patientsById.get(m[1]);
      const sub = m[2] || '';
      if (!patient) throw new HttpError(404, 'Patient not found');

      if (method === 'GET' && sub === '') return { patient: profileOf(patient) };

      if (method === 'PATCH' && sub === 'settings') {
        const body = await readBody(req);
        if (typeof body.publicEmergencyOptIn !== 'boolean') throw new HttpError(400, 'publicEmergencyOptIn must be true or false');
        patient.publicEmergencyOptIn = body.publicEmergencyOptIn;
        patient.updatedAt = new Date().toISOString();
        ctx.auditManager.appendEntry({
          actorId: patient.id,
          subjectId: patient.id,
          action: 'PATIENT_UPDATED_PUBLIC_BADGE_SETTING',
          accessType: 'NORMAL_CONSENT',
          ipAddress: '127.0.0.1',
          userAgent: 'PatientPortal/1.0',
          reason: `Public emergency badge ${patient.publicEmergencyOptIn ? 'enabled' : 'disabled'} by patient`,
        });
        return { patient: profileOf(patient) };
      }

      if (method === 'GET' && sub === 'timeline') {
        const items = ctx.timelineEngine.getTimeline(patient.id, patientActor(patient), { filters: parseFilters(url) });
        return { timeline: slimTimeline(items) };
      }

      if (method === 'GET' && sub === 'access-log') {
        return { logs: ctx.accessLogManager.getPatientAccessLog(patient.id) };
      }

      if (method === 'POST' && sub === 'disputes') {
        const body = await readBody(req);
        const reason = text(body.reason, 500);
        if (reason.length < 5) throw new HttpError(400, 'Please describe why you are disputing this access');
        const ticket = ctx.accessLogManager.disputeAccess(patient.id, String(body.auditLogId || ''), reason);
        return { ticket };
      }

      if (method === 'GET' && sub === 'consents') {
        return {
          pending: ctx.consentManager.getPendingRequests(patient.id).filter((r) => r.status === 'PENDING'),
          grants: ctx.consentManager.getPatientConsents(patient.id).map((g) => ({
            id: g.id,
            clinicianName: g.requestingClinicianName,
            facilityName: g.requestingFacilityName,
            scopes: g.scopes,
            reason: g.clinicalReason,
            createdAt: g.createdAt,
            validUntil: new Date(g.validUntil).toISOString(),
            isRevoked: g.isRevoked,
            revokedAt: g.revokedAt,
            status: g.isRevoked ? 'REVOKED' : new Date() > new Date(g.validUntil) ? 'EXPIRED' : 'ACTIVE',
          })),
        };
      }

      if (method === 'POST' && (m = sub.match(/^consents\/requests\/([^/]+)\/(approve|reject)$/))) {
        if (m[2] === 'approve') {
          const body = await readBody(req);
          const customHours = Number(body.customHours);
          const grant = ctx.consentManager.approveInApp(
            m[1],
            patient.id,
            Number.isFinite(customHours) && customHours > 0 && customHours <= 24 * 365 ? { customHours } : undefined
          );
          return { grantId: grant.id };
        }
        ctx.consentManager.rejectRequest(m[1], patient.id);
        return { success: true };
      }

      if (method === 'POST' && (m = sub.match(/^consents\/grants\/([^/]+)\/revoke$/))) {
        const body = await readBody(req);
        const grant = ctx.consentManager.revokeConsent(patient.id, m[1], text(body.reason, 200) || 'Patient revoked consent');
        return { grantId: grant.id, status: 'REVOKED' };
      }

      if (method === 'POST' && sub === 'emergency-code/reissue') {
        const old = ctx.codeByPatient.get(patient.id);
        const fresh = generatePatientUniqueCode('medistry.health');
        if (old) {
          ctx.patientsByCode.delete(old.rawCode);
          ctx.patientsByCode.delete(old.formattedCode);
        }
        ctx.patientsByCode.set(fresh.rawCode, patient);
        ctx.patientsByCode.set(fresh.formattedCode, patient);
        ctx.codeByPatient.set(patient.id, { rawCode: fresh.rawCode, formattedCode: fresh.formattedCode });
        patient.activeEmergencyCodeId = fresh.rawCode;
        ctx.auditManager.appendEntry({
          actorId: patient.id,
          subjectId: patient.id,
          action: 'EMERGENCY_CODE_REVOKED_AND_REISSUED',
          accessType: 'NORMAL_CONSENT',
          ipAddress: '127.0.0.1',
          userAgent: 'PatientPortal/1.0',
          reason: 'Patient reissued emergency code. The previous code no longer works.',
        });
        return { emergencyCode: fresh.formattedCode };
      }

      if (method === 'GET' && sub === 'notifications') {
        const phones = new Set(patient.emergencyContacts.map((c) => c.phone));
        const demo = decryptPatientDemographics(patient);
        const sms = ctx.notifications.sentSmsLogs
          .filter((s) => phones.has(s.to))
          .map((s) => ({ channel: 'SMS to emergency contact', to: s.to, message: s.message }));
        const push = ctx.notifications.sentPushLogs
          .filter((p) => p.toUserId === patient.id)
          .map((p) => ({ channel: 'Push to you', to: `${demo.firstName} ${demo.lastName}`, message: `${p.title}: ${p.body}` }));
        return { notifications: [...push, ...sms].reverse().slice(0, 50) };
      }

      return undefined;
    }

    // ---------- Clinician sign-in ----------
    if (method === 'GET' && (m = pathname.match(/^\/api\/demo\/totp\/([^/]+)$/))) {
      // Demo authenticator: shows the current code so visitors can sign in. Disabled in production.
      if (IS_PRODUCTION) throw new HttpError(404, 'Not found');
      const secret = totpSecrets.get(m[1]);
      if (!secret) throw new HttpError(404, 'Clinician not found');
      const stepMs = 30_000;
      return { code: generateTotp(secret), secondsRemaining: Math.ceil((stepMs - (Date.now() % stepMs)) / 1000) };
    }

    if (method === 'POST' && pathname === '/api/clinician/login') {
      const body = await readBody(req);
      const clinician = ctx.seedData.clinicians.find((c) => c.id === body.clinicianId);
      if (!clinician) throw new HttpError(404, 'Clinician not found');
      const state = loginFailures.get(clinician.id) || { count: 0, lockedUntil: 0 };
      if (state.lockedUntil > Date.now()) {
        throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil((state.lockedUntil - Date.now()) / 60000)} minutes.`);
      }
      const ok = verifyTotp(String(body.totp || '').trim(), totpSecrets.get(clinician.id)!);
      if (!ok) {
        state.count += 1;
        if (state.count >= MAX_LOGIN_ATTEMPTS) {
          state.lockedUntil = Date.now() + LOCKOUT_MS;
          state.count = 0;
        }
        loginFailures.set(clinician.id, state);
        throw new HttpError(401, 'Invalid authenticator code');
      }
      loginFailures.delete(clinician.id);
      const { rawToken } = generateSessionToken();
      sessions.set(rawToken, { clinicianId: clinician.id, expiresAt: Date.now() + SESSION_TTL_MS });
      return { token: rawToken, clinician: publicClinician(clinician) };
    }

    if (method === 'POST' && pathname === '/api/clinician/logout') {
      const header = req.headers.authorization || '';
      sessions.delete(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
      return { success: true };
    }

    if (!pathname.startsWith('/api/clinician/') && !pathname.startsWith('/api/emergency/')) return undefined;

    // ---------- Everything below needs a clinician session ----------
    if (method === 'POST' && pathname === '/api/emergency/break-glass') {
      const clinician = currentClinician(req);
      const body = await readBody(req);
      const patient = lookupByCode(String(body.code || ''));
      if (!patient) throw new HttpError(404, 'Patient emergency code not found');
      const facility = ctx.seedData.facilities.find((f) => f.id === clinician.facilityId) || ctx.seedData.facilities[0];
      const reason = String(body.reason || 'UNCONSCIOUS') as any;
      const { grant } = await ctx.emergencyEngine.initiateBreakGlass({
        patient,
        emergencyCode: String(body.code),
        actor: clinicianActor(clinician),
        treatingDoctorName: clinician.fullName,
        facilityId: facility.id,
        facilityName: facility.name,
        reason,
        reasonDetails: text(body.reasonDetails, 500),
      });
      await ctx.notifications.sendPush(
        patient.id,
        'Emergency Break-Glass Alert',
        `${clinician.fullName} at ${facility.name} opened your emergency record (${reason}). If this was not expected, dispute it in the patient portal.`
      );
      return { success: true, grantId: grant.id, redirectUrl: `/emergency/summary?grant=${grant.id}` };
    }

    if (!pathname.startsWith('/api/clinician/') && !pathname.startsWith('/api/emergency/grants/')) return undefined;
    const clinician = currentClinician(req);

    if (method === 'GET' && pathname === '/api/clinician/me') return { clinician: publicClinician(clinician) };

    if (method === 'POST' && pathname === '/api/clinician/lookup') {
      const body = await readBody(req);
      const found = ctx.consentManager.lookupPatientSafe(
        { code: body.code ? String(body.code) : undefined, patientId: body.patientId, dateOfBirth: body.dateOfBirth },
        ctx.patientsById,
        (code) => {
          const p = lookupByCode(code);
          return p ? { valid: true, patientId: p.id } : { valid: false };
        }
      );
      if (found.found) {
        const consent = ctx.consentManager.resolveActiveConsent(found.patientId!, clinician.id, clinician.facilityId);
        return { ...found, hasActiveConsent: !!consent };
      }
      return found;
    }

    if (method === 'POST' && pathname === '/api/clinician/access-requests') {
      const body = await readBody(req);
      const patient = getPatient(String(body.patientId || ''));
      const reason = text(body.reason, 300);
      if (reason.length < 5) throw new HttpError(400, 'A clinical reason is required');
      const preset: ConsentDurationPreset = ['ONE_VISIT', 'SEVEN_DAYS', 'THIRTY_DAYS'].includes(body.durationPreset) ? body.durationPreset : 'ONE_VISIT';
      const { requestId, rawOtp, expiresAt } = ctx.consentManager.createAccessRequest({
        patientId: patient.id,
        clinicianId: clinician.id,
        clinicianName: clinician.fullName,
        facilityId: clinician.facilityId,
        facilityName: facilityName(clinician.facilityId),
        requestedScopes: ['all'],
        durationPreset: preset,
        clinicalReason: reason,
      });
      // The one-time passcode goes to the patient (push), never back to the clinician.
      await ctx.notifications.sendPush(
        patient.id,
        'Record access request',
        `${clinician.fullName} (${facilityName(clinician.facilityId)}) asks to view your record. One-time code: ${rawOtp}. Approve in the portal or read the code to them.`
      );
      return { requestId, expiresAt };
    }

    if (method === 'POST' && (m = pathname.match(/^\/api\/clinician\/access-requests\/([^/]+)\/otp$/))) {
      const body = await readBody(req);
      const grant = ctx.consentManager.approveViaOtp(m[1], String(body.otp || '').trim(), clinician.id);
      return { grantId: grant.id, validUntil: new Date(grant.validUntil).toISOString() };
    }

    if (method === 'GET' && pathname === '/api/clinician/consents') {
      const grants: unknown[] = [];
      for (const p of ctx.patientsById.values()) {
        for (const g of ctx.consentManager.getPatientConsents(p.id)) {
          if (g.targetClinicianId !== clinician.id) continue;
          const active = !g.isRevoked && new Date() <= new Date(g.validUntil);
          const demo = decryptPatientDemographics(p);
          grants.push({
            id: g.id,
            patientId: p.id,
            patientInitials: `${demo.firstName.charAt(0)}. ${demo.lastName}`,
            validUntil: new Date(g.validUntil).toISOString(),
            status: g.isRevoked ? 'REVOKED' : active ? 'ACTIVE' : 'EXPIRED',
          });
        }
      }
      return { grants };
    }

    if (method === 'GET' && (m = pathname.match(/^\/api\/clinician\/patients\/([^/]+)\/record$/))) {
      const patient = getPatient(m[1]);
      const consent = ctx.consentManager.resolveActiveConsent(patient.id, clinician.id, clinician.facilityId);
      if (!consent) throw new HttpError(403, 'No active patient consent. Request access first.');
      const items = ctx.timelineEngine.getTimeline(patient.id, clinicianActor(clinician), { consent, filters: parseFilters(url) });
      return { patient: profileOf(patient), timeline: slimTimeline(items) };
    }

    if (method === 'GET' && pathname === '/api/clinician/emergency-grants') {
      return {
        grants: ctx.emergencyEngine.getActiveGrantsForClinician(clinician.id).map((g) => ({
          id: g.id,
          patientCode: g.emergencyCode,
          reason: g.reason,
          grantedAt: g.grantedAt,
          expiresAt: new Date(g.expiresAt).toISOString(),
          fullHistoryAccess: g.fullHistoryAccess,
          coSignDoctorName: g.coSignDoctorName,
          summaryUrl: `/emergency/summary?grant=${g.id}`,
        })),
      };
    }

    if (method === 'POST' && pathname === '/api/clinician/cosign') {
      const body = await readBody(req);
      const grant = ctx.emergencyEngine.getGrant(String(body.grantId || '').trim());
      if (!grant) throw new HttpError(404, 'Emergency grant not found');
      const updated = ctx.emergencyEngine.coSignForFullHistory({
        grantId: grant.id,
        primaryClinicianId: grant.clinicianId,
        coSignClinicianId: clinician.id,
        coSignDoctorName: clinician.fullName,
        coSignReason: text(body.reason, 300),
      });
      return { grantId: updated.id, fullHistoryAccess: updated.fullHistoryAccess };
    }

    if (method === 'GET' && (m = pathname.match(/^\/api\/emergency\/grants\/([^/]+)\/full-history$/))) {
      const grant = ctx.emergencyEngine.getGrant(m[1]);
      if (!grant) throw new HttpError(404, 'Emergency grant not found');
      if (grant.clinicianId !== clinician.id && grant.coSignClinicianId !== clinician.id) {
        throw new HttpError(403, 'This grant belongs to another clinician');
      }
      const patient = getPatient(grant.patientId);
      const items = ctx.timelineEngine.getTimeline(patient.id, clinicianActor(clinician), { emergencyGrant: grant });
      return { patient: profileOf(patient), timeline: slimTimeline(items), expiresAt: new Date(grant.expiresAt).toISOString() };
    }

    return undefined;
  }

  return handle;
}
