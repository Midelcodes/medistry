/**
 * Clinician and admin sign-in, clinician self-registration and review.
 *
 * Sign-in: password (scrypt, N=2^15) then TOTP. Five failures of either lock the account (accounts.ts). In demo
 * mode, seeded clinicians and demo admins have no password and sign in with the demo authenticator only;
 * outside demo mode a password is always required.
 *
 * Registration: licence format checked against the country registry (Phase 7), licence document validated,
 * scanned and encrypted (SecureDocumentManager), status PENDING. A FACILITY_ADMIN of the claimed facility or a
 * PLATFORM_ADMIN approves or rejects; every step is audited. PENDING clinicians have no clinical permissions.
 */
import crypto from 'node:crypto';
import type { SeedClinician, SeedFacility } from '../../../prisma/seed.ts';
import { decryptField, encryptField } from '../patient/profile.ts';
import { createTotpEnrolment, fromRfc4648Base32, generateTotpSecret, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword, verifyTotp } from './security.ts';
import { AccountStore, normalizeEmail, normalizePhone, type UserAccount } from './accounts.ts';
import { AuthError, type RequestInfo } from './patientAuth.ts';
import { ClinicianVerificationManager, registryFor, validateLicenceFormat } from '../clinician/verification.ts';
import { SecureDocumentManager, type CredentialDocument } from '../clinical/fileUpload.ts';
import { evaluatePolicy } from '../policy/enforcer.ts';
import { generateQrSvg } from '../code/deliverables.ts';
import { sanitizeClinicalText } from '../security/rateLimiter.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { ClinicianRepo } from '../data/repositories.ts';

// Days before a recorded licence expiry date to remind the clinician. An operational choice, not a regulatory rule.
export const LICENCE_REMINDER_DAYS = Math.max(1, parseInt(process.env.LICENCE_REMINDER_DAYS || '30', 10) || 30);
const DAY_MS = 86_400_000;

export interface CredentialDocumentRepo { saveCredentialDocument(d: CredentialDocument): void }

export interface StaffDeps {
  accounts: AccountStore;
  auditManager: AuditChainManager;
  dispatcher: NotificationDispatcher;
  clinicians: SeedClinician[];  // the runtime's list (new registrations are added to it)
  facilities: SeedFacility[];
  serverKey: string;
  demoMode: boolean;
  onClinicianAdded?: (c: SeedClinician) => void; // registers the name with the timeline and access log
}

export interface TotpEnrolment { otpauthUri: string; qrSvg: string }

const text = (v: unknown, max: number) => sanitizeClinicalText(typeof v === 'string' ? v : '').trim().slice(0, max);

export class StaffService {
  private deps: StaffDeps;
  private documents = new Map<string, CredentialDocument>(); // clinicianId -> licence document
  private docManager = new SecureDocumentManager();
  private verification = new ClinicianVerificationManager();
  /** Write-through repository (no-op in memory storage). */
  persistence?: CredentialDocumentRepo & ClinicianRepo;

  constructor(deps: StaffDeps) {
    this.deps = deps;
  }

  hydrate(documents: CredentialDocument[]): void {
    for (const d of documents) this.documents.set(d.clinicianId, d);
  }

  private derivedSecret(id: string): string {
    return generateTotpSecret(20, crypto.createHmac('sha256', this.deps.serverKey).update(`totp:${id}`).digest());
  }

  /** The TOTP secret: the enrolled one, else (demo seed accounts only) one derived from the server key. */
  totpSecretFor(id: string, account?: UserAccount): string | null {
    if (account?.encryptedTotpSecret) return decryptField(account.encryptedTotpSecret);
    return this.deps.demoMode ? this.derivedSecret(id) : null;
  }

  /** Demo authenticator: only for demo-mode accounts without an enrolled authenticator. */
  demoTotpSecret(id: string): string | null {
    if (!this.deps.demoMode) return null;
    const clinician = this.deps.clinicians.find((c) => c.id === id);
    const account = this.deps.accounts.get(clinician ? clinician.userId : id);
    if (account?.encryptedTotpSecret) return null;
    if (clinician) return this.derivedSecret(id);
    return account && (account.role === 'FACILITY_ADMIN' || account.role === 'PLATFORM_ADMIN') ? this.derivedSecret(id) : null;
  }

  private enrolment(label: string): { secret: string; enrolment: TotpEnrolment } {
    const { secret, otpauthUri } = createTotpEnrolment(label);
    return { secret, enrolment: { otpauthUri, qrSvg: generateQrSvg(otpauthUri, { label: 'Authenticator enrolment QR code' }) } };
  }

  private audit(action: string, actorId: string, info: RequestInfo, reason: string, extra: { facilityId?: string; resourceId?: string } = {}): void {
    this.deps.auditManager.appendEntry({
      actorId, action, accessType: 'SYSTEM_ADMIN', ipAddress: info.ipAddress, userAgent: info.userAgent, reason,
      ...(extra.resourceId ? { resourceType: 'Clinician', resourceId: extra.resourceId } : {}),
      ...(extra.facilityId ? { facilityId: extra.facilityId } : {}),
    });
  }

  /** Password (when required) then TOTP. Every failure counts towards the lockout. */
  private async checkFactors(account: UserAccount, totpId: string, password: unknown, totp: unknown, now: number): Promise<void> {
    const accounts = this.deps.accounts;
    try {
      accounts.assertNotLocked(account, now);
    } catch (err: any) {
      throw new AuthError(429, err.message);
    }
    const passwordRequired = !this.deps.demoMode || !!account.passwordHash;
    if (passwordRequired) {
      const ok = !!account.passwordHash && typeof password === 'string' && password.length <= 200 && await verifyPassword(password, account.passwordHash);
      if (!ok) {
        accounts.recordFailure(account, now);
        throw new AuthError(401, 'Invalid password or authenticator code');
      }
    }
    const secret = this.totpSecretFor(totpId, account);
    if (!secret || !verifyTotp(String(totp ?? '').trim(), secret, now)) {
      accounts.recordFailure(account, now);
      throw new AuthError(401, passwordRequired ? 'Invalid password or authenticator code' : 'Invalid authenticator code');
    }
    accounts.recordSuccess(account, now);
    if (!account.totpEnabled && account.encryptedTotpSecret) {
      account.totpEnabled = true; // first use of the enrolled authenticator confirms the enrolment
      accounts.save(account);
    }
  }

  /** Seeded clinicians get an account on first use, to hold lockout state (and a password, if one is set). */
  private clinicianAccount(c: SeedClinician): UserAccount {
    return this.deps.accounts.get(c.userId) || this.deps.accounts.create({ id: c.userId, role: 'DOCTOR', countryCode: c.countryCode || 'NG' });
  }

  findClinician(body: { clinicianId?: unknown; email?: unknown }): SeedClinician | undefined {
    if (typeof body.clinicianId === 'string' && body.clinicianId) return this.deps.clinicians.find((c) => c.id === body.clinicianId);
    const email = normalizeEmail(body.email);
    const account = email ? this.deps.accounts.byEmailAddress(email) : undefined;
    return account?.role === 'DOCTOR' ? this.deps.clinicians.find((c) => c.userId === account.id) : undefined;
  }

  async signInClinician(clinician: SeedClinician, password: unknown, totp: unknown, info: RequestInfo, now = Date.now()): Promise<void> {
    if (clinician.status === 'REJECTED' || clinician.status === 'SUSPENDED') {
      throw new AuthError(403, `This clinician account is ${clinician.status.toLowerCase()}. Contact your facility admin.`);
    }
    await this.checkFactors(this.clinicianAccount(clinician), clinician.id, password, totp, now);
    this.audit('CLINICIAN_SIGNED_IN', clinician.userId, info, `Signed in with password and authenticator code (status ${clinician.status})`, { facilityId: clinician.facilityId });
  }

  // ---------- admins ----------
  findAdmin(body: { adminId?: unknown; email?: unknown }): UserAccount | undefined {
    const email = normalizeEmail(body.email);
    const account = typeof body.adminId === 'string' && body.adminId ? this.deps.accounts.get(body.adminId) : email ? this.deps.accounts.byEmailAddress(email) : undefined;
    return account && (account.role === 'FACILITY_ADMIN' || account.role === 'PLATFORM_ADMIN') ? account : undefined;
  }

  async signInAdmin(admin: UserAccount, password: unknown, totp: unknown, info: RequestInfo, now = Date.now()): Promise<void> {
    await this.checkFactors(admin, admin.id, password, totp, now);
    this.audit('ADMIN_SIGNED_IN', admin.id, info, `${admin.role} signed in with password and authenticator code`, { facilityId: admin.facilityId });
  }

  /** Demo admins (demo mode only): a platform admin and one facility admin per facility, demo authenticator, no password. */
  ensureDemoAdmins(): void {
    if (!this.deps.demoMode) return;
    const accounts = this.deps.accounts;
    if (!accounts.get('admin-platform-demo')) accounts.create({ id: 'admin-platform-demo', role: 'PLATFORM_ADMIN', countryCode: 'NG', displayName: 'Demo Platform Admin (synthetic)' });
    for (const f of this.deps.facilities) {
      const id = `admin-${f.id}-demo`;
      if (!accounts.get(id)) accounts.create({ id, role: 'FACILITY_ADMIN', countryCode: f.countryCode, facilityId: f.id, displayName: `Demo Facility Admin, ${f.name} (synthetic)` });
    }
  }

  /**
   * First platform admin, from the environment (see scripts/admin-credentials.ts): PLATFORM_ADMIN_EMAIL,
   * PLATFORM_ADMIN_PASSWORD_HASH (scrypt) and PLATFORM_ADMIN_TOTP_SECRET (RFC 4648 base32). Created once.
   */
  bootstrapPlatformAdmin(env: NodeJS.ProcessEnv = process.env): UserAccount | null {
    const email = normalizeEmail(env.PLATFORM_ADMIN_EMAIL);
    const hash = (env.PLATFORM_ADMIN_PASSWORD_HASH || '').trim();
    const totp = (env.PLATFORM_ADMIN_TOTP_SECRET || '').trim();
    if (!email || !hash.startsWith('scrypt$') || !totp) return null;
    const existing = this.deps.accounts.byEmailAddress(email);
    if (existing) return existing;
    const bytes = fromRfc4648Base32(totp);
    if (bytes.length < 16) throw new Error('PLATFORM_ADMIN_TOTP_SECRET must be an RFC 4648 base32 secret of at least 16 bytes');
    const account = this.deps.accounts.create({
      id: `platform-admin-${crypto.randomUUID()}`, role: 'PLATFORM_ADMIN', countryCode: 'NG', displayName: 'Platform Admin',
      passwordHash: hash, encryptedTotpSecret: encryptField(generateTotpSecret(20, bytes)),
    });
    this.deps.accounts.setEmail(account, email);
    return account;
  }

  /** A PLATFORM_ADMIN creates a FACILITY_ADMIN. Returns the authenticator enrolment (shown once). */
  async createFacilityAdmin(by: UserAccount, body: any, info: RequestInfo): Promise<{ admin: UserAccount; totpEnrolment: TotpEnrolment }> {
    if (by.role !== 'PLATFORM_ADMIN') throw new AuthError(403, 'Only a platform admin can create facility admins');
    const fullName = text(body.name, 120);
    const email = normalizeEmail(body.email);
    const facility = this.deps.facilities.find((f) => f.id === body.facilityId);
    if (fullName.length < 3) throw new AuthError(400, 'Give the admin\'s full name');
    if (!email) throw new AuthError(400, 'Give a valid email address');
    if (!facility) throw new AuthError(400, 'Unknown facility');
    const password = this.password(body.password);
    if (this.deps.accounts.byEmailAddress(email)) throw new AuthError(409, 'This email address belongs to another account');
    const { secret, enrolment } = this.enrolment(email);
    const admin = this.deps.accounts.create({
      id: `admin-${crypto.randomUUID()}`, role: 'FACILITY_ADMIN', countryCode: facility.countryCode, facilityId: facility.id, displayName: fullName,
      passwordHash: await hashPassword(password), encryptedTotpSecret: encryptField(secret),
    });
    this.deps.accounts.setEmail(admin, email);
    this.audit('FACILITY_ADMIN_CREATED', by.id, info, `Facility admin ${admin.id} created`, { facilityId: facility.id });
    return { admin, totpEnrolment: enrolment };
  }

  private password(value: unknown): string {
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > 200) {
      throw new AuthError(400, `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    return value;
  }

  // ---------- clinician self-registration ----------
  async registerClinician(body: any, info: RequestInfo): Promise<{ clinician: SeedClinician; totpEnrolment: TotpEnrolment; message: string; regulator: string; registryMatch: boolean }> {
    const fullName = text(body.name, 120);
    if (fullName.length < 3) throw new AuthError(400, 'Give your full name as it appears on your licence');
    const phone = normalizePhone(body.phone);
    if (!phone) throw new AuthError(400, 'Give your phone number in international format, for example +234 800 000 0000');
    const email = normalizeEmail(body.email);
    if (!email) throw new AuthError(400, 'Give a valid email address');
    const countryCode = String(body.countryCode || '').trim().toUpperCase();
    try {
      registryFor(countryCode || '??');
    } catch (err: any) {
      throw new AuthError(400, err.message);
    }
    const licence = validateLicenceFormat(countryCode, String(body.licenceNumber || ''));
    if (!licence.valid) throw new AuthError(400, licence.error || 'Invalid licence number');
    // Registry code first; facilities without one (the Nigerian demo facilities) can be named by id.
    const claimed = String(body.facilityRegistryCode || '').trim().toUpperCase();
    const facility = this.deps.facilities.find((f) => f.countryCode === countryCode && claimed && (f.registryCode?.toUpperCase() === claimed || f.id.toUpperCase() === claimed));
    if (!facility) throw new AuthError(400, 'No facility with that registry code in this country');
    const password = this.password(body.password);
    let licenceExpiresOn: string | undefined;
    if (body.licenceExpiresOn !== undefined && body.licenceExpiresOn !== '') {
      licenceExpiresOn = String(body.licenceExpiresOn);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(licenceExpiresOn) || Number.isNaN(Date.parse(licenceExpiresOn))) throw new AuthError(400, 'licenceExpiresOn must be a date (YYYY-MM-DD)');
      if (Date.parse(licenceExpiresOn) < Date.now()) throw new AuthError(400, 'This licence has already expired');
    }
    const doc = body.licenceDocument || {};
    if (typeof doc.contentBase64 !== 'string' || !doc.contentBase64) throw new AuthError(400, 'Attach your licence document (PDF, JPEG or PNG)');
    if (this.deps.clinicians.some((c) => c.countryCode === countryCode && c.licenseNumber === licence.normalized)) {
      throw new AuthError(409, 'This licence number is already registered. Contact your facility admin.');
    }
    if (this.deps.accounts.byEmailAddress(email) || this.deps.accounts.byPhoneNumber(phone)) {
      throw new AuthError(409, 'This phone number or email address belongs to another account');
    }

    const id = `clinician-${crypto.randomUUID()}`;
    let document: CredentialDocument;
    try {
      document = await this.docManager.processCredentialDocument({ filename: String(doc.filename || 'licence'), mimeType: String(doc.mimeType || ''), buffer: Buffer.from(doc.contentBase64, 'base64') }, id);
    } catch (err: any) {
      throw new AuthError(400, err.message);
    }
    const userId = crypto.randomUUID();
    const check = await this.verification.processOnboardingSubmission({ id, userId, fullName, countryCode, licenseNumber: licence.normalized!, specialty: text(body.specialty, 120) || 'Not stated' });
    const clinician: SeedClinician = {
      id, userId, fullName, licenseNumber: check.profile.licenseNumber, countryCode, specialty: check.profile.specialty, facilityId: facility.id,
      status: 'PENDING', registeredAt: new Date().toISOString(), registryMatch: check.registryMatch, ...(licenceExpiresOn ? { licenceExpiresOn } : {}),
    };
    this.deps.clinicians.push(clinician);
    this.persistence?.saveClinician(clinician);
    this.deps.onClinicianAdded?.(clinician);
    const { secret, enrolment } = this.enrolment(email);
    const account = this.deps.accounts.create({ id: userId, role: 'DOCTOR', countryCode, passwordHash: await hashPassword(password), encryptedTotpSecret: encryptField(secret) });
    this.deps.accounts.setPhone(account, phone);
    this.deps.accounts.setEmail(account, email);
    this.documents.set(id, document);
    this.persistence?.saveCredentialDocument(document);
    this.audit('CLINICIAN_REGISTERED', userId, info, `Self-registration submitted to ${check.regulator}; licence format valid; registry match ${check.registryMatch ? 'yes' : 'no'}; status PENDING`, { facilityId: facility.id, resourceId: id });
    for (const admin of this.deps.accounts.all()) {
      if (admin.role === 'FACILITY_ADMIN' && admin.facilityId === facility.id) {
        await this.deps.dispatcher.notifyUser(admin.id, 'Clinician awaiting review', `${fullName} registered at ${facility.name} and is waiting for your review.`);
      }
    }
    return { clinician, totpEnrolment: enrolment, message: check.message, regulator: check.regulator, registryMatch: check.registryMatch };
  }

  private canReview(admin: UserAccount, clinician: SeedClinician): void {
    const decision = evaluatePolicy({
      actor: { userId: admin.id, role: admin.role as 'FACILITY_ADMIN' | 'PLATFORM_ADMIN', facilityId: admin.facilityId },
      action: 'CLINICIAN_VERIFY',
      targetFacilityId: clinician.facilityId,
    });
    if (!decision.allowed) throw new AuthError(403, decision.reason);
  }

  listForReview(admin: UserAccount, status?: string) {
    return this.deps.clinicians
      .filter((c) => admin.role === 'PLATFORM_ADMIN' || c.facilityId === admin.facilityId)
      .filter((c) => !status || c.status === status)
      .map((c) => ({
        id: c.id, fullName: c.fullName, licenseNumber: c.licenseNumber, countryCode: c.countryCode, facilityId: c.facilityId, status: c.status,
        registeredAt: c.registeredAt, registryMatch: c.registryMatch, licenceExpiresOn: c.licenceExpiresOn, hasLicenceDocument: this.documents.has(c.id),
      }));
  }

  /** Decrypted licence document for a reviewer. Audited. */
  licenceDocument(admin: UserAccount, clinicianId: string, info: RequestInfo): { filename: string; mimeType: string; sha256: string; contentBase64: string } {
    const clinician = this.deps.clinicians.find((c) => c.id === clinicianId);
    if (!clinician) throw new AuthError(404, 'Clinician not found');
    this.canReview(admin, clinician);
    const doc = this.documents.get(clinicianId);
    if (!doc) throw new AuthError(404, 'No licence document on file');
    this.audit('LICENCE_DOCUMENT_VIEWED', admin.id, info, 'Licence document opened for review', { facilityId: clinician.facilityId, resourceId: clinician.id });
    return { filename: doc.filename, mimeType: doc.mimeType, sha256: doc.sha256, contentBase64: decryptField(doc.encryptedPayload) };
  }

  async review(admin: UserAccount, clinicianId: string, decision: 'approve' | 'reject', reasonInput: unknown, info: RequestInfo): Promise<SeedClinician> {
    const clinician = this.deps.clinicians.find((c) => c.id === clinicianId);
    if (!clinician) throw new AuthError(404, 'Clinician not found');
    this.canReview(admin, clinician);
    if (clinician.status !== 'PENDING') throw new AuthError(409, `This clinician is already ${clinician.status}`);
    const reason = text(reasonInput, 300);
    if (decision === 'reject' && reason.length < 5) throw new AuthError(400, 'Give a reason for the rejection');
    clinician.status = decision === 'approve' ? 'VERIFIED' : 'REJECTED';
    clinician.reviewedBy = admin.id;
    clinician.reviewedAt = new Date().toISOString();
    if (decision === 'reject') clinician.rejectionReason = reason;
    this.persistence?.saveClinician(clinician);
    this.audit(decision === 'approve' ? 'CLINICIAN_APPROVED' : 'CLINICIAN_REJECTED', admin.id, info,
      `${admin.role} ${decision === 'approve' ? 'approved' : 'rejected'} clinician registration${reason ? `: ${reason}` : ''}`, { facilityId: clinician.facilityId, resourceId: clinician.id });
    const account = this.deps.accounts.get(clinician.userId);
    const phone = account ? this.deps.accounts.phoneOf(account) : undefined;
    const message = decision === 'approve'
      ? 'Your Medistry clinician account is verified. You can now sign in and use clinical features.'
      : 'Your Medistry clinician registration was not approved. Contact your facility admin for details.';
    if (phone) await this.deps.dispatcher.sendSms(phone, message);
    await this.deps.dispatcher.notifyUser(clinician.userId, 'Clinician registration', message);
    return clinician;
  }

  /**
   * Re-verification reminders: one per recorded licence expiry date, LICENCE_REMINDER_DAYS before it.
   * Runs at start-up and daily (server.ts). Returns how many reminders were sent.
   */
  async sendLicenceReminders(now = Date.now()): Promise<number> {
    let sent = 0;
    for (const c of this.deps.clinicians) {
      if (!c.licenceExpiresOn || c.licenceReminderSentFor === c.licenceExpiresOn) continue;
      if (c.status !== 'VERIFIED' && c.status !== 'PENDING') continue;
      const daysLeft = Math.ceil((Date.parse(c.licenceExpiresOn) - now) / DAY_MS);
      if (daysLeft > LICENCE_REMINDER_DAYS) continue;
      const message = daysLeft > 0
        ? `Your licence on record with Medistry expires on ${c.licenceExpiresOn}. Renew it and ask your facility admin to re-verify your account before then.`
        : `Your licence on record with Medistry expired on ${c.licenceExpiresOn}. Ask your facility admin to re-verify your account with your renewed licence.`;
      const account = this.deps.accounts.get(c.userId);
      const phone = account ? this.deps.accounts.phoneOf(account) : undefined;
      const email = account ? this.deps.accounts.emailOf(account) : undefined;
      if (phone) await this.deps.dispatcher.sendSms(phone, message);
      if (email) await this.deps.dispatcher.sendEmail(email, 'Medistry licence re-verification', message);
      await this.deps.dispatcher.notifyUser(c.userId, 'Licence re-verification', message);
      c.licenceReminderSentFor = c.licenceExpiresOn;
      this.persistence?.saveClinician(c);
      this.audit('LICENCE_REVERIFICATION_REMINDER', 'system', { ipAddress: '127.0.0.1', userAgent: 'Medistry/scheduler' },
        `Licence expiry reminder sent (${daysLeft > 0 ? `${daysLeft} days left` : 'expired'})`, { facilityId: c.facilityId, resourceId: c.id });
      sent++;
    }
    return sent;
  }
}
