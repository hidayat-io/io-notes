// The note lock is an access lock (PRD 27.7), not end-to-end encryption: the note text still
// syncs to the server. The dialog must not promise otherwise.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { returningUser, saveNewNote, startApp } from './harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

test('the lock dialog does not claim end-to-end encryption', async () => {
  const { ctx, page } = await returningUser(app, 'lock-copy@example.com');
  try {
    await saveNewNote(page, 'something private');
    await page.locator('[data-act="lock"]').click();
    const text = (await page.locator('#modal').textContent()) || '';
    assert.doesNotMatch(text, /plaintext is never stored/i, 'the dialog still promises that the server never sees the text');
    assert.doesNotMatch(text, /end-to-end encryption\s*[—-]/i, 'the dialog still advertises end-to-end encryption');
    assert.match(text, /not end-to-end encryption/i, 'the dialog does not say what the lock is not');
    assert.match(text, /synced to the server/i, 'the dialog does not say the text reaches the server');
  } finally {
    await ctx.close();
  }
});
