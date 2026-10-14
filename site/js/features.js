/* Features page: category filter + search over the feature cards. */
(function () {
  const { $, $$ } = window.Medistry;
  const pills = $$('.filter-pill');
  const cards = $$('.specialty-card');
  const input = $('#specialty-search-input');
  const button = $('#search-action-btn');
  let category = 'all';

  function apply() {
    const q = (input.value || '').trim().toLowerCase();
    let shown = 0;
    cards.forEach((card) => {
      const match = (category === 'all' || card.dataset.category === category) && (!q || card.textContent.toLowerCase().includes(q));
      card.classList.toggle('hidden', !match);
      if (match) shown += 1;
    });
    const empty = $('#no-results');
    if (empty) empty.hidden = shown !== 0;
  }

  pills.forEach((pill) => pill.addEventListener('click', () => {
    pills.forEach((p) => { p.classList.remove('active'); p.setAttribute('aria-selected', 'false'); });
    pill.classList.add('active');
    pill.setAttribute('aria-selected', 'true');
    category = pill.dataset.filter;
    apply();
  }));
  if (input) input.addEventListener('input', apply);
  if (button) button.addEventListener('click', apply);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
})();
