/**
 * Facility self-onboarding and staff management (Phase 18).
 *
 *   register   anyone can apply: the facility is created PENDING with its accreditation document (validated, scanned,
 *              encrypted) and the contact of its first admin (encrypted). Nothing else works for it until verified.
 *   verify     a PLATFORM_ADMIN verifies (or rejects) it; audited. Verification starts the trial and creates the first
 *              FACILITY_ADMIN account with an invite link (SMS + email).
 *   invite     the link carries a single-use token (only its hash is kept, valid INVITE_HOURS); accepting it sends a
 *              one-time code to the invitee's own phone (the Phase 12 OTP machinery); the code signs them in, and
 *              they then set a password and enrol an authenticator.
 *   staff      facility admins invite staff, approve PENDING clinicians (Phase 12), suspend and reinstate staff, and
 *              reassign non-clinical roles. They never read patient records (the enforcer rule is unchanged).
 */
import crypto from 'node:crypto';
import type { SeedClinician, SeedFacility } from '../../../prisma/seed.ts';
import { encryptField, decryptField } from '../patient/profile.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import { AccountStore, normalizeEmail, normalizePhone, type AccountRole, type UserAccount } from '../auth/accounts.ts';
import { AuthError, type PatientAuthService, type RequestInfo } from '../auth/patientAuth.ts';
import { createTotpEnrolment, hashPassword, MIN_PASSWORD_LENGTH } from '../auth/security.ts';
import { generateQrSvg } from '../code/deliverables.ts';
import { SecureDocumentManager, type CredentialDocument } from '../clinical/fileUpload.ts';
import { sanitizeClinicalText } from '../security/rateLimiter.ts';
import type { BillingService } from '../billing/billingService.ts';

export const INVITE_HOURS = Math.min(168, Math.max(1, parseInt(process.env.FACILITY_INVITE_HOURS || '72', 10) || 72));
const FACILITY_KINDS = ['HOSPITAL', 'CLINIC', 'LAB', 'PHARMACY'] as const;

export interface FacilityApplication {
  facilityId: string;
  encryptedContact: string; // AES-256-GCM JSON {name, email, phone}
  document: Omit<CredentialDocument, 'clinicianId'>;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
}

export interface StaffInvite {
  id: string;
  accountId: string;
  facilityId: string;
  role: AccountRole;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  createdBy: string;
  createdAt: string;
}

export interface OnboardingRepo {
  saveFacilityApplication(a: FacilityApplication): void;
  saveStaffInvite(i: StaffInvite): void;
  saveFacility(f: SeedFacility): void;
  saveClinician(c: SeedClinician): void;
}

const text = (v: unknown, max: number) => sanitizeClinicalText(typeof v === 'string' ? v : '').trim().slice(0, max);
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
// Roles a facility admin can give, per facility kind. Clinicians are not invited into a role: they register with
// their licence (Phase 12) and the admin approves them.
const STAFF_ROLES: Record<string, AccountRole[]> = {
  HOSPITAL: ['FACILITY_ADMIN', 'RECORDS_OFFICER', 'NURSE'],
  CLINIC: ['FACILITY_ADMIN', 'RECORDS_OFFICER', 'NURSE'],
  LAB: ['FACILITY_ADMIN', 'RECORDS_OFFICER'],
  PHARMACY: ['FACILITY_ADMIN', 'PHARMACIST'],
};

export class FacilityOnboardingService {
  private applications = new Map<string, FacilityApplication>();
  private invites = new Map<string, StaffInvite>();
  private documents = new SecureDocumentManager();
  private deps: {
    facilities: SeedFacility[]; clinicians: SeedClinician[]; addFacility: (f: SeedFacility) => void; accounts: AccountStore; patientAuth: PatientAuthService;
    dispatcher: NotificationDispatcher; auditManager: AuditChainManager; billing: BillingService;
  };
  persistence?: OnboardingRepo;

  constructor(deps: FacilityOnboardingService['deps']) {
    this.deps = deps;
  }

  hydrate(applications: FacilityApplication[], invites: StaffInvite[]): void {
    for (const a of applications) this.applications.set(a.facilityId, a);
    for (const i of invites) this.invites.set(i.id, i);
  }

  /** Lets the runtime wire addFacility after storage is attached. */
  setAddFacility(fn: (f: SeedFacility) => void): void {
    this.deps.addFacility = fn;
  }

  private audit(action: string, actorId: string, facilityId: string, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({ actorId, action, accessType: 'SYSTEM_ADMIN', facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason });
  }

  facility(id: string): SeedFacility | undefined {
    return this.deps.facilities.find((f) => f.id === id);
  }

  /** True for a self-registered facility (it has an application), false for seed facilities. */
  hasApplication(facilityId: string): boolean {
    return this.applications.has(facilityId);
  }

  isVerified(facilityId: string): boolean {
    return (this.facility(facilityId)?.status || 'VERIFIED') === 'VERIFIED';
  }

  // ---------- 1. self-registration ----------
  async register(body: any, info: RequestInfo) {
    const name = text(body.name, 160);
    const kind = String(body.type || '').toUpperCase();
    const countryCode = String(body.countryCode || '').toUpperCase();
    if (name.length < 3) throw new AuthError(400, 'Give the facility name');
    if (!FACILITY_KINDS.includes(kind as any)) throw new AuthError(400, `type must be one of ${FACILITY_KINDS.join(', ')}`);
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new AuthError(400, 'countryCode must be ISO 3166-1 alpha-2 (e.g. NG, KE)');
    const registryCode = text(body.registryCode, 40);
    if (!registryCode) throw new AuthError(400, 'Give the facility registry code (e.g. the national facility registry number)');
    if (this.deps.facilities.some((f) => f.countryCode === countryCode && f.registryCode?.toUpperCase() === registryCode.toUpperCase())) {
      throw new AuthError(409, 'A facility with this registry code is already registered');
    }
    const c = body.adminContact || {};
    const contact = { name: text(c.name, 120), email: normalizeEmail(c.email), phone: normalizePhone(c.phone) };
    if (contact.name.length < 3 || !contact.email || !contact.phone) throw new AuthError(400, 'adminContact needs name, email and phone (international format)');
    if (this.deps.accounts.byEmailAddress(contact.email) || this.deps.accounts.byPhoneNumber(contact.phone)) throw new AuthError(409, 'The admin contact\'s email or phone already belongs to an account');
    const doc = body.accreditationDocument || {};
    if (typeof doc.contentBase64 !== 'string' || !doc.contentBase64) throw new AuthError(400, 'Attach the accreditation document (PDF, JPEG or PNG)');
    const facilityId = `fac-${crypto.randomUUID()}`;
    let stored: CredentialDocument;
    try {
      stored = await this.documents.processCredentialDocument({ filename: String(doc.filename || 'accreditation'), mimeType: String(doc.mimeType || ''), buffer: Buffer.from(doc.contentBase64, 'base64') }, facilityId);
    } catch (err: any) {
      throw new AuthError(400, err.message);
    }
    const f: SeedFacility = {
      id: facilityId, name, kind: kind as SeedFacility['kind'], countryCode, registryCode, status: 'PENDING',
      region: text(body.region, 80) || 'Not stated', type: kind === 'LAB' ? 'Laboratory' : kind === 'PHARMACY' ? 'Pharmacy' : kind === 'CLINIC' ? 'Clinic' : 'Hospital',
      address: text(body.address, 200) || 'Not stated',
    };
    this.deps.addFacility(f);
    const { clinicianId: _owner, ...document } = stored;
    const app: FacilityApplication = { facilityId, encryptedContact: encryptField(JSON.stringify(contact)), document, status: 'PENDING', submittedAt: new Date().toISOString() };
    this.applications.set(facilityId, app);
    this.persistence?.saveFacilityApplication(app);
    this.audit('FACILITY_REGISTERED', 'anonymous', facilityId, info, `${kind} facility applied; PENDING platform admin verification`);
    return { facilityId, status: 'PENDING', message: 'Thank you. A Medistry platform admin will verify the facility; the admin contact then receives an invitation.' };
  }

  /** Invitation and application metadata for the retention report (no contact details, no documents). */
  retentionView() {
    return {
      invites: [...this.invites.values()].map((i) => ({ id: i.id, expiresAt: i.expiresAt, usedAt: i.usedAt })),
      applications: [...this.applications.values()].map((a) => ({ id: a.facilityId, status: a.status, reviewedAt: a.reviewedAt })),
    };
  }

  listApplications(admin: UserAccount, status = 'PENDING') {
    if (admin.role !== 'PLATFORM_ADMIN') throw new AuthError(403, 'Platform admins only');
    return [...this.applications.values()].filter((a) => a.status === status).map((a) => {
      const f = this.facility(a.facilityId)!;
      const contact = JSON.parse(decryptField(a.encryptedContact));
      return { facilityId: a.facilityId, name: f.name, kind: f.kind || 'HOSPITAL', countryCode: f.countryCode, registryCode: f.registryCode, submittedAt: a.submittedAt, contact, document: { filename: a.document.filename, mimeType: a.document.mimeType, sizeBytes: a.document.sizeBytes, sha256: a.document.sha256 } };
    });
  }

  /** The decrypted accreditation document for the reviewing platform admin. Audited. */
  accreditationDocument(admin: UserAccount, facilityId: string, info: RequestInfo) {
    if (admin.role !== 'PLATFORM_ADMIN') throw new AuthError(403, 'Platform admins only');
    const a = this.applications.get(facilityId);
    if (!a) throw new AuthError(404, 'Application not found');
    this.audit('FACILITY_DOCUMENT_VIEWED', admin.id, facilityId, info, 'Accreditation document opened for review');
    return { filename: a.document.filename, mimeType: a.document.mimeType, contentBase64: decryptField(a.document.encryptedPayload) };
  }

  /** PLATFORM_ADMIN verifies or rejects. Verification starts the trial and invites the first facility admin. */
  async review(admin: UserAccount, facilityId: string, decision: 'verify' | 'reject', reason: unknown, baseUrl: string, info: RequestInfo) {
    if (admin.role !== 'PLATFORM_ADMIN') throw new AuthError(403, 'Only a platform admin verifies facilities');
    const a = this.applications.get(facilityId);
    const f = this.facility(facilityId);
    if (!a || !f) throw new AuthError(404, 'Application not found');
    if (a.status !== 'PENDING') throw new AuthError(409, `This application is already ${a.status}`);
    const now = new Date().toISOString();
    if (decision === 'reject') {
      const why = text(reason, 300);
      if (why.length < 5) throw new AuthError(400, 'Give a reason for the rejection');
      Object.assign(a, { status: 'REJECTED', reviewedBy: admin.id, reviewedAt: now, rejectionReason: why });
      f.status = 'REJECTED';
      this.persistence?.saveFacilityApplication(a);
      this.persistence?.saveFacility(f);
      this.audit('FACILITY_REJECTED', admin.id, facilityId, info, `Facility application rejected: ${why}`);
      return { facilityId, status: 'REJECTED' };
    }
    Object.assign(a, { status: 'VERIFIED', reviewedBy: admin.id, reviewedAt: now });
    f.status = 'VERIFIED';
    this.persistence?.saveFacilityApplication(a);
    this.persistence?.saveFacility(f);
    this.audit('FACILITY_VERIFIED', admin.id, facilityId, info, `${f.kind || 'HOSPITAL'} facility verified by a platform admin`);
    this.deps.billing.startTrial(facilityId, info);
    const contact = JSON.parse(decryptField(a.encryptedContact));
    const account = this.deps.accounts.create({ id: `admin-${crypto.randomUUID()}`, role: 'FACILITY_ADMIN', countryCode: f.countryCode, facilityId, displayName: contact.name });
    this.deps.accounts.setPhone(account, contact.phone);
    this.deps.accounts.setEmail(account, contact.email);
    const invite = await this.sendInvite(account, f, admin.id, baseUrl, info);
    return { facilityId, status: 'VERIFIED', adminAccountId: account.id, inviteExpiresAt: invite.expiresAt };
  }

  // ---------- 2. invitations ----------
  private async sendInvite(account: UserAccount, f: SeedFacility, by: string, baseUrl: string, info: RequestInfo, extraLink?: string): Promise<StaffInvite & { token: string }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const invite: StaffInvite = {
      id: crypto.randomUUID(), accountId: account.id, facilityId: f.id, role: account.role, tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_HOURS * 3_600_000).toISOString(), createdBy: by, createdAt: new Date().toISOString(),
    };
    this.invites.set(invite.id, invite);
    this.persistence?.saveStaffInvite(invite);
    const link = extraLink || `${baseUrl}/facility-admin#invite=${token}`;
    const phone = this.deps.accounts.phoneOf(account);
    const email = this.deps.accounts.emailOf(account);
    if (phone) await this.deps.dispatcher.sendSms(phone, { template: 'staff_invite', vars: { facility: f.name, link } });
    if (email) await this.deps.dispatcher.sendEmail(email, `Your Medistry invitation (${f.name})`, `You are invited to Medistry as ${account.role.replace('_', ' ').toLowerCase()} at ${f.name}. Open this link within ${INVITE_HOURS} hours to accept: ${link}`);
    this.audit('STAFF_INVITED', by, f.id, info, `${account.role} invited (account ${account.id}); link valid ${INVITE_HOURS}h`);
    return { ...invite, token };
  }

  private inviteFor(token: unknown): { invite: StaffInvite; account: UserAccount } {
    const h = hashToken(String(token || ''));
    const invite = [...this.invites.values()].find((i) => i.tokenHash === h);
    if (!invite || invite.usedAt || Date.parse(invite.expiresAt) < Date.now()) throw new AuthError(410, 'This invitation is invalid, used or expired. Ask your facility admin for a new one.');
    const account = this.deps.accounts.get(invite.accountId);
    if (!account || account.disabled) throw new AuthError(410, 'This invitation is no longer valid');
    return { invite, account };
  }

  /** Step 1: the invite link is opened; a code goes to the invitee's own phone. */
  async startAcceptance(token: unknown, info: RequestInfo) {
    const { account } = this.inviteFor(token);
    return this.deps.patientAuth.sendStaffInviteCode(account, info);
  }

  /** Step 2: the code signs the invitee in (the caller issues the session). The invite is used up. */
  completeAcceptance(token: unknown, otp: unknown, info: RequestInfo): UserAccount {
    const { invite, account } = this.inviteFor(token);
    this.deps.patientAuth.verifyStaffInviteCode(account, otp, info);
    invite.usedAt = new Date().toISOString();
    this.persistence?.saveStaffInvite(invite);
    this.audit('STAFF_INVITE_ACCEPTED', account.id, invite.facilityId, info, `${account.role} accepted the invitation`);
    return account;
  }

  /** Step 3 (once): a password and an authenticator for later sign-ins. */
  async setCredentials(account: UserAccount, password: unknown, info: RequestInfo) {
    if (account.passwordHash) throw new AuthError(409, 'A password is already set');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) throw new AuthError(400, `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`);
    const { secret, otpauthUri } = createTotpEnrolment(this.deps.accounts.emailOf(account) || account.id);
    account.passwordHash = await hashPassword(password);
    account.encryptedTotpSecret = encryptField(secret);
    this.deps.accounts.save(account);
    this.audit('STAFF_CREDENTIALS_SET', account.id, account.facilityId || '', info, 'Password set and authenticator enrolled after accepting the invitation');
    return { totpEnrolment: { otpauthUri, qrSvg: generateQrSvg(otpauthUri, { label: 'Authenticator enrolment QR code' }) } };
  }

  private adminFacility(admin: UserAccount, requested?: unknown): SeedFacility {
    const id = admin.role === 'PLATFORM_ADMIN' ? String(requested || '') : admin.facilityId;
    const f = id ? this.facility(id) : undefined;
    if (!f || (admin.role !== 'PLATFORM_ADMIN' && admin.role !== 'FACILITY_ADMIN')) throw new AuthError(403, 'Facility admins only');
    if (!this.isVerified(f.id)) throw new AuthError(403, 'This facility is not verified yet');
    return f;
  }

  /** A facility admin invites staff. Clinicians get a link to register with their licence; others get an account. */
  async inviteStaff(admin: UserAccount, body: any, baseUrl: string, info: RequestInfo) {
    const f = this.adminFacility(admin, body.facilityId);
    const role = String(body.role || '').toUpperCase();
    const name = text(body.name, 120);
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    if (name.length < 3 || !email || !phone) throw new AuthError(400, 'Give the name, email and phone (international format)');
    if (role === 'CLINICIAN') {
      // Clinicians register themselves with their licence; the admin then approves them (Phase 12).
      const link = `${baseUrl}/clinicians#register=${encodeURIComponent(f.registryCode || f.id)}`;
      await this.deps.dispatcher.sendSms(phone, { template: 'staff_invite', vars: { facility: f.name, link } });
      await this.deps.dispatcher.sendEmail(email, `Register as a clinician at ${f.name}`, `Register on Medistry with your licence: ${link}. ${f.name} will then approve your account.`);
      this.audit('STAFF_INVITED', admin.id, f.id, info, 'Clinician invited to register with their licence');
      return { role, sent: true, next: 'The clinician registers with their licence; approve them under Staff once they appear as PENDING.' };
    }
    const allowed = STAFF_ROLES[f.kind || 'HOSPITAL'];
    if (!allowed.includes(role as AccountRole)) throw new AuthError(400, `role must be CLINICIAN or one of ${allowed.join(', ')} for this facility`);
    if (this.deps.accounts.byEmailAddress(email) || this.deps.accounts.byPhoneNumber(phone)) throw new AuthError(409, 'This email or phone already belongs to an account');
    const prefix = role === 'FACILITY_ADMIN' ? 'admin' : role === 'RECORDS_OFFICER' ? 'records' : role.toLowerCase();
    const account = this.deps.accounts.create({ id: `${prefix}-${crypto.randomUUID()}`, role: role as AccountRole, countryCode: f.countryCode, facilityId: f.id, displayName: name });
    this.deps.accounts.setPhone(account, phone);
    this.deps.accounts.setEmail(account, email);
    const invite = await this.sendInvite(account, f, admin.id, baseUrl, info);
    return { role, accountId: account.id, sent: true, inviteExpiresAt: invite.expiresAt };
  }

  /** Staff of the facility: clinicians (with verification status) and staff accounts. Names and roles only. */
  listStaff(admin: UserAccount, facilityId?: unknown) {
    const f = this.adminFacility(admin, facilityId);
    return {
      clinicians: this.deps.clinicians.filter((c) => c.facilityId === f.id).map((c) => ({ id: c.id, fullName: c.fullName, specialty: c.specialty, licenseNumber: c.licenseNumber, status: c.status })),
      staff: this.deps.accounts.all().filter((a) => a.facilityId === f.id && a.role !== 'PATIENT' && a.role !== 'PROXY')
        .map((a) => ({ id: a.id, role: a.role, name: a.displayName || null, disabled: !!a.disabled, invited: !a.passwordHash && !a.lastSignInAt })),
    };
  }

  private target(admin: UserAccount, id: string): { kind: 'clinician'; c: SeedClinician; f: SeedFacility } | { kind: 'account'; a: UserAccount; f: SeedFacility } {
    const c = this.deps.clinicians.find((x) => x.id === id);
    if (c) return { kind: 'clinician', c, f: this.checkSame(admin, c.facilityId) };
    const a = this.deps.accounts.get(id);
    if (!a || !a.facilityId || ['PATIENT', 'PROXY', 'PLATFORM_ADMIN'].includes(a.role)) throw new AuthError(404, 'Staff member not found');
    return { kind: 'account', a, f: this.checkSame(admin, a.facilityId) };
  }

  private checkSame(admin: UserAccount, facilityId: string): SeedFacility {
    if (admin.role !== 'PLATFORM_ADMIN' && admin.facilityId !== facilityId) throw new AuthError(404, 'Staff member not found');
    return this.adminFacility(admin, facilityId);
  }

  /** Suspend or reinstate. Suspended staff cannot sign in and their sessions end at once. */
  setSuspended(admin: UserAccount, id: string, suspended: boolean, reason: unknown, info: RequestInfo) {
    const t = this.target(admin, id);
    if (t.kind === 'account' && t.a.id === admin.id) throw new AuthError(400, 'You cannot suspend yourself');
    const why = text(reason, 200);
    if (suspended && why.length < 5) throw new AuthError(400, 'Give a reason for the suspension');
    if (t.kind === 'clinician') {
      if (suspended && t.c.status !== 'VERIFIED' && t.c.status !== 'PENDING') throw new AuthError(409, `This clinician is ${t.c.status}`);
      if (!suspended && t.c.status !== 'SUSPENDED') throw new AuthError(409, 'This clinician is not suspended');
      t.c.status = suspended ? 'SUSPENDED' : 'VERIFIED';
      this.persistence?.saveClinician(t.c);
      const account = this.deps.accounts.get(t.c.userId);
      if (account && suspended) this.deps.accounts.revokeSessions(account);
    } else {
      if (suspended && t.a.role === 'FACILITY_ADMIN' && this.activeAdmins(t.f.id).length <= 1) throw new AuthError(409, 'A facility must keep at least one active facility admin');
      t.a.disabled = suspended || undefined;
      if (suspended) this.deps.accounts.revokeSessions(t.a);
      this.deps.accounts.save(t.a);
    }
    this.audit(suspended ? 'STAFF_SUSPENDED' : 'STAFF_REINSTATED', admin.id, t.f.id, info, `${t.kind === 'clinician' ? `Clinician ${t.c.id}` : `${t.a.role} ${t.a.id}`} ${suspended ? `suspended: ${why}` : 'reinstated'}`);
    return { id, suspended };
  }

  private activeAdmins(facilityId: string): UserAccount[] {
    return this.deps.accounts.all().filter((a) => a.role === 'FACILITY_ADMIN' && a.facilityId === facilityId && !a.disabled);
  }

  /** Reassign a staff account's role (non-clinical roles of this facility kind). Sessions restart. */
  changeRole(admin: UserAccount, id: string, roleInput: unknown, info: RequestInfo) {
    const t = this.target(admin, id);
    if (t.kind === 'clinician') throw new AuthError(400, 'A clinician\'s role comes from their licence; it cannot be reassigned');
    if (t.a.id === admin.id) throw new AuthError(400, 'You cannot change your own role');
    const role = String(roleInput || '').toUpperCase() as AccountRole;
    const allowed = STAFF_ROLES[t.f.kind || 'HOSPITAL'];
    if (!allowed.includes(role)) throw new AuthError(400, `role must be one of ${allowed.join(', ')}`);
    if (t.a.role === 'FACILITY_ADMIN' && role !== 'FACILITY_ADMIN' && this.activeAdmins(t.f.id).length <= 1) throw new AuthError(409, 'A facility must keep at least one active facility admin');
    const from = t.a.role;
    t.a.role = role;
    this.deps.accounts.revokeSessions(t.a);
    this.audit('STAFF_ROLE_CHANGED', admin.id, t.f.id, info, `Account ${t.a.id} role changed from ${from} to ${role}`);
    return { id, role };
  }
}
