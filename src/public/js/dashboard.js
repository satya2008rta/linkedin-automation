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
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-browse-for]');
  if (!button) return;
  e.preventDefault();

  const inputSelector = button.getAttribute('data-browse-for');
  const input = document.querySelector(inputSelector);
  if (!input) return;

  let fileInput = document.getElementById('global-file-picker');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.id = 'global-file-picker';
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/gif';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
  }

  fileInput.onchange = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Processing image…';

    try {
      if (file.path) {
        input.value = file.path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(file);
        });

        const res = await fetch('/posts/upload-media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, base64Data }),
        });
        const data = await res.json();
        if (data.path) {
          input.value = data.path;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch (err) {
      console.error('Failed to select file:', err);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
      fileInput.value = '';
    }
  };

  fileInput.click();
});
