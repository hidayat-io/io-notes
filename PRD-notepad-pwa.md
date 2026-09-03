# PRD Eksekusi — io-notes

**Produk:** Notepad Online, offline-first PWA  
**Nama sementara:** io-notes  
**Owner:** Taufiq  
**Versi dokumen:** 2.0  
**Status:** Siap dieksekusi  
**Target pembaca:** Model coding agent / software engineer  
**Bahasa UI:** Indonesia  

---

## 0. Cara Membaca Dokumen Ini

Dokumen ini adalah sumber kebenaran implementasi io-notes. Jika contoh kode, asumsi model, atau dokumen lama bertentangan dengan dokumen ini, ikuti dokumen ini.

Arti kata normatif:

- **MUST / WAJIB:** harus diimplementasikan untuk MVP.
- **MUST NOT / DILARANG:** tidak boleh dilakukan.
- **SHOULD / SEBAIKNYA:** lakukan kecuali ada alasan teknis yang kuat dan terdokumentasi.
- **MAY / BOLEH:** opsional.

Model eksekutor WAJIB:

1. Membaca seluruh PRD sebelum mengubah repository.
2. Memeriksa kondisi repository dan `AGENTS.md` jika tersedia.
3. Membuat rencana implementasi bertahap.
4. Tidak mengganti keputusan stack atau protokol sync tanpa persetujuan owner.
5. Menjalankan formatter, unit test, integration test, frontend test, build produksi, dan pemeriksaan PWA sebelum menyatakan selesai.
6. Tidak menganggap pekerjaan selesai bila hanya happy path yang berfungsi.

---

## 1. Ringkasan Produk

io-notes adalah aplikasi catatan personal yang cepat, minimalis, installable, dan tetap bisa digunakan tanpa koneksi internet. Pengalaman utamanya menyerupai Apple Notes dalam bentuk yang lebih sederhana: daftar catatan, editor plain text, autosave, trash, dan sinkronisasi lintas perangkat.

Arsitektur operasional harus sederhana:

- Satu binary Go melayani REST API dan aset frontend hasil build.
- Frontend dan API berada pada origin yang sama.
- Browser menyimpan data kerja di IndexedDB.
- Turso menjadi penyimpanan cloud permanen.
- Cloud Run menjadi target deployment utama.
- Tidak ada server frontend terpisah dan tidak ada konfigurasi CORS untuk aplikasi utama.

### 1.1 Tujuan MVP

MVP dianggap berhasil jika user dapat:

1. Login dengan akun Google.
2. Membuat, membuka, mengubah, dan menghapus catatan tanpa tombol Save.
3. Tetap membaca dan mengedit catatan yang sudah tersimpan lokal ketika offline.
4. Menutup dan membuka kembali aplikasi tanpa kehilangan perubahan lokal.
5. Melihat perubahan muncul di perangkat lain setelah keduanya online dan sync selesai.
6. Memulihkan catatan dari Trash.
7. Meng-install aplikasi sebagai PWA pada browser yang mendukung instalasi.

### 1.2 Prinsip Produk

- **Local-first interaction:** UI membaca dan menulis IndexedDB terlebih dahulu.
- **Cloud-backed durability:** perubahan lokal akhirnya disimpan ke Turso setelah autentikasi dan koneksi tersedia.
- **Instant feedback:** aksi user tidak menunggu jaringan.
- **Predictable sync:** semua mutasi idempotent dan hasil konflik deterministik.
- **Data isolation:** seluruh akses note selalu di-scope dengan `user_id` hasil session, bukan nilai dari client.
- **Minimal UI:** jangan menambahkan fitur atau komponen visual di luar kebutuhan PRD.

### 1.3 Non-goals MVP

- Kolaborasi real-time atau shared note.
- CRDT, operational transform, atau presence indicator.
- Rich text, WYSIWYG, attachment, gambar, video, audio, dan embed.
- Folder, tag, pin, reminder, checklist khusus, dan version history.
- Mobile native app.
- Login selain Google.
- End-to-end encryption.
- Permanent delete. Tombstone perlu dipertahankan agar device lama tidak menghidupkan kembali note yang sudah dihapus.
- Search; direncanakan untuk fase berikutnya.

---

## 2. Keputusan Teknis yang Dikunci

| Area | Keputusan MVP | Alasan |
|---|---|---|
| Backend | Go + `chi` | Routing dan middleware kecil serta eksplisit |
| Frontend MVP | Vanilla JavaScript ES2022 + static assets | Tidak membutuhkan Node.js di host ARM dan menjaga artifact sederhana |
| Frontend upgrade path | Preact + TypeScript + Vite diperbolehkan setelah kontrak API/sync stabil | UI dapat dimodernisasi tanpa mengubah backend |
| IndexedDB MVP | IndexedDB native dengan wrapper lokal kecil | Menghindari dependency runtime; semua operasi tetap Promise-based |
| PWA MVP | Service worker manual + manifest | App shell kecil dan mudah diaudit; Workbox boleh dipakai saat bundler ditambahkan |
| Database produksi | Turso remote melalui `github.com/tursodatabase/libsql-client-go/libsql` | Cocok untuk container stateless/Cloud Run dan pure Go |
| Database lokal | `turso dev --db-file` atau database Turso development | Menjaga perilaku libSQL dekat produksi |
| Auth browser | Google Identity Services JavaScript API, popup UX | Login tanpa reload dan cocok untuk SPA |
| Verifikasi Google | `google.golang.org/api/idtoken` | Library Google untuk signature dan standard claims |
| Session | JWT HS256 milik aplikasi dalam cookie httpOnly | Session lebih panjang daripada Google ID token |
| Session JWT | `github.com/golang-jwt/jwt/v5` | Implementasi JWT terawat; validasi algorithm wajib eksplisit |
| ID | UUID v4 lowercase canonical | Tersedia di browser melalui `crypto.randomUUID()` dan aman dibuat offline |
| Sync cursor | Integer revision monotonic per user | Tidak bergantung jam device dan tidak melewatkan timestamp yang sama |
| Conflict | Deterministic LWW tuple `(updated_at, mutation_id)` | Mendukung offline write tanpa CRDT dan tie-break konsisten |
| Editor | `<textarea>` plain text + input title | Stabil, accessible, dan scope MVP terkendali |
| Logging | `log/slog` JSON di production | Terintegrasi dengan Cloud Logging tanpa agent tambahan |
| API origin | Same-origin saja | Cookie aman dan tidak perlu CORS |

Jangan menggunakan React penuh, Next.js, database ORM, GraphQL, Firebase Auth, atau backend-as-a-service lain pada MVP. Frontend vanilla boleh dimigrasikan ke Preact/Vite kemudian, tetapi tidak boleh mengubah kontrak API atau state machine sync.

Versi dependency WAJIB dipin melalui `go.mod` dan lockfile frontend. Gunakan versi stable yang kompatibel pada waktu implementasi; jangan menulis `latest` di Dockerfile atau workflow.

---

## 3. Arsitektur Sistem

```text
┌──────────────────────── Browser / installed PWA ────────────────────────┐
│ Preact UI                                                               │
│   ├─ notes list + editor + trash                                        │
│   ├─ auth state                                                         │
│   └─ sync coordinator                                                   │
│                                                                         │
│ IndexedDB                                                               │
│   ├─ notes (source of truth untuk UI)                                   │
│   ├─ outbox (mutasi belum diakui server)                                │
│   └─ meta (active user, cursor, clock offset, device ID)                │
│                                                                         │
│ Service Worker                                                          │
│   └─ cache app shell; DILARANG cache response /api/*                    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS, same-origin, session cookie
                                ▼
┌──────────────────────── Go binary / Cloud Run ──────────────────────────┐
│ chi router                                                              │
│   ├─ security/request middleware                                        │
│   ├─ Google login + application session                                 │
│   ├─ sync push/pull                                                     │
│   ├─ health/readiness                                                   │
│   └─ embedded web/dist                                                  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ libSQL remote protocol
                                ▼
┌──────────────────────────────── Turso ───────────────────────────────────┐
│ users + user_sync_state + notes + schema_migrations                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Sumber Kebenaran

- Untuk render UI aktif, IndexedDB adalah sumber kebenaran.
- Untuk durability lintas device, Turso adalah sumber kebenaran cloud.
- Outbox adalah bukti bahwa sebuah state lokal belum diakui server.
- Cursor server tidak boleh dimajukan sebelum hasil pull berhasil disimpan ke IndexedDB dalam transaction yang sama.
- Memory state Preact hanyalah cache tampilan dan tidak boleh menjadi satu-satunya tempat menyimpan perubahan user.

### 3.2 Batas Modul

- Handler HTTP hanya melakukan parsing, auth context, validasi, pemetaan error, dan serialization.
- Aturan LWW dan alokasi revision berada di service/repository, bukan di frontend saja.
- SQL hanya berada di package repository/database.
- Frontend API client tidak boleh mengakses IndexedDB secara langsung; gunakan repository lokal.
- Sync coordinator tidak boleh mengubah komponen UI secara langsung; ia mengubah local repository dan menerbitkan state/status.

---

## 4. Model Domain dan Aturan Dasar

### 4.1 User

Identitas utama akun Google adalah claim `sub`. Email bukan primary identity karena dapat berubah.

```ts
type User = {
  id: string;               // UUID server
  email: string;
  name: string;
  picture_url: string | null;
};
```

### 4.2 Note

```ts
type Note = {
  id: string;               // UUID dibuat client
  title: string;            // boleh kosong
  content: string;          // plain text
  created_at: number;       // epoch millisecond
  updated_at: number;       // logical client time untuk LWW
  deleted_at: number | null;
  mutation_id: string;      // UUID mutasi state terakhir
  revision: number;         // revision server, 0 jika belum pernah diakui server
  server_updated_at: number;// epoch ms server, 0 jika hanya lokal
};
```

Field `user_id` tidak dikirim di payload note. Server selalu mengambil user dari session.

### 4.3 Effective Title dan Snippet

- Jika `title.trim()` tidak kosong, gunakan title tersebut.
- Jika title kosong, gunakan baris non-kosong pertama dari `content`, maksimum 80 karakter Unicode.
- Jika title dan content kosong, tampilkan **“Catatan tanpa judul”**.
- Snippet berasal dari content, whitespace berulang dinormalisasi menjadi satu spasi, maksimum 120 karakter.
- Effective title hanya computed untuk display. Nilai hasil derivasi tidak otomatis ditulis ke field `title`.

### 4.4 Batas Data

- `title`: maksimum 500 Unicode code point.
- `content`: maksimum 1.000.000 byte UTF-8 per note.
- Body JSON sync push: maksimum 2 MiB.
- Maksimum 100 mutation per push.
- UUID harus canonical lowercase `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
- Timestamp harus integer epoch millisecond positif dan aman direpresentasikan sebagai JavaScript `number`.
- `created_at <= updated_at`.
- `deleted_at` hanya boleh `null` atau sama dengan `updated_at` pada mutation delete.
- Newline disimpan sebagai `\n`; frontend menormalisasi `\r\n` menjadi `\n` sebelum save.
- Backend tidak melakukan HTML rendering terhadap title/content.

### 4.5 Logical Client Time

`updated_at` dipakai untuk urutan konflik, tetapi cursor sync tidak menggunakannya.

Client menyimpan `clock_offset_ms = server_time - Date.now()` setiap kali mendapat response API. Saat membuat timestamp mutasi:

```text
candidate_now = Date.now() + clock_offset_ms
updated_at = max(candidate_now, previous_note_updated_at + 1, last_device_timestamp + 1)
```

Aturan server:

- Tolak mutation bila `updated_at > server_time + 5 menit` dengan `422 CLOCK_SKEW`.
- Timestamp lama boleh masuk; comparator LWW akan menentukan menang atau kalah.
- Response API selalu menyertakan `server_time` agar offset dapat dikalibrasi.
- Bila mendapat `CLOCK_SKEW`, client memperbarui offset, memberi timestamp baru secara monotonic pada outbox yang terdampak, membuat `mutation_id` baru, lalu retry satu kali. Jangan retry tanpa batas.

---

## 5. Skema Database

Gunakan migration SQL bernomor dan jangan mengandalkan auto-create schema tersebar di kode.

### 5.1 Migration `0001_initial.sql`

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL
);

CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    google_sub      TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL,
    email_verified  INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
    name            TEXT NOT NULL DEFAULT '',
    picture_url     TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE user_sync_state (
    user_id        TEXT PRIMARY KEY,
    last_revision  INTEGER NOT NULL DEFAULT 0 CHECK (last_revision >= 0),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE notes (
    user_id            TEXT NOT NULL,
    id                 TEXT NOT NULL,
    title              TEXT NOT NULL DEFAULT '',
    content            TEXT NOT NULL DEFAULT '',
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    deleted_at         INTEGER,
    mutation_id        TEXT NOT NULL,
    revision           INTEGER NOT NULL CHECK (revision > 0),
    server_updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (created_at <= updated_at),
    CHECK (deleted_at IS NULL OR deleted_at = updated_at)
);

CREATE UNIQUE INDEX idx_notes_user_revision
    ON notes(user_id, revision);

CREATE INDEX idx_notes_user_active_updated
    ON notes(user_id, deleted_at, updated_at DESC);
```

### 5.2 Aturan Migrasi

- Binary mendukung subcommand `litenotes migrate` dan `litenotes serve`.
- Production deployment menjalankan `migrate` sebelum revision baru menerima traffic.
- `AUTO_MIGRATE=true` boleh dipakai di development, default production harus `false`.
- Setiap migration dijalankan transactionally dan dicatat di `schema_migrations` hanya setelah berhasil.
- Jangan mengubah migration yang sudah diterapkan; tambah file migration baru.
- Startup `serve` harus gagal cepat bila schema version database lebih lama atau lebih baru daripada yang didukung binary.
- Semua query menggunakan parameter binding. Dilarang membangun SQL dari input user dengan string concatenation.

### 5.3 Alokasi Revision

Setiap mutation yang menang WAJIB melakukan langkah berikut dalam satu transaction database:

1. Pastikan row `user_sync_state` tersedia ketika user dibuat.
2. Baca note saat ini untuk user dan ID tersebut.
3. Terapkan comparator LWW.
4. Jika mutation menang, increment revision secara atomik:

```sql
UPDATE user_sync_state
SET last_revision = last_revision + 1
WHERE user_id = ?
RETURNING last_revision;
```

5. Upsert note dengan revision hasil langkah 4.
6. Commit.

SQLite/libSQL write serialization dan transaction menjaga revision unik per user. Handler tidak boleh membuat revision dari memory process karena Cloud Run dapat menjalankan lebih dari satu instance.

---

## 6. Autentikasi dan Session

### 6.1 Login Google

Frontend menggunakan Google Identity Services JavaScript API dan popup UX:

1. Load script resmi `https://accounts.google.com/gsi/client` secara async. Jangan self-host script GIS dan jangan cache script tersebut di service worker.
2. Panggil `google.accounts.id.initialize()` tepat satu kali.
3. Render tombol resmi dengan `google.accounts.id.renderButton()`.
4. Callback menerima `response.credential` berupa Google ID token.
5. Kirim token melalui JSON ke `POST /api/v1/auth/google` dengan same-origin credentials.
6. Jangan decode token di frontend untuk keputusan keamanan.

Server memverifikasi token menggunakan `google.golang.org/api/idtoken.Validate(ctx, token, GOOGLE_CLIENT_ID)` dan memeriksa:

- Signature valid.
- `aud` sama dengan `GOOGLE_CLIENT_ID`.
- `iss` Google valid.
- `exp` belum lewat.
- `sub` tersedia.
- `email` tersedia.
- `email_verified` bernilai true.

Setelah valid:

- Upsert user berdasarkan `google_sub`.
- Update email, name, picture, dan `updated_at` pada login berikutnya.
- Jangan membuat user baru berdasarkan email.
- Terbitkan session JWT milik io-notes.

### 6.2 JWT Session

Gunakan HS256 dan claim berikut:

```json
{
  "iss": "litenotes",
  "aud": "litenotes-web",
  "sub": "<user UUID>",
  "jti": "<session UUID>",
  "iat": 1780000000,
  "nbf": 1780000000,
  "exp": 1782592000
}
```

Aturan:

- Masa berlaku default 30 hari, configurable melalui `SESSION_TTL`.
- `SESSION_SECRET` minimum 32 byte random dan tidak boleh memiliki default production.
- Parser WAJIB menolak algorithm selain HS256 meskipun token menyebut algorithm lain.
- Validasi signature, issuer, audience, expiry, not-before, dan subject.
- Toleransi clock maksimum 30 detik.
- Token tidak pernah dikirim dalam response JSON atau localStorage.

Cookie production:

```text
Name: __Host-litenotes_session
HttpOnly: true
Secure: true
SameSite: Lax
Path: /
Domain: tidak diset
Max-Age: sama dengan session TTL
```

Development localhost boleh memakai nama `litenotes_session` dan `Secure=false` hanya ketika `APP_ENV=development`.

### 6.3 Logout dan Account Switching

- `POST /api/v1/auth/logout` menghapus cookie dengan atribut Path/SameSite/Secure yang sama dan `Max-Age=0`.
- Frontend memanggil `google.accounts.id.disableAutoSelect()` bila tersedia.
- Logout aman membutuhkan koneksi karena JavaScript tidak dapat menghapus cookie httpOnly. Jika offline, tampilkan **“Hubungkan ke internet untuk logout dengan aman”** dan jangan berpura-pura bahwa session server sudah berakhir.
- Jika outbox aktif belum kosong, UI mencoba sync terlebih dahulu. Jika tidak berhasil, tampilkan konfirmasi bahwa logout akan menghapus perubahan lokal yang belum tersinkron; default action adalah Cancel.
- Setelah logout dikonfirmasi, hapus seluruh data lokal milik active user, termasuk notes, outbox, cursor, dan profile. Device ID global boleh dipertahankan.
- Login sebagai user berbeda tidak boleh menggabungkan namespace IndexedDB user sebelumnya.

### 6.4 Kondisi Offline dan Session Expired

- User yang sebelumnya login boleh membaca serta mengedit data lokal saat `/api/v1/me` gagal karena network.
- Kegagalan network berbeda dengan HTTP 401.
- Jika online dan `/api/v1/me` atau sync mendapat 401, tampilkan status **“Login diperlukan untuk sync”**. Edit lokal tetap diizinkan dan tetap masuk outbox.
- Setelah user login kembali dengan akun yang sama, sync dilanjutkan.
- Jika login kembali dengan akun berbeda, outbox akun lama tidak boleh dikirim memakai session akun baru.

---

## 7. Konvensi HTTP API

Base path: `/api/v1`.

### 7.1 Aturan Umum

- Request dan response menggunakan UTF-8 JSON kecuali health endpoint.
- Semua fetch frontend memakai `credentials: "same-origin"`.
- Endpoint state-changing hanya menerima `Content-Type: application/json`.
- API response harus memiliki `Cache-Control: no-store`.
- Server menambahkan `X-Request-ID`; gunakan ID valid dari inbound header atau generate UUID baru.
- Semua response JSON, termasuk error, menyertakan `server_time` epoch millisecond.
- Unknown field pada request JSON ditolak menggunakan strict decoder.
- Body yang memiliki lebih dari satu JSON value atau trailing garbage ditolak.
- Method yang salah menghasilkan 405 JSON, bukan HTML.
- Route `/api/*` yang tidak ditemukan menghasilkan 404 JSON.
- Tidak ada CORS header pada production karena aplikasi same-origin.

### 7.2 Error Envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request tidak valid",
    "request_id": "7d0dc0c7-2c60-4ac8-a5fb-41c92acfc169",
    "details": {
      "field": "mutations[0].note.title"
    }
  },
  "server_time": 1780000000123
}
```

Production error message tidak boleh memuat SQL, stack trace, JWT, Google token, secret, DSN, atau internal filesystem path.

Kode minimum:

| HTTP | Code | Kondisi |
|---:|---|---|
| 400 | `BAD_JSON` | JSON rusak/unknown field/trailing value |
| 400 | `VALIDATION_ERROR` | Field tidak memenuhi kontrak |
| 401 | `UNAUTHENTICATED` | Cookie tidak ada/invalid/expired |
| 403 | `ORIGIN_NOT_ALLOWED` | Origin state-changing request tidak sesuai |
| 404 | `NOT_FOUND` | Route atau resource tidak tersedia |
| 409 | `MUTATION_ID_REUSED` | Mutation ID current dipakai dengan payload berbeda |
| 413 | `PAYLOAD_TOO_LARGE` | Body melebihi batas |
| 422 | `CLOCK_SKEW` | Timestamp terlalu jauh di masa depan |
| 429 | `RATE_LIMITED` | Rate limit terlampaui |
| 500 | `INTERNAL_ERROR` | Error tak terduga |
| 503 | `DATABASE_UNAVAILABLE` | Turso tidak dapat dijangkau sementara |

### 7.3 CSRF dan Origin Validation

Untuk `POST`, `PUT`, `PATCH`, dan `DELETE`:

- Verifikasi header `Origin` sama persis dengan `APP_ORIGIN`.
- Jika `Origin` tidak tersedia, periksa `Sec-Fetch-Site` dan hanya izinkan `same-origin`/`none` sesuai kebutuhan; production browser request normal harus memiliki Origin.
- Tetap gunakan SameSite cookie. Origin check adalah lapisan tambahan, bukan pengganti.
- Jangan menerima mutation melalui query string atau HTML form encoding.

---

## 8. Kontrak API

### 8.1 Health

#### `GET /healthz`

- Tidak membutuhkan auth.
- Tidak melakukan query database.
- Response `200 text/plain`: `ok`.

#### `GET /readyz`

- Tidak membutuhkan auth.
- Ping database dengan timeout 2 detik dan verifikasi schema version.
- `200` jika siap; `503` jika tidak.
- Jangan memuat detail credential/error sensitif.

### 8.2 Login

#### `POST /api/v1/auth/google`

Request:

```json
{
  "id_token": "<Google ID token>"
}
```

Validation:

- `id_token` required, non-empty, maksimum 16 KiB.
- Body maksimum 20 KiB.

Response `200`, sekaligus `Set-Cookie`:

```json
{
  "user": {
    "id": "e384eddf-1781-44ee-9e92-4270ba10988b",
    "email": "user@example.com",
    "name": "Example User",
    "picture_url": "https://..."
  },
  "server_time": 1780000000123
}
```

Invalid Google credential selalu `401 UNAUTHENTICATED`; jangan membocorkan claim mana yang gagal ke client.

### 8.3 Logout

#### `POST /api/v1/auth/logout`

Request:

```json
{}
```

Response `200`:

```json
{
  "ok": true,
  "server_time": 1780000000123
}
```

Endpoint idempotent: cookie tidak ada tetap 200.

### 8.4 Current User

#### `GET /api/v1/me`

Response `200`:

```json
{
  "user": {
    "id": "e384eddf-1781-44ee-9e92-4270ba10988b",
    "email": "user@example.com",
    "name": "Example User",
    "picture_url": null
  },
  "server_time": 1780000000123
}
```

Session invalid/expired menghasilkan `401 UNAUTHENTICATED`.

### 8.5 Push Sync

#### `POST /api/v1/sync/push`

Request:

```json
{
  "device_id": "da4f6c77-b6f6-4516-843c-7911ce5db3ac",
  "mutations": [
    {
      "mutation_id": "bdf50ce8-365a-4a1f-a03f-0a041c67380a",
      "note": {
        "id": "914737cc-a59d-4d50-9ccc-3060c94f5c23",
        "title": "Belanja",
        "content": "Susu\nKopi",
        "created_at": 1780000000000,
        "updated_at": 1780000000100,
        "deleted_at": null
      }
    }
  ]
}
```

Semua mutation divalidasi sebelum transaction dimulai. Bila satu mutation invalid, seluruh request ditolak dan tidak ada write.

Response `200`:

```json
{
  "results": [
    {
      "mutation_id": "bdf50ce8-365a-4a1f-a03f-0a041c67380a",
      "status": "applied",
      "note": {
        "id": "914737cc-a59d-4d50-9ccc-3060c94f5c23",
        "title": "Belanja",
        "content": "Susu\nKopi",
        "created_at": 1780000000000,
        "updated_at": 1780000000100,
        "deleted_at": null,
        "mutation_id": "bdf50ce8-365a-4a1f-a03f-0a041c67380a",
        "revision": 42,
        "server_updated_at": 1780000000200
      }
    }
  ],
  "latest_cursor": 42,
  "server_time": 1780000000200
}
```

Nilai `status`:

- `applied`: mutation menang dan membuat revision baru.
- `unchanged`: retry mutation yang sama dengan payload sama; tidak membuat revision baru.
- `superseded`: state server menang menurut comparator; `note` berisi state authoritative server.

### 8.6 Comparator LWW

Bandingkan secara lexicographic:

```text
(incoming.updated_at, incoming.mutation_id)
vs
(stored.updated_at, stored.mutation_id)
```

Aturan:

1. Jika note belum ada, incoming menang.
2. Timestamp lebih besar menang.
3. Timestamp sama: string UUID `mutation_id` yang lebih besar secara byte/ASCII menang.
4. Tuple sama dan payload sama: `unchanged`.
5. Tuple sama tetapi payload berbeda: `409 MUTATION_ID_REUSED` dan rollback seluruh batch.
6. Incoming kalah: `superseded`, tidak increment revision.
7. Untuk note existing, server mempertahankan `created_at` yang sudah tersimpan; perubahan `created_at` dari client diabaikan setelah lolos validasi dasar.
8. Delete dan restore adalah state mutation biasa, bukan operasi khusus server.

Delete lokal:

```text
updated_at = nextLogicalTime()
deleted_at = updated_at
mutation_id = new UUID
```

Restore lokal:

```text
updated_at = nextLogicalTime()
deleted_at = null
mutation_id = new UUID
```

### 8.7 Pull Sync

#### `GET /api/v1/sync/pull?cursor=<revision>&limit=<n>`

- `cursor` required, integer `>= 0`.
- `limit` optional, default 200, minimum 1, maksimum 500.
- Initial sync menggunakan cursor `0`.

Query inti harus di-scope user:

```sql
SELECT id, title, content, created_at, updated_at, deleted_at,
       mutation_id, revision, server_updated_at
FROM notes
WHERE user_id = ? AND revision > ?
ORDER BY revision ASC
LIMIT ?;
```

Ambil `limit + 1` untuk menentukan `has_more` tanpa query count penuh.

Response `200`:

```json
{
  "notes": [
    {
      "id": "914737cc-a59d-4d50-9ccc-3060c94f5c23",
      "title": "Belanja",
      "content": "Susu\nKopi",
      "created_at": 1780000000000,
      "updated_at": 1780000000100,
      "deleted_at": null,
      "mutation_id": "bdf50ce8-365a-4a1f-a03f-0a041c67380a",
      "revision": 42,
      "server_updated_at": 1780000000200
    }
  ],
  "next_cursor": 42,
  "has_more": false,
  "latest_cursor": 42,
  "server_time": 1780000000300
}
```

Jika tidak ada note, `next_cursor` sama dengan cursor request. `latest_cursor` adalah nilai current `user_sync_state.last_revision`.

Server tidak perlu mengirim semua versi perubahan; hanya state terbaru tiap note. Revision pada row memastikan state terbaru tetap akan muncul bila berubah setelah page sebelumnya dibaca.

### 8.8 Endpoint yang Sengaja Tidak Ada

MVP tidak menyediakan `DELETE /notes/:id`, `restore`, atau hard-delete endpoint. Semua perubahan state—edit, delete, restore—masuk melalui outbox dan `/sync/push`, sehingga perilaku offline sama dengan online dan hanya ada satu jalur resolusi konflik.

---

## 9. IndexedDB

Database name: `litenotes`, schema version mulai dari `1`.

### 9.1 Object Store `notes`

Key path: `[user_id, id]`.

Record:

```ts
type LocalNote = Note & {
  user_id: string;
  deleted_flag: 0 | 1; // mirror dari deleted_at khusus kebutuhan index
};
```

Indexes:

- `by-user-updated`: `[user_id, updated_at]`.
- `by-user-deleted-updated`: `[user_id, deleted_flag, updated_at]`.

`deleted_flag` wajib selalu `1` bila `deleted_at` non-null dan `0` bila null. Field ini hanya lokal dan tidak dikirim ke API.

### 9.2 Object Store `outbox`

Key path: `[user_id, note_id]`. Hanya satu pending snapshot terbaru per note; autosave berikutnya mengganti record lama.

```ts
type OutboxRecord = {
  user_id: string;
  note_id: string;
  mutation_id: string;
  snapshot: {
    id: string;
    title: string;
    content: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
  queued_at: number;
  attempt_count: number;
  last_error_code: string | null;
};
```

Index `by-user-queued`: `[user_id, queued_at]`.

### 9.3 Object Store `meta`

Key path `key`, value bebas tetapi tervalidasi saat dibaca.

Minimum keys:

- `device_id` — UUID per instalasi/browser profile.
- `active_user_id`.
- `profile:<user_id>`.
- `sync_cursor:<user_id>` — integer, default 0.
- `clock_offset_ms`.
- `last_device_timestamp`.

### 9.4 Atomic Local Save

Setiap autosave WAJIB memakai satu IndexedDB read-write transaction yang:

1. Menulis snapshot terbaru ke `notes`.
2. Menulis/mengganti pending snapshot pada `outbox`.
3. Memperbarui `last_device_timestamp`.
4. Commit sebelum UI menampilkan **“Tersimpan lokal”**.

Jika transaction gagal, UI menampilkan error persisten dan tidak boleh mengklaim perubahan tersimpan.

### 9.5 Upgrade dan Corruption Handling

- Upgrade schema hanya dilakukan melalui callback versioned IndexedDB.
- Jangan menghapus database otomatis bila upgrade gagal.
- Tampilkan error recovery dengan opsi reload dan export diagnostic non-sensitive.
- Jangan menyimpan Google ID token atau session JWT di IndexedDB/localStorage.

---

## 10. Algoritma Sync Client

### 10.1 Trigger

Jalankan/schedule sync ketika:

- App boot dan session valid.
- Local save berhasil.
- Event browser `online`.
- Tab kembali visible/focus setelah minimal 30 detik.
- Retry timer aktif.
- User menekan tombol Retry.

Jangan bergantung pada Background Sync API karena dukungan browser tidak merata. Boleh menambahkannya sebagai optimasi setelah alur utama stabil.

### 10.2 Mutual Exclusion

- Hanya satu sync loop boleh aktif per browser profile.
- Gunakan `navigator.locks.request("litenotes-sync", { ifAvailable: true })` jika tersedia.
- Gunakan in-memory mutex sebagai fallback untuk satu tab.
- Gunakan `BroadcastChannel("litenotes")` untuk memberi tahu tab lain agar reload state lokal setelah perubahan.
- Server tetap wajib idempotent; client lock bukan jaminan keamanan.

### 10.3 Urutan Sync

```text
acquire lock
  ├─ pastikan online dan session valid
  ├─ PUSH outbox batches sampai kosong atau error
  ├─ PULL dari stored cursor sampai has_more=false
  ├─ publish status + BroadcastChannel notification
release lock
```

Push dilakukan sebelum pull supaya perubahan offline ikut dipertimbangkan oleh LWW sebelum state cloud digabungkan.

### 10.4 Menangani Push Acknowledgement

Untuk setiap result, lakukan IndexedDB transaction:

1. Baca outbox current untuk note.
2. Jika current outbox `mutation_id` sama dengan mutation yang dikirim:
   - Hapus outbox record.
   - Simpan authoritative `result.note` ke local notes.
3. Jika outbox sudah memiliki mutation lebih baru karena user mengetik ketika request berjalan:
   - Jangan hapus outbox terbaru.
   - Jangan menimpa title/content optimistic terbaru.
   - Boleh memperbarui metadata server hanya jika tidak merusak comparator; implementasi paling aman adalah membiarkan mutation terbaru diselesaikan pada push berikutnya.
4. Untuk `superseded`, authoritative server state hanya boleh menimpa local state jika tidak ada pending mutation lebih baru yang menang menurut comparator.

Ini mencegah response request lama menghapus edit baru yang dibuat selama request in-flight.

### 10.5 Menangani Pull

Untuk setiap page, lakukan satu IndexedDB transaction:

1. Untuk setiap remote note, baca local note dan outbox note tersebut.
2. Jika tidak ada outbox, simpan remote note.
3. Jika ada outbox:
   - Jika tuple outbox lebih besar daripada remote, pertahankan local optimistic state dan outbox.
   - Jika tuple remote lebih besar atau sama, simpan remote dan hapus outbox yang kalah/sama.
4. Setelah seluruh note page berhasil, set `sync_cursor:<user>` ke `next_cursor` dalam transaction yang sama.
5. Commit, lalu bila `has_more=true`, ambil page berikutnya.

Batasi maksimal 20 page dalam satu loop agar UI tidak dimonopoli. Jika masih `has_more`, yield ke event loop lalu schedule continuation segera.

### 10.6 Retry

- Network error, 429, 500, dan 503: exponential backoff dengan jitter: sekitar 1s, 2s, 4s, 8s, 16s, maksimum 60s.
- Hormati `Retry-After` bila tersedia.
- 401: hentikan retry sampai login berhasil.
- 400/409 validation/programming error: hentikan mutation terdampak, tampilkan error, log request ID; jangan infinite retry.
- 422 `CLOCK_SKEW`: lakukan mekanisme kalibrasi §4.5, retry satu kali.
- Reset backoff setelah satu sync loop lengkap berhasil.

### 10.7 Sync Status UI

Prioritas status tertinggi ke terendah:

1. `error` — **“Gagal menyimpan”** atau **“Sync gagal — Coba lagi”**.
2. `auth-required` — **“Login diperlukan untuk sync”**.
3. `offline` + outbox — **“Offline — tersimpan lokal”**.
4. `saving-local` — **“Menyimpan…”**.
5. `syncing` — **“Menyinkronkan…”**.
6. outbox kosong dan sync sukses — **“Tersinkron”**.

Jangan menampilkan **“Tersinkron”** hanya karena IndexedDB save berhasil.

---

## 11. UX dan UI

### 11.1 Desktop

- Breakpoint utama: `768px`.
- Lebar sidebar sekitar 320px, minimum 260px, maksimum 380px.
- Sidebar berisi header, tombol new note, switch Notes/Trash, daftar note, user menu, dan status sync.
- Editor memenuhi area kanan.
- Note selected diberi state visual dan `aria-current` yang sesuai.

### 11.2 Mobile

- Default menampilkan list.
- Memilih note membuka editor full-screen.
- Tombol back mengembalikan ke list tanpa kehilangan draft.
- Gunakan hash routing agar refresh/offline tidak membutuhkan route server khusus:
  - `#/notes`
  - `#/notes/<uuid>`
  - `#/trash`
- Browser back harus bekerja secara wajar.

### 11.3 Editor

- Input title satu baris dan `<textarea>` content.
- Autosave debounce 600ms setelah input terakhir.
- Flush save segera ketika pindah note, blur editor, page menjadi hidden, atau sebelum aksi delete/restore.
- Dilarang memakai synchronous network request pada unload.
- Title dan content tidak dirender dengan `dangerouslySetInnerHTML`.
- `textarea` menggunakan font yang mudah dibaca, line-height minimum 1.5, dan resize mengikuti layout.
- Keyboard shortcut desktop:
  - `Ctrl/Cmd + N`: new note.
  - `Ctrl/Cmd + S`: cegah browser Save Page, lalu flush local save; tidak diperlukan untuk penggunaan normal.

### 11.4 New Note

1. Generate note ID dan waktu logical saat tombol `+` ditekan.
2. Buka editor dan focus title.
3. Draft kosong tetap di memory sampai input pertama.
4. Pada input pertama, simpan ke IndexedDB + outbox.
5. Jika user meninggalkan draft kosong yang belum pernah disimpan/sync, buang draft tanpa membuat blank note.

### 11.5 Delete dan Trash

- Delete selalu soft delete melalui local mutation.
- Setelah delete, note hilang dari main list segera dan masuk Trash segera.
- Jika note aktif dihapus, pilih note aktif berikutnya; jika tidak ada, tampilkan empty state.
- Trash diurutkan `deleted_at` descending.
- Restore membuat mutation baru, menghapus `deleted_at`, dan note kembali ke main list.
- Tidak ada tombol permanent delete atau empty trash pada MVP.

### 11.6 List Note

- Urutkan `updated_at` descending.
- Tampilkan effective title, snippet, dan waktu relatif.
- Waktu relatif diperbarui minimal setiap 60 detik ketika tab visible.
- Empty state Notes: **“Belum ada catatan”** dan tombol **“Buat catatan”**.
- Empty state Trash: **“Trash kosong”**.
- List panjang harus tetap responsif. Virtualization tidak wajib untuk MVP; hindari rerender seluruh editor pada setiap tick waktu relatif.

### 11.7 Login Screen

- Tampilkan nama io-notes, deskripsi singkat, dan tombol resmi Sign in with Google.
- Jika GIS gagal dimuat karena offline tetapi local user tersedia, berikan tombol **“Buka catatan offline”**.
- Jika belum pernah login dan offline, jelaskan bahwa login pertama membutuhkan internet.
- Jangan membuat tombol Google palsu ketika library belum tersedia.

### 11.8 Accessibility

- Seluruh aksi dapat diakses keyboard.
- Focus visible tidak boleh dihilangkan.
- Tombol icon-only memiliki `aria-label` bahasa Indonesia.
- Status sync menggunakan `aria-live="polite"`, kecuali error kritis boleh `assertive`.
- Kontras minimal mengikuti WCAG AA.
- Modal konfirmasi logout menjebak focus dan dapat ditutup dengan Escape.
- Respect `prefers-reduced-motion`.

---

## 12. PWA dan Caching

### 12.1 Manifest

`manifest.webmanifest` minimum:

```json
{
  "name": "io-notes",
  "short_name": "io-notes",
  "description": "Catatan ringan yang tetap bekerja offline",
  "start_url": "/#/notes",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "lang": "id-ID",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Tambahkan Apple touch icon. Icon final harus valid, tidak transparan seluruhnya, dan memiliki safe zone maskable.

### 12.2 Service Worker Strategy

- Precache `index.html`, `app.js`, `app.css`, manifest, dan icon melalui daftar aset manual pada `sw.js`.
- Navigation request: network-first dengan timeout singkat dan cached `index.html` sebagai fallback.
- Static assets: cache-first; aset yang berubah harus menaikkan versi cache pada `sw.js`.
- `/api/*`: network-only dan tidak pernah masuk Cache Storage.
- `https://accounts.google.com/gsi/*`: network-only; jangan self-host atau precache.
- Batasi cache hanya pada origin/aset yang dinyatakan.
- Hapus cache version lama pada activation.
- Jangan menjalankan `skipWaiting` diam-diam ketika ada editor aktif. Tampilkan toast **“Versi baru tersedia — Muat ulang”**; reload hanya setelah local save selesai.

### 12.3 Static Server Cache Headers

- `/index.html`: `Cache-Control: no-cache`.
- `/service-worker.js` atau generated SW: `Cache-Control: no-cache`.
- `/manifest.webmanifest`: `Cache-Control: public, max-age=3600`.
- Hashed assets: `Cache-Control: public, max-age=31536000, immutable`.
- API: `Cache-Control: no-store`.

### 12.4 Install UX

- Simpan event `beforeinstallprompt` jika browser menyediakannya dan tampilkan tombol Install.
- Jangan menganggap event tersebut tersedia di semua browser.
- Di iOS/iPadOS, tampilkan instruksi Add to Home Screen yang ringkas bila app belum standalone.
- Sembunyikan install CTA ketika app berjalan dalam display-mode standalone.

---

## 13. Backend HTTP dan Static Serving

### 13.1 Embed Layout

Go `//go:embed` tidak boleh menggunakan parent path. Karena itu embedding dilakukan dari file di direktori `web`:

```text
/web/embed.go       package webassets; //go:embed all:dist
/web/dist/...       hasil Vite build
```

`cmd/server` mengimpor package `webassets` dan menggunakan `fs.Sub(embeddedFS, "dist")`.

### 13.2 SPA Fallback

- `/api/*`, `/healthz`, dan `/readyz` selalu ditangani sebelum static handler.
- File static yang ada disajikan langsung.
- Request GET/HEAD dengan `Accept: text/html` yang tidak cocok file boleh mendapat `index.html`.
- Missing asset seperti `.js`, `.css`, `.png`, dan source map menghasilkan 404, bukan `index.html`.
- Path traversal harus ditolak/ditangani aman oleh `http.FileServer`/`fs.ValidPath`.

### 13.3 Server Lifecycle

- Listen pada `0.0.0.0:$PORT`; default development `8080`.
- Read header timeout: 5s.
- Read timeout: 15s.
- Write timeout: 30s untuk sync payload wajar.
- Idle timeout: 60s.
- Tangani `SIGTERM`/`SIGINT`; berhenti menerima request dan graceful shutdown maksimum 9 detik agar sesuai lifecycle Cloud Run.
- Database connection diinisialisasi sekali dan di-close saat shutdown.
- Jangan log DSN karena auth token dapat berada dalam query parameter connection string.

---

## 14. Security

### 14.1 Security Headers

Set minimum:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Resource-Policy: same-origin
```

CSP production harus mengizinkan GIS resmi dan aset sendiri. Baseline:

```text
default-src 'self';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';
form-action 'self';
script-src 'self' https://accounts.google.com/gsi/client;
style-src 'self' https://accounts.google.com/gsi/style;
img-src 'self' data: https:;
connect-src 'self' https://accounts.google.com/gsi/;
frame-src https://accounts.google.com/gsi/;
manifest-src 'self';
worker-src 'self';
```

Jika popup GIS gagal saat FedCM tidak aktif, set COOP sesuai rekomendasi GIS (`same-origin-allow-popups`) setelah diuji; jangan menambahkan header secara buta yang memutus popup.

### 14.2 Data Isolation

Aturan paling penting:

- Jangan menerima `user_id` dari request sync.
- Semua SELECT/UPDATE/INSERT note selalu menggunakan `user_id` dari verified session.
- Primary key note adalah `(user_id, id)`.
- Response superseded hanya boleh mengambil row dengan user session yang sama.
- Test isolasi dua user wajib ada pada repository dan HTTP layer.

### 14.3 Abuse Protection

- Login: token bucket in-memory per IP, kira-kira 10 request/menit dengan burst 20.
- Sync push: maksimum 30 request/menit per user dengan burst yang cukup untuk reconnect.
- Sync pull: maksimum 120 request/menit per user.
- In-memory rate limit bersifat best-effort per instance; dokumentasikan keterbatasannya. Distributed rate limiting bukan scope MVP.
- Gunakan IP dari platform/proxy terpercaya saja; jangan mempercayai arbitrary `X-Forwarded-For` tanpa aturan proxy.

### 14.4 Secret dan Logging

- Jangan commit `.env`, Turso token, Google token, atau session secret.
- Redact cookie, Authorization, `id_token`, dan query parameter `authToken` dari log.
- Jangan log title/content note pada production.
- Log metadata seperti request ID, route, status, latency, user ID ter-hash/UUID bila diperlukan, jumlah mutation, dan error code.

---

## 15. Konfigurasi

| Env | Required | Default | Keterangan |
|---|---:|---|---|
| `APP_ENV` | no | `development` | `development`, `test`, `production` |
| `APP_ORIGIN` | production yes | `http://localhost:8080` | Origin exact tanpa trailing slash |
| `PORT` | no | `8080` | Diisi Cloud Run |
| `GOOGLE_CLIENT_ID` | yes | — | OAuth Web Client ID |
| `SESSION_SECRET` | yes | — | Minimum 32 byte random |
| `SESSION_TTL` | no | `720h` | 30 hari |
| `TURSO_DATABASE_URL` | yes | — | `libsql://...` atau URL dev |
| `TURSO_AUTH_TOKEN` | production yes | empty dev | Jangan dilog |
| `AUTO_MIGRATE` | no | `false` | Hanya convenience development |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |

Config loader melakukan validasi saat startup dan mengembalikan satu error ringkas berisi nama config invalid, tanpa nilai secret. Production startup wajib gagal bila:

- `APP_ORIGIN` bukan HTTPS.
- Session secret terlalu pendek.
- Google client ID kosong.
- Database URL/token kosong.
- `AUTO_MIGRATE=true` jika kebijakan deployment tidak mengizinkan migration startup.

Frontend membutuhkan Google client ID. Sajikan runtime config non-secret dari endpoint atau script same-origin yang dihasilkan server, misalnya `GET /config.js`:

```js
window.__LITENOTES_CONFIG__ = Object.freeze({
  googleClientId: "...apps.googleusercontent.com"
});
```

- `/config.js` menggunakan `Cache-Control: no-store`.
- Hanya nilai public boleh ada di sana.
- Jangan bake secret ke Vite bundle.

---

## 16. Struktur Repository

```text
/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── app/                 # composition root/router/server lifecycle
│   ├── auth/                # Google verifier, JWT session, middleware
│   ├── config/              # env parsing + validation
│   ├── database/            # connection + migration runner
│   │   └── migrations/
│   │       └── 0001_initial.sql
│   ├── httpx/               # JSON/error/request ID/security middleware
│   ├── sync/                # domain, validation, service, repository, handlers
│   └── testutil/            # test-only helpers
├── web/
│   ├── embed.go             # embeds dist
│   └── dist/
│       ├── index.html
│       ├── app.js            # vanilla UI, IndexedDB, API client, sync loop
│       ├── app.css
│       ├── manifest.webmanifest
│       ├── sw.js
│       └── icon.svg
├── Dockerfile
├── Makefile
├── .dockerignore
├── .gitignore
├── go.mod
├── go.sum
├── README.md
└── PRD-notepad-pwa.md
```

MVP tidak membutuhkan package manager frontend. Jika bundler ditambahkan pada fase upgrade, gunakan satu package manager secara konsisten dan commit lockfile.

---

## 17. Observability

### 17.1 Structured Log

Satu log per completed request dengan field minimum:

- `request_id`
- `method`
- `route` template, bukan raw URL berisi data
- `status`
- `duration_ms`
- `response_bytes`
- `error_code` jika ada
- `mutation_count` untuk push
- `note_count` untuk pull

Log startup memuat app version, commit SHA bila tersedia, environment, port, dan schema version—tanpa secret.

### 17.2 Metrics Minimum dari Log

Walau belum memakai Prometheus, log harus memungkinkan pengukuran:

- Request count dan error rate per route.
- Latency p50/p95.
- Push applied/unchanged/superseded count.
- Pull note count.
- Database failure.
- Login failure tanpa menulis token atau email.

---

## 18. Testing Strategy

### 18.1 Go Unit Tests

WAJIB mencakup:

- LWW: newer timestamp, older timestamp, equal timestamp tie-break, exact retry, mutation reuse.
- Timestamp/UUID/title/content validation.
- JWT valid, expired, wrong issuer, wrong audience, wrong algorithm, tampered signature.
- Google verifier interface memakai fake; jangan memanggil Google pada unit test.
- JSON decoder menolak unknown field, oversized body, trailing JSON.
- Static fallback tidak mengembalikan HTML untuk missing JS/CSS.

Jalankan dengan `go test ./...` dan `go test -race ./...` bila environment mendukung.

### 18.2 Repository Integration Tests

Gunakan database SQLite/libSQL test sementara dengan SQL yang kompatibel. WAJIB menguji:

- Migration dari database kosong.
- Upsert new note.
- Revision bertambah hanya pada applied mutation.
- Retry unchanged tidak membuat revision.
- Mutation superseded tidak membuat revision.
- Pull cursor dan pagination tidak melewatkan note.
- Delete/restore muncul sebagai revision baru.
- Dua concurrent mutation menghasilkan revision unik.
- User A tidak dapat membaca, mengubah, atau menerima state User B.
- Transaction rollback ketika salah satu mutation dalam batch invalid/reused.

### 18.3 Frontend Unit Tests

Gunakan Vitest dan fake IndexedDB. WAJIB menguji:

- Effective title/snippet.
- Logical clock monotonic.
- Atomic local save menghasilkan note + outbox.
- Autosave coalesces beberapa input menjadi snapshot terbaru.
- Ack lama tidak menghapus outbox baru.
- Pull tidak menimpa pending mutation yang lebih baru.
- Cursor hanya maju setelah local transaction berhasil.
- Logout membersihkan namespace user.
- Network error, 401, 422, dan retry status.

### 18.4 End-to-End

Gunakan Playwright. Google login asli tidak perlu dijalankan di CI; backend test mode/fake verifier hanya boleh di-enable pada test binary/config yang tidak mungkin aktif di production.

Skenario wajib:

1. Login test user, create note, reload, note tetap ada.
2. Ketik cepat, autosave hanya menyimpan state akhir.
3. Simulasikan offline, edit note, reload offline, edit tetap terlihat.
4. Kembali online, outbox kosong setelah push sukses.
5. Dua browser context mensimulasikan dua device dan menerima perubahan.
6. Conflict timestamp berbeda menghasilkan pemenang deterministik.
7. Delete muncul di Trash pada device lain; restore kembali ke list.
8. Session 401 tidak menghapus outbox.
9. Logout dengan pending change menampilkan peringatan.
10. Service worker tidak meng-cache `/api/v1/me` atau sync response.

### 18.5 Build Verification

Sebelum selesai, WAJIB sukses:

```text
frontend lint
frontend typecheck
frontend unit test
frontend production build
go fmt / formatting check
go vet ./...
go test ./...
go build ./cmd/server
Docker image build
```

Jalankan Lighthouse/PWA check pada production build lokal. Catat keterbatasan browser jika kriteria installability berbeda antar-browser.

---

## 19. Performance dan Reliability

Target awal, diukur pada payload wajar:

- Go process siap menerima request dalam < 1 detik setelah dependency tersedia.
- API p95 < 300 ms untuk push/pull hingga 100 note kecil, tidak termasuk cold network ekstrem.
- First app shell terkompresi sekecil mungkin; target initial JS gzip < 100 KiB.
- Input editor tetap responsif dan tidak menunggu IndexedDB/network.
- Pull paginated; server tidak memuat seluruh akun ke memory tanpa batas.
- List 2.000 note lokal masih usable.
- Satu kegagalan network tidak menyebabkan kehilangan note atau outbox.

Gunakan gzip/brotli dari Cloud Run/proxy bila tersedia. Jangan menambahkan custom compression sebelum mengukur kebutuhan.

---

## 20. Deployment

### 20.1 Docker

Gunakan multi-stage build:

1. Karena aset MVP sudah berupa static files di `web/dist`, runtime build tidak memerlukan Node.js. Jika frontend sudah memakai bundler, jalankan build pada local/CI sebelum tahap Go.
2. Go stage menyalin `web/dist`, menjalankan test/build sesuai CI, lalu compile `CGO_ENABLED=0` untuk target deployment (`linux/arm64` untuk papandayan-public, `linux/amd64` untuk Cloud Run).
3. Runtime image minimal non-root dengan CA certificates dan timezone data bila diperlukan.
4. Binary adalah satu-satunya application artifact; aset PWA sudah embedded.

Jangan menjalankan process supervisor atau Node server di runtime image.

### 20.2 Cloud Run

- Container listen pada `$PORT` di `0.0.0.0`.
- Minimum instances `0` untuk scale-to-zero pada tahap personal/free-tier.
- Set max instances konservatif untuk melindungi database dan biaya.
- Secret berasal dari Secret Manager/env deployment, bukan image.
- Deploy migration terlebih dahulu, lalu revision service.
- Health/readiness dicek setelah deploy.
- `APP_ORIGIN` harus sama dengan URL/domain publik final.
- Google OAuth Authorized JavaScript origins harus memuat production origin dan localhost development yang benar.

### 20.3 Rollback

- Schema migration harus backward-compatible minimal dengan satu revision aplikasi sebelumnya bila memungkinkan.
- Jangan drop/rename column dalam migration yang sama dengan deploy code baru.
- Rollback app tidak boleh gagal karena schema lebih baru yang additive.
- Backup/PITR Turso dikonfigurasi sesuai kemampuan plan sebelum data production dianggap penting.

Free-tier dan limit layanan dapat berubah. Verifikasi pricing/quota Turso dan Cloud Run pada hari deployment; jangan hard-code angka free-tier ke produk.

---

## 21. Tahapan Implementasi

### Tahap 0 — Bootstrap

- [ ] Buat struktur repo, Go module, static frontend, formatter, dan test runner.
- [ ] `web/dist` tersedia dan Go embed berhasil.
- [ ] Server melayani app shell, config, health, dan JSON 404 API.
- [ ] Docker multi-stage build sukses.

Exit criteria: satu binary dapat dijalankan dan halaman shell terbuka.

### Tahap 1 — Database dan Auth

- [ ] Config validation.
- [ ] Turso connection dan migration command.
- [ ] Google GIS login.
- [ ] Google token verification abstraction.
- [ ] Session JWT cookie dan auth middleware.
- [ ] `/me`, logout, security headers, origin validation.
- [ ] Auth tests.

Exit criteria: login production-style bekerja, refresh tetap login, cookie tidak dapat dibaca JavaScript.

### Tahap 2 — Local Notes UX

- [ ] IndexedDB schema native dan wrapper Promise.
- [ ] Notes list, editor, mobile navigation.
- [ ] New note dan autosave transaction.
- [ ] Soft delete + Trash + restore lokal.
- [ ] Sync status dasar dan offline boot.
- [ ] Browser/API tests untuk local repository.

Exit criteria: seluruh note lifecycle bekerja tanpa backend setelah user pernah login.

### Tahap 3 — Sync

- [ ] Database repository dan revision allocation.
- [ ] Push endpoint + idempotency + LWW.
- [ ] Pull cursor + pagination.
- [ ] Client outbox push/pull coordinator.
- [ ] Retry, clock skew, auth-required, cross-tab safety.
- [ ] Isolation/concurrency/integration tests.

Exit criteria: skenario dua device, offline edit, delete, restore, conflict, dan retry lulus.

### Tahap 4 — PWA dan Hardening

- [ ] Manifest dan icon.
- [ ] Workbox caching rules.
- [ ] Install/update UX.
- [ ] CSP/GIS compatibility.
- [ ] Accessibility pass.
- [ ] Rate limit, structured log, graceful shutdown.
- [ ] E2E, production build, Docker, Lighthouse/PWA checks.

Exit criteria: seluruh Definition of Done terpenuhi.

Jangan menunda IndexedDB ke fase setelah MVP; offline-first dan outbox adalah bagian inti arsitektur, bukan polish.

---

## 22. Acceptance Criteria MVP

### Auth

- [ ] User dapat login memakai tombol resmi Google.
- [ ] Google ID token diverifikasi server; token palsu/wrong audience ditolak.
- [ ] Refresh browser mempertahankan session.
- [ ] Cookie production memiliki HttpOnly, Secure, SameSite=Lax, Path=/, dan prefix `__Host-`.
- [ ] Logout menghapus cookie dan data lokal user setelah warning unsynced ditangani.

### Notes dan Offline

- [ ] Create/edit langsung terlihat tanpa menunggu jaringan.
- [ ] Autosave terjadi sekitar 600ms setelah user berhenti mengetik.
- [ ] Reload offline mempertahankan perubahan yang sudah berstatus tersimpan lokal.
- [ ] Note aktif dan Trash terpisah.
- [ ] Restore bekerja saat offline dan tersinkron saat online.
- [ ] Tidak ada manual Save yang dibutuhkan.

### Sync

- [ ] Device 1 create note, device 2 menerima note setelah sync.
- [ ] Device offline dapat edit lalu push saat online.
- [ ] Retry request yang sama tidak membuat revision/perubahan ganda.
- [ ] Cursor pagination tidak melewatkan perubahan.
- [ ] Conflict menghasilkan pemenang sama di server dan seluruh device.
- [ ] Delete tersinkron sebagai tombstone dan tidak hidup kembali dari device lama.
- [ ] Response lama tidak menghapus edit baru yang dibuat saat request in-flight.
- [ ] 401 tidak menghapus local note/outbox.

### Security dan Isolation

- [ ] User A tidak dapat melihat atau memodifikasi note User B, termasuk dengan menebak UUID.
- [ ] Semua mutation query di-scope `user_id` dari session.
- [ ] Unknown JSON field, oversized body, invalid UUID, dan future timestamp ditolak.
- [ ] API dan Google token tidak masuk service-worker cache atau log.
- [ ] State-changing cross-origin request ditolak.

### PWA dan Operasional

- [ ] App shell terbuka offline setelah pernah dimuat online.
- [ ] Manifest, icon 192/512/maskable, start URL, scope, dan standalone valid.
- [ ] App installable pada browser yang mendukung kriteria instalasi.
- [ ] Satu Go binary melayani API dan frontend.
- [ ] Container berjalan sebagai non-root, menerima `$PORT`, dan shutdown graceful.
- [ ] Health/readiness, structured log, test suite, build produksi, dan Docker build lulus.

---

## 23. Definition of Done

Pekerjaan belum selesai sampai seluruh hal berikut terpenuhi:

1. Seluruh acceptance criteria memiliki bukti test otomatis atau langkah verifikasi manual terdokumentasi.
2. Tidak ada test yang di-skip tanpa alasan tertulis.
3. Tidak ada secret atau credential nyata di git history/current diff.
4. README berisi setup Google OAuth, Turso, development, migration, test, build, dan deploy.
5. `.env.example` hanya berisi placeholder aman.
6. Production frontend benar-benar embedded; binary tetap dapat serve setelah source frontend tidak tersedia di runtime.
7. Error state offline/auth/database dapat dipahami user dan tidak menghilangkan data lokal.
8. User isolation diuji, bukan hanya diasumsikan dari handler.
9. Sync race ketika user mengetik saat push berjalan diuji.
10. Handoff menyebutkan keputusan, command verifikasi, hasil test, dan pekerjaan yang sengaja deferred.

---

## 24. Failure Modes yang Wajib Ditangani

| Failure | Perilaku yang diwajibkan |
|---|---|
| Offline saat boot, pernah login | Buka namespace user terakhir dan izinkan edit lokal |
| Offline saat boot, belum pernah login | Tampilkan bahwa login pertama butuh internet |
| IndexedDB save gagal | Jangan klaim saved; tampilkan error persisten |
| Push timeout setelah server commit | Retry idempotent; result `unchanged` |
| User mengetik saat push in-flight | Ack lama tidak menghapus outbox/edit baru |
| Pull page tersimpan sebagian | Transaction rollback; cursor tidak maju |
| Session expired | Outbox tetap ada; minta login untuk sync |
| Turso unavailable | Backoff; UI tetap local-first |
| Clock device terlalu maju | 422, recalibrate, satu controlled retry |
| Dua device edit bersamaan | Comparator LWW memberi hasil deterministik |
| Device lama membawa note yang sudah deleted | Tombstone dengan tuple lebih baru menang |
| Service worker versi lama | Tawarkan reload setelah local save aman |
| GIS script gagal dimuat | Offline access tersedia untuk known user; jangan tampilkan fake login |
| Login akun berbeda | Namespace tidak bercampur dan outbox lama tidak terkirim |

---

## 25. Fase Setelah MVP

Urutan rekomendasi:

### Fase 2

- Client-side search title/content dengan debounce.
- Pin note.
- Export/import plain JSON atau Markdown.
- Theme dark mode.
- Improved install guidance.

### Fase 3

- Folder/tag.
- Markdown preview.
- Attachment gambar dengan object storage terpisah.
- Account/session management dan revoke all sessions.

Status per 3 September 2026: folder, Markdown preview, dan attachment private sudah
diimplementasikan. Attachment mendukung preview inline untuk image, Markdown,
plain text, dan PDF; Word/Excel/ZIP menggunakan fallback download. Preview Markdown
dan text dibatasi 512 KiB, HTML selalu di-escape, dan response inline memakai CSP
sandbox. Account/session management lanjutan dan revoke-all session tetap backlog.

### Permanent Delete

Permanent delete tidak boleh sekadar menghapus row `notes`. Desain berikutnya membutuhkan purge tombstone atau retention protocol yang memastikan seluruh device tidak menghidupkan kembali note lama. Fitur ini harus memiliki PRD sync tersendiri.

---

## 26. Referensi Implementasi Resmi

- Google Identity Services — backend authentication dan validasi ID token:  
  https://developers.google.com/identity/sign-in/web/backend-auth
- Google Identity Services — setup dan Content Security Policy:  
  https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
- Google Go ID token validator:  
  https://pkg.go.dev/google.golang.org/api/idtoken
- Turso Go SDK untuk remote server/container:  
  https://docs.turso.tech/sdk/go/quickstart
- Cloud Run container runtime contract:  
  https://cloud.google.com/run/docs/container-contract
- PWA web app manifest/installability:  
  https://web.dev/learn/pwa/web-app-manifest

Referensi digunakan untuk detail integrasi yang dapat berubah. Pada saat eksekusi/deploy, verifikasi kembali dokumentasi resmi, kompatibilitas dependency, quota, dan perilaku browser terbaru tanpa mengubah kontrak produk/sync secara diam-diam.

---

## 27. Deployment Papandayan Public — ARM64 Low Memory

Deployment target awal adalah host `papandayan-public`:

- Arsitektur: `aarch64/ARM64`.
- Kernel lama: Linux 5.9 arm64.
- RAM terdeteksi sekitar 924 MiB dengan swap sekitar 462 MiB.
- Root filesystem sekitar 5.8 GiB, free space sekitar 2 GiB.
- Port yang sudah digunakan: 80 (nginx), 8080 (wa-gateway), dan 8081 (sms-gateway).
- Port io-notes: `8091` pada loopback (`127.0.0.1`).
- Service existing tidak boleh dihentikan atau direstart sebagai bagian deploy io-notes.

### 27.1 Aturan Build

Jangan compile di `papandayan-public`. Host hanya menerima artifact final dan menjalankan binary.

Build dari komputer development:

```bash
cd litenotes
mkdir -p build
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags='-s -w' \
  -o build/litenotes-linux-arm64 ./cmd/server
file build/litenotes-linux-arm64
```

Syarat artifact:

- Harus ELF 64-bit LSB executable, ARM aarch64.
- Tidak boleh memerlukan shared library atau Node.js di host.
- Frontend sudah tersedia di `web/dist` dan ter-embed ke binary.
- Sebelum copy, jalankan `go test ./...` dan smoke test lokal.
- Hitung SHA-256 artifact sebelum dan sesudah transfer.
- Jangan menyalin `go.mod`, source, `node_modules`, atau dependency build ke host kecuali untuk debugging yang disetujui.

`modernc.org/sqlite` dipakai agar fallback SQLite dapat berjalan tanpa CGO. Jika `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN` tersedia, binary dapat memakai driver libSQL remote. Deployment awal ke host menggunakan SQLite lokal karena credential Turso belum tersedia; migrasi ke Turso cukup dengan mengganti env dan menjalankan migration/backup sesuai §5.

### 27.2 Layout Host

Gunakan layout berikut di host:

```text
/opt/litenotes/
├── bin/litenotes
├── data/litenotes.db
├── env/litenotes.env       # mode 0600, dibuat manual di host
└── releases/<timestamp>/   # optional rollback artifact
```

Buat direktori dengan owner `root:root`, permission directory `0750`, dan env file `0600`. Database tidak boleh disimpan di `/tmp`.

### 27.3 Environment Deployment Awal

File `/opt/litenotes/env/litenotes.env` minimum:

```dotenv
APP_ENV=development
APP_ORIGIN=http://127.0.0.1:8091
AUTH_MODE=dev
SESSION_SECRET=<random-minimum-32-byte-secret>
PORT=8091
TURSO_DATABASE_URL=file:/opt/litenotes/data/litenotes.db
```

`APP_ENV=development` + `AUTH_MODE=dev` hanya boleh dipakai selama service belum dipublikasikan ke internet dan hanya untuk smoke test internal. Sebelum public exposure WAJIB:

1. Set `AUTH_MODE=google`.
2. Set `GOOGLE_CLIENT_ID` yang benar.
3. Set `APP_ORIGIN` ke HTTPS public origin yang sebenarnya.
4. Ganti `SESSION_SECRET` production random.
5. Uji Google OAuth Authorized JavaScript origins.

Jangan mengekspos endpoint `/api/v1/auth/dev` pada public deployment.

### 27.4 systemd Unit

File `/etc/systemd/system/litenotes.service`:

```ini
[Unit]
Description=io-notes offline-first notes server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/litenotes
EnvironmentFile=/opt/litenotes/env/litenotes.env
ExecStart=/opt/litenotes/bin/litenotes
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/litenotes/data
MemoryMax=256M
LimitNOFILE=4096
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

Catatan: bila database atau service existing membutuhkan root policy yang berbeda, gunakan dedicated unprivileged user setelah permission diverifikasi. `MemoryMax` harus diuji; naikkan hanya jika kebutuhan nyata dan RAM host mencukupi.

### 27.5 Prosedur Transfer dan Deploy

Dijalankan dari local machine:

```bash
sha256sum build/litenotes-linux-arm64
scp build/litenotes-linux-arm64 papandayan-public:/tmp/litenotes-linux-arm64.new
```

Di host:

```bash
install -d -m 0750 /opt/litenotes/bin /opt/litenotes/data /opt/litenotes/env
install -m 0755 /tmp/litenotes-linux-arm64.new /opt/litenotes/bin/litenotes.new
sha256sum /opt/litenotes/bin/litenotes.new
mv /opt/litenotes/bin/litenotes.new /opt/litenotes/bin/litenotes
systemctl daemon-reload
systemctl enable --now litenotes
systemctl restart litenotes
systemctl is-active litenotes
curl --fail http://127.0.0.1:8091/healthz
curl --fail http://127.0.0.1:8091/readyz
```

Jangan menjalankan `go`, `npm`, `pnpm`, Docker build, atau migration build-time di host ARM low-memory. Rollback dilakukan dengan mengganti binary ke artifact release sebelumnya lalu `systemctl restart litenotes`.

### 27.6 Public Exposure

Port `8091` default hanya loopback. Untuk public exposure, pilih satu route yang tidak bertabrakan dengan service existing:

- Tambahkan hostname baru pada Cloudflare Tunnel yang menunjuk ke `http://localhost:8091`, atau
- Tambahkan virtual host nginx khusus yang reverse proxy ke `127.0.0.1:8091`.

Jangan mengganti catch-all nginx/cloudflared route sebelum hostname dan OAuth origin dikonfirmasi. Setelah hostname tersedia:

1. Update `APP_ORIGIN` ke `https://<hostname>`.
2. Set `AUTH_MODE=google` dan `GOOGLE_CLIENT_ID`.
3. Restart service.
4. Uji `/healthz`, login Google, cookie Secure, service worker, dan sync dua browser.

Status deployment per 3 September 2026:

- DNS CNAME `note.indoomega.my.id` sudah dibuat di Cloudflare dan proxied.
- Cloudflare Tunnel `3c998b49-c0ad-43e8-8ff4-2a4d268ed2ba` sudah memiliki ingress `note.indoomega.my.id -> http://localhost:8091`.
- HTTPS `https://note.indoomega.my.id/`, `/healthz`, dan manifest sudah lulus smoke test.
- Binary/service tetap bind loopback di host.
- Public request tidak dapat memakai `/api/v1/auth/dev`; endpoint tersebut dikunci hanya untuk Host localhost/127.0.0.1.
- `GOOGLE_CLIENT_ID` sudah dikonfigurasi pada host dan `AUTH_MODE=google` + `APP_ENV=production` sudah aktif dengan session secret baru. Invalid Google credential diuji menghasilkan 401 dan endpoint dev-auth publik menghasilkan 404.
- Login Google real masih perlu diuji manual dari browser dengan akun yang sudah didaftarkan sebagai OAuth test user/authorized account.
- Release `2eb2ad0` menambahkan preview attachment Markdown, plain text, dan PDF; shell PWA `v67`, health/readiness publik, serta konfigurasi R2 aktif sudah lulus smoke test.

### 27.7 Password per Note dan Reset via Email

Note dapat diberi password individual dari tombol `Password`. Password minimal 8 karakter dan disimpan sebagai bcrypt hash; plaintext password tidak pernah disimpan atau dicatat di log. Note terkunci menampilkan metadata minimal dan harus di-unlock sebelum isi dibuka. Endpoint yang tersedia:

- `PUT /api/v1/notes/{id}/password` — set/ganti password.
- `DELETE /api/v1/notes/{id}/password` — hapus password.
- `POST /api/v1/notes/{id}/unlock` — validasi password.
- `POST /api/v1/notes/{id}/password/reset-request` — membuat token reset sekali pakai.
- `POST /api/v1/notes/{id}/password/reset` — set password baru memakai token.

Token reset disimpan hanya dalam bentuk SHA-256 hash, berlaku 15 menit, dan ditandai terpakai setelah berhasil. Link dikirim ke email akun Google yang sedang login. Konfigurasi email memakai SMTP Brevo (direkomendasikan pada host ARM): `RESET_SMTP_ADDR`, `RESET_SMTP_USER`, `RESET_SMTP_PASSWORD`, `RESET_EMAIL_FROM`, dan `RESET_EMAIL_FROM_NAME`. `BREVO_API_KEY` tetap didukung sebagai fallback API.

Fitur ini adalah access lock pada aplikasi, bukan enkripsi end-to-end: isi note tetap tersedia untuk server dan client yang sudah terautentikasi. E2E encryption memerlukan desain kunci dan recovery terpisah.

### 27.8 Folder Organisasi Note

User dapat membuat folder, memfilter daftar note berdasarkan folder, dan memilih folder dari editor note. Note tanpa folder tetap berada pada tampilan `Semua`. Folder dapat diganti nama atau dihapus; saat folder dihapus, note di dalamnya dipindahkan menjadi tanpa folder. `folder_id` ikut masuk payload sync sehingga perubahan folder pada note tetap tersinkron antar perangkat.
