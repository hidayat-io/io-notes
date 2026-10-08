# Share Note via Inline Token — Design

Tanggal: 2026-10-08

## Tujuan

Owner bisa membagikan satu note lewat link. Penerima membuka link itu dan membaca note
**tanpa login**. Link membawa token (capability URL), dan siapa pun yang punya link bisa
membaca, selama owner belum mematikannya.

## Keputusan

| Hal | Keputusan |
|---|---|
| Akses penerima | Read-only |
| Isi yang dilihat | Live: selalu versi terbaru note, bukan snapshot |
| Attachment | Tidak ikut. Baris `![nama](attach:id)` tampil sebagai label nama file, tidak bisa dibuka |
| Masa berlaku | Tidak ada expiry. Satu note punya paling banyak satu link; owner bisa revoke atau regenerate |
| Posisi token | Di fragment: `/s#<token>`. Fragment tidak dikirim browser ke server, jadi tidak masuk access log, log Cloudflare, atau `Referer` |
| Note locked | Tidak bisa dibagikan |
| Token di DB | Disimpan apa adanya, bukan hash. `content` note juga plaintext di DB yang sama, jadi hash tidak menambah proteksi, dan owner tetap bisa copy ulang link |

## Data

Tabel baru di `cmd/server/schema.sql` (`CREATE TABLE IF NOT EXISTS`, tabel lama tidak diubah):

```sql
CREATE TABLE IF NOT EXISTS note_shares (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,note_id), FOREIGN KEY(user_id,note_id) REFERENCES notes(user_id,id) ON DELETE CASCADE);
```

- `token` dibuat dengan `randomToken()` (32 byte, base64url tanpa padding, 43 karakter).
- `UNIQUE(user_id,note_id)` menjamin satu note satu link, termasuk saat dua request `PUT` datang bersamaan.
- Share state **tidak** masuk model sync note: `push`, `pull`, dan `revision` tidak disentuh.

## Endpoint

Semua response mengikuti helper `jsonOK` / `jsonError` yang ada. Pesan error server memakai
Bahasa Indonesia, sama seperti endpoint lain.

### Owner (`withAuth` + limiter per user)

| Endpoint | Perilaku |
|---|---|
| `GET /api/v1/notes/{id}/share` | `{"shared": false}` atau `{"shared": true, "token": "...", "active": bool}`. `active` = guard akses (lihat bawah) sedang lolos. 404 kalau note tidak ada di server untuk user ini |
| `PUT /api/v1/notes/{id}/share` | Buat link, atau kembalikan link yang sudah ada (idempotent). Body `{"regenerate": true}` mengganti token dan token lama langsung mati. Body boleh kosong. Response `{"token": "..."}`. 404 kalau note tidak ada atau di Trash. 409 `NOTE_LOCKED` kalau note locked |
| `DELETE /api/v1/notes/{id}/share` | Hapus link. Idempotent: tetap `{"ok": true}` kalau link memang tidak ada |

Semua query owner di-scope `user_id` dari session.

### Publik (tanpa session, limiter per IP)

`POST /api/v1/shared/read` dengan body `{"token": "..."}` (batas body 4 KiB).

Response 200: `{"title": "...", "content": "...", "updated_at": <ms>}`.

Header response: `Cache-Control: no-store` dan `X-Robots-Tag: noindex`.

Token dikirim di body, bukan URL atau query. Server tidak boleh mencatat body request ini.

### Guard akses

Satu query menentukan semuanya:

```sql
SELECT n.title, n.content, n.updated_at
FROM note_shares s JOIN notes n ON n.user_id=s.user_id AND n.id=s.note_id
WHERE s.token=? AND n.deleted_at IS NULL AND n.password_hash=''
```

- Link hanya melayani note yang ada, tidak di Trash, dan tidak locked.
- Guard dievaluasi di setiap read, jadi berlaku untuk semua jalur yang mengubah `password_hash`:
  `PUT /notes/{id}/password`, `DELETE /notes/{id}/password`, dan `POST /notes/{id}/password/reset`.
  (`push` tidak bisa mengubah lock; ia selalu mempertahankan `password_hash` yang ada.)
- Query memakai `JOIN` ke `notes`, jadi hasilnya benar walaupun FK `ON DELETE CASCADE` tidak ditegakkan oleh koneksi.
- Link bersifat dormant selama note locked atau di Trash, dan aktif lagi kalau note di-unlock atau di-restore. Ini disengaja.
- Token yang bentuknya tidak valid (bukan 43 karakter base64url) ditolak sebelum menyentuh DB.
- Semua kegagalan token (malformed, tidak dikenal, di-revoke, note di Trash, note locked) dijawab **404 `NOT_FOUND`
  dengan objek `error` identik** (`"link tidak tersedia"`), supaya penyerang tidak bisa membedakan kasusnya.
  Satu-satunya bagian yang berbeda antar response adalah `server_time`, yang memang ditambahkan `jsonError`.
- Body yang tidak bisa didecode (bukan JSON valid, ada field tak dikenal, atau bukan `application/json`) dijawab
  400 `BAD_JSON`. Itu soal format request, bukan soal token.

### Rate limit

Dua limiter baru di `application`, memakai `newLimiter(perMinute, burst)` yang ada:
- `shareLimit` untuk endpoint owner: `newLimiter(30, 30)` per user.
- `shareReadLimit` untuk endpoint publik: `newLimiter(60, 30)` per IP (`clientIP`).

## Halaman share

File baru: `web/dist/share.html`, `share.js`, `share.css`. Ikut ter-embed otomatis lewat `//go:embed dist/*`.

- **Route:** path persis `/s` ditangani eksplisit di `staticFallback`, karena path tanpa ekstensi
  sekarang jatuh ke `index.html`. Response `share.html` memakai `Cache-Control: no-cache`,
  `Referrer-Policy: no-referrer`, dan `X-Robots-Tag: noindex`. HTML juga memuat `<meta name="robots" content="noindex">`.
- **Aset:** `share.js` dan `share.css` dipanggil dengan `?v=N` dan N dinaikkan tiap ada perubahan, sama seperti
  `app.js`. Path berekstensi dilayani dengan `immutable`, jadi tanpa versi, update tidak pernah sampai ke browser.
- **Service worker:** tidak berubah. `sw.js` hanya meng-handle navigasi ke `/` dan `/index.html`, dan hanya
  men-cache path di `ASSET_PATHS`. Halaman share selalu lewat network.
- **CSP:** tidak berubah. Tidak ada inline script, jadi `script-src 'self'` dan `connect-src 'self'` cukup.
- **Alur:** `share.js` membaca `location.hash`. Kalau kosong atau bentuknya tidak valid, langsung tampil state error
  tanpa memanggil API. Kalau valid, `POST /api/v1/shared/read`, lalu render.
- **Render read-only**, aturannya sama dengan overlay editor:
  - inline: `**bold**`, `*italic*`, `_underline_`, `==mark==`, `` `code` ``, `~~strike~~`
  - checklist yang statis (tidak bisa di-toggle). Server menyimpan bentuk kanonik `- [ ] ` / `- [x] ` (lihat
    `canonicalContent` di `app.js`), dan note lama bisa masih berisi 🟡 / ✅, jadi `share.js` menormalkan keduanya
    seperti `normalizeContent` sebelum render
  - baris `![nama](attach:id)` menjadi label nama file
  - semua teks lewat `esc()` lebih dulu; tidak ada HTML dari note yang di-interpret, dan tidak ada auto-link
  - `white-space: pre-wrap` supaya indentasi terjaga
- `formatInline` terduplikasi sekitar 10 baris di `share.js`. Tidak di-extract dari `app.js` karena file itu
  3.200 baris dan boot-nya terikat ke session dan sync.
- **State:** loading, 404 ("This link is unavailable or has been turned off"), 429 (rate limited), dan offline.
  Tema mengikuti `prefers-color-scheme`.
- Judul kosong ditampilkan sebagai "Untitled".

## UI owner (`web/dist/app.js`)

- `icon-btn` Share di header editor, di samping attachments dan lock (`data-act="share"`). Tidak tampil untuk note di Trash.
  String UI memakai Bahasa Inggris, mengikuti commit `6057e69`.
- Klik membuka modal. Isinya tergantung state, yang diambil lewat `GET .../share` saat modal dibuka:
  - belum ada link: button **Create link**
  - ada link: input read-only berisi `${location.origin}/s#${token}`, button **Copy** (toast "Link copied"),
    **Regenerate link** (konfirmasi dulu, karena link lama mati), dan **Turn off link**
  - `active: false` karena note locked: status "Inactive while the note is locked"
  - note locked tanpa link: modal tidak dibuka; toast "Locked notes cannot be shared. Remove the password first."
    (`modal()` tidak mendukung button disabled)
  - offline: modal tidak dibuka; toast perlu koneksi internet
  - note yang belum ada di server disinkronkan dulu lewat `ensureOnServer` (yang juga dipakai fitur lock). Kalau
    gagal: toast "Note not synced yet. Please try again shortly."
- Copy memakai `navigator.clipboard.writeText`. Konfirmasinya inline: label button berubah jadi "Copied" sebentar,
  bukan toast, karena toast tertutup top layer `<dialog>` selama modal terbuka. Kalau clipboard gagal, input dipilih
  supaya bisa di-copy manual.

## Testing

**Go test** di level HTTP mentah, mengikuti pola `cmd/server/main_test.go`:
- create → read lewat token → `title`, `content`, `updated_at` sama dengan note
- `PUT` dua kali tanpa regenerate → token sama; dengan regenerate → token lama 404, token baru 200
- revoke → 404; `DELETE` ulang → tetap `ok`
- Trash → 404, restore → 200
- note locked (`PUT .../password`): `PUT .../share` 409, dan link yang sudah ada menjadi 404; unlock
  (`DELETE .../password`) → 200 lagi
- `push` pada note yang sudah locked tidak membuka guard: read tetap 404 setelah `push` mengubah title/content
- isolasi: user B tidak bisa `GET`/`PUT`/`DELETE` share note milik user A (404 / tidak berefek); token A tidak
  membuka note lain
- token malformed, tidak dikenal, di-revoke, Trash, dan locked menghasilkan **status dan objek `error` identik**
  (selain `server_time`)
- header `Cache-Control: no-store` dan `X-Robots-Tag: noindex` ada di response publik
- rate limit publik mengembalikan 429 dengan `Retry-After`
- `GET /s` menyajikan `share.html` (bukan `index.html`) dengan header yang benar

**Probe tiap guard** (matikan, pastikan test relevan GAGAL, kembalikan): `n.deleted_at IS NULL`,
`n.password_hash=''`, scoping `user_id` di endpoint owner, cek bentuk token, cek lock saat `PUT`, dan limiter.

**E2E Playwright** (`web/e2e/`), konteks browser baru tanpa cookie:
- buka `/s#<token>` → note tampil, tidak ada layar login
- title dan content berisi `<img src=x onerror=...>` dan `<script>` → tampil sebagai teks, tidak tereksekusi
- tidak ada satu pun request yang URL-nya memuat token (membuktikan klaim fragment)
- token dimatikan → halaman menampilkan state "unavailable"

**Selesai berarti:** `go build ./...`, `go vet ./...`, `go test ./...`, `node --check web/dist/share.js`,
`node --check web/dist/app.js`, dan e2e, semuanya bersih tanpa warning. Plus satu run nyata di server
`AUTH_MODE=dev`: buat link dari UI, buka di jendela tanpa session, lalu matikan link.

## Docs

- `README.md`: fitur, tabel endpoint, dan struktur project.
- `PRD-notepad-pwa.md` baris 71 masih mencatat "shared note" sebagai non-goal; diperbarui supaya mencerminkan
  share link read-only.
