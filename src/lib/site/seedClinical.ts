/**
 * Populates the in-memory clinical store with synthetic FHIR R4 records so the
 * patient timeline and clinician views have data to show.
 * Synthetic data only. Writes go through the normal policy engine using a
 * seeded, facility-scoped consent for the authoring clinician.
 */

import type { ClinicalDataStore } from '../clinical/store.ts';
import type { PatientEntity } from '../patient/profile.ts';
import type { SeedClinician, SeedFacility, SeedEncounter } from '../../../prisma/seed.ts';
import { ENCOUNTER_TREATMENT_EXTENSION } from '../clinical/encounters.ts';
import type { ActorContext, ConsentContext } from '../policy/enforcer.ts';

const DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

export function seedClinicalRecords(
  store: ClinicalDataStore,
  patients: PatientEntity[],
  clinicians: SeedClinician[],
  facilities: SeedFacility[],
  encountersByPatient?: Map<string, SeedEncounter[]>
): void {
  patients.forEach((patient, index) => {
    const primaryFacility = facilities.find((f) => f.id === patient.primaryFacilityId) || facilities[0];
    const otherFacility = facilities.find((f) => f.id !== primaryFacility.id) || primaryFacility;
    const author = clinicians.find((c) => c.facilityId === primaryFacility.id) || clinicians[0];
    const otherAuthor = clinicians.find((c) => c.facilityId === otherFacility.id) || author;

    const ref = { reference: `Patient/${patient.id}` };
    const write = (clinician: SeedClinician, facility: SeedFacility, resource: any, category?: string, source?: 'clinician' | 'patient-reported') => {
      const actor: ActorContext = {
        userId: clinician.userId,
        role: 'DOCTOR',
        clinicianId: clinician.id,
        facilityId: facility.id,
        isVerifiedClinician: true,
      };
      const consent: ConsentContext = {
        id: `seed-consent-${patient.id}-${clinician.id}`,
        patientId: patient.id,
        targetClinicianId: clinician.id,
        targetFacilityId: facility.id,
        scopes: ['all'],
        validUntil: new Date(Date.now() + DAY),
        isRevoked: false,
      };
      store.writeRecord(patient.id, resource, actor, { consent, facilityId: facility.id, category, source });
    };

    const recorder = { reference: `Practitioner/${author.id}`, display: author.fullName };

    patient.chronicConditions.forEach((name, i) => {
      const when = isoDaysAgo(900 + i * 120 + index * 7);
      write(author, primaryFacility, {
        resourceType: 'Condition',
        id: crypto.randomUUID(),
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
        code: { text: name },
        subject: ref,
        onsetDateTime: when,
        recordedDate: when,
        recorder,
      });
    });

    patient.allergies.forEach((a, i) => {
      const reported = a.source === 'patient-reported';
      write(author, primaryFacility, {
        resourceType: 'AllergyIntolerance',
        id: crypto.randomUUID(),
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: reported ? 'unconfirmed' : 'confirmed' }] },
        type: 'allergy',
        category: [a.category === 'drug' ? 'medication' : a.category === 'food' ? 'food' : 'environment'],
        criticality: a.severity === 'severe' ? 'high' : 'low',
        code: { text: a.substance },
        patient: ref,
        recordedDate: isoDaysAgo(700 + i * 90),
        recorder,
        reaction: [{ manifestation: [{ text: a.reaction }], severity: a.severity }],
      }, undefined, reported ? 'patient-reported' : 'clinician');
    });

    patient.activeMedications.forEach((m, i) => {
      write(author, primaryFacility, {
        resourceType: 'MedicationStatement',
        id: crypto.randomUUID(),
        status: 'active',
        medicationCodeableConcept: { text: m.medicationName },
        subject: ref,
        dateAsserted: m.sinceDate || isoDaysAgo(300 + i * 30),
        effectiveDateTime: m.sinceDate || isoDaysAgo(300 + i * 30),
        dosage: [{ text: `${m.dose} (${m.route})` }],
      });
    });

    // Encounters: the patient's own synthetic visits when given (with diagnosis, treatment and outcome),
    // otherwise two generic visits at two hospitals so the timeline shows multi-facility provenance.
    const CLASS_DISPLAY = { EMER: 'Emergency', AMB: 'Ambulatory', IMP: 'Inpatient' } as const;
    const given = encountersByPatient?.get(patient.id);
    const visits: Array<{ clin: SeedClinician; fac: SeedFacility; daysAgo: number; code: 'EMER' | 'AMB' | 'IMP'; reason: string; diagnosis?: string; treatment?: string; result?: string }> = given
      ? given.map((e) => {
        const fac = facilities.find((f) => f.id === e.facilityId) || primaryFacility;
        const clin = clinicians.find((c) => c.facilityId === fac.id) || author;
        return { clin, fac, daysAgo: e.daysAgo, code: e.classCode, reason: e.reason, diagnosis: e.diagnosis, treatment: e.treatment, result: e.result };
      })
      : [
        { clin: author, fac: primaryFacility, daysAgo: 210 + index * 3, code: 'AMB', reason: 'Routine specialist review' },
        { clin: otherAuthor, fac: otherFacility, daysAgo: 45 + index, code: 'EMER', reason: 'Acute presentation, stabilised and discharged' },
      ];
    visits.forEach(({ clin, fac, daysAgo, code, reason, diagnosis, treatment, result }) => {
      const when = isoDaysAgo(daysAgo);
      write(clin, fac, {
        resourceType: 'Encounter',
        id: crypto.randomUUID(),
        status: 'finished',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code, display: CLASS_DISPLAY[code] },
        subject: ref,
        participant: [{ individual: { reference: `Practitioner/${clin.id}`, display: clin.fullName } }],
        period: { start: when },
        effectiveDateTime: when,
        reasonCode: [{ text: reason }],
        ...(diagnosis ? { diagnosis: [{ condition: { reference: `Condition/${crypto.randomUUID()}`, display: diagnosis }, rank: 1 }] } : {}),
        ...(result ? { hospitalization: { dischargeDisposition: { text: result } } } : {}),
        ...(treatment ? { extension: [{ url: ENCOUNTER_TREATMENT_EXTENSION, valueString: treatment }] } : {}),
        serviceProvider: { reference: `Organization/${fac.id}`, display: fac.name },
      }, undefined, 'clinician');
    });

    const labs: Array<[number, number, string]> = [
      [200 + index, 9.1 + (index % 4) * 0.4, 'Hemoglobin'],
      [40 + index, 8.7 + (index % 3) * 0.5, 'Hemoglobin'],
    ];
    labs.forEach(([daysAgo, value, label], i) => {
      const clin = i === 0 ? author : otherAuthor;
      const fac = i === 0 ? primaryFacility : otherFacility;
      write(clin, fac, {
        resourceType: 'Observation',
        id: crypto.randomUUID(),
        status: 'final',
        category: [{ text: 'laboratory' }],
        code: { text: label },
        subject: ref,
        effectiveDateTime: isoDaysAgo(daysAgo),
        valueQuantity: { value: Number(value.toFixed(1)), unit: 'g/dL' },
        performer: [{ reference: `Practitioner/${clin.id}`, display: clin.fullName }],
      }, 'laboratory');
    });
  });
}
