/**
 * MEDISTRY HL7 FHIR R4 Type Definitions
 * Standards-compliant shapes for Patient, Encounter, Condition, Observation,
 * AllergyIntolerance, MedicationStatement, Procedure, DocumentReference, and Bundle.
 */

export interface FHIRCoding {
  system: string; // e.g. "http://hl7.org/fhir/sid/icd-10", "http://snomed.info/sct", "http://www.nlm.nih.gov/research/umls/rxnorm"
  code: string;
  display: string;
}

export interface FHIRCodeableConcept {
  coding?: FHIRCoding[];
  text: string;
}

export interface FHIRReference {
  reference: string; // e.g. "Patient/patient-uuid", "Practitioner/clinician-uuid"
  display?: string;
}

export interface FHIRPeriod {
  start: string;
  end?: string;
}

// ---------------------------------------------------------------------------
// 1. Encounter (Clinical Visit / Admission)
// ---------------------------------------------------------------------------
export interface FHIREncounter {
  resourceType: 'Encounter';
  id: string;
  status: 'planned' | 'arrived' | 'triaged' | 'in-progress' | 'finished' | 'cancelled';
  class: {
    system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
    code: 'EMER' | 'IMP' | 'AMB'; // Emergency, Inpatient, Ambulatory
    display: string;
  };
  type?: FHIRCodeableConcept[];
  subject: FHIRReference; // Patient
  participant: Array<{
    individual: FHIRReference; // Clinician
  }>;
  period: FHIRPeriod;
  reasonCode?: FHIRCodeableConcept[];
  serviceProvider: FHIRReference; // Facility
}

// ---------------------------------------------------------------------------
// 2. Condition (Diagnosis / Clinical Problem)
// ---------------------------------------------------------------------------
export interface FHIRCondition {
  resourceType: 'Condition';
  id: string;
  clinicalStatus: {
    coding: Array<{
      system: 'http://terminology.hl7.org/CodeSystem/condition-clinical';
      code: 'active' | 'recurrence' | 'relapse' | 'remission' | 'resolved';
    }>;
  };
  verificationStatus: {
    coding: Array<{
      system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status';
      code: 'confirmed' | 'provisional' | 'differential' | 'refuted';
    }>;
  };
  category?: FHIRCodeableConcept[];
  severity?: FHIRCodeableConcept;
  code: FHIRCodeableConcept; // ICD-10 or clinical description
  subject: FHIRReference;
  encounter?: FHIRReference;
  onsetDateTime?: string;
  recordedDate: string;
  recorder: FHIRReference; // Clinician
}

// ---------------------------------------------------------------------------
// 3. Observation (Vitals, Lab Results, Telemetry)
// ---------------------------------------------------------------------------
export interface FHIRObservation {
  resourceType: 'Observation';
  id: string;
  status: 'registered' | 'preliminary' | 'final' | 'amended';
  category?: FHIRCodeableConcept[]; // 'vital-signs' | 'laboratory'
  code: FHIRCodeableConcept; // e.g. LOINC code or "Heart Rate", "Blood Oxygen"
  subject: FHIRReference;
  effectiveDateTime: string;
  valueQuantity?: {
    value: number;
    unit: string;
    system?: string;
    code?: string;
  };
  valueString?: string;
  interpretation?: FHIRCodeableConcept[];
  referenceRange?: Array<{
    low?: { value: number; unit: string };
    high?: { value: number; unit: string };
    text?: string;
  }>;
  performer: FHIRReference[]; // Clinician or Lab
}

// ---------------------------------------------------------------------------
// 4. AllergyIntolerance
// ---------------------------------------------------------------------------
export interface FHIRAllergyIntolerance {
  resourceType: 'AllergyIntolerance';
  id: string;
  clinicalStatus: {
    coding: Array<{
      system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
      code: 'active' | 'inactive' | 'resolved';
    }>;
  };
  verificationStatus: {
    coding: Array<{
      system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';
      code: 'confirmed' | 'unconfirmed' | 'refuted';
    }>;
  };
  type?: 'allergy' | 'intolerance';
  category?: Array<'food' | 'medication' | 'environment' | 'biologic'>;
  criticality: 'low' | 'high' | 'unable-to-assess';
  code: FHIRCodeableConcept; // Allergen (e.g. Penicillin, Sulfa)
  patient: FHIRReference;
  recordedDate: string;
  recorder: FHIRReference;
  reaction?: Array<{
    manifestation: FHIRCodeableConcept[]; // e.g. Anaphylaxis, Angioedema, Rash
    severity: 'mild' | 'moderate' | 'severe';
  }>;
}

// ---------------------------------------------------------------------------
// 5. MedicationStatement
// ---------------------------------------------------------------------------
export interface FHIRMedicationStatement {
  resourceType: 'MedicationStatement';
  id: string;
  status: 'active' | 'completed' | 'entered-in-error' | 'intended' | 'stopped' | 'on-hold';
  medicationCodeableConcept: FHIRCodeableConcept;
  subject: FHIRReference;
  effectivePeriod?: FHIRPeriod;
  dateAsserted: string;
  informationSource?: FHIRReference;
  dosage?: Array<{
    text: string;
    route?: FHIRCodeableConcept;
    timing?: {
      repeat?: {
        frequency?: number;
        period?: number;
        periodUnit?: 'h' | 'd' | 'wk';
      };
    };
    doseQuantity?: {
      value: number;
      unit: string;
    };
  }>;
}

// ---------------------------------------------------------------------------
// 6. Procedure
// ---------------------------------------------------------------------------
export interface FHIRProcedure {
  resourceType: 'Procedure';
  id: string;
  status: 'preparation' | 'in-progress' | 'not-done' | 'on-hold' | 'stopped' | 'completed';
  code: FHIRCodeableConcept; // Procedure name / code
  subject: FHIRReference;
  performedDateTime?: string;
  performer?: Array<{
    actor: FHIRReference;
  }>;
  reasonCode?: FHIRCodeableConcept[];
  outcome?: FHIRCodeableConcept;
}

// ---------------------------------------------------------------------------
// 7. DocumentReference (Scanned Reports, Referral Letters, PDFs)
// ---------------------------------------------------------------------------
export interface FHIRDocumentReference {
  resourceType: 'DocumentReference';
  id: string;
  status: 'current' | 'superseded' | 'entered-in-error';
  docStatus?: 'preliminary' | 'final' | 'amended';
  type: FHIRCodeableConcept; // e.g. "Discharge Summary", "Lab Report", "Radiology Scan"
  subject: FHIRReference;
  date: string;
  author: FHIRReference[];
  custodian?: FHIRReference; // Facility
  content: Array<{
    attachment: {
      contentType: string; // e.g. "application/pdf"
      url?: string;
      size: number;
      hash?: string; // SHA-256 checksum of original file
      title: string;
    };
  }>;
}

// ---------------------------------------------------------------------------
// 8. Bundle (Full Multi-Facility Record Export)
// ---------------------------------------------------------------------------
export interface FHIRBundleEntry<T = any> {
  fullUrl: string;
  resource: T;
}

export interface FHIRBundle {
  resourceType: 'Bundle';
  id: string;
  type: 'document' | 'collection';
  timestamp: string;
  total: number;
  entry: FHIRBundleEntry[];
}

