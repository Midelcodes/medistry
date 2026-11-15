/* Patient portal: demo patient picker (or phone sign-in outside demo mode), timeline, access log, consent, emergency kit, alerts. */
(function () {
  const { $, api, esc, fmtDate, showToast, setError, initTabs, renderTimeline, renderProfile } = window.Medistry;
  const STORE_KEY = 'medistry.patient';
  const TOKEN_KEY = 'medistry.patientToken';
  let patientToken = null; // patient or proxy session (DEMO_MODE=0); tab-scoped, never in localStorage
  try { patientToken = sessionStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  let patientId = null;
  let profile = null;
  let activeTab = 'overview';

  const tab = (name) => $(`#tab-${name}`);
  const base = () => `/api/patients/${encodeURIComponent(patientId)}`;

  function remembered() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } }
  function remember(id) { try { localStorage.setItem(STORE_KEY, id); } catch { /* ignore */ } }
  const fail = (err) => showToast('Something went wrong', err.message, 'error');

  async function loadChain() {
    const chip = $('#chain-chip');
    try {
      const v = await api('/api/audit/verify', { auth: false });
      chip.textContent = v.valid ? `Audit chain verified (${v.entries} entries)` : 'Audit chain FAILED verification';
      chip.className = `chain-chip ${v.valid ? 'ok' : 'bad'}`;
    } catch {
      chip.textContent = 'Audit chain unavailable';
    }
  }

  // ---- Overview ----
  async function loadOverview() {
    const { patient } = await api(base(), { auth: false, token: patientToken });
    profile = patient;
    const el = tab('overview');
    el.innerHTML = '<div id="ov-profile"></div>';
    renderProfile($('#ov-profile'), patient);
  }

  // ---- Timeline ----
  async function loadTimeline() {
    const type = $('#tl-type').value;
    const facility = $('#tl-facility').value;
    const qs = new URLSearchParams();
    if (type) qs.set('resourceType', type);
    if (facility) qs.set('facilityId', facility);
    const { timeline } = await api(`${base()}/timeline?${qs}`, { auth: false, token: patientToken });
    if (!facility) {
      const seen = new Map(timeline.map((t) => [t.facilityId, t.facilityName]));
      const select = $('#tl-facility');
      if (select.options.length <= 1) {
        seen.forEach((name, id) => select.add(new Option(name, id)));
      }
    }
    renderTimeline($('#timeline-list'), timeline, { flaggable: true });
  }

  // ---- Access log ----
  async function loadAccess() {
    const { logs } = await api(`${base()}/access-log`, { auth: false, token: patientToken });
    const body = $('#access-table tbody');
    if (!logs.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-note">No access events yet.</td></tr>';
      return;
    }
    body.innerHTML = logs.map((l) => `<tr class="${l.isEmergency ? 'emergency' : ''}">
      <td>${esc(l.formattedDate)}</td>
      <td>${esc(l.actorName)}</td>
      <td>${esc(l.facilityName)}</td>
      <td><span class="badge ${l.isEmergency ? 'red' : 'grey'}">${esc(l.accessTypeLabel)}</span></td>
      <td>${esc(l.actionDescription)}${l.reason ? `<div class="lc-meta">${esc(l.reason)}</div>` : ''}</td>
      <td>${l.isDisputed ? '<span class="badge amber">Disputed</span>' : `<button type="button" class="btn-text-link" data-dispute="${esc(l.auditId)}">Dispute</button>`}</td>
    </tr>`).join('');
  }

  $('#access-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-dispute]');
    if (!btn) return;
    const reason = window.prompt('Why do you want to dispute this access? (at least 5 characters)');
    if (!reason) return;
    try {
      await api(`${base()}/disputes`, { method: 'POST', auth: false, token: patientToken, body: { auditLogId: btn.dataset.dispute, reason } });
      showToast('Dispute filed', 'Medistry will review this access event.');
      loadAccess();
    } catch (err) { fail(err); }
  });

  // ---- Consent ----
  async function loadConsent() {
    const { pending, grants } = await api(`${base()}/consents`, { auth: false, token: patientToken });
    const count = $('#consent-count');
    count.hidden = pending.length === 0;
    count.textContent = pending.length;

    $('#pending-list').innerHTML = pending.length ? pending.map((r) => `
      <div class="list-card">
        <div>
          <div class="lc-title">${esc(r.requestingClinicianName)} — ${esc(r.requestingFacilityName)}</div>
          <div class="lc-meta">Reason: ${esc(r.clinicalReason)} &bull; asks for ${esc(r.durationHours)}h &bull; ${esc(fmtDate(r.createdAt, true))}</div>
        </div>
        <div class="lc-actions">
          <button type="button" class="btn btn-pill-primary btn-small" data-approve="${esc(r.id)}">Approve</button>
          <button type="button" class="btn btn-secondary-pill btn-small" data-reject="${esc(r.id)}">Reject</button>
        </div>
      </div>`).join('') : '<p class="empty-note">No pending requests. A clinician asking for access will appear here.</p>';

    $('#grants-list').innerHTML = grants.length ? grants.map((g) => `
      <div class="list-card">
        <div>
          <div class="lc-title">${esc(g.clinicianName)} — ${esc(g.facilityName)}
            <span class="badge ${g.status === 'ACTIVE' ? 'green' : 'grey'}">${esc(g.status.toLowerCase())}</span></div>
          <div class="lc-meta">${esc(g.reason)} &bull; until ${esc(fmtDate(g.validUntil, true))}</div>
        </div>
        <div class="lc-actions">${g.status === 'ACTIVE' ? `<button type="button" class="btn-danger btn-small" data-revoke="${esc(g.id)}">Revoke now</button>` : ''}</div>
      </div>`).join('') : '<p class="empty-note">You have not granted anyone access yet.</p>';
  }

  tab('consent').addEventListener('click', async (e) => {
    const approve = e.target.closest('[data-approve]');
    const reject = e.target.closest('[data-reject]');
    const revoke = e.target.closest('[data-revoke]');
    try {
      if (approve) {
        await api(`${base()}/consents/requests/${encodeURIComponent(approve.dataset.approve)}/approve`, { method: 'POST', auth: false, token: patientToken, body: {} });
        showToast('Access approved', 'The clinician can now read your record until the grant expires.');
      } else if (reject) {
        await api(`${base()}/consents/requests/${encodeURIComponent(reject.dataset.reject)}/reject`, { method: 'POST', auth: false, token: patientToken, body: {} });
        showToast('Request rejected', 'The clinician was not given access.');
      } else if (revoke) {
        if (!window.confirm('Revoke this clinician’s access right now?')) return;
        await api(`${base()}/consents/grants/${encodeURIComponent(revoke.dataset.revoke)}/revoke`, { method: 'POST', auth: false, token: patientToken, body: {} });
        showToast('Access revoked', 'This clinician can no longer read your record.');
      } else return;
      loadConsent();
    } catch (err) { fail(err); }
  });

  // ---- Emergency kit ----
  async function loadKit() {
    const { patient } = await api(base(), { auth: false, token: patientToken });
    profile = patient;
    $('#kit-code').textContent = patient.emergencyCode || 'No active code';
    const q = `patientId=${encodeURIComponent(patient.id)}&v=${Date.now()}`;
    $('#kit-wallet').src = `/emergency/wallet-card?${q}`;
    $('#kit-wrist').src = `/emergency/wristband?${q}`;
    $('#kit-offline').href = `/emergency/offline-card?patientId=${encodeURIComponent(patient.id)}`;
    $('#kit-public').checked = !!patient.publicEmergencyOptIn;
    renderCardOptions(patient);
    await loadCard(false);
  }

  // ---- My emergency card (offline, signed QR) ----
  function renderCardOptions(patient) {
    const sel = patient.card || { conditions: [], medicationIds: [], includeRecentDiagnosis: false };
    const box = (name, value, checked, label) =>
      `<label class="check-row"><input type="checkbox" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}> <span>${esc(label)}</span></label>`;
    $('#card-opt-conds').innerHTML = patient.chronicConditions.length
      ? patient.chronicConditions.map((c) => box('card-cond', c, sel.conditions.includes(c), c)).join('')
      : '<p class="empty-note">No conditions on your record.</p>';
    $('#card-opt-meds').innerHTML = patient.activeMedications.length
      ? patient.activeMedications.map((m) => box('card-med', m.id, sel.medicationIds.includes(m.id), `${m.medicationName} (${m.dose})`)).join('')
      : '<p class="empty-note">No medicines on your record.</p>';
    $('#card-opt-dx').checked = !!sel.includeRecentDiagnosis;
    $('#card-lang').value = patient.preferredLocale === 'sw' ? 'sw' : 'en';
    $('#card-dirty').hidden = true;
  }

  function showCard(card) {
    $('#card-needs-reissue').hidden = true;
    $('#card-stale').hidden = !card.stale;
    $('#card-lost').hidden = false;
    $('#card-preview').srcdoc = card.cardHtml;
    $('#card-download').href = card.qrPngDataUrl;
    $('#card-meta').textContent = `Card version ${card.cardVersion} · issued ${fmtDate(card.issuedAt)} · expires ${fmtDate(card.expiresAt)}`;
    const warn = $('#card-warnings');
    warn.innerHTML = (card.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    warn.hidden = !(card.warnings || []).length;
  }

  async function loadCard(reissue) {
    let card;
    try {
      card = await api(`${base()}/offline-card`, { method: reissue ? 'POST' : 'GET', auth: false, token: patientToken, ...(reissue ? { body: {} } : {}) });
    } catch (err) {
      if (err.status !== 409) throw err;
      // Revoked or expired: nothing to preview until the patient reissues.
      $('#card-preview').srcdoc = '';
      $('#card-download').removeAttribute('href');
      $('#card-meta').textContent = '';
      $('#card-stale').hidden = true;
      $('#card-lost').hidden = true;
      $('#card-needs-reissue').textContent = err.message;
      $('#card-needs-reissue').hidden = false;
      return null;
    }
    showCard(card);
    return card;
  }

  async function saveCardChoices() {
    const checked = (name) => Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((i) => i.value);
    try {
      await api(`${base()}/settings`, {
        method: 'PATCH',
        auth: false, token: patientToken,
        body: { cardConditions: checked('card-cond'), cardMedicationIds: checked('card-med'), cardIncludeRecentDiagnosis: $('#card-opt-dx').checked },
      });
      $('#card-dirty').hidden = false;
    } catch (err) { fail(err); loadKit().catch(fail); }
  }

  $('#my-card').addEventListener('change', (e) => {
    if (e.target.matches('input[name="card-cond"], input[name="card-med"], #card-opt-dx')) saveCardChoices();
  });

  $('#card-lang').addEventListener('change', async (e) => {
    try {
      await api(`${base()}/settings`, { method: 'PATCH', auth: false, token: patientToken, body: { preferredLocale: e.target.value } });
      await loadCard(false); // same card and QR, printed text in the new language
    } catch (err) { fail(err); }
  });

  $('#card-print').addEventListener('click', () => {
    const frame = $('#card-preview');
    if (frame.contentWindow) frame.contentWindow.print();
  });

  $('#card-lost').addEventListener('click', async () => {
    const reason = window.prompt('Report your emergency card lost or stolen? It will stop being trusted once scanners sync. Reason (for example "lost"):', 'lost');
    if (!reason) return;
    try {
      await api(`${base()}/offline-card/revoke`, { method: 'POST', auth: false, token: patientToken, body: { reason } });
      showToast('Card revoked', 'Reissue your card to print a new one.');
      await loadCard(false);
    } catch (err) { fail(err); }
  });

  $('#timeline-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-flag]');
    if (!btn) return;
    const note = window.prompt('What looks wrong in this record? (at least 5 characters) The record is not changed; the clinician who signed it is told.');
    if (!note) return;
    try {
      await api(`${base()}/records/${encodeURIComponent(btn.dataset.flag)}/flag`, { method: 'POST', auth: false, token: patientToken, body: { note } });
      showToast('Flag sent', 'The clinician who signed this record has been told.');
    } catch (err) { fail(err); }
  });

  $('#card-reissue').addEventListener('click', async () => {
    if (!window.confirm('Reissue your emergency card? The new card replaces the old one, so print the new card.')) return;
    try {
      const card = await loadCard(true);
      $('#card-dirty').hidden = true;
      showToast('New card issued', `Card version ${card.cardVersion} replaces the old one. Print it now.`);
    } catch (err) { fail(err); }
  });

  $('#kit-reissue').addEventListener('click', async () => {
    if (!window.confirm('Reissue your emergency code? Your current card and wristband will stop working.')) return;
    try {
      await api(`${base()}/emergency-code/reissue`, { method: 'POST', auth: false, token: patientToken, body: {} });
      showToast('New code issued', 'Print a new card. The old code no longer works.');
      loadKit();
    } catch (err) { fail(err); }
  });

  $('#kit-public').addEventListener('change', async (e) => {
    try {
      await api(`${base()}/settings`, { method: 'PATCH', auth: false, token: patientToken, body: { publicEmergencyOptIn: e.target.checked } });
      showToast('Saved', e.target.checked ? 'Anyone who scans your code now sees a minimal public badge.' : 'Your code now shows nothing without a clinician sign-in.');
    } catch (err) { e.target.checked = !e.target.checked; fail(err); }
  });

  // ---- Alerts ----
  async function loadAlerts() {
    const { notifications } = await api(`${base()}/notifications`, { auth: false, token: patientToken });
    $('#alerts-list').innerHTML = notifications.length ? notifications.map((n) => `
      <div class="list-card"><div>
        <div class="lc-title">${esc(n.channel)}</div>
        <div class="lc-meta">To: ${esc(n.to)}</div>
        <div>${esc(n.message)}</div>
      </div></div>`).join('') : '<p class="empty-note">No alerts yet. They appear when a clinician requests access or opens an emergency session.</p>';
  }

  // ---- Wiring ----
  const loaders = { overview: loadOverview, timeline: loadTimeline, access: loadAccess, consent: loadConsent, kit: loadKit, alerts: loadAlerts };
  function load(name) { return loaders[name]().catch(fail); }
  const select = initTabs($('#portal'), 'tab-', (name) => { activeTab = name; load(name); });

  async function setPatient(id) {
    patientId = id;
    remember(id);
    $('#portal').hidden = false;
    const fac = $('#tl-facility');
    while (fac.options.length > 1) fac.remove(1);
    $('#tl-type').value = '';
    select(activeTab);
    api(`${base()}/consents`, { auth: false, token: patientToken }).then(({ pending }) => {
      const c = $('#consent-count'); c.hidden = pending.length === 0; c.textContent = pending.length;
    }).catch(() => {});
  }

  $('#tl-type').addEventListener('change', () => load('timeline'));
  $('#tl-facility').addEventListener('change', () => load('timeline'));
  $('#patient-picker').addEventListener('change', (e) => setPatient(e.target.value));

  // ---- Phone sign-in (outside demo mode there is no patient picker) ----
  async function loadSignedIn() {
    const { records } = await api('/api/auth/patient/me', { auth: false, token: patientToken });
    $('#patient-signin').hidden = true;
    $('#ps-signout').hidden = false;
    const picker = $('#patient-picker');
    picker.innerHTML = records.map((r) => `<option value="${esc(r.patientId)}">${esc(r.name || r.patientId)}${r.as === 'self' ? '' : ` (as ${esc(r.as)})`}</option>`).join('');
    if (!records.length) { showToast('No records yet', 'Ask your clinic to link your phone number to your record, or accept a proxy invitation.'); return; }
    const saved = remembered();
    if (saved && records.some((r) => r.patientId === saved)) picker.value = saved;
    setPatient(picker.value);
  }

  function showSignIn() {
    $('#demo-banner').hidden = true;
    $('#patient-signin').hidden = false;
    const err = $('#ps-error');
    $('#ps-phone-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      setError(err, '');
      try {
        await api('/api/auth/patient/otp/request', { method: 'POST', auth: false, body: { phone: $('#ps-phone').value.trim() } });
        $('#ps-code-form').hidden = false;
        $('#ps-code').focus();
      } catch (ex) { setError(err, ex.message); }
    });
    $('#ps-code-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      setError(err, '');
      try {
        const data = await api('/api/auth/patient/otp/verify', { method: 'POST', auth: false, body: { phone: $('#ps-phone').value.trim(), otp: $('#ps-code').value.trim() } });
        patientToken = data.token;
        try { sessionStorage.setItem(TOKEN_KEY, patientToken); } catch { /* storage blocked */ }
        $('#ps-code').value = '';
        await loadSignedIn();
      } catch (ex) { setError(err, ex.message); }
    });
  }

  $('#ps-signout').addEventListener('click', async () => {
    try { await api('/api/auth/patient/logout', { method: 'POST', auth: false, token: patientToken, body: {} }); } catch { /* already gone */ }
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
    location.reload();
  });

  async function init() {
    loadChain();
    try {
      let patients;
      try {
        ({ patients } = await api('/api/patients', { auth: false }));
      } catch (err) {
        if (err.status !== 404) throw err;
        // DEMO_MODE=0: no synthetic directory; sign in with a phone number.
        if (patientToken) {
          try { await loadSignedIn(); return; } catch { patientToken = null; }
        }
        showSignIn();
        return;
      }
      const picker = $('#patient-picker');
      picker.innerHTML = patients.map((p) => `<option value="${esc(p.id)}">${esc(p.firstName)} ${esc(p.lastName)} — ${esc(p.bloodGroup)}, ${esc(p.genotype)}</option>`).join('');
      const saved = remembered();
      if (saved && patients.some((p) => p.id === saved)) picker.value = saved;
      setPatient(picker.value);
    } catch (err) { fail(err); }
  }
  init();
})();
