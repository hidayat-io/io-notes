// How the app opens for someone who already signed in on this browser: straight
// into their notes from IndexedDB, never through the login card, and never
// waiting on the server for anything the device already has.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { firstVisit, openApp, screensSeen, signIn, startApp } from './harness.mjs';

// A held request lasts SLOW_MS; a launch that waited for it can never beat FAST_MS.
const SLOW_MS = 6000;
const FAST_MS = 2500;

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

// Fresh browser storage and a fresh account per test, already past the first visit.
async function returningUser(email) {
  const ctx = await app.newContext();
  await signIn(ctx, app.base, email);
  const page = await ctx.newPage();
  await firstVisit(page, app.base);
  return { ctx, page };
}

async function whileSlow(pathname, fn) {
  app.delays.set(pathname, SLOW_MS);
  try {
    return await fn();
  } finally {
    app.delays.delete(pathname);
  }
}

test('a signed-in user opening the bare URL never sees the login card', async () => {
  const { ctx, page } = await returningUser('bare-url@example.com');
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
  const { ctx, page } = await returningUser('slow-me@example.com');
  try {
    const ms = await whileSlow('/api/v1/me', () => openApp(page, app.base + '/#/notes'));
    assert.ok(ms < FAST_MS, `notes took ${ms}ms while /me was held for ${SLOW_MS}ms`);
  } finally {
    await ctx.close();
  }
});

test('opening the app does not wait on the server for the page itself', async () => {
  const { ctx, page } = await returningUser('slow-page@example.com');
  try {
    const ms = await whileSlow('/', () => openApp(page, app.base + '/#/notes'));
    assert.ok(ms < FAST_MS, `notes took ${ms}ms while the page was held for ${SLOW_MS}ms`);
  } finally {
    await ctx.close();
  }
});

test('opening the app does not wait on the server for config.js', async () => {
  const { ctx, page } = await returningUser('slow-config@example.com');
  try {
    const ms = await whileSlow('/config.js', () => openApp(page, app.base + '/#/notes'));
    assert.ok(ms < FAST_MS, `notes took ${ms}ms while config.js was held for ${SLOW_MS}ms`);
  } finally {
    await ctx.close();
  }
});

test('an expired session keeps the notes on screen and offers to sign in again', async () => {
  const { ctx, page } = await returningUser('expired@example.com');
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

// The cached account is only good for painting. If the session cookie belongs to
// someone else, the cached account's unsynced notes must not be pushed with it.
test("a cached account's notes are never synced into another account", async () => {
  const { ctx, page } = await returningUser('owner-a@example.com');
  try {
    // Leave a note of A's in the local outbox: its push never reaches the server.
    await ctx.route('**/api/v1/sync/push', (r) => r.abort());
    await page.locator('[data-act="new"]:visible').first().click();
    await page.fill('#content', 'only for account A');
    await page.keyboard.press('Control+s');
    await page.locator('#toasts').getByText('Saved', { exact: true }).waitFor();
    await page.goto('about:blank');
    await ctx.unroute('**/api/v1/sync/push');

    // Same browser, other account: the cookie is B's, IndexedDB still caches A.
    await signIn(ctx, app.base, 'other-b@example.com');
    await openApp(page, app.base + '/#/notes');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });

    const pulled = await (await ctx.request.get(app.base + '/api/v1/sync/pull?cursor=0')).json();
    assert.deepEqual(pulled.notes.map((n) => n.content), [], "B's account received A's notes");
  } finally {
    await ctx.close();
  }
});
