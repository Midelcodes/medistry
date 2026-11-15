/**
 * Guardian and proxy access (children, elderly or incapacitated patients).
 *
 * A proxy acts under their own identity: every audit entry of a proxy's request names the proxy and the patient
 * (audit/actingContext.ts). Scopes: view (read the record, card, access log, consents), manage-card (card
 * content, reissue, revoke), approve-consent (approve, reject or revoke consent; disputes; record flags).
 * No scope allows editing clinical content (the Phase 6 rule; enforced again in policy/enforcer.ts).
 *
 * Minors: a facility admin records the parent or guardian after an in-person check (establishGuardian). The
 * guardian manages the account; the minor's own sign-in (if linked) can only view. On the patient's 18th
 * birthday (computed from the encrypted date of birth) the guardian's control ends and the patient is notified.
 */
import crypto from 'node:crypto';
import { decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { ProxyActing } from '../audit/actingContext.ts';
import { AccountStore, normalizePhone, type UserAccount } from './accounts.ts';
import { AuthError, type RequestInfo } from './patientAuth.ts';
import { deploymentCountry } from '../security/config.ts';

export const PROXY_RELATIONSHIPS = ['parent', 'guardian', 'caregiver', 'spouse', 'other'] as const;
export const PROXY_SCOPES = ['view', 'manage-card', 'approve-consent'] as const;
export type ProxyRelationshipKind = typeof PROXY_RELATIONSHIPS[number];
export type ProxyScope = typeof PROXY_SCOPES[number];
// The age at which a guardian's control ends, as specified for this product. Jurisdictions differ; review per country.
export const AGE_OF_MAJORITY = 18;

export interface ProxyRelationship {
  id: string;
  patientId: string;
  proxyUserId: string;
  relationship: ProxyRelationshipKind;
  scopes: ProxyScope[];
  validFrom: string;
  validUntil?: string;
  verifiedBy?: string;          // admin who checked a guardian's authority in person
  status: 'INVITED' | 'ACTIVE' | 'DECLINED' | 'REVOKED' | 'ENDED';
  managesMinorAccount: boolean; // guardian of a minor: account manager until AGE_OF_MAJORITY
  createdAt: string;
  endedAt?: string;
  endReason?: string;
}

export interface ProxyRepo { saveProxyRelationship(r: ProxyRelationship): void }

/** The date (UTC) the patient turns AGE_OF_MAJORITY. A 29 February birthday rolls to 1 March. */
export function majorityDate(patient: PatientEntity): Date {
  const [y, m, d] = decryptPatientDemographics(patient).dateOfBirth.split('-').map(Number);
  return new Date(Date.UTC(y + AGE_OF_MAJORITY, m - 1, d));
}

export function isMinor(patient: PatientEntity, now = Date.now()): boolean {
  return now < majorityDate(patient).getTime();
}

export class ProxyService {
  private relationships = new Map<string, ProxyRelationship>();
  private deps: { accounts: AccountStore; auditManager: AuditChainManager; dispatcher: NotificationDispatcher; patientsById: Map<string, PatientEntity> };
  persistence?: ProxyRepo;

  constructor(deps: ProxyService['deps']) {
    this.deps = deps;
  }

  hydrate(rows: ProxyRelationship[]): void {
    for (const r of rows) this.relationships.set(r.id, r);
  }

  private save(r: ProxyRelationship): void {
    this.persistence?.saveProxyRelationship(r);
  }

  private audit(action: string, actorId: string, patientId: string, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({ actorId, subjectId: patientId, action, accessType: 'SYSTEM_ADMIN', ipAddress: info.ipAddress, userAgent: info.userAgent, reason });
  }

  forPatient(patientId: string): ProxyRelationship[] {
    return [...this.relationships.values()].filter((r) => r.patientId === patientId);
  }

  forProxy(userId: string): ProxyRelationship[] {
    return [...this.relationships.values()].filter((r) => r.proxyUserId === userId);
  }

  get(id: string): ProxyRelationship | undefined {
    return this.relationships.get(id);
  }

  /** The active guardian who manages a minor's account, if any. */
  manager(patientId: string, now = Date.now()): ProxyRelationship | undefined {
    this.enforceExpiry(now);
    return this.forPatient(patientId).find((r) => r.status === 'ACTIVE' && r.managesMinorAccount);
  }

  private accountForPhone(phoneInput: unknown): UserAccount {
    const phone = normalizePhone(phoneInput);
    if (!phone) throw new AuthError(400, 'Give the phone number in international format, for example +234 800 000 0000');
    let account = this.deps.accounts.byPhoneNumber(phone);
    if (account && account.role !== 'PATIENT' && account.role !== 'PROXY') throw new AuthError(409, 'This number belongs to a staff account');
    if (!account) {
      account = this.deps.accounts.create({ id: crypto.randomUUID(), role: 'PROXY', countryCode: deploymentCountry() });
      this.deps.accounts.setPhone(account, phone);
    }
    return account;
  }

  private parse(body: any): { relationship: ProxyRelationshipKind; scopes: ProxyScope[]; validUntil?: string } {
    if (!PROXY_RELATIONSHIPS.includes(body.relationship)) throw new AuthError(400, `relationship must be one of ${PROXY_RELATIONSHIPS.join(', ')}`);
    const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
    if (!scopes.length || !scopes.every((s) => PROXY_SCOPES.includes(s as ProxyScope))) throw new AuthError(400, `scopes must be one or more of ${PROXY_SCOPES.join(', ')}`);
    let validUntil: string | undefined;
    if (body.validUntil) {
      const t = Date.parse(String(body.validUntil));
      if (Number.isNaN(t) || t <= Date.now()) throw new AuthError(400, 'validUntil must be a future date');
      validUntil = new Date(t).toISOString();
    }
    return { relationship: body.relationship, scopes: scopes as ProxyScope[], validUntil };
  }

  /** The patient (or, for a minor, the managing guardian) invites someone to act for them. */
  async invite(patient: PatientEntity, by: UserAccount, body: any, info: RequestInfo, now = Date.now()): Promise<ProxyRelationship> {
    const manager = this.manager(patient.id, now);
    const allowed = manager ? manager.proxyUserId === by.id : by.patientId === patient.id;
    if (!allowed) throw new AuthError(403, manager ? 'A guardian manages this account; only they can invite proxies' : 'Only the patient can invite a proxy');
    const { relationship, scopes, validUntil } = this.parse(body);
    const invitee = this.accountForPhone(body.phone);
    if (invitee.id === by.id || invitee.patientId === patient.id) throw new AuthError(400, 'You cannot invite yourself');
    if (this.forPatient(patient.id).some((r) => r.proxyUserId === invitee.id && (r.status === 'INVITED' || r.status === 'ACTIVE'))) {
      throw new AuthError(409, 'This person already has, or has been invited to, proxy access');
    }
    const r: ProxyRelationship = {
      id: crypto.randomUUID(), patientId: patient.id, proxyUserId: invitee.id, relationship, scopes,
      validFrom: new Date(now).toISOString(), ...(validUntil ? { validUntil } : {}), status: 'INVITED', managesMinorAccount: false, createdAt: new Date(now).toISOString(),
    };
    this.relationships.set(r.id, r);
    this.save(r);
    this.audit('PROXY_INVITED', by.id, patient.id, info, `Proxy ${invitee.id} invited as ${relationship} with scopes ${scopes.join(', ')}`);
    const phone = this.deps.accounts.phoneOf(invitee);
    if (phone) await this.deps.dispatcher.sendSms(phone, { template: 'proxy_invite', locale: patient.preferredLocale });
    return r;
  }

  /** The invitee accepts or declines. */
  respond(by: UserAccount, relationshipId: string, accept: boolean, info: RequestInfo, now = Date.now()): ProxyRelationship {
    const r = this.relationships.get(relationshipId);
    if (!r || r.proxyUserId !== by.id) throw new AuthError(404, 'Invitation not found');
    if (r.status !== 'INVITED') throw new AuthError(409, `This invitation is ${r.status.toLowerCase()}`);
    r.status = accept ? 'ACTIVE' : 'DECLINED';
    if (accept) r.validFrom = new Date(now).toISOString();
    this.save(r);
    this.audit(accept ? 'PROXY_ACCEPTED' : 'PROXY_DECLINED', by.id, r.patientId, info, `Proxy ${by.id} ${accept ? 'accepted' : 'declined'} the invitation (${r.relationship})`);
    void this.deps.dispatcher.notifyUser(r.patientId, 'Proxy access', `Your invited ${r.relationship} ${accept ? 'accepted' : 'declined'} proxy access.`);
    return r;
  }

  /** Ends a relationship: by the patient, the minor's manager, or the proxy themself. */
  revoke(by: UserAccount, relationshipId: string, info: RequestInfo, now = Date.now()): ProxyRelationship {
    const r = this.relationships.get(relationshipId);
    if (!r) throw new AuthError(404, 'Proxy relationship not found');
    const manager = this.manager(r.patientId, now);
    const isOwner = manager ? manager.proxyUserId === by.id && manager.id !== r.id : by.patientId === r.patientId;
    if (!isOwner && r.proxyUserId !== by.id) throw new AuthError(403, 'You cannot end this proxy relationship');
    if (r.status !== 'ACTIVE' && r.status !== 'INVITED') throw new AuthError(409, `This relationship is already ${r.status.toLowerCase()}`);
    this.end(r, 'REVOKED', r.proxyUserId === by.id ? 'Ended by the proxy' : 'Revoked by the account holder', now);
    this.audit('PROXY_REVOKED', by.id, r.patientId, info, `Proxy ${r.proxyUserId} (${r.relationship}) access revoked`);
    return r;
  }

  /** A facility or platform admin records a minor's parent or guardian after checking their authority in person. */
  async establishGuardian(patient: PatientEntity, body: any, admin: UserAccount, info: RequestInfo, now = Date.now()): Promise<ProxyRelationship> {
    if (body.relationship !== 'parent' && body.relationship !== 'guardian') throw new AuthError(400, 'relationship must be parent or guardian');
    if (!isMinor(patient, now)) throw new AuthError(400, `The patient is ${AGE_OF_MAJORITY} or older and manages their own account`);
    if (this.manager(patient.id, now)) throw new AuthError(409, 'This minor already has a managing guardian');
    const guardian = this.accountForPhone(body.phone);
    const r: ProxyRelationship = {
      id: crypto.randomUUID(), patientId: patient.id, proxyUserId: guardian.id, relationship: body.relationship, scopes: [...PROXY_SCOPES],
      validFrom: new Date(now).toISOString(), validUntil: majorityDate(patient).toISOString(), verifiedBy: admin.id,
      status: 'ACTIVE', managesMinorAccount: true, createdAt: new Date(now).toISOString(),
    };
    this.relationships.set(r.id, r);
    this.save(r);
    this.audit('GUARDIAN_ESTABLISHED', admin.id, patient.id, info, `Guardian ${guardian.id} (${r.relationship}) verified by ${admin.role}; manages the account until the patient turns ${AGE_OF_MAJORITY}`);
    const phone = this.deps.accounts.phoneOf(guardian);
    if (phone) await this.deps.dispatcher.sendSms(phone, { template: 'guardian_added', locale: patient.preferredLocale });
    return r;
  }

  private end(r: ProxyRelationship, status: 'REVOKED' | 'ENDED', reason: string, now: number): void {
    r.status = status;
    r.endedAt = new Date(now).toISOString();
    r.endReason = reason;
    this.save(r);
  }

  /**
   * Ends relationships whose validUntil has passed. For a minor's guardian this is the 18th birthday: control
   * passes to the patient, and both are told. Called on every authorisation and by the daily sweep.
   */
  enforceExpiry(now = Date.now()): ProxyRelationship[] {
    const ended: ProxyRelationship[] = [];
    for (const r of this.relationships.values()) {
      if ((r.status !== 'ACTIVE' && r.status !== 'INVITED') || !r.validUntil || Date.parse(r.validUntil) > now) continue;
      const system = { ipAddress: '127.0.0.1', userAgent: 'Medistry/scheduler' };
      if (r.managesMinorAccount) {
        this.end(r, 'ENDED', `Patient turned ${AGE_OF_MAJORITY}`, now);
        this.audit('GUARDIAN_CONTROL_ENDED', 'system', r.patientId, system, `Patient turned ${AGE_OF_MAJORITY}: guardian ${r.proxyUserId} no longer manages the account; control passed to the patient`);
        const guardian = this.deps.accounts.get(r.proxyUserId);
        const guardianPhone = guardian ? this.deps.accounts.phoneOf(guardian) : undefined;
        const locale = this.deps.patientsById.get(r.patientId)?.preferredLocale;
        if (guardianPhone) void this.deps.dispatcher.sendSms(guardianPhone, { template: 'guardian_ended', locale, vars: { age: AGE_OF_MAJORITY } });
        const own = this.deps.accounts.byPatient(r.patientId);
        const ownPhone = own ? this.deps.accounts.phoneOf(own) : undefined;
        const note = `You have turned ${AGE_OF_MAJORITY}: you now control your own Medistry record. Your guardian's access has ended. You can invite them back as a proxy if you wish.`;
        if (ownPhone) void this.deps.dispatcher.sendSms(ownPhone, { template: 'majority_patient', locale, vars: { age: AGE_OF_MAJORITY } });
        void this.deps.dispatcher.notifyUser(r.patientId, 'You now control your record', note);
      } else {
        this.end(r, 'ENDED', 'Validity period ended', now);
        this.audit('PROXY_EXPIRED', 'system', r.patientId, system, `Proxy ${r.proxyUserId} (${r.relationship}) access reached its end date`);
      }
      ended.push(r);
    }
    return ended;
  }

  /**
   * Can this signed-in account do `scope` on this patient's record? Returns the acting context for a proxy
   * (null for the patient themself) or throws 403.
   */
  authorize(account: UserAccount, patient: PatientEntity, scope: ProxyScope, now = Date.now()): ProxyActing | null {
    this.enforceExpiry(now);
    if (account.patientId === patient.id) {
      const manager = this.manager(patient.id, now);
      if (manager && scope !== 'view') {
        throw new AuthError(403, `Your guardian manages this account until ${manager.validUntil!.slice(0, 10)}. You can view your record.`);
      }
      return null;
    }
    const r = this.forPatient(patient.id).find((x) => x.proxyUserId === account.id && x.status === 'ACTIVE' && Date.parse(x.validFrom) <= now);
    if (!r) throw new AuthError(403, 'You do not have access to this patient record');
    if (!r.scopes.includes(scope)) throw new AuthError(403, `Your proxy access does not include "${scope}"`);
    return { proxyUserId: account.id, patientId: patient.id, relationship: r.relationship, relationshipId: r.id };
  }

  /** Patients this account can open: their own record and every active proxy relationship. */
  accessibleFor(account: UserAccount): Array<{ patientId: string; as: 'self' | ProxyRelationshipKind; scopes: ProxyScope[]; managesMinorAccount: boolean; validUntil?: string }> {
    this.enforceExpiry();
    const out: ReturnType<ProxyService['accessibleFor']> = [];
    if (account.patientId) {
      out.push({ patientId: account.patientId, as: 'self', scopes: this.manager(account.patientId) ? ['view'] : [...PROXY_SCOPES], managesMinorAccount: false });
    }
    for (const r of this.forProxy(account.id)) {
      if (r.status === 'ACTIVE') out.push({ patientId: r.patientId, as: r.relationship, scopes: r.scopes, managesMinorAccount: r.managesMinorAccount, validUntil: r.validUntil });
    }
    return out;
  }
}
