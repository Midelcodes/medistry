/**
 * Africa's Talking SMS provider (Phase 13). Selected with SMS_PROVIDER=africastalking; the console provider stays
 * the default. Plain fetch to the provider's HTTPS API, no SDK.
 *
 * Request shape, taken from the official SDK source (africastalking-node.js lib/common.js and lib/sms.js,
 * africastalking-python SMS.py), because the documentation site refuses automated reads:
 *   POST https://api.africastalking.com/version1/messaging          (production)
 *   POST https://api.sandbox.africastalking.com/version1/messaging  (sandbox; username is always "sandbox")
 *   headers: apiKey, Accept: application/json; body form-encoded: username, to, message, from (sender id, optional)
 * Response: SMSMessageData.Recipients[] with statusCode, status, messageId (the official sample shows
 * statusCode 101, status "Success").
 * TODO: confirm the full list of recipient status codes against the current docs; AT_ACCEPTED_STATUS_CODES
 * lists the codes treated as accepted (default 101).
 *
 * Each message gets a delivery record. Network errors, HTTP 429/5xx and recipient codes of 500 or more are
 * retried with exponential backoff (3 attempts in all); then sendSms throws so the dispatcher falls back to
 * email and push. Other refusals (an invalid number, for example) are not retried. Email and push go to the
 * fallback provider. Nothing here logs a phone number, message text or the API key.
 */
import type { INotificationProvider, SendOptions } from './dispatcher.ts';
import type { NotificationDeliveryStore } from './deliveries.ts';

export const AFRICASTALKING_SMS_URLS = {
  production: 'https://api.africastalking.com/version1/messaging',
  sandbox: 'https://api.sandbox.africastalking.com/version1/messaging',
} as const;

export interface AfricasTalkingConfig {
  username: string;
  apiKey: string;
  senderId?: string;
  env: 'sandbox' | 'production';
  acceptedStatusCodes: number[];
}

/** Reads AT_USERNAME, AT_API_KEY, AT_SENDER_ID, AT_ENV. Throws (without echoing values) when incomplete. */
export function africasTalkingConfig(env: NodeJS.ProcessEnv = process.env): AfricasTalkingConfig {
  const username = (env.AT_USERNAME || '').trim();
  const apiKey = (env.AT_API_KEY || '').trim();
  const mode = (env.AT_ENV || 'sandbox').trim().toLowerCase();
  if (!username || !apiKey) throw new Error('SMS_PROVIDER=africastalking needs AT_USERNAME and AT_API_KEY');
  if (mode !== 'sandbox' && mode !== 'production') throw new Error('AT_ENV must be sandbox or production');
  const codes = (env.AT_ACCEPTED_STATUS_CODES || '101').split(',').map((c) => parseInt(c.trim(), 10)).filter(Number.isFinite);
  return { username, apiKey, senderId: (env.AT_SENDER_ID || '').trim() || undefined, env: mode, acceptedStatusCodes: codes.length ? codes : [101] };
}

type Attempt = { ok: true; messageId: string; providerStatus: string } | { ok: false; retryable: boolean; error: string };

const word = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40);

export class AfricasTalkingNotificationProvider implements INotificationProvider {
  private config: AfricasTalkingConfig;
  private deliveries: NotificationDeliveryStore;
  private fallback: INotificationProvider;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;

  constructor(opts: {
    config: AfricasTalkingConfig; deliveries: NotificationDeliveryStore; fallback: INotificationProvider;
    fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxAttempts?: number; baseDelayMs?: number;
  }) {
    this.config = opts.config;
    this.deliveries = opts.deliveries;
    this.fallback = opts.fallback;
    this.fetchImpl = opts.fetch || fetch;
    this.sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
  }

  private async attempt(to: string, message: string): Promise<Attempt> {
    const body = new URLSearchParams({ username: this.config.username, to, message });
    if (this.config.senderId) body.set('from', this.config.senderId);
    let res: Response;
    try {
      res = await this.fetchImpl(AFRICASTALKING_SMS_URLS[this.config.env], {
        method: 'POST',
        headers: { apiKey: this.config.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      return { ok: false, retryable: true, error: `network error (${word(err?.name || 'error')})` };
    }
    if (!res.ok) return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `HTTP ${res.status}` };
    const data: any = await res.json().catch(() => null);
    const recipient = data?.SMSMessageData?.Recipients?.[0];
    // An unreadable success response is not retried: the message may have gone out, and a retry would send it twice.
    if (!recipient) return { ok: false, retryable: false, error: 'response without a recipient entry' };
    const code = Number(recipient.statusCode);
    if (this.config.acceptedStatusCodes.includes(code)) {
      return { ok: true, messageId: String(recipient.messageId || '').slice(0, 100), providerStatus: word(recipient.status) };
    }
    return { ok: false, retryable: code >= 500, error: `provider status ${code} ${word(recipient.status)}`.trim() };
  }

  async sendSms(toPhone: string, message: string, opts: SendOptions = {}): Promise<boolean> {
    const d = this.deliveries.create(toPhone, opts.templateId || 'unspecified', 'africastalking');
    let lastError = 'not attempted';
    for (let n = 1; n <= this.maxAttempts; n++) {
      const result = await this.attempt(toPhone, message);
      if (result.ok) {
        this.deliveries.update(d, { attempts: n, status: 'SENT', providerMessageId: result.messageId || undefined, providerStatus: result.providerStatus });
        return true;
      }
      lastError = result.error;
      this.deliveries.update(d, { attempts: n, lastError });
      if (!result.retryable) break;
      if (n < this.maxAttempts) await this.sleep(this.baseDelayMs * 2 ** (n - 1)); // 1s, 2s
    }
    this.deliveries.update(d, { status: 'FAILED', lastError });
    throw new Error(`SMS not sent (${lastError})`);
  }

  sendEmail(toEmail: string, subject: string, body: string, opts?: SendOptions): Promise<boolean> {
    return this.fallback.sendEmail(toEmail, subject, body, opts);
  }

  sendPush(toUserId: string, title: string, body: string): Promise<boolean> {
    return this.fallback.sendPush(toUserId, title, body);
  }
}
