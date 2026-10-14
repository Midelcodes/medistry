/* Patient portal: demo patient picker, timeline, access log, consent, emergency kit, alerts. */
(function () {
  const { $, api, esc, fmtDate, showToast, initTabs, renderTimeline, renderProfile } = window.Medistry;
  const STORE_KEY = 'medistry.patient';
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
    const { patient } = await api(base(), { auth: false });
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
    const { timeline } = await api(`${base()}/timeline?${qs}`, { auth: false });
    if (!facility) {
      const seen = new Map(timeline.map((t) => [t.facilityId, t.facilityName]));
      const select = $('#tl-facility');
      if (select.options.length <= 1) {
        seen.forEach((name, id) => select.add(new Option(name, id)));
      }
    }
    renderTimeline($('#timeline-list'), timeline);
  }

  // ---- Access log ----
  async function loadAccess() {
    const { logs } = await api(`${base()}/access-log`, { auth: false });
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
      await api(`${base()}/disputes`, { method: 'POST', auth: false, body: { auditLogId: btn.dataset.dispute, reason } });
      showToast('Dispute filed', 'Medistry will review this access event.');
      loadAccess();
    } catch (err) { fail(err); }
  });

  // ---- Consent ----
  async function loadConsent() {
    const { pending, grants } = await api(`${base()}/consents`, { auth: false });
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
        await api(`${base()}/consents/requests/${encodeURIComponent(approve.dataset.approve)}/approve`, { method: 'POST', auth: false, body: {} });
        showToast('Access approved', 'The clinician can now read your record until the grant expires.');
      } else if (reject) {
        await api(`${base()}/consents/requests/${encodeURIComponent(reject.dataset.reject)}/reject`, { method: 'POST', auth: false, body: {} });
        showToast('Request rejected', 'The clinician was not given access.');
      } else if (revoke) {
        if (!window.confirm('Revoke this clinician’s access right now?')) return;
        await api(`${base()}/consents/grants/${encodeURIComponent(revoke.dataset.revoke)}/revoke`, { method: 'POST', auth: false, body: {} });
        showToast('Access revoked', 'This clinician can no longer read your record.');
      } else return;
      loadConsent();
    } catch (err) { fail(err); }
  });

  // ---- Emergency kit ----
  async function loadKit() {
    const { patient } = await api(base(), { auth: false });
    profile = patient;
    $('#kit-code').textContent = patient.emergencyCode || 'No active code';
    const q = `patientId=${encodeURIComponent(patient.id)}&v=${Date.now()}`;
    $('#kit-wallet').src = `/emergency/wallet-card?${q}`;
    $('#kit-wrist').src = `/emergency/wristband?${q}`;
    $('#kit-offline').href = `/emergency/offline-card?patientId=${encodeURIComponent(patient.id)}`;
    $('#kit-public').checked = !!patient.publicEmergencyOptIn;
  }

  $('#kit-reissue').addEventListener('click', async () => {
    if (!window.confirm('Reissue your emergency code? Your current card and wristband will stop working.')) return;
    try {
      await api(`${base()}/emergency-code/reissue`, { method: 'POST', auth: false, body: {} });
      showToast('New code issued', 'Print a new card. The old code no longer works.');
      loadKit();
    } catch (err) { fail(err); }
  });

  $('#kit-public').addEventListener('change', async (e) => {
    try {
      await api(`${base()}/settings`, { method: 'PATCH', auth: false, body: { publicEmergencyOptIn: e.target.checked } });
      showToast('Saved', e.target.checked ? 'Anyone who scans your code now sees a minimal public badge.' : 'Your code now shows nothing without a clinician sign-in.');
    } catch (err) { e.target.checked = !e.target.checked; fail(err); }
  });

  // ---- Alerts ----
  async function loadAlerts() {
    const { notifications } = await api(`${base()}/notifications`, { auth: false });
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
    api(`${base()}/consents`, { auth: false }).then(({ pending }) => {
      const c = $('#consent-count'); c.hidden = pending.length === 0; c.textContent = pending.length;
    }).catch(() => {});
  }

  $('#tl-type').addEventListener('change', () => load('timeline'));
  $('#tl-facility').addEventListener('change', () => load('timeline'));
  $('#patient-picker').addEventListener('change', (e) => setPatient(e.target.value));

  async function init() {
    loadChain();
    try {
      const { patients } = await api('/api/patients', { auth: false });
      const picker = $('#patient-picker');
      picker.innerHTML = patients.map((p) => `<option value="${esc(p.id)}">${esc(p.firstName)} ${esc(p.lastName)} — ${esc(p.bloodGroup)}, ${esc(p.genotype)}</option>`).join('');
      const saved = remembered();
      if (saved && patients.some((p) => p.id === saved)) picker.value = saved;
      setPatient(picker.value);
    } catch (err) { fail(err); }
  }
  init();
})();
