// A shared note opens for someone with no account and no session, straight from the
// link, and the token never travels in a URL.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { returningUser, saveNewNote, signIn, startApp } from './harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const uuid = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

// Puts a note on the server for a signed-in context and returns its id.
async function serverNote(ctx, n, title, content) {
  const id = uuid(n);
  const now = Date.now();
  const res = await ctx.request.post(app.base + '/api/v1/sync/push', {
    data: { device_id: 'e2e', mutations: [{ mutation_id: uuid(n + 1000), note: { id, title, content, created_at: now, updated_at: now, deleted_at: null, folder_id: '', is_pinned: false } }] },
  });
  assert.ok(res.ok(), `push failed: HTTP ${res.status()}`);
  return id;
}

async function shareLink(ctx, id, data = {}) {
  const res = await ctx.request.put(`${app.base}/api/v1/notes/${id}/share`, { data });
  assert.ok(res.ok(), `share failed: HTTP ${res.status()}`);
  return (await res.json()).token;
}

async function owner(email) {
  const ctx = await app.newContext();
  await signIn(ctx, app.base, email);
  return ctx;
}

test('a share link renders the note for a visitor with no session', async () => {
  const ctx = await owner('share-owner@example.com');
  const visitor = await app.newContext(); // fresh browser: no cookies, no storage
  try {
    const id = await serverNote(ctx, 1, 'Weekly plan', [
      '**Bold** and `code`',
      '- [ ] todo item',
      '- [x] done item',
      '![report.pdf](attach:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)',
    ].join('\n'));
    const token = await shareLink(ctx, id);

    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();

    assert.equal(await page.locator('.share-title').textContent(), 'Weekly plan');
    assert.equal(await page.locator('.share-content strong').textContent(), 'Bold');
    assert.equal(await page.locator('.share-content code').textContent(), 'code');
    assert.equal(await page.locator('.checklist-line').count(), 2);
    assert.equal(await page.locator('.checklist-line .check.done').count(), 1);
    assert.equal(await page.locator('.attach-label .attach-name').textContent(), 'report.pdf');
    assert.equal(await page.locator('#shell, .login-card, #app').count(), 0, 'the app shell or a login card appeared');
    assert.equal(await page.title(), 'Weekly plan · io-notes');

    // What the server received: the read happened, and no request URL carried the token.
    assert.ok(app.seen.some((s) => s.startsWith('POST /api/v1/shared/read')), 'the proxy never saw the read request, so this check proves nothing');
    assert.deepEqual(app.seen.filter((s) => s.includes(token)), [], 'the token reached the server inside a URL');
  } finally {
    await visitor.close();
    await ctx.close();
  }
});

test('markup in a shared note is shown as text and never runs', async () => {
  const ctx = await owner('share-xss@example.com');
  const visitor = await app.newContext();
  try {
    const id = await serverNote(ctx, 2, '<img src=x onerror="window.__pwned=1">', [
      '<script>window.__pwned=1</script>',
      '<img src=x onerror="window.__pwned=1">',
      '[click](javascript:window.__pwned=1)',
    ].join('\n'));
    const token = await shareLink(ctx, id);

    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();

    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'note markup executed');
    assert.equal(await page.locator('#share img, #share script, #share a').count(), 0, 'note markup became elements');
    assert.match((await page.locator('.share-title').textContent()) || '', /<img src=x onerror=/);
    assert.match((await page.locator('.share-content').textContent()) || '', /<script>window\.__pwned=1<\/script>/);
  } finally {
    await visitor.close();
    await ctx.close();
  }
});

test('a turned-off, malformed or missing link shows the same unavailable page', async () => {
  const ctx = await owner('share-off@example.com');
  const visitor = await app.newContext();
  try {
    const id = await serverNote(ctx, 3, 'Soon private', 'text');
    const token = await shareLink(ctx, id);
    const page = await visitor.newPage();

    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();

    const off = await ctx.request.delete(`${app.base}/api/v1/notes/${id}/share`);
    assert.ok(off.ok());
    await page.reload();
    await page.locator('.share-state').waitFor();
    assert.match((await page.locator('.share-state h1').textContent()) || '', /Link unavailable/);

    // A fragment that cannot be a token must not even ask the server.
    const reads = () => app.seen.filter((s) => s.startsWith('POST /api/v1/shared/read')).length;
    const before = reads();
    await page.goto(`${app.base}/s#not-a-token`);
    await page.reload();
    await page.locator('.share-state').waitFor();
    assert.equal(reads(), before, 'a malformed fragment still produced a read request');

    await page.goto(`${app.base}/s`);
    await page.reload();
    await page.locator('.share-state').waitFor();
    assert.match((await page.locator('.share-state h1').textContent()) || '', /Link unavailable/);
  } finally {
    await visitor.close();
    await ctx.close();
  }
});

const TOKEN_TAIL = /^[A-Za-z0-9_-]{43}$/;

// Opens a share link in a browser that has never seen the app and returns what it shows.
async function visit(url) {
  const visitor = await app.newContext();
  try {
    const page = await visitor.newPage();
    await page.goto(url);
    await page.locator('.share-title, .share-state').first().waitFor();
    return {
      unavailable: (await page.locator('.share-state').count()) > 0,
      text: await page.locator('#share').textContent(),
    };
  } finally {
    await visitor.close();
  }
}

test('the owner creates, copies, regenerates and turns off a link from the editor', async () => {
  const { ctx, page } = await returningUser(app, 'share-ui@example.com');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
  try {
    await saveNewNote(page, 'shared from the editor');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });

    await page.locator('[data-act="share"]').click();
    await page.getByRole('button', { name: 'Create link', exact: true }).click();
    const input = page.locator('#share-url');
    await input.waitFor();
    const first = await input.inputValue();
    assert.ok(first.startsWith(`${app.base}/s#`), `link is ${first}`);
    assert.match(first.slice(`${app.base}/s#`.length), TOKEN_TAIL);

    // Copy: the button confirms inline and the clipboard really holds the link.
    await page.locator('[data-share-copy]').click();
    await page.locator('[data-share-copy]', { hasText: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), first);

    // Pressing Enter in the read-only field must not submit the dialog's form (a reload).
    await input.press('Enter');
    assert.equal(await page.locator('#share-url').count(), 1, 'Enter closed or reloaded the dialog');

    const live = await visit(first);
    assert.equal(live.unavailable, false);
    assert.match(live.text, /shared from the editor/);

    // Regenerate: the old link dies at once, the new one works.
    await page.getByRole('button', { name: 'Regenerate link', exact: true }).click();
    await page.getByRole('heading', { name: 'Regenerate link?' }).waitFor();
    await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await page.waitForFunction((old) => document.querySelector('#share-url')?.value !== old, first);
    const second = await page.locator('#share-url').inputValue();
    assert.notEqual(second, first);
    assert.equal((await visit(first)).unavailable, true, 'the old link still works after regenerate');
    assert.equal((await visit(second)).unavailable, false);

    // Turn off: back to the create state, and the link is dead.
    await page.getByRole('button', { name: 'Turn off link', exact: true }).click();
    await page.getByRole('heading', { name: 'Turn off link?' }).waitFor();
    await page.getByRole('button', { name: 'Turn off link', exact: true }).click();
    await page.getByRole('button', { name: 'Create link', exact: true }).waitFor();
    assert.equal((await visit(second)).unavailable, true, 'the link still works after it was turned off');
  } finally {
    await ctx.close();
  }
});

test('a locked note cannot be shared from the editor', async () => {
  const { ctx, page } = await returningUser(app, 'share-locked@example.com');
  try {
    await saveNewNote(page, 'secret plans');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });

    await page.locator('[data-act="lock"]').click();
    await page.fill('#mf-password', 'password123');
    await page.fill('#mf-confirm', 'password123');
    await page.getByRole('button', { name: 'Lock note', exact: true }).click();
    await page.locator('#toasts').getByText('Note locked', { exact: true }).waitFor();

    await page.locator('[data-act="share"]').click();
    await page.locator('#toasts').getByText('Locked notes cannot be shared', { exact: false }).waitFor();
    assert.equal(await page.locator('#share-url').count(), 0, 'a share dialog opened for a locked note');
    assert.equal(await page.getByRole('button', { name: 'Create link', exact: true }).count(), 0);
  } finally {
    await ctx.close();
  }
});

test('sharing needs a connection and says so without opening a dialog', async () => {
  const { ctx, page } = await returningUser(app, 'share-offline@example.com');
  try {
    await saveNewNote(page, 'written before going offline');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });

    await ctx.setOffline(true);
    await page.waitForSelector('#sync[data-state="offline"]', { timeout: 10000 });
    await page.locator('[data-act="share"]').click();
    await page.locator('#toasts').getByText('Sharing requires internet connection', { exact: false }).waitFor();
    assert.equal(await page.locator('#modal[open]').count(), 0, 'a dialog opened while offline');
  } finally {
    await ctx.close();
  }
});
