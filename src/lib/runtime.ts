/**
 * Builds the application's working set: engines, indexes and the persistence they write through.
 *   - memory storage: seeds the synthetic dataset in memory (the original behaviour).
 *   - postgres storage: rebuilds everything from the database (run `npm run seed` first); refuses to start if
 *     the database is empty or the stored audit chain does not verify.
 * seedDatabase() writes a fresh synthetic dataset through the given persistence (used by `npm run seed`).
 */
import { generateSeedData, type SeedDatabasePayload } from '../../prisma/seed.ts';
import { AuditChainManager } from './audit/hashChain.ts';
import { ClinicalDataStore } from './clinical/store.ts';
import { ClinicalTimelineEngine } from './clinical/timeline.ts';
import { NotificationDispatcher, ConsoleNotificationProvider, type INotificationProvider } from './notifications/dispatcher.ts';
import { NotificationDeliveryStore } from './notifications/deliveries.ts';
import { AfricasTalkingNotificationProvider, africasTalkingConfig } from './notifications/africasTalking.ts';
import { UssdService } from './ussd/ussdService.ts';
import { SecureDocumentManager } from './clinical/fileUpload.ts';
import { FacilityApiClientStore } from './integrations/apiClients.ts';
import { FacilityPatientLinkStore, FhirImportService } from './integrations/fhirImport.ts';
import { createIntakeAdapters } from './intake/adapters.ts';
import { IntakeService } from './intake/intakeService.ts';
import { IdentityStore } from './identity/identityStore.ts';
import { MasterPatientIndex } from './identity/mpi.ts';
import { createIdentityVerifier } from './identity/IdentityVerifier.ts';
import { PatientRegistrationService } from './identity/registration.ts';
import { createHieConnectors, type HieConnector } from './integrations/hie/HieConnector.ts';
import { NationalExchangeService } from './integrations/hie/nationalExchange.ts';
import { PharmacyService } from './integrations/pharmacy.ts';
import { normalizePatientCode } from './code/crockford.ts';
import type { SeedFacility } from '../../prisma/seed.ts';
import { BillingService } from './billing/billingService.ts';
import { BillingNotConfigured, loadPlans, type BillingProvider } from './billing/BillingProvider.ts';
import { PaystackProvider } from './billing/PaystackProvider.ts';
import { MpesaDarajaProvider } from './billing/MpesaDarajaProvider.ts';
import { FacilityOnboardingService } from './facilities/onboarding.ts';
import { EmergencyBreakGlassEngine } from './emergency/breakGlassEngine.ts';
import { OfflineCardStore } from './emergency/offlineCardStore.ts';
import { OfflineScanService } from './emergency/offlineScans.ts';
import { CardContentSync } from './emergency/cardSync.ts';
import { RecordFlagStore } from './clinical/recordFlags.ts';
import { ConsentLifecycleManager } from './consent/consentManager.ts';
import { PatientAccessLogManager } from './audit/accessLogManager.ts';
import { seedClinicalRecords } from './site/seedClinical.ts';
import { AccountStore } from './auth/accounts.ts';
import { PatientAuthService } from './auth/patientAuth.ts';
import { StaffService } from './auth/staff.ts';
import { ProxyService } from './auth/proxies.ts';
import { appSecret, DEMO_MODE } from './security/config.ts';
import type { PatientEntity } from './patient/profile.ts';
import type { Persistence, Snapshot } from './data/repositories.ts';

export interface Runtime {
  seedData: SeedDatabasePayload;
  patientsById: Map<string, PatientEntity>;
  patientsByCode: Map<string, PatientEntity>;
  codeByPatient: Map<string, { rawCode: string; formattedCode: string }>;
  auditManager: AuditChainManager;
  clinicalStore: ClinicalDataStore;
  timelineEngine: ClinicalTimelineEngine;
  consoleProvider: ConsoleNotificationProvider;
  dispatcher: NotificationDispatcher;
  deliveries: NotificationDeliveryStore;
  ussd: UssdService;
  apiClients: FacilityApiClientStore;
  patientLinks: FacilityPatientLinkStore;
  fhirImport: FhirImportService;
  intake: IntakeService;
  identity: IdentityStore;
  mpi: MasterPatientIndex;
  registration: PatientRegistrationService;
  connectors: Map<string, HieConnector>;
  nationalExchange: NationalExchangeService;
  pharmacy: PharmacyService;
  addFacility: (f: SeedFacility) => void;
  billingProviders: Map<string, BillingProvider>;
  billing: BillingService;
  onboarding: FacilityOnboardingService;
  emergencyEngine: EmergencyBreakGlassEngine;
  offlineCardStore: OfflineCardStore;
  consentManager: ConsentLifecycleManager;
  accessLogManager: PatientAccessLogManager;
  recordFlags: RecordFlagStore;
  offlineScans: OfflineScanService;
  accounts: AccountStore;
  patientAuth: PatientAuthService;
  staff: StaffService;
  proxies: ProxyService;
  persistence: Persistence;
}

const scanUrlFor = (formattedCode: string) => `https://medistry.health/e/${formattedCode}`;

/**
 * SMS_PROVIDER=africastalking sends SMS through Africa's Talking (AT_USERNAME, AT_API_KEY, AT_SENDER_ID, AT_ENV);
 * email and push still go to the console provider. Anything else: the console provider (default).
 */
function smsProvider(consoleProvider: ConsoleNotificationProvider, deliveries: NotificationDeliveryStore): INotificationProvider {
  const choice = (process.env.SMS_PROVIDER || 'console').trim().toLowerCase();
  if (choice === 'africastalking') {
    return new AfricasTalkingNotificationProvider({ config: africasTalkingConfig(), deliveries, fallback: consoleProvider });
  }
  if (choice !== 'console') console.warn(`[notifications] SMS_PROVIDER=${choice.replace(/[^a-z_-]/g, '').slice(0, 20)} is not supported; using the console provider.`);
  return consoleProvider;
}

/** Test/sandbox billing providers configured in the environment (a missing or live configuration is skipped). */
function createBillingProviders(paystackPlanCodes: Record<string, string | null>): Map<string, BillingProvider> {
  const out = new Map<string, BillingProvider>();
  const tryAdd = (country: string, make: () => BillingProvider) => {
    try { out.set(country, make()); } catch (err) {
      if (!(err instanceof BillingNotConfigured)) throw err;
    }
  };
  if (process.env.PAYSTACK_SECRET_KEY) tryAdd('NG', () => new PaystackProvider({ secretKey: process.env.PAYSTACK_SECRET_KEY, webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET, planCodes: paystackPlanCodes }));
  if (process.env.DARAJA_CONSUMER_KEY) tryAdd('KE', () => new MpesaDarajaProvider({
    env: process.env.DARAJA_ENV, consumerKey: process.env.DARAJA_CONSUMER_KEY, consumerSecret: process.env.DARAJA_CONSUMER_SECRET,
    shortCode: process.env.DARAJA_SHORT_CODE, passKey: process.env.DARAJA_PASSKEY, callbackSecret: process.env.DARAJA_CALLBACK_SECRET,
  }));
  return out;
}

function buildEngines(seedData: SeedDatabasePayload, auditEntries: Snapshot['audit'] = []) {
  const auditManager = new AuditChainManager(auditEntries);
  const clinicalStore = new ClinicalDataStore(auditManager);
  const timelineEngine = new ClinicalTimelineEngine(clinicalStore);
  const consoleProvider = new ConsoleNotificationProvider();
  const deliveries = new NotificationDeliveryStore();
  consoleProvider.deliveries = deliveries;
  const dispatcher = new NotificationDispatcher(smsProvider(consoleProvider, deliveries));
  const emergencyEngine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);
  const offlineCardStore = new OfflineCardStore(auditManager);
  const consentManager = new ConsentLifecycleManager(auditManager);
  const accessLogManager = new PatientAccessLogManager(auditManager);

  const patientsById = new Map<string, PatientEntity>();
  const patientsByCode = new Map<string, PatientEntity>();
  const codeByPatient = new Map<string, { rawCode: string; formattedCode: string }>();
  for (const entry of seedData.patients) {
    patientsById.set(entry.patient.id, entry.patient);
    patientsByCode.set(entry.emergencyCode.rawCode, entry.patient);
    patientsByCode.set(entry.emergencyCode.formattedCode, entry.patient);
    codeByPatient.set(entry.patient.id, { rawCode: entry.emergencyCode.rawCode, formattedCode: entry.emergencyCode.formattedCode });
  }
  for (const f of seedData.facilities) {
    timelineEngine.registerFacility(f.id, f.name);
    accessLogManager.registerFacility(f.id, f.name);
  }
  for (const c of seedData.clinicians) {
    for (const id of [c.id, c.userId]) {
      timelineEngine.registerClinician(id, `${c.fullName} (${c.specialty})`);
      accessLogManager.registerClinician(id, `${c.fullName} (${c.specialty})`);
    }
  }
  const recordFlags = new RecordFlagStore({ clinicalStore, auditManager, dispatcher });
  const offlineScans = new OfflineScanService({
    auditManager, dispatcher, cardStore: offlineCardStore, clinicians: seedData.clinicians, facilities: seedData.facilities, patientsById,
  });
  // Sign-in (Phase 12). Session tokens, sign-in codes and demo TOTP secrets are keyed from JWT_SECRET.
  const serverKey = appSecret('JWT_SECRET');
  const accounts = new AccountStore();
  const patientAuth = new PatientAuthService({ accounts, dispatcher, auditManager, serverKey });
  const proxies = new ProxyService({ accounts, auditManager, dispatcher, patientsById });
  const staff = new StaffService({
    accounts, auditManager, dispatcher, clinicians: seedData.clinicians, facilities: seedData.facilities, serverKey, demoMode: DEMO_MODE,
    onClinicianAdded: (c) => {
      for (const id of [c.id, c.userId]) {
        timelineEngine.registerClinician(id, `${c.fullName} (${c.specialty})`);
        accessLogManager.registerClinician(id, `${c.fullName} (${c.specialty})`);
      }
    },
  });
  // Patients get the break-glass SMS on their own sign-in phone (fallback: their recovery email), not only their contacts.
  emergencyEngine.contactLookup = (patientId) => {
    const account = accounts.byPatient(patientId);
    return account ? { phone: accounts.phoneOf(account), email: accounts.emailOf(account) } : undefined;
  };
  const ussd = new UssdService({ accounts, patientsById, auditManager, accessLogManager, offlineCards: offlineCardStore });
  // Records from existing EMRs (FHIR import) and from paper (AI intake drafts a doctor signs). Phase 15.
  const documents = new SecureDocumentManager();
  const patientLinks = new FacilityPatientLinkStore();
  const apiClients = new FacilityApiClientStore({ auditManager, facilities: seedData.facilities });
  // One person, one record (Phase 16): national identifiers (blind index), duplicate review, merge/unmerge.
  const identity = new IdentityStore();
  const mpi = new MasterPatientIndex({ patientsById, accounts, auditManager });
  clinicalStore.linkedPatientIds = (id) => mpi.linkedIds(id);
  emergencyEngine.mergedProfiles = (id) => mpi.linkedIds(id).map((x) => patientsById.get(x)).filter((p): p is PatientEntity => !!p);
  const registration = new PatientRegistrationService({
    seedData, patientsById, patientsByCode, codeByPatient, auditManager, identity, mpi, verifierFor: createIdentityVerifier(), patientAuth,
  });
  const fhirImport = new FhirImportService({
    clinicalStore, patientsById, clinicians: seedData.clinicians, consentManager, auditManager, links: patientLinks, documents, identity, mpi,
    facilities: seedData.facilities, dispatcher, accounts,
  });
  // National exchanges, labs and pharmacies (Phase 17).
  const connectors = createHieConnectors();
  const nationalExchange = new NationalExchangeService({ connectors, clinicalStore, consentManager, identity, patientsById, auditManager });
  const pharmacy = new PharmacyService({
    clinicalStore, consentManager, offlineCards: offlineCardStore, dispatcher, accounts, auditManager, facilities: seedData.facilities, patientsById,
    patientByCode: (code) => {
      const p = patientsByCode.get(normalizePatientCode(code));
      return p?.mergedIntoPatientId ? patientsById.get(mpi.canonical(p.id)) : p;
    },
  });
  // A facility created at runtime (labs, pharmacies). attach() makes it write through to storage too.
  const addFacility = (f: SeedFacility) => {
    seedData.facilities.push(f);
    timelineEngine.registerFacility(f.id, f.name);
    accessLogManager.registerFacility(f.id, f.name);
  };
  const intakeAdapters = createIntakeAdapters();
  const intake = new IntakeService({ clinicalStore, auditManager, documents, ...intakeAdapters });
  // Facilities sign up, run their staff and pay (Phase 18). Billing providers: test/sandbox only, from the environment.
  const plans = loadPlans();
  const billingProviders = createBillingProviders(plans.paystackPlanCodes);
  const billing = new BillingService({ auditManager, facilities: seedData.facilities, providers: () => billingProviders, demoMode: DEMO_MODE }, plans);
  const onboarding = new FacilityOnboardingService({ facilities: seedData.facilities, clinicians: seedData.clinicians, addFacility, accounts, patientAuth, dispatcher, auditManager, billing });
  return {
    seedData, patientsById, patientsByCode, codeByPatient, auditManager, clinicalStore, timelineEngine, consoleProvider,
    dispatcher, deliveries, emergencyEngine, offlineCardStore, consentManager, accessLogManager, recordFlags, offlineScans,
    accounts, patientAuth, staff, proxies, ussd, apiClients, patientLinks, fhirImport, intake, identity, mpi, registration,
    connectors, nationalExchange, pharmacy, addFacility, billingProviders, billing, onboarding,
  };
}

/** Connects every engine to the repositories, then starts keeping the card in step with signed records. */
function attach(rt: Omit<Runtime, 'persistence'>, persistence: Persistence): Runtime {
  rt.auditManager.persistence = persistence;
  rt.clinicalStore.persistence = persistence;
  rt.consentManager.persistence = persistence;
  rt.accessLogManager.persistence = persistence;
  rt.emergencyEngine.persistence = persistence;
  rt.offlineCardStore.persistence = persistence;
  rt.offlineScans.persistence = persistence;
  rt.recordFlags.persistence = persistence;
  rt.consoleProvider.persistence = persistence;
  rt.deliveries.persistence = persistence;
  rt.apiClients.persistence = persistence;
  rt.patientLinks.persistence = persistence;
  rt.intake.persistence = persistence;
  rt.identity.persistence = persistence;
  rt.mpi.persistence = persistence;
  rt.registration.persistence = persistence;
  rt.nationalExchange.persistence = persistence;
  rt.billing.persistence = persistence;
  rt.onboarding.persistence = persistence;
  connectAuth(rt, persistence);
  rt.staff.ensureDemoAdmins((f) => !rt.onboarding.hasApplication(f.id)); // never for self-registered facilities
  rt.staff.bootstrapPlatformAdmin();
  const cardSync = new CardContentSync({ patientsById: rt.patientsById, dispatcher: rt.dispatcher, auditManager: rt.auditManager });
  cardSync.persistence = persistence;
  rt.clinicalStore.onFinalRecord((event) => cardSync.handle(event));
  // Doctor-signed records go to the national exchange when the patient consents (outbox; sent by the worker loop).
  rt.clinicalStore.onFinalRecord((event) => { rt.nationalExchange.onFinalRecord(event); });
  const addFacility = (f: SeedFacility) => { rt.addFacility(f); persistence.saveFacility(f); };
  rt.onboarding.setAddFacility(addFacility);
  return { ...rt, persistence, addFacility };
}

function connectAuth(rt: Omit<Runtime, 'persistence'>, persistence: Persistence): void {
  rt.accounts.persistence = persistence;
  rt.proxies.persistence = persistence;
  rt.staff.persistence = persistence;
  rt.patientAuth.persistence = persistence;
}

/** Fresh synthetic dataset, written through `persistence` as it is created. */
function seedFresh(persistence: Persistence): Runtime {
  const seedData = generateSeedData();
  const rt = buildEngines(seedData);
  // Repositories first, so seeding writes (records, audit) are stored too; card sync starts after seeding.
  for (const engine of [rt.auditManager, rt.clinicalStore, rt.consentManager, rt.accessLogManager, rt.emergencyEngine,
    rt.offlineCardStore, rt.offlineScans, rt.recordFlags, rt.consoleProvider] as Array<{ persistence?: unknown }>) {
    engine.persistence = persistence;
  }
  for (const f of seedData.facilities) persistence.saveFacility(f);
  for (const c of seedData.clinicians) persistence.saveClinician(c);
  for (const { patient, emergencyCode } of seedData.patients) {
    persistence.savePatient(patient);
    persistence.saveEmergencyCode({
      patientId: patient.id, rawCode: emergencyCode.rawCode, formattedCode: emergencyCode.formattedCode,
      isActive: true, createdAt: patient.createdAt,
    });
  }
  seedClinicalRecords(rt.clinicalStore, seedData.patients.map((p) => p.patient), seedData.clinicians, seedData.facilities,
    new Map(seedData.patients.map((p) => [p.patient.id, p.encounters])));
  return attach(rt, persistence);
}

/** Working set rebuilt from stored data. */
function hydrate(snapshot: Snapshot, persistence: Persistence): Runtime {
  const codes = new Map(snapshot.emergencyCodes.filter((c) => c.isActive).map((c) => [c.patientId, c]));
  const seedData: SeedDatabasePayload = {
    facilities: snapshot.facilities,
    clinicians: snapshot.clinicians,
    patients: snapshot.patients.map((patient) => {
      const code = codes.get(patient.id);
      if (!code) throw new Error(`Stored patient ${patient.id} has no active emergency code`);
      patient.activeEmergencyCodeId = code.rawCode;
      return { patient, emergencyCode: { rawCode: code.rawCode, formattedCode: code.formattedCode, scanUrl: scanUrlFor(code.formattedCode) }, encounters: [] };
    }),
  };
  const rt = buildEngines(seedData, snapshot.audit);
  const chain = rt.auditManager.verifyChain();
  if (!chain.valid) {
    // Fail closed: a broken stored audit chain means tampering or corruption.
    throw new Error(`Stored audit chain does not verify (${chain.error}). Refusing to start.`);
  }
  rt.clinicalStore.hydrate(snapshot.records);
  rt.consentManager.hydrate(snapshot.consentRequests, snapshot.consentGrants);
  rt.accessLogManager.hydrate(snapshot.disputes);
  rt.emergencyEngine.hydrate(snapshot.emergencyGrants);
  rt.offlineCardStore.hydrate(snapshot.offlineCards);
  rt.offlineScans.hydrate(snapshot.scanEvents, snapshot.deviceKeys);
  rt.recordFlags.hydrate(snapshot.recordFlags);
  rt.consoleProvider.hydrate(snapshot.notifications);
  rt.deliveries.hydrate(snapshot.notificationDeliveries || []);
  rt.apiClients.hydrate(snapshot.facilityApiClients || []);
  rt.patientLinks.hydrate(snapshot.facilityPatientLinks || []);
  rt.intake.hydrate(snapshot.intakeSessions || []);
  rt.identity.hydrate(snapshot.patientIdentifiers || []);
  rt.mpi.hydrate(snapshot.duplicateReviews || [], snapshot.patientMerges || []);
  rt.nationalExchange.hydrate(snapshot.outboxMessages || []);
  rt.billing.hydrate(snapshot.subscriptions || []);
  rt.onboarding.hydrate(snapshot.facilityApplications || [], snapshot.staffInvites || []);
  rt.accounts.hydrate(snapshot.userAccounts || []);
  for (const patient of snapshot.patients) {
    const account = rt.accounts.get(patient.userId);
    if (account && account.role === 'PATIENT') account.patientId = patient.id; // the link is Patient.userId
  }
  rt.proxies.hydrate(snapshot.proxyRelationships || []);
  rt.staff.hydrate(snapshot.credentialDocuments || []);
  return attach(rt, persistence);
}

export async function createRuntime(persistence: Persistence): Promise<Runtime> {
  const snapshot = await persistence.loadSnapshot();
  if (snapshot === null) return seedFresh(persistence); // memory storage
  if (!snapshot.patients.length) {
    throw new Error('The database is empty. Seed it first: STORAGE=postgres npm run seed');
  }
  return hydrate(snapshot, persistence);
}

/** Writes the synthetic dataset through `persistence` and waits until it is stored. */
export async function seedDatabase(persistence: Persistence): Promise<{ patients: number; records: number; auditEntries: number }> {
  const rt = seedFresh(persistence);
  await persistence.flush();
  return {
    patients: rt.patientsById.size,
    records: [...rt.patientsById.keys()].reduce((n, id) => n + rt.clinicalStore.getLatestFinalRecords(id, 'Encounter').length, 0),
    auditEntries: rt.auditManager.getEntries().length,
  };
}

/** Exported for tests: rebuild a runtime from a snapshot. */
export const hydrateRuntime = hydrate;
