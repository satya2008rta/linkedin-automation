// Renders a pixel-close mock of a LinkedIn post card. Used by both the Compose page
// (live-updates as you type) and the AI Calendar page (one per draft) so "how it will
// look" is identical everywhere in the app.
(function () {
  function esc(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderLinkedInPreview({ name, headline, avatarUrl, content, mediaUrl }) {
    const avatarStyle = avatarUrl ? `background-image:url('${avatarUrl}')` : '';
    const hasContent = content && content.trim().length > 0;
    const bodyHtml = hasContent
      ? esc(content)
      : '<span class="li-preview-empty">Start typing to preview how this will look…</span>';
    const showMore = hasContent && content.length > 220;

    return `
      <div class="li-preview">
        <div class="li-preview-header">
          <div class="li-preview-avatar" style="${avatarStyle}"></div>
          <div class="li-preview-meta">
            <div class="li-preview-name">${esc(name) || 'Your Name'}</div>
            <div class="li-preview-headline">${esc(headline) || ''}</div>
            <div class="li-preview-time">Just now &middot; 🌐</div>
          </div>
        </div>
        <div class="li-preview-body ${hasContent ? 'clamped' : ''}">${bodyHtml}</div>
        ${showMore ? '<div class="li-preview-more">…see more</div>' : ''}
        ${mediaUrl ? `<img class="li-preview-media" src="${mediaUrl}" onerror="this.remove()">` : ''}
        <div class="li-preview-actions">
          <span>👍 Like</span><span>💬 Comment</span><span>🔁 Repost</span><span>✈️ Send</span>
        </div>
      </div>`;
  }

  function mountPreview(container, profile) {
    // profileOverride lets a caller swap identity per-render (e.g. a "Post as" dropdown
    // switching between your own profile and a Company Page) without re-mounting.
    function update(content, mediaPath, profileOverride) {
      const mediaUrl = mediaPath && mediaPath.trim() ? `/posts/media-preview?path=${encodeURIComponent(mediaPath.trim())}` : null;
      container.innerHTML = renderLinkedInPreview({ ...profile, ...profileOverride, content, mediaUrl });
      const more = container.querySelector('.li-preview-more');
      const body = container.querySelector('.li-preview-body');
      if (more && body) {
        more.addEventListener('click', () => {
          body.classList.remove('clamped');
          more.remove();
        });
      }
    }
    return { update };
  }

  window.LIPreview = { renderLinkedInPreview, mountPreview };
})();
