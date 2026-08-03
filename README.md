# io-notes

io-notes is a small offline-first notes PWA served by one Go binary. The current deployment artifact is built locally for `linux/arm64` and runs on `papandayan-public` as a loopback-only systemd service on port `8091`.

## Local development

```bash
AUTH_MODE=dev APP_ENV=development \
  SESSION_SECRET=local-change-this-secret-32-bytes \
  TURSO_DATABASE_URL=file:/tmp/litenotes.db PORT=8091 \
  go run ./cmd/server
```

Open `http://127.0.0.1:8091`. Dev auth is only for local/internal testing.

## Turso Integration (Cloud Durability)

To ensure data survives VPS/server crashes, set `TURSO_DATABASE_URL` to your remote Turso database URL (`libsql://...`) and provide `TURSO_AUTH_TOKEN`. Production `APP_ENV=production` requires remote Turso by default (local `file:` is blocked unless `ALLOW_LOCAL_SQLITE=1` is explicitly set as a temporary fallback).

```bash
APP_ENV=production \
  TURSO_DATABASE_URL=libsql://<your-db-name>-<org>.turso.io \
  TURSO_AUTH_TOKEN=<your-turso-token> \
  SESSION_SECRET=<32-byte-secret> \
  GOOGLE_CLIENT_ID=<google-client-id> \
  go run ./cmd/server
```

## Verify and build ARM64

```bash
go test ./...
node --check web/dist/app.js
mkdir -p build
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags='-s -w' \
  -o build/litenotes-linux-arm64 ./cmd/server
file build/litenotes-linux-arm64
```

Deployment details are in [`deploy/README.md`](deploy/README.md) and the full implementation PRD in [`PRD-notepad-pwa.md`](PRD-notepad-pwa.md).
