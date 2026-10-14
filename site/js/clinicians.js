/* Clinician console: sign-in, safe lookup, consent request by OTP, records, emergency grants and co-sign. */
(function () {
  const { $, api, esc, fmtDate, Session, setError, showToast, initTabs, bindClinicianLogin, signOut, renderTimeline, renderProfile } = window.Medistry;
  const fail = (err) => {
    showToast('Something went wrong', err.message, 'error');
    if (err.status === 401) renderState();
  };

  function renderState() {
    const session = Session.get();
    $('#cl-signin').hidden = !!session;
    $('#cl-app').hidden = !session;
    if (session) {
      const c = session.clinician;
      $('#cl-name').textContent = c.fullName;
      $('#cl-meta').textContent = `${c.specialty} • ${c.facilityName} • ${c.licenseNumber}`;
      loadTab(activeTab);
    }
  }

  let activeTab = 'lookup';
  const loaders = {
    lookup: loadDemoPatients,
    records: loadMyGrants,
    emergency: loadEmergencyGrants,
  };
  function loadTab(name) { if (loaders[name]) loaders[name]().catch(fail); }
  initTabs($('#cl-app'), 'cl-tab-', (name) => { activeTab = name; if (!$('#cl-app').hidden) loadTab(name); });

  // ---- Lookup + consent request ----
  let demoLoaded = false;
  async function loadDemoPatients() {
    if (demoLoaded) return;
    const { patients } = await api('/api/patients', { auth: false });
    $('#demo-patients').innerHTML = patients.map((p) => `<li><button type="button" data-code="${esc(p.emergencyCode)}">${esc(p.firstName)} ${esc(p.lastName)}<small>${esc(p.emergencyCode)}</small></button></li>`).join('');
    demoLoaded = true;
  }
  $('#demo-patients').addEventListener('click', (e) => {
    const b = e.target.closest('[data-code]');
    if (b) { $('#lk-code').value = b.dataset.code; $('#lk-id').value = ''; $('#lk-dob').value = ''; }
  });

  $('#lookup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#lookup-error');
    setError(err, '');
    $('#lookup-result').hidden = true;
    const code = $('#lk-code').value.trim();
    const patientId = $('#lk-id').value.trim();
    const dob = $('#lk-dob').value;
    if (!code && !(patientId && dob)) return setError(err, 'Enter an emergency code, or a patient ID with date of birth.');
    try {
      const body = code ? { code } : { patientId, dateOfBirth: dob };
      const r = await api('/api/clinician/lookup', { method: 'POST', body });
      if (!r.found) return setError(err, 'No matching patient. Check the details and try again.');
      showLookupResult(r);
    } catch (ex) { fail(ex); }
  });

  function showLookupResult(r) {
    const box = $('#lookup-result');
    const p = r.redactedPreview;
    box.hidden = false;
    box.innerHTML = `
      <h3 class="panel-title">Patient found: ${esc(p.initials)}</h3>
      <p class="panel-sub">Born ${esc(p.birthYear)} • ${esc(p.gender)}. Full details stay hidden until the patient consents.</p>
      ${r.hasActiveConsent
        ? `<p><span class="badge green">Consent active</span></p><div class="panel-actions"><button type="button" class="btn btn-pill-primary" id="open-record"><span>Open record</span></button></div>`
        : `<form id="request-form" class="stack-form">
            <div class="form-group"><label for="rq-reason">Clinical reason</label><textarea id="rq-reason" rows="2" required minlength="5" placeholder="e.g. Referral for cardiology review"></textarea></div>
            <div class="form-group"><label for="rq-duration">Access needed for</label>
              <select id="rq-duration"><option value="ONE_VISIT">One visit (24 hours)</option><option value="SEVEN_DAYS">7 days</option><option value="THIRTY_DAYS">30 days</option></select></div>
            <button type="submit" class="btn btn-pill-primary"><span>Request access</span></button>
          </form>
          <div id="otp-box" hidden>
            <p class="panel-sub">The patient was sent a one-time code and an approval request. Ask them to read the code to you (in this demo, open the <a href="/patients" target="_blank" rel="noopener">patient portal Alerts tab</a>), or wait for them to approve in the app.</p>
            <form id="otp-form" class="stack-form">
              <div class="form-group"><label for="otp-input">One-time code</label><input id="otp-input" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="off" required></div>
              <p class="form-error" id="otp-error" role="alert" hidden></p>
              <button type="submit" class="btn btn-pill-primary"><span>Verify code</span></button>
            </form>
          </div>`}`;

    const openBtn = $('#open-record');
    if (openBtn) openBtn.addEventListener('click', () => openRecord(r.patientId));

    const reqForm = $('#request-form');
    if (reqForm) {
      let requestId = null;
      reqForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const out = await api('/api/clinician/access-requests', {
            method: 'POST',
            body: { patientId: r.patientId, reason: $('#rq-reason').value, durationPreset: $('#rq-duration').value },
          });
          requestId = out.requestId;
          reqForm.hidden = true;
          $('#otp-box').hidden = false;
          showToast('Request sent', 'The patient has been asked to approve.');
        } catch (ex) { fail(ex); }
      });
      $('#otp-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        setError($('#otp-error'), '');
        try {
          await api(`/api/clinician/access-requests/${encodeURIComponent(requestId)}/otp`, { method: 'POST', body: { otp: $('#otp-input').value } });
          showToast('Consent granted', 'You can now read this patient’s record.');
          openRecord(r.patientId);
        } catch (ex) { setError($('#otp-error'), ex.message); }
      });
    }
  }

  // ---- Records ----
  async function loadMyGrants() {
    const { grants } = await api('/api/clinician/consents');
    $('#my-grants').innerHTML = grants.length ? grants.map((g) => `
      <div class="list-card">
        <div><div class="lc-title">${esc(g.patientInitials)} <span class="badge ${g.status === 'ACTIVE' ? 'green' : 'grey'}">${esc(g.status.toLowerCase())}</span></div>
        <div class="lc-meta">Consent valid until ${esc(fmtDate(g.validUntil, true))}</div></div>
        <div class="lc-actions">${g.status === 'ACTIVE' ? `<button type="button" class="btn btn-pill-primary btn-small" data-open="${esc(g.patientId)}">Open record</button>` : ''}</div>
      </div>`).join('') : '<p class="empty-note">No patient has consented yet. Use Patient lookup to request access.</p>';
  }
  $('#my-grants').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openRecord(b.dataset.open);
  });

  async function openRecord(patientId) {
    try {
      const { patient, timeline } = await api(`/api/clinician/patients/${encodeURIComponent(patientId)}/record`);
      document.querySelector('[data-tab="records"]').click();
      $('#record-view').hidden = false;
      $('#record-title').textContent = `${patient.firstName} ${patient.lastName}`;
      renderProfile($('#record-profile'), patient);
      renderTimeline($('#record-timeline'), timeline);
      $('#record-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) { fail(ex); }
  }
  $('#record-close').addEventListener('click', () => { $('#record-view').hidden = true; });

  // ---- Emergency grants + co-sign ----
  async function loadEmergencyGrants() {
    const { grants } = await api('/api/clinician/emergency-grants');
    $('#em-grants').innerHTML = grants.length ? grants.map((g) => `
      <div class="list-card">
        <div>
          <div class="lc-title">Code ${esc(g.patientCode)} <span class="badge ${g.fullHistoryAccess ? 'green' : 'amber'}">${g.fullHistoryAccess ? 'full history unlocked' : 'summary only'}</span></div>
          <div class="lc-meta">${esc(g.reason)} • expires ${esc(fmtDate(g.expiresAt, true))}${g.coSignDoctorName ? ` • co-signed by ${esc(g.coSignDoctorName)}` : ''}</div>
          <div class="lc-meta">Session ID: <code>${esc(g.id)}</code></div>
        </div>
        <div class="lc-actions">
          <a class="btn btn-secondary-pill btn-small" href="${esc(g.summaryUrl)}" target="_blank" rel="noopener">Summary</a>
          ${g.fullHistoryAccess ? `<button type="button" class="btn btn-pill-primary btn-small" data-fh="${esc(g.id)}">Full history</button>` : ''}
        </div>
      </div>`).join('') : '<p class="empty-note">No active break-glass sessions.</p>';
  }
  $('#em-grants').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fh]');
    if (b) showFullHistory(b.dataset.fh);
  });

  async function showFullHistory(grantId) {
    try {
      const { patient, timeline } = await api(`/api/emergency/grants/${encodeURIComponent(grantId)}/full-history`);
      $('#fh-view').hidden = false;
      $('#fh-title').textContent = `Full history: ${patient.firstName} ${patient.lastName}`;
      renderTimeline($('#fh-timeline'), timeline);
      $('#fh-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) { fail(ex); }
  }
  $('#fh-close').addEventListener('click', () => { $('#fh-view').hidden = true; });

  $('#cosign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#cs-error');
    setError(err, '');
    const grantId = $('#cs-grant').value.trim();
    try {
      await api('/api/clinician/cosign', { method: 'POST', body: { grantId, reason: $('#cs-reason').value } });
      showToast('Co-signed', 'Full history is now unlocked for the treating clinician.');
      $('#cosign-form').reset();
      showFullHistory(grantId);
    } catch (ex) { setError(err, ex.message); }
  });

  $('#cl-logout').addEventListener('click', async () => { await signOut(); renderState(); });

  bindClinicianLogin({
    form: '#cl-login-form', select: '#cl-clinician', totp: '#cl-totp',
    error: '#cl-login-error', showCode: '#cl-show-code', onSignedIn: renderState,
  });
  renderState();
})();
