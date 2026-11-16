/**
 * MEDISTRY Patient Profile & AES-256-GCM Field-Level Encryption
 * Ensures zero plaintext demographic or clinical PII/PHI is stored at rest.
 */

import crypto from 'node:crypto';
import { deploymentCountry } from '../security/config.ts';
import { keyProvider, type KeyProvider } from '../crypto/keyProvider.ts';

// Keys come from the KeyProvider (crypto/keyProvider.ts): FIELD_ENCRYPTION_KEY (64 hex chars) is the current
// version; earlier versions stay readable for rotation. If unset or a published default, a random per-process key.

export interface EncryptedCiphertext {
  iv: string;         // 12 bytes hex
  tag: string;        // 16 bytes hex (GCM authentication tag)
  ciphertext: string; // Hex payload
}

/** Key version of a ciphertext: "v<n>:" prefix, or 1 for ciphertexts written before versioning. */
export function fieldKeyVersionOf(encryptedPayload: string): number {
  const m = /^v(\d{1,4}):/.exec(encryptedPayload);
  return m ? Number(m[1]) : 1;
}

/**
 * Encrypts a plaintext string using AES-256-GCM with authenticated tag, under the current key version.
 */
export function encryptField(plaintext: string, provider: KeyProvider = keyProvider()): string {
  const { version, key } = provider.getFieldEncryptionKey();
  const iv = crypto.randomBytes(12); // Recommended 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  // Format: v<version>:iv:tag:ciphertext
  return `v${version}:${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM ciphertext payload and validates integrity tag.
 */
export function decryptField(encryptedPayload: string, provider: KeyProvider = keyProvider()): string {
  const version = fieldKeyVersionOf(encryptedPayload);
  const parts = encryptedPayload.replace(/^v\d{1,4}:/, '').split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format: expected [v<n>:]iv:tag:ciphertext');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const { key } = provider.getFieldEncryptionKey(version);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/** Re-encrypts a ciphertext under the current key version (unchanged if it already uses it). For key rotation. */
export function reencryptField(encryptedPayload: string, provider: KeyProvider = keyProvider()): string {
  if (fieldKeyVersionOf(encryptedPayload) === provider.getFieldEncryptionKey().version && /^v\d/.test(encryptedPayload)) return encryptedPayload;
  return encryptField(decryptField(encryptedPayload, provider), provider);
}

export type BloodGroup = 'A_POSITIVE' | 'A_NEGATIVE' | 'B_POSITIVE' | 'B_NEGATIVE' | 'AB_POSITIVE' | 'AB_NEGATIVE' | 'O_POSITIVE' | 'O_NEGATIVE' | 'UNKNOWN';
export type Genotype = 'AA' | 'AS' | 'SS' | 'AC' | 'SC' | 'UNKNOWN';

export interface EmergencyContact {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  email?: string;
  priority: number;
}

export interface PatientAllergy {
  substance: string;
  category: 'drug' | 'food' | 'environment';
  reaction: string;
  severity: 'severe' | 'moderate' | 'mild';
  // 'patient-reported': stated by the patient (e.g. at onboarding), not verified by a clinician
  source?: 'clinician' | 'patient-reported';
}

export interface ActiveMedication {
  id: string;         // Stable per-patient id; patients pick medications for their offline card by id
  medicationName: string;
  dose: string;
  route: string;
  sinceDate: string;
}

export interface PatientDemographics {
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  gender: 'male' | 'female' | 'other';
  nin?: string;        // Nigerian National Identification Number
  photoUrl?: string;
}

export interface PatientEntity {
  id: string;
  userId: string;
  countryCode: string;
  primaryFacilityId?: string;
  // Set when a reviewer merged this record into another (Phase 16). Nothing else changes; unmerge removes it.
  mergedIntoPatientId?: string;

  // Encrypted demographic fields
  encryptedFirstName: string;
  encryptedLastName: string;
  encryptedDob: string;
  gender: string;
  encryptedNin?: string;
  photoUrl?: string;

  // Emergency Triage Attributes (Unencrypted for instant sub-50KB queries)
  bloodGroup: BloodGroup;
  genotype: Genotype;
  advanceDirectiveDnr: boolean;
  organDonor: boolean;
  publicEmergencyOptIn: boolean; // default false

  // Associated collections
  emergencyContacts: EmergencyContact[];
  allergies: PatientAllergy[];
  chronicConditions: string[];
  activeMedications: ActiveMedication[];

  // Offline emergency card visibility (patient-chosen). These only select which existing items are
  // shown on the card; they never create or change clinical content.
  cardConditions: string[];          // subset of chronicConditions
  cardMedicationIds: string[];       // subset of activeMedications[].id
  cardIncludeRecentDiagnosis: boolean;
  cardVersion: number;               // version of the latest issued card (0 = none issued)
  cardStale: boolean;                // a signed record changed card content since the card was issued
  preferredLocale?: string;          // language for the printed card and notifications (i18n locale); English if unset

  activeEmergencyCodeId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Gives each medication a stable id (deterministic from its fields, so seeded ids survive restarts).
 */
function withMedicationIds(meds: Array<Omit<ActiveMedication, 'id'> & { id?: string }>): ActiveMedication[] {
  const used = new Set<string>();
  return meds.map((m) => {
    let id = m.id;
    if (!id) {
      const base = crypto.createHash('sha256').update(`${m.medicationName}|${m.dose}|${m.route}|${m.sinceDate}`).digest('hex').slice(0, 12);
      id = `med-${base}`;
      for (let n = 2; used.has(id); n++) id = `med-${base}-${n}`;
    }
    used.add(id);
    return { ...m, id };
  });
}

/**
 * Creates a patient entity with encrypted demographic fields.
 */
export function createPatientRecord(
  demographics: PatientDemographics,
  triageData: {
    bloodGroup: BloodGroup;
    genotype: Genotype;
    advanceDirectiveDnr?: boolean;
    organDonor?: boolean;
    publicEmergencyOptIn?: boolean;
    emergencyContacts?: EmergencyContact[];
    allergies?: PatientAllergy[];
    chronicConditions?: string[];
    activeMedications?: Array<Omit<ActiveMedication, 'id'> & { id?: string }>;
    cardConditions?: string[];
    cardMedicationIds?: string[];
    cardIncludeRecentDiagnosis?: boolean;
  },
  meta: { userId: string; countryCode?: string; primaryFacilityId?: string; id?: string }
): PatientEntity {
  const now = new Date().toISOString();

  return {
    id: meta.id || crypto.randomUUID(),
    userId: meta.userId,
    countryCode: meta.countryCode || deploymentCountry(),
    primaryFacilityId: meta.primaryFacilityId,

    // Encrypt demographics
    encryptedFirstName: encryptField(demographics.firstName),
    encryptedLastName: encryptField(demographics.lastName),
    encryptedDob: encryptField(demographics.dateOfBirth),
    gender: demographics.gender,
    encryptedNin: demographics.nin ? encryptField(demographics.nin) : undefined,
    photoUrl: demographics.photoUrl,

    // Triage attributes
    bloodGroup: triageData.bloodGroup,
    genotype: triageData.genotype,
    advanceDirectiveDnr: triageData.advanceDirectiveDnr || false,
    organDonor: triageData.organDonor || false,
    publicEmergencyOptIn: triageData.publicEmergencyOptIn || false,

    emergencyContacts: triageData.emergencyContacts || [],
    allergies: triageData.allergies || [],
    chronicConditions: triageData.chronicConditions || [],
    activeMedications: withMedicationIds(triageData.activeMedications || []),
    cardConditions: triageData.cardConditions || [],
    cardMedicationIds: triageData.cardMedicationIds || [],
    cardIncludeRecentDiagnosis: triageData.cardIncludeRecentDiagnosis || false,
    cardVersion: 0,
    cardStale: false,

    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Decrypts patient demographics for authorized views.
 */
export function decryptPatientDemographics(patient: PatientEntity): PatientDemographics {
  return {
    firstName: decryptField(patient.encryptedFirstName),
    lastName: decryptField(patient.encryptedLastName),
    dateOfBirth: decryptField(patient.encryptedDob),
    gender: patient.gender as 'male' | 'female' | 'other',
    nin: patient.encryptedNin ? decryptField(patient.encryptedNin) : undefined,
    photoUrl: patient.photoUrl,
  };
}

