/**
 * M-Pesa Daraja (Kenya), SANDBOX ONLY. The developer portal pages could not be read for this phase, so the request
 * shapes come from Safaricom's own SDK source (github.com/safaricom/mpesa-node-library, src/m-pesa.js,
 * src/endpoints/oauth.js, src/endpoints/lipa-na-mpesa-online.js):
 *   - base URL https://sandbox.safaricom.co.ke (production: https://api.safaricom.co.ke, not used here);
 *   - OAuth: GET /oauth/v1/generate?grant_type=client_credentials with Authorization: Basic base64(key:secret),
 *     response field access_token;
 *   - M-Pesa Express (STK push): POST /mpesa/stkpush/v1/processrequest with Bearer token and JSON BusinessShortCode,
 *     Password = base64(shortCode + passKey + Timestamp), Timestamp = YYYYMMDDHHmmss, TransactionType
 *     ('CustomerPayBillOnline'), Amount, PartyA (payer), PartyB (short code), PhoneNumber, CallBackURL,
 *     AccountReference, TransactionDesc.
 * Callbacks: nothing in Safaricom's SDK or listener source signs or authenticates callbacks, so the callback URL
 * carries a long random secret (DARAJA_CALLBACK_SECRET) checked in constant time.
 * TODO: credentials (DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, DARAJA_SHORT_CODE, DARAJA_PASSKEY) from the Daraja
 * portal; confirm the STK callback body against the official docs (parsed defensively here); confirm the payment with
 * an STK query before treating a callback as final; restrict callbacks to Safaricom's published IP ranges; recurring
 * billing (no native subscription in the SDK; each month is a new STK push started by the facility admin).
 */
import crypto from 'node:crypto';
import { BillingNotConfigured, type BillingEvent, type BillingProvider, type CheckoutRequest, type CheckoutStart } from './BillingProvider.ts';

export const DARAJA_SANDBOX = 'https://sandbox.safaricom.co.ke';

/** YYYYMMDDHHmmss (UTC), as the SDK derives it. */
export const darajaTimestamp = (d = new Date()) => d.toISOString().replace(/[^0-9]/g, '').slice(0, 14);

export class MpesaDarajaProvider implements BillingProvider {
  readonly name = 'mpesa' as const;
  readonly country = 'KE';
  private cfg: { consumerKey: string; consumerSecret: string; shortCode: string; passKey: string; callbackSecret: string };
  private fetchImpl: typeof fetch;

  constructor(opts: { env?: string; consumerKey?: string; consumerSecret?: string; shortCode?: string; passKey?: string; callbackSecret?: string; fetch?: typeof fetch }) {
    if ((opts.env || 'sandbox') !== 'sandbox') throw new BillingNotConfigured('M-Pesa Daraja: only the sandbox is supported in this build (DARAJA_ENV=sandbox)');
    const need = ['consumerKey', 'consumerSecret', 'shortCode', 'passKey', 'callbackSecret'] as const;
    if (need.some((k) => !String(opts[k] || '').trim())) throw new BillingNotConfigured('M-Pesa Daraja is not configured (DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, DARAJA_SHORT_CODE, DARAJA_PASSKEY, DARAJA_CALLBACK_SECRET)');
    if (String(opts.callbackSecret).length < 32) throw new BillingNotConfigured('DARAJA_CALLBACK_SECRET must be at least 32 characters');
    this.cfg = { consumerKey: opts.consumerKey!, consumerSecret: opts.consumerSecret!, shortCode: opts.shortCode!, passKey: opts.passKey!, callbackSecret: opts.callbackSecret! };
    this.fetchImpl = opts.fetch || fetch;
  }

  private async token(): Promise<string> {
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const res = await this.fetchImpl(`${DARAJA_SANDBOX}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(15_000) });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) throw new BillingNotConfigured(`M-Pesa sandbox did not issue a token (HTTP ${res.status})`);
    return String(data.access_token);
  }

  async startCheckout(req: CheckoutRequest): Promise<CheckoutStart> {
    if (!req.phone) throw new BillingNotConfigured('M-Pesa needs the facility admin\'s phone number');
    const timestamp = darajaTimestamp();
    const msisdn = req.phone.replace(/^\+/, '');
    const res = await this.fetchImpl(`${DARAJA_SANDBOX}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: this.cfg.shortCode,
        Password: Buffer.from(`${this.cfg.shortCode}${this.cfg.passKey}${timestamp}`).toString('base64'),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(req.amountMinor / 100), // whole shillings
        PartyA: msisdn,
        PartyB: this.cfg.shortCode,
        PhoneNumber: msisdn,
        CallBackURL: `${req.callbackBaseUrl}/api/billing/webhooks/mpesa/${this.cfg.callbackSecret}`,
        AccountReference: `Medistry ${req.plan.id}`.slice(0, 12),
        TransactionDesc: 'Medistry plan'.slice(0, 20),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.CheckoutRequestID) throw new BillingNotConfigured(`M-Pesa sandbox did not start the payment (HTTP ${res.status})`);
    return { providerRef: String(data.CheckoutRequestID), instructions: 'Approve the M-Pesa prompt on the phone to pay for this month.' };
  }

  /** No signature exists for Daraja callbacks: the secret in the callback URL path is the check (constant time). */
  verifyWebhook(_rawBody: string, _headers: Record<string, string | string[] | undefined>, pathSecret?: string): boolean {
    if (!pathSecret) return false;
    const a = crypto.createHash('sha256').update(pathSecret).digest();
    const b = crypto.createHash('sha256').update(this.cfg.callbackSecret).digest();
    return crypto.timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): BillingEvent {
    let body: any;
    try { body = JSON.parse(rawBody); } catch { return { type: 'ignored', eventId: 'unparseable', reason: 'not JSON' }; }
    // TODO: confirm this shape against the official Daraja docs.
    const cb = body?.Body?.stkCallback;
    const ref = typeof cb?.CheckoutRequestID === 'string' ? cb.CheckoutRequestID : '';
    if (!ref) return { type: 'ignored', eventId: 'unknown', reason: 'no CheckoutRequestID' };
    if (Number(cb.ResultCode) === 0) {
      const amount = (cb.CallbackMetadata?.Item || []).find((i: any) => i?.Name === 'Amount')?.Value;
      return { type: 'payment_succeeded', providerRef: ref, amountMinor: Number.isFinite(Number(amount)) ? Number(amount) * 100 : undefined, currency: 'KES', eventId: `stk:${ref}` };
    }
    return { type: 'payment_failed', providerRef: ref, eventId: `stk:${ref}:${cb.ResultCode}`, reason: String(cb.ResultDesc || 'payment not completed').slice(0, 80) };
  }
}
