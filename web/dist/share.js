// Read-only view of a shared note. The token lives in the URL fragment, which the
// browser never sends to the server; it only travels in the body of the read request.
(() => {
  'use strict';

  const root = document.getElementById('share');
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  const ATTACH_RE = /^!\[([^\]]*)\]\(attach:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;
  const CHECKLIST_RE = /^(\s*)(🟡|✅)(\s+)(.*)$/;
  const CHECK_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.8 4.6 4.6L19 7.6"/></svg>';
  const PAPERCLIP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 11.5-8.2 8.2a5 5 0 0 1-7-7l8.9-8.9a3.3 3.3 0 0 1 4.7 4.7L9.6 17.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The server stores checklists as "- [ ] " / "- [x] " and older notes may still hold
  // the emoji form. The editor converts both to emoji when it opens a note
  // (app.js normalizeContent); this page does the same before rendering.
  function normalizeContent(content) {
    return String(content || '')
      .replace(/<u>([\s\S]*?)<\/u>/gi, '_$1_')
      .replace(/^(\s*)-\s+\[\s\]\s+/gm, '$1🟡 ')
      .replace(/^(\s*)-\s+\[[xX]\]\s+/gm, '$1✅ ');
  }

  // Same inline rules as the editor overlay (app.js formatInline). The text is
  // escaped first, so nothing from the note is ever interpreted as markup.
  function formatInline(text) {
    return esc(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1<u>$2</u>')
      .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  }

  function renderContent(value) {
    return normalizeContent(value).split('\n').map((line) => {
      const attach = ATTACH_RE.exec(line);
      if (attach) {
        return `<div class="content-line"><span class="attach-label">${PAPERCLIP_SVG}<span class="attach-name">${esc(attach[1])}</span></span></div>`;
      }
      const item = CHECKLIST_RE.exec(line);
      if (!item) return `<div class="content-line">${formatInline(line) || '&nbsp;'}</div>`;
      const done = item[2] === '✅';
      return `<div class="content-line checklist-line">${item[1]}<span class="check${done ? ' done' : ''}" aria-hidden="true">${done ? CHECK_SVG : ''}</span><span class="cl-text${done ? ' done' : ''}">${formatInline(item[4]) || '&nbsp;'}</span></div>`;
    }).join('');
  }

  function showMessage(title, text) {
    root.innerHTML = `<div class="share-state" role="alert"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  }

  const attachmentLabel = (name) => `<span class="attach-label">${PAPERCLIP_SVG}<span class="attach-name">${esc(name)}</span></span>`;

  // Markdown notes use the shared renderer. If it did not load, show the text as it
  // is rather than an empty page.
  function renderBody(note) {
    if (note.format === 'md') {
      if (window.LiteMd) {
        return `<div class="share-content md">${window.LiteMd.render(note.content, { attachment: attachmentLabel })}</div>`;
      }
      return `<div class="share-content">${String(note.content || '').split('\n').map((l) => `<div class="content-line">${esc(l) || '&nbsp;'}</div>`).join('')}</div>`;
    }
    return `<div class="share-content">${renderContent(note.content)}</div>`;
  }

  async function load() {
    const token = location.hash.slice(1);
    if (!TOKEN_RE.test(token)) {
      showMessage('Link unavailable', 'This link is incomplete or has been turned off.');
      return;
    }
    let res;
    try {
      res = await fetch('/api/v1/shared/read', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      showMessage('No connection', 'Check your internet connection and reload this page.');
      return;
    }
    if (res.status === 429) {
      showMessage('Too many requests', 'Please wait a moment and reload this page.');
      return;
    }
    const note = res.ok ? await res.json().catch(() => null) : null;
    if (!note) {
      showMessage('Link unavailable', 'This link is unavailable or has been turned off.');
      return;
    }
    const title = note.title || 'Untitled';
    document.title = `${title} · io-notes`;
    root.innerHTML = `<article><h1 class="share-title">${esc(title)}</h1>${renderBody(note)}</article>`;
  }

  window.addEventListener('hashchange', () => void load());
  void load();
})();
