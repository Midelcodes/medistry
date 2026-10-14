/* Emergency page: validate a typed code, then open its gate. */
(function () {
  const { $, api, setError } = window.Medistry;
  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#code-error');
    setError(err, '');
    const code = $('#code-input').value.trim();
    if (!code) return setError(err, 'Enter the emergency code from the card or wristband.');
    const btn = $('button[type="submit"]', e.target);
    btn.disabled = true;
    try {
      const gate = await api(`/api/emergency/gate/${encodeURIComponent(code)}`, { auth: false });
      if (!gate.valid) throw new Error('That code was not found. Check for a typing mistake or ask for a new card.');
      window.location.href = `/e/${encodeURIComponent(code)}`;
    } catch (ex) {
      setError(err, ex.message);
      btn.disabled = false;
    }
  });
})();
