/**
 * MEDISTRY Server-Rendered Emergency Summary Template
 * Ultra-fast (< 50 KB, zero external JS/CSS dependencies), high-contrast,
 * mobile-first semantic HTML for immediate clinical triage on 3G connections.
 */

import type { EmergencySummaryData } from './breakGlassEngine.ts';

export function renderEmergencySummaryHtml(data: EmergencySummaryData): string {
  const { patient, triageEssentials, chronicCare, recentEncounters, legalDirectives, grantMeta } = data;

  const dnrBadge = legalDirectives.advanceDirectiveDnr
    ? `<div class="alert-banner dnr-banner" role="alert">
        <span class="alert-icon">⚠️</span>
        <div>
          <strong>DO NOT RESUSCITATE (DNR) ON FILE</strong>
          <p>Patient has an active legal advance directive declining cardiopulmonary resuscitation.</p>
        </div>
      </div>`
    : '';

  const organDonorBadge = legalDirectives.organDonor
    ? `<span class="badge badge-organ">🫀 Organ Donor</span>`
    : '';

  const drugAllergiesHtml = triageEssentials.drugAllergiesFirst.length > 0
    ? triageEssentials.drugAllergiesFirst.map(a => `
        <div class="drug-allergy-card">
          <div class="allergy-head">
            <span class="substance">${escapeHtml(a.substance)}</span>
            <span class="severity severity-${a.severity.toLowerCase()}">${escapeHtml(a.severity.toUpperCase())}</span>
          </div>
          <div class="reaction">Reaction: <strong>${escapeHtml(a.reaction)}</strong></div>
        </div>
      `).join('')
    : '<div class="empty-state">No known drug allergies on file.</div>';

  const otherAllergies = triageEssentials.allergies.filter(a => a.category !== 'drug');
  const otherAllergiesHtml = otherAllergies.length > 0
    ? `<div class="other-allergies-list">
        ${otherAllergies.map(a => `
          <span class="pill pill-allergy">${escapeHtml(a.substance)} (${escapeHtml(a.reaction)})</span>
        `).join('')}
       </div>`
    : '<span class="text-muted">None documented</span>';

  const medicationsHtml = chronicCare.activeMedications.length > 0
    ? chronicCare.activeMedications.map(m => `
        <li class="med-item">
          <strong>${escapeHtml(m.medicationName)}</strong> — ${escapeHtml(m.dose)} (${escapeHtml(m.route)})
          <span class="med-date">Since: ${escapeHtml(m.sinceDate)}</span>
        </li>
      `).join('')
    : '<li class="text-muted">No active chronic medications on record.</li>';

  const conditionsHtml = chronicCare.chronicConditions.length > 0
    ? chronicCare.chronicConditions.map(c => `
        <span class="pill pill-condition">${escapeHtml(c)}</span>
      `).join('')
    : '<span class="text-muted">No chronic conditions recorded</span>';

  const encountersHtml = recentEncounters.length > 0
    ? recentEncounters.map(e => `
        <tr class="encounter-row">
          <td><span class="enc-date">${escapeHtml(e.date)}</span></td>
          <td>
            <strong>${escapeHtml(e.diagnosis)}</strong>
            <div class="enc-sub">${escapeHtml(e.facilityName)} • Dr. ${escapeHtml(e.doctorName)}</div>
          </td>
          <td>
            <div>${escapeHtml(e.treatment)}</div>
            <div class="enc-result"><small>Result: ${escapeHtml(e.result)}</small></div>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" class="text-muted">No recent clinical encounters recorded.</td></tr>';

  const emergencyContactsHtml = patient.emergencyContacts.map(c => `
    <div class="contact-card">
      <div class="contact-info">
        <strong>${escapeHtml(c.name)}</strong> (${escapeHtml(c.relationship)})
      </div>
      <a href="tel:${escapeHtml(c.phone)}" class="btn btn-call" aria-label="Call ${escapeHtml(c.name)}">
        📞 ${escapeHtml(c.phone)}
      </a>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <meta name="theme-color" content="#b91c1c">
  <title>EMERGENCY MEDICAL SUMMARY — MEDISTRY</title>
  <style>
    :root {
      --bg-primary: #f8fafc;
      --surface: #ffffff;
      --text-main: #0f172a;
      --text-muted: #475569;
      --red-600: #dc2626;
      --red-700: #b91c1c;
      --red-50: #fef2f2;
      --amber-600: #d97706;
      --amber-50: #fffbeb;
      --blue-600: #2563eb;
      --blue-50: #eff6ff;
      --emerald-600: #059669;
      --border: #e2e8f0;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-primary);
      color: var(--text-main);
      font-family: var(--font-family);
      font-size: 15px;
      line-height: 1.5;
      padding: 0 0 40px;
    }
    .header-bar {
      background: #7f1d1d;
      color: #fff;
      padding: 12px 16px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .brand-title { font-size: 16px; font-weight: 800; letter-spacing: 0.05em; display: flex; align-items: center; gap: 8px; }
    .ttl-pill {
      background: #ef4444;
      color: #fff;
      padding: 4px 10px;
      border-radius: 9999px;
      font-weight: 700;
      font-size: 12px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
    .container { max-width: 800px; margin: 0 auto; padding: 16px; }
    .alert-banner {
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .dnr-banner {
      background: #fee2e2;
      border: 2px solid #ef4444;
      color: #991b1b;
    }
    .dnr-banner strong { font-size: 16px; }
    .alert-icon { font-size: 24px; line-height: 1; }
    .triage-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .triage-stat-card {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    .triage-stat-card.critical {
      border-color: #ef4444;
      background: #fff5f5;
    }
    .stat-label { font-size: 12px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
    .stat-value { font-size: 26px; font-weight: 900; color: #1e293b; margin-top: 4px; }
    .stat-value.danger { color: #dc2626; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .card-title {
      font-size: 16px;
      font-weight: 700;
      border-bottom: 2px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .patient-header {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 12px;
    }
    .patient-avatar {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #cbd5e1;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 800;
      color: #334155;
      flex-shrink: 0;
      border: 2px solid #94a3b8;
    }
    .patient-info h1 { font-size: 20px; font-weight: 800; }
    .patient-sub { color: var(--text-muted); font-size: 14px; }
    .contact-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      padding: 10px 12px;
      border-radius: 6px;
      margin-top: 8px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 700;
      border-radius: 6px;
      text-decoration: none;
      cursor: pointer;
      min-height: 44px;
    }
    .btn-call {
      background: #15803d;
      color: #fff;
    }
    .drug-allergy-card {
      background: #fef2f2;
      border: 1.5px solid #f87171;
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .allergy-head {
      display: flex;
      justify-content: space-between;
      font-weight: 700;
    }
    .severity {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 800;
    }
    .severity-severe { background: #b91c1c; color: #fff; }
    .severity-moderate { background: #ea580c; color: #fff; }
    .severity-mild { background: #ca8a04; color: #fff; }
    .reaction { font-size: 13px; margin-top: 4px; color: #7f1d1d; }
    .pill {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      margin: 2px 4px 2px 0;
    }
    .pill-allergy { background: #fee2e2; color: #991b1b; }
    .pill-condition { background: #e0f2fe; color: #0369a1; }
    .badge-organ { background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 700; }
    .med-item { margin-bottom: 8px; list-style-position: inside; }
    .med-date { display: block; font-size: 12px; color: var(--text-muted); margin-left: 18px; }
    .enc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .enc-table th, .enc-table td { padding: 8px; text-align: left; border-bottom: 1px solid var(--border); }
    .enc-table th { background: #f1f5f9; color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
    .enc-date { font-weight: 700; color: #334155; }
    .enc-sub { font-size: 11px; color: var(--text-muted); }
    .enc-result { color: #047857; }
    .full-history-box {
      border: 2px dashed #94a3b8;
      background: #f8fafc;
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    .btn-cosign {
      background: #1e293b;
      color: #fff;
      margin-top: 8px;
      border: none;
    }
    .audit-footer {
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
      margin-top: 24px;
      padding: 12px;
      border-top: 1px solid var(--border);
    }
    @media (max-width: 600px) {
      .patient-header { flex-direction: column; text-align: center; }
      .contact-card { flex-direction: column; gap: 8px; align-items: stretch; }
      .enc-table { font-size: 12px; }
    }
  </style>
</head>
<body>
  <header class="header-bar">
    <div class="brand-title">
      <span>🛡️ MEDISTRY EMERGENCY TRIAGE</span>
      <span class="badge" style="background:#0f172a; padding:2px 6px; border-radius:4px; font-size:11px;">READ-ONLY</span>
    </div>
    <div class="ttl-pill">
      ⏱️ EXPIRES IN ${grantMeta.remainingMinutes}m
    </div>
  </header>

  <main class="container">
    ${dnrBadge}

    <!-- 1. CRITICAL TRIAGE ESSENTIALS -->
    <section class="triage-grid" aria-label="Triage Essentials">
      <div class="triage-stat-card critical">
        <div class="stat-label">Blood Group & Rh</div>
        <div class="stat-value danger">${escapeHtml(triageEssentials.bloodGroup)}</div>
      </div>
      <div class="triage-stat-card">
        <div class="stat-label">Hemoglobin Genotype</div>
        <div class="stat-value">${escapeHtml(triageEssentials.genotype)}</div>
      </div>
      <div class="triage-stat-card">
        <div class="stat-label">Pregnancy Status</div>
        <div class="stat-value" style="font-size:16px; margin-top:8px;">${escapeHtml(chronicCare.pregnancyStatus || 'N/A')}</div>
      </div>
    </section>

    <!-- 2. PATIENT DEMOGRAPHICS & CONTACTS -->
    <section class="card" aria-label="Patient Identity">
      <div class="patient-header">
        <div class="patient-avatar" aria-hidden="true">
          ${patient.photoUrl ? `<img src="${escapeHtml(patient.photoUrl)}" alt="Patient Photo" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : patient.fullName.charAt(0)}
        </div>
        <div class="patient-info">
          <h1>${escapeHtml(patient.fullName)} ${organDonorBadge}</h1>
          <div class="patient-sub">
            Age: <strong>${patient.age} years</strong> • Sex: <strong>${escapeHtml(patient.gender)}</strong>
          </div>
        </div>
      </div>

      <div class="card-title" style="font-size:14px; margin-top:12px;">Emergency Contacts (Primary Notification Dispatched)</div>
      <div class="contacts-list">
        ${emergencyContactsHtml}
      </div>
    </section>

    <!-- 3. ALLERGIES & ANAPHYLAXIS RISKS (DRUGS FIRST) -->
    <section class="card" aria-label="Allergies">
      <div class="card-title">
        <span>🚨 Allergies & Adverse Reactions</span>
        <span style="font-size:12px; color:#dc2626; font-weight:700;">DRUG ALLERGIES PRIORITIZED</span>
      </div>

      <div style="margin-bottom:12px;">
        <h4 style="font-size:13px; text-transform:uppercase; color:#991b1b; margin-bottom:6px;">Drug / Pharmacological Allergies:</h4>
        ${drugAllergiesHtml}
      </div>

      <div>
        <h4 style="font-size:13px; text-transform:uppercase; color:var(--text-muted); margin-bottom:6px;">Environmental / Food Allergies:</h4>
        ${otherAllergiesHtml}
      </div>
    </section>

    <!-- 4. CHRONIC CARE, MEDICATIONS, IMPLANTS -->
    <section class="card" aria-label="Chronic Conditions and Medications">
      <div class="card-title">Chronic Conditions & Active Regimens</div>

      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px; color:var(--text-muted); margin-bottom:6px;">Diagnosed Chronic Conditions:</h4>
        <div>${conditionsHtml}</div>
      </div>

      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px; color:var(--text-muted); margin-bottom:6px;">Current Medications (Dose & Start):</h4>
        <ul>${medicationsHtml}</ul>
      </div>

      <div>
        <h4 style="font-size:13px; color:var(--text-muted); margin-bottom:4px;">Implants / Medical Devices:</h4>
        <div class="text-muted">${chronicCare.implantsOrDevices?.join(', ') || 'None reported'}</div>
      </div>
    </section>

    <!-- 5. RECENT ENCOUNTERS -->
    <section class="card" aria-label="Recent Encounters">
      <div class="card-title">Recent Encounters (Last 5 Events)</div>
      <div style="overflow-x: auto;">
        <table class="enc-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Diagnosis & Clinician</th>
              <th>Treatment & Result</th>
            </tr>
          </thead>
          <tbody>
            ${encountersHtml}
          </tbody>
        </table>
      </div>
    </section>

    <!-- 6. FULL HISTORY GATE -->
    <section class="card" aria-label="Full History Access Gate">
      <div class="card-title">Full Medical History Record</div>
      ${grantMeta.fullHistoryAccess
        ? `<div style="background:#ecfdf5; border:1px solid #10b981; padding:12px; border-radius:6px;">
             <strong>✅ Full Clinical History Unlocked via Dual Co-Sign</strong>
             <p style="font-size:13px; margin-top:4px;">Co-signing Clinician: Dr. ${escapeHtml(grantMeta.coSignDoctorName || 'Authorized Clinician')}</p>
             <a href="/timeline?grant=${escapeHtml(grantMeta.grantId)}" class="btn" style="background:#047857; color:#fff; margin-top:8px;">Open Complete Multi-Facility Timeline</a>
           </div>`
        : `<div class="full-history-box">
             <p><strong>Emergency access is restricted to minimal critical triage data.</strong></p>
             <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">
               To view comprehensive multi-year clinical encounters, laboratory observations, and diagnostic reports, a verified attending second clinician must co-sign.
             </p>
             <button type="button" class="btn btn-cosign" onclick="alert('Co-signing requires second clinician credentials on this terminal.')">
               ✍️ Request Second Clinician Co-Sign for Full History
             </button>
           </div>`
      }
    </section>

    <footer class="audit-footer">
      <div>Access Grant ID: <code>${escapeHtml(grantMeta.grantId)}</code></div>
      <div>Attending Clinician: Dr. ${escapeHtml(grantMeta.treatingDoctorName)} • Facility: ${escapeHtml(grantMeta.facilityName)}</div>
      <div style="margin-top:4px;">Reason: ${escapeHtml(grantMeta.reason)} • Timestamp: ${escapeHtml(grantMeta.grantedAt)}</div>
      <div style="margin-top:6px; color:#b91c1c; font-weight:700;">All accesses are recorded to the tamper-evident NDPA 2023 audit ledger and alerted to the patient.</div>
    </footer>
  </main>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

