/**
 * MEDISTRY Patient Access-Log & Dispute Manager ("Who Accessed My Record")
 * Powers the patient-visible audit log page, access monitoring, and dispute escalation flow.
 */

import { AuditChainManager, type ChainedAuditEntry } from './hashChain.ts';

export interface FormattedAccessLogEntry {
  auditId: string;
  sequenceNumber: number;
  timestamp: string;
  formattedDate: string;
  actorId: string;
  actorName: string;
  facilityId?: string;
  facilityName: string;
  accessType: 'NORMAL_CONSENT' | 'EMERGENCY_BREAK_GLASS' | 'PRE_SHARED_LINK' | 'SYSTEM_ADMIN';
  accessTypeLabel: string;
  action: string;
  actionDescription: string;
  resourceType?: string;
  reason: string;
  isEmergency: boolean;
  isDisputed: boolean;
  disputeReason?: string;
  disputedAt?: string;
}

export interface DisputeTicket {
  ticketId: string;
  auditLogId: string;
  patientId: string;
  actorId: string;
  facilityId?: string;
  accessType: string;
  disputeReason: string;
  createdAt: string;
  status: 'PENDING_REVIEW' | 'UNDER_INVESTIGATION' | 'RESOLVED_VALID' | 'RESOLVED_BREACH';
  adminNotes?: string;
}

export class PatientAccessLogManager {
  private disputes = new Map<string, DisputeTicket>(); // Key: auditLogId
  private clinicianNames = new Map<string, string>([
    ['doc-uuid-1', 'Dr. Robert Caldwell (Cardiothoracic)'],
    ['doc-uuid-2', 'Dr. Elena Rostova (Neurology)'],
    ['doc-uuid-3', 'Dr. Marcus Thorne (Emergency Critical Care)'],
    ['doc-uuid-4', 'Dr. Amina Bello (Pediatrics)'],
  ]);

  private facilityNames = new Map<string, string>([
    ['facility-lagos-1', 'Lagos University Teaching Hospital (LUTH)'],
    ['facility-abuja-1', 'National Hospital Abuja'],
    ['facility-ibadan-1', 'University College Hospital (UCH) Ibadan'],
  ]);

  private auditManager: AuditChainManager;

  constructor(auditManager: AuditChainManager) {
    this.auditManager = auditManager;
  }

  registerClinician(id: string, name: string) {
    this.clinicianNames.set(id, name);
  }

  registerFacility(id: string, name: string) {
    this.facilityNames.set(id, name);
  }

  private formatActionDescription(action: string, resourceType?: string): string {
    if (action.includes('EMERGENCY_BREAK_GLASS')) return '🚨 Emergency Break-Glass Scan & Critical Summary View';
    if (action.includes('CLINICAL_RECORD_WRITE')) return `✍️ Authored New ${resourceType || 'Clinical'} Record`;
    if (action.includes('CLINICAL_RECORD_VERSION_UPDATE')) return `🔄 Updated ${resourceType || 'Clinical'} Record (New Version)`;
    if (action.includes('CLINICAL_RECORDS_READ')) return '👁️ Viewed Complete Clinical Record History';
    if (action.includes('CONSENT_GRANTED')) return '✅ Granted Hospital Access';
    if (action.includes('CONSENT_REVOKED')) return '🚫 Revoked Hospital Access';
    return action;
  }

  /**
   * 1. Retrieves all access events for a patient formatted for the "Who accessed my record" page.
   */
  getPatientAccessLog(patientId: string): FormattedAccessLogEntry[] {
    const rawEntries = this.auditManager.getPatientAccessHistory(patientId);

    return rawEntries.map((entry) => {
      const actorName = this.clinicianNames.get(entry.actorId) || (entry.actorId === patientId ? 'Self (Patient)' : `Clinician (${entry.actorId})`);
      const facilityName = entry.facilityId ? (this.facilityNames.get(entry.facilityId) || entry.facilityId) : 'Digital Portal Gateway';
      const dispute = this.disputes.get(entry.id);

      const d = new Date(entry.timestamp);
      const formattedDate = d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      return {
        auditId: entry.id,
        sequenceNumber: entry.sequenceNumber,
        timestamp: entry.timestamp,
        formattedDate,
        actorId: entry.actorId,
        actorName,
        facilityId: entry.facilityId,
        facilityName,
        accessType: entry.accessType,
        accessTypeLabel: entry.accessType === 'EMERGENCY_BREAK_GLASS' ? 'Emergency Break-Glass' : 'Patient Authorized Consent',
        action: entry.action,
        actionDescription: this.formatActionDescription(entry.action, entry.resourceType),
        resourceType: entry.resourceType,
        reason: entry.reason || 'Routine Clinical Care',
        isEmergency: entry.accessType === 'EMERGENCY_BREAK_GLASS',
        isDisputed: Boolean(dispute),
        disputeReason: dispute?.disputeReason,
        disputedAt: dispute?.createdAt,
      };
    });
  }

  /**
   * 2. Dispute Flow: Patient flags an unauthorized or suspicious access for Platform Admin review.
   */
  disputeAccess(
    patientId: string,
    auditLogId: string,
    disputeReason: string
  ): DisputeTicket {
    const rawEntries = this.auditManager.getEntries();
    const targetEntry = rawEntries.find((e) => e.id === auditLogId);

    if (!targetEntry) {
      throw new Error(`Audit log entry ${auditLogId} not found`);
    }

    if (targetEntry.subjectId && targetEntry.subjectId !== patientId) {
      throw new Error('Unauthorized: You can only dispute access events for your own medical record');
    }

    if (this.disputes.has(auditLogId)) {
      throw new Error('This access event has already been disputed');
    }

    const ticketId = crypto.randomUUID();
    const now = new Date().toISOString();

    const ticket: DisputeTicket = {
      ticketId,
      auditLogId,
      patientId,
      actorId: targetEntry.actorId,
      facilityId: targetEntry.facilityId,
      accessType: targetEntry.accessType,
      disputeReason,
      createdAt: now,
      status: 'PENDING_REVIEW',
    };

    this.disputes.set(auditLogId, ticket);

    // Append immutable audit log event for dispute creation
    this.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'PATIENT_DISPUTED_ACCESS_EVENT',
      accessType: 'NORMAL_CONSENT',
      resourceId: auditLogId,
      facilityId: targetEntry.facilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientApp/1.0',
      reason: `Patient disputed access: ${disputeReason}`,
    });

    return ticket;
  }

  /**
   * 3. Retrieves all open disputes for Platform Admin governance review.
   */
  getOpenDisputes(): DisputeTicket[] {
    return Array.from(this.disputes.values());
  }

  /**
   * 4. Platform Admin resolves a dispute after investigation.
   */
  resolveDispute(
    ticketId: string,
    adminId: string,
    resolution: 'RESOLVED_VALID' | 'RESOLVED_BREACH',
    adminNotes: string
  ): DisputeTicket {
    const ticket = Array.from(this.disputes.values()).find((t) => t.ticketId === ticketId);
    if (!ticket) throw new Error('Dispute ticket not found');

    ticket.status = resolution;
    ticket.adminNotes = adminNotes;

    this.auditManager.appendEntry({
      actorId: adminId,
      subjectId: ticket.patientId,
      action: 'PLATFORM_ADMIN_RESOLVED_DISPUTE',
      accessType: 'SYSTEM_ADMIN',
      resourceId: ticket.auditLogId,
      ipAddress: '127.0.0.1',
      userAgent: 'AdminConsole/1.0',
      reason: `Dispute resolved as ${resolution}: ${adminNotes}`,
    });

    return ticket;
  }
}

