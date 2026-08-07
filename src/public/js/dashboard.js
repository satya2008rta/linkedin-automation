// Small shared behaviors: confirm destructive actions before submitting.
// Checks the button that actually triggered the submit first (for forms that share one
// <form> across multiple actions via formaction, e.g. Save/Approve/Discard), falling back
// to a data-confirm on the <form> itself for single-purpose forms like Cancel.
document.addEventListener('submit', (e) => {
  const form = e.target;
  const confirmEl = (e.submitter && e.submitter.hasAttribute('data-confirm')) ? e.submitter : form;
  if (confirmEl.matches('[data-confirm]') && !window.confirm(confirmEl.getAttribute('data-confirm'))) {
    e.preventDefault();
  }
});

// "Browse..." buttons next to a mediaPath text input: <button data-browse-for="#someInput">.
// Opens a native OS file picker server-side (see GET /posts/browse-file) and fills in the
// real absolute path, then fires an 'input' event so any live preview picks up the change.
document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-browse-for]');
  if (!button) return;
  e.preventDefault();

  const input = document.querySelector(button.getAttribute('data-browse-for'));
  if (!input) return;

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Waiting for file dialog…';
  try {
    const res = await fetch('/posts/browse-file');
    const data = await res.json();
    if (data.path) {
      input.value = data.path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch {
    window.alert('Could not open the file picker — check the server console for details.');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});
