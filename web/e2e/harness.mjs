// Runs the real server (dev auth, throwaway SQLite) behind a tiny proxy that can
// hold chosen paths back. A slow server is exactly the condition under which the
// app used to keep a signed-in user on a spinner or flash the login card.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    }).on('error', reject);
  });
}

async function waitForHealthy(base) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

export async function startApp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'io-notes-e2e-'));
  const bin = path.join(dir, 'litenotes');
  execFileSync('go', ['build', '-o', bin, './cmd/server'], { cwd: repoRoot, stdio: 'inherit' });

  const serverPort = await freePort();
  const proxyPort = await freePort();
  const base = `http://127.0.0.1:${proxyPort}`;

  const baseEnv = {
    ...process.env,
    AUTH_MODE: 'dev',
    APP_ENV: 'development',
    APP_ORIGIN: base,
    SESSION_SECRET: 'e2e-session-secret-at-least-32-chars',
    TURSO_DATABASE_URL: 'file:' + path.join(dir, 'e2e.db'),
    ATTACH_LOCAL_DIR: path.join(dir, 'attachments'),
    PORT: String(serverPort),
  };
  let server;
  async function startServer(extraEnv = {}) {
    server = spawn(bin, [], { env: { ...baseEnv, ...extraEnv }, stdio: 'ignore' });
    await waitForHealthy(base);
  }
  async function stopServer() {
    if (server.exitCode !== null || server.signalCode !== null) return; // already gone
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }

  // pathname -> milliseconds to hold the request before forwarding it.
  const delays = new Map();
  // pathname -> how many more requests get a 503 instead of reaching the server.
  const failures = new Map();
  const proxy = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, base);
    const failLeft = failures.get(pathname) || 0;
    if (failLeft > 0) {
      failures.set(pathname, failLeft - 1);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'DATABASE_UNAVAILABLE', message: 'injected by e2e proxy' } }));
      return;
    }
    setTimeout(() => {
      const upstream = http.request(
        { host: '127.0.0.1', port: serverPort, path: req.url, method: req.method, headers: req.headers },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    }, delays.get(pathname) || 0);
  });
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  await startServer();

  // Full Chromium in new headless mode: closest to the browsers people use.
  const browser = await chromium.launch({ channel: 'chromium' });

  return {
    base,
    delays,
    failures,
    // Same database, new process: how a deploy or a config change looks to clients.
    async restart(extraEnv = {}) {
      await stopServer();
      await startServer(extraEnv);
    },
    async newContext() {
      const ctx = await browser.newContext();
      await ctx.addInitScript(recordScreens);
      return ctx;
    },
    async stop() {
      await browser.close();
      await stopServer();
      await new Promise((r) => proxy.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Runs in the page before any app script: logs each top-level screen #app shows,
// and the text of every toast. Toasts go to this tab's sessionStorage, so one shown
// right before the app reloads itself is still on record afterwards.
function recordScreens() {
  const screens = [];
  /** @type {any} */ (window).__screens = screens;
  const keepToast = (text) => {
    try {
      const all = JSON.parse(sessionStorage.getItem('__e2e_toasts') || '[]');
      all.push(text);
      sessionStorage.setItem('__e2e_toasts', JSON.stringify(all));
    } catch { /* storage unavailable: nothing to record into */ }
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n instanceof Element && n.classList.contains('toast')) keepToast(n.textContent);
      }
    }
    const app = document.getElementById('app');
    if (!app) return;
    const s = app.querySelector('.login-card') ? 'login' : app.querySelector('#shell') ? 'notes' : app.querySelector('.loading') ? 'spinner' : null;
    if (s && screens.at(-1) !== s) screens.push(s);
  }).observe(document, { childList: true, subtree: true });
}

export async function signIn(ctx, base, email) {
  const res = await ctx.request.post(base + '/api/v1/auth/dev', { data: { email, name: email.split('@')[0] } });
  if (!res.ok()) throw new Error(`dev sign-in failed: HTTP ${res.status()}`);
  return (await res.json()).user;
}

// Fresh browser storage and a fresh account, already past the first visit.
export async function returningUser(app, email) {
  const ctx = await app.newContext();
  await signIn(ctx, app.base, email);
  const page = await ctx.newPage();
  await firstVisit(page, app.base);
  return { ctx, page };
}

// Creates a note through the UI and waits until it is saved on the device.
export async function saveNewNote(page, content) {
  await page.locator('[data-act="new"]:visible').first().click();
  await page.fill('#content', content);
  await page.keyboard.press('Control+s');
  await page.locator('#toasts').getByText('Saved', { exact: true }).waitFor();
}

export async function pulledContents(ctx, base) {
  const res = await ctx.request.get(base + '/api/v1/sync/pull?cursor=0');
  return (await res.json()).notes.map((n) => n.content);
}

// First visit on this browser: boots from the server, caches the account in
// IndexedDB and installs the service worker. Every later open is a "return".
export async function firstVisit(page, base) {
  await page.goto(base + '/#/notes');
  await page.waitForSelector('#shell');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
}

// Opens the app fresh (never a same-document hash change) and returns how long
// it took until the notes shell was on screen.
export async function openApp(page, url) {
  await page.goto('about:blank');
  const started = Date.now();
  await page.goto(url, { waitUntil: 'commit', timeout: 20000 });
  await page.waitForSelector('#shell', { timeout: 20000 });
  return Date.now() - started;
}

export const screensSeen = (page) => page.evaluate(() => /** @type {any} */ (window).__screens);

// Every toast this tab has shown, across reloads.
export const toastsSeen = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('__e2e_toasts') || '[]'));
