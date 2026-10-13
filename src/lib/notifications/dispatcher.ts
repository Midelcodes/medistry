/**
 * MEDISTRY Multi-Channel Notification Dispatcher
 * Dispatches instant emergency break-glass alerts via SMS, Email, and Push
 * with automatic graceful degradation if SMS providers encounter outages.
 */

export interface NotificationMessage {
  toPhone?: string;
  toEmail?: string;
  toUserId?: string;
  subject: string;
  body: string;
}

export interface INotificationProvider {
  sendSms(toPhone: string, message: string): Promise<boolean>;
  sendEmail(toEmail: string, subject: string, body: string): Promise<boolean>;
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

  async sendSms(toPhone: string, message: string): Promise<boolean> {
    if (this.forceSmsFailure) {
      throw new Error('Telecom gateway timeout (MTN/Airtel SMS outage simulated)');
    }
    this.sentSmsLogs.push({ to: toPhone, message });
    return true;
  }

  async sendEmail(toEmail: string, subject: string, body: string): Promise<boolean> {
    this.sentEmailLogs.push({ to: toEmail, subject, body });
    return true;
  }

  async sendPush(toUserId: string, title: string, body: string): Promise<boolean> {
    this.sentPushLogs.push({ toUserId, title, body });
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
      emergencyContacts: Array<{ name: string; phone: string; email?: string; relationship: string }>;
    },
    eventDetails: {
      doctorName: string;
      facilityName: string;
      reason: string;
      timestamp: string;
    }
  ): Promise<DispatchedAlertResult[]> {
    const results: DispatchedAlertResult[] = [];
    const alertBody = `🚨 MEDISTRY EMERGENCY BREAK-GLASS ALERT: Dr. ${eventDetails.doctorName} at ${eventDetails.facilityName} has accessed your emergency medical record. Reason: ${eventDetails.reason}. If this was not authorized by you or hospital staff, visit your patient portal immediately to dispute.`;

    // 1. Notify Patient
    if (patient.phone) {
      try {
        await this.provider.sendSms(patient.phone, alertBody);
        results.push({ recipient: patient.phone, channel: 'SMS', status: 'DELIVERED' });
      } catch (err: any) {
        // SMS Outage fallback to Email and Push
        results.push({ recipient: patient.phone, channel: 'SMS', status: 'FAILED', error: err.message });
        if (patient.email) {
          try {
            await this.provider.sendEmail(patient.email, '🚨 URGENT: Emergency Medical Access to Your Record', alertBody);
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
      const contactMsg = `🚨 MEDISTRY EMERGENCY NOTIFICATION: An emergency break-glass access was triggered for ${patient.fullName} by Dr. ${eventDetails.doctorName} at ${eventDetails.facilityName}. Reason: ${eventDetails.reason}.`;
      try {
        await this.provider.sendSms(contact.phone, contactMsg);
        results.push({ recipient: `${contact.name} (${contact.phone})`, channel: 'SMS', status: 'DELIVERED' });
      } catch (err: any) {
        results.push({ recipient: contact.phone, channel: 'SMS', status: 'FAILED', error: err.message });
        if (contact.email) {
          try {
            await this.provider.sendEmail(contact.email, `🚨 Emergency Alert for ${patient.fullName}`, contactMsg);
            results.push({ recipient: contact.email, channel: 'EMAIL', status: 'FALLBACK_DELIVERED' });
          } catch {}
        }
      }
    }

    return results;
  }
}
