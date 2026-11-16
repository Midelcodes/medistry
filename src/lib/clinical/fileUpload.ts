/**
 * MEDISTRY Secure Document Upload
 * Size limit (UPLOAD_MAX_MB, default 10), file type from magic bytes (PDF, PNG, JPEG only), malware scan
 * (clamd in production, see virusScanners.ts), image metadata removed, then AES-256-GCM encrypted storage as a
 * FHIR DocumentReference.
 */

import crypto from 'node:crypto';
import type { FHIRDocumentReference } from '../fhir/types.ts';
import { encryptField } from '../patient/profile.ts';
import { createVirusScanner, ScannerUnavailableError, type IVirusScannerAdapter } from './virusScanners.ts';
import { assertSafeAudioType, assertSafeFileType, stripImageMetadata } from './fileSafety.ts';

export { EICAR_TEST_STRING, TestPatternScannerAdapter, ClamdVirusScannerAdapter, ScannerUnavailableError } from './virusScanners.ts';
export type { IVirusScannerAdapter } from './virusScanners.ts';

/** Upload size limit in MB (UPLOAD_MAX_MB, default 10). */
export const UPLOAD_MAX_MB = Math.max(1, parseInt(process.env.UPLOAD_MAX_MB || '10', 10) || 10);
export const MAX_FILE_SIZE_BYTES = UPLOAD_MAX_MB * 1024 * 1024;
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

export interface FileUploadInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  title: string;
  category: 'discharge-summary' | 'laboratory-scan' | 'radiology-report' | 'referral-letter';
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

  /** Defaults to the environment's scanner: clamd with real data (fail closed), test patterns in demo and tests. */
  constructor(scanner: IVirusScannerAdapter = createVirusScanner()) {
    this.scanner = scanner;
  }

  /**
   * Checks shared by every upload: size, MIME type, content type from magic bytes (and extension), malware scan
   * of the original bytes. Returns the bytes to store, with image metadata removed. Throws on failure; an
   * unreachable scanner rejects the upload.
   */
  private async check(mimeType: string, buffer: Buffer, filename?: string): Promise<Buffer> {
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size exceeds ${UPLOAD_MAX_MB}MB limit (received ${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    }
    if (!ALLOWED_MIME_TYPES.includes(String(mimeType).toLowerCase())) {
      throw new Error(`Unsupported file type '${String(mimeType).slice(0, 60)}'. Allowed formats: PDF, JPEG, PNG.`);
    }
    const type = assertSafeFileType(buffer, mimeType, filename);
    let scanResult: { clean: boolean; threatName?: string };
    try {
      scanResult = await this.scanner.scanBuffer(buffer);
    } catch (err) {
      if (err instanceof ScannerUnavailableError) throw new Error(`Malware scanner unavailable (${err.message}). Upload rejected; try again later.`);
      throw err;
    }
    if (!scanResult.clean) {
      throw new Error(`SECURITY ALERT: Virus or malicious payload detected (${scanResult.threatName}). File rejected.`);
    }
    return stripImageMetadata(buffer, type);
  }

  /**
   * AI intake upload (Phase 15): a photo of a paper record (PDF, PNG, JPEG; image metadata removed) or a voice note
   * (WebM, Ogg, WAV, MP4, MP3). Size limit, content check and malware scan as for every upload; encrypted at rest.
   */
  async processIntakeUpload(input: { filename: string; mimeType: string; buffer: Buffer; kind: 'photo' | 'voice' }): Promise<{ mimeType: string; sha256: string; sizeBytes: number; encryptedPayload: string; stored: Buffer }> {
    if (!input.buffer.length) throw new Error('The upload is empty');
    let stored: Buffer;
    let mimeType: string;
    if (input.kind === 'photo') {
      stored = await this.check(input.mimeType, input.buffer, input.filename);
      mimeType = String(input.mimeType).toLowerCase();
    } else {
      if (input.buffer.length > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File size exceeds ${UPLOAD_MAX_MB}MB limit (received ${(input.buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      }
      mimeType = assertSafeAudioType(input.buffer, input.mimeType);
      let scan: { clean: boolean; threatName?: string };
      try {
        scan = await this.scanner.scanBuffer(input.buffer);
      } catch (err) {
        if (err instanceof ScannerUnavailableError) throw new Error(`Malware scanner unavailable (${err.message}). Upload rejected; try again later.`);
        throw err;
      }
      if (!scan.clean) throw new Error(`SECURITY ALERT: Virus or malicious payload detected (${scan.threatName}). File rejected.`);
      stored = input.buffer;
    }
    return {
      mimeType, stored, sizeBytes: stored.length,
      sha256: crypto.createHash('sha256').update(stored).digest('hex'),
      encryptedPayload: encryptField(stored.toString('base64')),
    };
  }

  /** Stores a clinician's licence document (self-registration): same checks, encrypted at rest. */
  async processCredentialDocument(input: { filename: string; mimeType: string; buffer: Buffer }, clinicianId: string): Promise<CredentialDocument> {
    if (!input.buffer.length) throw new Error('The licence document is empty');
    const stored = await this.check(input.mimeType, input.buffer, input.filename);
    return {
      id: crypto.randomUUID(),
      clinicianId,
      filename: String(input.filename || 'licence').replace(/[^\w. -]/g, '_').slice(0, 120),
      mimeType: input.mimeType.toLowerCase(),
      sha256: crypto.createHash('sha256').update(stored).digest('hex'),
      sizeBytes: stored.length,
      encryptedPayload: encryptField(stored.toString('base64')),
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
    const { filename, mimeType, title, category } = input;

    // 1-4. Size, type (magic bytes), malware scan; image metadata removed from what is stored
    const buffer = await this.check(mimeType, input.buffer, filename);

    // 5. SHA-256 checksum of the stored bytes
    const originalHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // 6. Encrypt document bytes using AES-256-GCM
    const base64Data = buffer.toString('base64');
    const encryptedFilePayload = encryptField(base64Data);

    const docId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 7. Build FHIR DocumentReference resource
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
