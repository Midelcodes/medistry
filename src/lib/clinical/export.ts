/**
 * MEDISTRY Patient Record Export Engine
 * Generates: (1) Standard HL7 FHIR R4 JSON Bundle, (2) Human-Readable Medical Summary Document.
 */

import crypto from 'node:crypto';
import { ClinicalDataStore } from './store.ts';
import { ClinicalTimelineEngine } from './timeline.ts';
import { decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
import type { ActorContext, ConsentContext, EmergencyGrantContext } from '../policy/enforcer.ts';
import type { FHIRBundle, FHIRBundleEntry } from '../fhir/types.ts';

export class RecordExportEngine {
  private clinicalStore: ClinicalDataStore;
  private timelineEngine: ClinicalTimelineEngine;

  constructor(
    clinicalStore: ClinicalDataStore,
    timelineEngine: ClinicalTimelineEngine
  ) {
    this.clinicalStore = clinicalStore;
    this.timelineEngine = timelineEngine;
  }

  /**
   * 1. Exports full patient record as a standard HL7 FHIR R4 JSON Bundle.
   */
  exportFhirBundle(
    patientId: string,
    actor: ActorContext,
    context: {
      consent?: ConsentContext | null;
      emergencyGrant?: EmergencyGrantContext | null;
    }
  ): FHIRBundle {
    const records = this.clinicalStore.getPatientRecords(patientId, actor, {
      consent: context.consent,
      emergencyGrant: context.emergencyGrant,
      includeHistoricalVersions: false,
    });

    const bundleEntries: FHIRBundleEntry[] = records.map(({ resource }) => ({
      fullUrl: `urn:uuid:${resource.id}`,
      resource,
    }));

    const bundle: FHIRBundle = {
      resourceType: 'Bundle',
      id: crypto.randomUUID(),
      type: 'document',
      timestamp: new Date().toISOString(),
      total: bundleEntries.length,
      entry: bundleEntries,
    };

    return bundle;
  }

  /**
   * 2. Generates a Human-Readable Medical Summary Report (PDF/Print ready HTML).
   */
  exportHumanReadableReport(
    patient: PatientEntity,
    actor: ActorContext,
    context: {
      consent?: ConsentContext | null;
      emergencyGrant?: EmergencyGrantContext | null;
    }
  ): string {
    const demographics = decryptPatientDemographics(patient);
    const timeline = this.timelineEngine.getTimeline(patient.id, actor, {
      consent: context.consent,
      emergencyGrant: context.emergencyGrant,
    });

    const contactsHtml = patient.emergencyContacts
      .map((c) => `<li><strong>${c.name}</strong> (${c.relationship}): ${c.phone}</li>`)
      .join('');

    const allergiesHtml = patient.allergies
      .map((a) => `<li style="color: #DC2626;"><strong>${a.substance}</strong> (${a.category}) - ${a.reaction} [${a.severity.toUpperCase()}]</li>`)
      .join('') || '<li>No known allergies on record</li>';

    const conditionsHtml = patient.chronicConditions
      .map((c) => `<li>${c}</li>`)
      .join('') || '<li>None recorded</li>';

    const medicationsHtml = patient.activeMedications
      .map((m) => `<li><strong>${m.medicationName}</strong>: ${m.dose} (${m.route}) - since ${m.sinceDate}</li>`)
      .join('') || '<li>No active regular medications</li>';

    const timelineHtml = timeline
      .map(
        (item) => `
        <div style="border-left: 3px solid #5B64E8; padding-left: 14px; margin-bottom: 16px;">
          <div style="font-size: 14px; font-weight: bold; color: #1E2038;">${item.title}</div>
          <div style="font-size: 12px; color: #4B5563;">${item.summary}</div>
          <div style="font-size: 11px; color: #5B64E8; font-weight: 600; margin-top: 4px;">📍 ${item.provenance.badgeStatement}</div>
        </div>
      `
      )
      .join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Medical Record Summary - ${demographics.firstName} ${demographics.lastName}</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1E2038; line-height: 1.5; padding: 32px; max-width: 800px; margin: 0 auto; }
    h1 { color: #5B64E8; font-size: 24px; border-bottom: 2px solid #5B64E8; padding-bottom: 8px; margin-bottom: 16px; }
    h2 { font-size: 16px; color: #374151; margin-top: 24px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: bold; margin-right: 6px; }
    .badge-blood { background: #FEE2E2; color: #991B1B; }
    .badge-genotype { background: #EDE9FE; color: #5B21B6; }
    .badge-dnr { background: #FEF3C7; color: #92400E; }
    .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #E5E7EB; font-size: 10px; color: #9CA3AF; text-align: center; }
  </style>
</head>
<body>
  <h1>MEDISTRY CLINICAL HEALTH SUMMARY</h1>
  <p style="font-size: 12px; color: #6B7280;">Export Generated on ${new Date().toUTCString()} • NDPA 2023 Compliant Health Export</p>

  <div>
    <strong>Patient:</strong> ${demographics.firstName} ${demographics.lastName} | 
    <strong>DOB:</strong> ${demographics.dateOfBirth} | 
    <strong>Gender:</strong> ${demographics.gender.toUpperCase()}
  </div>

  <div style="margin-top: 12px;">
    <span class="badge badge-blood">Blood Group: ${patient.bloodGroup.replace('_', ' ')}</span>
    <span class="badge badge-genotype">Genotype: ${patient.genotype}</span>
    ${patient.advanceDirectiveDnr ? '<span class="badge badge-dnr">DNR: ACTIVE</span>' : ''}
    ${patient.organDonor ? '<span class="badge" style="background:#D1FAE5;color:#065F46;">Organ Donor: YES</span>' : ''}
  </div>

  <h2>Emergency Contacts</h2>
  <ul>${contactsHtml}</ul>

  <h2>Allergies & Adverse Reactions</h2>
  <ul>${allergiesHtml}</ul>

  <h2>Chronic Conditions</h2>
  <ul>${conditionsHtml}</ul>

  <h2>Active Medications</h2>
  <ul>${medicationsHtml}</ul>

  <h2>Multi-Facility Clinical History & Provenance</h2>
  ${timelineHtml || '<p style="font-size: 12px; color: #6B7280;">No clinical events recorded yet.</p>'}

  <div class="footer">
    This clinical summary was compiled from verifiable FHIR R4 records via the Medistry Health Portability Network.
    Origin integrity guaranteed by cryptographic provenance seals.
  </div>
</body>
</html>
`.trim();
  }
}
