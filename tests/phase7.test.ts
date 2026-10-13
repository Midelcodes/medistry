import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SlidingWindowRateLimiter,
  constantTimeEqual,
  CsrfManager,
  sanitizeClinicalText,
  getSecurityHttpHeaders,
} from '../src/lib/security/rateLimiter.ts';
import { auditHtmlForWcag21AA } from '../src/lib/security/accessibilityAudit.ts';
import { t, SUPPORTED_LOCALES } from '../src/lib/i18n/translations.ts';
import { generateSeedData } from '../prisma/seed.ts';
import { benchmarkEmergencySummaryPath } from '../src/lib/emergency/loadBenchmark.ts';
import { renderEmergencySummaryHtml } from '../src/lib/emergency/summaryRenderer.ts';
import { EmergencyBreakGlassEngine } from '../src/lib/emergency/breakGlassEngine.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { ClinicalDataStore } from '../src/lib/clinical/store.ts';
import { ClinicalTimelineEngine } from '../src/lib/clinical/timeline.ts';
import { NotificationDispatcher } from '../src/lib/notifications/dispatcher.ts';
import { createPatientRecord } from '../src/lib/patient/profile.ts';
import type { ActorContext } from '../src/lib/policy/enforcer.ts';

describe('1. Sliding-Window Rate Limiting & Brute-Force Lockout', () => {
  test('Allows requests within configured sliding window budget', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const now = 1_000_000;

    for (let i = 1; i <= 5; i++) {
      const status = limiter.check('197.210.64.1', now + i * 100);
      assert.strictEqual(status.allowed, true);
      assert.strictEqual(status.remaining, 5 - i);
      assert.strictEqual(status.isLockedOut, false);
    }
  });

  test('Rejects excess requests when rate limit budget is exceeded', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const now = 1_000_000;

    limiter.check('197.210.64.2', now);
    limiter.check('197.210.64.2', now + 100);
    limiter.check('197.210.64.2', now + 200);

    // 4th request exceeds limit
    const rejected = limiter.check('197.210.64.2', now + 300);
    assert.strictEqual(rejected.allowed, false);
    assert.strictEqual(rejected.remaining, 0);
    assert.strictEqual(rejected.isLockedOut, false);
  });

  test('Enforces temporary IP lockout when violation threshold is breached', () => {
    const limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      lockoutThreshold: 3,
      lockoutDurationMs: 300_000, // 5 min lockout
    });
    const now = 1_000_000;

    limiter.check('bad-ip-attacker', now);
    limiter.check('bad-ip-attacker', now + 10);

    // 3 successive rate-limit violations
    limiter.check('bad-ip-attacker', now + 20); // Violation 1
    limiter.check('bad-ip-attacker', now + 30); // Violation 2
    const lockedOut = limiter.check('bad-ip-attacker', now + 40); // Violation 3 -> Lockout

    assert.strictEqual(lockedOut.allowed, false);
    assert.strictEqual(lockedOut.isLockedOut, true);
    assert.ok((lockedOut.lockoutRemainingMs || 0) > 0);

    // Even if sliding window passes, IP remains locked out until lockoutDurationMs expires
    const stillLocked = limiter.check('bad-ip-attacker', now + 70_000);
    assert.strictEqual(stillLocked.allowed, false);
    assert.strictEqual(stillLocked.isLockedOut, true);
  });
});

describe('2. Security Hardening Primitives (Constant-Time, CSRF, XSS, CSP)', () => {
  test('Constant-time matching prevents timing side-channels', () => {
    assert.strictEqual(constantTimeEqual('SECRET_TOKEN_XYZ', 'SECRET_TOKEN_XYZ'), true);
    assert.strictEqual(constantTimeEqual('SECRET_TOKEN_XYZ', 'SECRET_TOKEN_ABC'), false);
    assert.strictEqual(constantTimeEqual('SHORT', 'LONGER_STRING_SAMPLE'), false);
  });

  test('CSRF token manager generates secure tokens and verifies double-submit cookies', () => {
    const token = CsrfManager.generateToken();
    assert.strictEqual(token.length, 64); // 32 bytes hex

    assert.strictEqual(CsrfManager.verify(token, token), true);
    assert.strictEqual(CsrfManager.verify(token, 'tampered_token_xyz'), false);
    assert.strictEqual(CsrfManager.verify('', token), false);
  });

  test('Sanitizes malicious script injection from clinical notes and descriptions', () => {
    const dirtyInput = 'Acute abdomen <script>alert("XSS")</script><img src="x" onerror="stealCookies()">';
    const clean = sanitizeClinicalText(dirtyInput);

    assert.strictEqual(clean.includes('<script>'), false);
    assert.strictEqual(clean.includes('alert("XSS")'), false);
    assert.strictEqual(clean.includes('onerror='), false);
    assert.ok(clean.startsWith('Acute abdomen'));
  });

  test('Provides strict Content-Security-Policy and HTTP security headers', () => {
    const headers = getSecurityHttpHeaders();

    assert.ok(headers['Content-Security-Policy'].includes("default-src 'self'"));
    assert.ok(headers['Strict-Transport-Security'].includes('max-age=63072000'));
    assert.strictEqual(headers['X-Frame-Options'], 'DENY');
    assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
  });
});

describe('3. WCAG 2.1 AA Accessibility Pass on Emergency UI', () => {
  test('Emergency summary template passes 100% of WCAG 2.1 AA criteria', async () => {
    const auditManager = new AuditChainManager();
    const clinicalStore = new ClinicalDataStore(auditManager);
    const timelineEngine = new ClinicalTimelineEngine(clinicalStore);
    const dispatcher = new NotificationDispatcher();
    const engine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);

    const patient = createPatientRecord(
      { firstName: 'Amara', lastName: 'Okonkwo', dateOfBirth: '1998-04-12', gender: 'female' },
      {
        bloodGroup: 'O_POSITIVE',
        genotype: 'SS',
        allergies: [{ substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' }],
        emergencyContacts: [{ id: 'c1', name: 'Emeka Okonkwo', relationship: 'Brother', phone: '+234 802 111 2233', priority: 1 }],
        advanceDirectiveDnr: true, // DNR Alert
        organDonor: true,
      },
      { userId: 'u1', countryCode: 'NG' }
    );

    const doctor: ActorContext = {
      userId: 'u-doc',
      role: 'DOCTOR',
      clinicianId: 'c-doc',
      isVerifiedClinician: true,
    };

    const { grant } = await engine.initiateBreakGlass({
      patient,
      emergencyCode: 'K7QM-4T9X-2HDP-8W2',
      actor: doctor,
      treatingDoctorName: 'Dr. Robert Caldwell',
      facilityId: 'fac-luth-001',
      facilityName: 'LUTH Emergency Room',
      reason: 'UNCONSCIOUS',
    });

    const summary = engine.buildEmergencySummary(patient, grant.id);
    const html = renderEmergencySummaryHtml(summary);

    const audit = auditHtmlForWcag21AA(html);

    assert.strictEqual(audit.passed, true, `Violations found: ${audit.violations.join(', ')}`);
    assert.strictEqual(audit.score, 100);
    assert.strictEqual(audit.checks.hasValidViewportZoom, true);
    assert.strictEqual(audit.checks.hasMainLandmark, true);
    assert.strictEqual(audit.checks.hasAlertRoles, true);
    assert.strictEqual(audit.checks.hasLargeTouchTargets, true);
    assert.strictEqual(audit.checks.hasAriaLabelsOnInteractive, true);
    assert.strictEqual(audit.checks.hasAccessibleColorContrastStyles, true);
  });
});

describe('4. Regional Internationalization (i18n) Engine', () => {
  test('Supports all specified regional locales (Hausa, Yoruba, Igbo, Swahili, French)', () => {
    assert.deepStrictEqual(SUPPORTED_LOCALES, ['en', 'ha', 'yo', 'ig', 'sw', 'fr']);

    // English
    assert.strictEqual(t('blood_group', 'en'), 'Blood Group & Rh');

    // Hausa
    assert.strictEqual(t('blood_group', 'ha'), 'Nau’in Jini da Rh');
    assert.ok(t('emergency_title', 'ha').includes('GAGGAWA'));

    // Yoruba
    assert.strictEqual(t('blood_group', 'yo'), 'Ẹ̀yà Ẹ̀jẹ̀ àti Rh');
    assert.ok(t('emergency_title', 'yo').includes('PÀWÁDÀ'));

    // Igbo
    assert.strictEqual(t('blood_group', 'ig'), 'Ụdị Ọbara na Rh');
    assert.ok(t('emergency_title', 'ig').includes('MBEREDE'));

    // Swahili
    assert.strictEqual(t('blood_group', 'sw'), 'Kundi la Damu na Rh');

    // French
    assert.strictEqual(t('blood_group', 'fr'), 'Groupe Sanguin & Rh');
  });

  test('Interpolates dynamic parameters and gracefully falls back to English', () => {
    assert.strictEqual(t('remaining_time', 'en', { m: 45 }), 'Expires in 45 minutes');
    assert.strictEqual(t('remaining_time', 'ha', { m: 30 }), 'Zai ƙare a cikin mintuna 30');
    assert.strictEqual(t('remaining_time', 'fr', { m: 15 }), 'Expire dans 15 minutes');

    // Fallback on missing key
    assert.strictEqual(t('unknown_key_xyz', 'ha'), 'unknown_key_xyz');
  });
});

describe('5. Synthetic Database Seed Verification', () => {
  test('Seed dataset satisfies all architectural multi-facility requirements', () => {
    const seed = generateSeedData();

    // 1. Exactly 3 Facilities
    assert.strictEqual(seed.facilities.length, 3);
    const facilityIds = seed.facilities.map(f => f.id);
    assert.ok(facilityIds.includes('fac-luth-001'));
    assert.ok(facilityIds.includes('fac-abuja-001'));
    assert.ok(facilityIds.includes('fac-kano-001'));

    // 2. Exactly 6 Clinicians
    assert.strictEqual(seed.clinicians.length, 6);
    assert.ok(seed.clinicians.every(c => c.status === 'VERIFIED'));
    assert.ok(seed.clinicians.every(c => c.licenseNumber.startsWith('MDCN/')));

    // 3. Exactly 10 Synthetic Patients
    assert.strictEqual(seed.patients.length, 10);

    // 4. Critical Patient 1: Sickle Cell SS + Penicillin Anaphylaxis
    const amara = seed.patients[0];
    assert.strictEqual(amara.patient.genotype, 'SS');
    assert.strictEqual(amara.patient.bloodGroup, 'O_POSITIVE');
    const penicillinAllergy = amara.patient.allergies.find(a => a.substance === 'Penicillin');
    assert.ok(penicillinAllergy);
    assert.strictEqual(penicillinAllergy.severity, 'severe');
    assert.ok(amara.patient.chronicConditions.some(c => c.includes('Sickle Cell')));
    assert.ok(amara.emergencyCode.formattedCode.length >= 15);
  });
});

describe('6. Emergency Summary Path Load & Latency Benchmark', () => {
  test('Sub-50KB payload and ultra-fast server compilation guarantee sub-1.5s 3G budget', async () => {
    const metrics = await benchmarkEmergencySummaryPath(300);

    assert.strictEqual(metrics.iterations, 300);
    assert.ok(metrics.payloadByteSize < 50 * 1024, `Payload size was ${metrics.payloadByteSize} bytes (> 50 KB)`);
    assert.ok(metrics.p95Ms < 5.0, `p95 server latency was ${metrics.p95Ms}ms (> 5ms)`);
    assert.strictEqual(metrics.meets3GBudget, true);
    assert.ok(metrics.throughputPerSecond > 500, `Throughput was ${metrics.throughputPerSecond} req/s`);
  });
});

