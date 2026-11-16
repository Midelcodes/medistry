/**
 * PostgreSQL repositories through Prisma (write-through).
 *
 * Writes are queued and applied one at a time, in the order the engines made them, so a record is never stored
 * before the patient it belongs to. A failed write is counted and logged by entity and error code only (no
 * values). flush() waits for the queue; the server flushes before it exits.
 *
 * Audit chain: every append runs in a transaction that first takes LOCK TABLE "AuditLog" IN EXCLUSIVE MODE
 * (other appenders wait; readers do not), reads the latest entry, and only inserts if the new entry continues
 * it. appendComputed() is the database-authoritative variant: it computes the sequence number and hashes
 * under the same lock, so any number of concurrent writers produce one valid chain.
 */
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { computeAuditEntryHash, GENESIS_HASH, type AuditRecordPayload, type ChainedAuditEntry } from '../../audit/hashChain.ts';
import type { Persistence, Snapshot } from '../repositories.ts';
import * as M from './mappers.ts';
import { log } from '../../ops/logger.ts';

const TX_OPTIONS = { maxWait: 20_000, timeout: 20_000 };

export type PrismaPersistence = Persistence & {
  client: PrismaClient;
  /** Database-authoritative append (computes sequence and hashes under the lock). */
  appendComputed(payload: Omit<AuditRecordPayload, 'sequenceNumber' | 'timestamp'> & { timestamp?: string }): Promise<ChainedAuditEntry>;
  /** Deletes every row (demo reseeding only). */
  wipe(): Promise<void>;
};

export function createPrismaPersistence(client: PrismaClient = new PrismaClient()): PrismaPersistence {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let failed = 0;

  const enqueue = (label: string, op: () => Promise<unknown>) => {
    pending++;
    tail = tail.then(op).then(() => undefined, (err: any) => {
      failed++;
      // Entity and error code only: never log values (they may be personal data). Redacted by the logger as well.
      log('error', 'storage_write_failed', { entity: label, code: err?.code, error: String(err?.message || err).split('\n').filter(Boolean).pop()?.slice(0, 160) || 'error' });
    }).finally(() => { pending--; });
  };

  const upsertUser = (tx: any, u: { id: string; role: string; countryCode: string }) =>
    tx.user.upsert({ where: { id: u.id }, create: u, update: { role: u.role, countryCode: u.countryCode } });

  async function appendContinuing(entry: ChainedAuditEntry) {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "AuditLog" IN EXCLUSIVE MODE');
      const latest = await tx.auditLog.findFirst({ orderBy: { sequenceNumber: 'desc' } });
      const expectedSeq = (latest?.sequenceNumber ?? 0) + 1;
      const expectedPrev = latest?.currentHash ?? GENESIS_HASH;
      if (entry.sequenceNumber !== expectedSeq || entry.previousHash !== expectedPrev) {
        throw Object.assign(new Error(`audit append refused: entry ${entry.sequenceNumber} does not continue the stored chain at ${expectedSeq - 1}`), { code: 'CHAIN_FORK' });
      }
      await tx.auditLog.create({ data: M.auditToRow(entry) as any });
    }, TX_OPTIONS);
  }

  const persistence: PrismaPersistence = {
    mode: 'postgres',
    client,

    saveFacility: (f) => enqueue(`facility ${f.id}`, () => {
      const row = M.facilityToRow(f);
      return client.facility.upsert({ where: { id: f.id }, create: row as any, update: row as any });
    }),
    saveClinician: (c) => enqueue(`clinician ${c.id}`, () => {
      const { user, clinician } = M.clinicianToRows(c);
      return client.$transaction(async (tx) => {
        await upsertUser(tx, user);
        await tx.clinician.upsert({ where: { id: c.id }, create: clinician as any, update: clinician as any });
      }, TX_OPTIONS);
    }),
    savePatient: (p) => {
      const { user, patient } = M.patientToRows(p); // encrypt now, so the stored state is this moment's state
      enqueue(`patient ${p.id}`, () => client.$transaction(async (tx) => {
        await upsertUser(tx, user);
        await tx.patient.upsert({ where: { id: patient.id }, create: patient as any, update: patient as any });
      }, TX_OPTIONS));
    },
    saveEmergencyCode: (c) => {
      const row = M.codeToRow(c);
      const { createdAt: _keep, ...update } = row;
      enqueue('emergency code', () => client.emergencyCode.upsert({ where: { codeHash: row.codeHash }, create: row as any, update: update as any }));
    },
    saveRecord: (r) => {
      const row = M.recordToRow(r);
      enqueue(`record ${r.id}`, () => client.patientRecord.upsert({ where: { id: r.id }, create: row as any, update: row as any }));
    },
    saveRecordFlag: (f) => {
      const row = M.recordFlagToRow(f);
      enqueue(`flag ${f.id}`, () => client.recordFlag.upsert({ where: { id: f.id }, create: row as any, update: row as any }));
    },
    saveConsentRequest: (q) => {
      const row = M.consentRequestToRow(q);
      enqueue(`consent request ${q.id}`, () => client.consentRequest.upsert({ where: { id: q.id }, create: row as any, update: row as any }));
    },
    saveConsentGrant: (g) => {
      const row = M.consentGrantToRow(g);
      enqueue(`consent grant ${g.id}`, () => client.consentGrant.upsert({ where: { id: g.id }, create: row as any, update: row as any }));
    },
    saveEmergencyGrant: (g) => {
      const row = M.emergencyGrantToRow(g);
      enqueue(`emergency grant ${g.id}`, () => client.emergencyAccessGrant.upsert({ where: { id: g.id }, create: row as any, update: row as any }));
    },
    saveDispute: (t) => {
      const row = M.disputeToRow(t);
      enqueue(`dispute ${t.ticketId}`, () => client.disputeTicket.upsert({ where: { ticketId: t.ticketId }, create: row as any, update: row as any }));
    },
    saveOfflineCard: (c, token) => {
      const row = M.offlineCardToRow(c, token);
      enqueue(`offline card ${c.id}`, () => client.offlineCard.upsert({ where: { id: c.id }, create: row as any, update: row as any }));
    },
    saveScanEvent: (e) => {
      const row = M.scanEventToRow(e);
      enqueue(`scan event ${e.id}`, () => client.offlineScanEvent.upsert({ where: { id: e.id }, create: row as any, update: row as any }));
    },
    saveDeviceKey: (k) => {
      const row = M.deviceKeyToRow(k);
      enqueue(`device key ${k.thumbprint.slice(0, 12)}`, () => client.clinicianDeviceKey.upsert({
        where: { clinicianId_thumbprint: { clinicianId: k.clinicianId, thumbprint: k.thumbprint } }, create: row as any, update: row as any,
      }));
    },
    saveNotification: (n) => {
      const row = M.notificationToRow(n);
      enqueue('notification', () => client.notificationLog.create({ data: row as any }));
    },
    saveUserAccount: (a) => {
      const { user, facilityAdmin } = M.userAccountToRows(a);
      const { id: _id, createdAt: _created, ...update } = user;
      enqueue(`account ${a.id}`, () => client.$transaction(async (tx) => {
        await tx.user.upsert({ where: { id: a.id }, create: user as any, update: update as any });
        if (facilityAdmin) await tx.facilityAdmin.upsert({ where: { userId: a.id }, create: facilityAdmin, update: { facilityId: facilityAdmin.facilityId } });
      }, TX_OPTIONS));
    },
    saveProxyRelationship: (r) => {
      const row = M.proxyToRow(r);
      enqueue(`proxy ${r.id}`, () => client.proxyRelationship.upsert({ where: { id: r.id }, create: row as any, update: row as any }));
    },
    saveCredentialDocument: (d) => {
      const row = M.credentialDocumentToRow(d);
      enqueue(`licence document ${d.id}`, () => client.clinicianLicenceDocument.upsert({ where: { id: d.id }, create: row as any, update: row as any }));
    },
    saveNotificationDelivery: (d) => {
      const row = M.deliveryToRow(d);
      enqueue('notification delivery', () => client.notificationDelivery.upsert({ where: { id: d.id }, create: row as any, update: row as any }));
    },
    saveFacilityApiClient: (c) => {
      const row = M.apiClientToRow(c);
      enqueue(`api client ${c.id}`, () => client.facilityApiClient.upsert({ where: { id: c.id }, create: row as any, update: row as any }));
    },
    saveFacilityPatientLink: (l) => {
      const row = M.patientLinkToRow(l);
      enqueue('facility identifier link', () => client.facilityPatientLink.upsert({ where: { valueHash: l.valueHash }, create: row as any, update: row as any }));
    },
    saveIntakeSession: (s) => {
      const row = M.intakeToRow(s);
      enqueue(`intake ${s.id}`, () => client.intakeSession.upsert({ where: { id: s.id }, create: row as any, update: row as any }));
    },
    savePatientIdentifier: (i) => {
      const row = M.identifierToRow(i);
      enqueue('patient identifier', () => client.patientIdentifier.upsert({ where: { id: i.id }, create: row as any, update: row as any }));
    },
    saveDuplicateReview: (r) => {
      const row = M.reviewToRow(r);
      enqueue(`duplicate review ${r.id}`, () => client.duplicateReview.upsert({ where: { id: r.id }, create: row as any, update: row as any }));
    },
    savePatientMerge: (m) => {
      const row = M.mergeToRow(m);
      enqueue(`merge ${m.id}`, () => client.patientMerge.upsert({ where: { id: m.id }, create: row as any, update: row as any }));
    },
    saveOutboxMessage: (m) => {
      const row = M.outboxToRow(m);
      enqueue(`outbox ${m.id}`, () => client.outboxMessage.upsert({ where: { id: m.id }, create: row as any, update: row as any }));
    },
    saveFacilityApplication: (a) => {
      const row = M.applicationToRow(a);
      enqueue(`facility application ${a.facilityId}`, () => client.facilityApplication.upsert({ where: { facilityId: a.facilityId }, create: row as any, update: row as any }));
    },
    saveStaffInvite: (i) => {
      const row = M.inviteToRow(i);
      enqueue(`staff invite ${i.id}`, () => client.staffInvite.upsert({ where: { id: i.id }, create: row as any, update: row as any }));
    },
    saveAnomalyFlag: (f) => {
      const row = M.anomalyFlagToRow(f);
      enqueue(`anomaly flag ${f.id}`, () => client.anomalyFlag.upsert({ where: { id: f.id }, create: row as any, update: row as any }));
    },
    saveTriageResult: (r) => {
      const row = M.triageResultToRow(r);
      enqueue(`triage result ${r.id}`, () => client.triageResult.upsert({ where: { id: r.id }, create: row as any, update: row as any }));
    },
    saveSubscription: (s) => {
      const row = M.subscriptionToRow(s);
      enqueue(`subscription ${s.facilityId}`, () => client.subscription.upsert({ where: { facilityId: s.facilityId }, create: row as any, update: row as any }));
    },
    appendAudit: (e) => enqueue(`audit ${e.sequenceNumber}`, () => appendContinuing(e)),

    async appendComputed(payload) {
      return client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "AuditLog" IN EXCLUSIVE MODE');
        const latest = await tx.auditLog.findFirst({ orderBy: { sequenceNumber: 'desc' } });
        const full: AuditRecordPayload = {
          ...payload,
          sequenceNumber: (latest?.sequenceNumber ?? 0) + 1,
          timestamp: payload.timestamp || new Date().toISOString(),
        };
        const previousHash = latest?.currentHash ?? GENESIS_HASH;
        const entry: ChainedAuditEntry = { ...full, id: crypto.randomUUID(), previousHash, currentHash: computeAuditEntryHash(full, previousHash) };
        await tx.auditLog.create({ data: M.auditToRow(entry) as any });
        return entry;
      }, TX_OPTIONS);
    },

    async loadSnapshot(): Promise<Snapshot> {
      const [facilities, clinicians, patients, codes, records, audit, requests, grants, eGrants, disputes, cards, scans, keys, flags, notes,
        users, proxies, documents, deliveries, apiClients, links, intakes, identifiers, reviews, merges, outbox, applications, invites, subscriptions, anomalyFlags, triageResults] = await Promise.all([
        client.facility.findMany(), client.clinician.findMany(), client.patient.findMany(), client.emergencyCode.findMany(),
        client.patientRecord.findMany({ orderBy: [{ createdAt: 'asc' }, { versionId: 'asc' }] }),
        client.auditLog.findMany({ orderBy: { sequenceNumber: 'asc' } }),
        client.consentRequest.findMany(), client.consentGrant.findMany({ orderBy: { createdAt: 'asc' } }),
        client.emergencyAccessGrant.findMany({ orderBy: { grantedAt: 'asc' } }), client.disputeTicket.findMany(),
        client.offlineCard.findMany({ orderBy: { version: 'asc' } }), client.offlineScanEvent.findMany(),
        client.clinicianDeviceKey.findMany(), client.recordFlag.findMany(), client.notificationLog.findMany({ orderBy: { createdAt: 'asc' } }),
        client.user.findMany({ where: { hasAccount: true }, include: { facilityAdmin: true } }),
        client.proxyRelationship.findMany({ orderBy: { createdAt: 'asc' } }), client.clinicianLicenceDocument.findMany(),
        client.notificationDelivery.findMany({ orderBy: { createdAt: 'asc' } }),
        client.facilityApiClient.findMany(), client.facilityPatientLink.findMany(), client.intakeSession.findMany({ orderBy: { createdAt: 'asc' } }),
        client.patientIdentifier.findMany(), client.duplicateReview.findMany({ orderBy: { createdAt: 'asc' } }), client.patientMerge.findMany({ orderBy: { mergedAt: 'asc' } }),
        client.outboxMessage.findMany({ orderBy: { createdAt: 'asc' } }),
        client.facilityApplication.findMany(), client.staffInvite.findMany(), client.subscription.findMany(),
        client.anomalyFlag.findMany({ orderBy: { createdAt: 'asc' } }),
        client.triageResult.findMany({ orderBy: { createdAt: 'asc' } }),
      ]);
      // Keep the seed's order (Nigerian facilities and clinicians first) for the demo pickers.
      // Ties (same millisecond) break by id, so the order is deterministic.
      const byCreated = <T extends { createdAt: Date; id: string }>(xs: T[]) =>
        [...xs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      return {
        facilities: byCreated(facilities).map(M.rowToFacility),
        clinicians: byCreated(clinicians).map(M.rowToClinician),
        patients: byCreated(patients).map(M.rowToPatient),
        emergencyCodes: codes.map(M.rowToCode),
        records: records.map(M.rowToRecord),
        audit: audit.map(M.rowToAudit),
        consentRequests: requests.map(M.rowToConsentRequest),
        consentGrants: grants.map(M.rowToConsentGrant),
        emergencyGrants: eGrants.map(M.rowToEmergencyGrant),
        disputes: disputes.map(M.rowToDispute),
        offlineCards: cards.map(M.rowToOfflineCard),
        scanEvents: scans.map(M.rowToScanEvent),
        deviceKeys: keys.map(M.rowToDeviceKey),
        recordFlags: flags.map(M.rowToRecordFlag),
        notifications: notes.map(M.rowToNotification),
        userAccounts: users.map(M.rowToUserAccount),
        proxyRelationships: proxies.map(M.rowToProxy),
        credentialDocuments: documents.map(M.rowToCredentialDocument),
        notificationDeliveries: deliveries.map(M.rowToDelivery),
        facilityApiClients: apiClients.map(M.rowToApiClient),
        facilityPatientLinks: links.map(M.rowToPatientLink),
        intakeSessions: intakes.map(M.rowToIntake),
        patientIdentifiers: identifiers.map(M.rowToIdentifier),
        duplicateReviews: reviews.map(M.rowToReview),
        patientMerges: merges.map(M.rowToMerge),
        outboxMessages: outbox.map(M.rowToOutbox),
        facilityApplications: applications.map(M.rowToApplication),
        staffInvites: invites.map(M.rowToInvite),
        subscriptions: subscriptions.map(M.rowToSubscription),
        anomalyFlags: anomalyFlags.map(M.rowToAnomalyFlag),
        triageResults: triageResults.map(M.rowToTriageResult),
      };
    },

    async wipe() {
      await persistence.flush();
      await client.$transaction([
        client.notificationLog.deleteMany(), client.disputeTicket.deleteMany(), client.recordFlag.deleteMany(),
        client.proxyRelationship.deleteMany(), client.clinicianLicenceDocument.deleteMany(), client.notificationDelivery.deleteMany(),
        client.intakeSession.deleteMany(), client.facilityPatientLink.deleteMany(), client.facilityApiClient.deleteMany(),
        client.patientIdentifier.deleteMany(), client.duplicateReview.deleteMany(), client.patientMerge.deleteMany(), client.outboxMessage.deleteMany(),
        client.facilityApplication.deleteMany(), client.staffInvite.deleteMany(), client.subscription.deleteMany(), client.anomalyFlag.deleteMany(), client.triageResult.deleteMany(),
        client.offlineScanEvent.deleteMany(), client.clinicianDeviceKey.deleteMany(), client.offlineCard.deleteMany(),
        client.emergencyAccessGrant.deleteMany(), client.consentGrant.deleteMany(), client.consentRequest.deleteMany(),
        client.patientRecord.deleteMany(), client.emergencyCode.deleteMany(), client.patient.deleteMany(),
        client.clinicianFacility.deleteMany(), client.clinician.deleteMany(), client.facilityAdmin.deleteMany(),
        client.session.deleteMany(), client.user.deleteMany(), client.facility.deleteMany(), client.auditLog.deleteMany(),
      ]);
    },

    async flush() {
      // New writes can be queued while we wait; loop until the queue is empty.
      while (pending > 0) await tail;
    },
    async close() {
      await persistence.flush();
      await client.$disconnect();
    },
    stats: () => ({ mode: 'postgres', pendingWrites: pending, failedWrites: failed }),
  };
  return persistence;
}
