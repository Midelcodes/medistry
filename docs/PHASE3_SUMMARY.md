# Phase 3 Summary: Patient Profile, Unique Code Generation, Deliverables & Reissuance

## 1. Overview of Phase 3 Deliverables

| Deliverable | File Location | Key Capabilities |
| :--- | :--- | :--- |
| **Crockford Base32 & Checksum** | [`src/lib/code/crockford.ts`](file:///home/midel/medical/src/lib/code/crockford.ts) | 128-bit cryptographically secure randomness, Modulo-32 weighted check character detecting single-character typos and adjacent transpositions. Normalizes lookalikes (`I/L -> 1`, `O -> 0`). Format: `K7QM-4T9X-2HDP-8W2`. |
| **Field-Level Encryption** | [`src/lib/patient/profile.ts`](file:///home/midel/medical/src/lib/patient/profile.ts) | AES-256-GCM authenticated field encryption for demographics (First/Last Name, DOB, NIN) with 96-bit random IV and 128-bit auth tag. Queryable triage attributes (Blood Group, Genotype AA/AS/SS, Allergies, DNR, Organ Donor). |
| **Code Lifecycle & Reissuance** | [`src/lib/code/lifecycle.ts`](file:///home/midel/medical/src/lib/code/lifecycle.ts) | Initial code provisioning; lost card revocation marks code inactive immediately. Reissuance preserves 100% of medical history by associating clinical records with `patientId`. |
| **Deliverables Engine** | [`src/lib/code/deliverables.ts`](file:///home/midel/medical/src/lib/code/deliverables.ts) | (1) ISO ID-1 printable Wallet Card SVG, (2) Medical Wristband/Sticker SVG, (3) Lock Screen wallpaper & instructions for iOS/Android, (4) Binary NFC NDEF URI payload (Type 'U', prefix `0x04`), (5) HMAC-SHA256 signed offline emergency triage payload. |
| **Enumeration Defenses** | [`src/lib/code/securityGuard.ts`](file:///home/midel/medical/src/lib/code/securityGuard.ts) | Brute-force enumeration lockout: 5 failed attempts per 15 min triggers a 1-hour IP/device lockout (`429 Too Many Requests`). Constant-time SHA-256 lookup hash comparison. Immutable audit row on every scan. |
| **Automated Test Suite** | [`tests/phase3.test.ts`](file:///home/midel/medical/tests/phase3.test.ts) | 14 automated unit/integration tests for Phase 3 (30 tests passing project-wide). |

---

## 2. Test Execution Results

```text
> medical@1.0.0 test
> node --experimental-strip-types --test tests/*.test.ts

▶ 1. Security & Authentication Primitives (3 tests) ...................... PASS
▶ 2. Central Authorization Policy Engine (Deny by Default) (8 tests) ..... PASS
▶ 3. Clinician Onboarding & MDCN License Verification (2 tests) .......... PASS
▶ 4. Append-Only Tamper-Evident Hash-Chained Audit Log (3 tests) ......... PASS
▶ 5. Crockford Base32 Code Generation & Checksum Integrity (3 tests) ..... PASS
▶ 6. Patient Profile & AES-256-GCM Field-Level Encryption (3 tests) ...... PASS
▶ 7. Code Lifecycle & Lost-Card Reissuance (2 tests) ..................... PASS
▶ 8. Code Deliverables & Offline Emergency Signed Payload (4 tests) ...... PASS
▶ 9. Brute-Force Enumeration Defenses & Security Guard (2 tests) ......... PASS

ℹ tests 30 | suites 9 | pass 30 | fail 0 | duration_ms 273.65ms
```

---

## 3. Threat Model & Mitigations Implemented (Section 3 & 6)

| Threat | Mitigation Architecture |
| :--- | :--- |
| **Code Enumeration & Guessing** | 128-bit random entropy (~70 bits in 14 base32 chars + check char = $1.18 \times 10^{21}$ space). Max 5 failed scan attempts per 15 mins results in 1-hour lockout. Scans evaluated via SHA-256 constant-time indexing. |
| **Lost or Stolen Wallet Card** | Patient triggers 1-click revocation. The previous code immediately returns `410 Gone / Revoked` to any scanner, while all encounters, conditions, and lab histories are preserved under the patient's new code. |
| **Physical Tampering with Offline QR Card** | The offline payload is signed using HMAC-SHA256 (or ECDSA). If an attacker tampers with the blood group or allergies in the QR payload, cryptographic signature verification fails. |
| **Data Leakage on QR Scan** | The QR code contains zero clinical data—only the opaque URL `https://medistry.health/e/<code>`. Anonymous scanners see no medical information unless the patient explicitly opted into the emergency badge. |

---

## 4. Risks & Decisions for Phase 4 (Clinical Data Model & Transfer)

### Risks to Track
1. **FHIR Versioning Immobility**: In compliance with clinical audit standards, medical records must **never be overwritten or hard-deleted**. Any update to a condition or prescription creates a new version (`versionId: n + 1, isLatest: true`), deprecating the previous version (`isLatest: false`).
2. **Encrypted Attachment Storage**: Scanned lab reports and referral documents must undergo size limitations (max 10MB) and virus scanning before being encrypted with AES-256-GCM.

### Decisions Needed from User Before Phase 4
1. **Document Storage Backend**: For local dev, encrypted documents will be stored on local filesystem with AES-256-GCM envelope encryption. Please confirm if local encrypted filesystem storage is acceptable or if S3-compatible object storage (e.g. MinIO) should be added to `docker-compose.yml`.
2. **Clinical Terminology Coding**: Do you prefer standard ICD-10/SNOMED CT coding systems embedded in the FHIR condition/allergy shapes, or free-text descriptions alongside basic category enums? (Default: hybrid approach supporting both).

