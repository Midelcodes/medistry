/**
 * One delivery record per SMS (Phase 13). The phone number is kept only as a keyed hash plus its last 3 digits;
 * the message text is never kept here (the template id says what kind of message it was).
 *
 * Status: QUEUED (created) -> SENT (accepted by the provider) -> DELIVERED or FAILED (from the provider's delivery
 * report, or FAILED after the last send attempt). The provider's own status word is kept in providerStatus.
 */
import crypto from 'node:crypto';
import { identifierHash } from '../auth/accounts.ts';

export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

export interface NotificationDelivery {
  id: string;
  channel: 'SMS';
  provider: 'console' | 'africastalking';
  toHash: string;
  toLast3: string;
  templateId: string;
  status: DeliveryStatus;
  providerStatus?: string;
  providerMessageId?: string;
  attempts: number;
  lastError?: string; // never contains the phone number or the message text
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDeliveryRepo { saveNotificationDelivery(d: NotificationDelivery): void }

/** Provider status words are short identifiers; anything else is cut down so a report cannot inject text. */
const word = (v: unknown, max = 40) => String(v ?? '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, max);

export class NotificationDeliveryStore {
  private byId = new Map<string, NotificationDelivery>();
  persistence?: NotificationDeliveryRepo;

  hydrate(rows: NotificationDelivery[]): void {
    for (const d of rows) this.byId.set(d.id, d);
  }

  all(): NotificationDelivery[] {
    return [...this.byId.values()];
  }

  get(id: string): NotificationDelivery | undefined {
    return this.byId.get(id);
  }

  byProviderMessageId(messageId: string): NotificationDelivery | undefined {
    for (const d of this.byId.values()) if (d.providerMessageId === messageId) return d;
    return undefined;
  }

  create(to: string, templateId: string, provider: NotificationDelivery['provider']): NotificationDelivery {
    const now = new Date().toISOString();
    const d: NotificationDelivery = {
      id: crypto.randomUUID(), channel: 'SMS', provider, toHash: identifierHash('phone', to), toLast3: to.replace(/\D/g, '').slice(-3),
      templateId: word(templateId, 60) || 'unspecified', status: 'QUEUED', attempts: 0, createdAt: now, updatedAt: now,
    };
    this.byId.set(d.id, d);
    this.persistence?.saveNotificationDelivery(d);
    return d;
  }

  update(d: NotificationDelivery, patch: Partial<Pick<NotificationDelivery, 'status' | 'providerStatus' | 'providerMessageId' | 'attempts' | 'lastError'>>): void {
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    if (patch.lastError !== undefined) d.lastError = String(patch.lastError).slice(0, 200);
    this.persistence?.saveNotificationDelivery(d);
  }

  /**
   * Applies a provider delivery report. Statuses named in the Africa's Talking docs: Sent, Submitted, Buffered,
   * Rejected, Success; other failure words map to FAILED. A delivered message is never moved back.
   * Returns the record, or undefined for an unknown message id.
   */
  applyDeliveryReport(report: { id?: unknown; status?: unknown; failureReason?: unknown }): NotificationDelivery | undefined {
    const d = this.byProviderMessageId(String(report.id ?? ''));
    if (!d) return undefined;
    const providerStatus = word(report.status);
    let status: DeliveryStatus = d.status;
    if (/^success$/i.test(providerStatus)) status = 'DELIVERED';
    else if (/reject|fail|expired|absent|blacklist|insufficient/i.test(providerStatus)) status = 'FAILED';
    else if (/^(sent|submitted|buffered)$/i.test(providerStatus)) status = 'SENT';
    if (d.status === 'DELIVERED') status = 'DELIVERED';
    const reason = word(report.failureReason);
    this.update(d, { status, providerStatus, ...(status === 'FAILED' && reason ? { lastError: `delivery report: ${reason}` } : {}) });
    return d;
  }
}
