/**
 * EMR connectors (Phase 15): pull a patient's records from a facility's EMR and turn them into a FHIR collection
 * Bundle for the import pipeline (integrations/fhirImport.ts), so the same validation, matching, draft rules and
 * idempotency apply as for pushed bundles.
 */
export interface EmrPatientRef {
  /** The patient's id in the EMR (for OpenMRS: the patient UUID). */
  emrPatientId: string;
  /** The matched Medistry patient id (identity was established before pulling). */
  medistryPatientId: string;
}

export interface FhirCollectionBundle {
  resourceType: 'Bundle';
  type: 'collection';
  entry: Array<{ fullUrl?: string; resource: Record<string, any> }>;
}

export interface EmrConnector {
  /** Short name for logs and audit ("openmrs"). */
  readonly name: string;
  /** Records for one patient, changed since `since` (ISO date-time) if given, ready for FhirImportService. */
  pullPatientBundle(patient: EmrPatientRef, since?: string): Promise<FhirCollectionBundle>;
}
