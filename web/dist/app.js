/* io-notes — offline-first notes client.
   Hand-written ES2022, no build step. Run `node --check web/dist/app.js` before shipping.

   Rendering model: the shell is mounted once, then each region (folders, list,
   editor) repaints independently and only when its markup actually changed.
   Nothing ever replaces the whole document, so caret, scroll and IME state survive. */
(() => {
  'use strict';

  const cfg = window.__LITENOTES_CONFIG__ || { authMode: 'google', googleClientId: '' };
  const MAX_TITLE = 500;
  // V2 stores are account-scoped.  The original stores stay read-only as a
  // one-time recovery source so upgrading does not silently discard notes.
  const DB_VERSION = 3;
  const STORES = { notes: 'notes_v2', outbox: 'outbox_v2', meta: 'meta_v2' };

  const history = new Map();

  const state = {
    user: null,
    notes: [],
    folders: [],
    folderFilter: null,
    query: '',
    route: { view: 'notes', noteId: null },
    unlocked: Object.create(null),
    decrypted: Object.create(null),
    _keys: Object.create(null),
    listMode: 'folders', // 'folders' = browse folders, 'notes' = note rows
    db: null,
    deviceId: '',
    online: navigator.onLine,
    clockOffset: 0,
    lastStamp: 0,
    attachments: [],
  };
  const tabChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('litenotes-sync-v1') : null;

  /* ---------------------------------------------------------------- utils */

  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => crypto.randomUUID();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // Monotonic logical clock: server-calibrated, never goes backwards (PRD 4.5).
  function stamp(previous = 0) {
    const next = Math.max(Date.now() + state.clockOffset, previous + 1, state.lastStamp + 1);
    state.lastStamp = next;
    return next;
  }

  const decTitle = (n) => state.decrypted[n.id]?.title ?? n.title;
  const decContent = (n) => normalizeContent(state.decrypted[n.id]?.content ?? n.content);
  const titleOf = (n) => { const t = decTitle(n); const c = decContent(n); const first = (c.split('\n').find((l) => l.trim()) || '').trim(); return (t.trim() || stripMarkdown(first).trim() || 'Untitled note').slice(0, 120); };
  const snippetOf = (n) => stripMarkdown(decContent(n)).trim().slice(0, 180);
  const isLocked = (n) => !!n.is_locked && !state.unlocked[n.id];
  const wordsOf = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

  // PRD 4.4 caps content at 1 MB of UTF-8. Measuring bytes on every keystroke is
  // wasteful, so only weigh it once the cheap character count gets close.
  const MAX_CONTENT_BYTES = 1_000_000;
  function overContentLimit(text) {
    if (text.length < MAX_CONTENT_BYTES / 4) return false;
    return new TextEncoder().encode(text).length > MAX_CONTENT_BYTES;
  }

  /* --------------------------------------------------------- client crypto */

  // Derive AES-256-GCM key from password + noteId (as salt).
  async function deriveKey(password, noteId) {
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(noteId), iterations: 100000, hash: 'SHA-256' },
      keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encryptText(text, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { ct: btoa(String.fromCharCode(...new Uint8Array(ct))), iv: btoa(String.fromCharCode(...iv)) };
  }

  async function decryptText(ct, iv, key) {
    const ctBuf = Uint8Array.from(atob(ct), c => c.charCodeAt(0));
    const ivBuf = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ctBuf);
    return new TextDecoder().decode(plain);
  }

  function relTime(ms) {
    const diff = Date.now() + state.clockOffset - ms;
    if (diff < 45e3) return 'just now';
    if (diff < 3.6e6) return `${Math.round(diff / 6e4)}m ago`;
    if (diff < 864e5) return `${Math.round(diff / 36e5)}h ago`;
    const d = new Date(ms);
    const today = new Date();
    const dayDiff = Math.floor((today.setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 864e5);
    if (dayDiff === 1) return 'yesterday';
    if (dayDiff < 7) return `${dayDiff}d ago`;
    const opts = d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return d.toLocaleDateString('en-US', opts);
  }

  function fullTime(ms) {
    return new Date(ms).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Escape text while highlighting the first match of `q`.
  function highlight(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  /* ----------------------------------------------- apple-style smart input */

  // Flatten markdown into plain text for the note list (headings, bullets, …).
  function stripMarkdown(t) {
    return t
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^(\s*)-\s+\[[ xX]\]\s+/gm, '$1')
      .replace(/^(\s*)[🟡✅]\s+/gm, '$1')
      .replace(/^(\s*)([-*+•])\s+/gm, '$1')
      .replace(/^(\s*)(\d{1,9})[.)]\s+/gm, '$1')
      .replace(/^---+(\s*)$/gm, ' ')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/\s+/g, ' ');
  }

  // Recognise an Apple Notes-style list marker at the start of a line.
  function listItemAt(line) {
    let m = /^(\s*)(-\s+\[[ xX]\]\s+)(.*)$/.exec(line);
    if (m) return { indent: m[1], marker: m[2], rest: m[3], kind: 'task' };
    m = /^(\s*)([🟡✅])([ \t]+)(.*)$/.exec(line);
    if (m) return { indent: m[1], marker: m[2], sep: m[3], rest: m[4], kind: 'task-visual' };
    m = /^(\s*)([-*+•])(\s+)(.*)$/.exec(line);
    if (m) return { indent: m[1], marker: m[2], sep: m[3], rest: m[4], kind: 'ul' };
    m = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/.exec(line);
    if (m) return { indent: m[1], marker: m[2], sep: m[3] + m[4], rest: m[5], kind: 'ol' };
    return null;
  }

  // Write an edit and let the existing input pipeline (autosave, sync) run.
  function applyEdit(c, text, caret) {
    c.value = text;
    c.setSelectionRange(caret, caret);
    c.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function applyEditRange(c, text, start, end) {
    c.value = text;
    c.setSelectionRange(start, end);
    c.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Deleting a single * or _ of a balanced pair would leave a dangling literal
  // marker in the rendered text, so shave the mirrored char on the other side
  // too: ***x*** -> **x** -> *x* -> x.
  function balancedMarkerEdit(value, s, dir) {
    const i = dir === -1 ? s - 1 : s;
    const ch = value[i];
    if (ch !== '*' && ch !== '_') return null;
    const lineStart = value.lastIndexOf('\n', i - 1) + 1;
    let lineEnd = value.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const runs = [];
    for (let p = 0; p < line.length;) {
      if (line[p] === ch) {
        let q = p;
        while (q + 1 < line.length && line[q + 1] === ch) q++;
        runs.push([p, q + 1]);
        p = q + 1;
      } else p++;
    }
    if (runs.length !== 2) return null;
    if (runs[0][1] - runs[0][0] !== runs[1][1] - runs[1][0]) return null;
    if (!line.slice(runs[0][1], runs[1][0]).trim()) return null;
    const rel = i - lineStart;
    const other = rel < runs[0][1] ? lineStart + runs[1][1] - 1 : lineStart + runs[0][1] - 1;
    const lo = Math.min(i, other);
    const hi = Math.max(i, other);
    const text = value.slice(0, lo) + value.slice(lo + 1, hi) + value.slice(hi + 1);
    const caret = s - ((lo < s ? 1 : 0) + (hi < s ? 1 : 0));
    return { text, caret };
  }

  // Apple Notes-style smart typing: Enter continues lists (bullets auto-increment),
  // Tab indents / Shift+Tab outdents, Backspace at a list start outdents, and
  // Cmd/Ctrl+B / Cmd/Ctrl+I wrap the selection in bold / italic markers.
  function onContentKeydown(ev) {
    if (ev.isComposing) return; // never fight the IME
    // Some Android keyboards report keyCode 229 for plain Enter/Tab/Backspace
    // as well, so only bail for text-producing keys — list navigation keys are
    // safe to handle even when keyCode says 229.
    if (ev.keyCode === 229 && !['Enter', 'Tab', 'Backspace', 'Delete'].includes(ev.key)) return;
    const c = $('#content');
    if (!c) return;
    const { value } = c;
    const s = c.selectionStart;
    const e = c.selectionEnd;

    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === 'b' || ev.key === 'i')) {
      ev.preventDefault();
      const mark = ev.key === 'b' ? '**' : '*';
      if (s === e) {
        applyEdit(c, value.slice(0, s) + mark + mark + value.slice(e), s + mark.length);
      } else {
        const sel = value.slice(s, e).replace(/^(\*+)/, '').replace(/(\*+)$/, '');
        const next = value.slice(0, s) + mark + sel + mark + value.slice(e);
        applyEditRange(c, next, s + mark.length, s + mark.length + sel.length);
      }
      return;
    }

    if ((ev.key === '*' || ev.key === '`') && !ev.metaKey && !ev.ctrlKey && !ev.altKey && s !== e) {
      ev.preventDefault();
      applyEditRange(c, value.slice(0, s) + ev.key + value.slice(s, e) + ev.key + value.slice(e), s + 1, e + 1);
      return;
    }

    if (ev.key === 'Enter' && !ev.shiftKey && s === e) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const lineEndAt = value.indexOf('\n', s);
      const lineEnd = lineEndAt === -1 ? value.length : lineEndAt;
      const lineText = value.slice(lineStart, lineEnd);
      const item = listItemAt(lineText);
      const atLineEnd = s === lineEnd;
      if (!item) {
        const compact = /^(\s*)-(\d+)$/.exec(lineText);
        if (!compact || !atLineEnd) return; // plain paragraph — default Enter
        ev.preventDefault();
        const bullet = `${compact[1]}• ${compact[2]}`;
        const cont = `${compact[1]}• `;
        const next = value.slice(0, lineStart) + bullet + '\n' + cont + value.slice(lineEnd);
        applyEdit(c, next, lineStart + bullet.length + 1 + cont.length);
        return;
      }
      ev.preventDefault();
      if (item.rest.trim() === '' && atLineEnd) {
        // Empty item + Enter leaves the list.
        applyEdit(c, value.slice(0, lineStart) + value.slice(lineEnd), lineStart);
        return;
      }
      let cont;
      if (item.kind === 'ol') cont = `${item.indent}${parseInt(item.marker, 10) + 1}${item.sep.trimEnd()} `;
      else if (item.kind === 'task') cont = `${item.indent}- [ ] `;
      else if (item.kind === 'task-visual') cont = `${item.indent}${item.marker} `;
      else cont = `${item.indent}${item.marker} `;
      // Split the current line at the caret; the new line gets a fresh marker.
      const lineHead = value.slice(lineStart, lineEnd);
      const rel = s - lineStart;
      const next = value.slice(0, lineStart) + lineHead.slice(0, rel) + '\n' + cont + lineHead.slice(rel) + value.slice(lineEnd);
      applyEdit(c, next, lineStart + rel + 1 + cont.length);
      return;
    }

    if (ev.key === 'Tab') {
      ev.preventDefault();
      const blockStart = value.lastIndexOf('\n', s - 1) + 1;
      let blockEnd = value.indexOf('\n', e);
      if (blockEnd === -1) blockEnd = value.length;
      const block = value.slice(blockStart, blockEnd);
      const lines = block.split('\n');
      const changed = lines.map((l) => {
        if (!l.trim()) return l;
        if (ev.shiftKey) {
          if (/^ {2}/.test(l)) return l.slice(2);
          const it = listItemAt(l);
          if (it && it.indent === '') return l.slice(it.marker.length + (it.sep || '').length);
          return l;
        }
        return '  ' + l;
      }).join('\n');
      if (changed === block) return;
      applyEditRange(c, value.slice(0, blockStart) + changed + value.slice(blockEnd), s, e + (changed.length - block.length));
      return;
    }

    if (ev.key === 'Backspace' && s === e && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const bal = balancedMarkerEdit(value, s, -1);
      if (bal) { ev.preventDefault(); applyEdit(c, bal.text, bal.caret); return; }
    }
    if (ev.key === 'Delete' && s === e && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const bal = balancedMarkerEdit(value, s, 1);
      if (bal) { ev.preventDefault(); applyEdit(c, bal.text, bal.caret); return; }
    }

    if (ev.key === 'Backspace' && s === e) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      if (s !== lineStart) return;
      const lineEndAt = value.indexOf('\n', s);
      const lineEnd = lineEndAt === -1 ? value.length : lineEndAt;
      const line = value.slice(lineStart, lineEnd);
      if (/^ {2}/.test(line)) {
        ev.preventDefault();
        applyEdit(c, value.slice(0, lineStart) + line.slice(2) + value.slice(lineEnd), lineStart);
        return;
      }
      const item = listItemAt(line);
      if (item) {
        ev.preventDefault();
        const markerLen = item.marker.length + (item.sep || '').length;
        applyEdit(c, value.slice(0, lineStart) + line.slice(markerLen) + value.slice(lineEnd), lineStart);
      }
    }
  }


  /* ---------------------------------------------------------------- icons */

  const ICON_PATHS = {
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    search: '<circle cx="11" cy="11" r="6.6"/><path d="m20 20-3.4-3.4"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chev: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    left: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
    folder: '<path d="M3.5 7.2a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.1 1.3h7.1a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="var(--folder-yellow)" stroke="var(--folder-yellow)" stroke-linejoin="round"/>',
    folderOpen: '<path d="M3.5 7.2a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.1 1.3h7.1a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="var(--folder-yellow)" stroke-width="1.7" stroke-linejoin="round"/>',
    all: '<rect x="3.5" y="7" width="17" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 9h17"/>',
    pin: '<path d="M12 3.5l2.2 4.5 5 0.7-3.6 3.5 0.9 5-4.5-2.4-4.5 2.4 0.9-5L4.8 8.7l5-0.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    pinFill: '<path d="M12 3.5l2.2 4.5 5 0.7-3.6 3.5 0.9 5-4.5-2.4-4.5 2.4 0.9-5L4.8 8.7l5-0.7z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    lock: '<rect x="4.6" y="10.4" width="14.8" height="9.8" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>',
    unlock: '<rect x="4.6" y="10.4" width="14.8" height="9.8" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.2-1.5"/>',
    trash: '<path d="M4.5 7h15M9.6 7V5.4A1.4 1.4 0 0 1 11 4h2a1.4 1.4 0 0 1 1.4 1.4V7M6.8 7l.8 11.3A2 2 0 0 0 9.6 20.2h4.8a2 2 0 0 0 2-1.9L17.2 7"/>',
    restore: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V9h-4.5"/>',
    note: '<path d="M6.5 3.8h7.3L18.5 8.5v11.7h-12z"/><path d="M13.5 3.8v5h5"/><path d="M9.3 12.6h6M9.3 16h4"/>',
    sun: '<circle cx="12" cy="12" r="3.9"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
    moon: '<path d="M20 14.6A8.5 8.5 0 0 1 9.4 4 8.5 8.5 0 1 0 20 14.6z"/>',
    auto: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4" /><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/>',
    edit: '<path d="m14.3 5.6 4.1 4.1"/><path d="M4.4 19.6 5.5 15 15.9 4.6a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3L9 18.5z"/>',
    logout: '<path d="M14.5 5.2h3.3a1.7 1.7 0 0 1 1.7 1.7v10.2a1.7 1.7 0 0 1-1.7 1.7h-3.3"/><path d="m9.4 8.2-3.8 3.8 3.8 3.8M5.6 12h9"/>',
    more: '<circle cx="12" cy="5.6" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.4" r="1.4" fill="currentColor" stroke="none"/>',
    cloud: '<path d="M7.2 18.5a4 4 0 0 1-.4-8 5.6 5.6 0 0 1 10.7 1.2 3.4 3.4 0 0 1-.6 6.8z"/>',
    check: '<path d="m5 12.6 4.6 4.6L19 7.8"/>',
    checkBox: '<rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m7 12 3 3 7-7"/>',
    square: '<rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    bold: '<path d="M8 6.5h5a3 3 0 0 1 3 3 3 3 0 0 1-1.2 2.4A3.5 3.5 0 0 1 18.5 15a3.5 3.5 0 0 1-3.5 3.5H8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 11.2h5"/>',
    italic: '<path d="M14 4.5l-2 15M10 4.5h6M8 19.5h6"/>',
    underline: '<path d="M7 5.5v6a5 5 0 0 0 10 0v-6M5 19.5h14"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.6" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.4 12.2 2.5 2.5 4.9-4.9"/>',
    download: '<path d="M12 4.5v10M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    upload: '<path d="M12 14.5v-10M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19.5h14"/>',
    paperclip: '<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7-7l8.9-8.9a3.3 3.3 0 0 1 4.7 4.7L9.6 17.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
    warn: '<path d="M12 4.6 2.8 20.2h18.4z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
  };

  function icon(name, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  }

  /* ------------------------------------------------------------ indexeddb */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('litenotes', DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) {
          const s = db.createObjectStore('notes', { keyPath: 'id' });
          s.createIndex('updated_at', 'updated_at');
          s.createIndex('deleted_at', 'deleted_at');
        }
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORES.notes)) {
          const s = db.createObjectStore(STORES.notes, { keyPath: 'key' });
          s.createIndex('by_user_updated_at', ['user_id', 'updated_at']);
          s.createIndex('by_user_deleted_at', ['user_id', 'deleted_at']);
        }
        if (!db.objectStoreNames.contains(STORES.outbox)) db.createObjectStore(STORES.outbox, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const tx = (stores, mode = 'readonly') => state.db.transaction(stores, mode);
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const request = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const scopedKey = (key) => [state.user.id, key];

  // Authentication bootstrap deliberately remains global; every other piece of
  // local state is scoped to the server-issued user id.
  async function meta(key, value) {
    const legacy = key === 'cached_user';
    const storeName = legacy ? 'meta' : STORES.meta;
    const recordKey = legacy ? key : scopedKey(key);
    if (value === undefined) return request(tx([storeName]).objectStore(storeName).get(recordKey)).then((r) => (r ? r.value : undefined));
    const t = tx([storeName], 'readwrite');
    t.objectStore(storeName).put({ key: recordKey, user_id: legacy ? undefined : state.user.id, value });
    return done(t);
  }

  const notesAll = () => request(tx([STORES.notes]).objectStore(STORES.notes).index('by_user_updated_at').getAll(IDBKeyRange.bound([state.user.id, 0], [state.user.id, Number.MAX_SAFE_INTEGER])));
  const outboxAll = () => request(tx([STORES.outbox]).objectStore(STORES.outbox).getAll()).then((rows) => rows.filter((row) => row.user_id === state.user.id));

  // Snapshot the note so a later keystroke mutating state.notes cannot change what
  // lands in the outbox (PRD 9.4: one atomic snapshot per save).
  async function saveLocal(n, queue = true) {
    const snap = persistable(n);
    const stored = { ...snap, key: scopedKey(snap.id), user_id: state.user.id };
    const t = tx([STORES.notes, STORES.outbox], 'readwrite');
    t.objectStore(STORES.notes).put(stored);
    if (queue) t.objectStore(STORES.outbox).put({ key: scopedKey(snap.id), user_id: state.user.id, id: snap.id, mutation_id: snap.mutation_id, note: snap });
    await done(t);
    tabChannel?.postMessage({ type: 'local-change', userId: state.user.id });
    if (queue) navigator.serviceWorker?.ready.then((r) => r.sync?.register('io-notes-outbox')).catch(() => {});
  }

  function normalizeContent(content) {
    return String(content || '')
      .replace(/<u>([\s\S]*?)<\/u>/gi, '_$1_')
      .replace(/^(\s*)-\s+\[\s\]\s+/gm, '$1🟡 ')
      .replace(/^(\s*)-\s+\[[xX]\]\s+/gm, '$1✅ ');
  }

  function canonicalContent(content) {
    return String(content || '')
      .replace(/^(\s*)🟡\s+/gm, '$1- [ ] ')
      .replace(/^(\s*)✅\s+/gm, '$1- [x] ');
  }

  function persistable(n) {
    const { draft, ...rest } = n;
    rest.content = canonicalContent(rest.content);
    rest.is_pinned = !!rest.is_pinned;
    if (rest.is_locked && rest.encrypted_title) {
      return { ...rest, title: '', content: '' };
    }
    return rest;
  }

  // Versions before DB_VERSION stored every account in the same object stores.
  // Import only when the cached identity agrees with the authenticated user; a
  // browser with ambiguous legacy data must not leak it into another account.
  async function migrateLegacyForUser() {
    const cached = await request(tx(['meta']).objectStore('meta').get('cached_user'));
    if (!cached?.value?.id || cached.value.id !== state.user.id) return;
    const marker = await request(tx(['meta']).objectStore('meta').get('legacy_migrated_for'));
    if (marker?.value === state.user.id) return;

    const legacyNotes = await request(tx(['notes']).objectStore('notes').getAll());
    const legacyOutbox = await request(tx(['outbox']).objectStore('outbox').getAll());
    const legacyMeta = await request(tx(['meta']).objectStore('meta').getAll());
    const t = tx([STORES.notes, STORES.outbox, STORES.meta, 'meta'], 'readwrite');
    for (const n of legacyNotes) t.objectStore(STORES.notes).put({ ...n, key: scopedKey(n.id), user_id: state.user.id });
    for (const row of legacyOutbox) t.objectStore(STORES.outbox).put({ ...row, key: scopedKey(row.id), user_id: state.user.id });
    for (const entry of legacyMeta) {
      if (['cached_user', 'legacy_migrated_for'].includes(entry.key)) continue;
      t.objectStore(STORES.meta).put({ key: scopedKey(entry.key), user_id: state.user.id, value: entry.value });
    }
    t.objectStore('meta').put({ key: 'legacy_migrated_for', value: state.user.id });
    await done(t);
  }

  /* ------------------------------------------------------------------ api */

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    } catch {
      // navigator.onLine is not trustworthy (it stays true behind captive portals and
      // after some reloads), so a failed fetch is the real signal that we are offline.
      const err = new Error('Internet connection required for this action.');
      err.offline = true;
      throw err;
    }
    const body = await res.json().catch(() => ({}));
    // Errors carry server_time too, which is exactly what a CLOCK_SKEW rejection
    // needs in order to recalibrate before retrying (PRD 4.5).
    if (typeof body.server_time === 'number') {
      state.clockOffset = body.server_time - Date.now();
      meta('clock_offset_ms', state.clockOffset).catch(() => {});
    }
    if (!res.ok) {
      const err = new Error(body.error?.message || `An error occurred (HTTP ${res.status})`);
      err.status = res.status;
      err.code = body.error?.code;
      if (typeof body.used_bytes === 'number') err.used_bytes = body.used_bytes;
      if (typeof body.quota_bytes === 'number') err.quota_bytes = body.quota_bytes;
      const retryAfter = Number(res.headers.get('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    return body;
  }

  const netMessage = (e) => (e.offline || !state.online ? 'Internet connection required for this action.' : e.message);

  /* ---------------------------------------------------------- attachments */

  const attachmentsOn = () => cfg.attachmentsEnabled === 'true';
  const attachMaxBytes = () => Number(cfg.attachMaxBytes) || 10 * 1024 * 1024;
  const ATTACH_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip';
  const ATTACH_EXT_OK = { jpg: 1, jpeg: 1, png: 1, webp: 1, gif: 1, pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, txt: 1, md: 1, zip: 1 };
  const ATTACH_CONTENT_TYPE = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', md: 'text/markdown', zip: 'application/zip',
  };
  const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
  const attachExt = (name) => (name.lastIndexOf('.') > -1 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
  const humanSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

  // fetch() has no upload progress, so uploads go through XHR. The Content-Type
  // header must equal the type declared at create time: R2 signs it.
  function uploadBytes(url, file, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error('Upload gagal (HTTP ' + xhr.status + ')'), { status: xhr.status })));
      xhr.onerror = () => reject(Object.assign(new Error('Internet connection required for this action.'), { offline: true }));
      xhr.send(file);
    });
  }

  function progressToast(title) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="msg"></span><progress max="100" value="0"></progress>`;
    el.querySelector('.msg').textContent = title;
    host.appendChild(el);
    return {
      update(p) { el.querySelector('progress').value = Math.round(p * 100); },
      done(msg) { el.querySelector('progress').remove(); el.querySelector('.msg').textContent = msg; setTimeout(() => el.remove(), 2500); },
      fail(msg) { el.querySelector('progress').remove(); el.querySelector('.msg').textContent = msg; setTimeout(() => el.remove(), 4000); },
    };
  }

  async function refreshAttachments() {
    if (!attachmentsOn() || !state.online) return;
    try {
      const j = await api('/api/v1/attachments');
      state.attachments = j.attachments || [];
    } catch { /* offline or disabled: keep last copy */ }
  }

  const attachMeta = (id) => state.attachments.find((a) => a.id === id) || null;
  const attachFileURL = (id, dl) => '/api/v1/attachments/' + id + '/download' + (dl ? '?dl=1' : '');
  const attachPreviewURL = (id) => '/api/v1/attachments/' + id + '/download?preview=1';

  /* -------------------------------------------------------------- routing */

  function readRoute() {
    const raw = (location.hash || '').replace(/^#/, '');
    const [path, qs] = raw.split('?');
    const seg = path.split('/').filter(Boolean);
    if (seg[0] === 'reset-note-password') return { view: 'reset', params: new URLSearchParams(qs || '') };
    return { view: seg[0] === 'trash' ? 'trash' : 'notes', noteId: seg[1] || null };
  }

  const hrefFor = (view, noteId) => `#/${view}${noteId ? `/${noteId}` : ''}`;

  function navigate(view, noteId, replace = false) {
    const target = hrefFor(view, noteId);
    if (location.hash === target) return;
    if (replace) location.replace(target);
    else location.hash = target;
  }

  async function onRouteChange() {
    const prev = state.route;
    const next = readRoute();
    const leaving = prev.noteId && prev.noteId !== next.noteId ? prev.noteId : null;
    if (leaving) discardEmptyDraft(leaving);
    state.route = next;
    if (next.view === 'trash') { state.folderFilter = null; state.listMode = 'notes'; }
    if (next.noteId) state.listMode = 'notes';
    if (next.noteId && !state.notes.some((n) => n.id === next.noteId)) {
      navigate(next.view, null, true);
      return;
    }
    // Repaint before flushing: flushSave only reads state (onEdit already mirrored the
    // fields into it), so awaiting first would leave the old note's editor mounted under
    // the new URL and route stray keystrokes into the note we just left.
    paint();
    if (leaving) await flushSave();
  }

  const currentNote = () => (state.route.noteId ? state.notes.find((n) => n.id === state.route.noteId) || null : null);

  /* ------------------------------------------------------------ selectors */

  function visibleNotes() {
    const trash = state.route.view === 'trash';
    const q = state.query.trim().toLowerCase();
    let list = state.notes.filter((n) => (trash ? !!n.deleted_at : !n.deleted_at));
    if (!trash && state.folderFilter) list = list.filter((n) => (n.folder_id || '') === state.folderFilter);
    if (q) {
      list = list.filter((n) => {
        if (isLocked(n)) return false;
        const t = decTitle(n).toLowerCase();
        const c = decContent(n).toLowerCase();
        return t.includes(q) || c.includes(q);
      });
    }
    return list.sort((a, b) => trash ? (b.deleted_at || 0) - (a.deleted_at || 0) : Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at - a.updated_at);
  }

  const folderName = (id) => state.folders.find((f) => f.id === id)?.name || '';

  /* ------------------------------------------------------------ shell DOM */

  const root = $('#app');
  let shellMounted = false;
  let editorKey = '';
  let modalOpen = false;
  let listSig = '';

  function shellHTML() {
    return `
<div class="shell" id="shell" data-pane="list">
  <button class="skip" data-act="focus-content">Skip to editor</button>
  
  <aside class="folder-nav" aria-label="Folder Navigation">
    <div class="side-head">
      <span class="brand-mark" aria-hidden="true"></span>
      <h1 class="brand-name">io-notes</h1>
    </div>
    <div class="search">
      <span class="search-icon">${icon('search', 16)}</span>
      <input id="q" type="search" placeholder="Search notes…" aria-label="Search notes" autocomplete="off" spellcheck="false" enterkeyhint="search">
      <button class="search-clear" data-act="clear-search" aria-label="Clear search" hidden>${icon('x', 15)}</button>
    </div>
    <div class="list-head">
      <span class="list-title">Folders</span>
      <button class="icon-btn sm" data-act="new-folder" aria-label="Create new folder" title="New folder">${icon('plus', 15)}</button>
    </div>
    <div class="list" id="folder-list-desktop" role="list"></div>
    <footer class="side-foot">
      <div class="who">
        <span class="avatar" id="avatar" aria-hidden="true"></span>
        <span class="who-text">
          <span class="who-name" id="who-name"></span>
          <span class="sync" id="sync" data-state="local"><span class="label" id="sync-label" role="status" aria-live="polite"></span></span>
        </span>
      </div>
      <div class="side-actions">
        <button class="icon-btn" data-act="export" aria-label="Export backup" title="Export backup">${icon('download')}</button>
        <button class="icon-btn" data-act="import" aria-label="Import backup" title="Import backup">${icon('upload')}</button>
        <button class="icon-btn" data-act="theme" id="theme-btn" aria-label="Toggle theme"></button>
        <button class="icon-btn" data-act="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
      </div>
    </footer>
  </aside>

  <aside class="sidebar" aria-label="Note List">
    <div class="side-head" id="mobile-side-head">
      <span class="brand-mark" aria-hidden="true"></span>
      <h1 class="brand-name">io-notes</h1>
      <button class="icon-btn accent" data-act="new" aria-label="New note" title="New note (Ctrl+N)">${icon('plus', 20)}</button>
    </div>
    <div class="search" id="mobile-search">
      <span class="search-icon">${icon('search', 16)}</span>
      <input id="q-mobile" type="search" placeholder="Search notes…" aria-label="Search notes" autocomplete="off" spellcheck="false" enterkeyhint="search">
      <button class="search-clear" data-act="clear-search" aria-label="Clear search" hidden>${icon('x', 15)}</button>
    </div>
    <div class="list-head" id="list-head">
      <span class="list-title" id="list-title">Folders</span>
      <button class="icon-btn sm" data-act="new-folder" id="btn-new-folder" aria-label="Create new folder" title="New folder">${icon('plus', 15)}</button>
      <button class="icon-btn accent" data-act="new" id="btn-new-note-desktop" aria-label="New note" title="New note (Ctrl+N)" style="display:none;margin-left:auto">${icon('plus', 20)}</button>
    </div>
    <div class="list" id="list" role="list"></div>
    <footer class="side-foot" id="mobile-foot">
      <div class="who">
        <span class="avatar" id="avatar-mob" aria-hidden="true"></span>
        <span class="who-text">
          <span class="who-name" id="who-name-mob"></span>
          <span class="sync" id="sync-mob" data-state="local"><span class="label" id="sync-label-mob" role="status" aria-live="polite"></span></span>
        </span>
      </div>
      <div class="side-actions">
        <button class="icon-btn" data-act="export" aria-label="Export backup" title="Export backup">${icon('download')}</button>
        <button class="icon-btn" data-act="import" aria-label="Import backup" title="Import backup">${icon('upload')}</button>
        <button class="icon-btn" data-act="theme" id="theme-btn-mob" aria-label="Toggle theme"></button>
        <button class="icon-btn" data-act="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
      </div>
    </footer>
  </aside>
  <section class="editor" id="editor" aria-label="Note Editor"></section>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<dialog class="modal" id="modal"></dialog>`;
  }

  function mountShell() {
    root.innerHTML = shellHTML();
    shellMounted = true;
    editorKey = '';
    listSig = '';

    $('#shell').addEventListener('click', onShellClick);
    const q = $('#q');
    const qMob = $('#q-mobile');
    let queryTimer = null;
    
    const handleSearch = (v) => {
      clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        state.query = v;
        document.querySelectorAll('.search-clear').forEach(el => el.hidden = !v);
        paintList();
      }, 110);
    };

    if (q) {
      q.addEventListener('input', () => handleSearch(q.value));
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && q.value) { e.stopPropagation(); clearSearch(); }
      });
    }
    if (qMob) {
      qMob.addEventListener('input', () => handleSearch(qMob.value));
      qMob.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && qMob.value) { e.stopPropagation(); clearSearch(); }
      });
    }
    paintTheme();
  }

  function onShellClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'new') return void newNote();
    if (act === 'open') return void navigate(state.route.view, el.dataset.id);
    if (act === 'back') return void navigate(state.route.view, null);
    if (act === 'drill-back') return drillBack();
    if (act === 'trash-browse') return drillIntoTrash();
    if (act === 'clear-search') return clearSearch();
    if (act === 'new-folder') return void createFolder();
    if (act === 'folder') return selectFolder(el.dataset.folder || null);
    if (act === 'folder-menu') { e.stopPropagation(); return void folderMenu(el.dataset.folder); }
    if (act === 'theme') return cycleTheme();
    if (act === 'logout') return void confirmLogout();
    if (act === 'export') return void exportData();
    if (act === 'import') return importData();
    if (act === 'delete') return void deleteNote();
    if (act === 'restore') return void restoreNote();
    if (act === 'lock') return void lockMenu();
    if (act === 'move') return void moveNote();
    if (act === 'fmt-bold') return void wrapSelection('**', '**');
    if (act === 'fmt-italic') return void wrapSelection('*', '*');
    if (act === 'fmt-underline') return void wrapSelection('_', '_');
    if (act === 'fmt-check') return void insertListPrefix('🟡 ');
    if (act === 'fmt-bullet') return void insertListPrefix('• ');
    if (act === 'attach') return void attachPick();
    if (act === 'attach-open') return void openAttachment(el.dataset.id);
    if (act === 'attachments') return void attachmentsManager();
    if (act === 'toggle-pin') return void togglePin();
    if (act === 'undo') return applyHistory(null, 'undo');
    if (act === 'redo') return applyHistory(null, 'redo');
    if (act === 'unlock-submit') return void submitUnlock(e);
    if (act === 'forgot') return void requestPasswordReset();
    if (act === 'focus-content') return focusContentEnd();
  }

  /* ---------------------------------------------------------------- paint */

  function paint() {
    if (state.route.view === 'reset') { paintReset(); return; }
    if (!state.user) { paintLogin(); return; }
    if (!shellMounted) {
      mountShell();
    }

    const shell = $('#shell');
    shell.dataset.pane = state.route.noteId ? 'editor' : 'list';
    shell.dataset.view = state.route.view;
    shell.dataset.listMode = state.listMode;

    paintListTitle();
    paintList();
    paintEditor();
    paintIdentity();
  }

  function paintListTitle() {
    if (!shellMounted) return;
    const isDesktop = window.innerWidth >= 1024;
    const el = $('#list-title');
    const btn = $('#btn-new-folder');
    if (!el) return;
    
    if (isDesktop || state.listMode === 'notes') {
      if (btn) btn.hidden = true;
      if (state.route.view === 'trash') { el.textContent = 'Trash'; return; }
      if (state.folderFilter) { el.textContent = folderName(state.folderFilter) || 'Notes'; return; }
      el.textContent = 'All Notes';
      return;
    }

    el.textContent = 'Folders';
    if (btn) btn.hidden = false;
  }

  function paintList() {
    if (!shellMounted) return;
    const isDesktop = window.innerWidth >= 1024;
    
    if (isDesktop) {
      const desktopFolderHost = $('#folder-list-desktop');
      if (desktopFolderHost) {
        desktopFolderHost.innerHTML = folderListHTML();
      }
      const host = $('#list');
      if (host) {
        host.innerHTML = noteListHTML();
      }
      return;
    }
    
    // Mobile / Tablet behavior
    const host = $('#list');
    if (!host) return;

    const html = state.listMode === 'folders' ? folderListHTML() : noteListHTML();

    if (listSig === html) return;
    const top = host.scrollTop;
    const focusedId = document.activeElement?.closest?.('[data-act]')?.dataset?.id
      || document.activeElement?.closest?.('[data-folder]')?.dataset?.folder;
    host.innerHTML = html;
    listSig = html;
    host.scrollTop = top;
    if (focusedId) {
      const next = host.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)
        || host.querySelector(`[data-folder="${CSS.escape(focusedId)}"]`);
      next?.focus({ preventScroll: true });
    }
  }

  function folderListHTML() {
    const active = state.notes.filter((n) => !n.deleted_at);
    const q = state.query.trim().toLowerCase();
    const countFor = (id) => active.filter((n) => (n.folder_id || '') === id).length;
    const trashed = state.notes.filter((n) => n.deleted_at).length;

    let folders = state.folders;
    if (q) folders = folders.filter((f) => f.name.toLowerCase().includes(q));

    const isAllSelected = !state.folderFilter && state.route.view === 'notes';
    const isTrashSelected = state.route.view === 'trash';

    const rows = [];
    // "All Notes" row
    if (!q || 'all notes'.includes(q) || 'semua catatan'.includes(q)) {
      rows.push(`<div class="browse-row" role="listitem" aria-current="${isAllSelected}">
        <button class="browse-main" data-act="folder" data-folder="">
          ${icon('all', 16)}<span class="browse-name">All Notes</span><span class="browse-n">${active.length}</span>
        </button>
      </div>`);
    }
    // Per-folder rows
    for (const f of folders) {
      const isSelected = state.folderFilter === f.id && state.route.view === 'notes';
      rows.push(`<div class="browse-row" role="listitem" aria-current="${isSelected}">
        <button class="browse-main" data-act="folder" data-folder="${esc(f.id)}">
          ${icon('folder', 16)}<span class="browse-name">${esc(f.name)}</span><span class="browse-n">${countFor(f.id)}</span>
        </button>
        <button class="icon-btn sm browse-menu" data-act="folder-menu" data-folder="${esc(f.id)}" aria-label="Manage folder ${esc(f.name)}" title="Manage folder">${icon('more', 15)}</button>
      </div>`);
    }
    // Trash row at the bottom
    if (!q || 'trash'.includes(q) || 'sampah'.includes(q)) {
      rows.push(`<div class="browse-row browse-trash" role="listitem" aria-current="${isTrashSelected}">
        <button class="browse-main" data-act="trash-browse">
          ${icon('trash', 16)}<span class="browse-name">Trash</span><span class="browse-n">${trashed}</span>
        </button>
      </div>`);
    }

    if (!rows.length) return `<div class="list-empty">${icon('search', 22)}<p>No folders match "${esc(state.query.trim())}".</p></div>`;
    return rows.join('');
  }

  function noteListHTML() {
    const notes = visibleNotes();
    const q = state.query.trim();
    const showChip = !state.folderFilter && state.folders.length > 0;
    const isDesktop = window.innerWidth >= 1024;

    // Back affordance row (only for mobile/tablet drill-down)
    const backRow = isDesktop ? '' : `<button class="drill-back" role="listitem" data-act="drill-back" aria-label="Back to folders">
      ${icon('left', 14)}<span>Folders</span>
    </button>`;

    if (!notes.length) return backRow + emptyListHTML();

    return backRow + notes.map((n) => {
      const locked = isLocked(n);
      const title = locked ? 'Locked note' : titleOf(n);
      const snippet = locked ? 'Locked — enter password to unlock' : snippetOf(n) || 'Empty note';
      const when = state.route.view === 'trash' ? n.deleted_at || n.updated_at : n.updated_at;
      const chip = showChip && n.folder_id ? `<span class="chip">${icon('folder', 11)}<span>${esc(folderName(n.folder_id))}</span></span>` : '';
      return `<button class="item" role="listitem" data-act="open" data-id="${esc(n.id)}" aria-current="${state.route.noteId === n.id}">
        <span class="item-row">
          <span class="item-title">${n.is_locked ? `<span class="lock">${icon('lock', 12)}</span>` : ''}${locked ? esc(title) : highlight(title, q)}</span>
          ${n.is_pinned ? `<span class="pin" aria-label="Pinned">${icon('pinFill', 13)}</span>` : ''}
          <time class="item-time" datetime="${new Date(when).toISOString()}">${relTime(when)}</time>
        </span>
        <span class="item-snippet">${locked ? esc(snippet) : highlight(snippet, q)}</span>
        ${chip ? `<span class="item-foot">${chip}</span>` : ''}
      </button>`;
    }).join('');
  }

  function emptyListHTML() {
    if (state.query.trim()) return `<div class="list-empty">${icon('search', 22)}<p>No notes match “${esc(state.query.trim())}”.</p></div>`;
    if (state.route.view === 'trash') return `<div class="list-empty">${icon('trash', 22)}<p>Trash is empty.</p></div>`;
    if (state.folderFilter) return `<div class="list-empty">${icon('folder', 22)}<p>Folder “${esc(folderName(state.folderFilter))}” is empty.</p><button class="btn" data-act="new">Create note</button></div>`;
    return `<div class="list-empty">${icon('note', 22)}<p>No notes yet.</p><button class="btn primary" data-act="new">Create note</button></div>`;
  }

  function paintIdentity() {
    const u = state.user;
    
    const dName = $('#who-name');
    const dAvatar = $('#avatar');
    const titleText = u.name && u.email ? `${u.name} (${u.email})` : u.name || u.email || '';
    if (dName) {
      dName.textContent = u.name || u.email || 'Account';
      dName.title = titleText;
      if (dName.parentElement) dName.parentElement.title = titleText;
    }
    const initials = (u.name || u.email || '?').trim().slice(0, 1).toUpperCase();
    if (dAvatar && dAvatar.dataset.for !== u.id) {
      dAvatar.dataset.for = u.id;
      dAvatar.textContent = initials;
      dAvatar.style.backgroundImage = u.picture_url ? `url("${encodeURI(u.picture_url)}")` : '';
    }
    
    const mName = $('#who-name-mob');
    const mAvatar = $('#avatar-mob');
    if (mName) {
      mName.textContent = u.name || u.email || 'Account';
      mName.title = titleText;
      if (mName.parentElement) mName.parentElement.title = titleText;
    }
    if (mAvatar && mAvatar.dataset.for !== u.id) {
      mAvatar.dataset.for = u.id;
      mAvatar.textContent = initials;
      mAvatar.style.backgroundImage = u.picture_url ? `url("${encodeURI(u.picture_url)}")` : '';
    }
  }

  /* --------------------------------------------------------------- editor */

  // `is_locked` is part of the key too: locking a note you just unlocked keeps the
  // editor open but must still flip the header's lock affordance.
  function editorKeyFor(n) {
    if (!n) return `empty:${state.route.view}`;
    return `note:${n.id}:${n.is_locked ? 'pw' : 'nopw'}:${isLocked(n) ? 'locked' : 'open'}:${n.deleted_at ? 'trash' : 'live'}`;
  }

  function paintEditor() {
    const host = $('#editor');
    const n = currentNote();
    const key = editorKeyFor(n);
    if (key !== editorKey) {
      editorKey = key;
      host.innerHTML = editorHTML(n);
      wireEditor(n);
    } else {
      refreshEditorChrome(n);
    }
  }

  function editorHTML(n) {
    if (!n) {
      return state.route.view === 'trash'
        ? `<div class="state"><span class="state-icon">${icon('trash', 24)}</span><h2>Trash</h2><p>Select a note to restore it. Trashed notes do not appear in the main list.</p></div>`
        : `<div class="state"><span class="state-icon">${icon('note', 24)}</span><h2>No note selected</h2><p>Select a note from the list or create a new one.</p><button class="btn primary" data-act="new">${icon('plus', 16)} New note</button></div>`;
    }

    const head = (extra) => `<header class="editor-head">
      <button class="icon-btn back" data-act="back" aria-label="Back to list">${icon('left', 20)}</button>${extra}
    </header>`;

    if (isLocked(n)) {
      return head(`<span class="crumb"><span class="name">Locked note</span></span><span class="head-spacer"></span>`) +
        `<div class="state">
           <span class="state-icon">${icon('lock', 24)}</span>
           <h2>This note is locked</h2>
           <p>Enter the note password to unlock it. Unlocking requires internet connection.</p>
           <form data-act="unlock-submit">
             <input id="note-password" type="password" placeholder="Note password" autocomplete="current-password" aria-label="Note password">
             <p class="err" id="unlock-error" role="alert"></p>
             <button class="btn primary" type="submit">Unlock note</button>
             <button class="btn ghost" type="button" data-act="forgot">Forgot password? Send reset link</button>
           </form>
         </div>`;
    }

    const inTrash = !!n.deleted_at;
    const crumb = inTrash
      ? `<span class="crumb">${icon('trash', 15)}<span class="name">In Trash</span></span>`
      : `<button class="crumb" data-act="move" title="Move to folder">${icon(n.folder_id ? 'folder' : 'all', 15)}<span class="name">${esc(n.folder_id ? folderName(n.folder_id) : 'No folder')}</span></button>`;

    const actions = inTrash
      ? `<button class="btn" data-act="restore">${icon('restore', 15)} Restore</button>`
      : `${attachmentsOn() ? `<button class="icon-btn" data-act="attachments" aria-label="Manage attachments" title="Attachments">${icon('paperclip')}</button>` : ''}<button class="icon-btn ${n.is_locked ? 'on' : ''}" data-act="lock" aria-label="${n.is_locked ? 'Manage note lock' : 'Lock note with password'}" title="${n.is_locked ? 'Locked note' : 'Lock note'}">${icon(n.is_locked ? 'lock' : 'unlock')}</button>
         <button class="icon-btn danger" data-act="delete" aria-label="Move note to Trash" title="Move to Trash">${icon('trash')}</button>`;

    const formatBar = inTrash ? '' : `<div class="format-bar" role="toolbar" aria-label="Formatting">
      <div class="history-actions">
        <button type="button" data-act="undo" title="Undo (Cmd+Z)" aria-label="Undo" disabled>${icon('undo', 15)}</button>
        <button type="button" data-act="redo" title="Redo (Cmd+Shift+Z)" aria-label="Redo" disabled>${icon('redo', 15)}</button>
      </div>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="fmt-bold" title="Bold (Cmd+B)" aria-label="Bold">${icon('bold', 16)}</button>
      <button type="button" data-act="fmt-italic" title="Italic (Cmd+I)" aria-label="Italic">${icon('italic', 16)}</button>
      <button type="button" data-act="fmt-underline" title="Underline" aria-label="Underline">${icon('underline', 16)}</button>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="fmt-check" title="Checklist" aria-label="Checklist">${icon('checkCircle', 16)}</button>
      <button type="button" data-act="fmt-bullet" title="Bullet list" aria-label="Bullet list">${icon('list', 16)}</button>
      ${attachmentsOn() ? `<button type="button" data-act="attach" title="Attach file" aria-label="Attach file">${icon('paperclip', 16)}</button>` : ''}
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="toggle-pin" class="${n.is_pinned ? 'on' : ''}" title="${n.is_pinned ? 'Unpin' : 'Pin'}" aria-label="${n.is_pinned ? 'Unpin' : 'Pin'}">${icon(n.is_pinned ? 'pinFill' : 'pin', 16)}</button>
    </div>`;

    return head(`${crumb}<span class="head-spacer"></span><span class="save-state" id="save-state"></span><div class="actions">${actions}</div>`) +
      formatBar +
      `<div class="editor-body">
         <div class="page">
           <textarea class="title" id="title" rows="1" maxlength="${MAX_TITLE}" placeholder="Title" aria-label="Note title" spellcheck="false" ${inTrash ? 'readonly' : ''}></textarea>
           <div class="content-wrap">
             <div class="content-render" id="content-render" aria-hidden="true"></div>
             <textarea class="content" id="content" placeholder="Start writing…" aria-label="Note content" ${inTrash ? 'readonly' : ''}></textarea>
           </div>
         </div>
       </div>
       <footer class="editor-foot">
         <span id="meta-words"></span><span class="sep"></span><span id="meta-time"></span>
       </footer>`;
  }

  function wireEditor(n) {
    if (!n) return;
    const title = $('#title');
    const content = $('#content');
    if (!title || !content) {
      if (isLocked(n)) $('#note-password')?.focus({ preventScroll: true });
      return;
    }
    const d = state.decrypted[n.id];
    title.value = d?.title ?? n.title;
    content.value = normalizeContent(d?.content ?? n.content);
    renderContentOverlay(content.value);
    autoGrow(title);
    if (!n.deleted_at) {
      title.addEventListener('input', onEdit);
      content.addEventListener('input', onEdit);
      title.addEventListener('blur', () => void flushSave());
      content.addEventListener('blur', () => void flushSave());
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); content.focus(); content.setSelectionRange(0, 0); }
      });
      content.addEventListener('keydown', onContentKeydown);
      content.addEventListener('scroll', () => {
        const render = $('#content-render');
        if (render) { render.scrollTop = content.scrollTop; render.scrollLeft = content.scrollLeft; }
      });
      $('#content-render')?.addEventListener('click', (ev) => {
        const slot = ev.target.closest('.mark-slot');
        if (!slot) return;
        const lineEl = slot.closest('.content-line');
        toggleChecklistLine(Array.prototype.indexOf.call(lineEl.parentNode.children, lineEl));
      });
    }
    refreshEditorChrome(n);
    updateHistoryButtons();
  }

  // Grow the title up to the CSS max-height, then let it scroll.
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function formatInline(text) {
    return esc(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1<u>$2</u>')
      .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  }

  function renderContentOverlay(value) {
    const host = $('#content-render');
    if (!host) return;
    host.innerHTML = String(value || '').split('\n').map((line) => {
      const am = /^!\[([^\]]*)\]\(attach:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/.exec(line);
      if (am) return `<div class="content-line">${attachCardHTML(am[1], am[2])}</div>`;
      const m = /^(\s*)(🟡|✅)(\s+)(.*)$/.exec(line);
      if (!m) return `<div class="content-line">${formatInline(line) || '&nbsp;'}</div>`;
      const mark = m[2] === '✅' ? 'checklist-done' : 'checklist-empty';
      const done = m[2] === '✅' ? ' done' : '';
      return `<div class="content-line checklist-line">${m[1]}<span class="mark-slot">${m[2]}<span class="${mark}" aria-hidden="true">${m[2] === '✅' ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.8 4.6 4.6L19 7.6"/></svg>' : ''}</span></span>${m[3]}<span class="cl-text${done}">${formatInline(m[4]) || '&nbsp;'}</span></div>`;
    }).join('');
  }

  // Attachment embeds render as editable-title links; clicking opens a modal view.
  function attachCardHTML(name, id) {
    const meta = attachMeta(id);
    if (!state.online) return `<span class="attach-slot attach-offline" data-attach="${id}">${icon('cloud', 14)}<span class="attach-name">${esc(name)}</span></span>`;
    if (!meta) return `<span class="attach-slot attach-missing" data-act="attach-open" data-id="${id}">${icon('trash', 14)}<span class="attach-name">${esc(name)}</span></span>`;
    return `<span class="attach-slot attach-link" data-act="attach-open" data-id="${id}" title="${esc(meta.filename)} · ${humanSize(meta.size_bytes)}">${icon('paperclip', 14)}<span class="attach-name">${esc(name)}</span></span>`;
  }

  function rerenderOverlay() {
    const c = $('#content');
    if (c) renderContentOverlay(c.value);
  }

  // A deliberately small Markdown renderer for attachment previews. It starts
  // by escaping every source character and only emits a known-safe HTML subset;
  // uploaded HTML is never interpreted. Remote images are shown as labels so a
  // preview cannot silently make tracking requests.
  function markdownInline(source) {
    const code = [];
    let out = esc(source).replace(/`([^`\n]+)`/g, (_, value) => {
      const token = `\uE000${code.length}\uE001`;
      code.push(`<code>${value}</code>`);
      return token;
    });
    out = out
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '<span class="md-image-label">[Image: $1]</span>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s()]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1<em>$2</em>');
    return out.replace(/\uE000(\d+)\uE001/g, (_, i) => code[Number(i)] || '');
  }

  function renderMarkdown(source) {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let codeLines = null;
    let codeLanguage = '';
    let list = '';
    let listClass = '';
    const closeList = () => {
      if (!list) return;
      html.push(`</${list}>`);
      list = '';
      listClass = '';
    };
    const openList = (type, className = '') => {
      if (list === type && listClass === className) return;
      closeList();
      list = type;
      listClass = className;
      html.push(`<${type}${className ? ` class="${className}"` : ''}>`);
    };

    for (const line of lines) {
      const fence = /^\s*```\s*([^\s`]*)/.exec(line);
      if (fence) {
        if (codeLines) {
          const language = codeLanguage ? `<span class="md-code-language">${esc(codeLanguage)}</span>` : '';
          html.push(`<pre class="md-code">${language}<code>${esc(codeLines.join('\n'))}</code></pre>`);
          codeLines = null;
          codeLanguage = '';
        } else {
          closeList();
          codeLines = [];
          codeLanguage = fence[1] || '';
        }
        continue;
      }
      if (codeLines) { codeLines.push(line); continue; }

      let m = /^(#{1,6})\s+(.+)$/.exec(line);
      if (m) { closeList(); const level = m[1].length; html.push(`<h${level}>${markdownInline(m[2])}</h${level}>`); continue; }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { closeList(); html.push('<hr>'); continue; }
      m = /^\s*>\s?(.*)$/.exec(line);
      if (m) { closeList(); html.push(`<blockquote>${markdownInline(m[1]) || '&nbsp;'}</blockquote>`); continue; }
      m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
      if (m) {
        openList('ul', 'md-task-list');
        html.push(`<li><input type="checkbox" disabled${m[1].toLowerCase() === 'x' ? ' checked' : ''}><span>${markdownInline(m[2])}</span></li>`);
        continue;
      }
      m = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (m) { openList('ul'); html.push(`<li>${markdownInline(m[1])}</li>`); continue; }
      m = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (m) { openList('ol'); html.push(`<li>${markdownInline(m[1])}</li>`); continue; }
      closeList();
      if (!line.trim()) html.push('<div class="md-space"></div>');
      else html.push(`<p>${markdownInline(line)}</p>`);
    }
    closeList();
    if (codeLines) {
      const language = codeLanguage ? `<span class="md-code-language">${esc(codeLanguage)}</span>` : '';
      html.push(`<pre class="md-code">${language}<code>${esc(codeLines.join('\n'))}</code></pre>`);
    }
    return html.join('');
  }

  function attachmentPreviewHTML(meta, id) {
    if (meta.kind === 'image') {
      return `<img class="attach-preview" src="${esc(attachFileURL(id, false))}" alt="${esc(meta.filename)}">`;
    }
    if (meta.content_type === 'application/pdf') {
      return `<iframe class="attach-preview-frame" src="${esc(attachPreviewURL(id))}" title="Preview ${esc(meta.filename)}"></iframe>`;
    }
    if (meta.content_type === 'text/markdown' || meta.content_type === 'text/plain') {
      return `<div class="attach-preview-text" data-attachment-preview="${esc(id)}"><span class="spinner"></span><span>Memuat preview…</span></div>`;
    }
    return `<div class="attach-preview-doc">${icon('note', 28)}<span>Preview belum tersedia untuk jenis file ini.</span><small>File tetap dapat di-download.</small></div>`;
  }

  async function loadTextAttachmentPreview(meta, id, host) {
    if (!host) return;
    if (meta.size_bytes > MAX_TEXT_PREVIEW_BYTES) {
      host.classList.add('attach-preview-message');
      host.innerHTML = `<strong>File terlalu besar untuk preview.</strong><span>Batas preview teks ${humanSize(MAX_TEXT_PREVIEW_BYTES)}. File tetap dapat di-download.</span>`;
      return;
    }
    try {
      const response = await fetch(attachPreviewURL(id), { headers: { Accept: meta.content_type } });
      if (!response.ok) throw new Error('Preview gagal dimuat (HTTP ' + response.status + ')');
      const text = await response.text();
      if (!host.isConnected) return;
      if (meta.content_type === 'text/markdown') {
        host.classList.add('markdown-preview');
        host.innerHTML = renderMarkdown(text);
      } else {
        host.classList.add('plain-text-preview');
        host.textContent = text;
      }
    } catch (e) {
      if (!host.isConnected) return;
      host.classList.add('attach-preview-message');
      host.innerHTML = `<strong>Preview tidak dapat dimuat.</strong><span>${esc(netMessage(e))}</span>`;
    }
  }

  async function openAttachment(id) {
    const meta = attachMeta(id);
    if (!meta) {
      const clean = await modal({ title: 'Attachment tidak tersedia', description: 'Lampiran sudah dihapus. Hapus referensi dari note?', confirmText: 'Hapus referensi', danger: true });
      if (clean) { await removeAttachmentRefs(id); rerenderOverlay(); }
      return;
    }
    if (!state.online) { toast('Internet connection required for this action.'); return; }
    const preview = attachmentPreviewHTML(meta, id);
    const result = modal({
      title: meta.filename,
      previewHTML: preview,
      description: `${humanSize(meta.size_bytes)} · ${meta.content_type}`,
      choices: [{ value: 'download', label: 'Download', icon: 'download' }],
      cancelText: 'Close',
      wide: true,
    });
    const previewHost = document.querySelector(`[data-attachment-preview="${id}"]`);
    if (previewHost) void loadTextAttachmentPreview(meta, id, previewHost);
    const act = await result;
    if (act === 'download') {
      const a = document.createElement('a');
      a.href = attachFileURL(id, true);
      a.download = meta.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  function insertAttachmentRef(att) {
    const c = $('#content');
    if (!c) return;
    const ref = `\n![${att.filename}](attach:${att.id})\n`;
    const s = c.selectionStart ?? c.value.length;
    const e = c.selectionEnd ?? s;
    c.value = c.value.slice(0, s) + ref + c.value.slice(e);
    c.selectionStart = c.selectionEnd = s + ref.length;
    c.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Deleting an attachment also removes its embed references so notes never show
  // dangling raw markdown on any client.
  async function removeAttachmentRefs(id) {
    const lineRe = new RegExp(`^!\\[[^\\]]*\\]\\(attach:${id}\\)[ \\t]*$`);
    const inlineRe = new RegExp(`!?\\[[^\\]]*\\]\\(attach:${id}\\)`, 'g');
    let touchedOpen = false;
    for (const n of state.notes) {
      if (n.deleted_at || !n.content || !n.content.includes(id)) continue;
      const next = n.content.split('\n').filter((l) => !lineRe.test(l)).join('\n').replace(inlineRe, '');
      if (next === n.content) continue;
      n.content = next;
      n.updated_at = stamp(n.updated_at);
      n.mutation_id = uid();
      await saveLocal(n);
      if (currentNote()?.id === n.id) touchedOpen = true;
    }
    if (touchedOpen) {
      const c = $('#content');
      if (c) { c.value = currentNote().content; renderContentOverlay(c.value); }
    }
    paintList();
    scheduleSync();
  }

  async function attachPick() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    if (!state.online) { toast('Internet connection required for this action.'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ATTACH_ACCEPT;
    input.id = 'attach-input';
    input.style.display = 'none';
    $('#attach-input')?.remove();
    document.body.appendChild(input);
    input.onchange = () => { const files = [...input.files]; input.remove(); void uploadFiles(n, files); };
    input.click();
  }

  async function uploadFiles(note, files) {
    for (const file of files) {
      const ext = attachExt(file.name);
      if (!ATTACH_EXT_OK[ext]) { toast(`Jenis file .${ext || '?'} tidak didukung`); continue; }
      if (file.size > attachMaxBytes()) { toast(`"${file.name}" melebihi batas ${Math.round(attachMaxBytes() / 1048576)} MB`); continue; }
      // File.type is empty or inconsistent for Markdown on several browsers.
      // Canonicalising from the already allowlisted extension also guarantees
      // that the signed upload and the create request use the exact same MIME.
      const contentType = ATTACH_CONTENT_TYPE[ext];
      const pt = progressToast(`Mengupload ${file.name}…`);
      let attId = null;
      try {
        const created = await api('/api/v1/attachments', { method: 'POST', body: JSON.stringify({ filename: file.name, content_type: contentType, size_bytes: file.size }) });
        attId = created.attachment.id;
        await uploadBytes(created.upload_url, file, contentType, (p) => pt.update(p));
        await api('/api/v1/attachments/' + attId + '/confirm', { method: 'POST', body: '{}' });
        await refreshAttachments();
        insertAttachmentRef(created.attachment);
        pt.done(`${file.name} terupload`);
      } catch (e) {
        if (attId) api('/api/v1/attachments/' + attId, { method: 'DELETE' }).catch(() => {});
        pt.fail(netMessage(e) + (e.code === 'QUOTA_EXCEEDED' && e.quota_bytes ? ` (${humanSize(e.used_bytes)} / ${humanSize(e.quota_bytes)})` : ''));
      }
    }
  }

  async function attachmentsManager() {
    if (!attachmentsOn()) return;
    await refreshAttachments();
    const choices = [{ value: '__new', label: 'Upload file baru…', icon: 'upload' }];
    for (const a of state.attachments) {
      choices.push({ value: a.id, label: `${a.filename} · ${humanSize(a.size_bytes)}`, icon: 'paperclip' });
    }
    const pick = await modal({ title: 'Attachments', choices, emptyText: 'Belum ada lampiran.', cancelText: 'Close' });
    if (!pick || pick === '__new') {
      if (pick === '__new') return void attachPick();
      return;
    }
    const act = await modal({
      title: 'Attachment',
      choices: [
        { value: 'download', label: 'Download', icon: 'download' },
        { value: 'delete', label: 'Delete', icon: 'trash', danger: true },
      ],
      cancelText: 'Cancel',
    });
    if (act === 'download') return void openAttachment(pick);
    if (act === 'delete') {
      const sure = await modal({ title: 'Delete attachment?', description: 'Referensi di note ikut dihapus.', confirmText: 'Delete', danger: true });
      if (!sure) return;
      try {
        await api('/api/v1/attachments/' + pick, { method: 'DELETE' });
        state.attachments = state.attachments.filter((a) => a.id !== pick);
        await removeAttachmentRefs(pick);
        rerenderOverlay();
        toast('Attachment dihapus');
      } catch (e) {
        toast(netMessage(e));
      }
    }
  }

  // Apple Notes-style: clicking the circle toggles the line's checklist marker.
  function toggleChecklistLine(idx) {
    const c = $('#content');
    if (!c) return;
    const lines = c.value.split('\n');
    const line = lines[idx];
    if (line == null) return;
    const m = /^(\s*)(🟡|✅)/.exec(line);
    if (!m) return;
    const next = m[2] === '🟡' ? '✅' : '🟡';
    lines[idx] = m[1] + next + line.slice(m[0].length);
    let linePos = 0;
    for (let i = 0; i < idx; i++) linePos += lines[i].length + 1;
    let caret = c.selectionStart;
    const markerPos = linePos + m[1].length;
    if (caret > markerPos) caret += next.length - m[2].length;
    applyEdit(c, lines.join('\n'), caret);
  }

  function refreshEditorChrome(n) {
    if (!n) return;
    const title = $('#title');
    const content = $('#content');
    if (!title || !content) return;

    const d = state.decrypted[n.id];
    const nTitle = d?.title ?? n.title;
    const nContent = normalizeContent(d?.content ?? n.content);
    renderContentOverlay(content.value || nContent);

    // Keep active input only while its local mutation is pending. Once sync has
    // merged the authoritative note, refresh the DOM even if the field remains focused.
    if (dirtyId !== n.id) {
      if (title.value !== nTitle) { title.value = nTitle; autoGrow(title); }
      if (content.value !== nContent) content.value = nContent;
    }

    const crumbName = $('.crumb .name');
    if (crumbName && !n.deleted_at) crumbName.textContent = n.folder_id ? folderName(n.folder_id) : 'No folder';

    const words = wordsOf(content.value);
    $('#meta-words').textContent = `${words} words · ${content.value.length} characters`;
    const when = n.deleted_at || n.updated_at;
    const meta = $('#meta-time');
    meta.textContent = `${n.deleted_at ? 'Deleted' : 'Modified'} ${relTime(when)}`;
    meta.title = fullTime(when);
  }

  function wrapSelection(prefix, suffix) {
    const c = $('#content');
    if (!c) return;
    const start = c.selectionStart;
    const end = c.selectionEnd;
    const selected = c.value.slice(start, end) || 'text';
    c.value = c.value.slice(0, start) + prefix + selected + suffix + c.value.slice(end);
    c.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.focus();
  }

  function insertListPrefix(prefix) {
    const c = $('#content');
    if (!c) return;
    const { value } = c;
    const s = c.selectionStart;
    const e = c.selectionEnd;
    const blockStart = value.lastIndexOf('\n', s - 1) + 1;
    let blockEnd = value.indexOf('\n', e);
    if (blockEnd === -1) blockEnd = value.length;
    const block = value.slice(blockStart, blockEnd);
    const changed = block.split('\n').map((l) => (!l.trim() || l.startsWith(prefix)) ? l : prefix + l).join('\n');
    if (changed === block) return;
    applyEditRange(c, value.slice(0, blockStart) + changed + value.slice(blockEnd), blockStart + changed.length, blockStart + changed.length);
    c.focus();
  }

  async function togglePin() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    n.is_pinned = !n.is_pinned;
    n.updated_at = stamp(n.updated_at);
    n.mutation_id = uid();
    await saveLocal(n);
    paint();
    scheduleSync();
  }

  /* ------------------------------------------------------- backup export */

  function crc32(bytes) {
    if (!crc32.table) {
      crc32.table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc32.table[i] = c;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crc32.table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Minimal ZIP writer (method 0/store) so a backup is one downloadable file.
  function buildZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const en of entries) {
      const name = enc.encode(en.name);
      const data = enc.encode(en.text);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const chunk of all) { out.set(chunk, p); p += chunk.length; }
    return out;
  }

  async function exportData() {
    const entries = [];
    const used = new Map();
    const backup = { app: 'litenotes', version: 1, exported_at: new Date().toISOString(), folders: state.folders.map((f) => ({ id: f.id, name: f.name })), notes: [] };
    let skippedLocked = 0;
    for (const n of state.notes) {
      if (n.deleted_at) continue;
      const d = state.decrypted[n.id];
      if (n.is_locked && !d) { skippedLocked++; continue; }
      const title = d?.title ?? n.title;
      const content = d?.content ?? n.content;
      let name = String(title || 'untitled').replace(/[\/\\:*?"<>|]/g, '-').trim().slice(0, 60) || 'untitled';
      used.set(name, (used.get(name) || 0) + 1);
      if (used.get(name) > 1) name += `-${used.get(name)}`;
      const folder = n.folder_id ? folderName(n.folder_id) : '';
      entries.push({ name: `notes/${name}.md`, text: `---\ntitle: ${JSON.stringify(title)}\nfolder: ${JSON.stringify(folder)}\ncreated_at: ${n.created_at}\nupdated_at: ${n.updated_at}\npinned: ${!!n.is_pinned}\n---\n\n${canonicalContent(content)}` });
      backup.notes.push({ id: n.id, title, content, folder_id: n.folder_id || null, is_pinned: !!n.is_pinned, created_at: n.created_at, updated_at: n.updated_at });
    }
    entries.push({ name: 'litenotes-backup.json', text: JSON.stringify(backup, null, 2) });
    const blob = new Blob([buildZip(entries)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `litenotes-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(skippedLocked ? `Backup downloaded · ${skippedLocked} locked note(s) skipped (unlock first)` : 'Backup downloaded');
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => void (async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== 'litenotes' || !Array.isArray(data.notes)) throw new Error('file bukan backup litenotes');
        let folders = 0;
        for (const f of data.folders || []) {
          if (!f?.id || !f?.name || state.folders.some((x) => x.id === f.id)) continue;
          state.folders.push({ id: f.id, name: f.name, created_at: Date.now() });
          folders++;
        }
        if (folders) { state.folders.sort((a, b) => a.name.localeCompare(b.name, 'id')); await meta('folders', state.folders); }
        let count = 0;
        for (const nn of data.notes || []) {
          if (!nn?.id) continue;
          const existing = state.notes.find((x) => x.id === nn.id);
          if (existing && (existing.updated_at || 0) >= (nn.updated_at || 0)) continue;
          const n = existing || { id: nn.id };
          Object.assign(n, {
            title: String(nn.title ?? ''), content: normalizeContent(nn.content ?? ''),
            folder_id: nn.folder_id || null, is_pinned: !!nn.is_pinned, deleted_at: null, draft: false,
            created_at: nn.created_at || Date.now(), updated_at: nn.updated_at || Date.now(),
            mutation_id: uid(), is_locked: false, encrypted_title: '', encrypted_content: '', enc_iv: '', enc_content_iv: '',
          });
          if (!existing) state.notes.push(n);
          await saveLocal(n);
          count++;
        }
        paint();
        scheduleSync();
        toast(count ? `${count} note(s) imported` : 'Tidak ada note baru untuk diimpor');
      } catch (e) {
        toast(`Import gagal: ${e.message}`);
      }
    })();
    input.click();
  }

  function setSaveState(kind) {
    const el = $('#save-state');
    if (!el) return;
    el.dataset.state = kind;
    el.textContent = kind === 'saving' ? 'Saving…' : kind === 'saved' ? 'Saved' : '';
  }

  function focusContentEnd() {
    const c = $('#content');
    if (!c) return;
    c.focus();
    c.setSelectionRange(c.value.length, c.value.length);
  }

  /* ------------------------------------------------------- edit + autosave */

  let dirtyId = null;
  let dirtyVersion = 0;
  let saveTimer = null;
  let saveTimerSeq = 0;
  let listTimer = null;
  let flushChain = Promise.resolve();

  function updateHistoryButtons() {
    const h = history.get(currentNote()?.id);
    const undo = $('[data-act="undo"]');
    const redo = $('[data-act="redo"]');
    if (undo) undo.disabled = !h?.undo.length;
    if (redo) redo.disabled = !h?.redo.length;
  }

  function rememberEdit(n, title, content) {
    let h = history.get(n.id);
    if (!h) {
      h = { undo: [], redo: [], last: { title, content } };
      history.set(n.id, h);
    }
    if (h.last.title === title && h.last.content === content) return;
    h.undo.push(h.last);
    if (h.undo.length > 100) h.undo.shift();
    h.last = { title, content };
    h.redo = [];
    updateHistoryButtons();
  }

  function applyHistory(snapshot, direction) {
    const n = currentNote();
    const c = $('#content');
    const title = $('#title');
    if (!n || !c || !title) return;
    const h = history.get(n.id);
    if (!h) return;
    const current = { title: title.value, content: c.value };
    const target = direction === 'undo' ? h.undo.pop() : h.redo.pop();
    if (!target) return;
    if (direction === 'undo') h.redo.push(current); else h.undo.push(current);
    h.last = target;
    title.value = target.title;
    c.value = target.content;
    autoGrow(title);
    c.focus();
    c.setSelectionRange(c.value.length, c.value.length);
    n.title = target.title;
    n.content = target.content;
    n.draft = false;
    dirtyId = n.id;
    dirtyVersion += 1;
    setSaveState('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(++saveTimerSeq), 600);
    updateHistoryButtons();
  }

  function onEdit() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    const title = $('#title');
    const content = $('#content');
    rememberEdit(n, title.value, content.value);
    n.title = title.value;
    n.content = content.value;
    n.draft = false;
    dirtyId = n.id;
    dirtyVersion += 1;
    if (n.is_locked && state.unlocked[n.id]) {
      state.decrypted[n.id] = { title: title.value, content: content.value };
    }
    renderContentOverlay(content.value);
    autoGrow(title);
    setSaveState('saving');
    clearTimeout(saveTimer);
    const seq = ++saveTimerSeq;
    saveTimer = setTimeout(() => void flushSave(seq), 600);
    clearTimeout(listTimer);
    listTimer = setTimeout(() => { paintList(); refreshEditorChrome(currentNote()); }, 250);
  }

  // Flush the latest dirty note to IndexedDB. Timers and lifecycle events can
  // overlap, so every queued flush reads current state when it actually runs.
  async function flushSave(seq = null) {
    if (seq === null) ++saveTimerSeq;
    clearTimeout(saveTimer);
    saveTimer = null;
    const id = dirtyId;
    const version = dirtyVersion;
    if (!id) return;

    flushChain = flushChain.catch(() => {}).then(async () => {
      const current = state.notes.find((x) => x.id === id);
      if (!current || dirtyId !== id || dirtyVersion !== version) return;
      const snapshot = { title: current.title, content: current.content, updated_at: current.updated_at, created_at: current.created_at, deleted_at: current.deleted_at, mutation_id: current.mutation_id, folder_id: current.folder_id, is_locked: current.is_locked, encrypted_title: current.encrypted_title, encrypted_content: current.encrypted_content, enc_iv: current.enc_iv, enc_content_iv: current.enc_content_iv };

      const plainContent = state.decrypted[id]?.content ?? snapshot.content;
      if (overContentLimit(plainContent)) {
        setSaveState('');
        setSync('error', 'Note too large');
        toast('Note exceeds 1 MB limit and cannot be saved. Split it into multiple notes.', { duration: 0 });
        return;
      }
      if (current.is_locked && state._keys[id] && state.decrypted[id]) {
        const key = state._keys[id];
        const d = state.decrypted[id];
        const etitle = await encryptText(d.title, key);
        const econtent = await encryptText(d.content, key);
        current.encrypted_title = etitle.ct;
        current.encrypted_content = econtent.ct;
        current.enc_iv = etitle.iv;
        current.enc_content_iv = econtent.iv;
      }
      if (current.title === snapshot.title && current.content === snapshot.content) {
        current.updated_at = stamp(current.updated_at);
      }
      try {
        await saveLocal(current);
      } catch (error) {
        setSaveState('');
        setSync('error', 'Save failed — retry');
        toast('Could not save this note locally. Please try again.', { duration: 0 });
        throw error;
      }
      if (dirtyId === id && dirtyVersion === version) {
        dirtyId = null;
        setSaveState('saved');
      }
      paintList();
      refreshEditorChrome(currentNote());
      scheduleSync();
    });
    return flushChain;
  }

  // A brand-new note stays in memory until the first keystroke (PRD 11.4).
  function discardEmptyDraft(id) {
    const i = state.notes.findIndex((n) => n.id === id);
    if (i < 0) return;
    const n = state.notes[i];
    if (n.draft && !n.title.trim() && !n.content.trim()) state.notes.splice(i, 1);
  }

  function newNote() {
    const created = stamp();
    const n = {
      id: uid(), title: '', content: '', folder_id: state.folderFilter || '',
      created_at: created, updated_at: created, deleted_at: null,
      mutation_id: uid(), revision: 0, server_updated_at: 0, is_locked: false, draft: true,
    };
    state.notes.push(n);
    state.listMode = 'notes';
    if (state.route.view !== 'notes') { state.route = { view: 'notes', noteId: null }; }
    navigate('notes', n.id);
    requestAnimationFrame(() => $('#title')?.focus({ preventScroll: true }));
  }

  async function deleteNote() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    await flushSave();
    n.updated_at = stamp(n.updated_at);
    n.deleted_at = n.updated_at;
    n.mutation_id = uid();
    n.draft = false; // it now exists in the outbox; never garbage-collect it as an empty draft
    await saveLocal(n);

    const remaining = state.notes.filter((x) => !x.deleted_at && (!state.folderFilter || (x.folder_id || '') === state.folderFilter))
      .sort((a, b) => b.updated_at - a.updated_at);
    const toList = window.matchMedia('(max-width:767px)').matches;
    navigate('notes', toList ? null : remaining[0]?.id || null, true);
    paint();
    scheduleSync();
    toast('Note moved to Trash', { actionLabel: 'Undo', onAction: () => void undelete(n.id) });
  }

  async function undelete(id) {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    n.updated_at = stamp(n.updated_at);
    n.deleted_at = null;
    n.mutation_id = uid();
    await saveLocal(n);
    navigate('notes', n.id);
    paint();
    scheduleSync();
  }

  async function restoreNote() {
    const n = currentNote();
    if (!n || !n.deleted_at) return;
    await undelete(n.id);
    toast('Note restored');
  }

  /* --------------------------------------------------------------- folders */

  function selectFolder(id) {
    state.folderFilter = id || null;
    if (window.innerWidth < 1024) {
      state.listMode = 'notes';
    }
    state.query = '';
    const q = $('#q');
    const qMob = $('#q-mobile');
    if (q) { q.value = ''; }
    if (qMob) { qMob.value = ''; }
    document.querySelectorAll('.search-clear').forEach(el => el.hidden = true);
    
    const current = currentNote();
    const matchesFolder = current && !current.deleted_at && (id ? current.folder_id === id : true);
    const targetNoteId = matchesFolder ? current.id : null;

    listSig = '';
    paintListTitle();
    paintList();
    navigate(state.route.view === 'trash' ? 'notes' : state.route.view, targetNoteId);
    paintEditor();
  }

  function drillBack() {
    state.listMode = 'folders';
    state.folderFilter = null;
    state.query = '';
    const q = $('#q');
    const qMob = $('#q-mobile');
    if (q) { q.value = ''; }
    if (qMob) { qMob.value = ''; }
    document.querySelectorAll('.search-clear').forEach(el => el.hidden = true);
    if (state.route.view !== 'notes') navigate('notes', null, true);
    listSig = '';
    paintListTitle();
    paintList();
  }

  function drillIntoTrash() {
    if (window.innerWidth < 1024) {
      state.listMode = 'notes';
    }
    state.query = '';
    const q = $('#q');
    const qMob = $('#q-mobile');
    if (q) { q.value = ''; }
    if (qMob) { qMob.value = ''; }
    document.querySelectorAll('.search-clear').forEach(el => el.hidden = true);
    
    const current = currentNote();
    const targetNoteId = (current && current.deleted_at) ? current.id : null;

    listSig = '';
    paintListTitle();
    paintList();
    navigate('trash', targetNoteId);
    paintEditor();
  }

  async function createFolder() {
    const values = await modal({
      title: 'New folder',
      description: 'Group notes to organize them easily.',
      fields: [{ name: 'name', label: 'Folder name', maxlength: 80, placeholder: 'e.g. Work', required: true }],
      confirmText: 'Create folder',
    });
    if (!values) return;
    try {
      const j = await api('/api/v1/folders', { method: 'POST', body: JSON.stringify({ name: values.name.trim() }) });
      state.folders.push(j.folder);
      state.folders.sort((a, b) => a.name.localeCompare(b.name, 'id'));
      await meta('folders', state.folders);
      paintList();
    } catch (e) {
      toast(netMessage(e));
    }
  }

  async function folderMenu(id) {
    const f = state.folders.find((x) => x.id === id);
    if (!f) return;
    const choice = await modal({
      title: f.name,
      description: 'What would you like to do with this folder?',
      choices: [
        { value: 'rename', label: 'Rename', icon: 'edit' },
        { value: 'delete', label: 'Delete folder', icon: 'trash', danger: true },
      ],
    });
    if (choice === 'rename') await renameFolder(f);
    else if (choice === 'delete') await deleteFolder(f);
  }

  async function renameFolder(f) {
    const values = await modal({
      title: 'Rename folder',
      fields: [{ name: 'name', label: 'Folder name', value: f.name, maxlength: 80, required: true }],
      confirmText: 'Save',
    });
    if (!values) return;
    try {
      await api(`/api/v1/folders/${encodeURIComponent(f.id)}`, { method: 'PATCH', body: JSON.stringify({ name: values.name.trim() }) });
      f.name = values.name.trim();
      state.folders.sort((a, b) => a.name.localeCompare(b.name, 'id'));
      await meta('folders', state.folders);
      listSig = '';
      paint();
    } catch (e) {
      toast(netMessage(e));
    }
  }

  async function deleteFolder(f) {
    const count = state.notes.filter((n) => !n.deleted_at && n.folder_id === f.id).length;
    const ok = await modal({
      title: `Delete folder “${f.name}”?`,
      description: count ? `${count} notes inside will not be deleted — they will move to “No folder”.` : 'This empty folder will be deleted.',
      confirmText: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/v1/folders/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      state.folders = state.folders.filter((x) => x.id !== f.id);
      if (state.folderFilter === f.id) { state.folderFilter = null; state.listMode = 'folders'; }
      await meta('folders', state.folders);
      await sync();
      paint();
      toast(`Folder “${f.name}” deleted`);
    } catch (e) {
      toast(netMessage(e));
    }
  }

  async function moveNote() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    const choice = await modal({
      title: 'Move to folder',
      choices: [
        { value: '', label: 'No folder', icon: 'all', selected: !n.folder_id },
        ...state.folders.map((f) => ({ value: f.id, label: f.name, icon: 'folder', selected: n.folder_id === f.id })),
      ],
      emptyText: 'No folders yet. Create a folder first.',
    });
    if (choice === null || choice === undefined) return;
    await flushSave();
    n.folder_id = choice;
    n.updated_at = stamp(n.updated_at);
    n.mutation_id = uid();
    await saveLocal(n);
    paint();
    scheduleSync();
  }

  /* ------------------------------------------------------------ note lock */

  // The server owns the password, so the note must exist server-side first.
  async function ensureOnServer(n) {
    if (n.revision > 0) return n;
    if (!state.online) return null;
    await flushSave();
    await sync();
    const fresh = state.notes.find((x) => x.id === n.id);
    return fresh && fresh.revision > 0 ? fresh : null;
  }

  async function lockMenu() {
    let n = currentNote();
    if (!n) return;
    if (!state.online) { toast('Locking notes requires internet connection.'); return; }

    if (!n.is_locked) {
      const values = await modal({
        title: 'Lock note',
        description: 'AES-256 end-to-end encryption — content is encrypted locally, plaintext is never stored on server.',
        fields: [
          { name: 'password', label: 'New password', type: 'password', minlength: 8, required: true, placeholder: 'At least 8 characters', autocomplete: 'new-password' },
          { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
        ],
        confirmText: 'Lock note',
        validate: (v) => (v.password.length < 8 ? 'Password must be at least 8 characters.' : v.password !== v.confirm ? 'Passwords do not match.' : null),
      });
      if (!values) return;
      const ready = await ensureOnServer(n);
      if (!ready) { toast('Note not synced yet. Please try again shortly.'); return; }
      await applyPassword(ready, values.password, 'Note locked');
      return;
    }

    const choice = await modal({
      title: 'Locked note',
      description: 'Password protection is enabled for this note.',
      choices: [
        { value: 'change', label: 'Change password', icon: 'lock' },
        { value: 'remove', label: 'Remove password', icon: 'unlock', danger: true },
      ],
    });
    if (choice === 'change') {
      const values = await modal({
        title: 'Change note password',
        fields: [
          { name: 'password', label: 'New password', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' },
          { name: 'confirm', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' },
        ],
        confirmText: 'Save password',
        validate: (v) => (v.password.length < 8 ? 'Password must be at least 8 characters.' : v.password !== v.confirm ? 'Passwords do not match.' : null),
      });
      if (values) await applyPassword(n, values.password, 'Password updated');
    } else if (choice === 'remove') {
      const ok = await modal({ title: 'Remove password?', description: 'Anyone signed into your account will be able to read this note.', confirmText: 'Remove password', danger: true });
      if (ok) await applyPassword(n, '', 'Password removed');
    }
  }

  async function applyPassword(n, password, successMessage) {
    try {
      const plainTitle = state.decrypted[n.id]?.title ?? n.title;
      const plainContent = state.decrypted[n.id]?.content ?? n.content;

      const j = await api(`/api/v1/notes/${encodeURIComponent(n.id)}/password`, { method: 'PUT', body: JSON.stringify({ password }) });
      n.is_locked = j.is_locked;
      if (typeof j.revision === 'number') n.revision = j.revision;

      if (n.is_locked) {
        state.unlocked[n.id] = true;
        state.decrypted[n.id] = { title: plainTitle, content: plainContent };
        const key = await deriveKey(password, n.id);
        state._keys[n.id] = key;
        const etitle = await encryptText(plainTitle, key);
        const econtent = await encryptText(plainContent, key);
        n.encrypted_title = etitle.ct;
        n.encrypted_content = econtent.ct;
        n.enc_iv = etitle.iv;
        n.enc_content_iv = econtent.iv;
      } else {
        delete state.unlocked[n.id];
        delete state.decrypted[n.id];
        delete state._keys[n.id];
        n.title = plainTitle;
        n.content = plainContent;
        delete n.encrypted_title;
        delete n.encrypted_content;
        delete n.enc_iv;
        delete n.enc_content_iv;
      }

      await saveLocal(n, false);
      paint();
      toast(successMessage);
    } catch (e) {
      toast(netMessage(e));
    }
  }

  async function submitUnlock(e) {
    e.preventDefault();
    const n = currentNote();
    if (!n) return;
    const input = $('#note-password');
    const err = $('#unlock-error');
    err.textContent = '';
    if (!state.online) { err.textContent = 'Internet connection required to unlock.'; return; }
    try {
      await api(`/api/v1/notes/${encodeURIComponent(n.id)}/unlock`, { method: 'POST', body: JSON.stringify({ password: input.value }) });
      state.unlocked[n.id] = true;

      if (n.encrypted_title && n.enc_iv) {
        try {
          const key = await deriveKey(input.value, n.id);
          const title = await decryptText(n.encrypted_title, n.enc_iv, key);
          const content = await decryptText(n.encrypted_content, n.enc_content_iv, key);
          state.decrypted[n.id] = { title, content };
          state._keys[n.id] = key;
        } catch {
          toast('Decryption failed — content may be encrypted with a different password.');
        }
      }

      paint();
      requestAnimationFrame(() => $('#content')?.focus({ preventScroll: true }));
    } catch (error) {
      err.textContent = error.status === 401 ? 'Incorrect password.' : netMessage(error);
      input.select();
    }
  }

  async function requestPasswordReset() {
    const n = currentNote();
    if (!n) return;
    try {
      await api(`/api/v1/notes/${encodeURIComponent(n.id)}/password/reset-request`, { method: 'POST', body: '{}' });
      toast('Reset link sent to your account email.');
    } catch (e) {
      $('#unlock-error').textContent = netMessage(e);
    }
  }

  /* ----------------------------------------------------------------- sync */

  let syncing = false;
  let syncQueued = false;
  let syncTimer = null;
  let attempt = 0;
  // Notes the server keeps rejecting as invalid. Skipped rather than deleted: a
  // rejected note is still the user's writing, and we must not spin on it forever.
  const blockedNotes = new Set();

  // 1s, 2s, 4s … capped at 60s, with jitter so reconnecting devices do not
  // stampede the server in lockstep (PRD 10.6).
  function nextBackoff(err) {
    if (err?.retryAfterMs) return err.retryAfterMs;
    const base = Math.min(1000 * 2 ** attempt, 60000);
    attempt += 1;
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  function scheduleSync(delay = 300) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void sync(), delay);
  }

  const SYNC_LABELS = {
    error: 'Sync failed — retry',
    auth: 'Sign in required to sync',
    offline: 'Offline — saved locally',
    saving: 'Saving…',
    syncing: 'Syncing…',
    synced: 'Synced',
    local: 'Saved locally',
  };

  function setSync(kind, label) {
    state.syncStatus = kind === 'auth' || kind === 'saving' ? (kind === 'auth' ? 'error' : 'local') : kind;
    state.syncLabel = label || SYNC_LABELS[kind] || '';
    paintSync();
  }

  // The shell keeps two sync indicators (desktop sidebar + mobile footer). Update
  // both, and the dot color, from the shared state so the UI always reflects the
  // real sync status instead of a stale first paint.
  function paintSync() {
    for (const id of ['sync', 'sync-mob']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.dataset.state = state.syncStatus || 'local';
      const label = el.querySelector('.label');
      if (label) label.textContent = state.syncLabel || '';
    }
  }

  // "Tersinkron" is a claim about the server, not about IndexedDB: it may only be
  // shown when nothing is still waiting in the outbox (PRD 10.7).
  async function settleSyncState() {
    const pending = await outboxAll().catch(() => []);
    const stuck = pending.filter((p) => blockedNotes.has(p.id)).length;
    if (stuck) { setSync('error', `${stuck} notes failed to sync`); return; }
    if (dirtyId) { setSync('saving'); return; }
    if (pending.length) { setSync(state.online ? 'local' : 'offline'); return; }
    setSync('synced');
  }

  async function sync() {
    if (!navigator.locks?.request) return syncUnlocked();
    return navigator.locks.request('litenotes-sync', { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await syncUnlocked();
    });
  }

  async function syncUnlocked() {
    if (!state.user || !state.db) return;
    if (!state.online) { setSync('offline'); return; }
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    try {
      setSync('syncing');
      await pushOutbox();
      await pullChanges();
      await settleSyncState();
      tabChannel?.postMessage({ type: 'sync-complete', userId: state.user.id });
      attempt = 0; // reset only after a full loop succeeds (PRD 10.6)
    } catch (e) {
      if (e.status === 401) {
        onSessionExpired(); // stop retrying until the user signs in again
      } else {
        setSync(e.offline || !state.online ? 'offline' : 'error');
        scheduleSync(nextBackoff(e));
      }
    } finally {
      syncing = false;
      if (state.user) { paintListTitle(); paintList(); refreshEditorChrome(currentNote()); }
      if (syncQueued) { syncQueued = false; scheduleSync(150); }
    }
  }

  // Repair server-facing timestamps that validateMutation would otherwise reject:
  // a wrong device clock or legacy data can leave created_at/updated_at in the
  // future (looping CLOCK_SKEW) or violate created_at<=updated_at / delete invariants.
  // The note is re-based on the server-calibrated clock; returns true if changed.
  function sanitizeTimestamps(n) {
    const now = Date.now() + state.clockOffset;
    let changed = false;
    let ua = Number.isFinite(n.updated_at) && n.updated_at > 0 ? n.updated_at : 0;
    let ca = Number.isFinite(n.created_at) && n.created_at > 0 ? n.created_at : 0;
    if (ua > now) { ua = now; changed = true; }
    if (ca > ua) { ca = ua; changed = true; }
    if (!(ca > 0)) { ca = ua; changed = true; }
    if (!(ua > 0)) { ua = now; ca = now; changed = true; }
    if (n.deleted_at != null && n.deleted_at !== ua) { n.deleted_at = ua; changed = true; }
    if (n.updated_at !== ua) { n.updated_at = ua; changed = true; }
    if (n.created_at !== ca) { n.created_at = ca; changed = true; }
    return changed;
  }

  const canonicalUUID = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);

  // Heal every rejection a legacy outbox row can carry: timestamps, an overlong
  // legacy title, and a corrupt mutation_id (the server wheels these out as 400).
  function repairNote(row) {
    let changed = sanitizeTimestamps(row.note);
    if (typeof row.note.title === 'string' && row.note.title.length > 500) {
      row.note.title = row.note.title.slice(0, 500);
      changed = true;
    }
    if (!canonicalUUID(row.mutation_id)) {
      row.mutation_id = uid();
      changed = true;
    }
    return changed;
  }

  async function pushOutbox(skewRetried = false) {
    // Auto-heal stuck notes before sending: repair them and lift the session's
    // blocked flag so a note the server once rejected can finally sync.
    let pending = await outboxAll();
    const repaired = pending.filter((row) => repairNote(row));
    if (repaired.length) {
      const t = tx([STORES.notes, STORES.outbox], 'readwrite');
      for (const row of repaired) {
        row.key = scopedKey(row.id);
        row.user_id = state.user.id;
        t.objectStore(STORES.outbox).put(row);
        const n = state.notes.find((x) => x.id === row.id);
        if (n) {
          n.title = row.note.title;
          n.created_at = row.note.created_at;
          n.updated_at = row.note.updated_at;
          n.deleted_at = row.note.deleted_at;
          n.mutation_id = row.mutation_id;
          t.objectStore(STORES.notes).put({ ...persistable(n), key: scopedKey(n.id), user_id: state.user.id });
        }
        blockedNotes.delete(row.id);
      }
      await done(t);
    }
    pending = (await outboxAll()).filter((x) => !blockedNotes.has(x.id));
    if (!pending.length) return;
    
    // We must send plaintext to the server, so decrypt locked notes using in-memory keys.
    // If a key is missing (e.g. app restarted), skip it until the user unlocks it.
    const batch = [];
    for (const row of pending) {
      if (row.note.is_locked) {
        const key = state._keys[row.id];
        if (!key && !row.note.deleted_at) continue; // cannot send without key, unless it's a deletion
        
        if (key && row.note.encrypted_title && row.note.enc_iv) {
          try {
            row.note.title = await decryptText(row.note.encrypted_title, row.note.enc_iv, key);
            row.note.content = await decryptText(row.note.encrypted_content, row.note.enc_content_iv, key);
          } catch {
            continue; // decryption failed, skip
          }
        }
      }
      // Send a copy: the outbox row is a snapshot owned by IndexedDB, and JSON
      // serialization must never be able to mutate it or pick up a newer edit.
      batch.push({ id: row.id, mutation_id: row.mutation_id, note: { ...row.note } });
      if (batch.length >= 100) break;
    }
    
    if (!batch.length) return;

    let j;
    try {
      j = await api('/api/v1/sync/push', {
        method: 'POST',
        body: JSON.stringify({
          device_id: state.deviceId,
          mutations: batch.map((x) => {
            const n = x.note;
            // Send only the fields noteInput accepts: the server decodes with
            // DisallowUnknownFields, so any extra key (revision, mutation_id,
            // is_locked, server_updated_at) would reject the whole batch.
            return { mutation_id: x.mutation_id, note: { id: n.id, title: n.title, content: n.content, created_at: n.created_at, updated_at: n.updated_at, deleted_at: n.deleted_at == null ? null : n.deleted_at, folder_id: n.folder_id || '', is_pinned: !!n.is_pinned } };
          })
        }),
      });
    } catch (e) {
      // 422 CLOCK_SKEW: api() already recalibrated the offset, so re-stamp and try
      // exactly once more. Never loop — a broken clock would push forever.
      if (e.code === 'CLOCK_SKEW' && !skewRetried) {
        await restampOutbox(batch);
        return pushOutbox(true);
      }
      // 400/409 are programming or validation faults: retrying cannot fix them.
      if (e.status === 400 || e.status === 409) {
        for (const row of batch) blockedNotes.add(row.id);
        toast(`${batch.length} notes rejected by server and paused from syncing. Content remains safe on this device.`, { duration: 0 });
        return;
      }
      throw e;
    }
    const results = j.results || [];
    if (!results.length) return;

    // Single transaction, no awaits inside — IndexedDB transactions die on macrotask gaps.
    const t = tx([STORES.notes, STORES.outbox], 'readwrite');
    const outbox = t.objectStore(STORES.outbox);
    const notes = t.objectStore(STORES.notes);
    for (const r of results) {
      if (!r.note) continue;
      const probe = outbox.get(scopedKey(r.note.id));
      probe.onsuccess = () => {
        if (probe.result && probe.result.mutation_id !== r.mutation_id) return;
        outbox.delete(scopedKey(r.note.id));
        const existingReq = notes.get(scopedKey(r.note.id));
        existingReq.onsuccess = () => {
          const ex = existingReq.result;
          if (ex?.encrypted_title) {
            r.note.encrypted_title = ex.encrypted_title;
            r.note.encrypted_content = ex.encrypted_content;
            r.note.enc_iv = ex.enc_iv;
            r.note.enc_content_iv = ex.enc_content_iv;
          }
          notes.put({ ...r.note, key: scopedKey(r.note.id), user_id: state.user.id });
        };
        existingReq.onerror = () => notes.put({ ...r.note, key: scopedKey(r.note.id), user_id: state.user.id });
      };
    }
    await done(t);
    for (const r of results) if (r.note) mergeRemote(r.note);
  }

  // Re-issue the queued mutations against the freshly calibrated clock. A delete
  // keeps deleted_at == updated_at or the server's CHECK constraint rejects it.
  async function restampOutbox(rows) {
    const t = tx([STORES.notes, STORES.outbox], 'readwrite');
    state.lastStamp = 0;
    const updated = Math.max(Date.now() + state.clockOffset, 1);
    for (const row of rows) {
      const n = state.notes.find((x) => x.id === row.id);
      const mutationID = uid();
      row.note.updated_at = updated;
      if (!(row.note.created_at > 0) || row.note.created_at > updated) row.note.created_at = updated;
      if (row.note.deleted_at != null) row.note.deleted_at = updated;
      row.mutation_id = mutationID;
      row.key = scopedKey(row.id);
      row.user_id = state.user.id;
      t.objectStore(STORES.outbox).put(row);
      if (n) {
        n.updated_at = updated;
        if (!(n.created_at > 0) || n.created_at > updated) n.created_at = updated;
        if (n.deleted_at != null) n.deleted_at = updated;
        n.mutation_id = mutationID;
        t.objectStore(STORES.notes).put({ ...persistable(n), key: scopedKey(n.id), user_id: state.user.id });
      }
    }
    state.lastStamp = updated;
    await done(t);
  }

  async function pullChanges() {
    let cursor = Number(await meta('cursor')) || 0;
    for (let page = 0; page < 25; page += 1) {
      const j = await api(`/api/v1/sync/pull?cursor=${cursor}&limit=200`);
      const batch = j.notes || [];
      const next = Number(j.next_cursor);
      if (!Number.isFinite(next) || next === cursor) break;
      // The cursor advances in the same IndexedDB transaction as the notes. A
      // pending outbox row wins locally until push acknowledgement, preventing a
      // pull from replacing recoverable offline edits before a crash/reload.
      const skipped = new Set();
      const t = tx([STORES.notes, STORES.outbox, STORES.meta], 'readwrite');
      const notes = t.objectStore(STORES.notes);
      const outbox = t.objectStore(STORES.outbox);
      for (const remote of batch) {
        const pending = outbox.get(scopedKey(remote.id));
        pending.onsuccess = () => {
          if (pending.result) { skipped.add(remote.id); return; }
          const existingReq = notes.get(scopedKey(remote.id));
          existingReq.onsuccess = () => {
            const existing = existingReq.result;
            if (existing?.encrypted_title) {
              remote.encrypted_title = existing.encrypted_title;
              remote.encrypted_content = existing.encrypted_content;
              remote.enc_iv = existing.enc_iv;
              remote.enc_content_iv = existing.enc_content_iv;
            }
            notes.put({ ...remote, key: scopedKey(remote.id), user_id: state.user.id });
          };
          existingReq.onerror = () => notes.put({ ...remote, key: scopedKey(remote.id), user_id: state.user.id });
        };
      }
      t.objectStore(STORES.meta).put({ key: scopedKey('cursor'), user_id: state.user.id, value: next });
      await done(t);
      for (const remote of batch) if (!skipped.has(remote.id)) mergeRemote(remote);
      cursor = next;
      if (!j.has_more) break;
    }
  }

  // Last-writer-wins, but never clobber text the user is still typing.
  function mergeRemote(remote) {
    const i = state.notes.findIndex((n) => n.id === remote.id);
    if (i < 0) { state.notes.push({ ...remote }); return; }
    const local = state.notes[i];
    const keepLocalText = dirtyId === remote.id || local.updated_at > remote.updated_at;
    if (keepLocalText) {
      local.revision = remote.revision;
      local.server_updated_at = remote.server_updated_at;
      local.is_locked = remote.is_locked;
      return;
    }
    const enc = {};
    if (local.encrypted_title) {
      enc.encrypted_title = local.encrypted_title;
      enc.encrypted_content = local.encrypted_content;
      enc.enc_iv = local.enc_iv;
      enc.enc_content_iv = local.enc_content_iv;
    }
    // A remote note we just acknowledged from push may already be a live object in
    // state.notes (same id) — adopt the fields, never replace the reference, so the
    // editor and outbox keep pointing at the same note.
    state.notes[i] = { ...remote, ...enc };
  }

  function onSessionExpired() {
    setSync('auth');
    toast('Session expired. Your notes remain saved on this device.', {
      actionLabel: 'Sign in again',
      duration: 0,
      onAction: async () => { await flushSave(); await meta('cached_user', null); state.user = null; shellMounted = false; paint(); },
    });
  }

  /* ----------------------------------------------------------------- auth */

  function paintLogin() {
    shellMounted = false;
    const dev = cfg.authMode === 'dev';
    const cached = loginHint.cachedUser;
    root.innerHTML = `
<main class="login">
  <section class="login-card">
    <div class="brand-mark" aria-hidden="true"></div>
    <h1>io-notes</h1>
    <p class="sub">Lightweight offline-first note-taking app.</p>
    ${dev ? `
      <div class="field"><label for="dev-email">Email</label><input id="dev-email" type="email" autocomplete="username" value="demo@example.com"></div>
      <div class="field"><label for="dev-name">Name</label><input id="dev-name" autocomplete="name" value="Demo User"></div>
      <button class="btn primary" id="dev-login">Local Sign In</button>
      <p class="login-note">Dev Mode — local development only.</p>`
      : `<div id="google-button"></div>
         <p class="login-note" id="login-note">${state.online ? 'First sign-in requires internet connection.' : 'You are offline. Connect to the internet to sign in.'}</p>`}
    ${cached ? `<div class="divider">or</div><button class="btn block" id="offline-open">Open offline notes</button>` : ''}
  </section>
</main>`;

    if (dev) $('#dev-login').onclick = () => void loginDev();
    else loadGoogleSignIn();
    if (cached) $('#offline-open').onclick = async () => { state.user = cached; await bootLocal(); paint(); scheduleSync(); };
  }

  const loginHint = { cachedUser: null };

  async function loginDev() {
    try {
      const j = await api('/api/v1/auth/dev', { method: 'POST', body: JSON.stringify({ email: $('#dev-email').value, name: $('#dev-name').value }) });
      await onAuthenticated(j.user);
    } catch (e) {
      showLoginError(e.message);
    }
  }

  function loadGoogleSignIn() {
    const note = $('#login-note');
    if (!cfg.googleClientId) { showLoginError('GOOGLE_CLIENT_ID not configured on server.'); return; }
    if (!state.online) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onerror = () => showLoginError('Failed to load Google Sign-In. Check internet connection.');
    s.onload = () => {
      if (!window.google?.accounts?.id) { showLoginError('Google Sign-In unavailable.'); return; }
      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: async (r) => {
          try { await onAuthenticated((await api('/api/v1/auth/google', { method: 'POST', body: JSON.stringify({ id_token: r.credential }) })).user); }
          catch (e) { showLoginError(e.message); }
        },
      });
      window.google.accounts.id.renderButton($('#google-button'), { theme: 'outline', size: 'large', text: 'signin_with', width: 320 });
      if (note) note.textContent = 'First sign-in requires internet connection.';
    };
    document.head.appendChild(s);
  }

  function showLoginError(message) {
    const note = $('#login-note') || $('.login-card')?.appendChild(Object.assign(document.createElement('p'), { className: 'login-note', id: 'login-note' }));
    if (note) { note.textContent = message; note.classList.add('error'); }
  }

  async function onAuthenticated(user) {
    state.user = user;
    loginHint.cachedUser = user;
    await bootLocal();
    await meta('cached_user', user);
    paint();
    scheduleSync(0);
  }

  async function confirmLogout() {
    const pending = (await outboxAll()).length;
    const ok = await modal({
      title: 'Sign out of io-notes?',
      description: pending
        ? `You have ${pending} unsynced changes. Connect to internet first to prevent loss.`
        : 'Notes remain safe on the server and will reload when you sign in again.',
      confirmText: 'Sign out',
      danger: true,
    });
    if (!ok) return;
    await flushSave();
    try {
      await api('/api/v1/auth/logout', { method: 'POST', body: '{}' });
    } catch (e) {
      if (!state.online) { toast('Signing out requires internet connection.'); return; }
      if (e.status !== 401) { toast(e.message); return; }
    }
    await meta('cached_user', null);
    loginHint.cachedUser = null;
    state.user = null;
    state.notes = [];
    state.folders = [];
    state.unlocked = Object.create(null);
    state.decrypted = Object.create(null);
    state._keys = Object.create(null);
    shellMounted = false;
    paint();
  }

  /* --------------------------------------------------------------- modals */

  function modal({ title, description, previewHTML, fields, choices, confirmText = 'Save', cancelText = 'Cancel', danger = false, validate, emptyText, wide = false }) {
    const dlg = $('#modal');
    if (!dlg) return Promise.resolve(null);
    dlg.classList.toggle('modal-wide', wide);

    const isChoice = Array.isArray(choices);
    const body = isChoice
      ? (choices.length
        ? `<div class="modal-choices">${choices.map((c) => `<button type="button" class="btn block choice ${c.danger ? 'danger' : ''}" data-choice="${esc(c.value)}">${icon(c.icon || 'folder', 16)}<span class="choice-label">${esc(c.label)}</span>${c.selected ? `<span class="choice-check">${icon('check', 14)}</span>` : ''}</button>`).join('')}</div>`
        : `<p class="desc">${esc(emptyText || 'No options available.')}</p>`)
      : (fields || []).map((f) => `
          <div class="field">
            <label for="mf-${f.name}">${esc(f.label)}</label>
            <input id="mf-${f.name}" name="${f.name}" type="${f.type || 'text'}"
              ${f.value ? `value="${esc(f.value)}"` : ''}
              ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}
              ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}
              ${f.minlength ? `minlength="${f.minlength}"` : ''}
              ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}
              ${f.required ? 'required' : ''}>
          </div>`).join('');

    dlg.innerHTML = `<form id="modal-form" novalidate>
        <div class="modal-body">
          <h2>${esc(title)}</h2>
          ${description ? `<p class="desc">${esc(description)}</p>` : ''}
          ${previewHTML || ''}
          ${body}
          <p class="err" id="modal-error" role="alert"></p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close>${esc(cancelText)}</button>
          ${isChoice ? '' : `<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(confirmText)}</button>`}
        </div>
      </form>`;

    return new Promise((resolve) => {
      let settled = false;
      // The <dialog> element is reused, so every listener must be torn down with it.
      const scope = new AbortController();
      const finish = (value) => {
        if (settled) return;
        settled = true;
        modalOpen = false;
        scope.abort();
        dlg.close();
        dlg.innerHTML = '';
        dlg.classList.remove('modal-wide');
        resolve(value);
      };

      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }, { signal: scope.signal });
      $('[data-close]', dlg).onclick = () => finish(null);

      if (isChoice) {
        for (const b of dlg.querySelectorAll('[data-choice]')) b.onclick = () => finish(b.dataset.choice);
      } else {
        $('#modal-form', dlg).onsubmit = (e) => {
          e.preventDefault();
          const values = {};
          for (const f of fields || []) values[f.name] = $(`#mf-${f.name}`, dlg).value;
          for (const f of fields || []) {
            if (f.required && !values[f.name].trim()) { showModalError(`${f.label} is required.`); return; }
          }
          const problem = validate?.(values);
          if (problem) { showModalError(problem); return; }
          finish(fields?.length ? values : true);
        };
      }

      modalOpen = true;
      dlg.showModal();
      const first = dlg.querySelector('input, [data-choice]');
      first?.focus();
      if (first?.select) first.select();
    });
  }

  function showModalError(message) {
    const el = $('#modal-error');
    if (el) el.textContent = message;
  }

  /* --------------------------------------------------------------- toasts */

  function toast(message, { actionLabel, onAction, duration = 5000 } = {}) {
    const host = $('#toasts') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toasts', id: 'toasts' }));
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="msg">${esc(message)}</span>`;
    const remove = () => { clearTimeout(timer); el.remove(); };
    if (actionLabel) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = actionLabel;
      btn.onclick = () => { remove(); onAction?.(); };
      el.appendChild(btn);
    }
    // Only persistent toasts need a manual dismiss; auto-dismissing ones stay quiet.
    if (!duration) {
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close notification');
      close.innerHTML = icon('x', 14);
      close.onclick = remove;
      el.appendChild(close);
    }
    while (host.children.length >= 3) host.firstElementChild.remove();
    host.appendChild(el);
    const timer = duration ? setTimeout(remove, duration) : null;
  }

  /* ---------------------------------------------------------------- theme */

  const THEMES = ['system', 'light', 'dark'];

  function currentTheme() {
    const saved = store.get('io-notes-theme');
    return THEMES.includes(saved) ? saved : 'system';
  }

  function applyTheme(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = mode;
    store.set('io-notes-theme', mode);
    requestAnimationFrame(syncThemeColor);
  }

  function syncThemeColor() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = bg || '#f2f3f8';
    document.head.appendChild(meta);
  }

  function paintTheme() {
    const mode = currentTheme();
    const label = { system: 'System', light: 'Light', dark: 'Dark' }[mode];
    for (const btn of [$('#theme-btn'), $('#theme-btn-mob')]) {
      if (!btn) continue;
      btn.innerHTML = icon(mode === 'system' ? 'auto' : mode === 'light' ? 'sun' : 'moon');
      btn.title = `Theme: ${label}`;
      btn.setAttribute('aria-label', `Theme: ${label}. Click to toggle.`);
    }
  }

  function cycleTheme() {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    applyTheme(next);
    paintTheme();
  }

  /* ------------------------------------------------------- reset password */

  function paintReset() {
    shellMounted = false;
    const params = state.route.params;
    const note = params.get('note');
    const token = params.get('token');
    root.innerHTML = `
<main class="login">
  <section class="login-card">
    <div class="brand-mark" aria-hidden="true"></div>
    <h1>New Password</h1>
    <p class="sub">Set a new password for your locked note.</p>
    ${note && token ? `
      <form id="reset-form">
        <div class="field"><label for="reset-password">New password</label><input id="reset-password" type="password" autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required></div>
        <div class="field"><label for="reset-confirm">Confirm password</label><input id="reset-confirm" type="password" autocomplete="new-password" required></div>
        <button class="btn primary" type="submit">Save password</button>
      </form>
      <p class="login-note" id="reset-message" role="alert"></p>`
      : '<p class="login-note error">Reset link is invalid or expired.</p>'}
  </section>
</main>`;
    const form = $('#reset-form');
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const message = $('#reset-message');
      const password = $('#reset-password').value;
      if (password.length < 8) { message.textContent = 'Password must be at least 8 characters.'; return; }
      if (password !== $('#reset-confirm').value) { message.textContent = 'Passwords do not match.'; return; }
      try {
        await api(`/api/v1/notes/${encodeURIComponent(note)}/password/reset`, { method: 'POST', body: JSON.stringify({ token, password }) });
        location.hash = '#/notes';
        location.reload();
      } catch (error) {
        message.textContent = error.message;
      }
    };
  }

  /* ------------------------------------------------- storage failure (9.5) */

  // Never wipe the database on a failed open: the notes may still be recoverable
  // and deleting them is the one mistake we cannot undo. Offer reload plus a
  // diagnostic the user can paste somewhere, containing no note content.
  function paintStorageFailure(err) {
    shellMounted = false;
    const diagnostic = {
      when: new Date().toISOString(),
      error: `${err?.name || 'Error'}: ${err?.message || 'unknown'}`,
      userAgent: navigator.userAgent,
      storage: typeof indexedDB === 'undefined' ? 'indexeddb-missing' : 'indexeddb-present',
      standalone: isStandalone(),
    };
    root.innerHTML = `
<main class="login">
  <section class="login-card">
    <div class="state-icon">${icon('warn', 24)}</div>
    <h1>Storage Unavailable</h1>
    <p class="sub">io-notes uses IndexedDB to store notes on this device. Your notes are <strong>not deleted</strong> — the app cannot access storage right now.</p>
    <button class="btn primary block" id="storage-reload">Reload</button>
    <button class="btn block" id="storage-copy">Copy diagnostic info</button>
    <p class="login-note">If this occurs in private browsing, allow site storage and reload.</p>
  </section>
</main>`;
    $('#storage-reload').onclick = () => location.reload();
    $('#storage-copy').onclick = async () => {
      const text = JSON.stringify(diagnostic, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        $('#storage-copy').textContent = 'Copied';
      } catch {
        $('#storage-copy').textContent = text;
      }
    };
  }

  /* ------------------------------------------------------------------ pwa */

  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  function setupInstall() {
    if (isStandalone()) return;
    let deferred = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      if (store.get('io-notes-install-dismissed')) return;
      showInstallCard('Install io-notes', 'Launch faster and take notes offline.', 'Install', async () => {
        deferred.prompt();
        await deferred.userChoice;
        deferred = null;
      });
    });

    window.addEventListener('appinstalled', () => $('#install-card')?.remove());

    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (ios && !store.get('io-notes-install-dismissed')) {
      setTimeout(() => showInstallCard('Add to Home Screen', 'Tap the Share button in Safari, then select "Add to Home Screen".', null, null), 4000);
    }
  }

  function showInstallCard(title, body, actionLabel, onAction) {
    if ($('#install-card') || !state.user) return;
    const card = document.createElement('aside');
    card.id = 'install-card';
    card.className = 'install-card';
    card.innerHTML = `<p><strong>${esc(title)}</strong>${esc(body)}</p>
      <div class="row">
        <button class="btn ghost" data-dismiss>Later</button>
        ${actionLabel ? `<button class="btn primary" data-install>${esc(actionLabel)}</button>` : ''}
      </div>`;
    card.querySelector('[data-dismiss]').onclick = () => { store.set('io-notes-install-dismissed', '1'); card.remove(); };
    card.querySelector('[data-install]')?.addEventListener('click', async () => { card.remove(); await onAction?.(); });
    document.body.appendChild(card);
  }

  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloading) return;
      location.reload();
    });
    navigator.serviceWorker.register('/sw.js?v=65').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state !== 'installed' || !navigator.serviceWorker.controller) return;
          // Never swap the app out from under an open editor (PRD 12.2).
          toast('A new version of io-notes is available', {
            actionLabel: 'Reload',
            duration: 0,
            onAction: async () => { await flushSave(); reloading = true; worker.postMessage({ type: 'skip-waiting' }); },
          });
        });
      });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'io-notes-sync') scheduleSync(0); });
  }

  /* ------------------------------------------------------------ shortcuts */

  function setupShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n' && state.user) { e.preventDefault(); newNote(); return; }
      if (mod && e.key.toLowerCase() === 's' && state.user) { e.preventDefault(); void flushSave().then(() => toast('Saved')); return; }
      if (mod && e.key.toLowerCase() === 'z' && state.user) { e.preventDefault(); applyHistory(null, e.shiftKey ? 'redo' : 'undo'); return; }
      if (mod && e.key.toLowerCase() === 'k' && state.user) { e.preventDefault(); $('#q')?.focus(); $('#q')?.select(); return; }
      if (e.key === '/' && !typing && !modalOpen && state.user) { e.preventDefault(); $('#q')?.focus(); return; }
      if (e.key === 'Escape' && !modalOpen && !typing && state.route.noteId && window.innerWidth < 768) navigate(state.route.view, null);
    });
  }

  function clearSearch() {
    state.query = '';
    const q = $('#q');
    const qMob = $('#q-mobile');
    if (q) { q.value = ''; }
    if (qMob) { qMob.value = ''; }
    document.querySelectorAll('.search-clear').forEach(el => el.hidden = true);
    paintList();
    if (window.innerWidth >= 1024) {
      if (q) q.focus();
    } else {
      if (qMob) qMob.focus();
    }
  }

  /* ----------------------------------------------------------------- boot */

  async function bootLocal() {
    await migrateLegacyForUser();
    state.notes = (await notesAll()).map((n) => ({ ...n }));
    state.deviceId = (await meta('device_id')) || '';
    if (!state.deviceId) { state.deviceId = uid(); await meta('device_id', state.deviceId); }
    state.clockOffset = Number(await meta('clock_offset_ms')) || 0;
    state.folders = (await meta('folders')) || [];
    if (state.online) {
      try {
        const j = await api('/api/v1/folders');
        state.folders = j.folders || [];
        await meta('folders', state.folders); // folders must survive offline too
      } catch { /* keep the cached copy */ }
      await refreshAttachments();
    }
  }

  async function start() {
    applyTheme(currentTheme());

    if (!location.hash) location.replace('#/notes');
    state.route = readRoute();

    if (state.route.view === 'reset') { paintReset(); return; }

    try {
      state.db = await openDB();
    } catch (e) {
      paintStorageFailure(e);
      return;
    }

    const cached = await meta('cached_user');
    loginHint.cachedUser = cached || null;

    if (state.online) {
      try {
        state.user = (await api('/api/v1/me')).user;
        loginHint.cachedUser = state.user;
      } catch (e) {
        if (e.status === 401) { await meta('cached_user', null); loginHint.cachedUser = null; }
        else if (cached) state.user = cached;
      }
    } else if (cached) {
      state.user = cached;
    }

    if (state.user) {
      await bootLocal();
      await meta('cached_user', state.user);
    }

    // Resolve a deep link to a note that no longer exists.
    if (state.route.noteId && !state.notes.some((n) => n.id === state.route.noteId)) navigate(state.route.view, null, true);
    state.route = readRoute();

    paint();
    setSync(state.online ? 'local' : 'offline');
    if (state.user) scheduleSync(0);

    setupInstall();
    setupServiceWorker();
    setupShortcuts();
  }

  window.addEventListener('hashchange', () => void onRouteChange());
  window.addEventListener('online', () => { state.online = true; scheduleSync(0); void refreshAttachments().then(rerenderOverlay); });
  window.addEventListener('offline', () => { state.online = false; setSync('offline'); rerenderOverlay(); });
  window.addEventListener('io-notes-sync', () => scheduleSync(0));
  tabChannel?.addEventListener('message', (e) => {
    if (e.data?.userId === state.user?.id && (e.data.type === 'local-change' || e.data.type === 'sync-complete')) scheduleSync(0);
  });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushSave();
      else if (state.user) { paintList(); scheduleSync(400); }
    });
    window.addEventListener('pagehide', () => { void flushSave(); });
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 1024 && state.listMode === 'folders') {
        state.listMode = 'notes';
        paintListTitle();
      }
      paintList();
    });

  // Relative timestamps stay honest without touching the editor.
  setInterval(() => { if (document.visibilityState === 'visible' && state.user) { paintList(); refreshEditorChrome(currentNote()); } }, 45000);

  void start();
})();
