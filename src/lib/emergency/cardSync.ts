/**
 * MEDISTRY Card Content Sync
 * Keeps the patient's emergency-card fields (allergies, chronic conditions, active medications) in step with
 * DOCTOR-SIGNED clinical records. Drafts never reach here (the store only emits final records).
 *
 * On a signed AllergyIntolerance, Condition, MedicationStatement or (for patients who opted in their recent
 * diagnosis) Encounter that changes card content:
 *   - the patient's card is marked stale (patient.cardStale) if a card was issued,
 *   - opted-in items that were discontinued or resolved are removed from the patient's card choices,
 *   - the patient is notified: "Your record changed. Review and reissue your emergency card."
 * Patients never change clinical content here; only signed clinician records do.
 */
import crypto from 'node:crypto';
import type { PatientEntity, PatientAllergy, ActiveMedication } from '../patient/profile.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { NotificationDispatcher } from '../notifications/dispatcher.ts';
import type { FinalRecordEvent, RecordSource } from '../clinical/store.ts';

export const RECORD_CHANGED_MESSAGE = 'Your record changed. Review and reissue your emergency card.';

export interface CardSyncResult {
  changed: boolean;
  markedStale: boolean;
  removedOptIns: string[];
  notified: boolean;
}

const lower = (s: string) => s.trim().toLowerCase();
const statusCode = (r: any): string | undefined => r?.clinicalStatus?.coding?.[0]?.code;
const verification = (r: any): string | undefined => r?.verificationStatus?.coding?.[0]?.code;

function allergyFrom(resource: any, source: RecordSource): PatientAllergy | null {
  const substance = resource?.code?.text;
  if (!substance) return null;
  const reaction = resource.reaction?.[0];
  const cat = resource.category?.[0];
  return {
    substance,
    category: cat === 'medication' ? 'drug' : cat === 'food' ? 'food' : 'environment',
    reaction: reaction?.manifestation?.[0]?.text || 'Reaction not specified',
    severity: reaction?.severity || (resource.criticality === 'high' ? 'severe' : 'moderate'),
    source,
  };
}

function medicationFrom(resource: any): Omit<ActiveMedication, 'id'> | null {
  const name = resource?.medicationCodeableConcept?.text;
  if (!name) return null;
  const dosage: string = resource.dosage?.[0]?.text || '';
  const m = dosage.match(/^(.*) \(([^)]+)\)$/);
  return {
    medicationName: name,
    dose: (m ? m[1] : dosage) || 'as directed',
    route: m ? m[2] : '',
    sinceDate: String(resource.effectiveDateTime || resource.dateAsserted || '').slice(0, 10),
  };
}

const medId = (m: Omit<ActiveMedication, 'id'>) =>
  `med-${crypto.createHash('sha256').update(`${m.medicationName}|${m.dose}|${m.route}|${m.sinceDate}`).digest('hex').slice(0, 12)}`;

export class CardContentSync {
  private patientsById: Map<string, PatientEntity>;
  private dispatcher: NotificationDispatcher;
  private auditManager: AuditChainManager;

  constructor(deps: { patientsById: Map<string, PatientEntity>; dispatcher: NotificationDispatcher; auditManager: AuditChainManager }) {
    this.patientsById = deps.patientsById;
    this.dispatcher = deps.dispatcher;
    this.auditManager = deps.auditManager;
  }

  /** Store listener: apply one signed record to the patient's card fields. */
  handle(event: FinalRecordEvent): CardSyncResult {
    const patient = this.patientsById.get(event.record.patientId);
    const none: CardSyncResult = { changed: false, markedStale: false, removedOptIns: [], notified: false };
    if (!patient) return none;

    const before = JSON.stringify([patient.allergies, patient.chronicConditions, patient.activeMedications]);
    const removedOptIns: string[] = [];
    const r: any = event.resource;
    const prev: any = event.previous?.resource;
    let encounterChange = false;

    switch (event.record.resourceType) {
      case 'AllergyIntolerance': {
        // A correction that renames the allergen drops the old entry first.
        if (prev?.code?.text && lower(prev.code.text) !== lower(r.code?.text || '')) {
          patient.allergies = patient.allergies.filter((a) => lower(a.substance) !== lower(prev.code.text));
        }
        const gone = ['inactive', 'resolved'].includes(statusCode(r) || '') || ['refuted', 'entered-in-error'].includes(verification(r) || '');
        const a = allergyFrom(r, event.record.source);
        if (!a) break;
        patient.allergies = patient.allergies.filter((x) => lower(x.substance) !== lower(a.substance));
        if (!gone) patient.allergies.push(a);
        break;
      }
      case 'Condition': {
        const name: string | undefined = r.code?.text;
        const removeCondition = (n: string) => {
          patient.chronicConditions = patient.chronicConditions.filter((c) => lower(c) !== lower(n));
          const kept = patient.cardConditions.filter((c) => lower(c) !== lower(n));
          if (kept.length !== patient.cardConditions.length) removedOptIns.push(n);
          patient.cardConditions = kept;
        };
        if (prev?.code?.text && lower(prev.code.text) !== lower(name || '')) removeCondition(prev.code.text);
        if (!name) break;
        const gone = ['resolved', 'remission', 'inactive'].includes(statusCode(r) || '') || ['refuted', 'entered-in-error'].includes(verification(r) || '');
        if (gone) removeCondition(name);
        else if (!patient.chronicConditions.some((c) => lower(c) === lower(name))) patient.chronicConditions.push(name);
        break;
      }
      case 'MedicationStatement': {
        const removeMedication = (n: string) => {
          const leaving = patient.activeMedications.filter((m) => lower(m.medicationName) === lower(n));
          patient.activeMedications = patient.activeMedications.filter((m) => lower(m.medicationName) !== lower(n));
          for (const m of leaving) {
            if (patient.cardMedicationIds.includes(m.id)) {
              patient.cardMedicationIds = patient.cardMedicationIds.filter((id) => id !== m.id);
              removedOptIns.push(m.medicationName);
            }
          }
        };
        const prevName = prev?.medicationCodeableConcept?.text;
        if (prevName && lower(prevName) !== lower(r.medicationCodeableConcept?.text || '')) removeMedication(prevName);
        const med = medicationFrom(r);
        if (!med) break;
        if (['stopped', 'completed', 'entered-in-error'].includes(r.status)) {
          removeMedication(med.medicationName);
        } else if (r.status === 'active') {
          const existing = patient.activeMedications.find((m) => lower(m.medicationName) === lower(med.medicationName));
          if (existing) Object.assign(existing, med); // keeps its id, so an opt-in survives a dose change
          else patient.activeMedications.push({ ...med, id: medId(med) });
        }
        break;
      }
      case 'Encounter':
        // A new signed encounter can change "most recent diagnosis", which is on the card only if opted in.
        encounterChange = !event.previous && patient.cardIncludeRecentDiagnosis && !!r.reasonCode?.[0]?.text;
        break;
      default:
        return none;
    }

    const changed = encounterChange || before !== JSON.stringify([patient.allergies, patient.chronicConditions, patient.activeMedications]);
    if (!changed && !removedOptIns.length) return none;

    const hasCard = patient.cardVersion > 0;
    const markedStale = changed && hasCard;
    if (markedStale) patient.cardStale = true;
    patient.updatedAt = new Date().toISOString();

    if (markedStale) {
      // No clinical detail in the audit trail, only what kind of record changed the card.
      this.auditManager.appendEntry({
        actorId: event.actor.userId,
        subjectId: patient.id,
        action: 'OFFLINE_CARD_MARKED_STALE',
        accessType: 'NORMAL_CONSENT',
        resourceType: event.record.resourceType,
        resourceId: event.record.id,
        facilityId: event.record.originFacilityId,
        ipAddress: '127.0.0.1',
        userAgent: 'ClinicalClient/1.0',
        reason: `Signed ${event.record.resourceType} changed emergency card content${removedOptIns.length ? `; ${removedOptIns.length} card choice(s) removed` : ''}`,
      });
    }

    let notified = false;
    if (hasCard || removedOptIns.length) {
      const removed = removedOptIns.length
        ? ` We removed ${removedOptIns.join(', ')} from your card choices because ${removedOptIns.length === 1 ? 'it was' : 'they were'} discontinued or resolved.`
        : '';
      this.dispatcher.notifyUser(patient.id, 'Emergency card needs review', `${RECORD_CHANGED_MESSAGE}${removed}`).catch(() => {});
      notified = true;
    }
    return { changed, markedStale, removedOptIns, notified };
  }
}
