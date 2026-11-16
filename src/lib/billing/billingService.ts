/**
 * Facility subscriptions (Phase 18). Patients are never charged, and non-payment never touches emergency care:
 * break-glass, offline card scanning, patient records and imports keep working whatever the subscription state.
 * Only facility admin and analytics features are gated (usage dashboard, new API clients, staff invites and role
 * changes); see hasAccess().
 *
 * Lifecycle: a facility gets a trial when a platform admin verifies it; the admin starts a checkout with the
 * country's provider (Paystack NG, M-Pesa KE); a verified webhook for a successful payment of the plan amount
 * activates the subscription for one month (extending from the later of now and the current period end); a failed
 * payment marks it PAST_DUE (access continues until the period ends); after the period end it is EXPIRED.
 */
import crypto from 'node:crypto';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { SeedFacility } from '../../../prisma/seed.ts';
import type { UserAccount } from '../auth/accounts.ts';
import { AuthError, type RequestInfo } from '../auth/patientAuth.ts';
import { loadPlans, type BillingEvent, type BillingProvider, type PlansConfig } from './BillingProvider.ts';

export type SubscriptionStatus = 'TRIALING' | 'PENDING_PAYMENT' | 'ACTIVE' | 'PAST_DUE' | 'EXPIRED' | 'CANCELLED';

export interface Subscription {
  id: string;
  facilityId: string;
  plan: string;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
  provider: 'trial' | 'paystack' | 'mpesa';
  providerRef?: string;
  lastEventId?: string;   // last processed webhook event (idempotency)
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRepo { saveSubscription(s: Subscription): void }

const DAY_MS = 86_400_000;
const addMonth = (from: number) => { const d = new Date(from); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); };

export class BillingService {
  private subs = new Map<string, Subscription>(); // facilityId -> subscription
  private deps: { auditManager: AuditChainManager; facilities: SeedFacility[]; providers: () => Map<string, BillingProvider>; demoMode: boolean };
  readonly plans: PlansConfig;
  persistence?: SubscriptionRepo;

  constructor(deps: BillingService['deps'], plans: PlansConfig = loadPlans()) {
    this.deps = deps;
    this.plans = plans;
  }

  hydrate(rows: Subscription[]): void {
    for (const s of rows) this.subs.set(s.facilityId, s);
  }

  private save(s: Subscription, patch: Partial<Subscription>): Subscription {
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    this.persistence?.saveSubscription(s);
    return s;
  }

  private audit(action: string, actorId: string, facilityId: string, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({ actorId, action, accessType: 'SYSTEM_ADMIN', facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason });
  }

  get(facilityId: string, now = Date.now()): Subscription | undefined {
    const s = this.subs.get(facilityId);
    // Lapsed periods become EXPIRED (computed on read, persisted once).
    if (s && ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PENDING_PAYMENT'].includes(s.status) && Date.parse(s.currentPeriodEnd) <= now) this.save(s, { status: 'EXPIRED' });
    return s;
  }

  /** Admin and analytics features only. Never call this from emergency, patient or clinical paths. */
  hasAccess(facilityId: string, now = Date.now()): boolean {
    const s = this.get(facilityId, now);
    if (!s) return this.deps.demoMode; // demo facilities without a subscription
    return ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PENDING_PAYMENT'].includes(s.status) && Date.parse(s.currentPeriodEnd) > now;
  }

  /** Started when a platform admin verifies a facility. */
  startTrial(facilityId: string, info: RequestInfo, now = Date.now()): Subscription {
    const at = new Date(now).toISOString();
    const s: Subscription = {
      id: crypto.randomUUID(), facilityId, plan: this.plans.plans[0].id, status: 'TRIALING', provider: 'trial',
      currentPeriodEnd: new Date(now + this.plans.trialDays * DAY_MS).toISOString(), createdAt: at, updatedAt: at,
    };
    this.subs.set(facilityId, s);
    this.persistence?.saveSubscription(s);
    this.audit('BILLING_TRIAL_STARTED', 'system', facilityId, info, `Trial of ${this.plans.trialDays} days started`);
    return s;
  }

  view(admin: UserAccount, facilityId: string) {
    const f = this.deps.facilities.find((x) => x.id === facilityId);
    const country = f?.countryCode || 'NG';
    const s = this.get(facilityId);
    return {
      subscription: s ? { plan: s.plan, status: s.status, currentPeriodEnd: s.currentPeriodEnd, provider: s.provider } : null,
      access: this.hasAccess(facilityId),
      currency: this.plans.currencies[country] || null,
      plans: this.plans.plans.map((p) => ({ id: p.id, name: p.name, description: p.description, amountMinor: p.prices[country] ?? null, placeholderPrice: !!p.todo })),
      note: 'Emergency access, offline scanning and patient records are never affected by billing.',
    };
  }

  async subscribe(admin: UserAccount, facilityId: string, planId: unknown, contact: { email?: string; phone?: string }, callbackBaseUrl: string, info: RequestInfo) {
    const f = this.deps.facilities.find((x) => x.id === facilityId);
    if (!f) throw new AuthError(404, 'Facility not found');
    const plan = this.plans.plans.find((p) => p.id === planId);
    if (!plan) throw new AuthError(400, `plan must be one of ${this.plans.plans.map((p) => p.id).join(', ')}`);
    const amountMinor = plan.prices[f.countryCode];
    const currency = this.plans.currencies[f.countryCode];
    if (!amountMinor || !currency) throw new AuthError(400, `No price for ${f.countryCode} on this plan`);
    const provider = this.deps.providers().get(f.countryCode);
    if (!provider) throw new AuthError(503, `No billing provider is configured for ${f.countryCode}`);
    const existing = this.get(facilityId);
    const s = existing || this.save({ id: crypto.randomUUID(), facilityId, plan: plan.id, status: 'PENDING_PAYMENT', provider: provider.name, currentPeriodEnd: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: '' }, {});
    if (!existing) this.subs.set(facilityId, s);
    const started = await provider.startCheckout({ subscriptionId: s.id, facilityId, plan, amountMinor, currency, email: contact.email, phone: contact.phone, callbackBaseUrl });
    // An active or trial period keeps its status until the payment arrives.
    this.save(s, { plan: plan.id, provider: provider.name, providerRef: started.providerRef, ...(['TRIALING', 'ACTIVE'].includes(s.status) ? {} : { status: 'PENDING_PAYMENT' as const }) });
    this.audit('BILLING_CHECKOUT_STARTED', admin.id, facilityId, info, `Checkout for plan ${plan.id} started with ${provider.name}`);
    return { ...started, plan: plan.id, amountMinor, currency };
  }

  /** A provider webhook. Unauthenticated calls are rejected (401) and audited; nothing changes. */
  handleWebhook(providerName: 'paystack' | 'mpesa', rawBody: string, headers: Record<string, string | string[] | undefined>, pathSecret: string | undefined, info: RequestInfo, now = Date.now()) {
    const provider = [...this.deps.providers().values()].find((p) => p.name === providerName);
    if (!provider || !provider.verifyWebhook(rawBody, headers, pathSecret, now)) {
      this.deps.auditManager.appendEntry({ actorId: `webhook:${providerName}`, action: 'BILLING_WEBHOOK_REJECTED', accessType: 'SYSTEM_ADMIN', ipAddress: info.ipAddress, userAgent: info.userAgent, reason: 'Webhook signature or secret did not verify; ignored' });
      throw new AuthError(401, 'Invalid webhook signature');
    }
    const event: BillingEvent = provider.parseWebhook(rawBody);
    if (event.type === 'ignored') return { received: true, applied: false };
    const s = [...this.subs.values()].find((x) => x.providerRef && x.providerRef === event.providerRef);
    if (!s) return { received: true, applied: false };
    if (s.lastEventId === event.eventId) return { received: true, applied: false, duplicate: true };
    const f = this.deps.facilities.find((x) => x.id === s.facilityId);
    const plan = this.plans.plans.find((p) => p.id === s.plan)!;
    if (event.type === 'payment_succeeded') {
      const expected = plan.prices[f?.countryCode || ''];
      if (event.amountMinor !== undefined && expected !== undefined && event.amountMinor < expected) {
        this.audit('BILLING_PAYMENT_MISMATCH', `webhook:${providerName}`, s.facilityId, info, `Payment below the ${plan.id} price; subscription not changed`);
        return { received: true, applied: false };
      }
      const from = Math.max(now, Date.parse(s.currentPeriodEnd) || now);
      this.save(s, { status: 'ACTIVE', currentPeriodEnd: new Date(addMonth(from)).toISOString(), lastEventId: event.eventId });
      this.audit('BILLING_PAYMENT_RECEIVED', `webhook:${providerName}`, s.facilityId, info, `Payment for plan ${plan.id} received; active until ${s.currentPeriodEnd.slice(0, 10)}`);
    } else if (event.type === 'payment_failed') {
      this.save(s, { status: s.status === 'ACTIVE' ? 'PAST_DUE' : s.status, lastEventId: event.eventId });
      this.audit('BILLING_PAYMENT_FAILED', `webhook:${providerName}`, s.facilityId, info, `Payment failed (${event.reason || 'no reason given'}); emergency features unaffected`);
    } else if (event.type === 'subscription_cancelled') {
      this.save(s, { status: 'CANCELLED', lastEventId: event.eventId });
      this.audit('BILLING_SUBSCRIPTION_CANCELLED', `webhook:${providerName}`, s.facilityId, info, 'Subscription cancelled at the provider');
    }
    return { received: true, applied: true, status: s.status };
  }

  /** Test and operations helper: force a state (e.g. expire a period). */
  setForTest(facilityId: string, patch: Partial<Subscription>): Subscription | undefined {
    const s = this.subs.get(facilityId);
    return s ? this.save(s, patch) : undefined;
  }
}
