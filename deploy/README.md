# Deployment

## Current production

io-notes runs on `papandayan-public` as a systemd service, reachable publicly at
**https://note.indoomega.my.id** through the cloudflared tunnel.

| | |
|---|---|
| Binary | `/opt/litenotes/bin/litenotes` (`linux/arm64`) |
| Unit | `/etc/systemd/system/litenotes.service` |
| Env | `/opt/litenotes/env/litenotes.env`, mode 0600 |
| Data Primary | Turso Cloud Remote (`TURSO_DATABASE_URL=libsql://...`) |
| Bind | `127.0.0.1:8091` |
| Ingress | cloudflared `note.indoomega.my.id` → `http://localhost:8091` |
| Auth | `AUTH_MODE=google` |

The service listens on loopback only. `LISTEN_HOST` defaults to `127.0.0.1`; do not
set it to `0.0.0.0` unless something other than the local tunnel must reach the port,
because that would let clients bypass cloudflared and its TLS.

If a reverse proxy ever fronts the app and you need real client IPs for rate
limiting, set `CLIENT_IP_HEADER` to the header that proxy is trusted to set (for
cloudflared that is `CF-Connecting-IP`). Leave it unset otherwise — an unset value
means the limiter uses the socket address and cannot be spoofed.

## Turso Integration & Data Safety

To ensure data remains safe in Turso Cloud even if the server broken/destroyed:
1. Obtain database URL and auth token from Turso:
   ```bash
   turso db show <db-name> --url
   turso db tokens create <db-name>
   ```
2. Update `/opt/litenotes/env/litenotes.env` on server:
   ```bash
   TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
   TURSO_AUTH_TOKEN=<generated-token>
   ```
3. (Optional) Migrate existing local SQLite data to Turso:
   ```bash
   # On server: dump existing local SQLite tables
   sqlite3 /opt/litenotes/data/litenotes.db .dump > /tmp/litenotes_dump.sql
   # Upload dump to Turso via turso CLI
   turso db shell <db-name> < /tmp/litenotes_dump.sql
   ```
4. Restart service:
   ```bash
   systemctl restart litenotes
   ```

If Turso is unreachable during deployment and you need emergency fallback to local SQLite, set `ALLOW_LOCAL_SQLITE=1` in `/opt/litenotes/env/litenotes.env`.

## Build on the development machine

Never compile on the server.

```bash
go test ./...
node --check web/dist/app.js
node --check web/dist/sw.js

CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags='-s -w' \
  -o build/litenotes-linux-arm64 ./cmd/server
file build/litenotes-linux-arm64
```

The PWA assets in `web/dist` are embedded into the binary, so the binary is the only
artifact. When you change `app.js`, `app.css`, or the manifest, bump the `?v=` query
in `web/dist/index.html` **and** the matching `CACHE` name and asset list in
`web/dist/sw.js`, otherwise installed clients keep serving the previous shell.

## Deploy

```bash
scp build/litenotes-linux-arm64 papandayan-public:/tmp/litenotes-linux-arm64.new
ssh papandayan-public
```

Then, on the server:

```bash
TS=$(date +%Y%m%d-%H%M%S)
cp -a /opt/litenotes/bin/litenotes /opt/litenotes/bin/litenotes.bak-$TS
if [ -f /opt/litenotes/data/litenotes.db ]; then
  cp -a /opt/litenotes/data/litenotes.db /opt/litenotes/data/litenotes-$TS.bak
fi

install -m 0755 -o root -g root /tmp/litenotes-linux-arm64.new /opt/litenotes/bin/litenotes
systemctl restart litenotes

systemctl is-active litenotes
curl -sf http://127.0.0.1:8091/healthz && curl -sf http://127.0.0.1:8091/readyz
```

Rollback is the backup taken above:

```bash
install -m 0755 /opt/litenotes/bin/litenotes.bak-<TS> /opt/litenotes/bin/litenotes
systemctl restart litenotes
```

## Service worker rollout

`sw.js` no longer calls `skipWaiting()` on install. A new version installs and waits
while the page shows a *"Versi baru io-notes tersedia — Muat ulang"* toast; the swap
only happens after the open editor has flushed its local save. Expect installed
clients to sit on the previous shell until someone accepts that prompt.

## Verifying a release

```bash
curl -s https://note.indoomega.my.id/ | grep -o 'app\.js?v=[0-9]*'
curl -sI https://note.indoomega.my.id/ | grep -i content-security-policy
curl -s https://note.indoomega.my.id/sw.js | grep -o 'io-notes-shell-v[0-9]*'
```

The CSP is derived at startup from the hash of the inline bootstrap script in
`index.html`, so editing that script does not require touching the policy — but it
does require redeploying the binary, since the hash is computed from the embedded
copy.
