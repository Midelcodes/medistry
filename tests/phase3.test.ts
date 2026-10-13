/**
 * Phase 3 Comprehensive Test Suite
 * Tests: Crockford Base32 Generation, Checksum, AES-256-GCM Field Encryption,
 * Code Revocation/Reissuance, Deliverables (Wallet Card, Wristband, NFC, Offline JWS),
 * and Brute-Force Enumeration Defenses.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePatientUniqueCode,
  validatePatientCode,
  normalizePatientCode,
  computeCheckCharacter,
  hashEmergencyCode,
} from '../src/lib/code/crockford.ts';

import {
  createPatientRecord,
  decryptPatientDemographics,
  encryptField,
  decryptField,
  type PatientDemographics,
} from '../src/lib/patient/profile.ts';

import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { EmergencyCodeLifecycleManager } from '../src/lib/code/lifecycle.ts';
import {
  generateWalletCardSvg,
  generateWristbandSvg,
  getLockScreenGuide,
  generateNfcNdefPayload,
  generateOfflineSignedPayload,
  verifyOfflineSignedPayload,
} from '../src/lib/code/deliverables.ts';
import { CodeSecurityGuard } from '../src/lib/code/securityGuard.ts';

describe('1. Crockford Base32 Code Generation & Checksum Integrity', () => {
  test('Generates opaque 15-character code with valid Modulo-32 check character', () => {
    const codeObj = generatePatientUniqueCode('medistry.health');
    assert.equal(codeObj.rawCode.length, 15);
    assert.match(codeObj.formattedCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{3}$/);
    assert.ok(codeObj.scanUrl.startsWith('https://medistry.health/e/'));

    const validation = validatePatientCode(codeObj.formattedCode);
    assert.equal(validation.valid, true);
    assert.equal(validation.normalized, codeObj.rawCode);
  });

  test('Check character detects single-character substitution and transposition typos', () => {
    const codeObj = generatePatientUniqueCode();
    const chars = codeObj.rawCode.split('');

    // Single character typo: change first char
    const corruptedChar = chars[0] === 'A' ? 'B' : 'A';
    const typoCode = `${corruptedChar}${codeObj.rawCode.slice(1)}`;
    const typoResult = validatePatientCode(typoCode);
    assert.equal(typoResult.valid, false, 'Typo must be caught by checksum');
    assert.match(typoResult.error || '', /transcription error/);

    // Adjacent character transposition: swap chars 2 and 3
    const swapped = [...chars];
    const temp = swapped[2];
    swapped[2] = swapped[3];
    swapped[3] = temp;
    const swappedCode = swapped.join('');

    // If characters were identical, test with different ones
    if (swapped[2] !== swapped[3]) {
      const swapResult = validatePatientCode(swappedCode);
      assert.equal(swapResult.valid, false, 'Transposition must be caught by weighted checksum');
    }
  });

  test('Normalizer handles lowercases, spaces, hyphens and lookalikes (i, l, o)', () => {
    // 'o' -> '0', 'i' -> '1', 'l' -> '1'
    const inputWithLookalikes = 'k7qm-4t9x-2hdp-8wo';
    const normalized = normalizePatientCode(inputWithLookalikes);
    assert.ok(normalized.endsWith('0'), 'O must normalize to 0');
    assert.ok(!normalized.includes('-'), 'Dashes must be stripped');

    const inputWithIandL = 'k7il-4t9x-2hdp-8w1';
    const normalizedIL = normalizePatientCode(inputWithIandL);
    assert.equal(normalizedIL.slice(2, 4), '11', 'i and l must normalize to 1');
  });
});

describe('2. Patient Profile & AES-256-GCM Field-Level Encryption', () => {
  test('Demographic encryption and decryption round-trip', () => {
    const plaintext = 'Olumide Adebayo';
    const ciphertext = encryptField(plaintext);

    assert.notEqual(ciphertext, plaintext);
    assert.match(ciphertext, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/, 'Format must be iv:tag:ciphertext');

    const decrypted = decryptField(ciphertext);
    assert.equal(decrypted, plaintext);
  });

  test('Tampering with ciphertext or authentication tag fails decryption', () => {
    const ciphertext = encryptField('Confidential NIN: 12345678901');
    const parts = ciphertext.split(':');

    // Alter one byte of the ciphertext payload (preserving even hex length)
    const lastChar = parts[2].slice(-1);
    const flippedChar = lastChar === '0' ? '1' : '0';
    const corruptedPayload = parts[2].slice(0, -1) + flippedChar;
    const tampered = `${parts[0]}:${parts[1]}:${corruptedPayload}`;

    assert.throws(() => {
      decryptField(tampered);
    }, /unable to authenticate data|Unsupported state/i, 'GCM tag mismatch must throw');
  });

  test('Patient entity stores encrypted PII while exposing critical triage unencrypted', () => {
    const demographics: PatientDemographics = {
      firstName: 'Fatima',
      lastName: 'Danjuma',
      dateOfBirth: '1994-08-14',
      gender: 'female',
      nin: '99281029381',
    };

    const patient = createPatientRecord(
      demographics,
      {
        bloodGroup: 'O_POSITIVE',
        genotype: 'SS', // Sickle Cell Disease
        allergies: [{ substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' }],
        chronicConditions: ['Sickle Cell Anemia', 'Pulmonary Hypertension'],
        emergencyContacts: [{ id: '1', name: 'Zainab Danjuma', relationship: 'Sister', phone: '+2348030000000', priority: 1 }],
      },
      { userId: 'user-fatima-1', countryCode: 'NG' }
    );

    // Verify stored fields are encrypted
    assert.notEqual(patient.encryptedFirstName, 'Fatima');
    assert.notEqual(patient.encryptedLastName, 'Danjuma');
    assert.notEqual(patient.encryptedDob, '1994-08-14');

    // Triage attributes must be queryable
    assert.equal(patient.bloodGroup, 'O_POSITIVE');
    assert.equal(patient.genotype, 'SS');
    assert.equal(patient.allergies[0].substance, 'Penicillin');

    // Decrypt demographics for authorized view
    const decrypted = decryptPatientDemographics(patient);
    assert.equal(decrypted.firstName, 'Fatima');
    assert.equal(decrypted.lastName, 'Danjuma');
    assert.equal(decrypted.nin, '99281029381');
  });
});

describe('3. Code Lifecycle & Lost-Card Reissuance', () => {
  const auditManager = new AuditChainManager();
  const lifecycle = new EmergencyCodeLifecycleManager(auditManager);
  const patientId = 'patient-uuid-chidi';

  test('Initial issuance generates active code', () => {
    const initial = lifecycle.issueInitialCode(patientId);
    assert.equal(initial.record.isActive, true);
    assert.equal(initial.record.patientId, patientId);

    const lookup = lifecycle.resolveActiveCode(initial.rawCode);
    assert.equal(lookup.valid, true);
    assert.equal(lookup.patientId, patientId);
  });

  test('Lost card reissuance revokes old code immediately while preserving history', () => {
    const initial = lifecycle.getActiveCodeForPatient(patientId)!;
    const initialRaw = initial.formattedCode!;

    // Patient reports lost wallet card
    const reissued = lifecycle.revokeAndReissue(patientId, 'Wallet stolen at transit hub');
    assert.equal(reissued.oldRecord.isActive, false);
    assert.ok(reissued.oldRecord.revokedAt);
    assert.equal(reissued.newRecord.isActive, true);
    assert.equal(reissued.newRecord.reissuedFromId, reissued.oldRecord.id);

    // Old code scanning immediately returns revoked (isRevoked = true, valid = false)
    const oldLookup = lifecycle.resolveActiveCode(initialRaw);
    assert.equal(oldLookup.valid, false);
    assert.equal(oldLookup.isRevoked, true);

    // New code scanning succeeds
    const newLookup = lifecycle.resolveActiveCode(reissued.rawCode);
    assert.equal(newLookup.valid, true);
    assert.equal(newLookup.patientId, patientId);
  });
});

describe('4. Code Deliverables & Offline Emergency Signed Payload', () => {
  const patient = createPatientRecord(
    { firstName: 'Chidi', lastName: 'Okafor', dateOfBirth: '1988-03-22', gender: 'male' },
    {
      bloodGroup: 'B_POSITIVE',
      genotype: 'AS',
      advanceDirectiveDnr: false,
      organDonor: true,
      allergies: [{ substance: 'Sulfa Drugs', category: 'drug', reaction: 'Stevens-Johnson Syndrome', severity: 'severe' }],
      emergencyContacts: [{ id: '1', name: 'Ngozi Okafor', relationship: 'Spouse', phone: '+2348021112222', priority: 1 }],
    },
    { userId: 'user-chidi-1' }
  );

  const formattedCode = 'K7QM-4T9X-2HDP-8W2';

  test('Wallet Card and Wristband SVG generators output valid vector graphics', () => {
    const cardSvg = generateWalletCardSvg(formattedCode, 'Chidi Okafor', '+2348021112222');
    assert.ok(cardSvg.includes('<svg'));
    assert.ok(cardSvg.includes('K7QM-4T9X-2HDP-8W2'));
    assert.ok(cardSvg.includes('CHIDI OKAFOR'));
    assert.ok(cardSvg.includes('BREAK-GLASS GATE'));

    const wristbandSvg = generateWristbandSvg(formattedCode);
    assert.ok(wristbandSvg.includes('MEDISTRY EMERGENCY WRISTBAND'));
    assert.ok(wristbandSvg.includes(formattedCode));
  });

  test('Lock screen instructions page guides both iOS and Android workflows', () => {
    const guide = getLockScreenGuide(formattedCode);
    assert.ok(guide.iosInstructions.length >= 3);
    assert.ok(guide.androidInstructions.length >= 3);
    assert.equal(guide.code, formattedCode);
  });

  test('NFC NDEF URI binary payload follows RFC NFC Forum Record Type Definition', () => {
    const { uriString, ndefMessageBuffer } = generateNfcNdefPayload(formattedCode);
    assert.equal(uriString, `https://medistry.health/e/${formattedCode}`);

    // NDEF Header assertions
    assert.equal(ndefMessageBuffer[0], 0xd1, 'Header must be 0xD1 (MB=1, ME=1, SR=1, TNF=1)');
    assert.equal(ndefMessageBuffer[1], 1, 'Type Length must be 1');
    assert.equal(ndefMessageBuffer.toString('utf8', 3, 4), 'U', 'Record type must be "U" for URI');
    assert.equal(ndefMessageBuffer[4], 0x04, 'URI identifier code 0x04 represents "https://"');
  });

  test('Offline emergency signed payload: verification and tamper resistance', () => {
    const { token, payload } = generateOfflineSignedPayload(patient, formattedCode);

    // 1. Verify valid offline token
    const verification = verifyOfflineSignedPayload(token);
    assert.equal(verification.valid, true);
    assert.equal(verification.payload?.bloodGroup, 'B_POSITIVE');
    assert.equal(verification.payload?.genotype, 'AS');
    assert.equal(verification.payload?.criticalAllergies[0].substance, 'Sulfa Drugs');

    // 2. Tampering with offline payload fails cryptographic signature verification
    const parts = token.split('.');
    const decodedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // Attacker modifies blood group to O_NEGATIVE
    decodedPayload.bloodGroup = 'O_NEGATIVE';
    const forgedPayloadBase64 = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
    const forgedToken = `${parts[0]}.${forgedPayloadBase64}.${parts[2]}`;

    const forgedVerification = verifyOfflineSignedPayload(forgedToken);
    assert.equal(forgedVerification.valid, false);
    assert.match(forgedVerification.error || '', /Cryptographic signature mismatch/);
  });
});

describe('5. Brute-Force Enumeration Defenses & Security Guard', () => {
  const auditManager = new AuditChainManager();
  const lifecycle = new EmergencyCodeLifecycleManager(auditManager);
  const guard = new CodeSecurityGuard(lifecycle, auditManager, {
    maxAttempts: 5,
    windowMs: 60_000,
    lockoutDurationMs: 3600_000, // 1 hour
  });

  const ipAddress = '197.210.88.99';
  const userAgent = 'AttackerBot/1.0';

  test('Failed scan attempts are tracked and trigger lockout at threshold', () => {
    // Attempts 1 to 4 should return 404 NOT_FOUND
    for (let i = 1; i <= 4; i++) {
      const result = guard.processScanAttempt({
        code: `RAND-FAKE-CODE-${i}`,
        ipAddress,
        userAgent,
      });
      assert.equal(result.status, 'NOT_FOUND');
      assert.equal(result.statusCode, 404);
      assert.equal(result.allowed, false);
    }

    // 5th attempt breaches threshold -> triggers 429 LOCKED_OUT
    const fifthAttempt = guard.processScanAttempt({
      code: 'RAND-FAKE-CODE-5',
      ipAddress,
      userAgent,
    });
    assert.equal(fifthAttempt.status, 'LOCKED_OUT');
    assert.equal(fifthAttempt.statusCode, 429);
    assert.match(fifthAttempt.message, /locked out for 1 hour/);

    // Subsequent attempt while locked out (even with a legitimate code) is blocked
    const validPatientCode = lifecycle.issueInitialCode('legit-patient-id');
    const blockedValidAttempt = guard.processScanAttempt({
      code: validPatientCode.rawCode,
      ipAddress,
      userAgent,
    });
    assert.equal(blockedValidAttempt.status, 'LOCKED_OUT');
    assert.equal(blockedValidAttempt.statusCode, 429);
  });

  test('Valid scan attempt logs audit entry and resets counters', () => {
    const cleanIp = '102.89.12.34';
    const patientCode = lifecycle.issueInitialCode('patient-clean-id');

    const result = guard.processScanAttempt({
      code: patientCode.rawCode,
      ipAddress: cleanIp,
      userAgent: 'MobileChrome/120.0',
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.statusCode, 200);
    assert.equal(result.patientId, 'patient-clean-id');

    // Audit log verification
    const auditEntries = auditManager.getEntries();
    const lastEntry = auditEntries[auditEntries.length - 1];
    assert.equal(lastEntry.action, 'EMERGENCY_CODE_SCAN_SUCCESS');
    assert.equal(lastEntry.subjectId, 'patient-clean-id');
  });
});
