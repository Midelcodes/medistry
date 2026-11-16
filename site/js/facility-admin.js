/* Facility admin portal: invitation acceptance, sign-in, staff, integrations, usage (aggregates only) and billing. */
(function () {
  const { $, api, esc, fmtDate, showToast, setError, initTabs } = window.Medistry;
  const TOKEN_KEY = 'medistry.adminToken';
  let token = null;
  let me = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  const call = (path, options = {}) => api(path, { ...options, auth: false, token });
  const fail = (err) => { showToast('Something went wrong', err.message, 'error'); if (err.status === 401) signOutLocal(); };
  const setToken = (t) => { token = t; try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };
  const toBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });

  function show(section) {
    for (const id of ['fa-invite', 'fa-signin', 'fa-register', 'fa-app']) $(`#${id}`).hidden = id !== section;
  }
  function signOutLocal() { setToken(null); me = null; show('fa-signin'); }

  // ---- Invitation ----
  const inviteToken = (location.hash.match(/invite=([A-Za-z0-9_-]+)/) || [])[1];
  $('#fa-invite-send').addEventListener('click', async () => {
    setError($('#fa-invite-error'), '');
    try {
      const r = await api('/api/facilities/invites/accept', { method: 'POST', auth: false, body: { token: inviteToken } });
      $('#fa-invite-sub').textContent = `We sent a code to ${r.phone}.`;
      $('#fa-invite-form').hidden = false;
    } catch (ex) { setError($('#fa-invite-error'), ex.message); }
  });
  $('#fa-invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError($('#fa-invite-error'), '');
    try {
      const r = await api('/api/facilities/invites/verify', { method: 'POST', auth: false, body: { token: inviteToken, otp: $('#fa-invite-code').value.trim() } });
      setToken(r.token);
      history.replaceState(null, '', location.pathname);
      $('#fa-invite-form').hidden = true;
      $('#fa-invite-send').hidden = true;
      if (r.account.needsCredentials) $('#fa-cred-form').hidden = false;
      else await enter();
    } catch (ex) { setError($('#fa-invite-error'), ex.message); }
  });
  $('#fa-cred-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError($('#fa-invite-error'), '');
    try {
      const r = await call('/api/admin/credentials', { method: 'POST', body: { password: $('#fa-cred-password').value } });
      $('#fa-cred-password').value = '';
      $('#fa-cred-form').hidden = true;
      $('#fa-cred-qr').innerHTML = r.totpEnrolment.qrSvg; // server-generated SVG (no user text)
      $('#fa-cred-done').hidden = false;
    } catch (ex) { setError($('#fa-invite-error'), ex.message); }
  });
  $('#fa-cred-continue').addEventListener('click', () => enter().catch(fail));

  // ---- Sign-in ----
  $('#fa-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError($('#fa-login-error'), '');
    const id = $('#fa-login-id').value.trim();
    try {
      const body = { totp: $('#fa-login-totp').value.trim(), ...(id.includes('@') ? { email: id } : { adminId: id }) };
      if ($('#fa-login-password').value) body.password = $('#fa-login-password').value;
      const r = await api('/api/admin/login', { method: 'POST', auth: false, body });
      setToken(r.token);
      $('#fa-login-password').value = '';
      $('#fa-login-totp').value = '';
      await enter();
    } catch (ex) { setError($('#fa-login-error'), ex.message); }
  });
  $('#fa-demo-code').addEventListener('click', async () => {
    try {
      const { code } = await api(`/api/demo/totp/${encodeURIComponent($('#fa-login-id').value.trim())}`, { auth: false });
      $('#fa-login-totp').value = code;
    } catch (ex) { setError($('#fa-login-error'), 'No demo code for this account.'); }
  });
  $('#fa-logout').addEventListener('click', async () => {
    try { await call('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* gone */ }
    signOutLocal();
  });

  // ---- Facility application ----
  $('#fa-show-register').addEventListener('click', (e) => { e.preventDefault(); show('fa-register'); });
  $('#fa-register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError($('#fr-error'), '');
    try {
      const f = $('#fr-doc').files[0];
      if (!f) throw new Error('Attach the accreditation document');
      const r = await api('/api/facilities/register', { method: 'POST', auth: false, body: {
        name: $('#fr-name').value, type: $('#fr-type').value, countryCode: $('#fr-country').value, registryCode: $('#fr-registry').value, address: $('#fr-address').value,
        adminContact: { name: $('#fr-admin-name').value, email: $('#fr-admin-email').value, phone: $('#fr-admin-phone').value },
        accreditationDocument: { filename: f.name, mimeType: f.type, contentBase64: await toBase64(f) },
      } });
      showToast('Application received', r.message);
      show('fa-signin');
    } catch (ex) { setError($('#fr-error'), ex.message); }
  });

  // ---- App ----
  let activeTab = 'staff';
  const loaders = { staff: loadStaff, integrations: loadIntegrations, usage: loadUsage, billing: loadBilling };
  initTabs($('#fa-app'), 'fa-tab-', (name) => { activeTab = name; if (me) loaders[name]().catch(fail); });

  async function enter() {
    const r = await call('/api/admin/me');
    me = r.admin;
    $('#fa-name').textContent = me.name || me.id;
    $('#fa-meta').textContent = `${me.role.replace('_', ' ').toLowerCase()}${me.facilityId ? ` • ${me.facilityId}` : ''}`;
    show('fa-app');
    if (me.role !== 'FACILITY_ADMIN' && me.role !== 'PLATFORM_ADMIN') {
      $('#fa-app .tabs').hidden = true;
      $('#fa-tab-staff').innerHTML = '<p class="empty-note">Your account is ready. Records officers use the records desk; this page is for facility admins.</p>';
      return;
    }
    await loaders[activeTab]();
  }

  const gated = (ex, el) => { if (ex.status === 402) { el.innerHTML = `<p class="empty-note">${esc(ex.message)}</p>`; return true; } return false; };

  async function loadStaff() {
    const { clinicians, staff } = await call('/api/admin/staff');
    $('#fa-clinicians').innerHTML = clinicians.length ? clinicians.map((c) => `
      <div class="list-card"><div><div class="lc-title">${esc(c.fullName)} <span class="badge ${c.status === 'VERIFIED' ? 'green' : c.status === 'PENDING' ? 'amber' : 'grey'}">${esc(c.status.toLowerCase())}</span></div>
      <div class="lc-meta">${esc(c.specialty)} • ${esc(c.licenseNumber)}</div></div>
      <div class="lc-actions">
        ${c.status === 'PENDING' ? `<button type="button" class="btn btn-pill-primary btn-small" data-approve="${esc(c.id)}">Approve</button><button type="button" class="btn-text-link" data-reject="${esc(c.id)}">Reject</button>` : ''}
        ${c.status === 'VERIFIED' ? `<button type="button" class="btn-text-link" data-suspend="${esc(c.id)}">Suspend</button>` : ''}
        ${c.status === 'SUSPENDED' ? `<button type="button" class="btn-text-link" data-reinstate="${esc(c.id)}">Reinstate</button>` : ''}
      </div></div>`).join('') : '<p class="empty-note">No clinicians yet. Invite them below.</p>';
    $('#fa-staff').innerHTML = staff.length ? staff.map((a) => `
      <div class="list-card"><div><div class="lc-title">${esc(a.name || a.id)} <span class="badge ${a.disabled ? 'grey' : 'green'}">${a.disabled ? 'suspended' : a.invited ? 'invited' : 'active'}</span></div>
      <div class="lc-meta">${esc(a.role.replace('_', ' ').toLowerCase())}</div></div>
      <div class="lc-actions">${a.id === me.id ? '<span class="lc-meta">You</span>' : `
        <select aria-label="New role for ${esc(a.name || a.id)}" data-role-for="${esc(a.id)}"><option value="">Change role…</option><option value="FACILITY_ADMIN">Facility admin</option><option value="RECORDS_OFFICER">Records officer</option><option value="NURSE">Nurse</option><option value="PHARMACIST">Pharmacist</option></select>
        <button type="button" class="btn-text-link" data-${a.disabled ? 'reinstate' : 'suspend'}="${esc(a.id)}">${a.disabled ? 'Reinstate' : 'Suspend'}</button>`}</div></div>`).join('') : '<p class="empty-note">No staff accounts yet.</p>';
  }
  $('#fa-tab-staff').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.approve) await call(`/api/admin/clinicians/${encodeURIComponent(t.dataset.approve)}/approve`, { method: 'POST', body: {} });
      else if (t.dataset.reject) {
        const reason = window.prompt('Reason for rejecting this registration');
        if (!reason) return;
        await call(`/api/admin/clinicians/${encodeURIComponent(t.dataset.reject)}/reject`, { method: 'POST', body: { reason } });
      } else if (t.dataset.suspend) {
        const reason = window.prompt('Reason for the suspension');
        if (!reason) return;
        await call(`/api/admin/staff/${encodeURIComponent(t.dataset.suspend)}/suspend`, { method: 'POST', body: { reason } });
      } else if (t.dataset.reinstate) await call(`/api/admin/staff/${encodeURIComponent(t.dataset.reinstate)}/reinstate`, { method: 'POST', body: {} });
      else return;
      await loadStaff();
    } catch (ex) { fail(ex); }
  });
  $('#fa-tab-staff').addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-role-for]');
    if (!s || !s.value) return;
    try { await call(`/api/admin/staff/${encodeURIComponent(s.dataset.roleFor)}/role`, { method: 'POST', body: { role: s.value } }); await loadStaff(); } catch (ex) { fail(ex); }
  });
  $('#fa-invite-staff').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError($('#is-error'), '');
    try {
      await call('/api/admin/staff/invite', { method: 'POST', body: { role: $('#is-role').value, name: $('#is-name').value, email: $('#is-email').value, phone: $('#is-phone').value } });
      showToast('Invitation sent', 'They receive a link by SMS and email.');
      e.target.reset();
      await loadStaff();
    } catch (ex) { setError($('#is-error'), ex.message); }
  });

  async function loadIntegrations() {
    try {
      const { clients } = await call('/api/admin/facility-api-clients');
      $('#fa-clients').innerHTML = clients.length ? clients.map((c) => `
        <div class="list-card"><div><div class="lc-title">${esc(c.name)} <span class="badge ${c.status === 'ACTIVE' ? 'green' : 'grey'}">${esc(c.status.toLowerCase())}</span></div>
        <div class="lc-meta">${esc(c.clientId)} • last used ${c.lastUsedAt ? esc(fmtDate(c.lastUsedAt, true)) : 'never'}</div></div>
        <div class="lc-actions">${c.status === 'ACTIVE' ? `<button type="button" class="btn-text-link" data-revoke="${esc(c.id)}">Revoke</button>` : ''}</div></div>`).join('') : '<p class="empty-note">No API clients.</p>';
      const x = await call('/api/admin/integrations');
      $('#fa-exchange').innerHTML = `
        <div class="card-list">${x.connectors.map((c) => `<div class="list-card"><div><div class="lc-title">${esc(c.name)} (${esc(c.country)}) <span class="badge ${c.configured ? 'green' : 'grey'}">${c.configured ? 'configured' : 'not configured'}</span></div>
          <div class="lc-meta">${c.lastError ? `Last error: ${esc(c.lastError)}` : 'No errors'}</div></div></div>`).join('')}</div>
        <p class="panel-note">Last sync: ${x.lastSyncAt ? esc(fmtDate(x.lastSyncAt, true)) : 'never'} • queued ${x.outbox.queued} • sent ${x.outbox.sent} • failed ${x.outbox.failed}</p>
        ${x.deadLetters.map((d) => `<div class="list-card"><div><div class="lc-title">Failed: ${esc(d.resourceType)}</div><div class="lc-meta">${d.attempts} attempt(s) • ${esc(d.lastError || '')}</div></div>
          <div class="lc-actions"><button type="button" class="btn-text-link" data-retry="${esc(d.id)}">Retry</button></div></div>`).join('')}`;
    } catch (ex) { if (!gated(ex, $('#fa-clients'))) throw ex; }
  }
  $('#fa-tab-integrations').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.revoke) await call(`/api/admin/facility-api-clients/${encodeURIComponent(t.dataset.revoke)}/revoke`, { method: 'POST', body: {} });
      else if (t.dataset.retry) await call(`/api/admin/integrations/outbox/${encodeURIComponent(t.dataset.retry)}/retry`, { method: 'POST', body: {} });
      else return;
      await loadIntegrations();
    } catch (ex) { fail(ex); }
  });
  $('#fa-client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await call('/api/admin/facility-api-clients', { method: 'POST', body: { name: $('#ac-name').value } });
      const box = $('#fa-client-secret');
      box.hidden = false;
      box.textContent = `Client id ${r.clientId}. Secret (shown only now, store it in the EMR): ${r.clientSecret}`;
      e.target.reset();
      await loadIntegrations();
    } catch (ex) { fail(ex); }
  });

  async function loadUsage() {
    try {
      const u = await call(`/api/admin/usage?days=${encodeURIComponent($('#us-days').value)}`);
      const stat = (label, value) => `<div class="stat"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`;
      $('#fa-usage').innerHTML = [
        stat('Offline card scans', u.offlineCardScans), stat('Break-glass sessions', u.breakGlassSessions), stat('Records added', u.recordsAdded),
        stat('AI drafts signed', u.aiDraftsSigned),
        stat('Average time from break-glass to summary', u.averageSecondsScanToSummary === null ? 'No data yet' : `${u.averageSecondsScanToSummary} s (${u.scanToSummarySampleSize})`),
      ].join('');
      $('#fa-usage-note').textContent = `Counts only, no patient data. Not shown: ${u.omitted.map((o) => o.reason).join(' ')}`;
    } catch (ex) { if (!gated(ex, $('#fa-usage'))) throw ex; }
  }
  $('#us-days').addEventListener('change', () => loadUsage().catch(fail));

  async function loadBilling() {
    const b = await call('/api/admin/billing');
    const s = b.subscription;
    $('#fa-billing').innerHTML = `
      <p>${s ? `Plan <strong>${esc(s.plan)}</strong>, ${esc(s.status.toLowerCase().replace('_', ' '))} until ${esc(fmtDate(s.currentPeriodEnd))}.` : 'No subscription.'} ${esc(b.note)}</p>
      <div class="card-list">${b.plans.map((p) => `<div class="list-card"><div><div class="lc-title">${esc(p.name)}</div>
        <div class="lc-meta">${esc(p.description)} • ${p.amountMinor === null ? 'not offered here' : `${esc(b.currency)} ${(p.amountMinor / 100).toLocaleString()} / month${p.placeholderPrice ? ' (placeholder price)' : ''}`}</div></div>
        <div class="lc-actions">${me.role === 'FACILITY_ADMIN' && p.amountMinor ? `<button type="button" class="btn btn-pill-primary btn-small" data-plan="${esc(p.id)}">Choose</button>` : ''}</div></div>`).join('')}</div>
      <p class="panel-note" id="fa-billing-next"></p>`;
  }
  $('#fa-tab-billing').addEventListener('click', async (e) => {
    const t = e.target.closest('button[data-plan]');
    if (!t) return;
    try {
      const r = await call('/api/admin/billing/subscribe', { method: 'POST', body: { plan: t.dataset.plan } });
      const next = $('#fa-billing-next');
      if (r.checkoutUrl) next.innerHTML = `<a href="${esc(r.checkoutUrl)}" rel="noopener">Continue to the test payment page</a>`;
      else next.textContent = r.instructions || 'Payment started.';
    } catch (ex) { fail(ex); }
  });

  // ---- Start ----
  if (inviteToken) show('fa-invite');
  else if (location.hash === '#register') show('fa-register');
  else if (token) enter().catch(() => signOutLocal());
  else show('fa-signin');
})();
