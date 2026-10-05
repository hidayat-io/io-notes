// The app is already open when the session changes underneath it: it expires, or
// another tab in this browser signs in as someone else. Notes must never cross
// into the other account, and an expired session is reported once, not per save.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openApp, pulledContents, returningUser, signIn, startApp, toastsSeen } from './harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

test("switching accounts in another tab never syncs this tab's notes into the new account", async () => {
  const { ctx, page } = await returningUser(app, 'tab-a@example.com');
  try {
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 }); // verified as A
    // Another tab of this browser signs out and signs in as B; this tab still shows A.
    await ctx.request.post(app.base + '/api/v1/auth/logout', { data: {} });
    await signIn(ctx, app.base, 'tab-b@example.com');
    // Typing triggers autosave and a push; the app may switch accounts right away,
    // so do not wait for the "Saved" toast here.
    await page.locator('[data-act="new"]:visible').first().click();
    await page.fill('#content', 'typed in the tab that still shows A');
    await page.keyboard.press('Control+s');
    // Wait for the app to notice the switch; without the fix it never does.
    const notice = page.locator('.toast', { hasText: 'tab-b@example.com' });
    await notice.waitFor({ timeout: 8000 }).catch(() => {});
    assert.deepEqual(await pulledContents(ctx, app.base), [], "B's account received A's note");
    assert.match((await notice.textContent()) || '', /1 unsynced change from tab-a@example\.com/, "A's note was not kept for A");
    // The refused push is not the note's fault: it must not be reported as rejected.
    const rejected = (await toastsSeen(page)).filter((t) => t.includes('rejected'));
    assert.deepEqual(rejected, [], 'toasts claiming the note was rejected');
  } finally {
    await ctx.close();
  }
});

test('an expired session is reported once, not on every save', async () => {
  const { ctx, page } = await returningUser(app, 'expired-once@example.com');
  try {
    await ctx.clearCookies();
    let meCalls = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/v1/me') meCalls++; });
    await openApp(page, app.base + '/#/notes');
    await page.getByText('Session expired').waitFor();
    await page.locator('[data-act="new"]:visible').first().click();
    for (let i = 0; i < 5; i++) {
      await page.type('#content', `line ${i} `);
      await page.waitForTimeout(1200); // past the autosave debounce, so each round saves
    }
    assert.equal(await page.getByText('Session expired').count(), 1, '"Session expired" toasts on screen');
    assert.equal(meCalls, 1, '/me requests');
    // Coming back to the tab re-checks once; still signed out, so nothing new is shown.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1500);
    assert.equal(meCalls, 2, '/me requests after one re-check on focus');
    assert.equal(await page.getByText('Session expired').count(), 1, '"Session expired" toasts after the re-check');
  } finally {
    await ctx.close();
  }
});

// Pausing sync after a 401 must not be forever: once the cookie is valid again
// (the user signed in from another tab), coming back to this tab resumes sync.
test('an expired session recovers when the user signs in again elsewhere', async () => {
  const { ctx, page } = await returningUser(app, 'expired-recover@example.com');
  try {
    await ctx.clearCookies();
    await openApp(page, app.base + '/#/notes');
    await page.getByText('Session expired').waitFor();
    await page.locator('[data-act="new"]:visible').first().click();
    await page.fill('#content', 'written while signed out');
    await page.keyboard.press('Control+s');
    await signIn(ctx, app.base, 'expired-recover@example.com'); // "another tab"
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // back to this tab
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
    assert.deepEqual(await pulledContents(ctx, app.base), ['written while signed out']);
    assert.equal(await page.getByText('Session expired').count(), 0, 'stale "Session expired" toast still shown');
  } finally {
    await ctx.close();
  }
});

test("signing out and back in drops the old session's toasts", async () => {
  const { ctx, page } = await returningUser(app, 'relogin@example.com');
  try {
    await ctx.clearCookies();
    await openApp(page, app.base + '/#/notes');
    await page.getByText('Session expired').waitFor();
    await page.locator('[data-act="logout"]:visible').first().click();
    await page.locator('#modal').getByRole('button', { name: 'Sign out' }).click();
    await page.fill('#dev-email', 'relogin@example.com');
    await page.click('#dev-login');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
    assert.equal(await page.getByText('Session expired').count(), 0, 'stale "Session expired" toast after signing in');
  } finally {
    await ctx.close();
  }
});

test('opening the app while another tab holds the sync lock still syncs', async () => {
  const { ctx, page } = await returningUser(app, 'busy-lock@example.com');
  try {
    const other = await ctx.newPage();
    await other.goto(app.base + '/#/notes');
    await other.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
    // The other tab is in a slow sync: it holds the lock for a while and ends
    // without broadcasting anything.
    await other.evaluate(() => { void navigator.locks.request('litenotes-sync', () => new Promise((r) => setTimeout(r, 3000))); });
    await openApp(page, app.base + '/#/notes');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });
  } finally {
    await ctx.close();
  }
});
