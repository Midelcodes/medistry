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
import { EmergencyBreakGlassEngine, type BreakGlassReason } from './lib/emergency/breakGlassEngine.ts';
import { renderEmergencySummaryHtml } from './lib/emergency/summaryRenderer.ts';
import { OfflineEmergencyCardManager } from './lib/emergency/offlineCard.ts';
import { generateWalletCardSvg, generateWristbandSvg } from './lib/code/deliverables.ts';
import { SlidingWindowRateLimiter, getSecurityHttpHeaders } from './lib/security/rateLimiter.ts';
import { ConsentLifecycleManager } from './lib/consent/consentManager.ts';
import { PatientAccessLogManager } from './lib/audit/accessLogManager.ts';
import { decryptPatientDemographics, type PatientEntity } from './lib/patient/profile.ts';
import type { ActorContext } from './lib/policy/enforcer.ts';

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
const rateLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 60 });
const consentManager = new ConsentLifecycleManager(auditManager);
const accessLogManager = new PatientAccessLogManager(auditManager);

// Index patients by ID and by emergency code
const patientsById = new Map<string, PatientEntity>();
const patientsByCode = new Map<string, PatientEntity>();

for (const entry of seedData.patients) {
  patientsById.set(entry.patient.id, entry.patient);
  patientsByCode.set(entry.emergencyCode.rawCode, entry.patient);
  patientsByCode.set(entry.emergencyCode.formattedCode, entry.patient);
}

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
    // Static Routes
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      serveStaticFile(res, path.join(ROOT_DIR, 'index.html'), 'text/html; charset=utf-8');
      return;
    }
    if (method === 'GET' && pathname === '/styles.css') {
      serveStaticFile(res, path.join(ROOT_DIR, 'styles.css'), 'text/css');
      return;
    }
    if (method === 'GET' && pathname === '/app.js') {
      serveStaticFile(res, path.join(ROOT_DIR, 'app.js'), 'application/javascript');
      return;
    }

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

    // EMERGENCY GATE: /e/:code
    if (method === 'GET' && pathname.startsWith('/e/')) {
      const rawCode = pathname.replace('/e/', '').trim().toUpperCase();
      const patient = patientsByCode.get(rawCode);

      if (!patient) {
        sendHtml(
          res,
          404,
          `<div style="font-family:sans-serif; text-align:center; padding:40px;">
            <h1 style="color:#b91c1c;">404 - Emergency Code Not Found</h1>
            <p>The scanned emergency code is invalid or has been revoked by the patient.</p>
            <a href="/" style="color:#2563eb;">Return to Hospital Portal</a>
          </div>`
        );
        return;
      }

      // Check if patient opted into public badge without doctor login
      const gate = emergencyEngine.evaluatePublicScanGate(patient);
      if (!gate.requiresLogin && gate.publicCard) {
        sendHtml(
          res,
          200,
          `<!DOCTYPE html>
          <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PUBLIC EMERGENCY BADGE — MEDISTRY</title>
            <style>
              body { font-family: -apple-system, sans-serif; background:#f8fafc; padding:20px; color:#0f172a; }
              .card { max-width:500px; margin:0 auto; background:#fff; border-radius:12px; border:2px solid #dc2626; padding:20px; box-shadow:0 4px 6px rgba(0,0,0,0.1); }
              .badge-head { background:#fee2e2; color:#991b1b; padding:8px 12px; border-radius:6px; font-weight:bold; margin-bottom:16px; text-align:center; }
              .stat { display:flex; justify-content:space-between; margin-bottom:12px; border-bottom:1px solid #e2e8f0; padding-bottom:8px; }
              .val { font-size:20px; font-weight:800; color:#b91c1c; }
              .btn-login { display:block; text-align:center; background:#1e293b; color:#fff; padding:12px; border-radius:6px; text-decoration:none; font-weight:bold; margin-top:20px; }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="badge-head">🚨 PUBLIC EMERGENCY TRIAGE CARD (PATIENT OPT-IN)</div>
              <div class="stat"><span>Blood Group & Rh:</span> <span class="val">${gate.publicCard.bloodGroup}</span></div>
              <div class="stat"><span>Genotype:</span> <span class="val" style="color:#0f172a;">${gate.publicCard.genotype}</span></div>
              <div style="margin-bottom:12px;">
                <strong>Critical Allergies:</strong>
                <ul style="margin-top:6px; color:#b91c1c;">${gate.publicCard.allergies.map((a) => `<li>${a}</li>`).join('')}</ul>
              </div>
              <div style="margin-bottom:16px;">
                <strong>Emergency Contact Hotline:</strong>
                <div style="font-size:18px; font-weight:bold; margin-top:4px;"><a href="tel:${gate.publicCard.emergencyHotline}" style="color:#15803d; text-decoration:none;">📞 ${gate.publicCard.emergencyHotline}</a></div>
              </div>
              <p style="font-size:12px; color:#64748b;">Notice: Minimal triage data shown per patient consent. To access medications, clinical encounters, or medical directives, attending clinicians must log in.</p>
              <a href="/e/${rawCode}?mode=clinician" class="btn-login">👨‍⚕️ Clinician Break-Glass Gateway</a>
            </div>
          </body>
          </html>`
        );
        return;
      }

      // Default: Clinician Break-Glass Login & Reason Selection Screen
      sendHtml(
        res,
        200,
        `<!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>CLINICIAN EMERGENCY BREAK-GLASS — MEDISTRY</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f1f5f9; padding:20px; color:#0f172a; }
            .container { max-width:550px; margin:0 auto; background:#ffffff; border-radius:12px; border:2px solid #b91c1c; padding:24px; box-shadow:0 8px 16px rgba(0,0,0,0.1); }
            .header-stripe { background:#7f1d1d; color:#fff; margin:-24px -24px 20px -24px; padding:16px 24px; border-radius:10px 10px 0 0; }
            .header-stripe h2 { font-size:18px; margin:0; }
            .badge-code { background:#fee2e2; color:#991b1b; padding:6px 12px; border-radius:6px; font-family:monospace; font-size:16px; font-weight:bold; display:inline-block; margin-bottom:16px; }
            .form-group { margin-bottom:16px; }
            label { display:block; font-weight:bold; font-size:13px; margin-bottom:6px; color:#334155; }
            select, input, textarea { width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:6px; font-size:14px; box-sizing:border-box; }
            .alert-box { background:#fffbeb; border:1px solid #fef3c7; color:#92400e; padding:12px; border-radius:6px; font-size:12px; margin-bottom:16px; line-height:1.5; }
            .btn-break { background:#dc2626; color:#fff; width:100%; border:none; padding:14px; font-size:16px; font-weight:bold; border-radius:6px; cursor:pointer; }
            .btn-break:hover { background:#b91c1c; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header-stripe">
              <h2>🛡️ HOSPITAL EMERGENCY BREAK-GLASS GATEWAY</h2>
              <p style="font-size:12px; margin:4px 0 0 0; opacity:0.9;">Verified Attending Clinician Access Only • NDPA 2023 Regulated</p>
            </div>
            
            <div class="badge-code">PATIENT CODE: ${rawCode}</div>

            <div class="alert-box">
              <strong>⚠️ LEGAL & AUDIT NOTICE:</strong>
              Executing an emergency break-glass grants immediate, time-boxed (60-minute) read-only access to critical triage attributes. Every access appends an immutable entry to the cryptographic audit ledger and triggers instant SMS/push notifications to the patient and their emergency contacts.
            </div>

            <form id="breakGlassForm">
              <input type="hidden" name="code" value="${rawCode}">
              
              <div class="form-group">
                <label for="clinicianSelect">Select Attending Clinician (Verified MDCN Doctor):</label>
                <select id="clinicianSelect" name="clinicianId" required>
                  ${seedData.clinicians.map((c) => `<option value="${c.id}" data-name="${c.fullName}" data-fac="${c.facilityId}">${c.fullName} (${c.licenseNumber}) — ${c.specialty}</option>`).join('')}
                </select>
              </div>

              <div class="form-group">
                <label for="reasonSelect">Emergency Clinical Indication:</label>
                <select id="reasonSelect" name="reason" required onchange="toggleReasonDetails(this.value)">
                  <option value="UNCONSCIOUS">Patient is unconscious / comatose</option>
                  <option value="LIFE_THREATENING">Life-threatening trauma / shock state</option>
                  <option value="PATIENT_UNABLE_TO_CONSENT">Patient incapacitated / unable to communicate</option>
                  <option value="OTHER">Other acute clinical emergency (Requires documentation)</option>
                </select>
              </div>

              <div class="form-group" id="reasonDetailsGroup" style="display:none;">
                <label for="reasonDetails">Clinical Justification (Mandatory):</label>
                <textarea id="reasonDetails" name="reasonDetails" rows="2" placeholder="Describe the acute resuscitation indication..."></textarea>
              </div>

              <div class="form-group">
                <label for="totp">MDCN Clinician TOTP 2FA Token:</label>
                <input type="text" id="totp" name="totp" value="123456" placeholder="Enter 6-digit authenticator code" required>
              </div>

              <button type="submit" class="btn-break">🚨 CONFIRM BREAK-GLASS & VIEW SUMMARY</button>
            </form>
          </div>

          <script>
            function toggleReasonDetails(val) {
              document.getElementById('reasonDetailsGroup').style.display = (val === 'OTHER') ? 'block' : 'none';
            }

            document.getElementById('breakGlassForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const sel = document.getElementById('clinicianSelect');
              const opt = sel.options[sel.selectedIndex];
              const clinicianId = sel.value;
              const doctorName = opt.getAttribute('data-name');
              const facilityId = opt.getAttribute('data-fac');
              const reason = document.getElementById('reasonSelect').value;
              const reasonDetails = document.getElementById('reasonDetails').value;
              const code = '${rawCode}';

              try {
                const res = await fetch('/api/emergency/break-glass', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    code,
                    clinicianId,
                    doctorName,
                    facilityId,
                    reason,
                    reasonDetails
                  })
                });
                const data = await res.json();
                if (data.redirectUrl) {
                  window.location.href = data.redirectUrl;
                } else {
                  alert(data.error || 'Failed to initiate break glass');
                }
              } catch (err) {
                alert('Connection error: ' + err.message);
              }
            });
          </script>
        </body>
        </html>`
      );
      return;
    }

    // POST /api/emergency/break-glass
    if (method === 'POST' && pathname === '/api/emergency/break-glass') {
      const body = await parseJsonBody(req);
      const { code, clinicianId, doctorName, facilityId, reason, reasonDetails } = body;

      const patient = patientsByCode.get((code || '').toUpperCase());
      if (!patient) {
        sendJson(res, 404, { error: 'Patient emergency code not found' });
        return;
      }

      const clinician = seedData.clinicians.find((c) => c.id === clinicianId) || seedData.clinicians[0];
      const facility = seedData.facilities.find((f) => f.id === facilityId) || seedData.facilities[0];

      const actor: ActorContext = {
        userId: clinician.userId,
        role: 'DOCTOR',
        clinicianId: clinician.id,
        isVerifiedClinician: true,
      };

      try {
        const { grant } = await emergencyEngine.initiateBreakGlass({
          patient,
          emergencyCode: code,
          actor,
          treatingDoctorName: doctorName || clinician.fullName,
          facilityId: facility.id,
          facilityName: facility.name,
          reason: (reason as BreakGlassReason) || 'UNCONSCIOUS',
          reasonDetails,
        });

        sendJson(res, 200, {
          success: true,
          grantId: grant.id,
          redirectUrl: `/emergency/summary?grant=${grant.id}`,
        });
      } catch (err: any) {
        sendJson(res, 400, { error: err.message });
      }
      return;
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

    // POST /api/emergency/cosign
    if (method === 'POST' && pathname === '/api/emergency/cosign') {
      const body = await parseJsonBody(req);
      const { grantId, primaryClinicianId, coSignClinicianId, coSignDoctorName, coSignReason } = body;

      try {
        const updatedGrant = emergencyEngine.coSignForFullHistory({
          grantId,
          primaryClinicianId,
          coSignClinicianId,
          coSignDoctorName,
          coSignReason,
        });
        sendJson(res, 200, { success: true, grant: updatedGrant });
      } catch (err: any) {
        sendJson(res, 400, { error: err.message });
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

    // API: Multi-Facility Timeline
    if (method === 'GET' && pathname === '/api/timeline') {
      const patientId = urlObj.searchParams.get('patientId');
      if (!patientId) {
        sendJson(res, 400, { error: 'patientId query parameter required' });
        return;
      }
      const timeline = timelineEngine.getPatientTimeline(patientId);
      sendJson(res, 200, { timeline });
      return;
    }

    // API: Access Log ("Who accessed my record")
    if (method === 'GET' && pathname === '/api/audit/logs') {
      const patientId = urlObj.searchParams.get('patientId');
      if (!patientId) {
        sendJson(res, 400, { error: 'patientId query parameter required' });
        return;
      }
      const logs = accessLogManager.getPatientAccessAuditLog(patientId);
      sendJson(res, 200, { logs });
      return;
    }

    // Fallback 404
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
