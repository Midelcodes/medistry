/**
 * User accounts: the credentials behind every sign-in (patients, proxies, clinicians, admins).
 *
 * Phone numbers and emails are stored twice, never in plain text: a keyed hash (HMAC-SHA256) for lookup and an
 * AES-256-GCM ciphertext (encryptField) so messages can be sent. Passwords are scrypt hashes; TOTP secrets are
 * encrypted. Failed sign-ins lock the account after MAX_FAILED_SIGN_INS for LOCKOUT_MS.
 */
import crypto from 'node:crypto';
import { encryptField, decryptField } from '../patient/profile.ts';
import { keyProvider } from '../crypto/keyProvider.ts';

// RECORDS_OFFICER (Phase 16): registers patients and reviews duplicates for one facility; signs in like admins.
// PHARMACIST (Phase 17): staff of a PHARMACY facility; signs in like admins, uses /api/pharmacy only.
// NURSE (Phase 18): staff account created by invitation; nurse workflows are not built yet (sign-in only).
export type AccountRole = 'PATIENT' | 'PROXY' | 'DOCTOR' | 'FACILITY_ADMIN' | 'PLATFORM_ADMIN' | 'RECORDS_OFFICER' | 'PHARMACIST' | 'NURSE';

export interface UserAccount {
  id: string;                 // User id
  role: AccountRole;          // PATIENT: linked to a patient record; PROXY: a portal user who only acts for others
  countryCode: string;
  displayName?: string;       // admins only (clinician and patient names live on their own records)
  facilityId?: string;        // FACILITY_ADMIN / RECORDS_OFFICER: their facility
  patientId?: string;         // PATIENT: the linked patient record (persisted as Patient.userId)
  phoneHash?: string;
  encryptedPhone?: string;
  emailHash?: string;
  encryptedEmail?: string;
  passwordHash?: string;
  encryptedTotpSecret?: string;
  totpEnabled: boolean;       // false until the first successful sign-in with the enrolled authenticator
  failedSignIns: number;
  lockedUntil?: string;
  sessionsNotBefore?: string; // tokens issued earlier are refused
  lastSignInAt?: string;
  createdAt: string;
  // USSD (Phase 13): 4-digit PIN set in the app, scrypt hash; locked after 3 wrong PINs until reset in the app.
  ussdPinHash?: string;
  ussdPinFailures?: number;
  ussdLocked?: boolean;
  // Staff suspended by their facility admin (Phase 18): cannot sign in; existing sessions are revoked.
  disabled?: boolean;
}

export interface AccountRepo { saveUserAccount(a: UserAccount): void }

export const MAX_FAILED_SIGN_INS = 5;
// EMERGENCY_LOCKOUT_SECONDS was the clinician sign-in lockout before Phase 12; it still applies if set.
export const LOCKOUT_MS = Math.max(60, parseInt(process.env.ACCOUNT_LOCKOUT_SECONDS || process.env.EMERGENCY_LOCKOUT_SECONDS || '3600', 10) || 3600) * 1000;

/**
 * E.164 form: "+", country code, subscriber number, 8 to 15 digits in all. Spaces, dashes, dots and brackets
 * are removed. No country-specific numbering rules are applied.
 */
export function normalizePhone(input: unknown): string | null {
  const s = String(input ?? '').replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export function normalizeEmail(input: unknown): string | null {
  const s = String(input ?? '').trim().toLowerCase();
  return s.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Shows enough of a phone number to recognise it: +234•••••0001. */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 4)}${'•'.repeat(phone.length - 8)}${phone.slice(-4)}` : '••••';
}

/**
 * Keyed lookup hash for a phone number or email, keyed with a field key version (default: the current one).
 * During a field key rotation stored hashes may still use an older version, so lookups try every version
 * (identifierHashes); scripts/rotate-field-key.ts rewrites them to the current version.
 */
export function identifierHash(kind: 'phone' | 'email', value: string, version?: number): string {
  const { key } = keyProvider().getFieldEncryptionKey(version);
  return crypto.createHmac('sha256', key).update(`medistry-${kind}:${value}`).digest('hex');
}

/** The lookup hash under every readable key version, current first. */
export function identifierHashes(kind: 'phone' | 'email', value: string): string[] {
  return keyProvider().getFieldKeyVersions().map((v) => identifierHash(kind, value, v));
}

export class AccountStore {
  private byId = new Map<string, UserAccount>();
  private byPhone = new Map<string, string>();
  private byEmail = new Map<string, string>();
  persistence?: AccountRepo;

  hydrate(accounts: UserAccount[]): void {
    for (const a of accounts) this.index(a);
  }

  private index(a: UserAccount): void {
    this.byId.set(a.id, a);
    if (a.phoneHash) this.byPhone.set(a.phoneHash, a.id);
    if (a.emailHash) this.byEmail.set(a.emailHash, a.id);
  }

  get(id: string): UserAccount | undefined {
    return this.byId.get(id);
  }

  all(): UserAccount[] {
    return [...this.byId.values()];
  }

  private lookup(index: Map<string, string>, kind: 'phone' | 'email', value: string): string | undefined {
    for (const h of identifierHashes(kind, value)) {
      const id = index.get(h);
      if (id) return id;
    }
    return undefined;
  }

  byPhoneNumber(phone: string): UserAccount | undefined {
    const id = this.lookup(this.byPhone, 'phone', phone);
    return id ? this.byId.get(id) : undefined;
  }

  byEmailAddress(email: string): UserAccount | undefined {
    const id = this.lookup(this.byEmail, 'email', email);
    return id ? this.byId.get(id) : undefined;
  }

  byPatient(patientId: string): UserAccount | undefined {
    for (const a of this.byId.values()) if (a.patientId === patientId) return a;
    return undefined;
  }

  create(fields: Omit<UserAccount, 'createdAt' | 'failedSignIns' | 'totpEnabled'> & Partial<Pick<UserAccount, 'totpEnabled'>>): UserAccount {
    if (this.byId.has(fields.id)) throw new Error('Account already exists');
    const account: UserAccount = { totpEnabled: false, ...fields, failedSignIns: 0, createdAt: new Date().toISOString() };
    this.index(account);
    this.save(account);
    return account;
  }

  save(a: UserAccount): void {
    this.persistence?.saveUserAccount(a);
  }

  setPhone(a: UserAccount, phone: string): void {
    const hash = identifierHash('phone', phone);
    const owner = this.lookup(this.byPhone, 'phone', phone);
    if (owner && owner !== a.id) throw new Error('This phone number belongs to another account');
    if (a.phoneHash) this.byPhone.delete(a.phoneHash);
    a.phoneHash = hash;
    a.encryptedPhone = encryptField(phone);
    this.byPhone.set(hash, a.id);
    this.save(a);
  }

  setEmail(a: UserAccount, email: string): void {
    const hash = identifierHash('email', email);
    const owner = this.lookup(this.byEmail, 'email', email);
    if (owner && owner !== a.id) throw new Error('This email address belongs to another account');
    if (a.emailHash) this.byEmail.delete(a.emailHash);
    a.emailHash = hash;
    a.encryptedEmail = encryptField(email);
    this.byEmail.set(hash, a.id);
    this.save(a);
  }

  phoneOf(a: UserAccount): string | undefined {
    return a.encryptedPhone ? decryptField(a.encryptedPhone) : undefined;
  }

  emailOf(a: UserAccount): string | undefined {
    return a.encryptedEmail ? decryptField(a.encryptedEmail) : undefined;
  }

  /** Throws a lockout message if the account is locked. */
  assertNotLocked(a: UserAccount, now = Date.now()): void {
    if (a.lockedUntil && Date.parse(a.lockedUntil) > now) {
      throw Object.assign(new Error(`Too many failed attempts. Try again in ${Math.ceil((Date.parse(a.lockedUntil) - now) / 60000)} minutes.`), { status: 429 });
    }
  }

  recordFailure(a: UserAccount, now = Date.now()): { locked: boolean } {
    a.failedSignIns += 1;
    let locked = false;
    if (a.failedSignIns >= MAX_FAILED_SIGN_INS) {
      a.lockedUntil = new Date(now + LOCKOUT_MS).toISOString();
      a.failedSignIns = 0;
      locked = true;
    }
    this.save(a);
    return { locked };
  }

  recordSuccess(a: UserAccount, now = Date.now()): void {
    a.failedSignIns = 0;
    a.lockedUntil = undefined;
    a.lastSignInAt = new Date(now).toISOString();
    this.save(a);
  }

  /** Voids every session issued before now. */
  revokeSessions(a: UserAccount, now = Date.now()): void {
    a.sessionsNotBefore = new Date(now).toISOString();
    this.save(a);
  }
}
