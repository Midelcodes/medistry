/**
 * MEDISTRY Record Flags
 * A patient can flag a clinical record as possibly wrong. The flag NEVER changes the record: it is stored
 * beside it, audited, and sent to the clinician who signed the record, who may correct it with a new
 * version (ClinicalDataStore.updateRecord). Patients cannot write clinical content.
 */
import crypto from 'node:crypto';
import type { ClinicalDataStore } from './store.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { RecordRepo } from '../data/repositories.ts';

export interface RecordFlag {
  id: string;
  recordId: string;
  patientId: string;
  resourceType: string;
  note: string;
  authorClinicianId: string;
  createdAt: string;
  status: 'OPEN' | 'RESOLVED';
}

export class RecordFlagStore {
  private flags = new Map<string, RecordFlag>();
  /** Write-through repository (no-op in memory storage). */
  persistence?: Pick<RecordRepo, 'saveRecordFlag'>;

  /** Rebuilds flags from storage (start-up). */
  hydrate(flags: RecordFlag[]): void {
    for (const f of flags) this.flags.set(f.id, f);
  }
  private deps: { clinicalStore: ClinicalDataStore; auditManager: AuditChainManager; dispatcher: NotificationDispatcher };

  constructor(deps: { clinicalStore: ClinicalDataStore; auditManager: AuditChainManager; dispatcher: NotificationDispatcher }) {
    this.deps = deps;
  }

  flag(patientId: string, recordId: string, note: string): RecordFlag {
    const record = this.deps.clinicalStore.getRecordById(recordId);
    // Drafts are invisible to patients, so they cannot be flagged either.
    if (!record || record.patientId !== patientId || record.status !== 'final') throw new Error('Record not found');
    const text = note.trim();
    if (text.length < 5) throw new Error('Describe what looks wrong (at least 5 characters)');

    const flag: RecordFlag = {
      id: crypto.randomUUID(),
      recordId,
      patientId,
      resourceType: record.resourceType,
      note: text.slice(0, 1000),
      authorClinicianId: record.signedByClinicianId || record.authorClinicianId,
      createdAt: new Date().toISOString(),
      status: 'OPEN',
    };
    this.flags.set(flag.id, flag);
    this.persistence?.saveRecordFlag(flag);

    // The patient's note is not copied into the audit trail; the flag itself holds it.
    this.deps.auditManager.appendEntry({
      actorId: patientId,
      subjectId: patientId,
      action: 'PATIENT_FLAGGED_RECORD',
      accessType: 'NORMAL_CONSENT',
      resourceType: record.resourceType,
      resourceId: recordId,
      facilityId: record.originFacilityId,
      ipAddress: '127.0.0.1',
      userAgent: 'PatientPortal/1.0',
      reason: 'Patient flagged a record as possibly wrong; record unchanged, author notified',
    });

    const day = String(record.effectiveDate).slice(0, 10);
    this.deps.dispatcher.notifyUser(flag.authorClinicianId, 'A patient flagged a record',
      `A patient flagged a ${record.resourceType} record you signed (${day}) as possibly wrong. Their note: "${flag.note}". ` +
      'Review it, and if it needs correcting, file a new version. The original stays in the record.'
    ).catch(() => {});

    return { ...flag };
  }

  forAuthor(clinicianId: string): RecordFlag[] {
    return [...this.flags.values()].filter((f) => f.authorClinicianId === clinicianId).map((f) => ({ ...f }));
  }

  forPatient(patientId: string): RecordFlag[] {
    return [...this.flags.values()].filter((f) => f.patientId === patientId).map((f) => ({ ...f }));
  }
}
