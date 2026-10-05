// How the app opens for someone who already signed in on this browser: straight
// into their notes from IndexedDB, never through the login card, and never
// waiting on the server for anything the device already has.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openApp, pulledContents, returningUser, saveNewNote, screensSeen, signIn, startApp } from './harness.mjs';

// A held request lasts SLOW_MS; a launch that waited for it can never beat FAST_MS.
const SLOW_MS = 6000;
const FAST_MS = 2500;
// How long the app waits before re-fetching a server-side list that failed.
const LIST_RETRY_MS = 5000;

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

async function whileSlow(pathname, fn) {
  app.delays.set(pathname, SLOW_MS);
  try {
    return await fn();
  } finally {
    app.delays.delete(pathname);
  }
}

test('a signed-in user opening the bare URL never sees the login card', async () => {
  const { ctx, page } = await returningUser(app, 'bare-url@example.com');
  try {
    app.delays.set('/api/v1/me', 1500);
    await openApp(page, app.base + '/');
    const screens = await screensSeen(page);
    assert.ok(!screens.includes('login'), `screens shown: ${screens.join(' -> ')}`);
  } finally {
    app.delays.delete('/api/v1/me');
    await ctx.close();
  }
});

test('a returning user gets their notes without waiting for /me', async () => {
  const { ctx, page } = await returningUser(app, 'slow-me@example.com');
  try {
    const ms = await whileSlow('/api/v1/me', () => openApp(page, app.base + '/#/notes'));
    assert.ok(ms < FAST_MS, `notes took ${ms}ms while /me was held for ${SLOW_MS}ms`);
  } finally {
    await ctx.close();
  }
});

test('opening the app does not wait on the server for the page itself', async () => {
  const { ctx, page } = await returningUser(app, 'slow-page@example.com');
  try {
    const ms = await whileSlow('/', () => openApp(page, app.base + '/#/notes'));
    assert.ok(ms < FAST_MS, `notes took ${ms}ms while the page was held for ${SLOW_MS}ms`);
  } finally {
    await ctx.close();
  }
});

test('opening the app does not wait on the server for config.js', async () => {
  const { ctx, page } = await returningUser(app, 'slow-config@example.com');
  try {
    const ms = await whileSlow('/config.js', () => openApp(page, app.base + '/#/notes'));
    assert.ok(ms < FAST_MS, `notes took ${ms}ms while config.js was held for ${SLOW_MS}ms`);
  } finally {
    await ctx.close();
  }
});

test('an expired session keeps the notes on screen and offers to sign in again', async () => {
  const { ctx, page } = await returningUser(app, 'expired@example.com');
  try {
    await ctx.clearCookies();
    await openApp(page, app.base + '/#/notes');
    await page.getByText('Session expired').waitFor({ timeout: 5000 });
    const screens = await screensSeen(page);
    assert.ok(!screens.includes('login'), `screens shown: ${screens.join(' -> ')}`);
  } finally {
    await ctx.close();
  }
});

// IndexedDB caches account A with one unsynced note; the browser's session cookie
// then changes to account B (signed in elsewhere in this browser).
async function cacheAWithUnsyncedNoteThenSignInAsB(ctx, page, emailB) {
  await ctx.route('**/api/v1/sync/push', (r) => r.abort()); // the note never reaches the server
  await saveNewNote(page, 'only for account A');
  await page.goto('about:blank');
  await ctx.unroute('**/api/v1/sync/push');
  await signIn(ctx, app.base, emailB);
}

// The cached account is only good for painting. If the session cookie belongs to
// someone else, the cached account's unsynced notes must not be pushed with it.
test("a cached account's notes are never synced into another account", async () => {
  const { ctx, page } = await returningUser(app, 'owner-a@example.com');
  try {
    await cacheAWithUnsyncedNoteThenSignInAsB(ctx, page, 'other-b@example.com');
    await openApp(page, app.base + '/#/notes');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
    assert.deepEqual(await pulledContents(ctx, app.base), [], "B's account received A's notes");
  } finally {
    await ctx.close();
  }
});

test('switching to the account in the cookie tells the user, and keeps the old account\'s changes', async () => {
  const { ctx, page } = await returningUser(app, 'switch-a@example.com');
  try {
    await cacheAWithUnsyncedNoteThenSignInAsB(ctx, page, 'switch-b@example.com');
    await openApp(page, app.base + '/#/notes');
    const notice = page.locator('.toast', { hasText: 'switch-b@example.com' });
    await notice.waitFor({ timeout: 10000 });
    const text = await notice.textContent();
    assert.match(text, /switch-a@example\.com/, `notice: ${text}`);
    assert.match(text, /\b1 unsynced change\b/, `notice: ${text}`);
  } finally {
    await ctx.close();
  }
});

test('leaving the password-reset page opens the notes', async () => {
  const { ctx, page } = await returningUser(app, 'reset-leave@example.com');
  try {
    await page.goto('about:blank');
    await page.goto(app.base + '/#/reset-note-password?note=n&token=t');
    await page.getByRole('heading', { name: 'New Password' }).waitFor();
    await page.evaluate(() => { location.hash = '#/notes'; });
    await page.waitForSelector('#shell', { timeout: 5000 });
  } finally {
    await ctx.close();
  }
});

// The first /me after launch can fail (server or database hiccup). Once the
// session is confirmed later, the server-side lists must still be refreshed.
test('folders made on another device show up even when the first /me fails', async () => {
  const { ctx, page } = await returningUser(app, 'flaky-me@example.com');
  try {
    const res = await ctx.request.post(app.base + '/api/v1/folders', { data: { name: 'From the laptop' } });
    assert.ok(res.ok(), `create folder: HTTP ${res.status()}`);
    app.failures.set('/api/v1/me', 1);
    await openApp(page, app.base + '/#/notes');
    await page.locator('.folder-nav').getByText('From the laptop').waitFor({ timeout: 10000 });
  } finally {
    app.failures.delete('/api/v1/me');
    await ctx.close();
  }
});

test('attachment metadata is fetched again after a failed refresh', async () => {
  const { ctx, page } = await returningUser(app, 'flaky-attachments@example.com');
  try {
    let fetches = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/v1/attachments') fetches++; });
    app.failures.set('/api/v1/attachments', 1);
    await openApp(page, app.base + '/#/notes');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
    await page.waitForTimeout(LIST_RETRY_MS + 500);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // any later sync
    await page.waitForTimeout(1500);
    assert.ok(fetches >= 2, `attachments fetched ${fetches} time(s) after the first one failed`);
  } finally {
    app.failures.delete('/api/v1/attachments');
    await ctx.close();
  }
});

test('a slow folder list does not hold back pushing notes', async () => {
  const { ctx, page } = await returningUser(app, 'slow-folders@example.com');
  try {
    app.delays.set('/api/v1/folders', SLOW_MS);
    await openApp(page, app.base + '/#/notes');
    await page.locator('[data-act="new"]:visible').first().click();
    await page.fill('#content', 'should not wait for folders');
    await page.keyboard.press('Control+s');
    const started = Date.now();
    while (!(await pulledContents(ctx, app.base)).includes('should not wait for folders')) {
      assert.ok(Date.now() - started < FAST_MS, `note not on the server ${FAST_MS}ms after saving, folders held for ${SLOW_MS}ms`);
      await page.waitForTimeout(200);
    }
  } finally {
    app.delays.delete('/api/v1/folders');
    await ctx.close();
  }
});

test('a list endpoint that keeps failing is not re-fetched on every save', async () => {
  const { ctx, page } = await returningUser(app, 'failing-attachments@example.com');
  try {
    let fetches = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/v1/attachments') fetches++; });
    app.failures.set('/api/v1/attachments', 1000);
    await openApp(page, app.base + '/#/notes');
    await page.locator('[data-act="new"]:visible').first().click();
    for (let i = 0; i < 5; i++) {
      await page.type('#content', `save ${i} `);
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(600);
    }
    assert.ok(fetches <= 2, `attachments fetched ${fetches} times during 5 saves in about 3 seconds`);
  } finally {
    app.failures.delete('/api/v1/attachments');
    await ctx.close();
  }
});

// Runs in the page: plants a note in the stores used before per-account storage,
// marked as already migrated for the account cached on this browser.
async function seedLegacyNote(content) {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('litenotes');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const owner = await new Promise((resolve) => {
    const r = db.transaction('meta').objectStore('meta').get('cached_user');
    r.onsuccess = () => resolve(r.result.value.id);
  });
  const at = Date.now() - 1000;
  const note = { id: crypto.randomUUID(), title: '', content, folder_id: '', created_at: at, updated_at: at, deleted_at: null, mutation_id: crypto.randomUUID(), revision: 0, server_updated_at: 0, is_locked: false };
  const t = db.transaction(['notes', 'outbox', 'meta'], 'readwrite');
  t.objectStore('notes').put(note);
  t.objectStore('outbox').put({ id: note.id, mutation_id: note.mutation_id, note });
  t.objectStore('meta').put({ key: 'legacy_migrated_for', value: owner });
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
  db.close();
}

// Data from before per-account storage belongs to the account that migrated it.
// Another account using this browser must never import it, let alone push it.
test('notes from before per-account storage never reach another account', async () => {
  const { ctx, page } = await returningUser(app, 'legacy-a@example.com');
  try {
    await page.evaluate(seedLegacyNote, 'legacy note of A');
    await page.goto('about:blank');
    await signIn(ctx, app.base, 'legacy-b@example.com');
    await openApp(page, app.base + '/#/notes');
    await page.locator('.toast', { hasText: 'legacy-b@example.com' }).waitFor({ timeout: 10000 }); // now B
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
    assert.deepEqual(await pulledContents(ctx, app.base), [], "B's account received A's legacy note");
  } finally {
    await ctx.close();
  }
});

async function signOutThroughMenu(page) {
  await page.locator('[data-act="logout"]:visible').first().click();
  await page.locator('#modal').getByRole('button', { name: 'Sign out' }).click();
  await page.locator('#dev-login').waitFor();
}

// Account A's folder list is slow; A signs out while it is still in flight. Returns
// that request so a test can wait for its late response to land.
async function slowFolderListThenSignOut(emailA) {
  const { ctx, page } = await returningUser(app, emailA);
  const res = await ctx.request.post(app.base + '/api/v1/folders', { data: { name: 'Only for A' } });
  assert.ok(res.ok(), `create folder: HTTP ${res.status()}`);
  app.delays.set('/api/v1/folders', 8000);
  const inFlight = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/folders');
  await openApp(page, app.base + '/#/notes');
  const lateRequest = await inFlight;
  await signOutThroughMenu(page);
  app.delays.delete('/api/v1/folders');
  return { ctx, page, lateRequest };
}

test('a late response from the previous account does not re-render the sign-in card', async () => {
  const { ctx, page, lateRequest } = await slowFolderListThenSignOut('late-card@example.com');
  try {
    await page.fill('#dev-email', 'typing@example.com');
    await lateRequest.response(); // A's folders arrive while the user is typing here
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#dev-email'), 'typing@example.com', 'the sign-in card was re-rendered under the user');
  } finally {
    app.delays.delete('/api/v1/folders');
    await ctx.close();
  }
});

test("a slow folder list from the previous account never shows up for the next one", async () => {
  const { ctx, page, lateRequest } = await slowFolderListThenSignOut('late-a@example.com');
  try {
    // B's own folder refresh fails once, so nothing overwrites what A's late
    // response leaves behind. (Chrome also queues B's request for the same URL
    // behind A's, which would otherwise hide the damage right away.)
    app.failures.set('/api/v1/folders', 1);
    await page.fill('#dev-email', 'late-b@example.com');
    await page.click('#dev-login');
    await page.waitForSelector('#shell');
    await lateRequest.response(); // A's folders arrive after B is signed in
    await page.waitForTimeout(300);
    // B's next launch first shows the folders this device cached for B.
    app.delays.set('/api/v1/folders', 3000);
    await openApp(page, app.base + '/#/notes');
    assert.equal(await page.locator('.folder-nav').getByText('Only for A').count(), 0, "A's folder cached for B");
  } finally {
    app.delays.delete('/api/v1/folders');
    app.failures.delete('/api/v1/folders');
    await ctx.close();
  }
});
