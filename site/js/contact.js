/* Contact page: posts the message to the backend, which stores it. */
(function () {
  const { $, api, setError } = window.Medistry;
  const form = $('#contact-form');

  const topic = new URLSearchParams(location.search).get('topic');
  if (topic) $('#ct-message').value = `I would like to know more about: ${topic.slice(0, 120)}\n\n`;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#ct-error');
    setError(err, '');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const btn = $('#ct-submit');
    btn.disabled = true;
    try {
      const data = await api('/api/contact', {
        method: 'POST', auth: false,
        body: {
          name: $('#ct-name').value, email: $('#ct-email').value, role: $('#ct-role').value,
          facility: $('#ct-facility').value, message: $('#ct-message').value,
        },
      });
      $('#ct-ref').textContent = data.reference;
      form.hidden = true;
      $('#ct-success').hidden = false;
      form.reset();
    } catch (ex) {
      setError(err, ex.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('#ct-again').addEventListener('click', () => {
    $('#ct-success').hidden = true;
    form.hidden = false;
  });
})();
