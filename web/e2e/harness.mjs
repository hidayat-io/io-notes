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

  const server = spawn(bin, [], {
    env: {
      ...process.env,
      AUTH_MODE: 'dev',
      APP_ENV: 'development',
      APP_ORIGIN: base,
      SESSION_SECRET: 'e2e-session-secret-at-least-32-chars',
      TURSO_DATABASE_URL: 'file:' + path.join(dir, 'e2e.db'),
      ATTACH_LOCAL_DIR: path.join(dir, 'attachments'),
      PORT: String(serverPort),
    },
    stdio: 'ignore',
  });

  // pathname -> milliseconds to hold the request before forwarding it.
  const delays = new Map();
  const proxy = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, base);
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
  await waitForHealthy(base);

  // Full Chromium in new headless mode: closest to the browsers people use.
  const browser = await chromium.launch({ channel: 'chromium' });

  return {
    base,
    delays,
    async newContext() {
      const ctx = await browser.newContext();
      await ctx.addInitScript(recordScreens);
      return ctx;
    },
    async stop() {
      await browser.close();
      server.kill();
      await new Promise((r) => proxy.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Runs in the page before any app script: logs each top-level screen #app shows.
function recordScreens() {
  const screens = [];
  /** @type {any} */ (window).__screens = screens;
  new MutationObserver(() => {
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
