// Small shared behaviors: confirm destructive actions before submitting.
// Checks the button that actually triggered the submit first (for forms that share one
// <form> across multiple actions via formaction, e.g. Save/Approve/Discard), falling back
// to a data-confirm on the <form> itself for single-purpose forms like Cancel.
document.addEventListener('submit', (e) => {
  const form = e.target;
  const confirmEl = (e.submitter && e.submitter.hasAttribute('data-confirm')) ? e.submitter : form;
  if (confirmEl.matches('[data-confirm]') && !window.confirm(confirmEl.getAttribute('data-confirm'))) {
    e.preventDefault();
    return;
  }

  // Check 8-hour proximity warning if a custom scheduled time is selected
  const scheduledInput = form.querySelector('input[name="scheduledFor"]') || form.querySelector('input[type="datetime-local"]');
  if (scheduledInput && scheduledInput.value) {
    const targetDate = new Date(scheduledInput.value);
    if (!Number.isNaN(targetDate.getTime())) {
      const targetTime = targetDate.getTime();
      const posts = window.allPosts || [];
      const currentPostId = form.dataset.id || (e.submitter && e.submitter.dataset.id);
      const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

      const conflicting = posts.find((p) => {
        if (currentPostId && String(p.id) === String(currentPostId)) return false;
        const pDateStr = p.scheduledFor || p.postedAt || p.createdAt;
        if (!pDateStr) return false;
        const pTime = new Date(pDateStr).getTime();
        if (Number.isNaN(pTime)) return false;
        return Math.abs(targetTime - pTime) < EIGHT_HOURS_MS;
      });

      if (conflicting) {
        const conflictFormatted = new Date(conflicting.scheduledFor || conflicting.postedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const conflictDate = new Date(conflicting.scheduledFor || conflicting.postedAt).toLocaleDateString();
        const proceed = window.confirm(`Warning: Another post is scheduled within 8 hours of this time (on ${conflictDate} at ${conflictFormatted}). Do you still want to schedule it?`);
        if (!proceed) {
          e.preventDefault();
        }
      }
    }
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
        input.setAttribute('value', file.path);
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
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ filename: file.name, base64Data }),
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error(`Server returned status ${res.status}. Please restart your node server (npm run dev or node src/server.js) to load the new upload route.`);
        }

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Upload failed with status ${res.status}`);
        }

        if (data.path) {
          input.value = data.path;
          input.setAttribute('value', data.path);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch (err) {
      console.error('Failed to select file:', err);
      alert('File selection error: ' + (err.message || err));
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
      fileInput.value = '';
    }
  };

  fileInput.click();
});

// "Rewrite with AI" ✨ buttons: <button type="button" data-ai-rewrite-for="#someTextarea">.
// Opens a shared modal (#ai-rewrite-modal, present once per page on queue.ejs/calendar.ejs)
// for a free-text instruction, sends the CURRENT textarea value + instruction to Gemini via
// POST /ai/rewrite-text, and drops the rewritten text back in. Stateless on the server side
// (no post ID, no DB write) — the existing Save/Approve/Retry button still has to be clicked
// to actually persist it, same as any other manual edit.
(function () {
  const modal = document.getElementById('ai-rewrite-modal');
  if (!modal) return; // this page doesn't have the modal (e.g. compose/settings)

  const instructionEl = document.getElementById('ai-rewrite-instruction');
  const errorEl = document.getElementById('ai-rewrite-error');
  const rewriteBtn = document.getElementById('ai-rewrite-submit');
  const cancelBtn = document.getElementById('ai-rewrite-cancel');
  const closeX = modal.querySelector('.modal-close'); // scoped to this modal, avoids id clashes with other modals on the page

  let targetTextarea = null;
  // Bumped on every open/close so a slow response can't land on whatever post the user has
  // since navigated to — the Event Detail Modal's textarea is a single shared DOM node
  // reused across every post clicked, so this isn't just theoretical.
  let requestToken = 0;

  function openModal(textarea) {
    targetTextarea = textarea;
    requestToken++;
    instructionEl.value = '';
    errorEl.textContent = '';
    rewriteBtn.disabled = false;
    rewriteBtn.textContent = 'Rewrite';
    modal.style.display = 'flex';
    instructionEl.focus();
  }

  function closeModal() {
    requestToken++; // invalidate any in-flight request for the textarea we're leaving
    modal.style.display = 'none';
    targetTextarea = null;
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-ai-rewrite-for]');
    if (!trigger) return;
    e.preventDefault();
    const textarea = document.querySelector(trigger.getAttribute('data-ai-rewrite-for'));
    if (!textarea) return;
    openModal(textarea);
    if (!textarea.value.trim()) {
      // Show the error in context rather than silently no-op'ing — cheaper than a round trip.
      errorEl.textContent = 'Nothing to rewrite yet — write something first.';
    }
  });

  cancelBtn.addEventListener('click', closeModal);
  if (closeX) closeX.addEventListener('click', closeModal);

  rewriteBtn.addEventListener('click', async () => {
    if (!targetTextarea) return;
    const instruction = instructionEl.value.trim();
    if (!instruction) {
      errorEl.textContent = 'Describe what you want changed.';
      return;
    }
    if (!targetTextarea.value.trim()) {
      errorEl.textContent = 'Nothing to rewrite yet — write something first.';
      return;
    }
    errorEl.textContent = '';
    rewriteBtn.disabled = true;
    rewriteBtn.textContent = 'Rewriting…';

    const myToken = requestToken;
    const textareaAtRequestTime = targetTextarea;

    try {
      const res = await fetch('/ai/rewrite-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: textareaAtRequestTime.value, instruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Rewrite failed with status ${res.status}`);

      if (myToken !== requestToken) return; // modal was closed/retargeted while this was in flight

      textareaAtRequestTime.value = data.content;
      textareaAtRequestTime.dispatchEvent(new Event('input', { bubbles: true }));
      closeModal();
    } catch (err) {
      if (myToken !== requestToken) return;
      errorEl.textContent = err.message;
    } finally {
      if (myToken === requestToken) {
        rewriteBtn.disabled = false;
        rewriteBtn.textContent = 'Rewrite';
      }
    }
  });
})();
