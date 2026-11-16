/**
 * Facility API clients (Phase 15): machine credentials for a facility's EMR to push FHIR bundles.
 *
 * A facility admin creates a client and receives its secret once. The client exchanges clientId + secret for a
 * short-lived bearer token (OAuth 2.0 client-credentials style, POST /api/fhir/token). Only an scrypt hash of the
 * secret is kept; a revoked client's tokens stop working at once (checked on every request).
 */
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../auth/security.ts';
import { AuthError, type RequestInfo } from '../auth/patientAuth.ts';
import type { UserAccount } from '../auth/accounts.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';

export const API_CLIENT_SCOPES = ['fhir.import'] as const;
export type ApiClientScope = typeof API_CLIENT_SCOPES[number];
export const API_TOKEN_TTL_SECONDS = Math.min(3600, Math.max(60, parseInt(process.env.API_TOKEN_TTL_SECONDS || '300', 10) || 300));

export interface FacilityApiClient {
  id: string;
  facilityId: string;
  name: string;
  clientId: string;
  secretHash: string;
  scopes: ApiClientScope[];
  status: 'ACTIVE' | 'REVOKED';
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface FacilityApiClientRepo { saveFacilityApiClient(c: FacilityApiClient): void }

// A real secret hash for unknown client ids, so a miss costs the same scrypt time as a hit.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export class FacilityApiClientStore {
  private byId = new Map<string, FacilityApiClient>();
  private deps: { auditManager: AuditChainManager; facilities: Array<{ id: string }> };
  persistence?: FacilityApiClientRepo;

  constructor(deps: FacilityApiClientStore['deps']) {
    this.deps = deps;
  }

  hydrate(rows: FacilityApiClient[]): void {
    for (const c of rows) this.byId.set(c.id, c);
  }

  get(id: string): FacilityApiClient | undefined {
    return this.byId.get(id);
  }

  private byClientId(clientId: string): FacilityApiClient | undefined {
    for (const c of this.byId.values()) if (c.clientId === clientId) return c;
    return undefined;
  }

  private audit(action: string, actorId: string, facilityId: string, info: RequestInfo, reason: string): void {
    this.deps.auditManager.appendEntry({ actorId, action, accessType: 'SYSTEM_ADMIN', facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason });
  }

  private facilityFor(admin: UserAccount, requested: unknown): string {
    if (admin.role === 'FACILITY_ADMIN') {
      if (requested && requested !== admin.facilityId) throw new AuthError(403, 'Facility admins create clients for their own facility only');
      return admin.facilityId!;
    }
    if (admin.role === 'PLATFORM_ADMIN' && typeof requested === 'string' && this.deps.facilities.some((f) => f.id === requested)) return requested;
    throw new AuthError(400, 'Give the facilityId');
  }

  /** Creates a client. The secret is returned once and never stored in plain text. */
  async create(admin: UserAccount, body: any, info: RequestInfo): Promise<{ client: FacilityApiClient; clientSecret: string }> {
    const facilityId = this.facilityFor(admin, body.facilityId);
    const name = String(body.name || '').replace(/[^\w .()-]/g, '').trim().slice(0, 80);
    if (name.length < 3) throw new AuthError(400, 'Give the client a name (the EMR system it is for)');
    const scopes = Array.isArray(body.scopes) && body.scopes.length ? [...new Set(body.scopes)] : ['fhir.import'];
    if (!scopes.every((s) => API_CLIENT_SCOPES.includes(s as ApiClientScope))) throw new AuthError(400, `scopes must be among ${API_CLIENT_SCOPES.join(', ')}`);
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    const client: FacilityApiClient = {
      id: crypto.randomUUID(), facilityId, name, clientId: `mdc_${crypto.randomBytes(12).toString('hex')}`, secretHash: await hashPassword(clientSecret),
      scopes: scopes as ApiClientScope[], status: 'ACTIVE', createdBy: admin.id, createdAt: new Date().toISOString(),
    };
    this.byId.set(client.id, client);
    this.persistence?.saveFacilityApiClient(client);
    this.audit('API_CLIENT_CREATED', admin.id, facilityId, info, `API client ${client.clientId} (${name}) created with scopes ${client.scopes.join(', ')}`);
    return { client, clientSecret };
  }

  revoke(admin: UserAccount, id: string, info: RequestInfo): FacilityApiClient {
    const c = this.byId.get(id);
    if (!c || (admin.role === 'FACILITY_ADMIN' && c.facilityId !== admin.facilityId)) throw new AuthError(404, 'API client not found');
    if (admin.role !== 'FACILITY_ADMIN' && admin.role !== 'PLATFORM_ADMIN') throw new AuthError(403, 'Admins only');
    c.status = 'REVOKED';
    this.persistence?.saveFacilityApiClient(c);
    this.audit('API_CLIENT_REVOKED', admin.id, c.facilityId, info, `API client ${c.clientId} revoked`);
    return c;
  }

  list(admin: UserAccount) {
    return [...this.byId.values()]
      .filter((c) => admin.role === 'PLATFORM_ADMIN' || c.facilityId === admin.facilityId)
      .map(({ secretHash: _hidden, ...c }) => c);
  }

  /** Client-credentials check (constant time whether or not the client exists). Returns the active client or null. */
  async authenticate(clientId: unknown, clientSecret: unknown, info: RequestInfo): Promise<FacilityApiClient | null> {
    const c = typeof clientId === 'string' ? this.byClientId(clientId) : undefined;
    const ok = await verifyPassword(typeof clientSecret === 'string' ? clientSecret.slice(0, 200) : '', c ? c.secretHash : await DUMMY_HASH);
    if (!c || !ok || c.status !== 'ACTIVE') return null;
    c.lastUsedAt = new Date().toISOString();
    this.persistence?.saveFacilityApiClient(c);
    this.audit('API_TOKEN_ISSUED', `api-client:${c.clientId}`, c.facilityId, info, `Access token issued (${API_TOKEN_TTL_SECONDS}s, scopes ${c.scopes.join(', ')})`);
    return c;
  }
}
