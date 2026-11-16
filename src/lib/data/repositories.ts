/**
 * MEDISTRY data repositories (write-through design).
 *
 * The in-memory engines (audit chain, clinical store, consent, break-glass, offline cards and scans, flags,
 * disputes, notifications, patient and code maps) are the synchronous working set: every read is served from
 * memory, exactly as before. Each engine reports every write and every in-place change to these repositories.
 *
 *   memory   (src/lib/data/memory)  no-op repositories: nothing outlives the process (default; `npm test`).
 *   postgres (src/lib/data/prisma)  each write is queued and stored through Prisma, in order; at start-up the
 *                                   working set is rebuilt from the database (loadSnapshot + engine hydrate()).
 *
 * Limit: one application instance per database. A second instance would not see the first one's in-memory
 * state. The audit chain itself cannot fork in the database: appends run under an advisory lock and must
 * continue the stored chain.
 */
import type { PatientEntity } from '../patient/profile.ts';
import type { ChainedAuditEntry } from '../audit/hashChain.ts';
import type { StoredClinicalRecord } from '../clinical/store.ts';
import type { PendingAccessRequest, StoredConsentGrant } from '../consent/consentManager.ts';
import type { StoredEmergencyGrant } from '../emergency/breakGlassEngine.ts';
import type { OfflineCardRecord } from '../emergency/offlineCardStore.ts';
import type { OfflineScanEventRecord } from '../emergency/offlineScans.ts';
import type { RecordFlag } from '../clinical/recordFlags.ts';
import type { DisputeTicket } from '../audit/accessLogManager.ts';
import type { SeedClinician, SeedFacility } from '../../../prisma/seed.ts';
import type { AccountRepo, UserAccount } from '../auth/accounts.ts';
import type { ProxyRepo, ProxyRelationship } from '../auth/proxies.ts';
import type { CredentialDocumentRepo } from '../auth/staff.ts';
import type { CredentialDocument } from '../clinical/fileUpload.ts';
import type { NotificationDelivery, NotificationDeliveryRepo } from '../notifications/deliveries.ts';
import type { FacilityApiClient, FacilityApiClientRepo } from '../integrations/apiClients.ts';
import type { FacilityPatientLink, FacilityPatientLinkRepo } from '../integrations/fhirImport.ts';
import type { IntakeSession, IntakeSessionRepo } from '../intake/intakeService.ts';

export type StorageMode = 'memory' | 'postgres';

/** An emergency code as the runtime knows it. Stored hashed (lookup) and encrypted (patient display). */
export interface EmergencyCodeEntity {
  patientId: string;
  rawCode: string;
  formattedCode: string;
  isActive: boolean;
  createdAt: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface DeviceKeyEntity {
  clinicianId: string;
  thumbprint: string;
  publicJwk: JsonWebKey;
  boundAt: string;
}

export interface NotificationEntity {
  channel: 'SMS' | 'EMAIL' | 'PUSH';
  to: string;
  title?: string;
  body: string;
}

export interface PatientRepo { savePatient(p: PatientEntity): void }
export interface FacilityRepo { saveFacility(f: SeedFacility): void }
export interface ClinicianRepo { saveClinician(c: SeedClinician): void }
export interface EmergencyCodeRepo { saveEmergencyCode(c: EmergencyCodeEntity): void }
export interface RecordRepo { saveRecord(r: StoredClinicalRecord): void; saveRecordFlag(f: RecordFlag): void }
export interface ConsentRepo { saveConsentRequest(r: PendingAccessRequest): void; saveConsentGrant(g: StoredConsentGrant): void }
export interface EmergencyGrantRepo { saveEmergencyGrant(g: StoredEmergencyGrant): void; saveDispute(t: DisputeTicket): void }
export interface OfflineCardRepo { saveOfflineCard(c: OfflineCardRecord, currentToken: string | null): void }
export interface OfflineScanRepo { saveScanEvent(e: OfflineScanEventRecord): void; saveDeviceKey(k: DeviceKeyEntity): void }
export interface AuditRepo { appendAudit(e: ChainedAuditEntry): void }
export interface NotificationRepo { saveNotification(n: NotificationEntity): void }

/** Everything needed to rebuild the working set after a restart. */
export interface Snapshot {
  facilities: SeedFacility[];
  clinicians: SeedClinician[];
  patients: PatientEntity[];
  emergencyCodes: EmergencyCodeEntity[];
  records: StoredClinicalRecord[];
  audit: ChainedAuditEntry[];
  consentRequests: PendingAccessRequest[];
  consentGrants: StoredConsentGrant[];
  emergencyGrants: StoredEmergencyGrant[];
  disputes: DisputeTicket[];
  offlineCards: Array<{ card: OfflineCardRecord; currentToken: string | null }>;
  scanEvents: OfflineScanEventRecord[];
  deviceKeys: DeviceKeyEntity[];
  recordFlags: RecordFlag[];
  notifications: NotificationEntity[];
  // Phase 12 (absent in snapshots written before it: treated as empty)
  userAccounts?: UserAccount[];
  proxyRelationships?: ProxyRelationship[];
  credentialDocuments?: CredentialDocument[];
  // Phase 13
  notificationDeliveries?: NotificationDelivery[];
  // Phase 15
  facilityApiClients?: FacilityApiClient[];
  facilityPatientLinks?: FacilityPatientLink[];
  intakeSessions?: IntakeSession[];
}

export interface Persistence extends PatientRepo, FacilityRepo, ClinicianRepo, EmergencyCodeRepo, RecordRepo,
  ConsentRepo, EmergencyGrantRepo, OfflineCardRepo, OfflineScanRepo, AuditRepo, NotificationRepo,
  AccountRepo, ProxyRepo, CredentialDocumentRepo, NotificationDeliveryRepo, FacilityApiClientRepo, FacilityPatientLinkRepo, IntakeSessionRepo {
  readonly mode: StorageMode;
  /** The stored working set, or null for memory storage. */
  loadSnapshot(): Promise<Snapshot | null>;
  /** Resolves when every queued write has been attempted. */
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): { mode: StorageMode; pendingWrites: number; failedWrites: number };
}
