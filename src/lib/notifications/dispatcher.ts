/**
 * MEDISTRY Multi-Channel Notification Dispatcher
 * Dispatches instant emergency break-glass alerts via SMS, Email, and Push
 * with automatic graceful degradation if SMS providers encounter outages.
 */
import type { NotificationRepo, NotificationEntity } from '../data/repositories.ts';
import type { NotificationDeliveryStore } from './deliveries.ts';
import { renderSms, type SmsTemplateId } from '../i18n/translations.ts';

export interface NotificationMessage {
  toPhone?: string;
  toEmail?: string;
  toUserId?: string;
  subject: string;
  body: string;
}

/**
 * storedAs: what the message log keeps instead of the text (for one-time codes, which must never be stored).
 * templateId: which SMS template produced the text (kept on the delivery record instead of the text).
 */
export interface SendOptions { storedAs?: string; templateId?: string }

/** An SMS is always a template plus values (see SMS_TEMPLATES in i18n/translations.ts), never free text. */
export interface SmsContent { template: SmsTemplateId; locale?: string; vars?: Record<string, string | number> }

export interface INotificationProvider {
  sendSms(toPhone: string, message: string, opts?: SendOptions): Promise<boolean>;
  sendEmail(toEmail: string, subject: string, body: string, opts?: SendOptions): Promise<boolean>;
  sendPush(toUserId: string, title: string, body: string): Promise<boolean>;
}

/**
 * Built-in Console Provider for Local Dev and Automated Testing.
 */
export class ConsoleNotificationProvider implements INotificationProvider {
  public sentSmsLogs: Array<{ to: string; message: string }> = [];
  public sentEmailLogs: Array<{ to: string; subject: string; body: string }> = [];
  public sentPushLogs: Array<{ toUserId: string; title: string; body: string }> = [];
  public forceSmsFailure = false; // For testing graceful degradation
  /** Write-through repository (no-op in memory storage). */
  persistence?: NotificationRepo;
  /** Delivery records (one per SMS). */
  deliveries?: NotificationDeliveryStore;

  /** Restores sent-message logs from storage (start-up), in order. */
  hydrate(entries: NotificationEntity[]): void {
    for (const n of entries) {
      if (n.channel === 'SMS') this.sentSmsLogs.push({ to: n.to, message: n.body });
      else if (n.channel === 'EMAIL') this.sentEmailLogs.push({ to: n.to, subject: n.title || '', body: n.body });
      else this.sentPushLogs.push({ toUserId: n.to, title: n.title || '', body: n.body });
    }
  }

  // The in-memory logs stand in for the recipient's handset or inbox (tests read codes from them); the
  // stored log keeps opts.storedAs instead of the text when one is given.
  async sendSms(toPhone: string, message: string, opts: SendOptions = {}): Promise<boolean> {
    const delivery = this.deliveries?.create(toPhone, opts.templateId || 'unspecified', 'console');
    if (this.forceSmsFailure) {
      if (delivery) this.deliveries!.update(delivery, { attempts: 1, status: 'FAILED', lastError: 'simulated outage' });
      throw new Error('Telecom gateway timeout (MTN/Airtel SMS outage simulated)');
    }
    if (delivery) this.deliveries!.update(delivery, { attempts: 1, status: 'SENT' });
    this.sentSmsLogs.push({ to: toPhone, message });
    this.persistence?.saveNotification({ channel: 'SMS', to: toPhone, body: opts.storedAs ?? message });
    return true;
  }

  async sendEmail(toEmail: string, subject: string, body: string, opts: SendOptions = {}): Promise<boolean> {
    this.sentEmailLogs.push({ to: toEmail, subject, body });
    this.persistence?.saveNotification({ channel: 'EMAIL', to: toEmail, title: subject, body: opts.storedAs ?? body });
    return true;
  }

  async sendPush(toUserId: string, title: string, body: string): Promise<boolean> {
    this.sentPushLogs.push({ toUserId, title, body });
    this.persistence?.saveNotification({ channel: 'PUSH', to: toUserId, title, body });
    return true;
  }
}

export interface DispatchedAlertResult {
  recipient: string;
  channel: 'SMS' | 'EMAIL' | 'PUSH';
  status: 'DELIVERED' | 'FAILED' | 'FALLBACK_DELIVERED';
  error?: string;
}

export class NotificationDispatcher {
  private provider: INotificationProvider;

  constructor(provider: INotificationProvider = new ConsoleNotificationProvider()) {
    this.provider = provider;
  }

  /**
   * Dispatches emergency break-glass alerts to patient and all emergency contacts.
   * Graceful degradation: If SMS fails, falls back immediately to email and push.
   */
  async dispatchEmergencyBreakGlassAlerts(
    patient: {
      id: string;
      fullName: string;
      phone?: string;
      email?: string;
      locale?: string;
      emergencyContacts: Array<{ name: string; phone: string; email?: string; relationship: string }>;
    },
    eventDetails: {
      doctorName: string;
      facilityName: string;
      reason: string; // kept off SMS and email: it is clinical detail
      timestamp: string;
    }
  ): Promise<DispatchedAlertResult[]> {
    const results: DispatchedAlertResult[] = [];
    // No clinical detail in SMS or email: who opened the record, where, and how to review or dispute.
    const vars = { doctor: eventDetails.doctorName, facility: eventDetails.facilityName, patient: patient.fullName };
    const alertBody = renderSms('access_alert', patient.locale, vars);

    // 1. Notify Patient
    if (patient.phone) {
      try {
        await this.provider.sendSms(patient.phone, alertBody, { templateId: 'access_alert' });
        results.push({ recipient: patient.phone, channel: 'SMS', status: 'DELIVERED' });
      } catch (err: any) {
        // SMS failed (after the provider's retries): fall back to email and push
        results.push({ recipient: patient.phone, channel: 'SMS', status: 'FAILED', error: err.message });
        if (patient.email) {
          try {
            await this.provider.sendEmail(patient.email, 'Medistry: your record was accessed', alertBody);
            results.push({ recipient: patient.email, channel: 'EMAIL', status: 'FALLBACK_DELIVERED' });
          } catch {}
        }
        try {
          await this.provider.sendPush(patient.id, '🚨 Emergency Break-Glass Alert', alertBody);
          results.push({ recipient: patient.id, channel: 'PUSH', status: 'FALLBACK_DELIVERED' });
        } catch {}
      }
    }

    // 2. Notify Emergency Contacts
    for (const contact of patient.emergencyContacts) {
      const contactMsg = renderSms('contact_alert', patient.locale, vars);
      try {
        await this.provider.sendSms(contact.phone, contactMsg, { templateId: 'contact_alert' });
        results.push({ recipient: `${contact.name} (${contact.phone})`, channel: 'SMS', status: 'DELIVERED' });
      } catch (err: any) {
        results.push({ recipient: contact.phone, channel: 'SMS', status: 'FAILED', error: err.message });
        if (contact.email) {
          try {
            await this.provider.sendEmail(contact.email, 'Medistry: emergency access notice', contactMsg);
            results.push({ recipient: contact.email, channel: 'EMAIL', status: 'FALLBACK_DELIVERED' });
          } catch {}
        }
      }
    }

    return results;
  }

  /**
   * One SMS from a template (sign-in codes, account notices). A `code` value is never stored: the message log
   * keeps the text with the code blanked. Failures are reported, never thrown.
   */
  async sendSms(toPhone: string, sms: SmsContent): Promise<DispatchedAlertResult> {
    const message = renderSms(sms.template, sms.locale, sms.vars);
    const storedAs = sms.vars?.code !== undefined ? renderSms(sms.template, sms.locale, { ...sms.vars, code: '[code not stored]' }) : undefined;
    try {
      await this.provider.sendSms(toPhone, message, { templateId: sms.template, storedAs });
      return { recipient: toPhone, channel: 'SMS', status: 'DELIVERED' };
    } catch (err: any) {
      return { recipient: toPhone, channel: 'SMS', status: 'FAILED', error: err?.message };
    }
  }

  /** One email (recovery codes, account notices). Failures are reported, never thrown. */
  async sendEmail(toEmail: string, subject: string, body: string, opts?: SendOptions): Promise<DispatchedAlertResult> {
    try {
      await this.provider.sendEmail(toEmail, subject, body, opts);
      return { recipient: toEmail, channel: 'EMAIL', status: 'DELIVERED' };
    } catch (err: any) {
      return { recipient: toEmail, channel: 'EMAIL', status: 'FAILED', error: err?.message };
    }
  }

  /** Push notification to one user (patient or clinician). Failures are reported, never thrown. */
  async notifyUser(userId: string, title: string, message: string): Promise<DispatchedAlertResult> {
    try {
      await this.provider.sendPush(userId, title, message);
      return { recipient: userId, channel: 'PUSH', status: 'DELIVERED' };
    } catch (err: any) {
      return { recipient: userId, channel: 'PUSH', status: 'FAILED', error: err?.message };
    }
  }
}
