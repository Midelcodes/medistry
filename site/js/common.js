/**
 * MEDISTRY - shared browser helpers (navigation, toast, API client, clinician session).
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    return d.toLocaleString('en-GB', withTime
      ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---- Clinician session (kept in this tab only) ----
  const SESSION_KEY = 'medistry.clinician';
  const Session = {
    get() {
      try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
    },
    set(value) {
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
    clear() {
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    },
  };

  // ---- API client ----
  async function api(path, options = {}) {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const session = Session.get();
    if (options.auth !== false && session && session.token) headers.Authorization = `Bearer ${session.token}`;
    let res;
    try {
      res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && session && options.auth !== false) Session.clear();
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- Toast ----
  let toastTimer;
  function showToast(title, message, type) {
    const toast = $('#toast-notification');
    if (!toast) return;
    $('#toast-title').textContent = title;
    $('#toast-message').textContent = message || '';
    $('#toast-icon').textContent = type === 'error' ? '!' : '✓';
    toast.classList.toggle('error', type === 'error');
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
  }

  function setError(el, message) {
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  // ---- Tabs ----
  function initTabs(root, prefix, onChange) {
    const tabs = $$('.tab', root);
    function select(name) {
      tabs.forEach((t) => {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
        const panel = document.getElementById(prefix + t.dataset.tab);
        if (panel) panel.hidden = !on;
      });
      if (onChange) onChange(name);
    }
    tabs.forEach((t) => t.addEventListener('click', () => select(t.dataset.tab)));
    return select;
  }

  // ---- Shared clinician sign-in widget (used by the console and the emergency gate) ----
  async function bindClinicianLogin(opts) {
    const select = $(opts.select);
    const totp = $(opts.totp);
    const errorEl = $(opts.error);
    try {
      const { clinicians } = await api('/api/clinicians', { auth: false });
      select.innerHTML = clinicians
        .map((c) => `<option value="${esc(c.id)}">${esc(c.fullName)} — ${esc(c.specialty)}</option>`)
        .join('');
    } catch (err) {
      setError(errorEl, err.message);
    }

    $(opts.showCode).addEventListener('click', async () => {
      try {
        const { code, secondsRemaining } = await api(`/api/demo/totp/${encodeURIComponent(select.value)}`, { auth: false });
        totp.value = code;
        showToast('Demo authenticator', `Code ${code} is valid for about ${secondsRemaining}s.`);
      } catch (err) {
        setError(errorEl, err.message);
      }
    });

    $(opts.form).addEventListener('submit', async (e) => {
      e.preventDefault();
      setError(errorEl, '');
      const btn = $('button[type="submit"]', e.target);
      btn.disabled = true;
      try {
        const data = await api('/api/clinician/login', {
          method: 'POST', auth: false,
          body: { clinicianId: select.value, totp: totp.value.trim() },
        });
        Session.set({ token: data.token, clinician: data.clinician });
        totp.value = '';
        opts.onSignedIn(data.clinician);
      } catch (err) {
        setError(errorEl, err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function signOut() {
    try { await api('/api/clinician/logout', { method: 'POST', body: {} }); } catch { /* already gone */ }
    Session.clear();
  }

  // ---- Timeline rendering (shared) ----
  function renderTimeline(listEl, items) {
    if (!items.length) {
      listEl.innerHTML = '<li class="empty-note">No records match.</li>';
      return;
    }
    listEl.innerHTML = items
      .map((i) => `<li>
        <div class="tl-head"><span class="tl-title">${esc(i.title)}</span><span class="tl-date">${esc(fmtDate(i.effectiveDate))}</span></div>
        <div class="tl-summary">${esc(i.summary)}</div>
        <div class="tl-badge"><span class="badge">${esc(i.resourceType)}</span> ${esc(i.badge)}</div>
      </li>`)
      .join('');
  }

  function renderProfile(el, p) {
    const allergies = p.allergies.length
      ? p.allergies.map((a) => `<li><span class="badge ${a.severity === 'severe' ? 'red' : 'amber'}">${esc(a.severity)}</span> ${esc(a.substance)} — ${esc(a.reaction)}</li>`).join('')
      : '<li class="empty-note">None on record</li>';
    const meds = p.activeMedications.length
      ? p.activeMedications.map((m) => `<li>${esc(m.medicationName)} — ${esc(m.dose)} (${esc(m.route)})</li>`).join('')
      : '<li class="empty-note">None on record</li>';
    const conds = p.chronicConditions.length
      ? p.chronicConditions.map((c) => `<span class="badge">${esc(c)}</span>`).join('')
      : '<span class="empty-note">None on record</span>';
    const contacts = p.emergencyContacts.length
      ? p.emergencyContacts.map((c) => `<li>${esc(c.name)} (${esc(c.relationship)}) — ${esc(c.phone)}</li>`).join('')
      : '<li class="empty-note">None on record</li>';
    el.innerHTML = `
      <dl class="kv-grid">
        <div><dt>Name</dt><dd>${esc(p.firstName)} ${esc(p.lastName)}</dd></div>
        <div><dt>Age / sex</dt><dd>${esc(p.age)} / ${esc(p.gender)}</dd></div>
        <div><dt>Date of birth</dt><dd>${esc(fmtDate(p.dateOfBirth))}</dd></div>
        <div><dt>Blood group</dt><dd>${esc(p.bloodGroup)}</dd></div>
        <div><dt>Genotype</dt><dd>${esc(p.genotype)}</dd></div>
        <div><dt>Home hospital</dt><dd>${esc(p.primaryFacilityName || 'Not set')}</dd></div>
        <div><dt>Do not resuscitate</dt><dd>${p.dnr ? '<span class="badge red">Active</span>' : 'No'}</dd></div>
        <div><dt>Organ donor</dt><dd>${p.organDonor ? 'Yes' : 'No'}</dd></div>
      </dl>
      <h3 class="section-sub">Allergies</h3><ul class="plain-list">${allergies}</ul>
      <h3 class="section-sub">Chronic conditions</h3><div class="pill-row">${conds}</div>
      <h3 class="section-sub">Active medications</h3><ul class="plain-list">${meds}</ul>
      <h3 class="section-sub">Emergency contacts</h3><ul class="plain-list">${contacts}</ul>`;
  }

  // ---- Page wiring ----
  function initNav() {
    const toggle = $('#mobile-menu-toggle');
    const drawer = $('#mobile-nav-drawer');
    if (toggle && drawer) {
      toggle.addEventListener('click', () => {
        const open = drawer.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
      });
      $$('a', drawer).forEach((a) => a.addEventListener('click', () => drawer.classList.remove('open')));
    }
    const close = $('#toast-close');
    if (close) close.addEventListener('click', () => $('#toast-notification').classList.remove('show'));
  }

  async function initLiveStats() {
    const el = $('#live-stats');
    if (!el) return;
    try {
      const s = await api('/api/stats', { auth: false });
      el.innerHTML = [
        [s.patients, 'synthetic patients'],
        [s.facilities, 'facilities'],
        [s.clinicians, 'verified clinicians'],
        [s.auditEntries, `audit entries (${s.auditChainValid ? 'chain verified' : 'chain INVALID'})`],
      ].map(([n, l]) => `<span class="stat-pill"><strong>${esc(n)}</strong> ${esc(l)}</span>`).join('');
    } catch { /* stats are optional */ }
  }

  document.addEventListener('DOMContentLoaded', () => { initNav(); initLiveStats(); });

  window.Medistry = { $, $$, esc, fmtDate, api, Session, showToast, setError, initTabs, bindClinicianLogin, signOut, renderTimeline, renderProfile };
})();
