/**
 * MEDISTRY Recent Encounters: one source for the emergency summary and the offline card's recent diagnosis.
 * Reads the patient's latest, doctor-SIGNED Encounter records (drafts never count), newest first.
 * Missing fields read "Not recorded"; nothing is invented.
 *
 * Callers must already be authorised for this patient: the emergency summary checks its break-glass grant,
 * and the card is built for the patient themself. This read is not separately audited.
 */
import type { ClinicalDataStore } from './store.ts';
import type { FHIREncounter } from '../fhir/types.ts';

export const NOT_RECORDED = 'Not recorded';

// FHIR R4 Encounter has no treatment field, so a short treatment summary is carried in an extension.
// TODO: replace this placeholder canonical URL with the project's own FHIR profile base before production.
export const ENCOUNTER_TREATMENT_EXTENSION = 'https://medistry.example/fhir/StructureDefinition/encounter-treatment';

export interface EncounterSummary {
  date: string;
  facilityName: string;
  doctorName: string;
  diagnosis: string;
  treatment: string;
  result: string;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : NOT_RECORDED);

/** The encounter's diagnosis text (Encounter.diagnosis[0].condition.display), or undefined. */
export function encounterDiagnosis(e: Partial<FHIREncounter> | undefined): string | undefined {
  const sorted = [...(e?.diagnosis || [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const d = sorted[0]?.condition?.display;
  return typeof d === 'string' && d.trim() ? d.trim() : undefined;
}

function toSummary(e: FHIREncounter, fallbackDate: string): EncounterSummary {
  return {
    date: text(String(e.period?.start || fallbackDate || '').slice(0, 10)),
    facilityName: text(e.serviceProvider?.display),
    doctorName: text(e.participant?.[0]?.individual?.display),
    diagnosis: text(encounterDiagnosis(e)),
    treatment: text(e.extension?.find((x) => x.url === ENCOUNTER_TREATMENT_EXTENSION)?.valueString),
    result: text(e.hospitalization?.dischargeDisposition?.text),
  };
}

/** The patient's most recent signed encounters, newest first (empty if none). */
export function recentEncounters(store: ClinicalDataStore, patientId: string, limit = 5): EncounterSummary[] {
  return store.getLatestFinalRecords(patientId, 'Encounter')
    .map(({ record, resource }) => ({ when: String((resource as FHIREncounter).period?.start || record.effectiveDate), record, resource: resource as FHIREncounter }))
    .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
    .slice(0, limit)
    .map(({ record, resource }) => toSummary(resource, record.effectiveDate));
}

/**
 * The card's "most recent diagnosis": the diagnosis of the newest signed encounter, the same row the emergency
 * summary shows first. Null if the newest encounter has no recorded diagnosis or there are no encounters.
 */
export function latestDiagnosisForCard(store: ClinicalDataStore, patientId: string): { t: string; d: string } | null {
  const [newest] = recentEncounters(store, patientId, 1);
  return newest && newest.diagnosis !== NOT_RECORDED ? { t: newest.diagnosis, d: newest.date } : null;
}
