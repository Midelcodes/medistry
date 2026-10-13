/**
 * MEDISTRY Multi-Facility Chronological Timeline Engine
 * Aggregates clinical events across multiple hospitals into a single unified timeline
 * with strict provenance badges and multi-criteria filtering.
 */

import { ClinicalDataStore, type AnyClinicalFHIRResource, type StoredClinicalRecord } from './store.ts';
import type { ActorContext, ConsentContext, EmergencyGrantContext } from '../policy/enforcer.ts';

export interface TimelineProvenance {
  authorClinicianId: string;
  authorName: string;
  originFacilityId: string;
  facilityName: string;
  countryCode: string;
  timestamp: string;
  badgeStatement: string; // e.g. "Diagnosed by Dr. Elena Rostova, Lagoon Hospital, Lagos (NG) on 12 Mar 2026"
}

export interface TimelineItem {
  id: string;
  versionId: number;
  resourceType: string;
  category?: string;
  title: string;
  summary: string;
  effectiveDate: string;
  provenance: TimelineProvenance;
  resource: AnyClinicalFHIRResource;
}

export interface TimelineFilterOptions {
  resourceType?: string;     // e.g. 'Condition' | 'Encounter' | 'MedicationStatement'
  facilityId?: string;       // Filter by specific hospital
  category?: string;         // e.g. 'vital-signs' | 'laboratory'
  startDate?: string;        // ISO date
  endDate?: string;          // ISO date
}

export class ClinicalTimelineEngine {
  // Facility and Clinician directory for provenance metadata resolution
  private facilityDirectory = new Map<string, string>([
    ['facility-lagos-1', 'Lagos University Teaching Hospital (LUTH)'],
    ['facility-abuja-1', 'National Hospital Abuja'],
    ['facility-ibadan-1', 'University College Hospital (UCH) Ibadan'],
  ]);

  private clinicianDirectory = new Map<string, string>([
    ['doc-uuid-1', 'Dr. Robert Caldwell, MD (Cardiothoracic)'],
    ['doc-uuid-2', 'Dr. Elena Rostova, MD, PhD (Neurology)'],
    ['doc-uuid-3', 'Dr. Marcus Thorne, MD (Emergency Critical Care)'],
    ['doc-uuid-4', 'Dr. Amina Bello, MBBS (Pediatrics)'],
  ]);
  private clinicalStore: ClinicalDataStore;

  constructor(clinicalStore: ClinicalDataStore) {
    this.clinicalStore = clinicalStore;
  }

  /**
   * Registers a facility name in the directory.
   */
  registerFacility(facilityId: string, name: string) {
    this.facilityDirectory.set(facilityId, name);
  }

  /**
   * Registers a clinician name in the directory.
   */
  registerClinician(clinicianId: string, name: string) {
    this.clinicianDirectory.set(clinicianId, name);
  }

  /**
   * Resolves a clinical resource into a human-friendly title and summary.
   */
  private formatResourceDisplay(resource: AnyClinicalFHIRResource): { title: string; summary: string } {
    switch (resource.resourceType) {
      case 'Condition': {
        const title = `Diagnosis: ${resource.code.text || 'Clinical Condition'}`;
        const status = resource.clinicalStatus?.coding?.[0]?.code || 'active';
        return { title, summary: `Status: ${status.toUpperCase()} • Recorded: ${resource.recordedDate}` };
      }
      case 'Encounter': {
        const title = `Hospital Visit: ${resource.class.display || 'Clinical Encounter'}`;
        const reason = resource.reasonCode?.[0]?.text || 'General Clinical Consultation';
        return { title, summary: `Reason: ${reason} • Status: ${resource.status}` };
      }
      case 'Observation': {
        const val = resource.valueQuantity ? `${resource.valueQuantity.value} ${resource.valueQuantity.unit}` : resource.valueString || 'Recorded';
        const title = `Observation: ${resource.code.text}`;
        return { title, summary: `Value: ${val} • Effective: ${resource.effectiveDateTime}` };
      }
      case 'AllergyIntolerance': {
        const title = `Allergy: ${resource.code.text}`;
        const reactions = resource.reaction?.map((r) => r.manifestation?.[0]?.text).filter(Boolean).join(', ');
        return { title, summary: `Criticality: ${resource.criticality.toUpperCase()} • Reactions: ${reactions || 'Reported'}` };
      }
      case 'MedicationStatement': {
        const title = `Medication: ${resource.medicationCodeableConcept.text}`;
        const dose = resource.dosage?.[0]?.text || 'Dose as directed';
        return { title, summary: `${dose} • Status: ${resource.status}` };
      }
      case 'Procedure': {
        const title = `Procedure: ${resource.code.text}`;
        return { title, summary: `Status: ${resource.status} • Performed: ${resource.performedDateTime || 'Completed'}` };
      }
      case 'DocumentReference': {
        const title = `Document: ${resource.type.text}`;
        const docTitle = resource.content?.[0]?.attachment?.title || 'Clinical Report';
        return { title, summary: `${docTitle} (${resource.content?.[0]?.attachment?.contentType})` };
      }
      default:
        return { title: 'Clinical Record', summary: 'HL7 FHIR Record Entry' };
    }
  }

  /**
   * Formats dates nicely for provenance badges.
   */
  private formatDate(isoDate: string): string {
    try {
      const d = new Date(isoDate);
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return isoDate;
    }
  }

  /**
   * Generates the multi-facility chronological timeline with filters and provenance badges.
   */
  getTimeline(
    patientId: string,
    actor: ActorContext,
    context: {
      consent?: ConsentContext | null;
      emergencyGrant?: EmergencyGrantContext | null;
      filters?: TimelineFilterOptions;
    }
  ): TimelineItem[] {
    const records = this.clinicalStore.getPatientRecords(patientId, actor, {
      consent: context.consent,
      emergencyGrant: context.emergencyGrant,
      includeHistoricalVersions: false,
    });

    const filters = context.filters || {};
    const items: TimelineItem[] = [];

    for (const { record, resource } of records) {
      // 1. Filter by resourceType
      if (filters.resourceType && record.resourceType !== filters.resourceType) {
        continue;
      }

      // 2. Filter by facility
      if (filters.facilityId && record.originFacilityId !== filters.facilityId) {
        continue;
      }

      // 3. Filter by category
      if (filters.category && record.clinicalCategory !== filters.category) {
        continue;
      }

      // 4. Filter by Date range
      const recordTime = new Date(record.effectiveDate).getTime();
      if (filters.startDate && recordTime < new Date(filters.startDate).getTime()) {
        continue;
      }
      if (filters.endDate && recordTime > new Date(filters.endDate).getTime()) {
        continue;
      }

      // Format Provenance Badge
      const doctorName = this.clinicianDirectory.get(record.authorClinicianId) || `Clinician (${record.authorClinicianId})`;
      const facilityName = this.facilityDirectory.get(record.originFacilityId) || `Facility (${record.originFacilityId})`;
      const formattedDate = this.formatDate(record.effectiveDate);
      const badgeStatement = `Authored by ${doctorName}, ${facilityName} (${record.countryCode}) on ${formattedDate}`;

      const { title, summary } = this.formatResourceDisplay(resource);

      items.push({
        id: record.id,
        versionId: record.versionId,
        resourceType: record.resourceType,
        category: record.clinicalCategory,
        title,
        summary,
        effectiveDate: record.effectiveDate,
        provenance: {
          authorClinicianId: record.authorClinicianId,
          authorName: doctorName,
          originFacilityId: record.originFacilityId,
          facilityName,
          countryCode: record.countryCode,
          timestamp: record.effectiveDate,
          badgeStatement,
        },
        resource,
      });
    }

    // Sort chronologically (newest first)
    items.sort((a, b) => new Date(b.effectiveDate).getTime() - new Date(a.effectiveDate).getTime());

    return items;
  }
}
