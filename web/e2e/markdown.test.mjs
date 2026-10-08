// Markdown notes, the way a person uses them: write, read, convert, sync, attach, share.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { firstVisit, returningUser, saveNewNote, signIn, startApp } from './harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const uuid = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

async function pulledNotes(ctx) {
  const res = await ctx.request.get(`${app.base}/api/v1/sync/pull?cursor=0&limit=500`);
  return (await res.json()).notes;
}

// Waits until the server holds a note matching the predicate (sync is asynchronous).
async function untilNote(ctx, predicate) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const notes = await pulledNotes(ctx);
    const found = notes.find(predicate);
    if (found) return found;
    assert.ok(Date.now() < deadline, `the server never received the expected note; it holds ${JSON.stringify(notes.map((n) => ({ format: n.format, content: n.content })))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const ATTACHED = ['# Attached', '', '| k | v |', '|---|---|', '| a | 1 |', '', '- top', '  - nested', ''].join('\n');

test('an attached .md file previews with its table and nested list', async () => {
  const { ctx, page } = await returningUser(app, 'md-preview@example.com');
  try {
    await saveNewNote(page, 'see the attachment');
    await untilNote(ctx, (n) => n.content === 'see the attachment');

    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-act="attach"]').click();
    await (await chooser).setFiles({ name: 'doc.md', mimeType: 'text/markdown', buffer: Buffer.from(ATTACHED) });

    const card = page.locator('#content-render .attach-slot');
    await card.waitFor();
    await card.click();
    const preview = page.locator('.markdown-preview');
    await preview.locator('table').waitFor();
    assert.equal(await preview.locator('h1').textContent(), 'Attached');
    assert.equal(await preview.locator('ul ul li').count(), 1, 'the nested list was flattened');
  } finally {
    await ctx.close();
  }
});

const SAMPLE = [
  '# Release notes', '',
  '| name | qty |', '|:-----|----:|', '| apple | 3 |', '',
  '- one', '  - nested', '- [ ] task', '',
  '<u>kept</u> and _this_', '🟡 not a checklist here',
].join('\n');

async function newMarkdownNote(page, text) {
  await page.locator('[data-act="new-md"]:visible').first().click();
  await page.locator('#content').waitFor();
  await page.fill('#content', text);
}

const done = (page) => page.getByRole('button', { name: 'Done', exact: true });

test('a new Markdown note opens in Edit, renders after Done and is stored exactly as typed', async () => {
  const { ctx, page } = await returningUser(app, 'md-basic@example.com');
  try {
    await newMarkdownNote(page, SAMPLE);
    assert.equal(await page.locator('#content-render').count(), 0, 'the plain-note overlay is showing in a Markdown note');
    assert.equal(await page.locator('[data-act="fmt-bold"]').count(), 0, 'plain-note formatting buttons are showing');

    await done(page).click();
    await page.locator('#md-view h1').waitFor();
    assert.equal(await page.locator('#md-view h1').textContent(), 'Release notes');
    assert.equal(await page.locator('#md-view th').count(), 2);
    assert.equal(await page.locator('#md-view ul ul li').count(), 1);
    assert.equal(await page.locator('#md-view input[type="checkbox"]').count(), 1);
    // A list that also holds a task keeps the bullets of its plain items.
    const bullet = await page.locator('#md-view ul > li:not(.md-task)').first().evaluate((el) => getComputedStyle(el).listStyleType);
    assert.notEqual(bullet, 'none', 'a plain item lost its bullet because the list also has a task');
    assert.equal(await page.locator('#content').count(), 0, 'View still shows a textarea');

    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === SAMPLE);
    assert.equal(note.content, SAMPLE, 'the server holds different text than was typed');
  } finally {
    await ctx.close();
  }
});

test('a Markdown note reopens in View, edits as the exact text, and returns to View when reopened', async () => {
  const { ctx, page } = await returningUser(app, 'md-reopen@example.com');
  try {
    await newMarkdownNote(page, SAMPLE);
    await done(page).click();
    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === SAMPLE);

    await page.reload();
    await page.locator('#md-view').waitFor();
    assert.equal(await page.locator('#content').count(), 0, 'a reload came back in Edit');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await page.locator('#content').inputValue(), SAMPLE, 'Edit shows a rewritten version of the note');

    await page.goto(`${app.base}/#/notes`);
    await page.goto(`${app.base}/#/notes/${note.id}`);
    await page.locator('#md-view').waitFor();
    assert.equal(await page.locator('#content').count(), 0, 'leaving the note and coming back kept it in Edit');
  } finally {
    await ctx.close();
  }
});

test('converting a plain note to Markdown and back changes how it looks, never what it says', async () => {
  const { ctx, page } = await returningUser(app, 'md-toggle@example.com');
  try {
    await saveNewNote(page, '- [ ] a\n**b**');
    await untilNote(ctx, (n) => n.content === '- [ ] a\n**b**');

    await page.locator('[data-act="toggle-md"]').click();
    await page.locator('#md-view').waitFor();
    assert.equal(await page.locator('#md-view input[type="checkbox"]').count(), 1);
    assert.equal(await page.locator('#md-view strong').textContent(), 'b');
    await untilNote(ctx, (n) => n.format === 'md' && n.content === '- [ ] a\n**b**');

    await page.locator('[data-act="toggle-md"]').click();
    await page.locator('#content').waitFor();
    assert.equal(await page.locator('#content').inputValue(), '🟡 a\n**b**', 'the plain editor shows its checklist the usual way');
    await untilNote(ctx, (n) => n.format === 'text' && n.content === '- [ ] a\n**b**');
  } finally {
    await ctx.close();
  }
});

test('a change that arrives from another device shows up in an open Markdown view', async () => {
  const { ctx, page } = await returningUser(app, 'md-live@example.com');
  try {
    await newMarkdownNote(page, '# First');
    await done(page).click();
    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === '# First');

    const pushed = await ctx.request.post(`${app.base}/api/v1/sync/push`, {
      data: {
        device_id: 'other-device',
        mutations: [{ mutation_id: uuid(701), note: { id: note.id, title: '', content: '# Second\n\nchanged elsewhere', created_at: note.created_at, updated_at: note.updated_at + 1, deleted_at: null, folder_id: '', is_pinned: false, format: 'md' } }],
      },
    });
    assert.ok(pushed.ok(), `push failed: HTTP ${pushed.status()}`);

    // Coming back to the tab is one of the moments the app syncs.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#md-view h1', { hasText: 'Second' }).waitFor();
    assert.match((await page.locator('#meta-words').textContent()) || '', /^4 words/);
  } finally {
    await ctx.close();
  }
});

test('attaching a file while a Markdown note is in View puts the reference in the note', async () => {
  const { ctx, page } = await returningUser(app, 'md-attach@example.com');
  try {
    await newMarkdownNote(page, '# Doc');
    await done(page).click();
    await page.locator('#md-view').waitFor();

    // View keeps pin and attach, and drops what only makes sense while typing.
    assert.equal(await page.locator('[data-act="toggle-pin"]').count(), 1);
    assert.equal(await page.locator('[data-act="attach"]').count(), 1);
    assert.equal(await page.locator('[data-act="fmt-bold"]').count(), 0);
    assert.equal(await page.locator('[data-act="undo"]').count(), 0);

    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-act="attach"]').click();
    await (await chooser).setFiles({ name: 'doc.md', mimeType: 'text/markdown', buffer: Buffer.from(ATTACHED) });

    // The note moved to Edit so the reference could be inserted.
    await page.locator('#content').waitFor();
    await page.waitForFunction(() => /!\[doc\.md\]\(attach:[0-9a-f-]{36}\)/.test(document.querySelector('#content')?.value || ''));
    assert.equal(await page.locator('[data-act="undo"]').count(), 1, 'Edit lost the undo button');

    await done(page).click();
    const card = page.locator('#md-view .attach-slot');
    await card.waitFor();
    await card.click();
    await page.locator('.markdown-preview table').waitFor();
    await page.keyboard.press('Escape');

    // After a reload the cards are drawn before the attachment list has arrived; View has to
    // repaint them once it does, or they would stay marked as missing.
    await page.reload();
    await page.locator('#md-view .attach-slot.attach-link').waitFor();

    // Deleting the attachment from the manager clears its card from View as well.
    await page.locator('[data-act="attachments"]').click();
    await page.getByRole('button', { name: /doc\.md/ }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('heading', { name: 'Delete attachment?' }).waitFor();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#md-view .attach-slot').length === 0);
    await untilNote(ctx, (n) => n.format === 'md' && !n.content.includes('attach:'));
  } finally {
    await ctx.close();
  }
});

test('the format reaches another browser signed in as the same user', async () => {
  const { ctx, page } = await returningUser(app, 'md-sync@example.com');
  const other = await app.newContext();
  try {
    await newMarkdownNote(page, '# Shared everywhere');
    await done(page).click();
    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === '# Shared everywhere');

    await signIn(other, app.base, 'md-sync@example.com');
    const second = await other.newPage();
    await firstVisit(second, app.base);
    await second.goto(`${app.base}/#/notes/${note.id}`);
    await second.locator('#md-view h1').waitFor();
    assert.equal(await second.locator('#md-view h1').textContent(), 'Shared everywhere');
  } finally {
    await other.close();
    await ctx.close();
  }
});

test('plain notes keep their editor: underline overlay, checklist emoji and the full toolbar', async () => {
  const { ctx, page } = await returningUser(app, 'md-plain@example.com');
  try {
    await saveNewNote(page, '_u_ and **b**\n- [ ] todo');
    assert.equal(await page.locator('[data-act="fmt-bold"]').count(), 1);
    assert.equal(await page.locator('[data-act="md-edit"]').count(), 0, 'a plain note shows the Markdown Edit button');
    assert.equal(await page.locator('#content-render u').count(), 1);

    await page.reload();
    await page.locator('#content').waitFor();
    assert.equal(await page.locator('#content').inputValue(), '_u_ and **b**\n🟡 todo');
    assert.equal(await page.locator('#content-render u').count(), 1);
  } finally {
    await ctx.close();
  }
});

// Puts a note on the server for a signed-in context and returns a share link token.
async function sharedNote(ctx, n, title, content, format) {
  const id = uuid(n);
  const now = Date.now();
  const pushed = await ctx.request.post(`${app.base}/api/v1/sync/push`, {
    data: { device_id: 'e2e', mutations: [{ mutation_id: uuid(n + 1), note: { id, title, content, created_at: now, updated_at: now, deleted_at: null, folder_id: '', is_pinned: false, format } }] },
  });
  assert.ok(pushed.ok(), `push failed: HTTP ${pushed.status()}`);
  const shared = await ctx.request.put(`${app.base}/api/v1/notes/${id}/share`, { data: {} });
  assert.ok(shared.ok(), `share failed: HTTP ${shared.status()}`);
  return (await shared.json()).token;
}

test('a shared Markdown note is rendered as Markdown on the share page and stays safe', async () => {
  const owner = await app.newContext();
  await signIn(owner, app.base, 'md-share@example.com');
  const visitor = await app.newContext();
  try {
    const hostile = ['[x](javascript:window.__pwned=1)', '<script>window.__pwned=1</script>', '<img src=x onerror="window.__pwned=1">'].join('\n');
    const token = await sharedNote(owner, 801, 'Doc', `${SAMPLE}\n\n${hostile}`, 'md');

    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-content.md h1').waitFor();
    assert.equal(await page.locator('.share-content.md th').count(), 2);
    assert.equal(await page.locator('.share-content.md ul ul li').count(), 1);
    assert.equal(await page.locator('.share-content.md input[type="checkbox"]').count(), 1);
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'note markup executed');
    assert.equal(await page.locator('#share script, #share a, #share img').count(), 0, 'note markup became elements');
    assert.match((await page.locator('.share-content').textContent()) || '', /<script>window\.__pwned=1<\/script>/);
  } finally {
    await visitor.close();
    await owner.close();
  }
});

test('a shared plain note still shows Markdown-looking text as typed', async () => {
  const owner = await app.newContext();
  await signIn(owner, app.base, 'md-share-plain@example.com');
  const visitor = await app.newContext();
  try {
    const token = await sharedNote(owner, 811, 'Notes', '# not a heading\n**bold** stays bold', 'text');
    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();
    assert.equal(await page.locator('#share h1').count(), 1, 'a plain note grew a heading');
    assert.equal(await page.locator('.share-content .content-line').count(), 2);
    assert.equal(await page.locator('.share-content strong').textContent(), 'bold');
  } finally {
    await visitor.close();
    await owner.close();
  }
});
