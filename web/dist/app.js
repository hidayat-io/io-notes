/* io-notes — offline-first notes client.
   Hand-written ES2022, no build step. Run `node --check web/dist/app.js` before shipping.

   Rendering model: the shell is mounted once, then each region (folders, list,
   editor) repaints independently and only when its markup actually changed.
   Nothing ever replaces the whole document, so caret, scroll and IME state survive. */
(() => {
  'use strict';

  const cfg = window.__LITENOTES_CONFIG__ || { authMode: 'google', googleClientId: '' };
  const MAX_TITLE = 500;

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
  };

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
  const decContent = (n) => state.decrypted[n.id]?.content ?? n.content;
  const titleOf = (n) => { const t = decTitle(n); const c = decContent(n); return (t.trim() || (c.split('\n').find((l) => l.trim()) || '').trim() || 'Untitled note').slice(0, 120); };
  const snippetOf = (n) => decContent(n).replace(/\s+/g, ' ').trim().slice(0, 180);
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

  /* ---------------------------------------------------------------- icons */

  const ICON_PATHS = {
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    search: '<circle cx="11" cy="11" r="6.6"/><path d="m20 20-3.4-3.4"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chev: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    left: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
    folder: '<path d="M3.5 7.2a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.1 1.3h7.1a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    all: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9"/>',
    lock: '<rect x="4.6" y="10.4" width="14.8" height="9.8" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>',
    unlock: '<rect x="4.6" y="10.4" width="14.8" height="9.8" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.2-1.5"/>',
    trash: '<path d="M4.5 7h15M9.6 7V5.4A1.4 1.4 0 0 1 11 4h2a1.4 1.4 0 0 1 1.4 1.4V7M6.8 7l.8 11.3A2 2 0 0 0 9.6 20.2h4.8a2 2 0 0 0 2-1.9L17.2 7"/>',
    restore: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V9h-4.5"/>',
    note: '<path d="M6.5 3.8h7.3L18.5 8.5v11.7h-12z"/><path d="M13.5 3.8v5h5"/><path d="M9.3 12.6h6M9.3 16h4"/>',
    sun: '<circle cx="12" cy="12" r="3.9"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
    moon: '<path d="M20 14.6A8.5 8.5 0 0 1 9.4 4 8.5 8.5 0 1 0 20 14.6z"/>',
    auto: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4" /><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/>',
    logout: '<path d="M14.5 5.2h3.3a1.7 1.7 0 0 1 1.7 1.7v10.2a1.7 1.7 0 0 1-1.7 1.7h-3.3"/><path d="m9.4 8.2-3.8 3.8 3.8 3.8M5.6 12h9"/>',
    edit: '<path d="m14.3 5.6 4.1 4.1"/><path d="M4.4 19.6 5.5 15 15.9 4.6a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3L9 18.5z"/>',
    more: '<circle cx="12" cy="5.6" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.4" r="1.4" fill="currentColor" stroke="none"/>',
    cloud: '<path d="M7.2 18.5a4 4 0 0 1-.4-8 5.6 5.6 0 0 1 10.7 1.2 3.4 3.4 0 0 1-.6 6.8z"/>',
    check: '<path d="m5 12.6 4.6 4.6L19 7.8"/>',
    warn: '<path d="M12 4.6 2.8 20.2h18.4z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
  };

  function icon(name, size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  }

  /* ------------------------------------------------------------ indexeddb */

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('litenotes', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) {
          const s = db.createObjectStore('notes', { keyPath: 'id' });
          s.createIndex('updated_at', 'updated_at');
          s.createIndex('deleted_at', 'deleted_at');
        }
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const tx = (stores, mode = 'readonly') => state.db.transaction(stores, mode);
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const request = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function meta(key, value) {
    if (value === undefined) return request(tx(['meta']).objectStore('meta').get(key)).then((r) => (r ? r.value : undefined));
    const t = tx(['meta'], 'readwrite');
    t.objectStore('meta').put({ key, value });
    return done(t);
  }

  const notesAll = () => request(tx(['notes']).objectStore('notes').getAll());
  const outboxAll = () => request(tx(['outbox']).objectStore('outbox').getAll());

  function outboxRow(n) {
    return {
      id: n.id,
      mutation_id: n.mutation_id,
      note: persistable(n),
    };
  }

  async function saveLocal(n, queue = true) {
    const t = tx(['notes', 'outbox'], 'readwrite');
    t.objectStore('notes').put(persistable(n));
    if (queue) t.objectStore('outbox').put(outboxRow(n));
    await done(t);
    if (queue) navigator.serviceWorker?.ready.then((r) => r.sync?.register('io-notes-outbox')).catch(() => {});
  }

  function persistable(n) {
    const { draft, ...rest } = n;
    if (rest.is_locked && rest.encrypted_title) {
      return { ...rest, title: '', content: '' };
    }
    return rest;
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
      const retryAfter = Number(res.headers.get('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    return body;
  }

  const netMessage = (e) => (e.offline || !state.online ? 'Internet connection required for this action.' : e.message);

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
    return list.sort((a, b) => (trash ? (b.deleted_at || 0) - (a.deleted_at || 0) : b.updated_at - a.updated_at));
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
      <button class="icon-btn" data-act="theme" id="theme-btn" aria-label="Toggle theme"></button>
      <button class="icon-btn" data-act="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
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
      <button class="icon-btn" data-act="theme" id="theme-btn-mob" aria-label="Toggle theme"></button>
      <button class="icon-btn" data-act="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button>
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
    if (act === 'delete') return void deleteNote();
    if (act === 'restore') return void restoreNote();
    if (act === 'lock') return void lockMenu();
    if (act === 'move') return void moveNote();
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
      rows.push(`<button class="browse-row" role="listitem" data-act="folder" data-folder="" aria-current="${isAllSelected}">
        ${icon('all', 16)}<span class="browse-name">All Notes</span><span class="browse-n">${active.length}</span>
      </button>`);
    }
    // Per-folder rows
    for (const f of folders) {
      const isSelected = state.folderFilter === f.id && state.route.view === 'notes';
      rows.push(`<button class="browse-row" role="listitem" data-act="folder" data-folder="${esc(f.id)}" aria-current="${isSelected}">
        ${icon('folder', 16)}<span class="browse-name">${esc(f.name)}</span><span class="browse-n">${countFor(f.id)}</span>
        <button class="icon-btn sm browse-menu" data-act="folder-menu" data-folder="${esc(f.id)}" aria-label="Manage folder ${esc(f.name)}" title="Manage folder">${icon('more', 15)}</button>
      </button>`);
    }
    // Trash row at the bottom
    if (!q || 'trash'.includes(q) || 'sampah'.includes(q)) {
      rows.push(`<button class="browse-row browse-trash" role="listitem" data-act="trash-browse" aria-current="${isTrashSelected}">
        ${icon('trash', 16)}<span class="browse-name">Trash</span><span class="browse-n">${trashed}</span>
      </button>`);
    }

    if (!rows.length) return `<div class="list-empty">${icon('search', 22)}<p>No folders match "${esc(state.query.trim())}".</p></div>`;
    return rows.join('');
  }

  function noteListHTML() {
    const notes = visibleNotes();
    const q = state.query.trim();
    const showChip = !state.folderFilter && state.folders.length > 0;

    // Back affordance row
    const backRow = `<button class="drill-back" role="listitem" data-act="drill-back" aria-label="Back to folders">
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
      : `<button class="icon-btn ${n.is_locked ? 'on' : ''}" data-act="lock" aria-label="${n.is_locked ? 'Manage note lock' : 'Lock note with password'}" title="${n.is_locked ? 'Locked note' : 'Lock note'}">${icon(n.is_locked ? 'lock' : 'unlock')}</button>
         <button class="icon-btn danger" data-act="delete" aria-label="Move note to Trash" title="Move to Trash">${icon('trash')}</button>`;

    return head(`${crumb}<span class="head-spacer"></span><span class="save-state" id="save-state"></span><div class="actions">${actions}</div>`) +
      `<div class="editor-body">
         <div class="page">
           <textarea class="title" id="title" rows="1" maxlength="${MAX_TITLE}" placeholder="Title" aria-label="Note title" spellcheck="false" ${inTrash ? 'readonly' : ''}></textarea>
           <textarea class="content" id="content" placeholder="Start writing…" aria-label="Note content" ${inTrash ? 'readonly' : ''}></textarea>
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
    content.value = d?.content ?? n.content;
    autoGrow(title);
    if (!n.deleted_at) {
      title.addEventListener('input', onEdit);
      content.addEventListener('input', onEdit);
      title.addEventListener('blur', () => void flushSave());
      content.addEventListener('blur', () => void flushSave());
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); content.focus(); content.setSelectionRange(0, 0); }
      });
    }
    refreshEditorChrome(n);
  }

  // Grow the title up to the CSS max-height, then let it scroll.
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function refreshEditorChrome(n) {
    if (!n) return;
    const title = $('#title');
    const content = $('#content');
    if (!title || !content) return;

    const d = state.decrypted[n.id];
    const nTitle = d?.title ?? n.title;
    const nContent = d?.content ?? n.content;

    // Adopt remote text only when the user is not in the field and has nothing pending.
    const focused = document.activeElement === title || document.activeElement === content;
    if (!focused && dirtyId !== n.id) {
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
  let saveTimer = null;
  let listTimer = null;

  function onEdit() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    const title = $('#title');
    const content = $('#content');
    n.title = title.value;
    n.content = content.value;
    n.draft = false;
    dirtyId = n.id;
    if (n.is_locked && state.unlocked[n.id]) {
      state.decrypted[n.id] = { title: title.value, content: content.value };
    }
    autoGrow(title);
    setSaveState('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 600);
    clearTimeout(listTimer);
    listTimer = setTimeout(() => { paintList(); refreshEditorChrome(currentNote()); }, 250);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirtyId) return;
    const n = state.notes.find((x) => x.id === dirtyId);
    dirtyId = null;
    if (!n) return;
    const plainContent = state.decrypted[n.id]?.content ?? n.content;
    if (overContentLimit(plainContent)) {
      setSaveState('');
      setSync('error', 'Note too large');
      toast('Note exceeds 1 MB limit and cannot be saved. Split it into multiple notes.', { duration: 0 });
      return;
    }
    n.updated_at = stamp(n.updated_at);

    if (n.is_locked && state._keys[n.id] && state.decrypted[n.id]) {
      const key = state._keys[n.id];
      const d = state.decrypted[n.id];
      const etitle = await encryptText(d.title, key);
      const econtent = await encryptText(d.content, key);
      n.encrypted_title = etitle.ct;
      n.encrypted_content = econtent.ct;
      n.enc_iv = etitle.iv;
      n.enc_content_iv = econtent.iv;
    }

    await saveLocal(n);
    setSaveState('saved');
    paintList();
    refreshEditorChrome(currentNote());
    scheduleSync();
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
    navigate('notes', remaining[0]?.id || null, true);
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
    if (state.route.view !== 'notes') { navigate('notes', null); return; }
    listSig = '';
    paintListTitle();
    paintList();
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
    navigate('trash', null);
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
      paintFolders();
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
    if (!state.user || !state.db) return;
    if (!state.online) { setSync('offline'); return; }
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    try {
      setSync('syncing');
      await pushOutbox();
      await pullChanges();
      await settleSyncState();
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
      if (state.user) { paintTabs(); paintFolders(); paintListTitle(); paintList(); refreshEditorChrome(currentNote()); }
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
      const t = tx(['notes', 'outbox'], 'readwrite');
      for (const row of repaired) {
        t.objectStore('outbox').put(row);
        const n = state.notes.find((x) => x.id === row.id);
        if (n) {
          n.title = row.note.title;
          n.created_at = row.note.created_at;
          n.updated_at = row.note.updated_at;
          n.deleted_at = row.note.deleted_at;
          n.mutation_id = row.mutation_id;
          t.objectStore('notes').put(persistable(n));
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
      batch.push(row);
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
            return { mutation_id: x.mutation_id, note: { id: n.id, title: n.title, content: n.content, created_at: n.created_at, updated_at: n.updated_at, deleted_at: n.deleted_at == null ? null : n.deleted_at, folder_id: n.folder_id || '' } };
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
    const t = tx(['notes', 'outbox'], 'readwrite');
    const outbox = t.objectStore('outbox');
    const notes = t.objectStore('notes');
    for (const r of results) {
      if (!r.note) continue;
      const probe = outbox.get(r.note.id);
      probe.onsuccess = () => {
        if (probe.result && probe.result.mutation_id !== r.mutation_id) return;
        outbox.delete(r.note.id);
        const existingReq = notes.get(r.note.id);
        existingReq.onsuccess = () => {
          const ex = existingReq.result;
          if (ex?.encrypted_title) {
            r.note.encrypted_title = ex.encrypted_title;
            r.note.encrypted_content = ex.encrypted_content;
            r.note.enc_iv = ex.enc_iv;
            r.note.enc_content_iv = ex.enc_content_iv;
          }
          notes.put(r.note);
        };
        existingReq.onerror = () => notes.put(r.note);
      };
    }
    await done(t);
    for (const r of results) if (r.note) mergeRemote(r.note);
  }

  // Re-issue the queued mutations against the freshly calibrated clock. A delete
  // keeps deleted_at == updated_at or the server's CHECK constraint rejects it.
  async function restampOutbox(rows) {
    const t = tx(['notes', 'outbox'], 'readwrite');
    state.lastStamp = 0;
    const updated = Math.max(Date.now() + state.clockOffset, 1);
    for (const row of rows) {
      const n = state.notes.find((x) => x.id === row.id);
      const mutationID = uid();
      row.note.updated_at = updated;
      if (!(row.note.created_at > 0) || row.note.created_at > updated) row.note.created_at = updated;
      if (row.note.deleted_at != null) row.note.deleted_at = updated;
      row.mutation_id = mutationID;
      t.objectStore('outbox').put(row);
      if (n) {
        n.updated_at = updated;
        if (!(n.created_at > 0) || n.created_at > updated) n.created_at = updated;
        if (n.deleted_at != null) n.deleted_at = updated;
        n.mutation_id = mutationID;
        t.objectStore('notes').put(persistable(n));
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
      if (batch.length) {
        const t = tx(['notes'], 'readwrite');
        const s = t.objectStore('notes');
        for (const remote of batch) {
          const getReq = s.get(remote.id);
          getReq.onsuccess = () => {
            const existing = getReq.result;
            if (existing?.encrypted_title) {
              remote.encrypted_title = existing.encrypted_title;
              remote.encrypted_content = existing.encrypted_content;
              remote.enc_iv = existing.enc_iv;
              remote.enc_content_iv = existing.enc_content_iv;
            }
            s.put(remote);
          };
          getReq.onerror = () => s.put(remote);
        }
        await done(t);
        for (const remote of batch) mergeRemote(remote);
      }
      const next = Number(j.next_cursor);
      if (!Number.isFinite(next) || next === cursor) break;
      cursor = next;
      await meta('cursor', cursor);
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
    await meta('cached_user', user);
    await bootLocal();
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

  function modal({ title, description, fields, choices, confirmText = 'Save', cancelText = 'Cancel', danger = false, validate, emptyText }) {
    const dlg = $('#modal');
    if (!dlg) return Promise.resolve(null);

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
    const btn = $('#theme-btn');
    if (!btn) return;
    const mode = currentTheme();
    const label = { system: 'System', light: 'Light', dark: 'Dark' }[mode];
    btn.innerHTML = icon(mode === 'system' ? 'auto' : mode === 'light' ? 'sun' : 'moon');
    btn.title = `Theme: ${label}`;
    btn.setAttribute('aria-label', `Theme: ${label}. Click to toggle.`);
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
    navigator.serviceWorker.register('/sw.js?v=26').then((reg) => {
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
        await meta('cached_user', state.user);
        loginHint.cachedUser = state.user;
      } catch (e) {
        if (e.status === 401) { await meta('cached_user', null); loginHint.cachedUser = null; }
        else if (cached) state.user = cached;
      }
    } else if (cached) {
      state.user = cached;
    }

    if (state.user) await bootLocal();

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
  window.addEventListener('online', () => { state.online = true; scheduleSync(0); });
  window.addEventListener('offline', () => { state.online = false; setSync('offline'); });
  window.addEventListener('io-notes-sync', () => scheduleSync(0));
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
