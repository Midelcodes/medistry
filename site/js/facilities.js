/* Facilities page: hospitals with their verified clinicians. */
(function () {
  const { $, api, esc } = window.Medistry;
  let facilities = [];
  let clinicians = [];

  function render() {
    const q = ($('#fac-search').value || '').trim().toLowerCase();
    const list = $('#facility-list');
    const rows = facilities
      .map((f) => ({ f, docs: clinicians.filter((c) => c.facilityId === f.id) }))
      .filter(({ f, docs }) => !q || [f.name, f.region, f.type, f.address, ...docs.flatMap((d) => [d.fullName, d.specialty])].join(' ').toLowerCase().includes(q));
    $('#fac-empty').hidden = rows.length !== 0;
    list.innerHTML = rows.map(({ f, docs }) => `
      <article class="facility-card">
        <h2>${esc(f.name)}</h2>
        <p class="facility-meta">${esc(f.type)} &bull; ${esc(f.region)}, ${esc(f.countryCode)} &bull; ${esc(f.address)}</p>
        <div class="clinician-chips">
          ${docs.length ? docs.map((d) => `<div class="clinician-chip"><strong>${esc(d.fullName)}</strong><span>${esc(d.specialty)}</span><span>${esc(d.licenseNumber)} <span class="badge green">MDCN verified</span></span></div>`).join('') : '<span class="empty-note">No clinicians listed</span>'}
        </div>
      </article>`).join('');
  }

  async function init() {
    try {
      [{ facilities }, { clinicians }] = await Promise.all([
        api('/api/facilities', { auth: false }),
        api('/api/clinicians', { auth: false }),
      ]);
      render();
    } catch (err) {
      $('#facility-list').innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  }
  $('#fac-search').addEventListener('input', render);
  init();
})();
