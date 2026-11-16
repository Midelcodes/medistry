/**
 * OpenMRS connector (stub; KenyaEMR is built on OpenMRS). Pulls through the OpenMRS FHIR module (fhir2).
 *
 * From the OpenMRS FHIR implementation guide (https://fhir.openmrs.org/, artifacts page, read for this phase):
 *   - search URLs have the form /ws/fhir2/{release}/<Resource>?..., one example with the /openmrs prefix
 *     ("/openmrs/ws/fhir2/{release}/Condition?_lastUpdated={date}"); the module is based on FHIR R4 (4.0.1);
 *   - patient-scoped searches: Encounter?patient={uuid}, Observation?patient={uuid}, Condition?patient={uuid},
 *     AllergyIntolerance?patient={uuid}, MedicationRequest?patient={uuid}; _lastUpdated is listed for these;
 *   - medications are exported as MedicationRequest (MedicationStatement is not in the module's resource list);
 *   - Encounter maps onto both OpenMRS Encounter and Visit; Condition maps onto Condition and Diagnosis.
 * Not documented in the pages that could be read, so configurable or marked TODO here:
 *   - authentication (HTTP Basic is used, as configured; TODO: confirm per site, or use a session/OAuth setup),
 *   - paging (the standard FHIR Bundle link rel="next" is followed; TODO: confirm on the target server),
 *   - DiagnosticReport search parameters (patient={uuid} is assumed like the other resources; TODO: confirm),
 *   - concept code systems (CIEL or local concept codes are passed through unchanged; TODO: site mapping),
 *   - encounter class (not part of the documented search; taken from config; TODO: map encounter types per site).
 *
 * Config: OPENMRS_BASE_URL (server root, e.g. https://emr.example.org/openmrs), OPENMRS_USERNAME, OPENMRS_PASSWORD.
 * No live calls in tests: a fetch implementation is injected.
 */
import type { EmrConnector, EmrPatientRef, FhirCollectionBundle } from './EmrConnector.ts';

export interface OpenMrsConfig {
  baseUrl: string;
  username: string;
  password: string;
  /** FHIR release path segment (R4). */
  release?: string;
  /** Encounter.class when the server sends none. TODO: map OpenMRS encounter types to v3 ActCode classes per site. */
  defaultEncounterClass?: { system: string; code: string; display?: string };
  /** OpenMRS provider/practitioner UUID -> Medistry clinician id. TODO: populate per site. */
  practitionerMap?: Record<string, string>;
  /** Maximum pages followed per resource type (safety limit). */
  maxPages?: number;
}

export function openMrsConfig(env: NodeJS.ProcessEnv = process.env): OpenMrsConfig {
  const baseUrl = (env.OPENMRS_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl) || !env.OPENMRS_USERNAME || !env.OPENMRS_PASSWORD) {
    throw new Error('OpenMRS connector needs OPENMRS_BASE_URL (http/https), OPENMRS_USERNAME and OPENMRS_PASSWORD');
  }
  return { baseUrl, username: env.OPENMRS_USERNAME, password: env.OPENMRS_PASSWORD };
}

// Resource types pulled, in this order. MedicationRequest is mapped to MedicationStatement for import.
export const OPENMRS_PULL_TYPES = ['Encounter', 'Condition', 'AllergyIntolerance', 'Observation', 'MedicationRequest', 'DiagnosticReport'] as const;

// MedicationRequest.status -> MedicationStatement.status (FHIR R4 value sets).
const MED_STATUS: Record<string, string> = {
  active: 'active', 'on-hold': 'on-hold', cancelled: 'stopped', completed: 'completed', 'entered-in-error': 'entered-in-error',
  stopped: 'stopped', draft: 'intended', unknown: 'unknown',
};

export class OpenMrsConnector implements EmrConnector {
  readonly name = 'openmrs';
  private config: OpenMrsConfig;
  private fetchImpl: typeof fetch;

  constructor(config: OpenMrsConfig, opts: { fetch?: typeof fetch } = {}) {
    this.config = config;
    this.fetchImpl = opts.fetch || fetch;
  }

  private get fhirBase(): string {
    return `${this.config.baseUrl}/ws/fhir2/${this.config.release || 'R4'}`;
  }

  /** GET with HTTP Basic, following Bundle link rel="next" (bounded). Never logs credentials or responses. */
  private async search(resourceType: string, params: URLSearchParams): Promise<any[]> {
    const auth = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`;
    const resources: any[] = [];
    let url: string | undefined = `${this.fhirBase}/${resourceType}?${params}`;
    for (let page = 0; url && page < (this.config.maxPages ?? 20); page++) {
      const res = await this.fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`OpenMRS ${resourceType} search failed (HTTP ${res.status})`);
      const bundle: any = await res.json();
      for (const e of bundle?.entry || []) if (e?.resource?.resourceType === resourceType) resources.push(e.resource);
      const next = (bundle?.link || []).find((l: any) => l?.relation === 'next')?.url;
      // Only follow next links on the same server (never let a response redirect credentials elsewhere).
      url = typeof next === 'string' && next.startsWith(this.config.baseUrl) ? next : undefined;
    }
    return resources;
  }

  /** Maps one OpenMRS FHIR resource to what the import pipeline accepts. Exported for tests. */
  mapResource(r: any, patient: EmrPatientRef): Record<string, any> | null {
    const out: any = structuredClone(r);
    delete out.meta;
    delete out.text; // narrative HTML from the source is not imported
    // Stable identity for idempotent re-imports: keep source identifiers, else the OpenMRS UUID.
    if (!Array.isArray(out.identifier) || !out.identifier.some((i: any) => i?.value)) {
      out.identifier = [{ system: `${this.fhirBase}/${r.resourceType}`, value: r.id }];
    }
    const subject = { reference: `Patient/${patient.medistryPatientId}` };
    const practitioner = (ref: any) => {
      const uuid = typeof ref?.reference === 'string' ? ref.reference.split('/').pop() : undefined;
      const clinicianId = uuid ? this.config.practitionerMap?.[uuid] : undefined;
      return clinicianId ? { reference: `Practitioner/${clinicianId}` } : undefined;
    };
    switch (r.resourceType) {
      case 'Encounter':
        out.subject = subject;
        if (!out.class?.code) out.class = this.config.defaultEncounterClass || { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' };
        out.participant = (r.participant || []).map((p: any) => ({ ...p, individual: practitioner(p.individual) })).filter((p: any) => p.individual);
        delete out.location; // OpenMRS location UUIDs mean nothing here; the importing facility is the origin
        break;
      case 'Condition':
        out.subject = subject;
        out.recorder = practitioner(r.recorder);
        delete out.encounter;
        break;
      case 'AllergyIntolerance':
        out.patient = subject;
        out.recorder = practitioner(r.recorder);
        break;
      case 'Observation':
      case 'DiagnosticReport':
        out.subject = subject;
        out.performer = (r.performer || []).map(practitioner).filter(Boolean);
        delete out.encounter;
        delete out.result; // references to Observations by OpenMRS id; those are imported on their own
        delete out.hasMember;
        break;
      case 'MedicationRequest': {
        // Exported as MedicationRequest; Medistry files current medications as MedicationStatement.
        const concept = r.medicationCodeableConcept || (r.medicationReference?.display ? { text: r.medicationReference.display } : undefined);
        if (!concept) return null; // TODO: resolve medicationReference via the Medication resource per site
        return {
          resourceType: 'MedicationStatement', identifier: out.identifier, status: MED_STATUS[r.status] || 'unknown',
          medicationCodeableConcept: concept, subject, effectiveDateTime: r.authoredOn, dateAsserted: r.authoredOn,
          dosage: (r.dosageInstruction || []).slice(0, 1).map((d: any) => ({ text: d.text || 'as directed' })),
          informationSource: practitioner(r.requester),
        };
      }
      default:
        return null;
    }
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  async pullPatientBundle(patient: EmrPatientRef, since?: string): Promise<FhirCollectionBundle> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(patient.emrPatientId)) throw new Error('Invalid OpenMRS patient UUID');
    const entry: FhirCollectionBundle['entry'] = [];
    for (const type of OPENMRS_PULL_TYPES) {
      const params = new URLSearchParams({ patient: patient.emrPatientId });
      if (since) params.set('_lastUpdated', `ge${since}`);
      for (const r of await this.search(type, params)) {
        const mapped = this.mapResource(r, patient);
        if (mapped) entry.push({ resource: mapped });
      }
    }
    return { resourceType: 'Bundle', type: 'collection', entry };
  }
}
