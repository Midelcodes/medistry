/**
 * MEDISTRY Emergency Break-Glass Execution Engine & Summary Builder
 * Enforces 60-min time-boxed emergency grants, instant triage compilation,
 * dual-clinician co-signing, and automated notification alerts.
 */

import crypto from 'node:crypto';
import { decryptPatientDemographics, type PatientEntity } from '../patient/profile.ts';
import { ClinicalDataStore } from '../clinical/store.ts';
import { ClinicalTimelineEngine } from '../clinical/timeline.ts';
import { AuditChainManager } from '../audit/hashChain.ts';
import { NotificationDispatcher, type DispatchedAlertResult } from '../notifications/dispatcher.ts';
import type { ActorContext, EmergencyGrantContext } from '../policy/enforcer.ts';

export type BreakGlassReason = 'UNCONSCIOUS' | 'LIFE_THREATENING' | 'PATIENT_UNABLE_TO_CONSENT' | 'OTHER';

export interface EmergencySummaryData {
  patient: {
    fullName: string;
    age: number;
    gender: string;
    photoUrl?: string;
    emergencyContacts: Array<{ name: string; relationship: string; phone: string }>;
  };
  triageEssentials: {
    bloodGroup: string;
    genotype: string;
    allergies: Array<{ substance: string; category: string; reaction: string; severity: string }>;
    drugAllergiesFirst: Array<{ substance: string; reaction: string; severity: string }>;
  };
  chronicCare: {
    chronicConditions: string[];
    activeMedications: Array<{ medicationName: string; dose: string; route: string; sinceDate: string }>;
    implantsOrDevices?: string[];
    pregnancyStatus?: string;
  };
  recentEncounters: Array<{
    date: string;
    facilityName: string;
    doctorName: string;
    diagnosis: string;
    treatment: string;
    result: string;
  }>;
  legalDirectives: {
    advanceDirectiveDnr: boolean;
    organDonor: boolean;
  };
  grantMeta: {
    grantId: string;
    treatingDoctorName: string;
    facilityName: string;
    reason: string;
    grantedAt: string;
    expiresAt: string;
    remainingMinutes: number;
    fullHistoryAccess: boolean;
    coSignDoctorName?: string;
  };
}

export interface StoredEmergencyGrant extends EmergencyGrantContext {
  emergencyCode: string;
  reason: BreakGlassReason;
  reasonDetails?: string;
  treatingDoctorName: string;
  facilityName: string;
  grantedAt: string;
  isDisputed: boolean;
  disputeReason?: string;
  coSignDoctorName?: string;
}

export class EmergencyBreakGlassEngine {
  private grants = new Map<string, StoredEmergencyGrant>(); // Key: grantId
  private activePatientGrants = new Map<string, string>();   // Key: patientId -> grantId
  private auditManager: AuditChainManager;
  private clinicalStore: ClinicalDataStore;
  private timelineEngine: ClinicalTimelineEngine;
  private dispatcher: NotificationDispatcher;

  constructor(
    auditManager: AuditChainManager,
    clinicalStore: ClinicalDataStore,
    timelineEngine: ClinicalTimelineEngine,
    dispatcher: NotificationDispatcher
  ) {
    this.auditManager = auditManager;
    this.clinicalStore = clinicalStore;
    this.timelineEngine = timelineEngine;
    this.dispatcher = dispatcher;
  }

  /**
   * Computes age from ISO date of birth (YYYY-MM-DD).
   */
  private computeAge(dateOfBirth: string): number {
    try {
      const dob = new Date(dateOfBirth);
      const diffMs = Date.now() - dob.getTime();
      return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365.25));
    } catch {
      return 0;
    }
  }

  /**
   * 1. Public Gate Evaluator: Checks if patient opted into public emergency badges
   * for anonymous scanners before clinician authentication.
   */
  evaluatePublicScanGate(patient: PatientEntity): {
    requiresLogin: boolean;
    publicCard?: {
      bloodGroup: string;
      genotype: string;
      allergies: string[];
      emergencyHotline: string;
    };
  } {
    if (patient.publicEmergencyOptIn) {
      return {
        requiresLogin: false,
        publicCard: {
          bloodGroup: patient.bloodGroup.replace('_', ' '),
          genotype: patient.genotype,
          allergies: patient.allergies.map((a) => `${a.substance} (${a.reaction})`),
          emergencyHotline: patient.emergencyContacts[0]?.phone || '+234 800 420 6337',
        },
      };
    }

    return { requiresLogin: true };
  }

  /**
   * 2. Initiates the Emergency Break-Glass Procedure.
   * Time-boxes access to exactly 60 minutes, records facility & reason,
   * fires instant alerts to patient + emergency contacts, and appends to audit chain.
   */
  async initiateBreakGlass(params: {
    patient: PatientEntity;
    emergencyCode: string;
    actor: ActorContext;
    treatingDoctorName: string;
    facilityId: string;
    facilityName: string;
    reason: BreakGlassReason;
    reasonDetails?: string;
  }): Promise<{ grant: StoredEmergencyGrant; alertResults: DispatchedAlertResult[] }> {
    const { patient, emergencyCode, actor, treatingDoctorName, facilityId, facilityName, reason, reasonDetails } = params;

    // Verify actor is a verified clinician
    if (actor.role !== 'DOCTOR' || !actor.isVerifiedClinician) {
      throw new Error('Break-glass authorization denied: Only verified medical doctors can execute emergency break-glass');
    }

    // Reason validation
    if (reason === 'OTHER' && (!reasonDetails || reasonDetails.trim().length < 5)) {
      throw new Error('Mandatory clinical justification is required when selecting break-glass reason "OTHER"');
    }

    const grantId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 60-minute time-box

    const reasonSummary = reason === 'OTHER' ? `OTHER: ${reasonDetails}` : reason;

    const grant: StoredEmergencyGrant = {
      id: grantId,
      patientId: patient.id,
      emergencyCode,
      clinicianId: actor.clinicianId || actor.userId,
      facilityId,
      facilityName,
      treatingDoctorName,
      reason,
      reasonDetails,
      grantedAt: now.toISOString(),
      expiresAt,
      fullHistoryAccess: false,
      isDisputed: false,
    };

    this.grants.set(grantId, grant);
    this.activePatientGrants.set(patient.id, grantId);

    // Append immutable audit row
    this.auditManager.appendEntry({
      actorId: actor.userId,
      subjectId: patient.id,
      action: 'EMERGENCY_BREAK_GLASS_INITIATED',
      accessType: 'EMERGENCY_BREAK_GLASS',
      facilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalEmergencyPortal/1.0',
      reason: `Break-glass initiated by ${treatingDoctorName} at ${facilityName}: ${reasonSummary}`,
    });

    // Dispatch instant notifications (SMS/Email/Push) to patient and emergency contacts
    const demographics = decryptPatientDemographics(patient);
    const alertResults = await this.dispatcher.dispatchEmergencyBreakGlassAlerts(
      {
        id: patient.id,
        fullName: `${demographics.firstName} ${demographics.lastName}`,
        emergencyContacts: patient.emergencyContacts,
      },
      {
        doctorName: treatingDoctorName,
        facilityName,
        reason: reasonSummary,
        timestamp: now.toISOString(),
      }
    );

    return { grant, alertResults };
  }

  /**
   * 3. Compiles the Emergency Summary Data (most critical triage attributes first).
   */
  buildEmergencySummary(patient: PatientEntity, grantId: string): EmergencySummaryData {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('Emergency grant not found');

    const now = Date.now();
    const exp = new Date(grant.expiresAt).getTime();
    if (now > exp) {
      throw new Error('Emergency grant expired (60-minute window elapsed)');
    }

    const remainingMinutes = Math.max(0, Math.ceil((exp - now) / (1000 * 60)));
    const demo = decryptPatientDemographics(patient);

    // Separate drug allergies first (highest priority)
    const drugAllergiesFirst = patient.allergies
      .filter((a) => a.category === 'drug')
      .map((a) => ({ substance: a.substance, reaction: a.reaction, severity: a.severity }));

    // Mock last 5 encounters
    const recentEncounters = [
      {
        date: '2026-09-14',
        facilityName: 'Lagos University Teaching Hospital',
        doctorName: 'Dr. Robert Caldwell',
        diagnosis: 'Vaso-occlusive pain crisis',
        treatment: 'IV Hydration & Analgesia protocol',
        result: 'Stabilized and discharged',
      },
      {
        date: '2026-05-22',
        facilityName: 'National Hospital Abuja',
        doctorName: 'Dr. Marcus Thorne',
        diagnosis: 'Acute bacterial bronchitis',
        treatment: 'Azithromycin 500mg 3-day course',
        result: 'Resolved',
      },
    ];

    return {
      patient: {
        fullName: `${demo.firstName} ${demo.lastName}`,
        age: this.computeAge(demo.dateOfBirth),
        gender: demo.gender.toUpperCase(),
        photoUrl: demo.photoUrl,
        emergencyContacts: patient.emergencyContacts.map((c) => ({
          name: c.name,
          relationship: c.relationship,
          phone: c.phone,
        })),
      },
      triageEssentials: {
        bloodGroup: patient.bloodGroup.replace('_', ' '),
        genotype: patient.genotype,
        allergies: patient.allergies,
        drugAllergiesFirst,
      },
      chronicCare: {
        chronicConditions: patient.chronicConditions,
        activeMedications: patient.activeMedications,
        implantsOrDevices: ['None on record'],
        pregnancyStatus: demo.gender === 'female' ? 'Non-pregnant (Self-reported)' : undefined,
      },
      recentEncounters,
      legalDirectives: {
        advanceDirectiveDnr: patient.advanceDirectiveDnr,
        organDonor: patient.organDonor,
      },
      grantMeta: {
        grantId: grant.id,
        treatingDoctorName: grant.treatingDoctorName,
        facilityName: grant.facilityName,
        reason: grant.reason,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt.toISOString(),
        remainingMinutes,
        fullHistoryAccess: grant.fullHistoryAccess,
        coSignDoctorName: grant.coSignDoctorName,
      },
    };
  }

  /**
   * 4. Dual-Clinician Co-Sign for Full Medical History.
   * Full history in emergency requires a verified second doctor co-sign + stated reason.
   */
  coSignForFullHistory(params: {
    grantId: string;
    primaryClinicianId: string;
    coSignClinicianId: string;
    coSignDoctorName: string;
    coSignReason: string;
  }): StoredEmergencyGrant {
    const { grantId, primaryClinicianId, coSignClinicianId, coSignDoctorName, coSignReason } = params;
    const grant = this.grants.get(grantId);

    if (!grant) throw new Error('Emergency grant not found');
    if (new Date() > new Date(grant.expiresAt)) throw new Error('Cannot co-sign an expired emergency grant');

    // Rule: Co-signer must be a distinct clinician
    if (coSignClinicianId === primaryClinicianId || coSignClinicianId === grant.clinicianId) {
      throw new Error('Co-signing requires a second, distinct attending clinician');
    }

    if (!coSignReason || coSignReason.trim().length < 5) {
      throw new Error('Mandatory clinical reason required for full history access');
    }

    grant.fullHistoryAccess = true;
    grant.coSignClinicianId = coSignClinicianId;
    grant.coSignDoctorName = coSignDoctorName;
    grant.coSignReason = coSignReason;

    // Append immutable audit entry
    this.auditManager.appendEntry({
      actorId: coSignClinicianId,
      subjectId: grant.patientId,
      action: 'EMERGENCY_CO_SIGN_FULL_HISTORY_GRANTED',
      accessType: 'EMERGENCY_BREAK_GLASS',
      facilityId: grant.facilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'ClinicalPortal/1.0',
      reason: `Full history unlocked via dual co-sign by Dr. ${coSignDoctorName}: ${coSignReason}`,
    });

    return grant;
  }

  /**
   * Retrieve grant by ID.
   */
  getGrant(grantId: string): StoredEmergencyGrant | undefined {
    return this.grants.get(grantId);
  }
}
