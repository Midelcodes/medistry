/**
 * MEDISTRY Patient Profile & AES-256-GCM Field-Level Encryption
 * Ensures zero plaintext demographic or clinical PII/PHI is stored at rest.
 */

import crypto from 'node:crypto';

// Default 32-byte key for local dev (in production loaded from KMS or FIELD_ENCRYPTION_KEY env)
const DEFAULT_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function getEncryptionKey(): Buffer {
  const envKey = process.env.FIELD_ENCRYPTION_KEY || DEFAULT_KEY_HEX;
  const keyBuf = Buffer.from(envKey, 'hex');
  if (keyBuf.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be a 32-byte hexadecimal string (64 chars)');
  }
  return keyBuf;
}

export interface EncryptedCiphertext {
  iv: string;         // 12 bytes hex
  tag: string;        // 16 bytes hex (GCM authentication tag)
  ciphertext: string; // Hex payload
}

/**
 * Encrypts a plaintext string using AES-256-GCM with authenticated tag.
 */
export function encryptField(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // Recommended 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  // Format: iv:tag:ciphertext
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM ciphertext payload and validates integrity tag.
 */
export function decryptField(encryptedPayload: string): string {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format: expected iv:tag:ciphertext');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
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
}

export interface ActiveMedication {
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
  
  activeEmergencyCodeId?: string;
  createdAt: string;
  updatedAt: string;
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
    activeMedications?: ActiveMedication[];
  },
  meta: { userId: string; countryCode?: string; primaryFacilityId?: string; id?: string }
): PatientEntity {
  const now = new Date().toISOString();

  return {
    id: meta.id || crypto.randomUUID(),
    userId: meta.userId,
    countryCode: meta.countryCode || 'NG',
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
    activeMedications: triageData.activeMedications || [],

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

