/**
 * USSD channel for feature phones (Phase 13), in the Africa's Talking USSD callback format: the provider posts
 * sessionId, serviceCode, phoneNumber and text, where text is every answer so far joined by "*" ("1234*3*1").
 * Each reply starts with "CON " (more input expected) or "END " (session over) and stays within USSD_MAX_CHARS.
 *
 *   (PIN) -> 1 View my emergency summary (blood group, genotype, allergies only)
 *            2 Recent access to my record (last 3 events)
 *            3 Dispute last access        (confirm, then a dispute ticket)
 *            4 Lock my emergency card     (confirm, then revoke; reissue later in the app)
 *
 * Authentication: the calling number must be the sign-in phone of a patient account (linked to the record by a
 * facility admin after an identity check) AND the 4-digit USSD PIN the patient set in the app (scrypt hash). Three
 * wrong PINs lock USSD until the patient sets a new PIN in the app. The PIN travels in `text` on every step, so it
 * is checked on every step. Every USSD action writes an audit entry (never the phone number or the PIN).
 *
 * TODO: the USSD short code (USSD_SERVICE_CODE) must be provisioned with the provider and the telcos.
 */
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { PatientAccessLogManager } from '../audit/accessLogManager.ts';
import type { OfflineCardStore } from '../emergency/offlineCardStore.ts';
import type { PatientEntity } from '../patient/profile.ts';
import { AccountStore, normalizePhone, type UserAccount } from '../auth/accounts.ts';
import { AuthError, type RequestInfo } from '../auth/patientAuth.ts';
import { hashPassword, verifyPassword } from '../auth/security.ts';

export const USSD_MAX_CHARS = 182; // per screen, including the CON/END prefix
export const USSD_MAX_PIN_FAILURES = 3;

export interface UssdRequest { sessionId?: unknown; serviceCode?: unknown; phoneNumber?: unknown; text?: unknown }

/** One screen: "CON ..." or "END ...", cut to USSD_MAX_CHARS. */
export function screen(kind: 'CON' | 'END', body: string): string {
  const out = `${kind} ${body}`;
  return out.length <= USSD_MAX_CHARS ? out : `${out.slice(0, USSD_MAX_CHARS - 3)}...`;
}

const MENU = '1. My emergency summary\n2. Recent access to my record\n3. Dispute last access\n4. Lock my emergency card';
const bloodGroup = (b: string) => (b === 'UNKNOWN' ? 'not recorded' : b.replace('_POSITIVE', '+').replace('_NEGATIVE', '-'));
const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)}`;
};

export class UssdService {
  private deps: {
    accounts: AccountStore; patientsById: Map<string, PatientEntity>; auditManager: AuditChainManager;
    accessLogManager: PatientAccessLogManager; offlineCards: OfflineCardStore;
  };

  constructor(deps: UssdService['deps']) {
    this.deps = deps;
  }

  private audit(action: string, account: UserAccount | undefined, patient: PatientEntity | undefined, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({
      actorId: account?.id || 'anonymous', subjectId: patient?.id, action, accessType: 'NORMAL_CONSENT',
      ipAddress: info.ipAddress, userAgent: 'USSD', reason: `USSD: ${reason}`,
    });
  }

  /** The patient sets (or resets) their USSD PIN in the app. Resetting also lifts a lockout. */
  async setPin(account: UserAccount, pin: unknown, info: RequestInfo): Promise<void> {
    if (account.role !== 'PATIENT' || !account.patientId) throw new AuthError(403, 'Only a patient signed in to their own record can set a USSD PIN');
    const value = String(pin ?? '');
    if (!/^\d{4}$/.test(value)) throw new AuthError(400, 'The USSD PIN must be exactly 4 digits');
    if (/^(\d)\1{3}$/.test(value) || '0123456789'.includes(value) || '9876543210'.includes(value)) {
      throw new AuthError(400, 'Choose a less obvious PIN (not 1111, 1234 or similar)');
    }
    account.ussdPinHash = await hashPassword(value);
    account.ussdPinFailures = 0;
    account.ussdLocked = false;
    this.deps.accounts.save(account);
    this.audit('USSD_PIN_SET', account, this.deps.patientsById.get(account.patientId), info, 'USSD PIN set in the app');
  }

  /** Recent access by others (clinicians, scans), newest first: not the patient, their proxies or system events. */
  private accessEvents(patient: PatientEntity) {
    return this.deps.accessLogManager.getPatientAccessLog(patient.id).filter((e) => {
      if (e.accessType === 'SYSTEM_ADMIN' || e.actorId === patient.id || e.actorId === 'system' || e.actorId === 'anonymous') return false;
      const role = this.deps.accounts.get(e.actorId)?.role;
      return role !== 'PATIENT' && role !== 'PROXY';
    });
  }

  async handle(req: UssdRequest, info: RequestInfo): Promise<string> {
    const phone = normalizePhone(req.phoneNumber);
    const account = phone ? this.deps.accounts.byPhoneNumber(phone) : undefined;
    const patient = account?.role === 'PATIENT' && account.patientId ? this.deps.patientsById.get(account.patientId) : undefined;
    if (!account || !patient) {
      this.audit('USSD_UNKNOWN_NUMBER', undefined, undefined, info, 'Call from a number that is not linked to a patient record');
      return screen('END', 'This number is not linked to a Medistry record. Ask your clinic to link it.');
    }
    if (!account.ussdPinHash) {
      this.audit('USSD_NO_PIN', account, patient, info, 'USSD used before a PIN was set');
      return screen('END', 'Set a 4-digit USSD PIN in the Medistry app first.');
    }
    if (account.ussdLocked) {
      this.audit('USSD_LOCKED_ATTEMPT', account, patient, info, 'USSD used while locked');
      return screen('END', 'USSD access is locked after 3 wrong PINs. Set a new PIN in the Medistry app.');
    }

    const text = String(req.text ?? '').trim().slice(0, 100);
    const parts = text === '' ? [] : text.split('*');
    if (!parts.length) {
      this.audit('USSD_SESSION_STARTED', account, patient, info, 'Session started; PIN requested');
      return screen('CON', 'Medistry\nEnter your 4-digit PIN:');
    }

    const pinOk = /^\d{4}$/.test(parts[0]) && await verifyPassword(parts[0], account.ussdPinHash);
    if (!pinOk) {
      account.ussdPinFailures = (account.ussdPinFailures || 0) + 1;
      if (account.ussdPinFailures >= USSD_MAX_PIN_FAILURES) {
        account.ussdLocked = true;
        this.deps.accounts.save(account);
        this.audit('USSD_PIN_LOCKED', account, patient, info, `Locked after ${USSD_MAX_PIN_FAILURES} wrong PINs`);
        return screen('END', 'Wrong PIN. USSD access is now locked. Set a new PIN in the Medistry app.');
      }
      this.deps.accounts.save(account);
      this.audit('USSD_PIN_FAILED', account, patient, info, 'Wrong PIN');
      return screen('END', `Wrong PIN. ${USSD_MAX_PIN_FAILURES - account.ussdPinFailures} attempt(s) left.`);
    }
    if (account.ussdPinFailures) {
      account.ussdPinFailures = 0;
      this.deps.accounts.save(account);
    }

    const [choice, confirm, ...extra] = parts.slice(1);
    if (choice === undefined) {
      this.audit('USSD_SIGNED_IN', account, patient, info, 'PIN accepted; menu shown');
      return screen('CON', MENU);
    }
    if (extra.length) return screen('END', 'Invalid choice.');

    if (choice === '1' && confirm === undefined) {
      this.audit('USSD_SUMMARY_VIEWED', account, patient, info, 'Emergency summary viewed (blood group, genotype, allergies)');
      const allergies = patient.allergies.length ? patient.allergies.map((a) => a.substance).join(', ') : 'none recorded';
      return screen('END', `Blood group: ${bloodGroup(patient.bloodGroup)}\nGenotype: ${patient.genotype === 'UNKNOWN' ? 'not recorded' : patient.genotype}\nAllergies: ${allergies}`);
    }

    if (choice === '2' && confirm === undefined) {
      this.audit('USSD_ACCESS_LOG_VIEWED', account, patient, info, 'Last 3 access events viewed');
      const events = this.accessEvents(patient).slice(0, 3);
      if (!events.length) return screen('END', 'No one else has accessed your record.');
      return screen('END', events.map((e, i) => `${i + 1}. ${shortDate(e.timestamp)} ${e.actorName}${e.isEmergency ? ' (emergency)' : ''}`).join('\n'));
    }

    if (choice === '3') {
      const last = this.accessEvents(patient)[0];
      if (!last) {
        this.audit('USSD_DISPUTE_NONE', account, patient, info, 'Dispute requested; no access to dispute');
        return screen('END', 'There is no access to dispute.');
      }
      if (last.isDisputed) {
        this.audit('USSD_DISPUTE_DUPLICATE', account, patient, info, 'Dispute requested; last access already disputed');
        return screen('END', 'You have already disputed the last access. We are reviewing it.');
      }
      if (confirm === undefined) {
        this.audit('USSD_DISPUTE_CONFIRM_SHOWN', account, patient, info, `Asked to confirm a dispute of audit entry ${last.sequenceNumber}`);
        return screen('CON', `Dispute access by ${last.actorName} on ${shortDate(last.timestamp)}?\n1. Yes\n2. No`);
      }
      if (confirm === '1') {
        const ticket = this.deps.accessLogManager.disputeAccess(patient.id, last.auditId, 'Disputed by the patient by USSD');
        this.audit('USSD_DISPUTE_OPENED', account, patient, info, `Dispute ${ticket.ticketId} opened for audit entry ${last.sequenceNumber}`);
        return screen('END', `Dispute opened (ref ${ticket.ticketId.slice(0, 8).toUpperCase()}). We will review it and tell you the outcome.`);
      }
      this.audit('USSD_CANCELLED', account, patient, info, 'Dispute cancelled');
      return screen('END', 'Cancelled. Nothing was changed.');
    }

    if (choice === '4') {
      const card = this.deps.offlineCards.getCurrent(patient.id);
      if (!card) {
        this.audit('USSD_CARD_LOCK_NONE', account, patient, info, 'Card lock requested; no active card');
        return screen('END', 'You have no active emergency card.');
      }
      if (confirm === undefined) {
        this.audit('USSD_CARD_LOCK_CONFIRM_SHOWN', account, patient, info, `Asked to confirm locking card version ${card.version}`);
        return screen('CON', 'Lock your emergency card? It stops working until you reissue it in the app.\n1. Yes\n2. No');
      }
      if (confirm === '1') {
        this.deps.offlineCards.revoke(patient.id, card.version, 'Locked by the patient by USSD');
        this.audit('USSD_CARD_LOCKED', account, patient, info, `Emergency card version ${card.version} revoked`);
        return screen('END', 'Your emergency card is locked. Reissue it in the Medistry app when you need it.');
      }
      this.audit('USSD_CANCELLED', account, patient, info, 'Card lock cancelled');
      return screen('END', 'Cancelled. Nothing was changed.');
    }

    return screen('END', 'Invalid choice.');
  }
}
