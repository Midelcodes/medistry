/**
 * MEDISTRY Portal API
 * JSON endpoints behind the patient portal, clinician console, emergency gate
 * and contact form. All data is synthetic and held in memory.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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
import { generateTotp } from '../auth/security.ts';
import { SessionManager, type SessionClaims } from '../auth/sessions.ts';
import { maskPhone, type AccountStore, type UserAccount } from '../auth/accounts.ts';
import type { PatientAuthService, RequestInfo } from '../auth/patientAuth.ts';
import type { StaffService } from '../auth/staff.ts';
import type { ProxyService, ProxyScope } from '../auth/proxies.ts';
import { currentActing, runActing, type ProxyActing } from '../audit/actingContext.ts';
import { getSecurityHttpHeaders, sanitizeClinicalText, SlidingWindowRateLimiter } from '../security/rateLimiter.ts';
import { appBaseUrl, appSecret, clientIp, DEMO_MODE, parseCookies, SESSION_COOKIE, SESSION_TTL_MS } from '../security/config.ts';
import { buildOfflineCardBundle, cardLocale } from '../emergency/offlineCard.ts';
import { SUPPORTED_LOCALES } from '../i18n/translations.ts';
import { latestDiagnosisForCard } from '../clinical/encounters.ts';
import { evaluatePolicy, type ActorContext } from '../policy/enforcer.ts';
import type { OfflineCardStore } from '../emergency/offlineCardStore.ts';
import type { OfflineScanService } from '../emergency/offlineScans.ts';
import type { RecordFlagStore } from '../clinical/recordFlags.ts';
import type { Persistence } from '../data/repositories.ts';
import { validateCardSelection, type CardDiagnosis } from '../emergency/cardPayload.ts';

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
  offlineCards: OfflineCardStore;
  offlineScans: OfflineScanService;
  recordFlags: RecordFlagStore;
  persistence?: Persistence;
  dataDir: string;
  // Sign-in (Phase 12)
  accounts: AccountStore;
  patientAuth: PatientAuthService;
  staff: StaffService;
  proxies: ProxyService;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export function createPortalApi(ctx: PortalContext) {
  // ---- Clinician authentication state (in memory) ----
  // Secrets and session tokens are derived from JWT_SECRET. If it is unset or a published default,
  // a random per-process key is used instead (see security/config.ts), never a key from this repo.
  const serverKey = appSecret('JWT_SECRET');
  const loginLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 10 });
  // Offline card endpoints (on top of the server-wide limiter). Signing, verification and device-key
  // binding cost CPU and write audit entries, so each has its own per-IP budget.
  const cardLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 30 });       // card issue/view/revoke, settings, flags
  const deviceKeyLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 10 });  // device-key binding
  const scanUploadLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 20 }); // offline-scan batches (up to 50 events each)
  const limit = (limiter: SlidingWindowRateLimiter, req: http.IncomingMessage) => {
    if (!limiter.check(clientIp(req)).allowed) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
  };
  const registerLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 60_000, maxRequests: 5 }); // clinician self-registration
  const extraHeaders = new WeakMap<http.IncomingMessage, Record<string, string>>();
  // One token format for clinicians, admins, patients and proxies (auth/sessions.ts). Tokens issued before an
  // account's sessionsNotBefore (sign out everywhere, account recovery) are refused.
  const sessions = new SessionManager(serverKey);
  sessions.notBefore = (kind, subject) => {
    const userId = kind === 'clinician' ? ctx.seedData.clinicians.find((c) => c.id === subject)?.userId : subject;
    const at = userId ? ctx.accounts.get(userId)?.sessionsNotBefore : undefined;
    return at ? Date.parse(at) : undefined;
  };
  const requestInfo = (req: http.IncomingMessage): RequestInfo => ({ ipAddress: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 200) });
  const contactMessages: Array<Record<string, string>> = [];

  // ---- Helpers ----
  function sendJson(res: http.ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...getSecurityHttpHeaders(), ...extra });
    res.end(JSON.stringify(data));
  }

  function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxBytes) {
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

  // A proxy acts for the patient: the actor is the patient's record, the proxy's own id rides along (and the
  // audit log records the proxy, see audit/actingContext.ts).
  const patientActor = (p: PatientEntity): ActorContext => ({ userId: p.id, role: 'PATIENT', proxyUserId: currentActing()?.proxyUserId });

  function facilityName(id: string): string {
    return ctx.seedData.facilities.find((f) => f.id === id)?.name || id;
  }

  function clinicianFromToken(token: string): SeedClinician | null {
    const claims = token ? sessions.read(token) : null;
    if (claims?.kind !== 'clinician') return null;
    const clinician = ctx.seedData.clinicians.find((c) => c.id === claims.subject);
    return clinician && clinician.status !== 'REJECTED' && clinician.status !== 'SUSPENDED' ? clinician : null;
  }

  const bearerOf = (req: http.IncomingMessage) => {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  };

  // API calls authenticate with the Bearer header only. The session cookie (HttpOnly, SameSite=Strict)
  // is accepted solely for read-only page navigations such as the emergency summary.
  function authenticate(req: http.IncomingMessage, opts: { allowCookie?: boolean } = {}): SeedClinician | null {
    const fromHeader = clinicianFromToken(bearerOf(req));
    if (fromHeader || !opts.allowCookie) return fromHeader;
    return clinicianFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE] || '');
  }

  function currentClinician(req: http.IncomingMessage): SeedClinician {
    const clinician = authenticate(req);
    if (!clinician) throw new HttpError(401, 'Clinician sign-in required');
    return clinician;
  }

  /** PENDING clinicians can sign in and see their status, nothing clinical. */
  function requireVerified(c: SeedClinician): void {
    if (c.status !== 'VERIFIED') throw new HttpError(403, 'Your clinician account is pending verification by a facility admin. Clinical features are disabled until then.');
  }

  /** A signed-in patient or proxy (Bearer only), with its token claims. */
  function personSession(req: http.IncomingMessage): { account: UserAccount; claims: SessionClaims } | null {
    const claims = sessions.read(bearerOf(req));
    if (claims?.kind !== 'person') return null;
    const account = ctx.accounts.get(claims.subject);
    return account && (account.role === 'PATIENT' || account.role === 'PROXY') ? { account, claims } : null;
  }

  function currentPerson(req: http.IncomingMessage): { account: UserAccount; claims: SessionClaims } {
    const s = personSession(req);
    if (!s) throw new HttpError(401, 'Sign in with your phone number first');
    return s;
  }

  function adminSession(req: http.IncomingMessage): { account: UserAccount; claims: SessionClaims } {
    const claims = sessions.read(bearerOf(req));
    const account = claims?.kind === 'admin' ? ctx.accounts.get(claims.subject) : undefined;
    if (!claims || !account || (account.role !== 'FACILITY_ADMIN' && account.role !== 'PLATFORM_ADMIN')) throw new HttpError(401, 'Admin sign-in required');
    return { account, claims };
  }

  function publicAccount(a: UserAccount) {
    const phone = ctx.accounts.phoneOf(a);
    return { id: a.id, role: a.role, patientId: a.patientId || null, phone: phone ? maskPhone(phone) : null, hasRecoveryEmail: !!a.emailHash };
  }

  /** The proxy scope a patient-portal route needs. */
  function scopeFor(method: string, sub: string): ProxyScope {
    if (/^proxies(\/|$)/.test(sub)) return 'view'; // inviting and revoking are checked by the proxy service
    if (method !== 'GET' && /^(consents\/|disputes$|records\/[^/]+\/flag$)/.test(sub)) return 'approve-consent';
    if (method === 'GET' && sub !== 'offline-card') return 'view';
    return 'manage-card';
  }

  function sessionCookie(req: http.IncomingMessage, token: string, maxAgeSeconds: number): string {
    const secure = IS_PRODUCTION || req.headers['x-forwarded-proto'] === 'https';
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  const clinicianActor = (c: SeedClinician): ActorContext => ({
    userId: c.userId,
    role: 'DOCTOR',
    clinicianId: c.id,
    facilityId: c.facilityId,
    isVerifiedClinician: c.status === 'VERIFIED',
  });

  function publicClinician(c: SeedClinician) {
    return {
      id: c.id,
      fullName: c.fullName,
      licenseNumber: c.licenseNumber,
      specialty: c.specialty,
      facilityId: c.facilityId,
      facilityName: facilityName(c.facilityId),
      status: c.status,
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
      card: {
        conditions: p.cardConditions,
        medicationIds: p.cardMedicationIds,
        includeRecentDiagnosis: p.cardIncludeRecentDiagnosis,
        version: p.cardVersion,
        stale: p.cardStale,
      },
      preferredLocale: p.preferredLocale || 'en',
    };
  }

  /** Most recent diagnosis for the card: the newest signed encounter's diagnosis (same source as the emergency summary). */
  function latestDiagnosis(p: PatientEntity): CardDiagnosis | null {
    return latestDiagnosisForCard(ctx.clinicalStore, p.id);
  }

  /**
   * The patient's offline card with QR and printable HTML. reissue=false returns the current card if it
   * is still valid (issuing the first one if needed); reissue=true always issues a new version.
   */
  async function offlineCardFor(p: PatientEntity, req: http.IncomingMessage, reissue: boolean, lang?: string | null) {
    const opts = { recentDiagnosis: p.cardIncludeRecentDiagnosis ? latestDiagnosis(p) : null };
    let issued: Awaited<ReturnType<typeof ctx.offlineCards.issue>> & { reused: boolean };
    const current = reissue ? null : ctx.offlineCards.getCurrentIssued(p);
    if (reissue || (!current && p.cardVersion === 0)) {
      issued = { ...ctx.offlineCards.issue(p, opts), reused: false }; // explicit reissue, or the very first card
    } else if (current) {
      issued = current;
    } else {
      // A revoked or expired card is never replaced silently: the patient must reissue.
      const last = ctx.offlineCards.latest(p.id);
      throw new HttpError(409, last?.revokedAt
        ? 'Your emergency card was revoked. Reissue it to print a new card.'
        : 'Your emergency card has expired. Reissue it to print a new card.');
    }
    const locale = cardLocale(lang || p.preferredLocale);
    const bundle = await buildOfflineCardBundle(issued, { baseUrl: appBaseUrl(req), formattedCode: ctx.codeByPatient.get(p.id)?.formattedCode, locale });
    return { ...bundle, reused: issued.reused, stale: p.cardStale, locale };
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
      sendJson(res, 200, result, extraHeaders.get(req));
      return true;
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : /Forbidden|Unauthorized/.test(err?.message || '') ? 403 : 400;
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
      // Always log (hosting platforms capture stdout); also try to keep a local file copy.
      console.log(`CONTACT_MESSAGE ${JSON.stringify(entry)}`);
      for (const dir of [ctx.dataDir, os.tmpdir()]) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, 'contact-messages.jsonl'), JSON.stringify(entry) + '\n');
          break;
        } catch {
          /* read-only filesystem: try the next location */
        }
      }
      return { success: true, reference: entry.id.slice(0, 8).toUpperCase() };
    }

    // Emergency gate (what an anonymous scanner sees)
    if (method === 'GET' && (m = pathname.match(/^\/api\/emergency\/gate\/([^/]+)$/))) {
      const patient = lookupByCode(decodeURIComponent(m[1]));
      if (!patient) return { valid: false };
      const gate = ctx.emergencyEngine.evaluatePublicScanGate(patient);
      return { valid: true, requiresLogin: gate.requiresLogin, publicCard: gate.publicCard || null };
    }

    // ---------- Patient portal ----------
    // DEMO_MODE=1: a synthetic patient is picked on the page (no sign-in), unless a session is presented.
    // DEMO_MODE=0: a patient or proxy session is required; the patient themself, or a proxy whose scopes cover
    // the route. A proxy's request runs in an acting context, so its audit entries name the proxy.
    if ((m = pathname.match(/^\/api\/patients\/([^/]+)(?:\/(.*))?$/)) && m[1] !== '') {
      const person = personSession(req);
      if (!DEMO_MODE && !person) throw new HttpError(401, 'Sign in with your phone number first');
      const patient = ctx.patientsById.get(m[1]);
      const sub = m[2] || '';
      if (!patient) throw new HttpError(person || DEMO_MODE ? 404 : 401, 'Patient not found');
      const acting = person ? ctx.proxies.authorize(person.account, patient, scopeFor(method, sub)) : null;
      return runActing(acting, () => patientRoute(req, method, sub, url, patient, person?.account ?? null, acting));
    }

    return clinicianAndAdminRoute(req, method, pathname, url);
  }

  async function patientRoute(req: http.IncomingMessage, method: string, sub: string, url: URL, patient: PatientEntity,
    viewer: UserAccount | null, acting: ProxyActing | null): Promise<unknown | undefined> {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && sub === '') return { patient: profileOf(patient), actingAs: acting ? { proxyUserId: acting.proxyUserId, relationship: acting.relationship } : null };

    // Proxies: list, invite (the patient, or a minor's managing guardian), revoke.
    if (sub === 'proxies' || sub.startsWith('proxies/')) {
      if (!viewer) throw new HttpError(401, 'Sign in with your phone number first');
      if (method === 'GET' && sub === 'proxies') {
        const all = ctx.proxies.forPatient(patient.id);
        return { proxies: acting ? all.filter((r) => r.proxyUserId === viewer.id) : all };
      }
      if (method === 'POST' && sub === 'proxies') {
        return { proxy: await ctx.proxies.invite(patient, viewer, await readBody(req), requestInfo(req)) };
      }
      if (method === 'POST' && (m = sub.match(/^proxies\/([^/]+)\/revoke$/))) {
        const r = ctx.proxies.get(decodeURIComponent(m[1]));
        if (!r || r.patientId !== patient.id) throw new HttpError(404, 'Proxy relationship not found');
        return { proxy: ctx.proxies.revoke(viewer, r.id, requestInfo(req)) };
      }
      return undefined;
    }

    if (method === 'PATCH' && sub === 'settings') {
      limit(cardLimiter, req);
      // Visibility settings only. Clinical content (conditions, medications, allergies) cannot be changed here.
      const body = await readBody(req);
      const allowed = ['publicEmergencyOptIn', 'cardConditions', 'cardMedicationIds', 'cardIncludeRecentDiagnosis', 'preferredLocale'];
      const keys = Object.keys(body || {});
      const extra = keys.filter((k) => !allowed.includes(k));
      if (extra.length) throw new HttpError(400, `Only visibility settings can be changed here. Not allowed: ${extra.join(', ')}`);
      if (!keys.length) throw new HttpError(400, `Provide at least one of: ${allowed.join(', ')}`);
      if (body.publicEmergencyOptIn !== undefined && typeof body.publicEmergencyOptIn !== 'boolean') {
        throw new HttpError(400, 'publicEmergencyOptIn must be true or false');
      }
      if (body.preferredLocale !== undefined && !SUPPORTED_LOCALES.includes(body.preferredLocale)) {
        throw new HttpError(400, `preferredLocale must be one of ${SUPPORTED_LOCALES.join(', ')}`);
      }
      if (body.preferredLocale !== undefined) patient.preferredLocale = body.preferredLocale;
      const { preferredLocale: _ignored, ...cardBody } = body;
      let card: ReturnType<typeof validateCardSelection>;
      try {
        card = validateCardSelection(patient, cardBody);
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      if (Object.keys(card).length) {
        const decision = evaluatePolicy({ actor: patientActor(patient), action: 'PATIENT_SET_CARD_VISIBILITY', targetPatientId: patient.id });
        if (!decision.allowed) throw new HttpError(decision.statusCode, decision.reason);
      }

      if (typeof body.publicEmergencyOptIn === 'boolean') {
        patient.publicEmergencyOptIn = body.publicEmergencyOptIn;
        ctx.auditManager.appendEntry({
          actorId: patient.id,
          subjectId: patient.id,
          action: 'PATIENT_UPDATED_PUBLIC_BADGE_SETTING',
          accessType: 'NORMAL_CONSENT',
          ipAddress: '127.0.0.1',
          userAgent: 'PatientPortal/1.0',
          reason: `Public emergency badge ${patient.publicEmergencyOptIn ? 'enabled' : 'disabled'} by patient`,
        });
      }
      if (Object.keys(card).length) {
        if (card.cardConditions) patient.cardConditions = card.cardConditions;
        if (card.cardMedicationIds) patient.cardMedicationIds = card.cardMedicationIds;
        if (card.cardIncludeRecentDiagnosis !== undefined) patient.cardIncludeRecentDiagnosis = card.cardIncludeRecentDiagnosis;
        // Counts only: the audit trail must not list sensitive conditions or medications.
        ctx.auditManager.appendEntry({
          actorId: patient.id,
          subjectId: patient.id,
          action: 'PATIENT_UPDATED_CARD_VISIBILITY',
          accessType: 'NORMAL_CONSENT',
          ipAddress: '127.0.0.1',
          userAgent: 'PatientPortal/1.0',
          reason: `Card shows ${patient.cardConditions.length} condition(s), ${patient.cardMedicationIds.length} medication(s), recent diagnosis ${patient.cardIncludeRecentDiagnosis ? 'on' : 'off'}`,
        });
      }
      patient.updatedAt = new Date().toISOString();
      ctx.persistence?.savePatient(patient);
      return { patient: profileOf(patient) };
    }

    // GET: current card (issues the first one if none is valid). POST: reissue, superseding the old card.
    if ((method === 'GET' || method === 'POST') && sub === 'offline-card') {
      limit(cardLimiter, req);
      return offlineCardFor(patient, req, method === 'POST', url.searchParams.get('lang'));
    }

    if (method === 'GET' && sub === 'offline-cards') {
      limit(cardLimiter, req);
      return { cards: ctx.offlineCards.list(patient.id) };
    }

    // Lost or stolen card: revoke it. Scanners learn of it on their next sync (cardStatus 'revoked').
    if (method === 'POST' && sub === 'offline-card/revoke') {
      limit(cardLimiter, req);
      const body = await readBody(req);
      const reason = text(body.reason, 200);
      if (reason.length < 2) throw new HttpError(400, 'Give a short reason, for example "lost"');
      const current = ctx.offlineCards.getCurrent(patient.id);
      if (!current) throw new HttpError(404, 'There is no current card to revoke');
      const revoked = ctx.offlineCards.revoke(patient.id, current.version, reason);
      return { revokedVersion: revoked.version, revokedAt: revoked.revokedAt, needsReissue: true };
    }

    // Patient flags a record as possibly wrong. The record is not changed; its author is notified.
    if (method === 'POST' && (m = sub.match(/^records\/([^/]+)\/flag$/))) {
      limit(cardLimiter, req);
      const body = await readBody(req);
      try {
        return { flag: ctx.recordFlags.flag(patient.id, decodeURIComponent(m[1]), text(body.note, 1000)) };
      } catch (err: any) {
        throw new HttpError(/not found/i.test(err.message) ? 404 : 400, err.message);
      }
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
      // Accepts an audit entry id, or an offline scan event id (offlineScanEventId, or passed as auditLogId).
      const requested = String(body.offlineScanEventId || body.auditLogId || '');
      const scan = ctx.offlineScans.getEvent(requested);
      if (body.offlineScanEventId && (!scan || scan.patientId !== patient.id)) throw new HttpError(404, 'Offline scan event not found');
      const auditLogId = scan && scan.patientId === patient.id ? scan.auditLogId : requested;
      const ticket = ctx.accessLogManager.disputeAccess(patient.id, auditLogId, reason);
      if (scan && scan.patientId === patient.id) ctx.offlineScans.markDisputed(scan.id);
      return { ticket, offlineScanEventId: scan && scan.patientId === patient.id ? scan.id : undefined };
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
      const now = new Date().toISOString();
      if (old) ctx.persistence?.saveEmergencyCode({ patientId: patient.id, ...old, isActive: false, createdAt: now, revokedAt: now, revocationReason: 'Reissued by patient' });
      ctx.persistence?.saveEmergencyCode({ patientId: patient.id, rawCode: fresh.rawCode, formattedCode: fresh.formattedCode, isActive: true, createdAt: now });
      ctx.persistence?.savePatient(patient);
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

  async function clinicianAndAdminRoute(req: http.IncomingMessage, method: string, pathname: string, url: URL): Promise<unknown | undefined> {
    let m: RegExpMatchArray | null;

    // ---------- Patient and proxy sign-in ----------
    if (pathname.startsWith('/api/auth/patient/')) return patientAuthRoute(req, method, pathname);

    // ---------- Admins ----------
    if (pathname.startsWith('/api/admin/')) return adminRoute(req, method, pathname, url);

    // ---------- Clinician sign-in ----------
    if (method === 'GET' && (m = pathname.match(/^\/api\/demo\/totp\/([^/]+)$/))) {
      // Demo authenticator: shows the current code so visitors can sign in. Demo mode only, never in production,
      // and never for an account with an enrolled authenticator.
      if (IS_PRODUCTION || !DEMO_MODE) throw new HttpError(404, 'Not found');
      const secret = ctx.staff.demoTotpSecret(m[1]);
      if (!secret) throw new HttpError(404, 'Clinician not found');
      const stepMs = 30_000;
      return { code: generateTotp(secret), secondsRemaining: Math.ceil((stepMs - (Date.now() % stepMs)) / 1000) };
    }

    // Self-registration: status PENDING until a facility admin of the claimed facility (or a platform admin) approves.
    if (method === 'POST' && pathname === '/api/clinician/register') {
      limit(registerLimiter, req);
      const body = await readBody(req, 15 * 1024 * 1024); // licence document (base64, at most 10 MB decoded)
      const result = await ctx.staff.registerClinician(body, requestInfo(req));
      return {
        clinicianId: result.clinician.id, status: result.clinician.status, message: result.message, regulator: result.regulator,
        registryMatch: result.registryMatch, totpEnrolment: result.totpEnrolment,
        next: 'Add the QR code to your authenticator app now: it is shown only once. You can sign in, but clinical features stay disabled until a facility admin approves you.',
      };
    }

    if (method === 'POST' && pathname === '/api/clinician/login') {
      if (!loginLimiter.check(clientIp(req)).allowed) throw new HttpError(429, 'Too many sign-in attempts from this network. Wait a minute and try again.');
      const body = await readBody(req);
      const clinician = ctx.staff.findClinician(body);
      if (!clinician) throw new HttpError(body.clinicianId ? 404 : 401, body.clinicianId ? 'Clinician not found' : 'Invalid password or authenticator code');
      // Password (required outside demo mode, or once set) then TOTP; five failures lock the account.
      await ctx.staff.signInClinician(clinician, body.password, body.totp, requestInfo(req));
      // Optional: a scanner device sends its public key to get a 7-day offline pass bound to that key.
      let offline: Record<string, string> = {};
      if (body.devicePublicJwk !== undefined && clinician.status !== 'VERIFIED') {
        offline = { passError: 'An offline pass needs a verified clinician account' };
      } else if (body.devicePublicJwk !== undefined) {
        limit(deviceKeyLimiter, req);
        let thumbprint: string;
        try {
          thumbprint = ctx.offlineScans.bindDeviceKey(clinician.id, body.devicePublicJwk);
        } catch (err: any) {
          throw new HttpError(400, err.message);
        }
        try {
          const { pass, expiresAt } = ctx.offlineScans.issuePass(clinician.id, thumbprint);
          offline = { pass, passExpiresAt: expiresAt, deviceKeyThumbprint: thumbprint };
        } catch (err: any) {
          offline = { passError: err.message };
        }
      }
      const token = sessions.issue('clinician', clinician.id, SESSION_TTL_MS);
      extraHeaders.set(req, { 'Set-Cookie': sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)) });
      return { token, clinician: publicClinician(clinician), expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000), ...offline };
    }

    if (method === 'POST' && pathname === '/api/clinician/logout') {
      // Revokes this token and clears the browser's cookie and stored copy.
      const claims = sessions.read(bearerOf(req)) || sessions.read(parseCookies(req.headers.cookie)[SESSION_COOKIE] || '');
      if (claims) sessions.revokeToken(claims);
      extraHeaders.set(req, { 'Set-Cookie': sessionCookie(req, '', 0) });
      return { success: true };
    }

    if (!pathname.startsWith('/api/clinician/') && !pathname.startsWith('/api/emergency/')) return undefined;

    // Offline scan events. No session needed: each event carries a server-signed pass and is signed by the
    // device key bound into that pass, so the upload is authenticated per event.
    if (method === 'POST' && pathname === '/api/emergency/offline-scans') {
      limit(scanUploadLimiter, req);
      const body = await readBody(req, 512 * 1024);
      let results;
      try {
        results = ctx.offlineScans.processBatch(body.events, { ipAddress: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 200) });
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      return { results };
    }

    // ---------- Everything below needs a clinician session ----------
    if (method === 'POST' && pathname === '/api/emergency/break-glass') {
      const clinician = currentClinician(req);
      requireVerified(clinician);
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
    // Everything below is clinical (records, consent, emergency grants, offline passes): verified clinicians only.
    requireVerified(clinician);

    if (method === 'GET' && pathname === '/api/clinician/record-flags') {
      limit(cardLimiter, req);
      return { flags: ctx.recordFlags.forAuthor(clinician.id) };
    }

    if (method === 'POST' && pathname === '/api/clinician/device-key') {
      limit(deviceKeyLimiter, req);
      const body = await readBody(req);
      let thumbprint: string;
      try {
        thumbprint = ctx.offlineScans.bindDeviceKey(clinician.id, body.publicJwk);
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      try {
        const { pass, expiresAt } = ctx.offlineScans.issuePass(clinician.id, thumbprint);
        return { pass, passExpiresAt: expiresAt, deviceKeyThumbprint: thumbprint };
      } catch (err: any) {
        throw new HttpError(403, err.message);
      }
    }

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

    if (method === 'GET' && (m = pathname.match(/^\/api\/emergency\/grants\/([^/]+)\/summary$/))) {
      const grant = ctx.emergencyEngine.getGrant(m[1]);
      if (!grant) throw new HttpError(404, 'Emergency grant not found');
      if (grant.clinicianId !== clinician.id && grant.coSignClinicianId !== clinician.id) {
        throw new HttpError(403, 'This grant belongs to another clinician');
      }
      return { summary: ctx.emergencyEngine.buildEmergencySummary(getPatient(grant.patientId), grant.id) };
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

  // ---------- Patient and proxy sign-in (phone first; email for recovery) ----------
  async function patientAuthRoute(req: http.IncomingMessage, method: string, pathname: string): Promise<unknown | undefined> {
    if (method !== 'POST' && !(method === 'GET' && pathname === '/api/auth/patient/me')) return undefined;
    const info = requestInfo(req);
    const signedIn = (account: UserAccount) => ({
      token: sessions.issue('person', account.id, SESSION_TTL_MS), expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000), account: publicAccount(account),
    });
    let m: RegExpMatchArray | null;

    if (pathname === '/api/auth/patient/otp/request') return ctx.patientAuth.requestSignInCode((await readBody(req)).phone, info);
    if (pathname === '/api/auth/patient/otp/verify') {
      const body = await readBody(req);
      return signedIn(ctx.patientAuth.verifySignInCode(body.phone, body.otp, info));
    }
    // Recovery: code to the recovery email, then a code to the new phone; then every old session is revoked.
    if (pathname === '/api/auth/patient/recovery/request') {
      const body = await readBody(req);
      return ctx.patientAuth.requestRecovery(body.email, body.newPhone, info);
    }
    if (pathname === '/api/auth/patient/recovery/verify-email') {
      const body = await readBody(req);
      return ctx.patientAuth.verifyRecoveryEmailCode(body.email, body.otp, info);
    }
    if (pathname === '/api/auth/patient/recovery/complete') {
      const body = await readBody(req);
      return signedIn(await ctx.patientAuth.completeRecovery(body.newPhone, body.otp, info));
    }

    // ---- signed in ----
    const { account, claims } = currentPerson(req);
    if (pathname === '/api/auth/patient/me') {
      const records = ctx.proxies.accessibleFor(account).map((r) => {
        const p = ctx.patientsById.get(r.patientId);
        const demo = p ? decryptPatientDemographics(p) : null;
        return { ...r, name: demo ? `${demo.firstName} ${demo.lastName}` : null };
      });
      const invitations = ctx.proxies.forProxy(account.id).filter((r) => r.status === 'INVITED')
        .map((r) => ({ id: r.id, relationship: r.relationship, scopes: r.scopes, validUntil: r.validUntil }));
      return { account: publicAccount(account), records, invitations };
    }
    if (pathname === '/api/auth/patient/logout') {
      sessions.revokeToken(claims);
      ctx.patientAuth.recordSignOut(account, info);
      return { success: true };
    }
    if (pathname === '/api/auth/patient/sessions/revoke') {
      ctx.patientAuth.revokeAllSessions(account, info);
      return { success: true, signedOut: 'all devices' };
    }
    if (pathname === '/api/auth/patient/recovery-email') return ctx.patientAuth.requestRecoveryEmailCode(account, (await readBody(req)).email, info);
    if (pathname === '/api/auth/patient/recovery-email/verify') {
      const body = await readBody(req);
      return { account: publicAccount(ctx.patientAuth.confirmRecoveryEmail(account, body.email, body.otp, info)) };
    }
    if ((m = pathname.match(/^\/api\/auth\/patient\/proxy-invitations\/([^/]+)\/(accept|decline)$/))) {
      return { proxy: ctx.proxies.respond(account, decodeURIComponent(m[1]), m[2] === 'accept', info) };
    }
    return undefined;
  }

  // ---------- Admins (facility and platform) ----------
  async function adminRoute(req: http.IncomingMessage, method: string, pathname: string, url: URL): Promise<unknown | undefined> {
    const info = requestInfo(req);
    let m: RegExpMatchArray | null;

    if (method === 'POST' && pathname === '/api/admin/login') {
      if (!loginLimiter.check(clientIp(req)).allowed) throw new HttpError(429, 'Too many sign-in attempts from this network. Wait a minute and try again.');
      const body = await readBody(req);
      const admin = ctx.staff.findAdmin(body);
      if (!admin) throw new HttpError(401, 'Invalid password or authenticator code');
      await ctx.staff.signInAdmin(admin, body.password, body.totp, info);
      return {
        token: sessions.issue('admin', admin.id, SESSION_TTL_MS), expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
        admin: { id: admin.id, role: admin.role, name: admin.displayName, facilityId: admin.facilityId || null },
      };
    }

    const { account: admin, claims } = adminSession(req);
    if (method === 'GET' && pathname === '/api/admin/me') {
      return { admin: { id: admin.id, role: admin.role, name: admin.displayName, facilityId: admin.facilityId || null } };
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      sessions.revokeToken(claims);
      return { success: true };
    }
    if (method === 'GET' && pathname === '/api/admin/clinicians') {
      return { clinicians: ctx.staff.listForReview(admin, url.searchParams.get('status') || undefined) };
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/admin\/clinicians\/([^/]+)\/licence-document$/))) {
      return { document: ctx.staff.licenceDocument(admin, decodeURIComponent(m[1]), info) };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/clinicians\/([^/]+)\/(approve|reject)$/))) {
      const body = await readBody(req);
      const c = await ctx.staff.review(admin, decodeURIComponent(m[1]), m[2] as 'approve' | 'reject', body.reason, info);
      return { clinicianId: c.id, status: c.status };
    }
    if (method === 'POST' && pathname === '/api/admin/facility-admins') {
      const { admin: created, totpEnrolment } = await ctx.staff.createFacilityAdmin(admin, await readBody(req), info);
      return { adminId: created.id, facilityId: created.facilityId, totpEnrolment };
    }

    // Patient accounts: a facility admin of the patient's primary facility, or a platform admin, after an
    // in-person identity check. Admins never see clinical content through these endpoints.
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/patients\/([^/]+)\/(account|guardian)$/))) {
      const patient = getPatient(decodeURIComponent(m[1]));
      if (admin.role !== 'PLATFORM_ADMIN' && admin.facilityId !== patient.primaryFacilityId) {
        throw new HttpError(403, 'Only an admin of the patient\'s primary facility, or a platform admin, can do this');
      }
      const body = await readBody(req);
      if (m[2] === 'account') {
        const account = ctx.patientAuth.linkPatient(patient, body.phone, { ...info, adminId: admin.id });
        return { account: publicAccount(account) };
      }
      return { proxy: await ctx.proxies.establishGuardian(patient, body, admin, info) };
    }
    return undefined;
  }

  return Object.assign(handle, { authenticate, offlineCardFor });
}
