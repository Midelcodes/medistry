/**
 * MEDISTRY Full-Stack Application Server
 * Serves the patient frontpage UI, RESTful FHIR APIs, Break-Glass Emergency Gate,
 * server-rendered emergency summaries (<50KB), and offline cryptographic card exports.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderEmergencySummaryHtml } from './lib/emergency/summaryRenderer.ts';
import { OfflineEmergencyCardManager } from './lib/emergency/offlineCard.ts';
import { getPublicJwks } from './lib/crypto/cardKeys.ts';
import { escapeHtml } from './lib/security/rateLimiter.ts';
import { generateWalletCardSvg, generateWristbandSvg, DEFAULT_CONFIG } from './lib/code/deliverables.ts';
import { SlidingWindowRateLimiter, getSecurityHttpHeaders } from './lib/security/rateLimiter.ts';
import { decryptPatientDemographics } from './lib/patient/profile.ts';
import { createPortalApi } from './lib/site/portalApi.ts';
import { createPersistence } from './lib/data/storage.ts';
import { createRuntime } from './lib/runtime.ts';
import { scannerStrings } from './lib/i18n/translations.ts';
import { normalizePatientCode } from './lib/code/crockford.ts';
import { appBaseUrl, clientIp as getClientIp, DEMO_MODE, deploymentCountry } from './lib/security/config.ts';
import { registryFor } from './lib/clinician/verification.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 1. Storage and engines. Memory by default; STORAGE=postgres + DATABASE_URL writes through to PostgreSQL and
// rebuilds the working set from it at start-up (see src/lib/data/repositories.ts).
console.log('📦 Initializing MEDISTRY Clinical Store and Cryptographic Engines...');
// Loads the offline card signing key at startup, so a missing production key fails closed immediately.
const offlineCardManager = new OfflineEmergencyCardManager();
const startupFailed = (err: any): never => {
  // One clear line (no stack dump of the database client, no connection strings).
  console.error(`Startup failed: ${String(err?.message || err).split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean).pop()}`);
  process.exit(1);
};
const persistence = await createPersistence().catch(startupFailed);
const runtime = await createRuntime(persistence).catch(startupFailed);
console.log(`💾 Storage: ${persistence.mode}`);
const { seedData, patientsById, patientsByCode, codeByPatient, auditManager, clinicalStore, timelineEngine,
  consoleProvider, emergencyEngine, offlineCardStore, consentManager, accessLogManager, recordFlags, offlineScans,
  accounts, patientAuth, staff, proxies, deliveries, ussd } = runtime;
const rateLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 300 });
// Stricter limit on emergency-code lookups to slow code enumeration
const gateLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 20 });

const SITE_DIR = path.join(ROOT_DIR, 'site');
const handlePortalApi = createPortalApi({
  seedData,
  patientsById,
  patientsByCode,
  codeByPatient,
  auditManager,
  clinicalStore,
  timelineEngine,
  consentManager,
  accessLogManager,
  emergencyEngine,
  notifications: consoleProvider,
  offlineCards: offlineCardStore,
  recordFlags,
  offlineScans,
  persistence,
  dataDir: path.join(ROOT_DIR, 'data'),
  accounts,
  patientAuth,
  staff,
  proxies,
  deliveries,
  ussd,
});

// Daily housekeeping: licence re-verification reminders, and ending guardian control at the patient's 18th
// birthday (also enforced on every request). Runs once at start-up.
const housekeeping = () => {
  proxies.enforceExpiry();
  staff.sendLicenceReminders().catch((err) => console.error(`[housekeeping] licence reminders failed: ${err?.message || err}`));
};
housekeeping();
setInterval(housekeeping, 24 * 60 * 60 * 1000).unref();

// Site pages: shared layout + one template per page
type PageDef = { file: string; nav: string; title: string; description: string; script?: string; module?: boolean };
const PAGES: Record<string, PageDef> = {
  '/': { file: 'home', nav: 'home', title: 'Medistry | Portable Medical Records & Emergency Access', description: 'Medistry gives patients control of their FHIR-based medical records and lets verified clinicians reach life-saving information through an audited emergency break-glass scan.' },
  '/about': { file: 'about', nav: 'about', title: 'About | Medistry', description: 'Why Medistry exists, the principles behind it, and how it aligns with the Nigeria Data Protection Act 2023.' },
  '/features': { file: 'features', nav: 'features', title: 'Features | Medistry', description: 'Patient-controlled records, verified clinician access, emergency QR and NFC codes, encryption and a tamper-evident audit log.', script: 'features' },
  '/how-it-works': { file: 'how-it-works', nav: 'how', title: 'How It Works | Medistry', description: 'From a random emergency code to a read-only, 60-minute break-glass grant, step by step.' },
  '/emergency': { file: 'emergency', nav: 'emergency', title: 'Emergency Access | Medistry', description: 'Scan or enter a patient emergency code to start the clinician break-glass process.', script: 'emergency' },
  '/patients': { file: 'patients', nav: 'patients', title: 'Patient Portal | Medistry', description: 'View your record timeline, approve or revoke access, see who accessed your record, and manage your emergency code.', script: 'patients' },
  '/clinicians': { file: 'clinicians', nav: 'clinicians', title: 'Clinician Console | Medistry', description: 'Sign in, look up a patient, request consent, read records and co-sign emergency access.', script: 'clinicians' },
  '/facilities': { file: 'facilities', nav: 'facilities', title: 'Facilities | Medistry', description: 'Accredited facilities and verified clinicians on Medistry.', script: 'facilities' },
  '/status': { file: 'status', nav: '', title: 'Platform Status | Medistry', description: 'Live health of this Medistry environment.', script: 'status' },
  '/contact': { file: 'contact', nav: 'contact', title: 'Contact | Medistry', description: 'Talk to the Medistry team about onboarding, integration or a walkthrough.', script: 'contact' },
};

const NAV_KEYS = ['home', 'about', 'features', 'how', 'patients', 'clinicians', 'emergency', 'facilities', 'contact'];

// Offline card scanner. Not in PAGES: it embeds the public keys and its strings, and may use the camera.
const SCAN_PAGE: PageDef = {
  file: 'scan', nav: 'emergency', title: 'Emergency Scan | Medistry',
  description: 'Scan and verify a Medistry offline emergency card on this device, even without internet.',
  script: 'scan', module: true,
};

/** JSON that is safe inside <script type="application/json"> (cannot close the tag or break the page). */
function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function renderPage(page: PageDef, extra: Record<string, string> = {}): string | null {
  try {
    let html = fs.readFileSync(path.join(SITE_DIR, 'layout.html'), 'utf-8');
    const content = fs.readFileSync(path.join(SITE_DIR, 'pages', `${page.file}.html`), 'utf-8');
    html = html
      .replace('{{content}}', () => content)
      .replace(/\{\{title\}\}/g, () => page.title.replace(/&/g, '&amp;'))
      .replace(/\{\{description\}\}/g, () => page.description.replace(/"/g, '&quot;'))
      .replace('{{pageScript}}', () => (page.script
        ? (page.module ? `<script type="module" src="/js/${page.script}.js"></script>` : `<script src="/js/${page.script}.js" defer></script>`)
        : ''));
    for (const key of NAV_KEYS) {
      html = html.replace(new RegExp(`\\{\\{active_${key}\\}\\}`, 'g'), page.nav === key ? 'active' : '');
    }
    for (const [k, v] of Object.entries(extra)) html = html.split(`{{${k}}}`).join(v);
    return html;
  } catch {
    return null;
  }
}

const STATIC_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const PORT = parseInt(process.env.PORT || '3000', 10);

// Helper to parse JSON body
function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON responses
function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  const headers = {
    'Content-Type': 'application/json',
    ...getSecurityHttpHeaders(),
  };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

// Helper to send HTML responses
function sendHtml(res: http.ServerResponse, statusCode: number, html: string) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    ...getSecurityHttpHeaders(),
  };
  res.writeHead(statusCode, headers);
  res.end(html);
}

// Helper to serve static files
function serveStaticFile(res: http.ServerResponse, filePath: string, contentType: string) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      ...getSecurityHttpHeaders(),
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = getClientIp(req);
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method || 'GET';

  // 1. Rate Limiting Check
  const rateLimitStatus = rateLimiter.check(ip);
  if (!rateLimitStatus.allowed) {
    sendJson(res, 429, {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please wait before making further requests.',
      resetMs: rateLimitStatus.resetMs,
      isLockedOut: rateLimitStatus.isLockedOut,
    });
    return;
  }

  if ((pathname.startsWith('/api/emergency/gate/') || pathname.startsWith('/e/')) && !gateLimiter.check(ip).allowed) {
    sendJson(res, 429, { error: 'Too many emergency code lookups. Wait a minute and try again.' });
    return;
  }

  try {
    // Static assets from /site: one optional subfolder (e.g. /js/lib/), no dot-segments, known types only
    if (method === 'GET' && /^\/(css|js|assets|vendor)\/(?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(pathname)) {
      const ext = path.extname(pathname);
      const filePath = path.resolve(SITE_DIR, `.${pathname}`);
      if (STATIC_TYPES[ext] && filePath.startsWith(SITE_DIR + path.sep)) {
        serveStaticFile(res, filePath, STATIC_TYPES[ext]);
        return;
      }
    }

    // Scanner service worker (served from the root so it may control /s)
    if (method === 'GET' && pathname === '/sw.js') {
      fs.readFile(path.join(SITE_DIR, 'sw.js'), (err, content) => {
        if (err) { sendJson(res, 404, { error: 'Route not found', path: pathname }); return; }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ...getSecurityHttpHeaders() });
        res.end(content);
      });
      return;
    }

    // Offline card scanner: embeds the current public keys and its strings so it works offline after one visit.
    // The card token stays in the URL fragment and is never sent here.
    if (method === 'GET' && (pathname === '/s' || pathname === '/s/')) {
      const html = renderPage(SCAN_PAGE, {
        jwksJson: jsonForScriptTag({ keys: getPublicJwks(), generatedAt: Date.now() }),
        scanI18nJson: jsonForScriptTag(scannerStrings()),
      });
      if (html) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...getSecurityHttpHeaders(),
          'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }
    }

    // Site pages
    if (method === 'GET' && PAGES[pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname]) {
      const html = renderPage(PAGES[pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname]);
      if (html) {
        sendHtml(res, 200, html);
        return;
      }
    }

    // Public keys for verifying offline emergency cards (current key first, then previous keys kept for rotation).
    // Never contains private key material.
    if (method === 'GET' && pathname === '/.well-known/medistry-keys.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...getSecurityHttpHeaders(), 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify({ keys: getPublicJwks() }));
      return;
    }

    // Demo shortcut: the priority patient's emergency gate (code is generated at startup)
    if (method === 'GET' && pathname === '/demo') {
      const demoCode = codeByPatient.get(seedData.patients[0].patient.id)?.formattedCode || seedData.patients[0].emergencyCode.formattedCode;
      res.writeHead(302, { Location: `/e/${demoCode}` });
      res.end();
      return;
    }

    // JSON API for the patient portal, clinician console, emergency gate and contact form
    if (await handlePortalApi(req, res, urlObj)) return;

    // Health Check
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'HEALTHY',
        platform: 'MEDISTRY Regional Health Record Portability Platform',
        countryCode: deploymentCountry(),
        regulator: (() => { try { return registryFor(deploymentCountry()).regulatorName; } catch { return 'Not configured for this country'; } })(),
        compliance: 'Nigeria Data Protection Act (NDPA 2023)',
        timestamp: new Date().toISOString(),
        activePatients: seedData.patients.length,
        accreditedFacilities: seedData.facilities.length,
        verifiedClinicians: seedData.clinicians.length,
        storage: persistence.stats(),
      });
      return;
    }

    // API: Facilities
    if (method === 'GET' && pathname === '/api/facilities') {
      sendJson(res, 200, { facilities: seedData.facilities });
      return;
    }

    // API: Clinicians
    if (method === 'GET' && pathname === '/api/clinicians') {
      // Verified clinicians only, public fields only (no review notes, registration or licence-expiry details).
      sendJson(res, 200, {
        clinicians: seedData.clinicians.filter((c) => c.status === 'VERIFIED').map((c) => ({
          id: c.id, userId: c.userId, fullName: c.fullName, licenseNumber: c.licenseNumber, countryCode: c.countryCode,
          specialty: c.specialty, facilityId: c.facilityId, status: c.status,
        })),
      });
      return;
    }

    // API: Patients (Safe Redacted Directory for Testing)
    if (method === 'GET' && pathname === '/api/patients') {
      if (!DEMO_MODE) { sendJson(res, 404, { error: 'Route not found', path: pathname }); return; }
      const sanitized = seedData.patients.map((p) => {
        const demo = decryptPatientDemographics(p.patient);
        return {
          id: p.patient.id,
          firstName: demo.firstName,
          lastName: demo.lastName,
          dateOfBirth: demo.dateOfBirth,
          gender: demo.gender,
          bloodGroup: p.patient.bloodGroup.replace('_', ' '),
          genotype: p.patient.genotype,
          emergencyCode: p.emergencyCode.formattedCode,
          scanUrl: p.emergencyCode.scanUrl,
          dnr: p.patient.advanceDirectiveDnr,
          organDonor: p.patient.organDonor,
          publicOptIn: p.patient.publicEmergencyOptIn,
          allergiesCount: p.patient.allergies.length,
          chronicConditions: p.patient.chronicConditions,
        };
      });
      sendJson(res, 200, { patients: sanitized });
      return;
    }

    // EMERGENCY GATE: /e/:code (the page loads the gate state from /api/emergency/gate/:code)
    if (method === 'GET' && pathname.startsWith('/e/')) {
      const code = decodeURIComponent(pathname.slice(3)).trim();
      const patient = patientsByCode.get(normalizePatientCode(code));
      const html = renderPage(
        { file: 'emergency-gate', nav: 'emergency', title: 'Emergency Gate | Medistry', description: 'Clinician emergency break-glass gateway.', script: 'gate' }
      );
      if (html) {
        sendHtml(res, patient ? 200 : 404, html);
        return;
      }
    }

    // GET /emergency/summary?grant=:grantId
    if (method === 'GET' && pathname === '/emergency/summary') {
      const grantId = urlObj.searchParams.get('grant');
      if (!grantId) {
        sendHtml(res, 400, '<h1>Missing grant parameter</h1>');
        return;
      }

      // Clinician session required (cookie or Bearer), and the grant must belong to that clinician.
      const viewer = handlePortalApi.authenticate(req, { allowCookie: true });
      if (!viewer) {
        sendHtml(res, 401, '<h1>Clinician sign-in required</h1><p>Sign in on the <a href="/clinicians">clinician console</a>, then reopen this page.</p>');
        return;
      }
      const grant = emergencyEngine.getGrant(grantId);
      if (!grant) {
        sendHtml(res, 404, '<h1>Emergency grant not found or expired</h1>');
        return;
      }
      if (grant.clinicianId !== viewer.id && grant.coSignClinicianId !== viewer.id) {
        sendHtml(res, 403, '<h1>This emergency grant belongs to another clinician</h1>');
        return;
      }

      const patient = patientsById.get(grant.patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient entity not found</h1>');
        return;
      }

      try {
        const summaryData = emergencyEngine.buildEmergencySummary(patient, grantId);
        const html = renderEmergencySummaryHtml(summaryData);
        sendHtml(res, 200, html);
      } catch (err: any) {
        sendHtml(res, 400, `<h1>Error generating emergency summary: ${escapeHtml(err?.message || 'unknown error')}</h1>`);
      }
      return;
    }

    // GET /emergency/offline-card?patientId=:patientId
    if (method === 'GET' && pathname === '/emergency/offline-card') {
      if (!DEMO_MODE) { sendJson(res, 404, { error: 'Route not found', path: pathname }); return; }
      const patientId = urlObj.searchParams.get('patientId') || seedData.patients[0].patient.id;
      const patient = patientsById.get(patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient not found</h1>');
        return;
      }

      // Same card as the patient portal: the current valid card, or the first one if none exists.
      try {
        const card = await handlePortalApi.offlineCardFor(patient, req, false, urlObj.searchParams.get('lang'));
        sendHtml(res, 200, card.cardHtml);
      } catch (err: any) {
        sendHtml(res, err?.status || 500, `<h1>${escapeHtml(err?.message || 'Card unavailable')}</h1><p><a href="/patients">Open the patient portal</a> to reissue your card.</p>`);
      }
      return;
    }

    // GET /emergency/wallet-card?patientId=:patientId
    if (method === 'GET' && pathname === '/emergency/wallet-card') {
      if (!DEMO_MODE) { sendJson(res, 404, { error: 'Route not found', path: pathname }); return; }
      const patientId = urlObj.searchParams.get('patientId') || seedData.patients[0].patient.id;
      const patient = patientsById.get(patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient not found</h1>');
        return;
      }
      const demo = decryptPatientDemographics(patient);
      const svg = generateWalletCardSvg(
        codeByPatient.get(patient.id)?.formattedCode || patient.activeEmergencyCodeId || 'K7QM-4T9X-2HDP-8W2',
        `${demo.firstName} ${demo.lastName}`,
        patient.emergencyContacts[0]?.phone,
        { ...DEFAULT_CONFIG, baseUrl: appBaseUrl(req) }
      );
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...getSecurityHttpHeaders() });
      res.end(svg);
      return;
    }

    // GET /emergency/wristband?patientId=:patientId
    if (method === 'GET' && pathname === '/emergency/wristband') {
      if (!DEMO_MODE) { sendJson(res, 404, { error: 'Route not found', path: pathname }); return; }
      const patientId = urlObj.searchParams.get('patientId') || seedData.patients[0].patient.id;
      const patient = patientsById.get(patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient not found</h1>');
        return;
      }
      const svg = generateWristbandSvg(
        codeByPatient.get(patient.id)?.formattedCode || patient.activeEmergencyCodeId || 'K7QM-4T9X-2HDP-8W2',
        { ...DEFAULT_CONFIG, baseUrl: appBaseUrl(req) }
      );
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...getSecurityHttpHeaders() });
      res.end(svg);
      return;
    }

    // Fallback 404: friendly page for browsers, JSON for API clients
    if (method === 'GET' && !pathname.startsWith('/api/')) {
      const html = renderPage({ file: '404', nav: '', title: 'Page Not Found | Medistry', description: 'Page not found.' });
      if (html) {
        sendHtml(res, 404, html);
        return;
      }
    }
    sendJson(res, 404, { error: 'Route not found', path: pathname });
  } catch (err: any) {
    console.error('Unhandled Server Error:', err);
    sendJson(res, 500, { error: 'Internal Server Error', message: err.message });
  }
});

// Write-through storage: finish queued writes before the process exits.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close();
    persistence.close().catch(() => {}).finally(() => process.exit(0));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🛡️  MEDISTRY FULL-STACK PLATFORM RUNNING LOCALLY`);
  console.log(`🌐  Local URL:        http://localhost:${PORT}`);
  console.log(`🏥  Health Check:     http://localhost:${PORT}/api/health`);
  console.log(`👥  Patients List:    http://localhost:${PORT}/api/patients`);
  console.log(`🚨  Emergency Demo:   http://localhost:${PORT}/e/${seedData.patients[0].emergencyCode.formattedCode}`);
  console.log(`🫀  Priority synthetic patient: open the Emergency Demo link (no patient details are logged)`);
  console.log(`======================================================\n`);
});
