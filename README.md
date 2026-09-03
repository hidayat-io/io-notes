# LiteNotes (io-notes)

> Fast, privacy-friendly, offline-first notes PWA powered by a single Go binary and Turso Cloud database.

🌐 **Try it Live (Free):** [https://note.indoomega.my.id](https://note.indoomega.my.id)

---

## 🌟 Highlights

- 🌐 **Free Public Instance**: Anyone can use the hosted web app for free at **[note.indoomega.my.id](https://note.indoomega.my.id)** with Google Sign-In support.
- 📴 **Offline-First PWA**: Read and edit your notes anytime without internet connectivity. Changes are queued locally and synced automatically when back online.
- 💻 **Apple Notes-Style 3-Pane Layout**: Clean desktop interface split into **Folder Navigation**, **Note List**, and a **Full-Width Editor**. Responsive drill-down navigation on mobile screens.
- 📁 **Folders & Trash Management**: Organize notes into custom folders, search notes instantly, and recover deleted items from Trash.
- 🔒 **Note Lock / Password Protection**: Secure individual sensitive notes with password encryption.
- 📎 **Private Attachments & Preview**: Upload images and documents to private object storage, with inline previews for images, Markdown, plain text, and PDF.
- ⚡ **Zero-Dependency Single Binary**: Frontend PWA assets (`web/dist`) are embedded directly into the Go server binary.
- ☁️ **Cloud Durability via Turso**: Multi-device sync powered by Turso Cloud (`libSQL`) with fallback to local SQLite.

---

## 🛠 Tech Stack

- **Backend**: Go (`net/http`, standard library server), `libSQL` / Turso driver (`@libsql/client` / Go sqlite)
- **Frontend**: Vanilla JavaScript (ES Modules, Signals-like reactive state), Modern CSS (CSS Grid/Flexbox, CSS variables), PWA Service Worker
- **Storage**: Turso Cloud Database (Primary) with fallback to local SQLite
- **Auth**: Google Identity Services (OAuth 2.0 / OIDC) for production, Dev Mode auth for local testing
- **Deployment**: Systemd service, reverse-proxied via Cloudflare Tunnel (`cloudflared`)

---

## 📎 Attachments and previews

Attachments require an internet connection and are stored separately from note
content. Clicking an attachment reference opens the preview modal when the format
can be rendered safely by the browser.

| Format | Preview behavior |
|---|---|
| JPG, PNG, WebP, GIF | Inline image |
| Markdown (`.md`) | Rendered headings, lists, checklists, quotes, links, and code |
| Plain text (`.txt`) | Scrollable plain-text view |
| PDF | Browser's built-in PDF viewer |
| DOC, DOCX, XLS, XLSX, ZIP | Metadata and download fallback |

Markdown and plain-text previews are limited to 512 KiB to keep the UI responsive.
Uploaded Markdown is escaped before rendering, uploaded HTML is never interpreted,
and remote images in Markdown are shown as labels rather than fetched. Formats that
cannot be previewed remain downloadable.

---

## 🚀 Quick Start (Local Development)

### Prerequisites

- **Go**: 1.22 or higher
- **Node.js**: (optional, only for `node --check` validation of frontend scripts)

### Running Locally (Dev Mode)

In development mode, Google OAuth can be bypassed using `AUTH_MODE=dev`.

```bash
AUTH_MODE=dev \
APP_ENV=development \
SESSION_SECRET=local-dev-secret-key-32-bytes-long \
TURSO_DATABASE_URL=file:/tmp/litenotes.db \
ATTACH_LOCAL_DIR=/tmp/litenotes-attachments \
PORT=8091 \
go run ./cmd/server
```

Open your browser at **`http://127.0.0.1:8091`** and click "Masuk lokal" to log in with a test user.

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8091` | Server HTTP port |
| `LISTEN_HOST` | No | `127.0.0.1` | Host interface to bind |
| `APP_ENV` | No | `development` | `development` or `production` |
| `AUTH_MODE` | No | `google` | `google` (production) or `dev` (local mock) |
| `SESSION_SECRET` | **Yes** | — | 32-byte secret key for signing session cookies |
| `TURSO_DATABASE_URL` | **Yes** (Prod) | — | Turso database URL (`libsql://...`) or `file:...` |
| `TURSO_AUTH_TOKEN` | **Yes** (Prod) | — | Auth token generated from Turso CLI |
| `GOOGLE_CLIENT_ID` | **Yes** (Prod) | — | Google OAuth 2.0 Client ID for GIS authentication |
| `ALLOW_LOCAL_SQLITE` | No | `0` | Set `1` to allow `file:` databases in production mode |
| `ATTACH_LOCAL_DIR` | No | — | Local attachment storage for `AUTH_MODE=dev` only |
| `ATTACH_MAX_BYTES` | No | `10485760` | Maximum bytes per attachment |
| `ATTACH_USER_QUOTA_BYTES` | No | `536870912` | Per-user attachment quota |
| `ATTACH_GLOBAL_CAP_BYTES` | No | `8589934592` | Global attachment storage cap |

---

## 📦 Building for Production

### Verify Code & Assets

```bash
# Run Go unit tests
go test ./...

# Validate frontend JavaScript syntax
node --check web/dist/app.js
node --check web/dist/sw.js
```

### Cross-Compile Binary

Because PWA assets in `web/dist` are embedded into the binary via `go:embed`, compiling produces a single deployable executable.

```bash
# Example: Cross-compile for Linux ARM64
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags='-s -w' \
  -o build/litenotes-linux-arm64 ./cmd/server
```

For detailed deployment instructions, systemd service setup, and database migration steps, refer to [`deploy/README.md`](deploy/README.md).

---

## 📂 Project Structure

```
.
├── cmd/server/         # Go server (entrypoint, routes, auth, sync, attachments)
│   ├── main.go         # Server entry point & API endpoints
│   ├── attachments.go  # Upload, preview/download, quota, and storage handlers
│   ├── middleware.go   # Access logging, rate limiting, CORS, security headers
│   ├── schema.sql      # Database schema (SQLite / Turso)
│   └── main_test.go    # Server integration & unit tests
├── web/                # Frontend PWA source & embedded assets
│   ├── embed.go        # //go:embed dist/* directive
│   └── dist/           # HTML, CSS, JS, PWA Service Worker & icons
├── deploy/             # Deployment guides and systemd unit files
│   └── README.md       # Deployment & operations runbook
├── PRD-notepad-pwa.md  # Detailed Product Requirement Definition
└── README.md           # Project documentation
```

---

## 📜 License

MIT License. Free to use, modify, and self-host.
