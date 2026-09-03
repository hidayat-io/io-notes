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

## R2 attachments

File/image uploads store bytes in Cloudflare R2 (private bucket). Browsers upload
directly to short-lived presigned URLs; authenticated downloads and previews are
proxied by the application so the bucket remains private. Quota is enforced
server-side by reserving bytes in a `pending` row before the presign is issued.
Unconfirmed uploads and soft-deleted attachments are swept (row deleted in the DB
transaction, object deleted after commit) after 60 minutes; a failed object delete
is logged as `attachment_orphan` and can be cleaned manually with
`wrangler r2 object delete <bucket> <key>`.

### Preview contract

The authenticated same-origin download route also serves safe inline previews:

| Content type | Client preview | Server disposition |
|---|---|---|
| `image/jpeg`, `image/png`, `image/webp`, `image/gif` | `<img>` | Inline/default |
| `text/markdown` | Escaped, client-rendered Markdown | Inline with `?preview=1` |
| `text/plain` | Plain text | Inline with `?preview=1` |
| `application/pdf` | Same-origin browser PDF viewer | Inline with `?preview=1` |
| Word, Excel, ZIP | No inline renderer; download fallback | Attachment |

Text and Markdown previews are capped at 512 KiB by the client. The response for
`?preview=1` is sandboxed with a restrictive CSP and may only be framed by the same
origin. The regular URL and `?dl=1` retain attachment semantics. Do not expand the
inline allowlist to HTML, SVG, or arbitrary MIME types: attachment metadata is
user-controlled, and those formats can execute active content.

The browser canonicalizes the upload MIME type from the allowlisted extension. This
is especially important for `.md`, because some browsers report an empty or
inconsistent `File.type`; the create request and signed R2 PUT must use the same
content type.

One-time setup:

```bash
wrangler r2 bucket create litenotes-attachments   # private by default; never enable public access
# create an R2 API token with Object Read & Write for this bucket
```

Then set in `/opt/litenotes/env/litenotes.env` (mode 0600):

```
R2_ACCOUNT_ID=<account-id>
R2_ACCESS_KEY_ID=<token-key-id>
R2_SECRET_ACCESS_KEY=<token-secret>
R2_BUCKET=litenotes-attachments
ATTACH_MAX_BYTES=10485760          # per file (10 MB)
ATTACH_USER_QUOTA_BYTES=536870912  # per user (512 MB)
ATTACH_GLOBAL_CAP_BYTES=8589934592 # all users (8 GB; keeps the account under R2's 10 GB free tier)
```

All four `R2_*` vars must be set together; with none set the feature is fully off
(endpoints return 503 `ATTACHMENTS_NOT_CONFIGURED`). Quotas are env-tunable — verify
current R2 free-tier numbers on deploy day and adjust without code changes.

CORS: the bucket must allow `PUT`/`GET`/`HEAD` from `APP_ORIGIN`. Bootstrap it once by
deploying with `R2_BOOTSTRAP_CORS=1` (log line `r2_cors_bootstrapped`), then remove the
var. Manual alternative:

```bash
aws s3api put-bucket-cors --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  --bucket litenotes-attachments --cors-configuration file://cors.json
```

with `cors.json` allowing origins `["https://note.indoomega.my.id"]`, methods
`["PUT","GET","HEAD"]`, headers `["*"]`, expose `["ETag"]`, max age 3600.

Add to release verification (with a session cookie in `$C`):

```bash
curl -s https://note.indoomega.my.id/config.js | grep -o 'attachmentsEnabled[^,]*'
curl -s -b "$C" -H 'Content-Type: application/json' https://note.indoomega.my.id/api/v1/attachments \
  -d '{"filename":"t.txt","content_type":"text/plain","size_bytes":5}'
curl -s -X PUT -H 'Content-Type: text/plain' --data-binary 'hello' "<upload_url from previous response>"
curl -s -b "$C" -X POST https://note.indoomega.my.id/api/v1/attachments/<id>/confirm -d '{}'
curl -sSI -b "$C" 'https://note.indoomega.my.id/api/v1/attachments/<id>/download?preview=1'
```

For the preview response, verify `Content-Disposition: inline`, the declared safe
`Content-Type`, `X-Content-Type-Options: nosniff`, and a CSP containing `sandbox`
and `frame-ancestors 'self'`. Also open the attachment from the note UI after login;
an existing installed PWA may need to accept the new-version reload prompt first.

Rollback is safe: the schema change is additive (new `attachments` table) and old
binaries ignore it; removing the `R2_*` env vars turns the feature off.
