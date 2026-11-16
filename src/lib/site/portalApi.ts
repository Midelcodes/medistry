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

import type { SeedDatabasePayload, SeedClinician, SeedFacility } from '../../../prisma/seed.ts';
import { decryptField, decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
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
import type { NotificationDeliveryStore } from '../notifications/deliveries.ts';
import type { UssdService } from '../ussd/ussdService.ts';
import { log } from '../ops/logger.ts';
import { API_TOKEN_TTL_SECONDS, type FacilityApiClientStore, type FacilityApiClient } from '../integrations/apiClients.ts';
import type { FhirImportService } from '../integrations/fhirImport.ts';
import type { IntakeService } from '../intake/intakeService.ts';
import type { MasterPatientIndex } from '../identity/mpi.ts';
import type { PatientRegistrationService } from '../identity/registration.ts';
import { NATIONAL_EXCHANGE_SCOPE, type NationalExchangeService } from '../integrations/hie/nationalExchange.ts';
import type { PharmacyService } from '../integrations/pharmacy.ts';
import type { BillingService } from '../billing/billingService.ts';
import type { AuditAnomalyAgent } from '../audit/anomalyAgent.ts';
import { retentionReport } from '../ops/retention.ts';
import { RecordExportEngine } from '../clinical/export.ts';
import type { FacilityOnboardingService } from '../facilities/onboarding.ts';
import { facilityUsage } from '../facilities/usage.ts';
import { getSecurityHttpHeaders, sanitizeClinicalText, SlidingWindowRateLimiter } from '../security/rateLimiter.ts';
import { appBaseUrl, appSecret, clientIp, DEMO_MODE, parseCookies, SESSION_COOKIE, SESSION_TTL_MS } from '../security/config.ts';
import { buildOfflineCardBundle, cardLocale } from '../emergency/offlineCard.ts';
import { SUPPORTED_LOCALES } from '../i18n/translations.ts';
import { latestDiagnosisForCard } from '../clinical/encounters.ts';
import { evaluatePolicy, type ActorContext } from '../policy/enforcer.ts';
import type { OfflineCardStore } from '../emergency/offlineCardStore.ts';
import type { OfflineScanService } from '../emergency/offlineScans.ts';
import type { RecordFlagStore } from '../clinical/recordFlags.ts';
import { TriageValidationError, type TriageBoardStore } from '../emergency/triageBoard.ts';
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
  // Triage agent results shown on the clinician triage board (decision support only)
  triageBoard?: TriageBoardStore;
  persistence?: Persistence;
  dataDir: string;
  // Sign-in (Phase 12)
  accounts: AccountStore;
  patientAuth: PatientAuthService;
  staff: StaffService;
  proxies: ProxyService;
  // SMS delivery records and USSD (Phase 13)
  deliveries: NotificationDeliveryStore;
  ussd: UssdService;
  // Records from EMRs and from paper (Phase 15)
  apiClients: FacilityApiClientStore;
  fhirImport: FhirImportService;
  intake: IntakeService;
  // One person, one record (Phase 16)
  mpi: MasterPatientIndex;
  registration: PatientRegistrationService;
  // National exchanges, labs and pharmacies (Phase 17)
  nationalExchange: NationalExchangeService;
  pharmacy: PharmacyService;
  addFacility: (f: SeedFacility) => void;
  // Facilities sign up, run their staff and pay (Phase 18)
  billing: BillingService;
  onboarding: FacilityOnboardingService;
  anomalyAgent: AuditAnomalyAgent;
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
  // Provider callbacks (per calling IP: the provider's servers).
  const webhookLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 120 }); // SMS delivery reports
  const ussdLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 300 });    // USSD callbacks
  const tokenLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 30 });    // facility API client tokens
  const importLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 60 });   // FHIR bundle imports
  const intakeLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 20 });   // AI intake (uploads, model calls)
  const pharmacyLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 60 }); // pharmacy access and reads
  const exchangeLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 20 }); // national exchange queries
  const facilityRegisterLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 60_000, maxRequests: 3 }); // facility applications
  const inviteLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 10 });  // invitation acceptance
  const triageLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 60 });  // triage results and referral acceptance
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

  /** The raw request body as text (payment webhooks are verified over the exact bytes received). */
  function readRaw(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxBytes) { reject(new HttpError(413, 'Payload too large')); req.destroy(); }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /** A provider callback body: application/x-www-form-urlencoded (Africa's Talking) or JSON. */
  async function readCallback(req: http.IncomingMessage): Promise<Record<string, string>> {
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) return readBody(req, 16 * 1024);
    const raw: string = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16 * 1024) { reject(new HttpError(413, 'Payload too large')); req.destroy(); }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    return Object.fromEntries(new URLSearchParams(raw));
  }

  /**
   * Shared-secret check for provider callbacks: the secret comes in the URL path (Africa's Talking callback URLs
   * cannot carry custom headers) or the X-Medistry-Webhook-Secret header. Compared in constant time (SHA-256 of
   * both sides, so lengths do not leak). A missing or short configured secret never matches.
   */
  function secretMatches(given: string | undefined, configured: string | undefined): boolean {
    if (!configured || configured.length < 32 || !given) return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(configured).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const callbackSecret = (req: http.IncomingMessage, fromPath?: string) =>
    fromPath ? decodeURIComponent(fromPath) : String(req.headers['x-medistry-webhook-secret'] || '') || undefined;

  /**
   * USSD callback (Africa's Talking format). Replies are text/plain "CON ..."/"END ...". USSD_CALLBACK_SECRET is
   * required when set; without it the endpoint only works in demo mode.
   */
  async function handleUssd(req: http.IncomingMessage, res: http.ServerResponse, secretInPath?: string): Promise<void> {
    const reply = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...getSecurityHttpHeaders() });
      res.end(body);
    };
    if (!ussdLimiter.check(clientIp(req)).allowed) return reply(429, 'END Too many requests. Try again in a minute.');
    const configured = process.env.USSD_CALLBACK_SECRET;
    if (configured ? !secretMatches(callbackSecret(req, secretInPath), configured) : !DEMO_MODE) return reply(configured ? 401 : 404, 'END Not available.');
    try {
      const body = await readCallback(req);
      reply(200, await ctx.ussd.handle(body, { ipAddress: clientIp(req), userAgent: 'USSD' }));
    } catch {
      reply(200, 'END Sorry, something went wrong. Please try again later.');
    }
  }

  function getPatient(id: string): PatientEntity {
    const patient = ctx.patientsById.get(id);
    if (!patient) throw new HttpError(404, 'Patient not found');
    return patient;
  }

  // A proxy acts for the patient: the actor is the patient's record, the proxy's own id rides along (and the
  // audit log records the proxy, see audit/actingContext.ts).
  const patientActor = (p: PatientEntity): ActorContext => ({ userId: p.id, role: 'PATIENT', proxyUserId: currentActing()?.proxyUserId });
  const exportEngine = new RecordExportEngine(ctx.clinicalStore, ctx.timelineEngine);

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
    // An admin or staff account is signed in, but is not a clinician: forbidden, not just unauthenticated.
    if (!clinician && sessions.read(bearerOf(req))?.kind === 'admin') throw new HttpError(403, 'Admin accounts cannot read patient records');
    if (!clinician) throw new HttpError(401, 'Clinician sign-in required');
    return clinician;
  }

  /** The active facility API client behind a Bearer token, with the given scope. */
  function apiClientFrom(req: http.IncomingMessage, scope: string): FacilityApiClient {
    const claims = sessions.read(bearerOf(req));
    const client = claims?.kind === 'api-client' ? ctx.apiClients.get(claims.subject) : undefined;
    if (!client || client.status !== 'ACTIVE') throw new HttpError(401, 'A valid facility API token is required (POST /api/fhir/token)');
    if (!client.scopes.includes(scope as any)) throw new HttpError(403, `This client lacks the ${scope} scope`);
    return client;
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
    if (!claims || !account || account.disabled || !['FACILITY_ADMIN', 'PLATFORM_ADMIN', 'RECORDS_OFFICER', 'PHARMACIST', 'NURSE'].includes(account.role)) throw new HttpError(401, 'Admin sign-in required');
    return { account, claims };
  }

  function publicAccount(a: UserAccount) {
    const phone = ctx.accounts.phoneOf(a);
    return { id: a.id, role: a.role, patientId: a.patientId || null, phone: phone ? maskPhone(phone) : null, hasRecoveryEmail: !!a.emailHash };
  }

  /** The proxy scope a patient-portal route needs. */
  function scopeFor(method: string, sub: string): ProxyScope {
    if (/^proxies(\/|$)/.test(sub)) return 'view'; // inviting and revoking are checked by the proxy service
    if (method !== 'GET' && /^(consents\/|disputes$|records\/[^/]+\/flag$|national-exchange$)/.test(sub)) return 'approve-consent';
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

  /** Patient for an emergency code. A merged record's code leads to the surviving record (Phase 16). */
  function lookupByCode(input: string): PatientEntity | undefined {
    const p = ctx.patientsByCode.get(normalizePatientCode(input));
    return p?.mergedIntoPatientId ? ctx.patientsById.get(ctx.mpi.canonical(p.id)) : p;
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

    const ussd = method === 'POST' ? pathname.match(/^\/api\/ussd(?:\/([^/]+))?$/) : null;
    if (ussd) {
      await handleUssd(req, res, ussd[1]);
      return true;
    }

    try {
      const result = await route(req, method, pathname, url);
      if (result === undefined) return false;
      sendJson(res, 200, result, extraHeaders.get(req));
      return true;
    } catch (err: any) {
      // FHIR import errors answer with the OperationOutcome itself.
      if (err?.outcome?.resourceType === 'OperationOutcome') {
        sendJson(res, err.status || 422, err.outcome, { 'Content-Type': 'application/fhir+json' });
        return true;
      }
      const status = typeof err?.status === 'number' ? err.status : /Forbidden|Unauthorized/.test(err?.message || '') ? 403 : 400;
      sendJson(res, status, { error: err?.message || 'Request failed', ...(err?.mergedInto ? { mergedInto: err.mergedInto } : {}) });
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
      // Log the reference only (no name, email or message); the message itself goes to the local file below.
      log('info', 'contact_message_received', { reference: entry.id.slice(0, 8).toUpperCase() });
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

    // SMS delivery reports (provider callback). Needs SMS_WEBHOOK_SECRET (32+ characters) in the path or header.
    if (method === 'POST' && (m = pathname.match(/^\/api\/webhooks\/sms\/delivery(?:\/([^/]+))?$/))) {
      limit(webhookLimiter, req);
      const configured = process.env.SMS_WEBHOOK_SECRET;
      if (!configured) throw new HttpError(404, 'Not found');
      if (!secretMatches(callbackSecret(req, m[1]), configured)) throw new HttpError(401, 'Unauthorized');
      const report = await readCallback(req);
      const delivery = ctx.deliveries.applyDeliveryReport(report);
      // 200 even for an unknown message id, so the provider does not keep retrying.
      return { received: true, matched: !!delivery };
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
      // Staff, admin and machine tokens never open the patient portal (facility admins have no PHI access).
      const presented = sessions.read(bearerOf(req));
      if (presented && presented.kind !== 'person') throw new HttpError(403, 'Staff and admin accounts cannot read patient records through the patient portal');
      const person = personSession(req);
      if (!DEMO_MODE && !person) throw new HttpError(401, 'Sign in with your phone number first');
      const patient = ctx.patientsById.get(m[1]);
      const sub = m[2] || '';
      if (!patient) throw new HttpError(person || DEMO_MODE ? 404 : 401, 'Patient not found');
      if (patient.mergedIntoPatientId) {
        throw Object.assign(new HttpError(409, 'This record was merged into another record. Open the surviving record.'), { mergedInto: ctx.mpi.canonical(patient.id) });
      }
      const acting = person ? ctx.proxies.authorize(person.account, patient, scopeFor(method, sub)) : null;
      return runActing(acting, () => patientRoute(req, method, sub, url, patient, person?.account ?? null, acting));
    }

    return clinicianAndAdminRoute(req, method, pathname, url);
  }

  async function patientRoute(req: http.IncomingMessage, method: string, sub: string, url: URL, patient: PatientEntity,
    viewer: UserAccount | null, acting: ProxyActing | null): Promise<unknown | undefined> {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && sub === '') return { patient: profileOf(patient), actingAs: acting ? { proxyUserId: acting.proxyUserId, relationship: acting.relationship } : null };
    // Referrals a clinician accepted from the triage agent's suggestions. Patients see where they were referred,
    // by whom and when; never the triage score or the handover.
    if (method === 'GET' && sub === 'referrals') return { referrals: ctx.triageBoard ? ctx.triageBoard.referralsForPatient(patient.id) : [] };

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

    // National exchange sharing (Phase 17): the patient's own consent scope 'national-exchange'.
    if (sub === 'national-exchange') {
      const grants = () => ctx.consentManager.getPatientConsents(patient.id).filter((g) => !g.isRevoked && g.scopes.includes(NATIONAL_EXCHANGE_SCOPE));
      if (method === 'GET') return { enabled: grants().length > 0 };
      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
        if (body.enabled) ctx.consentManager.grantNationalExchange(patient.id, `${patient.countryCode} national health information exchange`);
        else for (const g of grants()) ctx.consentManager.revokeConsent(patient.id, g.id, 'Patient stopped national exchange sharing');
        return { enabled: grants().length > 0 };
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

    // Data portability: the patient's records as a FHIR R4 Bundle (latest versions; drafts excluded). Audited.
    if (method === 'GET' && sub === 'export') {
      const bundle = exportEngine.exportFhirBundle(patient.id, patientActor(patient), {});
      ctx.auditManager.appendEntry({
        actorId: viewer?.id || patient.userId, subjectId: patient.id, action: 'PATIENT_EXPORTED_RECORD', accessType: 'NORMAL_CONSENT',
        resourceType: 'Bundle', resourceId: bundle.id, ipAddress: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
        reason: `Patient record exported as FHIR R4 (${bundle.total} resources)`,
      });
      return bundle;
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

    // ---------- Pharmacies (Phase 17): pharmacist accounts, patient consent required ----------
    if (pathname.startsWith('/api/pharmacy/')) {
      limit(pharmacyLimiter, req);
      const { account: pharmacist } = adminSession(req);
      if (pharmacist.role !== 'PHARMACIST') throw new HttpError(403, 'Pharmacist sign-in required');
      const info = requestInfo(req);
      if (method === 'POST' && pathname === '/api/pharmacy/access/request') return ctx.pharmacy.requestOtp(pharmacist, (await readBody(req)).emergencyCode, info);
      if (method === 'POST' && pathname === '/api/pharmacy/access/card') return ctx.pharmacy.cardAccess(pharmacist, (await readBody(req)).token, info);
      if (method === 'POST' && (m = pathname.match(/^\/api\/pharmacy\/access\/([^/]+)\/otp$/))) return ctx.pharmacy.confirmOtp(pharmacist, decodeURIComponent(m[1]), (await readBody(req)).otp, info);
      if (method === 'GET' && (m = pathname.match(/^\/api\/pharmacy\/patients\/([^/]+)\/medications$/))) return ctx.pharmacy.medications(pharmacist, decodeURIComponent(m[1]), info);
      if (method === 'POST' && (m = pathname.match(/^\/api\/pharmacy\/patients\/([^/]+)\/dispense$/))) return ctx.pharmacy.dispense(pharmacist, decodeURIComponent(m[1]), await readBody(req), info);
      return undefined;
    }

    // ---------- Admins ----------
    if (pathname.startsWith('/api/admin/')) return adminRoute(req, method, pathname, url);

    // ---------- Facility self-onboarding and invitations (public) ----------
    if (method === 'POST' && pathname === '/api/facilities/register') {
      limit(facilityRegisterLimiter, req);
      return ctx.onboarding.register(await readBody(req, 15 * 1024 * 1024), requestInfo(req));
    }
    if (method === 'POST' && pathname === '/api/facilities/invites/accept') {
      limit(inviteLimiter, req);
      return ctx.onboarding.startAcceptance((await readBody(req)).token, requestInfo(req));
    }
    if (method === 'POST' && pathname === '/api/facilities/invites/verify') {
      limit(inviteLimiter, req);
      const body = await readBody(req);
      const account = ctx.onboarding.completeAcceptance(body.token, body.otp, requestInfo(req));
      return {
        token: sessions.issue('admin', account.id, SESSION_TTL_MS), expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
        account: { id: account.id, role: account.role, facilityId: account.facilityId || null, name: account.displayName || null, needsCredentials: !account.passwordHash },
      };
    }

    // ---------- Payment provider webhooks (signature or path secret checked; never touches emergency features) ----------
    if (method === 'POST' && (m = pathname.match(/^\/api\/billing\/webhooks\/(paystack|mpesa)(?:\/([^/]+))?$/))) {
      limit(webhookLimiter, req);
      const raw = await readRaw(req);
      return ctx.billing.handleWebhook(m[1] as 'paystack' | 'mpesa', raw, req.headers as Record<string, string | string[] | undefined>, m[2] ? decodeURIComponent(m[2]) : undefined, requestInfo(req));
    }

    // ---------- Facility systems: FHIR import (client credentials, short-lived token) ----------
    if (method === 'POST' && pathname === '/api/fhir/token') {
      limit(tokenLimiter, req);
      const body = await readCallback(req); // form-encoded (OAuth 2.0 style) or JSON
      if (body.grant_type !== 'client_credentials') throw new HttpError(400, 'grant_type must be client_credentials');
      let id = body.client_id;
      let secret = body.client_secret;
      const basic = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
      if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      const client = await ctx.apiClients.authenticate(id, secret, requestInfo(req));
      if (!client) throw new HttpError(401, 'invalid_client');
      return { access_token: sessions.issue('api-client', client.id, API_TOKEN_TTL_SECONDS * 1000), token_type: 'Bearer', expires_in: API_TOKEN_TTL_SECONDS, scope: client.scopes.join(' ') };
    }
    if (method === 'POST' && pathname === '/api/fhir/import') {
      limit(importLimiter, req);
      const client = apiClientFrom(req, 'fhir.import');
      const bundle = await readBody(req, 8 * 1024 * 1024);
      const result = await ctx.fhirImport.importBundle(bundle, { id: client.id, clientId: client.clientId, facilityId: client.facilityId }, requestInfo(req));
      extraHeaders.set(req, { 'Content-Type': 'application/fhir+json' });
      return result.response;
    }

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

    // ---------- Triage board: results of the triage agent (decision support only) ----------
    // Posted against an active break-glass grant the clinician owns: the patient is identified by the grant, the
    // access is already audited and the patient already notified. Never written to the clinical record or the card.
    if (method === 'POST' && (m = pathname.match(/^\/api\/emergency\/grants\/([^/]+)\/triage$/))) {
      limit(triageLimiter, req);
      if (!ctx.triageBoard) throw new HttpError(503, 'Triage board is not available');
      const grant = ctx.emergencyEngine.getGrant(decodeURIComponent(m[1]));
      if (!grant || new Date(grant.expiresAt).getTime() < Date.now()) throw new HttpError(404, 'Emergency grant not found or expired');
      if (grant.clinicianId !== clinician.id && grant.coSignClinicianId !== clinician.id) throw new HttpError(403, 'This grant belongs to another clinician');
      const info = requestInfo(req);
      try {
        const result = ctx.triageBoard.create({
          patientId: grant.patientId, facilityId: clinician.facilityId, clinicianId: clinician.id, clinicianUserId: clinician.userId,
          grantId: grant.id, payload: await readBody(req, 64 * 1024), ipAddress: info.ipAddress, userAgent: info.userAgent,
        });
        return { triageResultId: result.id, colour: result.colour, tews: result.tews, boardUrl: '/clinicians/triage' };
      } catch (err: any) {
        if (err instanceof TriageValidationError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (method === 'GET' && pathname === '/api/clinician/triage/board') {
      limit(triageLimiter, req);
      if (!ctx.triageBoard) throw new HttpError(503, 'Triage board is not available');
      const rows = ctx.triageBoard.board(clinician.facilityId);
      return {
        facilityId: clinician.facilityId,
        facilityName: facilityName(clinician.facilityId),
        disclaimer: 'Decision support only. Triage scoring is not clinically validated. The clinician makes every decision.',
        generatedAt: new Date().toISOString(),
        // Pseudonymous reference and minimised essentials only; no names, contacts or emergency codes.
        patients: rows.map(({ patientId: _p, grantId: _g, ...r }) => r),
      };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/clinician\/triage\/([^/]+)\/accept-referral$/))) {
      limit(triageLimiter, req);
      if (!ctx.triageBoard) throw new HttpError(503, 'Triage board is not available');
      const body = await readBody(req);
      try {
        const r = ctx.triageBoard.acceptReferral(decodeURIComponent(m[1]), String(body.facilityId || ''),
          { clinicianId: clinician.id, userId: clinician.userId, name: clinician.fullName, facilityId: clinician.facilityId }, requestInfo(req));
        return { id: r.id, acceptedReferral: r.acceptedReferral };
      } catch (err: any) {
        if (err instanceof TriageValidationError) throw new HttpError(err.message === 'Triage result not found' ? 404 : 400, err.message);
        throw err;
      }
    }

    // ---------- Drafts and AI intake (Phase 15): all need the patient's active consent ----------
    const consentFor = (patientId: string) => {
      const consent = ctx.consentManager.resolveActiveConsent(patientId, clinician.id, clinician.facilityId);
      if (!consent) throw new HttpError(403, 'No active patient consent. Request access first.');
      return consent as any;
    };
    if (method === 'POST' && pathname === '/api/clinician/intake') {
      limit(intakeLimiter, req);
      const body = await readBody(req, 15 * 1024 * 1024); // photo or voice note, base64, at most UPLOAD_MAX_MB decoded
      const patient = getPatient(String(body.patientId || ''));
      return ctx.intake.create({ patient, kind: body.kind, text: body.text, file: body.file }, clinicianActor(clinician), consentFor(patient.id), requestInfo(req));
    }
    if ((m = pathname.match(/^\/api\/clinician\/intake\/([^/]+)(?:\/(.*))?$/))) {
      const intakeId = decodeURIComponent(m[1]);
      const sub = m[2] || '';
      const view = ctx.intake.get(intakeId, clinicianActor(clinician));
      const consent = consentFor(view.patientId);
      if (method === 'GET' && sub === '') return view;
      if (method === 'POST' && sub === 'sign') return ctx.intake.signAll(intakeId, clinicianActor(clinician), consent, requestInfo(req), (await readBody(req)).recordIds);
      let d: RegExpMatchArray | null;
      if (method === 'POST' && (d = sub.match(/^drafts\/([^/]+)$/))) return ctx.intake.revise(intakeId, decodeURIComponent(d[1]), (await readBody(req)).fields, clinicianActor(clinician), consent);
      if (method === 'POST' && (d = sub.match(/^drafts\/([^/]+)\/discard$/))) return ctx.intake.discard(intakeId, decodeURIComponent(d[1]), (await readBody(req)).reason, clinicianActor(clinician), consent);
      return undefined;
    }
    // National exchange summary (Phase 17): with the patient's consent; shown separately, never merged.
    if (method === 'GET' && (m = pathname.match(/^\/api\/clinician\/patients\/([^/]+)\/national-summary$/))) {
      limit(exchangeLimiter, req);
      const patient = getPatient(m[1]);
      consentFor(patient.id);
      return ctx.nationalExchange.querySummary(patient, { userId: clinician.userId, facilityId: clinician.facilityId, basis: 'consent' });
    }
    // Lab results this clinician ordered (Phase 17).
    if (method === 'GET' && pathname === '/api/clinician/lab-results') {
      return {
        results: ctx.clinicalStore.resultsOrderedBy(clinician.id).map((r) => {
          const res = JSON.parse(decryptField(r.encryptedPayload));
          return { recordId: r.id, patientId: r.patientId, resourceType: r.resourceType, title: res.code?.text || r.resourceType, originFacilityId: r.originFacilityId, createdAt: r.createdAt };
        }),
      };
    }
    // Drafts waiting for a doctor (imported without a verified author, or created by staff): list and sign.
    if (method === 'GET' && (m = pathname.match(/^\/api\/clinician\/patients\/([^/]+)\/drafts$/))) {
      const patient = getPatient(m[1]);
      const drafts = ctx.clinicalStore.getDrafts(patient.id, clinicianActor(clinician), consentFor(patient.id));
      return { drafts: drafts.map(({ record, resource }) => ({ recordId: record.id, resourceType: record.resourceType, source: record.source, originFacilityId: record.originFacilityId, versionId: record.versionId, createdAt: record.createdAt, resource })) };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/clinician\/drafts\/([^/]+)\/sign$/))) {
      const draft = ctx.clinicalStore.getRecordById(decodeURIComponent(m[1]));
      if (!draft || draft.status !== 'draft') throw new HttpError(404, 'Draft not found');
      const { record } = ctx.clinicalStore.signDraft(draft.id, clinicianActor(clinician), { consent: consentFor(draft.patientId), facilityId: clinician.facilityId });
      return { recordId: record.id, versionId: record.versionId, previousVersionId: record.previousVersionId, status: record.status };
    }

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
      const summary = ctx.emergencyEngine.buildEmergencySummary(getPatient(grant.patientId), grant.id);
      ctx.emergencyEngine.recordSummaryView(grant.id, clinician.userId, clinician.facilityId);
      return { summary };
    }

    // National exchange summary under break-glass (Phase 17): the grant's own clinicians, while it is active.
    if (method === 'GET' && (m = pathname.match(/^\/api\/emergency\/grants\/([^/]+)\/national-summary$/))) {
      limit(exchangeLimiter, req);
      const grant = ctx.emergencyEngine.getGrant(m[1]);
      if (!grant || new Date(grant.expiresAt).getTime() < Date.now()) throw new HttpError(404, 'Emergency grant not found or expired');
      if (grant.clinicianId !== clinician.id && grant.coSignClinicianId !== clinician.id) throw new HttpError(403, 'This grant belongs to another clinician');
      return ctx.nationalExchange.querySummary(getPatient(grant.patientId), { userId: clinician.userId, facilityId: clinician.facilityId, basis: 'break-glass' });
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
    // USSD PIN (feature phones): 4 digits, scrypt; setting a new PIN also lifts a USSD lockout.
    if (pathname === '/api/auth/patient/ussd-pin') {
      await ctx.ussd.setPin(account, (await readBody(req)).pin, info);
      return { success: true };
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
    // Records officers: registration, patient account links and the duplicate queue only.
    if (admin.role === 'RECORDS_OFFICER' && !/^\/api\/admin\/(me|logout|credentials|patients(\/.*)?|mpi\/.*)$/.test(pathname)) {
      throw new HttpError(403, 'Records officers can register patients and review duplicates only');
    }
    if ((admin.role === 'PHARMACIST' || admin.role === 'NURSE') && !/^\/api\/admin\/(me|logout|credentials)$/.test(pathname)) {
      throw new HttpError(403, admin.role === 'PHARMACIST' ? 'Pharmacists use the pharmacy API only' : 'Nurse workflows are not available yet');
    }
    // Admin and analytics features need an active subscription (or trial). Emergency, patient and clinical features never do.
    const requireSubscription = (facilityId: string | undefined) => {
      if (admin.role === 'PLATFORM_ADMIN' || !facilityId) return;
      if (!ctx.billing.hasAccess(facilityId)) throw new HttpError(402, 'Your subscription is not active. Renew it to use admin and analytics features. Emergency access, offline scanning and patient records are not affected.');
    };
    const ownFacility = () => (admin.role === 'PLATFORM_ADMIN' ? url.searchParams.get('facilityId') || undefined : admin.facilityId);
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
    // Facility API clients for EMR integration: created by a facility admin (own facility) or a platform admin.
    if (method === 'GET' && pathname === '/api/admin/facility-api-clients') return { clients: ctx.apiClients.list(admin) };
    if (method === 'POST' && pathname === '/api/admin/facility-api-clients') {
      requireSubscription(admin.facilityId);
      const { client, clientSecret } = await ctx.apiClients.create(admin, await readBody(req), info);
      return {
        id: client.id, clientId: client.clientId, clientSecret, facilityId: client.facilityId, scopes: client.scopes,
        note: 'Store the client secret now: it is shown only once. Exchange it at POST /api/fhir/token for a short-lived token.',
      };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/facility-api-clients\/([^/]+)\/revoke$/))) {
      const c = ctx.apiClients.revoke(admin, decodeURIComponent(m[1]), info);
      return { id: c.id, status: c.status };
    }

    if (method === 'POST' && pathname === '/api/admin/facility-admins') {
      const { admin: created, totpEnrolment } = await ctx.staff.createFacilityAdmin(admin, await readBody(req), info);
      return { adminId: created.id, facilityId: created.facilityId, totpEnrolment };
    }

    // First sign-in after an invitation: set a password and enrol an authenticator (once).
    if (method === 'POST' && pathname === '/api/admin/credentials') {
      return ctx.onboarding.setCredentials(admin, (await readBody(req)).password, info);
    }
    // Facility applications (platform admin).
    if (method === 'GET' && pathname === '/api/admin/facility-applications') {
      return { applications: ctx.onboarding.listApplications(admin, url.searchParams.get('status') || 'PENDING') };
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/admin\/facility-applications\/([^/]+)\/document$/))) {
      return { document: ctx.onboarding.accreditationDocument(admin, decodeURIComponent(m[1]), info) };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/facilities\/([^/]+)\/(verify|reject)$/))) {
      return ctx.onboarding.review(admin, decodeURIComponent(m[1]), m[2] as 'verify' | 'reject', (await readBody(req)).reason, appBaseUrl(req), info);
    }
    // Staff (facility admin): list, invite, suspend/reinstate, reassign. Clinician approval: /api/admin/clinicians.
    if (method === 'GET' && pathname === '/api/admin/staff') return ctx.onboarding.listStaff(admin, url.searchParams.get('facilityId'));
    if (method === 'POST' && pathname === '/api/admin/staff/invite') {
      const body = await readBody(req);
      requireSubscription(admin.role === 'PLATFORM_ADMIN' ? body.facilityId : admin.facilityId);
      return ctx.onboarding.inviteStaff(admin, body, appBaseUrl(req), info);
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/staff\/([^/]+)\/(suspend|reinstate|role)$/))) {
      const body = await readBody(req);
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'role') {
        requireSubscription(admin.facilityId);
        return ctx.onboarding.changeRole(admin, id, body.role, info);
      }
      // Suspending staff is a safety action: never gated by billing.
      return ctx.onboarding.setSuspended(admin, id, m[2] === 'suspend', body.reason, info);
    }
    // Usage dashboard: aggregate counts only, no patient data.
    if (method === 'GET' && pathname === '/api/admin/usage') {
      if (admin.role !== 'FACILITY_ADMIN' && admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Admins only');
      const facilityId = ownFacility();
      if (!facilityId || !ctx.onboarding.facility(facilityId)) throw new HttpError(400, 'Give the facilityId');
      requireSubscription(facilityId);
      return facilityUsage({ auditManager: ctx.auditManager, clinicalStore: ctx.clinicalStore, emergencyEngine: ctx.emergencyEngine }, facilityId, Number(url.searchParams.get('days') || 30));
    }
    // Billing (facility admin): plans and subscription; start a test/sandbox checkout.
    if (method === 'GET' && pathname === '/api/admin/billing') {
      const facilityId = ownFacility();
      if (!facilityId) throw new HttpError(400, 'Give the facilityId');
      return ctx.billing.view(admin, facilityId);
    }
    if (method === 'POST' && pathname === '/api/admin/billing/subscribe') {
      if (admin.role !== 'FACILITY_ADMIN') throw new HttpError(403, 'The facility admin subscribes');
      if (!ctx.onboarding.isVerified(admin.facilityId!)) throw new HttpError(403, 'This facility is not verified yet');
      const body = await readBody(req);
      return ctx.billing.subscribe(admin, admin.facilityId!, body.plan, { email: ctx.accounts.emailOf(admin), phone: ctx.accounts.phoneOf(admin) }, appBaseUrl(req), info);
    }

    // Audit agent review queue (platform admins): rule-based flags, human decision, no automatic action.
    if (method === 'GET' && pathname === '/api/admin/anomalies') {
      return { flags: ctx.anomalyAgent.list(admin, url.searchParams.get('status') || 'OPEN'), rules: ctx.anomalyAgent.config };
    }
    if (method === 'POST' && pathname === '/api/admin/anomalies/run') {
      if (admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Platform admins only');
      return { created: ctx.anomalyAgent.run().length };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/anomalies\/([^/]+)\/review$/))) {
      const body = await readBody(req);
      return { flag: ctx.anomalyAgent.review(admin, decodeURIComponent(m[1]), body.decision, body.note, info) };
    }
    // Patient disputes of access events (complaints): platform admins review and resolve them.
    if (method === 'GET' && pathname === '/api/admin/disputes') {
      if (admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Platform admins only');
      const status = url.searchParams.get('status');
      return { disputes: ctx.accessLogManager.getOpenDisputes().filter((t) => !status || t.status === status) };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/disputes\/([^/]+)\/resolve$/))) {
      if (admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Platform admins only');
      const body = await readBody(req);
      if (body.resolution !== 'RESOLVED_VALID' && body.resolution !== 'RESOLVED_BREACH') throw new HttpError(400, 'resolution must be RESOLVED_VALID or RESOLVED_BREACH');
      const notes = text(body.notes, 1000);
      if (notes.length < 5) throw new HttpError(400, 'Write a short note explaining the resolution');
      try {
        return { dispute: ctx.accessLogManager.resolveDispute(decodeURIComponent(m[1]), admin.id, body.resolution, notes) };
      } catch (err: any) {
        throw new HttpError(/not found/i.test(err.message) ? 404 : 400, err.message);
      }
    }
    // Retention report (platform admins): what WOULD be archived. Deletes nothing.
    if (method === 'GET' && pathname === '/api/admin/retention-report') {
      if (admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Platform admins only');
      const report = retentionReport(ctx);
      ctx.auditManager.appendEntry({ actorId: admin.id, action: 'RETENTION_REPORT_GENERATED', accessType: 'SYSTEM_ADMIN', ipAddress: info.ipAddress, userAgent: info.userAgent, reason: 'Retention report generated (report only, nothing deleted)' });
      return report;
    }

    // National exchange integration view: connector status, last sync, queued, failed (facility admin: own facility).
    if (method === 'GET' && pathname === '/api/admin/integrations') {
      if (admin.role !== 'FACILITY_ADMIN' && admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Admins only');
      return ctx.nationalExchange.adminView(admin);
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/integrations\/outbox\/([^/]+)\/retry$/))) {
      if (admin.role !== 'FACILITY_ADMIN' && admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Admins only');
      const msg = ctx.nationalExchange.retry(admin, decodeURIComponent(m[1]));
      return { id: msg.id, status: msg.status };
    }
    // New facilities (labs, pharmacies, clinics): platform admin only.
    if (method === 'POST' && pathname === '/api/admin/facilities') {
      if (admin.role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'Only a platform admin adds facilities');
      const body = await readBody(req);
      const kind = String(body.kind || '').toUpperCase();
      if (!['HOSPITAL', 'CLINIC', 'LAB', 'PHARMACY'].includes(kind)) throw new HttpError(400, 'kind must be HOSPITAL, CLINIC, LAB or PHARMACY');
      const name = text(body.name, 160).trim();
      const countryCode = String(body.countryCode || '').toUpperCase();
      if (name.length < 3 || !/^[A-Z]{2}$/.test(countryCode)) throw new HttpError(400, 'Give the facility name and countryCode');
      const f: SeedFacility = {
        id: `fac-${kind.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`, name, kind: kind as SeedFacility['kind'], countryCode,
        region: text(body.region, 80) || 'Not stated', type: kind === 'LAB' ? 'Laboratory' : kind === 'PHARMACY' ? 'Pharmacy' : text(body.type, 80) || 'Facility',
        address: text(body.address, 200) || 'Not stated', registryCode: body.registryCode ? text(body.registryCode, 40) : null,
      };
      ctx.addFacility(f);
      ctx.auditManager.appendEntry({ actorId: admin.id, action: 'FACILITY_CREATED', accessType: 'SYSTEM_ADMIN', facilityId: f.id, ipAddress: info.ipAddress, userAgent: info.userAgent, reason: `${kind} facility created` });
      return { facility: f };
    }
    if (method === 'POST' && pathname === '/api/admin/pharmacists') {
      const { officer, totpEnrolment } = await ctx.staff.createRecordsOfficer(admin, await readBody(req), info, 'PHARMACIST');
      return { pharmacistId: officer.id, facilityId: officer.facilityId, totpEnrolment };
    }

    // Patient registration with identity checks; probable duplicates go to the review queue (never merged here).
    if (method === 'POST' && pathname === '/api/admin/patients') {
      return ctx.registration.register(admin, await readBody(req), info);
    }
    if (method === 'POST' && pathname === '/api/admin/records-officers') {
      const { officer, totpEnrolment } = await ctx.staff.createRecordsOfficer(admin, await readBody(req), info);
      return { officerId: officer.id, facilityId: officer.facilityId, totpEnrolment };
    }
    // Duplicate review queue, merge and unmerge: a records officer of a facility involved, or a platform admin.
    if (method === 'GET' && pathname === '/api/admin/mpi/reviews') {
      return { reviews: ctx.mpi.listReviews(admin, url.searchParams.get('status') || 'OPEN', info) };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/mpi\/reviews\/([^/]+)\/(merge|dismiss)$/))) {
      const body = await readBody(req);
      if (m[2] === 'dismiss') return { review: ctx.mpi.dismiss(admin, decodeURIComponent(m[1]), info) };
      return { merge: ctx.mpi.merge(admin, { reviewId: decodeURIComponent(m[1]), survivorId: body.survivorId }, info) };
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/admin\/mpi\/merges\/([^/]+)\/unmerge$/))) {
      return { merge: ctx.mpi.unmerge(admin, decodeURIComponent(m[1]), info) };
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
