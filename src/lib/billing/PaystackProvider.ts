/**
 * Paystack (Nigeria), TEST MODE ONLY. From the Paystack docs (read for this phase):
 *   - API base https://api.paystack.co for test and live; the secret key decides (test keys start "sk_test_").
 *     Authorization: Bearer <secret key>.
 *   - POST /transaction/initialize, JSON: amount (subunit: kobo for NGN), email; optional reference (only "-", ".",
 *     "=" and alphanumerics), callback_url, metadata, plan (a plan code; then amount is ignored). The response has
 *     data.authorization_url and data.reference.
 *   - Webhooks: header "Paystack-Signature: t=<unix seconds>,v1=<signature>", HMAC SHA512 over "<t>.<raw body>" with
 *     the webhook signing secret (whsec_...), reject if t is more than 300 s away; legacy header "x-paystack-signature"
 *     = HMAC SHA512 of the raw body with the secret key (no timestamp). Answer 200 OK. Events used: charge.success,
 *     invoice.payment_failed, subscription.disable. Webhooks come from 52.31.139.75, 52.49.173.169, 52.214.14.220.
 * TODO: test credentials (PAYSTACK_SECRET_KEY=sk_test_..., PAYSTACK_WEBHOOK_SECRET=whsec_...) and the plan codes in
 * src/config/plans.json; confirm the v1 signature value format against a real test-mode webhook.
 */
import crypto from 'node:crypto';
import { BillingNotConfigured, type BillingEvent, type BillingProvider, type CheckoutRequest, type CheckoutStart } from './BillingProvider.ts';

export const PAYSTACK_API = 'https://api.paystack.co';
export const PAYSTACK_WEBHOOK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];
const MAX_SKEW_SECONDS = 300;

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export class PaystackProvider implements BillingProvider {
  readonly name = 'paystack' as const;
  readonly country = 'NG';
  private secretKey: string;
  private webhookSecret?: string;
  private planCodes: Record<string, string | null>;
  private fetchImpl: typeof fetch;

  constructor(opts: { secretKey?: string; webhookSecret?: string; planCodes?: Record<string, string | null>; fetch?: typeof fetch }) {
    const key = (opts.secretKey || '').trim();
    if (!key) throw new BillingNotConfigured('Paystack is not configured (PAYSTACK_SECRET_KEY)');
    // Test mode only in this build: a live key is refused, never used.
    if (!key.startsWith('sk_test_')) throw new BillingNotConfigured('Paystack: only test-mode keys (sk_test_...) are accepted in this build');
    this.secretKey = key;
    this.webhookSecret = (opts.webhookSecret || '').trim() || undefined;
    this.planCodes = opts.planCodes || {};
    this.fetchImpl = opts.fetch || fetch;
  }

  async startCheckout(req: CheckoutRequest): Promise<CheckoutStart> {
    if (!req.email) throw new BillingNotConfigured('Paystack needs the facility admin\'s email address');
    const reference = `medistry-${req.subscriptionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}-${Date.now()}`;
    const planCode = this.planCodes[req.plan.id];
    const res = await this.fetchImpl(`${PAYSTACK_API}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: req.email, amount: String(req.amountMinor), currency: req.currency, reference,
        callback_url: `${req.callbackBaseUrl}/facility-admin#billing`,
        metadata: { facilityId: req.facilityId, subscriptionId: req.subscriptionId, plan: req.plan.id },
        ...(planCode ? { plan: planCode } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.status || !data?.data?.authorization_url) throw new BillingNotConfigured(`Paystack did not start the payment (HTTP ${res.status})`);
    return { providerRef: String(data.data.reference || reference), checkoutUrl: String(data.data.authorization_url) };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, _pathSecret?: string, now = Date.now()): boolean {
    const header = (name: string) => { const v = headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
    const current = header('paystack-signature');
    if (current && this.webhookSecret) {
      const parts = Object.fromEntries(current.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
      const t = Number(parts.t);
      if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > MAX_SKEW_SECONDS) return false;
      const given = String(parts.v1 || '').split(':').pop() || ''; // "v1=<key id>:<hex>" in the docs' example
      const expected = crypto.createHmac('sha512', this.webhookSecret).update(`${t}.${rawBody}`).digest('hex');
      return safeEqualHex(given, expected);
    }
    const legacy = header('x-paystack-signature');
    if (legacy) return safeEqualHex(legacy, crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex'));
    return false;
  }

  parseWebhook(rawBody: string): BillingEvent {
    let body: any;
    try { body = JSON.parse(rawBody); } catch { return { type: 'ignored', eventId: 'unparseable', reason: 'not JSON' }; }
    const d = body?.data || {};
    const eventId = String(d.id ?? d.reference ?? d.subscription_code ?? 'unknown').slice(0, 100);
    switch (body?.event) {
      case 'charge.success':
        return { type: 'payment_succeeded', providerRef: String(d.reference || ''), amountMinor: Number(d.amount), currency: d.currency, eventId: `charge:${eventId}` };
      case 'invoice.payment_failed':
        return { type: 'payment_failed', providerRef: String(d.transaction?.reference || d.subscription?.subscription_code || ''), eventId: `invoice:${eventId}`, reason: 'invoice payment failed' };
      case 'subscription.disable':
        return { type: 'subscription_cancelled', providerRef: String(d.subscription_code || ''), eventId: `sub:${eventId}` };
      default:
        return { type: 'ignored', eventId, reason: `event ${String(body?.event).slice(0, 40)} not used` };
    }
  }
}
