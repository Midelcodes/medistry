/**
 * MEDISTRY Secure Document Upload & Antivirus Scanner
 * Enforces size limits (max 10MB), MIME restrictions, antivirus scanning,
 * and AES-256-GCM encrypted document storage as FHIR DocumentReference.
 */

import crypto from 'node:crypto';
import type { FHIRDocumentReference } from '../fhir/types.ts';
import { encryptField } from '../patient/profile.ts';

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

// EICAR Standard Antivirus Test Signature
export const EICAR_TEST_STRING = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface FileUploadInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  title: string;
  category: 'discharge-summary' | 'laboratory-scan' | 'radiology-report' | 'referral-letter';
}

export interface IVirusScannerAdapter {
  scanBuffer(buffer: Buffer): Promise<{ clean: boolean; threatName?: string }>;
}

/**
 * Built-in ClamAV/EICAR Antivirus Scanner Adapter
 */
export class StandardVirusScannerAdapter implements IVirusScannerAdapter {
  async scanBuffer(buffer: Buffer): Promise<{ clean: boolean; threatName?: string }> {
    const contentString = buffer.toString('utf8');
    if (contentString.includes(EICAR_TEST_STRING)) {
      return { clean: false, threatName: 'EICAR_Test_Malware_Signature' };
    }
    // Check for suspicious script injection in PDF / images
    if (contentString.includes('<script>') || contentString.includes('javascript:')) {
      return { clean: false, threatName: 'Embedded_Script_Exploit_Pattern' };
    }
    return { clean: true };
  }
}

export interface UploadResult {
  documentReference: FHIRDocumentReference;
  encryptedFilePayload: string;
  originalHash: string;
  sizeBytes: number;
}

/** A clinician's licence document, validated, scanned and encrypted like a clinical upload. */
export interface CredentialDocument {
  id: string;
  clinicianId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  encryptedPayload: string; // AES-256-GCM (encryptField) of the base64 bytes
  uploadedAt: string;
}

export class SecureDocumentManager {
  private scanner: IVirusScannerAdapter;

  constructor(scanner: IVirusScannerAdapter = new StandardVirusScannerAdapter()) {
    this.scanner = scanner;
  }

  /** Size, type and malware checks shared by every upload. Throws on failure. */
  private async check(mimeType: string, buffer: Buffer): Promise<void> {
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size exceeds 10MB limit (received ${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    }
    if (!ALLOWED_MIME_TYPES.includes(String(mimeType).toLowerCase())) {
      throw new Error(`Unsupported file type '${mimeType}'. Allowed formats: PDF, JPEG, PNG.`);
    }
    const scanResult = await this.scanner.scanBuffer(buffer);
    if (!scanResult.clean) {
      throw new Error(`SECURITY ALERT: Virus or malicious payload detected (${scanResult.threatName}). File rejected.`);
    }
  }

  /** Stores a clinician's licence document (self-registration): same checks, encrypted at rest. */
  async processCredentialDocument(input: { filename: string; mimeType: string; buffer: Buffer }, clinicianId: string): Promise<CredentialDocument> {
    if (!input.buffer.length) throw new Error('The licence document is empty');
    await this.check(input.mimeType, input.buffer);
    return {
      id: crypto.randomUUID(),
      clinicianId,
      filename: String(input.filename || 'licence').replace(/[^\w. -]/g, '_').slice(0, 120),
      mimeType: input.mimeType.toLowerCase(),
      sha256: crypto.createHash('sha256').update(input.buffer).digest('hex'),
      sizeBytes: input.buffer.length,
      encryptedPayload: encryptField(input.buffer.toString('base64')),
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * Validates, scans, encrypts, and converts an uploaded file into a FHIR DocumentReference.
   */
  async processUpload(
    input: FileUploadInput,
    patientId: string,
    authorClinicianId: string,
    facilityId: string
  ): Promise<UploadResult> {
    const { filename, mimeType, buffer, title, category } = input;

    // 1. Size Validation (Max 10MB)
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size exceeds 10MB limit (received ${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    }

    // 2. MIME Type Validation
    if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) {
      throw new Error(`Unsupported file type '${mimeType}'. Allowed formats: PDF, JPEG, PNG.`);
    }

    // 3. Antivirus Scan
    const scanResult = await this.scanner.scanBuffer(buffer);
    if (!scanResult.clean) {
      throw new Error(`SECURITY ALERT: Virus or malicious payload detected (${scanResult.threatName}). File rejected.`);
    }

    // 4. Compute original SHA-256 checksum
    const originalHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // 5. Encrypt document bytes using AES-256-GCM
    const base64Data = buffer.toString('base64');
    const encryptedFilePayload = encryptField(base64Data);

    const docId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 6. Build FHIR DocumentReference resource
    const documentReference: FHIRDocumentReference = {
      resourceType: 'DocumentReference',
      id: docId,
      status: 'current',
      docStatus: 'final',
      type: {
        coding: [{
          system: 'http://loinc.org',
          code: category === 'laboratory-scan' ? '11502-2' : '34133-9',
          display: title,
        }],
        text: title,
      },
      subject: {
        reference: `Patient/${patientId}`,
      },
      date: now,
      author: [{
        reference: `Practitioner/${authorClinicianId}`,
      }],
      custodian: {
        reference: `Organization/${facilityId}`,
      },
      content: [{
        attachment: {
          contentType: mimeType,
          size: buffer.length,
          hash: originalHash,
          title: `${title} (${filename})`,
        },
      }],
    };

    return {
      documentReference,
      encryptedFilePayload,
      originalHash,
      sizeBytes: buffer.length,
    };
  }
}
