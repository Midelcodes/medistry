/* Emergency gate (/e/:code): public badge, clinician sign-in, break-glass confirmation. */
(function () {
  const { $, api, Session, setError, bindClinicianLogin, signOut, esc } = window.Medistry;
  const code = decodeURIComponent(location.pathname.replace(/^\/e\//, '')).trim();

  function renderState() {
    const session = Session.get();
    $('#gate-signin').hidden = !!session;
    $('#gate-break').hidden = !session;
    if (session) $('#gate-me').textContent = session.clinician.fullName;
  }

  async function init() {
    let gate;
    try {
      gate = await api(`/api/emergency/gate/${encodeURIComponent(code)}`, { auth: false });
    } catch {
      gate = { valid: false };
    }
    $('#gate-loading').hidden = true;
    if (!gate.valid) {
      $('#gate-invalid').hidden = false;
      return;
    }
    $('#gate-valid').hidden = false;
    $('#gate-code').textContent = code.toUpperCase();

    if (gate.publicCard) {
      const c = gate.publicCard;
      $('#public-card').hidden = false;
      $('#pc-blood').textContent = c.bloodGroup;
      $('#pc-genotype').textContent = c.genotype;
      $('#pc-allergies').innerHTML = c.allergies.length ? c.allergies.map((a) => `<li>${esc(a)}</li>`).join('') : '<li>None on record</li>';
      const phone = $('#pc-phone');
      phone.textContent = c.emergencyHotline;
      phone.href = `tel:${c.emergencyHotline.replace(/[^+\d]/g, '')}`;
    }

    await bindClinicianLogin({
      form: '#gate-login-form', select: '#gate-clinician', totp: '#gate-totp',
      error: '#gate-login-error', showCode: '#gate-show-code', onSignedIn: renderState,
    });
    renderState();
  }

  $('#gate-logout').addEventListener('click', async () => { await signOut(); renderState(); });
  $('#break-reason').addEventListener('change', (e) => { $('#break-details-group').hidden = e.target.value !== 'OTHER'; });

  $('#break-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#break-error');
    setError(err, '');
    const reason = $('#break-reason').value;
    const details = $('#break-details').value.trim();
    if (reason === 'OTHER' && details.length < 5) return setError(err, 'Written justification is required when the reason is "Other".');
    const btn = $('button[type="submit"]', e.target);
    btn.disabled = true;
    try {
      const data = await api('/api/emergency/break-glass', { method: 'POST', body: { code, reason, reasonDetails: details } });
      window.location.href = data.redirectUrl;
    } catch (ex) {
      setError(err, ex.message);
      if (ex.status === 401) renderState();
      btn.disabled = false;
    }
  });

  init();
})();
