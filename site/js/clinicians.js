/* Clinician console: sign-in, safe lookup, consent request by OTP, records, emergency grants, co-sign, and AI intake review. */
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
    form: '#cl-login-form', select: '#cl-clinician', totp: '#cl-totp', password: '#cl-password',
    error: '#cl-login-error', showCode: '#cl-show-code', onSignedIn: renderState,
  });
  renderState();

  // ---- Intake from paper or voice (AI drafts; the doctor reviews, edits and signs) ----
  let intake = null;      // current review payload
  let recorder = null;
  let voiceBlob = null;
  const inErr = () => $('#in-error');

  async function loadIntake() {
    const { grants } = await api('/api/clinician/consents');
    const active = grants.filter((g) => g.status === 'ACTIVE');
    $('#in-patient').innerHTML = active.length
      ? active.map((g) => `<option value="${esc(g.patientId)}">${esc(g.patientInitials)}</option>`).join('')
      : '<option value="">No patient has consented yet</option>';
  }
  loaders.intake = loadIntake;

  document.querySelectorAll('input[name="in-kind"]').forEach((r) => r.addEventListener('change', () => {
    const kind = document.querySelector('input[name="in-kind"]:checked').value;
    $('#in-text-group').hidden = kind !== 'text';
    $('#in-photo-group').hidden = kind !== 'photo';
    $('#in-voice-group').hidden = kind !== 'voice';
  }));

  $('#in-rec').addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        $('#in-rec').querySelector('span').textContent = 'Record again';
        $('#in-rec-status').textContent = `Recorded (${Math.round(voiceBlob.size / 1024)} KB)`;
      };
      recorder.start();
      $('#in-rec').querySelector('span').textContent = 'Stop recording';
      $('#in-rec-status').textContent = 'Recording…';
    } catch (ex) { setError(inErr(), 'The microphone is not available. Paste the text instead.'); }
  });

  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(blob);
  });

  $('#intake-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError(inErr(), '');
    const btn = $('button[type="submit"]', e.target);
    btn.disabled = true;
    try {
      const kind = document.querySelector('input[name="in-kind"]:checked').value;
      const body = { patientId: $('#in-patient').value, kind };
      if (kind === 'text') body.text = $('#in-text').value;
      if (kind === 'photo') {
        const f = $('#in-photo').files[0];
        if (!f) throw new Error('Choose or take a photo first');
        body.file = { filename: f.name, mimeType: f.type, contentBase64: await toBase64(f) };
      }
      if (kind === 'voice') {
        if (!voiceBlob) throw new Error('Record a voice note first');
        body.file = { filename: 'voice-note', mimeType: voiceBlob.type, contentBase64: await toBase64(voiceBlob) };
      }
      showReview(await api('/api/clinician/intake', { method: 'POST', body }));
    } catch (ex) { setError(inErr(), ex.message); } finally { btn.disabled = false; }
  });

  /** Source text with every proposed span highlighted (escaped; spans come from the server). */
  function renderSource(text, proposals) {
    const spans = [];
    for (const p of proposals) for (const f of p.fields) if (f.span) spans.push({ ...f.span, id: `${p.key}:${f.path}` });
    spans.sort((a, b) => a.start - b.start);
    let html = '';
    let at = 0;
    for (const s of spans) {
      if (s.start < at) continue; // overlapping spans: the first one wins
      html += esc(text.slice(at, s.start)) + `<mark data-span="${esc(s.id)}">${esc(text.slice(s.start, s.end))}</mark>`;
      at = s.end;
    }
    $('#in-source').innerHTML = html + esc(text.slice(at));
  }

  function showReview(v) {
    intake = v;
    $('#intake-start').hidden = true;
    $('#intake-review').hidden = false;
    const drafts = v.proposals.filter((p) => p.state === 'draft').length;
    $('#in-meta').textContent = `Proposed by ${v.adapters.llm}${v.adapters.ocr ? `, OCR ${v.adapters.ocr}` : ''}${v.adapters.stt ? `, speech-to-text ${v.adapters.stt}` : ''}. ${drafts} draft(s) to review, ${v.lowConfidenceFields} value(s) flagged.`;
    $('#in-sign-all').disabled = drafts === 0;
    renderSource(v.sourceText, v.proposals);
    $('#in-proposals').innerHTML = v.proposals.length ? v.proposals.map((p) => `
      <div class="list-card intake-card" data-key="${esc(p.key)}">
        <div style="flex:1">
          <div class="lc-title">${esc(p.resourceType)} <span class="badge ${p.state === 'signed' ? 'green' : p.state === 'discarded' ? 'grey' : 'amber'}">${esc(p.state)}</span></div>
          ${p.fields.map((f) => `
            <div class="intake-field${f.lowConfidence ? ' low' : ''}">
              <label for="f-${esc(p.key)}-${esc(f.path)}">${esc(f.path)}${f.lowConfidence ? ' <span class="badge amber">check</span>' : ''}${f.edited ? ' <span class="badge">edited</span>' : ''}</label>
              <input id="f-${esc(p.key)}-${esc(f.path)}" data-path="${esc(f.path)}" data-span="${esc(`${p.key}:${f.path}`)}" value="${esc(f.value)}" ${p.state === 'draft' ? '' : 'disabled'}>
              <span class="intake-from">${f.span ? `From: “${esc(f.span.text)}”` : 'Not found in the source text'}</span>
            </div>`).join('')}
        </div>
        ${p.state === 'draft' ? `<div class="lc-actions">
          <button type="button" class="btn btn-secondary-pill btn-small" data-save="${esc(p.recordId)}">Save edits</button>
          <button type="button" class="btn-text-link" data-discard="${esc(p.recordId)}">Discard</button>
        </div>` : ''}
      </div>`).join('') : '<p class="empty-note">Nothing was recognised in this note. Labelled lines such as "Diagnosis: …" work best.</p>';
  }

  $('#in-proposals').addEventListener('focusin', (e) => {
    const id = e.target.dataset && e.target.dataset.span;
    document.querySelectorAll('#in-source mark').forEach((m) => m.classList.toggle('active', m.dataset.span === id));
  });
  $('#in-proposals').addEventListener('click', async (e) => {
    const save = e.target.closest('[data-save]');
    const discard = e.target.closest('[data-discard]');
    try {
      if (save) {
        const card = save.closest('.intake-card');
        const fields = {};
        card.querySelectorAll('input[data-path]').forEach((i) => { fields[i.dataset.path] = i.value; });
        showReview(await api(`/api/clinician/intake/${encodeURIComponent(intake.intakeId)}/drafts/${encodeURIComponent(save.dataset.save)}`, { method: 'POST', body: { fields } }));
        showToast('Draft updated', 'Your edit is saved as a new draft version.');
      }
      if (discard) {
        showReview(await api(`/api/clinician/intake/${encodeURIComponent(intake.intakeId)}/drafts/${encodeURIComponent(discard.dataset.discard)}/discard`, { method: 'POST', body: { reason: 'Discarded at review' } }));
      }
    } catch (ex) { fail(ex); }
  });
  $('#in-sign-all').addEventListener('click', async () => {
    try {
      showReview(await api(`/api/clinician/intake/${encodeURIComponent(intake.intakeId)}/sign`, { method: 'POST', body: {} }));
      showToast('Signed', 'The drafts are now part of the patient record.');
    } catch (ex) { fail(ex); }
  });
  $('#in-close').addEventListener('click', () => {
    intake = null;
    voiceBlob = null;
    $('#intake-review').hidden = true;
    $('#intake-start').hidden = false;
    $('#in-text').value = '';
  });
})();
