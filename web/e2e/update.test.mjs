// The service worker serves the app shell from its cache, so a new deploy or a new
// server config only reaches an installed browser through a service worker update.
// That update must happen whenever what the browser caches changes, and it must be
// offered to the user in every tab — even when the app failed to boot.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openApp, returningUser, startApp } from './harness.mjs';

const UPDATE = 'A new version of io-notes is available';
const R2_ENV = { R2_ACCOUNT_ID: 'e2eacct', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' };

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const updateToast = (page) => page.locator('.toast', { hasText: UPDATE });

// Resolves to how the page's CSP treats a request to `url`.
function connectVerdict(url) {
  return new Promise((resolve) => {
    document.addEventListener('securitypolicyviolation', (e) => resolve(`blocked by ${e.violatedDirective}`), { once: true });
    fetch(url, { method: 'PUT', body: 'x' }).catch(() => {});
    setTimeout(() => resolve('allowed'), 1000);
  });
}

test('a CSP change on the server reaches a browser that already has the app', async () => {
  const { ctx, page } = await returningUser(app, 'update-csp@example.com');
  try {
    await app.restart(R2_ENV); // attachments move to R2: connect-src gains its endpoint
    await openApp(page, app.base + '/#/notes');
    await updateToast(page).waitFor({ timeout: 10000 });
    await Promise.all([page.waitForEvent('load'), updateToast(page).getByRole('button', { name: 'Reload' }).click()]);
    await page.waitForSelector('#shell');
    assert.equal(await page.evaluate(connectVerdict, 'https://e2eacct.r2.cloudflarestorage.com/b/probe'), 'allowed');
  } finally {
    await app.restart();
    await ctx.close();
  }
});

test('an update dismissed in one tab is still offered in a new tab', async () => {
  const { ctx, page } = await returningUser(app, 'update-tabs@example.com');
  try {
    await app.restart({ ATTACH_MAX_BYTES: '1048576' }); // config.js changes
    await openApp(page, app.base + '/#/notes');
    await updateToast(page).waitFor({ timeout: 10000 });
    await updateToast(page).getByRole('button', { name: 'Close notification' }).click();
    const tab2 = await ctx.newPage();
    await openApp(tab2, app.base + '/#/notes');
    await updateToast(tab2).waitFor({ timeout: 10000 });
  } finally {
    await app.restart();
    await ctx.close();
  }
});

test('an update is offered even when the app cannot boot', async () => {
  const { ctx, page } = await returningUser(app, 'update-broken@example.com');
  try {
    await app.restart({ ATTACH_MAX_BYTES: '2097152' });
    await ctx.addInitScript(() => { indexedDB.open = () => { throw new Error('storage broken for this test'); }; });
    await page.goto('about:blank');
    await page.goto(app.base + '/#/notes');
    await page.getByText('Storage Unavailable').waitFor();
    await updateToast(page).waitFor({ timeout: 10000 });
  } finally {
    await app.restart();
    await ctx.close();
  }
});

// A toast can appear before the notes shell exists (here: an update offered on the
// sign-in screen). Signing in must not add a second toast container on top of it.
test('toasts from before and after sign-in share one container', async () => {
  const ctx = await app.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(app.base + '/#/notes'); // signed out: the sign-in screen installs the worker
    await page.locator('#dev-login').waitFor();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await app.restart({ ATTACH_MAX_BYTES: '3145728' });
    await page.reload();
    await updateToast(page).waitFor({ timeout: 10000 });
    await page.fill('#dev-email', 'toast-host@example.com');
    await page.click('#dev-login');
    await page.waitForSelector('#shell');
    assert.equal(await page.locator('[id="toasts"]').count(), 1, 'toast containers');
    // The update offer is not tied to an account: signing out keeps it.
    await page.locator('[data-act="logout"]:visible').first().click();
    await page.locator('#modal').getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#dev-login').waitFor();
    assert.equal(await updateToast(page).count(), 1, 'update offers after signing out');
  } finally {
    await app.restart();
    await ctx.close();
  }
});

// A second deploy can land after the update was offered: the offered worker is
// then replaced. "Reload" must still activate the newest one.
test('Reload applies the newest update even when another one arrived after the offer', async () => {
  const { ctx, page } = await returningUser(app, 'update-twice@example.com');
  try {
    await app.restart({ ATTACH_MAX_BYTES: '4194304' });
    await openApp(page, app.base + '/#/notes');
    await updateToast(page).first().waitFor({ timeout: 10000 });
    await app.restart({ ATTACH_MAX_BYTES: '5242880' });
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      /** @type {any} */ (window).__offered = reg.waiting;
      await reg.update();
    });
    await page.waitForFunction(() => /** @type {any} */ (window).__offered.state === 'redundant', null, { timeout: 10000 });
    await Promise.all([
      page.waitForEvent('load', { timeout: 10000 }),
      updateToast(page).first().getByRole('button', { name: 'Reload' }).click(),
    ]);
  } finally {
    await app.restart();
    await ctx.close();
  }
});
