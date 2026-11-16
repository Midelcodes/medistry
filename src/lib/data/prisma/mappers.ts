/**
 * Entity <-> database row mapping for the Prisma repositories. Pure functions (no database), so they are
 * tested without Postgres (tests/phase8-storage.test.ts).
 *
 * Encryption at rest: every value that is health or contact data, a free-text reason, a secret or a code is
 * encrypted here with encryptField (AES-256-GCM, FIELD_ENCRYPTION_KEY) before it leaves the process, and
 * decrypted on load. Demographic fields arrive already encrypted from the patient entity and are stored as is.
 */
import crypto from 'node:crypto';
import { encryptField, decryptField, type PatientEntity } from '../../patient/profile.ts';
import { hashEmergencyCode, normalizePatientCode } from '../../code/crockford.ts';
import type { ChainedAuditEntry } from '../../audit/hashChain.ts';
import type { StoredClinicalRecord } from '../../clinical/store.ts';
import type { PendingAccessRequest, StoredConsentGrant } from '../../consent/consentManager.ts';
import type { StoredEmergencyGrant } from '../../emergency/breakGlassEngine.ts';
import type { OfflineCardRecord } from '../../emergency/offlineCardStore.ts';
import type { OfflineScanEventRecord } from '../../emergency/offlineScans.ts';
import type { RecordFlag } from '../../clinical/recordFlags.ts';
import type { DisputeTicket } from '../../audit/accessLogManager.ts';
import type { SeedClinician, SeedFacility } from '../../../../prisma/seed.ts';
import type { DeviceKeyEntity, EmergencyCodeEntity, NotificationEntity } from '../repositories.ts';
import type { UserAccount } from '../../auth/accounts.ts';
import type { ProxyRelationship } from '../../auth/proxies.ts';
import type { CredentialDocument } from '../../clinical/fileUpload.ts';
import type { NotificationDelivery } from '../../notifications/deliveries.ts';
import type { FacilityApiClient } from '../../integrations/apiClients.ts';
import type { FacilityPatientLink } from '../../integrations/fhirImport.ts';
import type { IntakeSession } from '../../intake/intakeService.ts';
import type { PatientIdentifier } from '../../identity/identityStore.ts';
import type { DuplicateReview, PatientMerge } from '../../identity/mpi.ts';
import type { OutboxMessage } from '../../integrations/hie/nationalExchange.ts';
import type { FacilityApplication, StaffInvite } from '../../facilities/onboarding.ts';
import type { Subscription } from '../../billing/billingService.ts';

type Row = Record<string, any>;

const date = (s?: string | null) => (s ? new Date(s) : null);
const iso = (d?: Date | string | null) => (d ? new Date(d).toISOString() : undefined);
const enc = (s?: string | null) => (s === undefined || s === null ? null : encryptField(s));
const dec = (s?: string | null) => (s ? decryptField(s) : undefined);
/** Drops keys whose value is undefined, so loaded entities look like the ones the engines create. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o)) if ((o as any)[k] === undefined) delete (o as any)[k];
  return o;
}

// ---------- Facility ----------
export const facilityToRow = (f: SeedFacility): Row => ({
  id: f.id, name: f.name, region: f.region, type: f.type, address: f.address, countryCode: f.countryCode,
  registryCode: f.registryCode, synthetic: !!f.synthetic, status: f.status || 'VERIFIED', kind: f.kind || 'HOSPITAL',
});
export const rowToFacility = (r: Row): SeedFacility => clean({
  id: r.id, name: r.name, region: r.region, countryCode: r.countryCode, type: r.type, address: r.address,
  registryCode: r.registryCode ?? null, synthetic: r.synthetic || undefined, kind: r.kind && r.kind !== 'HOSPITAL' ? r.kind : undefined,
  status: r.status && r.status !== 'VERIFIED' ? r.status : undefined,
});

// ---------- Clinician (+ user) ----------
export const clinicianToRows = (c: SeedClinician) => ({
  user: { id: c.userId, role: 'DOCTOR', countryCode: c.countryCode },
  clinician: {
    id: c.id, userId: c.userId, fullName: c.fullName, licenseNumber: c.licenseNumber, countryCode: c.countryCode,
    specialty: c.specialty, facilityId: c.facilityId, status: c.status,
    registeredAt: date(c.registeredAt), registryMatch: c.registryMatch ?? null, licenceExpiresOn: c.licenceExpiresOn ?? null,
    licenceReminderSentFor: c.licenceReminderSentFor ?? null, verifiedBy: c.reviewedBy ?? null, verifiedAt: date(c.reviewedAt),
    encryptedRejectionReason: enc(c.rejectionReason),
  },
});
export const rowToClinician = (r: Row): SeedClinician => clean({
  id: r.id, userId: r.userId, fullName: r.fullName, licenseNumber: r.licenseNumber, countryCode: r.countryCode,
  specialty: r.specialty, facilityId: r.facilityId, status: r.status,
  registeredAt: iso(r.registeredAt), registryMatch: r.registryMatch ?? undefined, licenceExpiresOn: r.licenceExpiresOn ?? undefined,
  licenceReminderSentFor: r.licenceReminderSentFor ?? undefined, reviewedBy: r.verifiedBy ?? undefined, reviewedAt: iso(r.verifiedAt),
  rejectionReason: dec(r.encryptedRejectionReason),
});

// ---------- User account (sign-in credentials; Phase 12) ----------
// Phone and email arrive already encrypted (AccountStore); the TOTP secret is encrypted; the password is a scrypt hash.
export const userAccountToRows = (a: UserAccount) => ({
  user: {
    id: a.id, role: a.role, countryCode: a.countryCode, hasAccount: true, displayName: a.displayName ?? null,
    phoneHash: a.phoneHash ?? null, encryptedPhone: a.encryptedPhone ?? null, emailHash: a.emailHash ?? null, encryptedEmail: a.encryptedEmail ?? null,
    passwordHash: a.passwordHash ?? null, twoFactorSecret: a.encryptedTotpSecret ?? null, twoFactorEnabled: a.totpEnabled,
    failedSignIns: a.failedSignIns, lockedUntil: date(a.lockedUntil), sessionsNotBefore: date(a.sessionsNotBefore),
    lastSignInAt: date(a.lastSignInAt), createdAt: new Date(a.createdAt),
    ussdPinHash: a.ussdPinHash ?? null, ussdPinFailures: a.ussdPinFailures ?? 0, ussdLocked: !!a.ussdLocked,
    staffFacilityId: ['RECORDS_OFFICER', 'PHARMACIST', 'NURSE'].includes(a.role) ? a.facilityId ?? null : null, disabled: !!a.disabled,
  },
  facilityAdmin: a.role === 'FACILITY_ADMIN' && a.facilityId ? { userId: a.id, facilityId: a.facilityId } : null,
});
export const rowToUserAccount = (r: Row): UserAccount => clean({
  id: r.id, role: r.role, countryCode: r.countryCode, displayName: r.displayName ?? undefined, facilityId: r.facilityAdmin?.facilityId ?? r.staffFacilityId ?? undefined,
  phoneHash: r.phoneHash ?? undefined, encryptedPhone: r.encryptedPhone ?? undefined, emailHash: r.emailHash ?? undefined, encryptedEmail: r.encryptedEmail ?? undefined,
  passwordHash: r.passwordHash ?? undefined, encryptedTotpSecret: r.twoFactorSecret ?? undefined, totpEnabled: !!r.twoFactorEnabled,
  failedSignIns: r.failedSignIns ?? 0, lockedUntil: iso(r.lockedUntil), sessionsNotBefore: iso(r.sessionsNotBefore),
  lastSignInAt: iso(r.lastSignInAt), createdAt: iso(r.createdAt)!,
  ussdPinHash: r.ussdPinHash ?? undefined, ussdPinFailures: r.ussdPinFailures || undefined, ussdLocked: r.ussdLocked || undefined, disabled: r.disabled || undefined,
} as UserAccount);

// ---------- Phase 18: facility applications, staff invites, subscriptions ----------
export const applicationToRow = (a: FacilityApplication): Row => ({
  facilityId: a.facilityId, encryptedContact: a.encryptedContact, documentId: a.document.id, encryptedFilename: encryptField(a.document.filename),
  documentMimeType: a.document.mimeType, documentSha256: a.document.sha256, documentSizeBytes: a.document.sizeBytes, encryptedDocument: a.document.encryptedPayload,
  status: a.status, submittedAt: new Date(a.submittedAt), reviewedBy: a.reviewedBy ?? null, reviewedAt: date(a.reviewedAt), rejectionReason: a.rejectionReason ?? null,
});
export const rowToApplication = (r: Row): FacilityApplication => clean({
  facilityId: r.facilityId, encryptedContact: r.encryptedContact,
  document: { id: r.documentId, filename: decryptField(r.encryptedFilename), mimeType: r.documentMimeType, sha256: r.documentSha256, sizeBytes: r.documentSizeBytes, encryptedPayload: r.encryptedDocument, uploadedAt: iso(r.submittedAt)! },
  status: r.status, submittedAt: iso(r.submittedAt)!, reviewedBy: r.reviewedBy ?? undefined, reviewedAt: iso(r.reviewedAt), rejectionReason: r.rejectionReason ?? undefined,
} as FacilityApplication);
export const inviteToRow = (i: StaffInvite): Row => ({ ...i, usedAt: date(i.usedAt), expiresAt: new Date(i.expiresAt), createdAt: new Date(i.createdAt) });
export const rowToInvite = (r: Row): StaffInvite => clean({
  id: r.id, accountId: r.accountId, facilityId: r.facilityId, role: r.role, tokenHash: r.tokenHash, expiresAt: iso(r.expiresAt)!, usedAt: iso(r.usedAt),
  createdBy: r.createdBy, createdAt: iso(r.createdAt)!,
} as StaffInvite);
export const subscriptionToRow = (s: Subscription): Row => ({
  ...s, providerRef: s.providerRef ?? null, lastEventId: s.lastEventId ?? null, currentPeriodEnd: new Date(s.currentPeriodEnd), createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
});
export const rowToSubscription = (r: Row): Subscription => clean({
  id: r.id, facilityId: r.facilityId, plan: r.plan, status: r.status, currentPeriodEnd: iso(r.currentPeriodEnd)!, provider: r.provider,
  providerRef: r.providerRef ?? undefined, lastEventId: r.lastEventId ?? undefined, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
} as Subscription);

// ---------- Phase 17: national exchange outbox ----------
export const outboxToRow = (m: OutboxMessage): Row => ({
  ...m, lastError: m.lastError ?? null, remoteId: m.remoteId ?? null, nextAttemptAt: new Date(m.nextAttemptAt), createdAt: new Date(m.createdAt),
  updatedAt: new Date(m.updatedAt), sentAt: date(m.sentAt),
});
export const rowToOutbox = (r: Row): OutboxMessage => clean({
  id: r.id, kind: r.kind, connector: r.connector, patientId: r.patientId, recordId: r.recordId, resourceType: r.resourceType, facilityId: r.facilityId,
  status: r.status, attempts: r.attempts, nextAttemptAt: iso(r.nextAttemptAt)!, lastError: r.lastError ?? undefined, remoteId: r.remoteId ?? undefined,
  createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!, sentAt: iso(r.sentAt),
} as OutboxMessage);

// ---------- Phase 16: national identifiers, duplicate reviews, merges ----------
export const identifierToRow = (i: PatientIdentifier): Row => ({ ...i, verifiedAt: date(i.verifiedAt), createdAt: new Date(i.createdAt) });
export const rowToIdentifier = (r: Row): PatientIdentifier => clean({
  id: r.id, patientId: r.patientId, country: r.country, idType: r.idType, blindIndex: r.blindIndex, encryptedValue: r.encryptedValue,
  last2: r.last2, status: r.status, matchScore: r.matchScore, verifier: r.verifier, verifiedAt: iso(r.verifiedAt), createdAt: iso(r.createdAt)!,
} as PatientIdentifier);
export const reviewToRow = (x: DuplicateReview): Row => ({ ...x, reviewedBy: x.reviewedBy ?? null, createdAt: new Date(x.createdAt), reviewedAt: date(x.reviewedAt) });
export const rowToReview = (r: Row): DuplicateReview => clean({
  id: r.id, patientId: r.patientId, candidatePatientId: r.candidatePatientId, score: r.score, breakdown: r.breakdown, facilityId: r.facilityId,
  source: r.source, status: r.status, createdAt: iso(r.createdAt)!, reviewedBy: r.reviewedBy ?? undefined, reviewedAt: iso(r.reviewedAt),
} as DuplicateReview);
export const mergeToRow = (m: PatientMerge): Row => ({
  ...m, reviewId: m.reviewId ?? null, unmergedBy: m.unmergedBy ?? null, mergedAt: new Date(m.mergedAt), unmergedAt: date(m.unmergedAt),
});
export const rowToMerge = (r: Row): PatientMerge => clean({
  id: r.id, survivorId: r.survivorId, mergedId: r.mergedId, reviewId: r.reviewId ?? undefined, mergedBy: r.mergedBy, mergedAt: iso(r.mergedAt)!,
  status: r.status, unmergedBy: r.unmergedBy ?? undefined, unmergedAt: iso(r.unmergedAt),
} as PatientMerge);

// ---------- Phase 15: facility API clients, identifier links, intake sessions ----------
export const apiClientToRow = (c: FacilityApiClient): Row => ({ ...c, createdAt: new Date(c.createdAt), lastUsedAt: date(c.lastUsedAt) });
export const rowToApiClient = (r: Row): FacilityApiClient => clean({
  id: r.id, facilityId: r.facilityId, name: r.name, clientId: r.clientId, secretHash: r.secretHash, scopes: r.scopes, status: r.status,
  createdBy: r.createdBy, createdAt: iso(r.createdAt)!, lastUsedAt: iso(r.lastUsedAt),
} as FacilityApiClient);
export const patientLinkToRow = (l: FacilityPatientLink): Row => ({ ...l, createdAt: new Date(l.createdAt) });
export const rowToPatientLink = (r: Row): FacilityPatientLink => ({
  facilityId: r.facilityId, system: r.system, valueHash: r.valueHash, encryptedValue: r.encryptedValue, patientId: r.patientId, createdAt: iso(r.createdAt)!,
});
export const intakeToRow = (s: IntakeSession): Row => ({
  id: s.id, patientId: s.patientId, clinicianId: s.clinicianId, facilityId: s.facilityId, kind: s.kind,
  ocrAdapter: s.adapters.ocr ?? null, sttAdapter: s.adapters.stt ?? null, llmAdapter: s.adapters.llm, model: s.adapters.model,
  encryptedSourceText: s.encryptedSourceText, encryptedFile: s.encryptedFile ?? null, fileMimeType: s.fileMimeType ?? null, fileSha256: s.fileSha256 ?? null,
  encryptedProposals: s.encryptedProposals, status: s.status, createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt),
});
export const rowToIntake = (r: Row): IntakeSession => clean({
  id: r.id, patientId: r.patientId, clinicianId: r.clinicianId, facilityId: r.facilityId, kind: r.kind,
  adapters: clean({ ocr: r.ocrAdapter ?? undefined, stt: r.sttAdapter ?? undefined, llm: r.llmAdapter, model: r.model }),
  encryptedSourceText: r.encryptedSourceText, encryptedFile: r.encryptedFile ?? undefined, fileMimeType: r.fileMimeType ?? undefined, fileSha256: r.fileSha256 ?? undefined,
  encryptedProposals: r.encryptedProposals, status: r.status, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
} as IntakeSession);

// ---------- SMS delivery record (Phase 13): phone as hash + last 3 digits only, no message text ----------
export const deliveryToRow = (d: NotificationDelivery): Row => ({
  id: d.id, channel: d.channel, provider: d.provider, toHash: d.toHash, toLast3: d.toLast3, templateId: d.templateId, status: d.status,
  providerStatus: d.providerStatus ?? null, providerMessageId: d.providerMessageId ?? null, attempts: d.attempts,
  lastError: d.lastError ?? null, createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt),
});
export const rowToDelivery = (r: Row): NotificationDelivery => clean({
  id: r.id, channel: r.channel, provider: r.provider, toHash: r.toHash, toLast3: r.toLast3, templateId: r.templateId, status: r.status,
  providerStatus: r.providerStatus ?? undefined, providerMessageId: r.providerMessageId ?? undefined, attempts: r.attempts,
  lastError: r.lastError ?? undefined, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
} as NotificationDelivery);

// ---------- Proxy relationship ----------
export const proxyToRow = (x: ProxyRelationship): Row => ({
  id: x.id, patientId: x.patientId, proxyUserId: x.proxyUserId, relationship: x.relationship, scopes: x.scopes,
  validFrom: new Date(x.validFrom), validUntil: date(x.validUntil), verifiedBy: x.verifiedBy ?? null, status: x.status,
  managesMinorAccount: x.managesMinorAccount, createdAt: new Date(x.createdAt), endedAt: date(x.endedAt), endReason: x.endReason ?? null,
});
export const rowToProxy = (r: Row): ProxyRelationship => clean({
  id: r.id, patientId: r.patientId, proxyUserId: r.proxyUserId, relationship: r.relationship, scopes: r.scopes,
  validFrom: iso(r.validFrom)!, validUntil: iso(r.validUntil), verifiedBy: r.verifiedBy ?? undefined, status: r.status,
  managesMinorAccount: r.managesMinorAccount, createdAt: iso(r.createdAt)!, endedAt: iso(r.endedAt), endReason: r.endReason ?? undefined,
} as ProxyRelationship);

// ---------- Clinician licence document ----------
export const credentialDocumentToRow = (d: CredentialDocument): Row => ({
  id: d.id, clinicianId: d.clinicianId, encryptedFilename: encryptField(d.filename), mimeType: d.mimeType, sha256: d.sha256,
  sizeBytes: d.sizeBytes, encryptedPayload: d.encryptedPayload, uploadedAt: new Date(d.uploadedAt),
});
export const rowToCredentialDocument = (r: Row): CredentialDocument => ({
  id: r.id, clinicianId: r.clinicianId, filename: decryptField(r.encryptedFilename), mimeType: r.mimeType, sha256: r.sha256,
  sizeBytes: r.sizeBytes, encryptedPayload: r.encryptedPayload, uploadedAt: iso(r.uploadedAt)!,
});

// ---------- Patient (+ user) ----------
export function patientToRows(p: PatientEntity) {
  const profile = {
    emergencyContacts: p.emergencyContacts, allergies: p.allergies, chronicConditions: p.chronicConditions,
    activeMedications: p.activeMedications, cardConditions: p.cardConditions,
  };
  return {
    user: { id: p.userId, role: 'PATIENT', countryCode: p.countryCode },
    patient: {
      id: p.id, userId: p.userId,
      encryptedFirstName: p.encryptedFirstName, encryptedLastName: p.encryptedLastName, encryptedDob: p.encryptedDob,
      gender: p.gender, encryptedNin: p.encryptedNin ?? null, photoUrl: p.photoUrl ?? null,
      bloodGroup: p.bloodGroup, genotype: p.genotype, advanceDirectiveDnr: p.advanceDirectiveDnr, organDonor: p.organDonor,
      publicEmergencyOptIn: p.publicEmergencyOptIn,
      encryptedEmergencyProfile: encryptField(JSON.stringify(profile)),
      cardMedicationIds: p.cardMedicationIds, cardIncludeRecentDiagnosis: p.cardIncludeRecentDiagnosis,
      cardVersion: p.cardVersion, cardStale: p.cardStale, preferredLocale: p.preferredLocale ?? null,
      countryCode: p.countryCode, primaryFacilityId: p.primaryFacilityId ?? null, mergedIntoPatientId: p.mergedIntoPatientId ?? null,
      createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
    },
  };
}
export function rowToPatient(r: Row): PatientEntity {
  const profile = JSON.parse(decryptField(r.encryptedEmergencyProfile));
  return clean({
    id: r.id, userId: r.userId, countryCode: r.countryCode, primaryFacilityId: r.primaryFacilityId ?? undefined, mergedIntoPatientId: r.mergedIntoPatientId ?? undefined,
    encryptedFirstName: r.encryptedFirstName, encryptedLastName: r.encryptedLastName, encryptedDob: r.encryptedDob,
    gender: r.gender, encryptedNin: r.encryptedNin ?? undefined, photoUrl: r.photoUrl ?? undefined,
    bloodGroup: r.bloodGroup, genotype: r.genotype, advanceDirectiveDnr: r.advanceDirectiveDnr, organDonor: r.organDonor,
    publicEmergencyOptIn: r.publicEmergencyOptIn,
    emergencyContacts: profile.emergencyContacts, allergies: profile.allergies, chronicConditions: profile.chronicConditions,
    activeMedications: profile.activeMedications, cardConditions: profile.cardConditions,
    cardMedicationIds: r.cardMedicationIds, cardIncludeRecentDiagnosis: r.cardIncludeRecentDiagnosis,
    cardVersion: r.cardVersion, cardStale: r.cardStale, preferredLocale: r.preferredLocale ?? undefined,
    createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
  } as PatientEntity);
}

// ---------- Emergency code ----------
const maskCode = (formatted: string) => formatted.split('-').map((g, i, all) =>
  (i === 0 ? g : i === all.length - 1 ? '*'.repeat(Math.max(0, g.length - 2)) + g.slice(-2) : '*'.repeat(g.length))).join('-');
export function codeToRow(c: EmergencyCodeEntity): Row {
  const codeHash = hashEmergencyCode(c.rawCode);
  return {
    id: `code-${codeHash.slice(0, 32)}`, patientId: c.patientId, codeHash, encryptedCode: encryptField(c.formattedCode),
    displayCode: maskCode(c.formattedCode), isActive: c.isActive, createdAt: new Date(c.createdAt),
    revokedAt: date(c.revokedAt), revocationReason: c.revocationReason ?? null,
  };
}
export function rowToCode(r: Row): EmergencyCodeEntity {
  const formattedCode = decryptField(r.encryptedCode);
  return clean({
    patientId: r.patientId, rawCode: normalizePatientCode(formattedCode), formattedCode, isActive: r.isActive,
    createdAt: iso(r.createdAt)!, revokedAt: iso(r.revokedAt), revocationReason: r.revocationReason ?? undefined,
  });
}

// ---------- Clinical record ----------
export const recordToRow = (x: StoredClinicalRecord): Row => ({
  id: x.id, patientId: x.patientId, resourceType: x.resourceType, versionId: x.versionId, isLatest: x.isLatest,
  previousVersionId: x.previousVersionId ?? null,
  status: x.status.toUpperCase(), source: x.source.toUpperCase().replace('-', '_'), externalKey: x.externalKey ?? null, orderingClinicianId: x.orderingClinicianId ?? null,
  draftedByUserId: x.draftedByUserId ?? null, signedByClinicianId: x.signedByClinicianId ?? null, signedAt: date(x.signedAt),
  authorClinicianId: x.authorClinicianId, originFacilityId: x.originFacilityId, countryCode: x.countryCode,
  clinicalCategory: x.clinicalCategory ?? null, effectiveDate: x.effectiveDate,
  encryptedPayload: x.encryptedPayload, payloadSignature: x.payloadSignature,
  createdAt: new Date(x.createdAt), updatedAt: new Date(x.updatedAt),
});
export const rowToRecord = (r: Row): StoredClinicalRecord => clean({
  id: r.id, patientId: r.patientId, resourceType: r.resourceType, versionId: r.versionId, isLatest: r.isLatest,
  previousVersionId: r.previousVersionId ?? undefined,
  status: String(r.status).toLowerCase(), source: String(r.source).toLowerCase().replace('_', '-'), externalKey: r.externalKey ?? undefined, orderingClinicianId: r.orderingClinicianId ?? undefined,
  draftedByUserId: r.draftedByUserId ?? undefined, signedByClinicianId: r.signedByClinicianId ?? undefined, signedAt: iso(r.signedAt),
  authorClinicianId: r.authorClinicianId, originFacilityId: r.originFacilityId, countryCode: r.countryCode,
  clinicalCategory: r.clinicalCategory ?? undefined, effectiveDate: r.effectiveDate,
  encryptedPayload: r.encryptedPayload, payloadSignature: r.payloadSignature,
  createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
} as StoredClinicalRecord);

// ---------- Audit entry (the hash covers the plaintext reason; the column holds it encrypted) ----------
export const auditToRow = (e: ChainedAuditEntry): Row => ({
  id: e.id, sequenceNumber: e.sequenceNumber, timestamp: e.timestamp, actorId: e.actorId, subjectId: e.subjectId ?? null,
  action: e.action, accessType: e.accessType, resourceType: e.resourceType ?? null, resourceId: e.resourceId ?? null,
  facilityId: e.facilityId ?? null, countryCode: e.countryCode ?? null, ipAddress: e.ipAddress, userAgent: e.userAgent,
  encryptedReason: enc(e.reason), previousHash: e.previousHash, currentHash: e.currentHash,
});
export const rowToAudit = (r: Row): ChainedAuditEntry => clean({
  id: r.id, sequenceNumber: r.sequenceNumber, timestamp: r.timestamp, actorId: r.actorId, subjectId: r.subjectId ?? undefined,
  action: r.action, accessType: r.accessType, resourceType: r.resourceType ?? undefined, resourceId: r.resourceId ?? undefined,
  facilityId: r.facilityId ?? undefined, countryCode: r.countryCode ?? undefined, ipAddress: r.ipAddress, userAgent: r.userAgent,
  reason: dec(r.encryptedReason), previousHash: r.previousHash, currentHash: r.currentHash,
} as ChainedAuditEntry);

// ---------- Consent ----------
export const consentRequestToRow = (q: PendingAccessRequest): Row => ({
  id: q.id, patientId: q.patientId, requestingClinicianId: q.requestingClinicianId, requestingClinicianName: q.requestingClinicianName,
  requestingFacilityId: q.requestingFacilityId, requestingFacilityName: q.requestingFacilityName, requestedScopes: q.requestedScopes,
  durationPreset: q.durationPreset, durationHours: q.durationHours, encryptedClinicalReason: encryptField(q.clinicalReason),
  hashedOtp: q.hashedOtp, otpExpiresAt: new Date(q.otpExpiresAt), otpAttemptsRemaining: q.otpAttemptsRemaining,
  status: q.status, createdAt: new Date(q.createdAt),
});
export const rowToConsentRequest = (r: Row): PendingAccessRequest => ({
  id: r.id, patientId: r.patientId, requestingClinicianId: r.requestingClinicianId, requestingClinicianName: r.requestingClinicianName,
  requestingFacilityId: r.requestingFacilityId, requestingFacilityName: r.requestingFacilityName, requestedScopes: r.requestedScopes,
  durationPreset: r.durationPreset, durationHours: r.durationHours, clinicalReason: decryptField(r.encryptedClinicalReason),
  hashedOtp: r.hashedOtp, otpExpiresAt: new Date(r.otpExpiresAt).getTime(), otpAttemptsRemaining: r.otpAttemptsRemaining,
  status: r.status, createdAt: iso(r.createdAt)!,
});
export const consentGrantToRow = (g: StoredConsentGrant): Row => ({
  id: g.id, patientId: g.patientId, targetFacilityId: g.targetFacilityId ?? null, targetClinicianId: g.targetClinicianId ?? null,
  scopes: g.scopes, requestingClinicianName: g.requestingClinicianName, requestingFacilityName: g.requestingFacilityName,
  encryptedClinicalReason: encryptField(g.clinicalReason), validUntil: new Date(g.validUntil), isRevoked: g.isRevoked,
  revokedAt: date(g.revokedAt), revocationReason: g.revocationReason ?? null, createdAt: new Date(g.createdAt),
});
export const rowToConsentGrant = (r: Row): StoredConsentGrant => clean({
  id: r.id, patientId: r.patientId, targetFacilityId: r.targetFacilityId ?? undefined, targetClinicianId: r.targetClinicianId ?? undefined,
  scopes: r.scopes, requestingClinicianName: r.requestingClinicianName, requestingFacilityName: r.requestingFacilityName,
  clinicalReason: decryptField(r.encryptedClinicalReason), validUntil: new Date(r.validUntil), isRevoked: r.isRevoked,
  revokedAt: iso(r.revokedAt), revocationReason: r.revocationReason ?? undefined, createdAt: iso(r.createdAt)!,
} as StoredConsentGrant);

// ---------- Break-glass grant and disputes ----------
export const emergencyGrantToRow = (g: StoredEmergencyGrant): Row => ({
  id: g.id, patientId: g.patientId, encryptedEmergencyCode: encryptField(g.emergencyCode), clinicianId: g.clinicianId,
  facilityId: g.facilityId, facilityName: g.facilityName, treatingDoctorName: g.treatingDoctorName, reason: g.reason,
  encryptedReasonDetails: enc(g.reasonDetails), grantedAt: new Date(g.grantedAt), expiresAt: new Date(g.expiresAt),
  fullHistoryAccess: g.fullHistoryAccess, coSignClinicianId: g.coSignClinicianId ?? null, coSignDoctorName: g.coSignDoctorName ?? null,
  encryptedCoSignReason: enc(g.coSignReason), isDisputed: g.isDisputed, disputeReason: g.disputeReason ?? null,
});
export const rowToEmergencyGrant = (r: Row): StoredEmergencyGrant => clean({
  id: r.id, patientId: r.patientId, emergencyCode: decryptField(r.encryptedEmergencyCode), clinicianId: r.clinicianId,
  facilityId: r.facilityId, facilityName: r.facilityName, treatingDoctorName: r.treatingDoctorName, reason: r.reason,
  reasonDetails: dec(r.encryptedReasonDetails), grantedAt: iso(r.grantedAt)!, expiresAt: new Date(r.expiresAt),
  fullHistoryAccess: r.fullHistoryAccess, coSignClinicianId: r.coSignClinicianId ?? undefined, coSignDoctorName: r.coSignDoctorName ?? undefined,
  coSignReason: dec(r.encryptedCoSignReason), isDisputed: r.isDisputed, disputeReason: r.disputeReason ?? undefined,
} as StoredEmergencyGrant);
export const disputeToRow = (t: DisputeTicket): Row => ({
  ticketId: t.ticketId, auditLogId: t.auditLogId, patientId: t.patientId, actorId: t.actorId, facilityId: t.facilityId ?? null,
  accessType: t.accessType, encryptedDisputeReason: encryptField(t.disputeReason), createdAt: new Date(t.createdAt),
  status: t.status, adminNotes: t.adminNotes ?? null,
});
export const rowToDispute = (r: Row): DisputeTicket => clean({
  ticketId: r.ticketId, auditLogId: r.auditLogId, patientId: r.patientId, actorId: r.actorId, facilityId: r.facilityId ?? undefined,
  accessType: r.accessType, disputeReason: decryptField(r.encryptedDisputeReason), createdAt: iso(r.createdAt)!,
  status: r.status, adminNotes: r.adminNotes ?? undefined,
} as DisputeTicket);

// ---------- Offline cards, scans, device keys ----------
export const offlineCardToRow = (c: OfflineCardRecord, currentToken: string | null): Row => ({
  id: c.id, patientId: c.patientId, version: c.version, kid: c.kid, payloadHash: c.payloadHash,
  encryptedCurrentToken: currentToken ? encryptField(currentToken) : null,
  issuedAt: new Date(c.issuedAt), expiresAt: new Date(c.expiresAt), revokedAt: date(c.revokedAt),
  revocationReason: c.revocationReason ?? null, supersededById: c.supersededById ?? null,
});
export const rowToOfflineCard = (r: Row): { card: OfflineCardRecord; currentToken: string | null } => ({
  card: clean({
    id: r.id, patientId: r.patientId, version: r.version, kid: r.kid, payloadHash: r.payloadHash,
    issuedAt: iso(r.issuedAt)!, expiresAt: iso(r.expiresAt)!, revokedAt: iso(r.revokedAt),
    revocationReason: r.revocationReason ?? undefined, supersededById: r.supersededById ?? undefined,
  } as OfflineCardRecord),
  currentToken: r.encryptedCurrentToken ? decryptField(r.encryptedCurrentToken) : null,
});
export const scanEventToRow = (e: OfflineScanEventRecord): Row => ({
  id: e.id, patientId: e.patientId, cardVersion: e.cardVersion, cardKid: e.cardKid, clinicianId: e.clinicianId,
  facilityId: e.facilityId, clinicianCountry: e.clinicianCountry, cardCountry: e.cardCountry, reason: e.reason,
  encryptedDetails: enc(e.details), scannedAt: new Date(e.scannedAt), receivedAt: new Date(e.receivedAt),
  deviceKeyThumbprint: e.deviceKeyThumbprint, deviceSig: e.deviceSig, auditLogId: e.auditLogId, status: e.status,
});
export const rowToScanEvent = (r: Row): OfflineScanEventRecord => clean({
  id: r.id, patientId: r.patientId, cardVersion: r.cardVersion, cardKid: r.cardKid, clinicianId: r.clinicianId,
  facilityId: r.facilityId, clinicianCountry: r.clinicianCountry, cardCountry: r.cardCountry, reason: r.reason,
  details: dec(r.encryptedDetails), scannedAt: iso(r.scannedAt)!, receivedAt: iso(r.receivedAt)!,
  deviceKeyThumbprint: r.deviceKeyThumbprint, status: r.status, auditLogId: r.auditLogId, deviceSig: r.deviceSig,
} as OfflineScanEventRecord);
export const deviceKeyToRow = (k: DeviceKeyEntity): Row => ({
  clinicianId: k.clinicianId, thumbprint: k.thumbprint, publicJwk: k.publicJwk as object, boundAt: new Date(k.boundAt),
});
export const rowToDeviceKey = (r: Row): DeviceKeyEntity => ({
  clinicianId: r.clinicianId, thumbprint: r.thumbprint, publicJwk: r.publicJwk, boundAt: iso(r.boundAt)!,
});

// ---------- Record flags ----------
export const recordFlagToRow = (f: RecordFlag): Row => ({
  id: f.id, recordId: f.recordId, patientId: f.patientId, resourceType: f.resourceType, encryptedNote: encryptField(f.note),
  authorClinicianId: f.authorClinicianId, status: f.status, createdAt: new Date(f.createdAt),
});
export const rowToRecordFlag = (r: Row): RecordFlag => ({
  id: r.id, recordId: r.recordId, patientId: r.patientId, resourceType: r.resourceType, note: decryptField(r.encryptedNote),
  authorClinicianId: r.authorClinicianId, createdAt: iso(r.createdAt)!, status: r.status,
});

// ---------- Notifications (recipient, title and body encrypted: bodies can hold one-time codes) ----------
export const notificationToRow = (n: NotificationEntity, createdAt = new Date()): Row => ({
  id: crypto.randomUUID(), channel: n.channel, encryptedRecipient: encryptField(n.to),
  encryptedTitle: enc(n.title), encryptedBody: encryptField(n.body), createdAt,
});
export const rowToNotification = (r: Row): NotificationEntity => clean({
  channel: r.channel, to: decryptField(r.encryptedRecipient), title: dec(r.encryptedTitle), body: decryptField(r.encryptedBody),
});
