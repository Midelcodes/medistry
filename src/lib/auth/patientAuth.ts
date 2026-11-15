/**
 * Phone-first sign-in for patients and proxies, with an optional email for account recovery.
 *
 *   sign-in   6-digit code by SMS -> verify -> session. A first sign-in creates a proxy-only account; a facility
 *             admin links a phone number to a patient record (linkPatient) so its owner can sign in to it.
 *   recovery  code to the recovery email, then a second code to the new phone number (re-verification). The
 *             phone number is replaced and every existing session is revoked.
 *
 * Codes: only HMAC-SHA256(server key, challenge id + code) is kept (never the code), valid OTP_TTL_MS, at most
 * MAX_OTP_ATTEMPTS tries per code. Requests are rate limited per phone number (or email) and per IP address.
 * Every sign-in, recovery, lockout and session revocation writes an audit entry (no phone numbers or emails).
 */
import crypto from 'node:crypto';
import { encryptField, decryptField, type PatientEntity } from '../patient/profile.ts';
import { SlidingWindowRateLimiter } from '../security/rateLimiter.ts';
import { deploymentCountry } from '../security/config.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { PatientRepo } from '../data/repositories.ts';
import { AccountStore, identifierHash, maskPhone, normalizeEmail, normalizePhone, type UserAccount } from './accounts.ts';

export const OTP_TTL_MS = 5 * 60_000;
export const MAX_OTP_ATTEMPTS = 5;
// Request budgets. Operational choices, not regulatory values: tune per deployment.
const PER_DESTINATION = { windowMs: 15 * 60_000, maxRequests: parseInt(process.env.OTP_MAX_PER_PHONE || '3', 10) || 3 };
const PER_IP = { windowMs: 15 * 60_000, maxRequests: parseInt(process.env.OTP_MAX_PER_IP || '10', 10) || 10 };
const VERIFY_PER_IP = { windowMs: 60_000, maxRequests: 20 };

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Purpose = 'sign-in' | 'recovery-email-setup' | 'recovery' | 'recovery-new-phone';

interface OtpChallenge {
  id: string;
  purpose: Purpose;
  destinationHash: string; // phone or email lookup hash
  otpHash: string;         // HMAC of challenge id + code; the code itself is never kept
  expiresAt: number;
  attempts: number;
  accountId?: string;
  encryptedPending?: string; // the email being added, or the new phone number during recovery
}

export interface RequestInfo { ipAddress: string; userAgent: string }

export class PatientAuthService {
  private challenges = new Map<string, OtpChallenge>();
  private destinationLimiter = new SlidingWindowRateLimiter(PER_DESTINATION);
  private ipLimiter = new SlidingWindowRateLimiter(PER_IP);
  private verifyLimiter = new SlidingWindowRateLimiter(VERIFY_PER_IP);
  private deps: { accounts: AccountStore; dispatcher: NotificationDispatcher; auditManager: AuditChainManager; serverKey: string };
  /** Write-through repository (no-op in memory storage). */
  persistence?: PatientRepo;

  constructor(deps: PatientAuthService['deps']) {
    this.deps = deps;
  }

  // ---------- codes ----------
  private otpHash(challengeId: string, otp: string): string {
    return crypto.createHmac('sha256', this.deps.serverKey).update(`otp:${challengeId}:${otp}`).digest('hex');
  }

  private limit(destinationHash: string, info: RequestInfo): void {
    if (!this.ipLimiter.check(info.ipAddress).allowed || !this.destinationLimiter.check(destinationHash).allowed) {
      throw new AuthError(429, 'Too many codes requested. Wait 15 minutes and try again.');
    }
  }

  private createChallenge(purpose: Purpose, destinationHash: string, extra: Partial<OtpChallenge> = {}, now = Date.now()): { challenge: OtpChallenge; otp: string } {
    // One live code per destination and purpose: a new request replaces the old one.
    for (const [id, c] of this.challenges) {
      if ((c.destinationHash === destinationHash && c.purpose === purpose) || c.expiresAt <= now) this.challenges.delete(id);
    }
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const id = crypto.randomUUID();
    const challenge: OtpChallenge = { id, purpose, destinationHash, otpHash: this.otpHash(id, otp), expiresAt: now + OTP_TTL_MS, attempts: 0, ...extra };
    this.challenges.set(id, challenge);
    return { challenge, otp };
  }

  /** Checks a code. Wrong codes count towards MAX_OTP_ATTEMPTS; after that the code is dead. */
  private consume(purpose: Purpose, destinationHash: string, otp: unknown, info: RequestInfo, now = Date.now()): OtpChallenge {
    if (!this.verifyLimiter.check(info.ipAddress).allowed) throw new AuthError(429, 'Too many attempts from this network. Wait a minute and try again.');
    const challenge = [...this.challenges.values()].find((c) => c.purpose === purpose && c.destinationHash === destinationHash);
    if (!challenge) throw new AuthError(401, 'This code is not valid. Request a new code.');
    if (challenge.attempts >= MAX_OTP_ATTEMPTS) throw new AuthError(429, 'Too many wrong codes. Request a new code.');
    if (now > challenge.expiresAt) {
      this.challenges.delete(challenge.id);
      throw new AuthError(401, 'This code has expired. Request a new code.');
    }
    const given = Buffer.from(this.otpHash(challenge.id, String(otp ?? '').trim()), 'hex');
    const expected = Buffer.from(challenge.otpHash, 'hex');
    if (!crypto.timingSafeEqual(given, expected)) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
        this.audit('ONE_TIME_CODE_LOCKED', challenge.accountId ? this.deps.accounts.get(challenge.accountId) : undefined, info,
          `A ${purpose} code was locked after ${MAX_OTP_ATTEMPTS} wrong attempts`);
      }
      throw new AuthError(401, `Wrong code. ${Math.max(0, MAX_OTP_ATTEMPTS - challenge.attempts)} attempt(s) left.`);
    }
    this.challenges.delete(challenge.id);
    return challenge;
  }

  /** What is kept for each live code (for tests and operators): hashes only. */
  storedChallenges(): Array<Readonly<OtpChallenge>> {
    return [...this.challenges.values()].map((c) => ({ ...c }));
  }

  private audit(action: string, account: UserAccount | undefined, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({
      actorId: account?.id || 'anonymous',
      subjectId: account?.patientId,
      action,
      accessType: 'SYSTEM_ADMIN',
      ipAddress: info.ipAddress,
      userAgent: info.userAgent,
      reason,
    });
  }

  private async sms(phone: string, message: string, storedAs: string): Promise<void> {
    const sent = await this.deps.dispatcher.sendSms(phone, message, { storedAs });
    if (sent.status === 'FAILED') throw new AuthError(503, 'The code could not be sent. Try again in a few minutes.');
  }

  private codeText(otp: string, what: string): string {
    return `Your Medistry ${what} code is ${otp}. It expires in ${OTP_TTL_MS / 60_000} minutes. Never share it, not even with Medistry staff.`;
  }

  private phone(input: unknown): string {
    const phone = normalizePhone(input);
    if (!phone) throw new AuthError(400, 'Enter your phone number in international format, for example +234 800 000 0000.');
    return phone;
  }

  // ---------- sign-in ----------
  async requestSignInCode(phoneInput: unknown, info: RequestInfo): Promise<{ sent: true; expiresInSeconds: number }> {
    const phone = this.phone(phoneInput);
    const destinationHash = identifierHash('phone', phone);
    this.limit(destinationHash, info);
    const { otp } = this.createChallenge('sign-in', destinationHash);
    await this.sms(phone, this.codeText(otp, 'sign-in'), 'Medistry sign-in code (code not stored)');
    return { sent: true, expiresInSeconds: OTP_TTL_MS / 1000 };
  }

  /** Verifies the code; the first sign-in with a new number creates a proxy-only account. */
  verifySignInCode(phoneInput: unknown, otp: unknown, info: RequestInfo, now = Date.now()): UserAccount {
    const phone = this.phone(phoneInput);
    this.consume('sign-in', identifierHash('phone', phone), otp, info, now);
    let account = this.deps.accounts.byPhoneNumber(phone);
    if (account && account.role !== 'PATIENT' && account.role !== 'PROXY') {
      throw new AuthError(403, 'This number belongs to a staff account. Sign in on the clinician or admin console.');
    }
    if (!account) {
      account = this.deps.accounts.create({ id: crypto.randomUUID(), role: 'PROXY', countryCode: deploymentCountry() });
      this.deps.accounts.setPhone(account, phone);
    }
    this.deps.accounts.recordSuccess(account, now);
    this.audit(account.role === 'PATIENT' ? 'PATIENT_SIGNED_IN' : 'PROXY_SIGNED_IN', account, info, 'Signed in with a one-time code sent by SMS');
    return account;
  }

  // ---------- recovery email ----------
  async requestRecoveryEmailCode(account: UserAccount, emailInput: unknown, info: RequestInfo): Promise<{ sent: true }> {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AuthError(400, 'Enter a valid email address');
    const destinationHash = identifierHash('email', email);
    this.limit(destinationHash, info);
    const { otp } = this.createChallenge('recovery-email-setup', destinationHash, { accountId: account.id, encryptedPending: encryptField(email) });
    const sent = await this.deps.dispatcher.sendEmail(email, 'Confirm your Medistry recovery email', this.codeText(otp, 'email confirmation'), { storedAs: 'Recovery email confirmation code (code not stored)' });
    if (sent.status === 'FAILED') throw new AuthError(503, 'The code could not be sent. Try again in a few minutes.');
    return { sent: true };
  }

  confirmRecoveryEmail(account: UserAccount, emailInput: unknown, otp: unknown, info: RequestInfo): UserAccount {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AuthError(400, 'Enter a valid email address');
    const challenge = this.consume('recovery-email-setup', identifierHash('email', email), otp, info);
    if (challenge.accountId !== account.id) throw new AuthError(401, 'This code is not valid. Request a new code.');
    try {
      this.deps.accounts.setEmail(account, decryptField(challenge.encryptedPending!));
    } catch (err: any) {
      throw new AuthError(409, err.message);
    }
    this.audit('RECOVERY_EMAIL_ADDED', account, info, 'Recovery email confirmed with a one-time code');
    return account;
  }

  // ---------- recovery ----------
  /** Step 1: code to the recovery email. The answer is the same whether or not the email is known. */
  async requestRecovery(emailInput: unknown, newPhoneInput: unknown, info: RequestInfo): Promise<{ sent: true }> {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AuthError(400, 'Enter a valid email address');
    const newPhone = this.phone(newPhoneInput);
    const destinationHash = identifierHash('email', email);
    this.limit(destinationHash, info);
    const account = this.deps.accounts.byEmailAddress(email);
    if (account) {
      const { otp } = this.createChallenge('recovery', destinationHash, { accountId: account.id, encryptedPending: encryptField(newPhone) });
      await this.deps.dispatcher.sendEmail(email, 'Medistry account recovery', `${this.codeText(otp, 'account recovery')} If you did not ask to recover your account, ignore this email.`,
        { storedAs: 'Account recovery code (code not stored)' });
    }
    return { sent: true };
  }

  /** Step 2: the email code is right, so send a second code to the new phone number (re-verification). */
  async verifyRecoveryEmailCode(emailInput: unknown, otp: unknown, info: RequestInfo): Promise<{ next: 'verify-new-phone'; phone: string }> {
    const email = normalizeEmail(emailInput);
    if (!email) throw new AuthError(400, 'Enter a valid email address');
    const challenge = this.consume('recovery', identifierHash('email', email), otp, info);
    const newPhone = decryptField(challenge.encryptedPending!);
    const { otp: phoneOtp } = this.createChallenge('recovery-new-phone', identifierHash('phone', newPhone), { accountId: challenge.accountId });
    await this.sms(newPhone, this.codeText(phoneOtp, 'new phone confirmation'), 'Recovery phone confirmation code (code not stored)');
    return { next: 'verify-new-phone', phone: maskPhone(newPhone) };
  }

  /** Step 3: the new phone is confirmed. Replaces the phone number and revokes every existing session. */
  async completeRecovery(newPhoneInput: unknown, otp: unknown, info: RequestInfo, now = Date.now()): Promise<UserAccount> {
    const newPhone = this.phone(newPhoneInput);
    const challenge = this.consume('recovery-new-phone', identifierHash('phone', newPhone), otp, info, now);
    const account = this.deps.accounts.get(challenge.accountId || '');
    if (!account) throw new AuthError(401, 'This code is not valid. Request a new code.');
    const oldPhone = this.deps.accounts.phoneOf(account);
    try {
      this.deps.accounts.setPhone(account, newPhone);
    } catch (err: any) {
      throw new AuthError(409, err.message);
    }
    this.deps.accounts.revokeSessions(account, now);
    this.deps.accounts.recordSuccess(account, now);
    this.audit('ACCOUNT_RECOVERED', account, info, 'Account recovered: recovery email code and new phone number confirmed');
    this.audit('SESSIONS_REVOKED', account, info, 'All sessions revoked after account recovery');
    if (oldPhone && oldPhone !== newPhone) {
      await this.deps.dispatcher.sendSms(oldPhone, 'Your Medistry account was moved to a new phone number. If this was not you, contact your clinic now.');
    }
    return account;
  }

  // ---------- sessions ----------
  revokeAllSessions(account: UserAccount, info: RequestInfo, now = Date.now()): void {
    this.deps.accounts.revokeSessions(account, now);
    this.audit('SESSIONS_REVOKED', account, info, 'Signed out on every device');
  }

  recordSignOut(account: UserAccount, info: RequestInfo): void {
    this.audit('SESSION_REVOKED', account, info, 'Signed out on this device');
  }

  // ---------- linking a patient record ----------
  /**
   * Links a phone number to a patient record so its owner can sign in (done by a facility or platform admin
   * after checking identity in person). An existing proxy-only account with that number becomes the patient's.
   */
  linkPatient(patient: PatientEntity, phoneInput: unknown, info: RequestInfo & { adminId: string }): UserAccount {
    const phone = this.phone(phoneInput);
    const accounts = this.deps.accounts;
    const linked = accounts.byPatient(patient.id);
    const holder = accounts.byPhoneNumber(phone);
    let account: UserAccount;
    if (linked) {
      if (holder && holder.id !== linked.id) throw new AuthError(409, 'This phone number belongs to another account');
      accounts.setPhone(linked, phone);
      account = linked;
    } else if (holder) {
      if (holder.patientId) throw new AuthError(409, 'This phone number is already linked to another patient record');
      holder.role = 'PATIENT';
      holder.patientId = patient.id;
      accounts.save(holder);
      account = holder;
    } else {
      const id = accounts.get(patient.userId) ? crypto.randomUUID() : patient.userId;
      account = accounts.create({ id, role: 'PATIENT', countryCode: patient.countryCode || deploymentCountry(), patientId: patient.id });
      accounts.setPhone(account, phone);
    }
    if (patient.userId !== account.id) {
      patient.userId = account.id;
      this.persistence?.savePatient(patient);
    }
    this.deps.auditManager.appendEntry({
      actorId: info.adminId, subjectId: patient.id, action: 'PATIENT_ACCOUNT_LINKED', accessType: 'SYSTEM_ADMIN',
      ipAddress: info.ipAddress, userAgent: info.userAgent, reason: 'Phone sign-in linked to the patient record after an identity check',
    });
    return account;
  }
}
