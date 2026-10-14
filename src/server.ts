/**
 * MEDISTRY Full-Stack Application Server
 * Serves the patient frontpage UI, RESTful FHIR APIs, Break-Glass Emergency Gate,
 * server-rendered emergency summaries (<50KB), and offline cryptographic card exports.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSeedData } from '../prisma/seed.ts';
import { AuditChainManager } from './lib/audit/hashChain.ts';
import { ClinicalDataStore } from './lib/clinical/store.ts';
import { ClinicalTimelineEngine } from './lib/clinical/timeline.ts';
import { NotificationDispatcher, ConsoleNotificationProvider } from './lib/notifications/dispatcher.ts';
import { EmergencyBreakGlassEngine } from './lib/emergency/breakGlassEngine.ts';
import { renderEmergencySummaryHtml } from './lib/emergency/summaryRenderer.ts';
import { OfflineEmergencyCardManager } from './lib/emergency/offlineCard.ts';
import { generateWalletCardSvg, generateWristbandSvg } from './lib/code/deliverables.ts';
import { SlidingWindowRateLimiter, getSecurityHttpHeaders } from './lib/security/rateLimiter.ts';
import { ConsentLifecycleManager } from './lib/consent/consentManager.ts';
import { PatientAccessLogManager } from './lib/audit/accessLogManager.ts';
import { decryptPatientDemographics, type PatientEntity } from './lib/patient/profile.ts';
import { seedClinicalRecords } from './lib/site/seedClinical.ts';
import { createPortalApi } from './lib/site/portalApi.ts';
import { normalizePatientCode } from './lib/code/crockford.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 1. Initialize In-Memory Data Store & Engines
console.log('📦 Initializing MEDISTRY Clinical Store and Cryptographic Engines...');
const seedData = generateSeedData();
const auditManager = new AuditChainManager();
const clinicalStore = new ClinicalDataStore(auditManager);
const timelineEngine = new ClinicalTimelineEngine(clinicalStore);
const consoleProvider = new ConsoleNotificationProvider();
const dispatcher = new NotificationDispatcher(consoleProvider);
const emergencyEngine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);
const offlineCardManager = new OfflineEmergencyCardManager();
const rateLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 300 });
const consentManager = new ConsentLifecycleManager(auditManager);
const accessLogManager = new PatientAccessLogManager(auditManager);

// Index patients by ID and by emergency code (raw and formatted)
const patientsById = new Map<string, PatientEntity>();
const patientsByCode = new Map<string, PatientEntity>();
const codeByPatient = new Map<string, { rawCode: string; formattedCode: string }>();

for (const entry of seedData.patients) {
  patientsById.set(entry.patient.id, entry.patient);
  patientsByCode.set(entry.emergencyCode.rawCode, entry.patient);
  patientsByCode.set(entry.emergencyCode.formattedCode, entry.patient);
  codeByPatient.set(entry.patient.id, {
    rawCode: entry.emergencyCode.rawCode,
    formattedCode: entry.emergencyCode.formattedCode,
  });
}

// Resolve provenance names and seed synthetic FHIR records for the timelines
for (const f of seedData.facilities) {
  timelineEngine.registerFacility(f.id, f.name);
  accessLogManager.registerFacility(f.id, f.name);
}
for (const c of seedData.clinicians) {
  timelineEngine.registerClinician(c.id, `${c.fullName} (${c.specialty})`);
  timelineEngine.registerClinician(c.userId, `${c.fullName} (${c.specialty})`);
  accessLogManager.registerClinician(c.id, `${c.fullName} (${c.specialty})`);
  accessLogManager.registerClinician(c.userId, `${c.fullName} (${c.specialty})`);
}
seedClinicalRecords(clinicalStore, seedData.patients.map((p) => p.patient), seedData.clinicians, seedData.facilities);

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
  dataDir: path.join(ROOT_DIR, 'data'),
});

// Site pages: shared layout + one template per page
const PAGES: Record<string, { file: string; nav: string; title: string; description: string; script?: string }> = {
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

function renderPage(page: { file: string; nav: string; title: string; description: string; script?: string }, extra: Record<string, string> = {}): string | null {
  try {
    let html = fs.readFileSync(path.join(SITE_DIR, 'layout.html'), 'utf-8');
    const content = fs.readFileSync(path.join(SITE_DIR, 'pages', `${page.file}.html`), 'utf-8');
    html = html
      .replace('{{content}}', () => content)
      .replace(/\{\{title\}\}/g, () => page.title.replace(/&/g, '&amp;'))
      .replace(/\{\{description\}\}/g, () => page.description.replace(/"/g, '&quot;'))
      .replace('{{pageScript}}', () => (page.script ? `<script src="/js/${page.script}.js" defer></script>` : ''));
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
  const clientIp = req.socket.remoteAddress || '127.0.0.1';
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method || 'GET';

  // 1. Rate Limiting Check
  const rateLimitStatus = rateLimiter.check(clientIp);
  if (!rateLimitStatus.allowed) {
    sendJson(res, 429, {
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please wait before making further requests.',
      resetMs: rateLimitStatus.resetMs,
      isLockedOut: rateLimitStatus.isLockedOut,
    });
    return;
  }

  try {
    // Static assets (css, js, svg) from /site, with path traversal protection
    if (method === 'GET' && /^\/(css|js|assets)\/[A-Za-z0-9._-]+$/.test(pathname)) {
      const ext = path.extname(pathname);
      if (STATIC_TYPES[ext]) {
        serveStaticFile(res, path.join(SITE_DIR, pathname), STATIC_TYPES[ext]);
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
        countryCode: 'NG',
        regulator: 'Medical and Dental Council of Nigeria (MDCN)',
        compliance: 'Nigeria Data Protection Act (NDPA 2023)',
        timestamp: new Date().toISOString(),
        activePatients: seedData.patients.length,
        accreditedFacilities: seedData.facilities.length,
        verifiedClinicians: seedData.clinicians.length,
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
      sendJson(res, 200, { clinicians: seedData.clinicians });
      return;
    }

    // API: Patients (Safe Redacted Directory for Testing)
    if (method === 'GET' && pathname === '/api/patients') {
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

      const grant = emergencyEngine.getGrant(grantId);
      if (!grant) {
        sendHtml(res, 404, '<h1>Emergency grant not found or expired</h1>');
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
        sendHtml(res, 400, `<h1>Error generating emergency summary: ${err.message}</h1>`);
      }
      return;
    }

    // GET /emergency/offline-card?patientId=:patientId
    if (method === 'GET' && pathname === '/emergency/offline-card') {
      const patientId = urlObj.searchParams.get('patientId') || seedData.patients[0].patient.id;
      const patient = patientsById.get(patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient not found</h1>');
        return;
      }

      const card = offlineCardManager.exportOfflineEmergencyCard(patient, patient.activeEmergencyCodeId || 'K7QM-4T9X-2HDP-8W2', 30);
      sendHtml(
        res,
        200,
        `<!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>OFFLINE EMERGENCY CARD — MEDISTRY</title>
          <style>
            body { font-family: -apple-system, sans-serif; background: #f1f5f9; padding: 24px; display: flex; flex-direction: column; align-items: center; }
            .info { max-width: 400px; margin-top: 16px; font-size: 13px; color: #475569; text-align: center; }
            .btn-print { margin-top: 16px; padding: 10px 20px; background: #0f172a; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
          </style>
        </head>
        <body>
          ${card.printableCardHtml}
          <div class="info">
            Cryptographically signed by Regional Health Authority. Ambulance first responders can scan and verify signature offline.
          </div>
          <button class="btn-print" onclick="window.print()">🖨️ Print Emergency Card</button>
        </body>
        </html>`
      );
      return;
    }

    // GET /emergency/wallet-card?patientId=:patientId
    if (method === 'GET' && pathname === '/emergency/wallet-card') {
      const patientId = urlObj.searchParams.get('patientId') || seedData.patients[0].patient.id;
      const patient = patientsById.get(patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient not found</h1>');
        return;
      }
      const demo = decryptPatientDemographics(patient);
      const svg = generateWalletCardSvg(
        patient.activeEmergencyCodeId || 'K7QM-4T9X-2HDP-8W2',
        `${demo.firstName} ${demo.lastName}`,
        patient.emergencyContacts[0]?.phone
      );
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...getSecurityHttpHeaders() });
      res.end(svg);
      return;
    }

    // GET /emergency/wristband?patientId=:patientId
    if (method === 'GET' && pathname === '/emergency/wristband') {
      const patientId = urlObj.searchParams.get('patientId') || seedData.patients[0].patient.id;
      const patient = patientsById.get(patientId);
      if (!patient) {
        sendHtml(res, 404, '<h1>Patient not found</h1>');
        return;
      }
      const svg = generateWristbandSvg(patient.activeEmergencyCodeId || 'K7QM-4T9X-2HDP-8W2');
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🛡️  MEDISTRY FULL-STACK PLATFORM RUNNING LOCALLY`);
  console.log(`🌐  Local URL:        http://localhost:${PORT}`);
  console.log(`🏥  Health Check:     http://localhost:${PORT}/api/health`);
  console.log(`👥  Patients List:    http://localhost:${PORT}/api/patients`);
  console.log(`🚨  Emergency Demo:   http://localhost:${PORT}/e/${seedData.patients[0].emergencyCode.formattedCode}`);
  console.log(`🫀  Priority Patient: Amara Okonkwo (HbSS Sickle Cell, Penicillin Allergy)`);
  console.log(`======================================================\n`);
});
