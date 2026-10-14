/* Platform status page: reads /api/health, /api/stats and /api/audit/verify. */
(function () {
  const { $, api, esc, fmtDate, setError } = window.Medistry;

  async function load() {
    const chip = $('#status-chip');
    setError($('#status-error'), '');
    chip.textContent = 'Checking…';
    chip.className = 'chain-chip';
    try {
      const [health, stats, chain] = await Promise.all([
        api('/api/health', { auth: false }),
        api('/api/stats', { auth: false }),
        api('/api/audit/verify', { auth: false }),
      ]);
      const healthy = health.status === 'HEALTHY' && chain.valid;
      chip.textContent = healthy ? 'All systems operational' : 'Attention needed';
      chip.className = `chain-chip ${healthy ? 'ok' : 'bad'}`;
      const rows = [
        ['Service', health.status === 'HEALTHY' ? 'Healthy' : health.status],
        ['Region', health.countryCode],
        ['Regulator', health.regulator],
        ['Data protection', health.compliance],
        ['Synthetic patients', stats.patients],
        ['Facilities', stats.facilities],
        ['Verified clinicians', stats.clinicians],
        ['Audit entries', stats.auditEntries],
        ['Audit chain', chain.valid ? 'Verified' : `FAILED: ${chain.error || 'unknown error'}`],
      ];
      $('#status-grid').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
      $('#status-time').textContent = `Checked ${fmtDate(health.timestamp, true)}`;
    } catch (err) {
      chip.textContent = 'Unavailable';
      chip.className = 'chain-chip bad';
      setError($('#status-error'), err.message);
    }
  }

  $('#status-refresh').addEventListener('click', load);
  load();
})();
