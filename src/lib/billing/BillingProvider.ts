/**
 * Facility billing providers (Phase 18). Test/sandbox mode only in this build: each provider refuses live
 * credentials. Patients are never billed; only facilities subscribe.
 */
import fs from 'node:fs';

export interface Plan { id: string; name: string; description: string; prices: Record<string, number>; todo?: string }
export interface PlansConfig {
  interval: 'monthly';
  trialDays: number;
  currencies: Record<string, string>;
  plans: Plan[];
  paystackPlanCodes: Record<string, string | null>;
}

export function loadPlans(file = new URL('../../config/plans.json', import.meta.url)): PlansConfig {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export interface CheckoutRequest {
  subscriptionId: string;
  facilityId: string;
  plan: Plan;
  amountMinor: number;
  currency: string;
  email?: string;   // Paystack needs the payer's email
  phone?: string;   // M-Pesa needs the payer's phone (E.164)
  callbackBaseUrl: string;
}

export interface CheckoutStart {
  providerRef: string;          // our reference (Paystack) or the provider's request id (M-Pesa)
  checkoutUrl?: string;         // redirect the admin here (Paystack)
  instructions?: string;        // what happens next (M-Pesa: approve the prompt on the phone)
}

/** What a verified webhook means for a subscription. */
export type BillingEvent =
  | { type: 'payment_succeeded'; providerRef: string; amountMinor?: number; currency?: string; eventId: string }
  | { type: 'payment_failed'; providerRef: string; eventId: string; reason?: string }
  | { type: 'subscription_cancelled'; providerRef: string; eventId: string }
  | { type: 'ignored'; eventId: string; reason: string };

export interface BillingProvider {
  readonly name: 'paystack' | 'mpesa';
  readonly country: string;
  startCheckout(req: CheckoutRequest): Promise<CheckoutStart>;
  /** Authenticates a webhook (signature or shared secret, as the provider allows). Never throws. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, pathSecret?: string, now?: number): boolean;
  /** Interprets a verified webhook body. */
  parseWebhook(rawBody: string): BillingEvent;
}

export class BillingNotConfigured extends Error {
  status = 503;
}
