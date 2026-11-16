/**
 * National health information exchange (HIE) connectors (Phase 17). Adapters and sandboxes only: no live
 * government calls are made by tests, and nothing here is wired to a real agency yet.
 *
 *   KenyaShrConnector     Kenya shared health record, through the Digital Health Agency's exchange.
 *   NigeriaHieConnector   Nigeria NDHI health information exchange.
 *
 * TODO (both): obtain sandbox access and conformance requirements from the agency (base URL, authentication,
 * facility identification, profiles, which FHIR interactions are supported). No agency endpoints are invented here:
 * the base URL, credentials, facility code and the patient identifier system all come from configuration, and the
 * calls are plain FHIR R4 REST interactions relative to that base URL:
 *   pushRecord           POST [base]/[resourceType]                      (FHIR "create")
 *   queryPatientSummary  GET  [base]/Patient?identifier=[system]|[value] (FHIR search), then
 *                        GET  [base]/Patient/[id]/$everything            (FHIR R4 Patient $everything operation)
 * Whether the agency supports exactly these must be confirmed during onboarding.
 */
export interface HieIdentity {
  country: string;
  idType: string;
  idNumber: string;
  medistryPatientId: string;
}

export interface HieStatus {
  name: string;
  country: string;
  configured: boolean;
  baseUrl: string | null;          // shown to admins (no credentials)
  facilityCode: string | null;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

export interface HieConnector {
  readonly name: string;
  readonly country: string;
  /** Sends one FHIR resource (subject already expressed by national identifier). Returns the remote id if given. */
  pushRecord(fhirResource: Record<string, any>): Promise<{ remoteId?: string }>;
  /** The patient's records held by the exchange (never merged into Medistry's record by the caller). */
  queryPatientSummary(identity: HieIdentity): Promise<{ resources: Array<Record<string, any>> }>;
  getStatus(): HieStatus;
  /** FHIR identifier system the exchange uses for this ID type (from config), or null if not configured. */
  patientIdentifierSystem(idType: string): string | null;
}

/** The connector cannot be used (not configured). Not retryable. */
export class HieNotConfigured extends Error {
  retryable = false;
}

/** A transient failure (network, 5xx, 429): the outbox retries. */
export class HieTransientError extends Error {
  retryable = true;
}

export interface FhirHieConfig {
  baseUrl?: string;
  accessToken?: string;           // TODO: replace with the agency's authentication once known (client credentials, mTLS...)
  facilityCode?: string;          // TODO: how the agency expects the submitting facility to be identified
  identifierSystems: Record<string, string>; // idType -> FHIR identifier system URI, from config only
}

/** Reads <PREFIX>BASE_URL, <PREFIX>ACCESS_TOKEN, <PREFIX>FACILITY_CODE, <PREFIX>ID_SYSTEM_<IDTYPE> (e.g. HIE_KE_ID_SYSTEM_NATIONAL_ID). */
export function hieConfigFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): FhirHieConfig {
  const identifierSystems: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = new RegExp(`^${prefix}ID_SYSTEM_([A-Z_]+)$`).exec(k);
    if (m && v) identifierSystems[m[1]] = v.trim();
  }
  const baseUrl = (env[`${prefix}BASE_URL`] || '').trim().replace(/\/+$/, '');
  return {
    baseUrl: /^https:\/\//.test(baseUrl) ? baseUrl : undefined, // HTTPS only
    accessToken: (env[`${prefix}ACCESS_TOKEN`] || '').trim() || undefined,
    facilityCode: (env[`${prefix}FACILITY_CODE`] || '').trim() || undefined,
    identifierSystems,
  };
}

/** A generic FHIR R4 client behind the HieConnector interface. Country connectors configure it. */
export class FhirHieConnector implements HieConnector {
  readonly name: string;
  readonly country: string;
  protected config: FhirHieConfig;
  private fetchImpl: typeof fetch;
  private status: { lastSuccessAt?: string; lastErrorAt?: string; lastError?: string } = {};

  constructor(name: string, country: string, config: FhirHieConfig, opts: { fetch?: typeof fetch } = {}) {
    this.name = name;
    this.country = country;
    this.config = config;
    this.fetchImpl = opts.fetch || fetch;
  }

  patientIdentifierSystem(idType: string): string | null {
    return this.config.identifierSystems[idType] || null;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    if (!this.config.baseUrl) throw new HieNotConfigured(`${this.name} is not configured (no HTTPS base URL)`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/fhir+json',
          ...(body ? { 'Content-Type': 'application/fhir+json' } : {}),
          ...(this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      throw this.fail(new HieTransientError(`network error (${String(err?.name || 'error').slice(0, 40)})`));
    }
    if (res.status === 429 || res.status >= 500) throw this.fail(new HieTransientError(`HTTP ${res.status}`));
    if (!res.ok) {
      // 4xx: the exchange refused the content; retrying the same message will not help.
      const e = new Error(`HTTP ${res.status}`) as Error & { retryable: boolean };
      e.retryable = false;
      throw this.fail(e);
    }
    this.status.lastSuccessAt = new Date().toISOString();
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  private fail<E extends Error>(err: E): E {
    this.status.lastErrorAt = new Date().toISOString();
    this.status.lastError = err.message.slice(0, 120); // never a response body (could hold health data)
    return err;
  }

  async pushRecord(fhirResource: Record<string, any>): Promise<{ remoteId?: string }> {
    const type = String(fhirResource.resourceType || '');
    if (!/^[A-Z][A-Za-z]{2,40}$/.test(type)) throw new Error('Not a FHIR resource');
    const created = await this.request('POST', `/${type}`, fhirResource);
    return { remoteId: typeof created?.id === 'string' ? created.id.slice(0, 100) : undefined };
  }

  async queryPatientSummary(identity: HieIdentity): Promise<{ resources: Array<Record<string, any>> }> {
    const system = this.patientIdentifierSystem(identity.idType);
    if (!system) throw new HieNotConfigured(`${this.name} has no identifier system configured for ${identity.idType}`);
    const found = await this.request('GET', `/Patient?identifier=${encodeURIComponent(`${system}|${identity.idNumber}`)}`);
    const patientId = found?.entry?.find((e: any) => e?.resource?.resourceType === 'Patient')?.resource?.id;
    if (!patientId) return { resources: [] };
    const everything = await this.request('GET', `/Patient/${encodeURIComponent(patientId)}/$everything`);
    return { resources: (everything?.entry || []).map((e: any) => e?.resource).filter((r: any) => r && typeof r === 'object') };
  }

  getStatus(): HieStatus {
    return {
      name: this.name, country: this.country, configured: !!this.config.baseUrl, baseUrl: this.config.baseUrl || null,
      facilityCode: this.config.facilityCode || null, ...this.status,
    };
  }
}

/** Kenya shared health record (Digital Health Agency exchange). TODO: sandbox access and conformance requirements from the agency. */
export class KenyaShrConnector extends FhirHieConnector {
  constructor(config = hieConfigFromEnv('HIE_KE_'), opts: { fetch?: typeof fetch } = {}) {
    super('kenya-shr', 'KE', config, opts);
  }
}

/** Nigeria NDHI health information exchange. TODO: sandbox access and conformance requirements from the agency. */
export class NigeriaHieConnector extends FhirHieConnector {
  constructor(config = hieConfigFromEnv('HIE_NG_'), opts: { fetch?: typeof fetch } = {}) {
    super('nigeria-ndhi', 'NG', config, opts);
  }
}

/** Connectors by country (one per deployment country in practice). */
export function createHieConnectors(env: NodeJS.ProcessEnv = process.env): Map<string, HieConnector> {
  return new Map<string, HieConnector>([
    ['KE', new KenyaShrConnector(hieConfigFromEnv('HIE_KE_', env))],
    ['NG', new NigeriaHieConnector(hieConfigFromEnv('HIE_NG_', env))],
  ]);
}
