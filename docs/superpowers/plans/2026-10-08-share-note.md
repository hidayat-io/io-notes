# Share Note via Inline Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner bisa membagikan satu note lewat link read-only (`/s#<token>`) yang bisa dibuka siapa pun tanpa login.

**Architecture:** Tabel `note_shares` baru (satu link per note, token disimpan apa adanya). Tiga endpoint owner (`GET/PUT/DELETE /api/v1/notes/{id}/share`) dan satu endpoint publik (`POST /api/v1/shared/read`, token di body) yang membaca note lewat satu query guard. Halaman standalone `share.html` + `share.js` membaca token dari URL fragment, jadi token tidak pernah masuk URL request. UI owner memakai `modal()` yang sudah ada di `app.js`.

**Tech Stack:** Go `net/http` + SQLite/libSQL (`cmd/server`), vanilla JS classic script (`web/dist`), Playwright untuk e2e (`web/e2e`).

## Global Constraints

Dikutip dari spec `docs/superpowers/specs/2026-10-08-share-note-design.md` dan aturan project:

- **JANGAN `git add` / `git commit` / `git push`.** Owner yang menentukan kapan commit. Plan ini tidak punya step commit; tiap task ditutup dengan checkpoint `git status`.
- Read-only, live (bukan snapshot), tanpa expiry, satu note satu link. Attachment tidak ikut: baris `![nama](attach:id)` tampil sebagai label nama file.
- Token = `randomToken()` (32 byte, base64url tanpa padding, **43 karakter**), disimpan apa adanya di `note_shares.token`.
- Endpoint publik: `POST /api/v1/shared/read`, body `{"token": "..."}` (batas 4 KiB). Token tidak boleh ada di URL atau query.
- Guard akses = satu query: note ada, `deleted_at IS NULL`, `password_hash=''`. Semua kegagalan token dijawab 404 `NOT_FOUND` dengan objek `error` identik (`"link tidak tersedia"`). Body yang tidak bisa didecode dijawab 400 `BAD_JSON`.
- Create link untuk note locked ditolak 409 `NOTE_LOCKED`; untuk note Trash atau yang tidak ada di server ditolak 404 `NOT_FOUND`.
- Limiter baru: `shareLimit = newLimiter(30, 30)` per user, `shareReadLimit = newLimiter(60, 30)` per IP.
- Response publik: `Cache-Control: no-store` dan `X-Robots-Tag: noindex`. Response `/s`: `Cache-Control: no-cache`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
- CSP dan `sw.js` untuk halaman share **tidak berubah** (tanpa inline script; share asset tidak masuk `ASSET_PATHS`).
- Pesan error server dalam Bahasa Indonesia; string UI dalam Bahasa Inggris (commit `6057e69`).
- `build`, `vet`, `test` bersih tanpa warning. Setiap guard di-probe: matikan, test relevan harus GAGAL, lalu kembalikan.
- Baseline sebelum mulai (sudah diverifikasi 2026-10-08): `go build`, `go vet`, `go test ./...` hijau; `node --check` OK; e2e 25 pass, 0 fail (~73 detik).

---

## File Structure

| File | Aksi | Tanggung jawab |
|---|---|---|
| `cmd/server/schema.sql` | Modify | Tabel `note_shares` |
| `cmd/server/share.go` | Create | `isShareToken`, handler owner (`getShare`, `putShare`, `deleteShare`), handler publik (`sharedRead`) |
| `cmd/server/main.go` | Modify | Field limiter di `application`, inisialisasi di `newApplication`, 4 route, cabang `/s` di `staticFallback` |
| `cmd/server/share_test.go` | Create | Semua test Go untuk fitur share |
| `web/dist/share.html` | Create | Shell halaman share (tanpa inline script) |
| `web/dist/share.js` | Create | Baca fragment, `POST` read, render read-only |
| `web/dist/share.css` | Create | Style halaman share (light/dark lewat `prefers-color-scheme`) |
| `web/dist/app.js` | Modify | Icon `link`/`copy`, button Share di header editor, `shareMenu()` |
| `web/dist/app.css` | Modify | Style `.share-row` di modal |
| `web/dist/index.html`, `web/dist/sw.js` | Modify | Naikkan versi aset `69` → `70` |
| `web/e2e/harness.mjs` | Modify | Catat request yang sampai ke server (`app.seen`) |
| `web/e2e/share.test.mjs` | Create | E2E: halaman share dan alur UI owner |
| `README.md`, `PRD-notepad-pwa.md` | Modify | Dokumentasi |

---

### Task 1: Schema + endpoint owner (`GET/PUT/DELETE /api/v1/notes/{id}/share`)

**Files:**
- Modify: `cmd/server/schema.sql` (append satu statement)
- Create: `cmd/server/share.go`
- Modify: `cmd/server/main.go` (struct `application`, `newApplication`, `routes`)
- Test: `cmd/server/share_test.go`

**Interfaces:**
- Consumes: `newTestApp`, `(*application).mustUser`, `(*application).do`, `pushOne`, `testUUID` (semua di `main_test.go`); `getNote`, `decodeJSON`, `jsonOK`, `jsonError`, `randomToken`, `userKey`, `withAuth`, `byUser` (di `main.go` / `middleware.go`).
- Produces (dipakai Task 2): `isShareToken(string) bool`; `application.shareLimit`, `application.shareReadLimit` (`*limiter`); helper test `shareToken(t, a, u, noteID, body) string`, `decodeBody(t, w) map[string]any`, `lockForTest(t, a, u, id)`, `unlockForTest(t, a, u, id)`.

- [ ] **Step 1: Tulis test yang gagal**

Buat `cmd/server/share_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

/* --------------------------------------------------------- test helpers */

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("response is not JSON: %q (%v)", w.Body.String(), err)
	}
	return m
}

// shareToken creates (or fetches) the share link of a note as its owner.
func shareToken(t *testing.T, a *application, u user, noteID string, body map[string]any) string {
	t.Helper()
	w := a.do(t, u, "PUT", "/api/v1/notes/"+noteID+"/share", body)
	if w.Code != 200 {
		t.Fatalf("PUT share: status %d body %s", w.Code, w.Body.String())
	}
	token, _ := decodeBody(t, w)["token"].(string)
	if token == "" {
		t.Fatalf("PUT share: no token in %s", w.Body.String())
	}
	return token
}

func lockForTest(t *testing.T, a *application, u user, id string) {
	t.Helper()
	if w := a.do(t, u, "PUT", "/api/v1/notes/"+id+"/password", map[string]any{"password": "password123"}); w.Code != 200 {
		t.Fatalf("lock: status %d body %s", w.Code, w.Body.String())
	}
}

func unlockForTest(t *testing.T, a *application, u user, id string) {
	t.Helper()
	if w := a.do(t, u, "DELETE", "/api/v1/notes/"+id+"/password", nil); w.Code != 200 {
		t.Fatalf("unlock: status %d body %s", w.Code, w.Body.String())
	}
}

func shareRows(t *testing.T, a *application, userID, noteID string) int {
	t.Helper()
	var n int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM note_shares WHERE user_id=? AND note_id=?", userID, noteID).Scan(&n); err != nil {
		t.Fatalf("count note_shares: %v", err)
	}
	return n
}

/* ------------------------------------------------------- owner endpoints */

func TestIsShareToken(t *testing.T) {
	good := randomToken()
	cases := []struct {
		name  string
		token string
		want  bool
	}{
		{"issued token", good, true},
		{"empty", "", false},
		{"one char short", good[:42], false},
		{"one char long", good + "A", false},
		{"plus is not base64url", strings.Repeat("A", 42) + "+", false},
		{"slash is not base64url", strings.Repeat("A", 42) + "/", false},
		{"padding is not allowed", strings.Repeat("A", 42) + "=", false},
		{"space", strings.Repeat("A", 42) + " ", false},
		{"dash and underscore are allowed", strings.Repeat("-", 21) + strings.Repeat("_", 22), true},
	}
	for _, tc := range cases {
		if got := isShareToken(tc.token); got != tc.want {
			t.Errorf("%s: isShareToken(%q) = %v, want %v", tc.name, tc.token, got, tc.want)
		}
	}
	if len(good) != 43 {
		t.Fatalf("randomToken is %d chars; share.js and isShareToken both assume 43", len(good))
	}
}

func TestShareCreateIsIdempotentAndRegenerateReplacesToken(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-share-1", "share1@example.com")
	id := testUUID(301)
	pushOne(t, a, u, id, 2000, "shared note", nil)

	first := shareToken(t, a, u, id, map[string]any{})
	if !isShareToken(first) {
		t.Fatalf("token %q does not look like a share token", first)
	}
	if again := shareToken(t, a, u, id, map[string]any{}); again != first {
		t.Fatalf("second PUT changed the token: %q -> %q", first, again)
	}
	// An empty body means the same as {}.
	w := a.do(t, u, "PUT", "/api/v1/notes/"+id+"/share", nil)
	if w.Code != 200 || decodeBody(t, w)["token"] != first {
		t.Fatalf("PUT with empty body: status %d body %s, want token %q", w.Code, w.Body.String(), first)
	}
	regenerated := shareToken(t, a, u, id, map[string]any{"regenerate": true})
	if regenerated == first {
		t.Fatal("regenerate returned the old token")
	}
	if n := shareRows(t, a, u.ID, id); n != 1 {
		t.Fatalf("note_shares rows = %d, want exactly 1 per note", n)
	}
}

func TestShareRejectsMalformedBody(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-share-2", "share2@example.com")
	id := testUUID(302)
	pushOne(t, a, u, id, 2000, "n", nil)
	w := a.do(t, u, "PUT", "/api/v1/notes/"+id+"/share", map[string]any{"regenerate": true, "surprise": 1})
	if w.Code != 400 {
		t.Fatalf("unknown field: status %d, want 400", w.Code)
	}
	if n := shareRows(t, a, u.ID, id); n != 0 {
		t.Fatalf("a rejected request created %d rows", n)
	}
}

func TestShareStatusAndRevoke(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-share-3", "share3@example.com")
	id := testUUID(303)
	pushOne(t, a, u, id, 2000, "n", nil)
	path := "/api/v1/notes/" + id + "/share"

	w := a.do(t, u, "GET", path, nil)
	if w.Code != 200 || decodeBody(t, w)["shared"] != false {
		t.Fatalf("before sharing: status %d body %s", w.Code, w.Body.String())
	}

	token := shareToken(t, a, u, id, map[string]any{})
	got := decodeBody(t, a.do(t, u, "GET", path, nil))
	if got["shared"] != true || got["token"] != token || got["active"] != true {
		t.Fatalf("after sharing: %v, want shared=true token=%s active=true", got, token)
	}

	if w := a.do(t, u, "DELETE", path, nil); w.Code != 200 {
		t.Fatalf("revoke: status %d", w.Code)
	}
	if got := decodeBody(t, a.do(t, u, "GET", path, nil)); got["shared"] != false {
		t.Fatalf("after revoke: %v", got)
	}
	if w := a.do(t, u, "DELETE", path, nil); w.Code != 200 {
		t.Fatalf("second revoke must stay ok, got %d", w.Code)
	}
}

func TestShareStatusReportsWhetherTheLinkWorks(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-share-4", "share4@example.com")
	id := testUUID(304)
	pushOne(t, a, u, id, 2000, "n", nil)
	path := "/api/v1/notes/" + id + "/share"
	shareToken(t, a, u, id, map[string]any{})

	lockForTest(t, a, u, id)
	if got := decodeBody(t, a.do(t, u, "GET", path, nil)); got["shared"] != true || got["active"] != false {
		t.Fatalf("locked note: %v, want shared=true active=false", got)
	}
	unlockForTest(t, a, u, id)

	del := int64(3000)
	pushOne(t, a, u, id, 3000, "n", &del)
	if got := decodeBody(t, a.do(t, u, "GET", path, nil)); got["shared"] != true || got["active"] != false {
		t.Fatalf("trashed note: %v, want shared=true active=false", got)
	}
	pushOne(t, a, u, id, 4000, "n", nil)
	if got := decodeBody(t, a.do(t, u, "GET", path, nil)); got["active"] != true {
		t.Fatalf("restored note: %v, want active=true", got)
	}
}

func TestShareCreateRefusesLockedTrashedAndMissingNotes(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-share-5", "share5@example.com")
	locked, trashed, missing := testUUID(311), testUUID(312), testUUID(313)
	pushOne(t, a, u, locked, 2000, "locked", nil)
	pushOne(t, a, u, trashed, 2000, "trashed", nil)
	lockForTest(t, a, u, locked)
	del := int64(3000)
	pushOne(t, a, u, trashed, 3000, "trashed", &del)

	cases := []struct {
		name, id, wantCode string
		wantStatus         int
	}{
		{"locked note", locked, "NOTE_LOCKED", 409},
		{"note in Trash", trashed, "NOT_FOUND", 404},
		{"note the server never saw", missing, "NOT_FOUND", 404},
	}
	for _, tc := range cases {
		w := a.do(t, u, "PUT", "/api/v1/notes/"+tc.id+"/share", map[string]any{})
		if w.Code != tc.wantStatus {
			t.Errorf("%s: status %d, want %d (body %s)", tc.name, w.Code, tc.wantStatus, w.Body.String())
			continue
		}
		errObj, _ := decodeBody(t, w)["error"].(map[string]any)
		if errObj["code"] != tc.wantCode {
			t.Errorf("%s: code %v, want %s", tc.name, errObj["code"], tc.wantCode)
		}
		if n := shareRows(t, a, u.ID, tc.id); n != 0 {
			t.Errorf("%s: a refused request left %d rows", tc.name, n)
		}
	}
}

func TestShareEndpointsAreScopedToTheOwner(t *testing.T) {
	a := newTestApp(t)
	alice := a.mustUser(t, "sub-alice-share", "alice-share@example.com")
	bob := a.mustUser(t, "sub-bob-share", "bob-share@example.com")
	id := testUUID(321)
	pushOne(t, a, alice, id, 2000, "alice note", nil)
	token := shareToken(t, a, alice, id, map[string]any{})
	path := "/api/v1/notes/" + id + "/share"

	// Bob has no note with this id: nothing to read or create.
	if w := a.do(t, bob, "GET", path, nil); w.Code != 404 {
		t.Errorf("bob GET: status %d, want 404", w.Code)
	}
	if w := a.do(t, bob, "PUT", path, map[string]any{}); w.Code != 404 {
		t.Errorf("bob PUT: status %d, want 404", w.Code)
	}
	// Bob's DELETE must never remove Alice's link.
	if w := a.do(t, bob, "DELETE", path, nil); w.Code != 200 {
		t.Errorf("bob DELETE: status %d, want 200 (idempotent, no effect)", w.Code)
	}
	var stored string
	if err := a.db.QueryRow("SELECT token FROM note_shares WHERE user_id=? AND note_id=?", alice.ID, id).Scan(&stored); err != nil || stored != token {
		t.Fatalf("alice's link was touched by bob: token=%q err=%v, want %q", stored, err, token)
	}

	// Same note id under Bob's account is a different note with a different link.
	pushOne(t, a, bob, id, 2000, "bob note", nil)
	bobToken := shareToken(t, a, bob, id, map[string]any{})
	if bobToken == token {
		t.Fatal("bob and alice share a token")
	}
	if err := a.db.QueryRow("SELECT token FROM note_shares WHERE user_id=? AND note_id=?", alice.ID, id).Scan(&stored); err != nil || stored != token {
		t.Fatalf("alice's link changed after bob shared his note: %q (%v)", stored, err)
	}
}

func TestShareOwnerEndpointsRequireASession(t *testing.T) {
	a := newTestApp(t)
	path := "/api/v1/notes/" + testUUID(331) + "/share"
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if w := a.do(t, user{}, method, path, nil); w.Code != 401 {
			t.Errorf("%s without a session: status %d, want 401", method, w.Code)
		}
	}
}
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `cd /Users/mthidayat/Dev-Labs/litenotes && go test ./cmd/server -run 'TestIsShareToken|TestShare' 2>&1 | head -20`
Expected: build error `undefined: isShareToken` (belum ada `share.go`).

- [ ] **Step 3: Tambah tabel di `schema.sql`**

Append satu baris di akhir `cmd/server/schema.sql` (setelah `idx_attachments_status_created`), format satu-statement-per-baris seperti yang lain:

```sql
CREATE TABLE IF NOT EXISTS note_shares (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,note_id), FOREIGN KEY(user_id,note_id) REFERENCES notes(user_id,id) ON DELETE CASCADE);
```

- [ ] **Step 4: Buat `cmd/server/share.go`**

```go
package main

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"time"
)

// A share token is randomToken(): 32 random bytes as unpadded base64url, which is
// always 43 characters. Anything else cannot be a token this server issued, so it
// is refused before it reaches the database.
const shareTokenLen = 43

func isShareToken(s string) bool {
	if len(s) != shareTokenLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// getShare tells the owner whether the note has a link and whether it currently
// works (the same guard sharedRead applies: not in Trash, not locked).
func (a *application) getShare(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	n, found, err := getNote(r.Context(), a.db, u.ID, r.PathValue("id"))
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	if !found {
		jsonError(w, 404, "NOT_FOUND", "note tidak ditemukan")
		return
	}
	var token string
	err = a.db.QueryRowContext(r.Context(), "SELECT token FROM note_shares WHERE user_id=? AND note_id=?", u.ID, n.ID).Scan(&token)
	if errors.Is(err, sql.ErrNoRows) {
		jsonOK(w, map[string]any{"shared": false})
		return
	}
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca link share")
		return
	}
	jsonOK(w, map[string]any{"shared": true, "token": token, "active": n.DeletedAt == nil && !n.IsLocked})
}

// putShare creates the note's link, or returns the existing one. With
// {"regenerate": true} the old token is dropped and a new one issued.
func (a *application) putShare(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	var in struct {
		Regenerate bool `json:"regenerate"`
	}
	// An empty body is a plain "create or fetch"; anything else must be well-formed.
	if err := decodeJSON(r, &in, 256); err != nil && !errors.Is(err, io.EOF) {
		jsonError(w, 400, "BAD_JSON", "request share tidak valid")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer tx.Rollback()
	n, found, err := getNote(r.Context(), tx, u.ID, r.PathValue("id"))
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	if !found || n.DeletedAt != nil {
		jsonError(w, 404, "NOT_FOUND", "note tidak ditemukan")
		return
	}
	if n.IsLocked {
		jsonError(w, 409, "NOTE_LOCKED", "note yang dikunci tidak bisa dibagikan")
		return
	}
	if in.Regenerate {
		if _, err = tx.ExecContext(r.Context(), "DELETE FROM note_shares WHERE user_id=? AND note_id=?", u.ID, n.ID); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal mengganti link share")
			return
		}
	}
	// DO NOTHING keeps two simultaneous first-time requests down to one row; both
	// then read back the token that actually won.
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO note_shares(token,user_id,note_id,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,note_id) DO NOTHING", randomToken(), u.ID, n.ID, time.Now().UnixMilli()); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat link share")
		return
	}
	var token string
	if err = tx.QueryRowContext(r.Context(), "SELECT token FROM note_shares WHERE user_id=? AND note_id=?", u.ID, n.ID).Scan(&token); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca link share")
		return
	}
	if err = tx.Commit(); err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	jsonOK(w, map[string]any{"token": token})
}

// deleteShare is idempotent: turning off a link that does not exist is still ok.
func (a *application) deleteShare(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	if _, err := a.db.ExecContext(r.Context(), "DELETE FROM note_shares WHERE user_id=? AND note_id=?", u.ID, r.PathValue("id")); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal mematikan link share")
		return
	}
	jsonOK(w, map[string]any{"ok": true})
}
```

- [ ] **Step 5: Hubungkan limiter dan route di `main.go`**

Di struct `application` (setelah `downloadLimit *limiter`), tambah:

```go
	shareLimit     *limiter
	shareReadLimit *limiter
```

Di `newApplication`, setelah baris `downloadLimit: newLimiter(60, 90),`, tambah:

```go
		shareLimit:     newLimiter(30, 30), // owner endpoints; opening the share dialog is a single GET
		shareReadLimit: newLimiter(60, 30), // public reads, per IP
```

Di `routes()`, setelah baris `mux.HandleFunc("POST /api/v1/notes/{id}/password/reset", a.byIP(a.resetNotePassword))`, tambah:

```go
	mux.HandleFunc("GET /api/v1/notes/{id}/share", a.withAuth(a.byUser(a.shareLimit, a.getShare)))
	mux.HandleFunc("PUT /api/v1/notes/{id}/share", a.withAuth(a.byUser(a.shareLimit, a.putShare)))
	mux.HandleFunc("DELETE /api/v1/notes/{id}/share", a.withAuth(a.byUser(a.shareLimit, a.deleteShare)))
```

Lalu rapikan alignment: `gofmt -w cmd/server/main.go cmd/server/share.go cmd/server/share_test.go`. Perubahan di `main.go` harus hanya baris yang kamu tambah plus alignment blok limiter.

- [ ] **Step 6: Jalankan test, pastikan lulus**

Run: `go test ./cmd/server -run 'TestIsShareToken|TestShare' -v 2>&1 | tail -30`
Expected: semua `PASS`, tidak ada `FAIL`.

- [ ] **Step 7: Probe guard (matikan, test harus GAGAL, kembalikan)**

Lakukan satu per satu, jalankan `go test ./cmd/server -run 'TestShare' 2>&1 | tail -15` tiap kali, lalu kembalikan:

1. Di `putShare`, hapus blok `if n.IsLocked { ... }` → `TestShareCreateRefusesLockedTrashedAndMissingNotes` harus gagal pada "locked note".
2. Di `putShare`, ubah `if !found || n.DeletedAt != nil` jadi `if !found` → test yang sama harus gagal pada "note in Trash".
3. Di `deleteShare`, hapus `user_id=? AND ` dan argumen `u.ID` → `TestShareEndpointsAreScopedToTheOwner` harus gagal ("alice's link was touched by bob").
4. Di `putShare`, hapus blok `if in.Regenerate { ... }` → `TestShareCreateIsIdempotentAndRegenerateReplacesToken` harus gagal ("regenerate returned the old token").
5. Di `isShareToken`, ubah `shareTokenLen = 43` jadi `42` → `TestIsShareToken` harus gagal.

Setelah kelimanya, `git diff cmd/server/share.go` tidak boleh menyisakan perubahan probe; jalankan ulang Step 6 dan harus PASS.

- [ ] **Step 8: Checkpoint (TANPA commit)**

Run: `gofmt -l cmd/ ; go vet ./... && git status --short`
Expected: `gofmt -l` tidak mencetak apa pun; `go vet` bersih; `git status` menampilkan `M cmd/server/main.go`, `M cmd/server/schema.sql`, `?? cmd/server/share.go`, `?? cmd/server/share_test.go` (plus `docs/` dan `.commandcode/` yang sudah ada sebelumnya).

---

### Task 2: Endpoint publik `POST /api/v1/shared/read` + guard + rate limit

**Files:**
- Modify: `cmd/server/share.go` (tambah `sharedRead`, `shareUnavailable`)
- Modify: `cmd/server/main.go` (satu route)
- Test: `cmd/server/share_test.go` (tambah test; tambah import `bytes`, `log/slog`)

**Interfaces:**
- Consumes (dari Task 1): `isShareToken`, `shareToken`, `decodeBody`, `lockForTest`, `unlockForTest`, `application.shareReadLimit`.
- Produces: `POST /api/v1/shared/read` → 200 `{"title","content","updated_at"}`; semua kegagalan token → 404 `{"error":{"code":"NOT_FOUND","message":"link tidak tersedia"}}`. Dipakai `share.js` (Task 3).

- [ ] **Step 1: Tulis test yang gagal**

Ubah import di `share_test.go` menjadi:

```go
import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)
```

Tambahkan di akhir file:

```go
/* ------------------------------------------------------- public endpoint */

func readShared(t *testing.T, a *application, token string) *httptest.ResponseRecorder {
	t.Helper()
	// No user, so no session cookie: this is what a recipient without an account sends.
	return a.do(t, user{}, "POST", "/api/v1/shared/read", map[string]any{"token": token})
}

func TestSharedReadReturnsTheLiveNoteWithoutASession(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-read-1", "read1@example.com")
	id := testUUID(401)
	pushOne(t, a, u, id, 2000, "first title", nil)
	token := shareToken(t, a, u, id, map[string]any{})

	w := readShared(t, a, token)
	if w.Code != 200 {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	got := decodeBody(t, w)
	if got["title"] != "first title" || got["content"] != "body" || got["updated_at"] != float64(2000) {
		t.Fatalf("payload = %v", got)
	}
	if len(got) != 3 {
		t.Fatalf("payload has extra keys (must be exactly title, content, updated_at): %v", got)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if tag := w.Header().Get("X-Robots-Tag"); tag != "noindex" {
		t.Errorf("X-Robots-Tag = %q, want noindex", tag)
	}

	// Live: an edit after sharing is what the next read returns.
	pushOne(t, a, u, id, 3000, "second title", nil)
	got = decodeBody(t, readShared(t, a, token))
	if got["title"] != "second title" || got["updated_at"] != float64(3000) {
		t.Fatalf("after edit payload = %v, want the new title", got)
	}
}

func TestSharedReadGuard(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-read-2", "read2@example.com")
	id := testUUID(402)
	pushOne(t, a, u, id, 2000, "guarded", nil)
	token := shareToken(t, a, u, id, map[string]any{})

	expect := func(want int, step string) {
		t.Helper()
		if w := readShared(t, a, token); w.Code != want {
			t.Fatalf("%s: status %d, want %d (body %s)", step, w.Code, want, w.Body.String())
		}
	}
	expect(200, "fresh link")

	del := int64(3000)
	pushOne(t, a, u, id, 3000, "guarded", &del)
	expect(404, "note in Trash")
	pushOne(t, a, u, id, 4000, "guarded", nil)
	expect(200, "note restored")

	lockForTest(t, a, u, id)
	expect(404, "note locked")
	// push keeps password_hash, so editing a locked note must not reopen the link.
	pushOne(t, a, u, id, 5000, "edited while locked", nil)
	expect(404, "push on a locked note")
	unlockForTest(t, a, u, id)
	expect(200, "note unlocked")

	// Turning the link off, and replacing it, both close the old token for good.
	newToken := shareToken(t, a, u, id, map[string]any{"regenerate": true})
	expect(404, "old token after regenerate")
	if w := readShared(t, a, newToken); w.Code != 200 {
		t.Fatalf("new token after regenerate: status %d", w.Code)
	}
	if w := a.do(t, u, "DELETE", "/api/v1/notes/"+id+"/share", nil); w.Code != 200 {
		t.Fatalf("revoke: %d", w.Code)
	}
	if w := readShared(t, a, newToken); w.Code != 404 {
		t.Fatalf("token after revoke: status %d, want 404", w.Code)
	}
}

func TestSharedReadFailuresAreIndistinguishable(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-read-3", "read3@example.com")

	revoked, trashed, locked := testUUID(411), testUUID(412), testUUID(413)
	for _, id := range []string{revoked, trashed, locked} {
		pushOne(t, a, u, id, 2000, "n", nil)
	}
	tokens := map[string]string{
		"revoked":   shareToken(t, a, u, revoked, map[string]any{}),
		"trashed":   shareToken(t, a, u, trashed, map[string]any{}),
		"locked":    shareToken(t, a, u, locked, map[string]any{}),
		"malformed": "not-a-token",
		"empty":     "",
		"unknown":   randomToken(),
	}
	a.do(t, u, "DELETE", "/api/v1/notes/"+revoked+"/share", nil)
	del := int64(3000)
	pushOne(t, a, u, trashed, 3000, "n", &del)
	lockForTest(t, a, u, locked)

	var reference string
	for name, token := range tokens {
		w := readShared(t, a, token)
		if w.Code != 404 {
			t.Errorf("%s: status %d, want 404", name, w.Code)
			continue
		}
		body := decodeBody(t, w)
		delete(body, "server_time") // jsonError stamps every response; that is the only difference allowed
		raw, _ := json.Marshal(body)
		if reference == "" {
			reference = string(raw)
		}
		if string(raw) != reference {
			t.Errorf("%s: body %s differs from %s, so a caller can tell the cases apart", name, raw, reference)
		}
	}
	if !strings.Contains(reference, `"NOT_FOUND"`) || !strings.Contains(reference, "link tidak tersedia") {
		t.Fatalf("unexpected 404 body: %s", reference)
	}
}

func TestSharedReadRejectsUndecodableRequests(t *testing.T) {
	a := newTestApp(t)
	cases := []struct {
		name, contentType, body string
	}{
		{"not json", "application/json", "not json"},
		{"unknown field", "application/json", `{"token":"x","extra":1}`},
		{"wrong content type", "text/plain", `{"token":"x"}`},
		{"empty body", "application/json", ""},
	}
	for _, tc := range cases {
		r := httptest.NewRequest("POST", "/api/v1/shared/read", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.contentType)
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Errorf("%s: status %d, want 400", tc.name, w.Code)
		}
	}
}

func TestSharedReadIsRateLimitedPerIP(t *testing.T) {
	a := newTestApp(t)
	for i := 0; i < 200; i++ {
		w := readShared(t, a, "not-a-token")
		if w.Code == 429 {
			if w.Header().Get("Retry-After") == "" {
				t.Fatal("429 without Retry-After")
			}
			return
		}
	}
	t.Fatal("public read was never rate limited")
}

// The token travels in the request body only. The access log must carry neither it
// nor anything that could be turned back into it.
func TestSharedReadNeverLogsTheToken(t *testing.T) {
	var logs bytes.Buffer
	a := newTestApp(t)
	a.logger = slog.New(slog.NewTextHandler(&logs, nil))
	u := a.mustUser(t, "sub-read-4", "read4@example.com")
	id := testUUID(421)
	pushOne(t, a, u, id, 2000, "n", nil)
	token := shareToken(t, a, u, id, map[string]any{})

	logs.Reset()
	if w := readShared(t, a, token); w.Code != 200 {
		t.Fatalf("read: %d", w.Code)
	}
	if !strings.Contains(logs.String(), "route=/api/v1/shared/read") {
		t.Fatalf("expected an access log line for the read, got %q", logs.String())
	}
	if strings.Contains(logs.String(), token) {
		t.Fatalf("access log contains the share token: %s", logs.String())
	}
}
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `go test ./cmd/server -run 'TestSharedRead' 2>&1 | head -30`
Expected: FAIL. `readShared` mendapat 404 dari mux (route belum ada), jadi test status 200 gagal, dan test 400/429 gagal juga.

- [ ] **Step 3: Tambah `sharedRead` di `share.go`**

Append di akhir `cmd/server/share.go`:

```go
func shareUnavailable(w http.ResponseWriter) {
	jsonError(w, 404, "NOT_FOUND", "link tidak tersedia")
}

// sharedRead is the only endpoint a recipient without an account can reach. One
// query is the whole access rule: the link must point at a note that exists, is
// not in Trash and is not locked. Every way of failing it answers the same 404, so
// the response never says which of those it was. The JOIN keeps the answer right
// even if a foreign key cascade did not run.
func (a *application) sharedRead(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Robots-Tag", "noindex")
	var in struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(r, &in, 4096); err != nil {
		jsonError(w, 400, "BAD_JSON", "request tidak valid")
		return
	}
	if !isShareToken(in.Token) {
		shareUnavailable(w)
		return
	}
	var title, content string
	var updatedAt int64
	err := a.db.QueryRowContext(r.Context(),
		`SELECT n.title, n.content, n.updated_at
		 FROM note_shares s JOIN notes n ON n.user_id=s.user_id AND n.id=s.note_id
		 WHERE s.token=? AND n.deleted_at IS NULL AND n.password_hash=''`, in.Token).Scan(&title, &content, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		shareUnavailable(w)
		return
	}
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	jsonOK(w, map[string]any{"title": title, "content": content, "updated_at": updatedAt})
}
```

- [ ] **Step 4: Tambah route di `main.go`**

Setelah tiga route share owner di `routes()`, tambah:

```go
	mux.HandleFunc("POST /api/v1/shared/read", a.limitBy(a.shareReadLimit, a.clientIP, a.sharedRead))
```

- [ ] **Step 5: Jalankan test, pastikan lulus**

Run: `gofmt -l cmd/ ; go test ./cmd/server -run 'TestShare|TestSharedRead|TestIsShareToken' -v 2>&1 | grep -E '^(=== RUN|--- (PASS|FAIL)|FAIL|ok|PASS)' | grep -v '=== RUN'`
Expected: semua `--- PASS`; `gofmt -l` kosong.

- [ ] **Step 6: Probe guard (matikan, test harus GAGAL, kembalikan)**

Jalankan `go test ./cmd/server -run 'TestSharedRead' 2>&1 | tail -15` setelah tiap perubahan, lalu kembalikan:

1. Hapus ` AND n.deleted_at IS NULL` dari query → `TestSharedReadGuard` gagal di "note in Trash".
2. Hapus ` AND n.password_hash=''` dari query → `TestSharedReadGuard` gagal di "note locked".
3. Ganti `jsonError(w, 404, "NOT_FOUND", "link tidak tersedia")` di `shareUnavailable` jadi pesan berbeda hanya untuk token tak dikenal (mis. di cabang `sql.ErrNoRows` pakai `jsonError(w, 404, "NOT_FOUND", "tidak ada")`) → `TestSharedReadFailuresAreIndistinguishable` gagal.
4. Ubah `newLimiter(60, 30)` di `newApplication` jadi `newLimiter(600000, 600000)` → `TestSharedReadIsRateLimitedPerIP` gagal.
5. Di `sharedRead`, tambahkan `a.logger.Info("share_read", "token", in.Token)` → `TestSharedReadNeverLogsTheToken` gagal.
6. Hapus `w.Header().Set("X-Robots-Tag", "noindex")` → `TestSharedReadReturnsTheLiveNoteWithoutASession` gagal.

Kembalikan semuanya, jalankan ulang Step 5, harus PASS.

- [ ] **Step 7: Checkpoint (TANPA commit)**

Run: `gofmt -l cmd/ ; go build ./... && go vet ./... && go test ./... 2>&1 | tail -5 && git status --short`
Expected: semua bersih, `ok  litenotes/cmd/server`; `git status` menambah perubahan di `share.go`, `share_test.go`, `main.go`.

---

### Task 3: Halaman share (`/s`) + e2e halaman

**Files:**
- Create: `web/dist/share.html`, `web/dist/share.js`, `web/dist/share.css`
- Modify: `cmd/server/main.go` (cabang `/s` di `staticFallback`)
- Modify: `web/e2e/harness.mjs` (catat request ke server)
- Test: `cmd/server/share_test.go` (route), `web/e2e/share.test.mjs` (halaman)

**Interfaces:**
- Consumes: `POST /api/v1/shared/read` (Task 2); `inlineScript` regexp (di `middleware.go`).
- Produces: `GET /s` menyajikan `share.html`; `share.js` merender ke `<main id="share">` dengan kelas `.share-title`, `.share-content`, `.content-line`, `.checklist-line`, `.check` / `.check.done`, `.attach-label` / `.attach-name`, `.share-state` (state error), `.share-status` (loading). Harness: `app.seen` (array string `"METHOD /path?query"` untuk setiap request yang sampai ke server).

- [ ] **Step 1: Tulis test Go yang gagal untuk route `/s`**

Tambahkan di akhir `cmd/server/share_test.go`:

```go
/* ----------------------------------------------------------- share page */

func TestSharePageIsServedAtS(t *testing.T) {
	a := newTestApp(t)
	for _, accept := range []string{"text/html,application/xhtml+xml", ""} {
		r := httptest.NewRequest("GET", "/s", nil)
		if accept != "" {
			r.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		body := w.Body.String()
		if !strings.Contains(body, `id="share"`) || strings.Contains(body, `id="app"`) {
			t.Fatalf("Accept %q: /s did not serve share.html (got the SPA shell or something else)", accept)
		}
		want := map[string]string{
			"Content-Type":    "text/html; charset=utf-8",
			"Cache-Control":   "no-cache",
			"Referrer-Policy": "no-referrer",
			"X-Robots-Tag":    "noindex",
		}
		for k, v := range want {
			if got := w.Header().Get(k); got != v {
				t.Errorf("Accept %q: %s = %q, want %q", accept, k, got, v)
			}
		}
		if w.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("Accept %q: /s is served without a CSP", accept)
		}
		// The CSP only hashes index.html's inline script, so share.html must have none.
		if inlineScript.MatchString(body) {
			t.Error("share.html has an inline <script>; the CSP would block it")
		}
	}
	for _, p := range []string{"/share.js", "/share.css"} {
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		if w.Code != 200 {
			t.Errorf("GET %s: status %d, want 200", p, w.Code)
		}
	}
}
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `go test ./cmd/server -run TestSharePageIsServedAtS 2>&1 | head -10`
Expected: FAIL (`Accept "text/html...": /s did not serve share.html` atau status 404 untuk `Accept ""`).

- [ ] **Step 3: Buat `web/dist/share.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Shared note · io-notes</title>
<link rel="icon" type="image/png" href="/favicon-io-notes.png">
<link rel="stylesheet" href="/share.css?v=1">
</head>
<body>
<main id="share"><p class="share-status" role="status"><span class="spinner"></span><span>Loading…</span></p></main>
<script src="/share.js?v=1" defer></script>
</body>
</html>
```

- [ ] **Step 4: Buat `web/dist/share.css`**

```css
/* Read-only page for a shared note. Self-contained: it must not depend on app.css,
   which belongs to the signed-in app. Palette values mirror app.css. */

:root{
  color-scheme:light dark;
  --bg:#fbfbfd;
  --surface-3:#e5e5ea;
  --border:#e5e5ea;
  --border-strong:#d1d1d6;
  --text:#1d1d1f;
  --text-2:#3a3a3c;
  --text-muted:#6e6e73;
  --text-tertiary:#8e8e93;
  --accent:#007aff;
  --folder-yellow:#ffcc02;
  --ok:#34c759;
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#1c1c1e;
    --surface-3:#48484a;
    --border:#38383a;
    --border-strong:#48484a;
    --text:#f5f5f7;
    --text-2:#d1d1d6;
    --text-muted:#98989d;
    --text-tertiary:#8e8e93;
    --accent:#0a84ff;
    --ok:#30d158;
  }
}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--text);font-family:var(--font)}

#share{
  max-width:720px;margin:0 auto;
  padding:calc(32px + env(safe-area-inset-top,0px)) calc(20px + env(safe-area-inset-right,0px)) calc(48px + env(safe-area-inset-bottom,0px)) calc(20px + env(safe-area-inset-left,0px));
}

.share-title{margin:0 0 18px;font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-.02em;overflow-wrap:anywhere}
.share-content{font-size:16px;line-height:26px;color:var(--text-2)}
.content-line{min-height:26px;white-space:pre-wrap;overflow-wrap:anywhere}
.content-line mark{background:color-mix(in srgb,var(--folder-yellow) 35%,transparent);border-radius:3px;padding:0 2px}
.content-line code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--surface-3);border-radius:4px;padding:0 4px}
.content-line s{color:var(--text-tertiary)}

.check{
  display:inline-grid;place-items:center;width:17px;height:17px;margin-right:8px;
  border-radius:50%;border:1.5px solid var(--border-strong);vertical-align:-3px;
}
.check.done{background:var(--ok);border-color:var(--ok)}
.cl-text.done{text-decoration:line-through;color:var(--text-tertiary)}

.attach-label{display:inline-flex;align-items:center;gap:5px;max-width:100%;color:var(--text-muted)}
.attach-label svg{flex:none;color:var(--text-tertiary)}
.attach-label .attach-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.share-state{padding:72px 12px;text-align:center;color:var(--text-muted)}
.share-state h1{margin:0 0 8px;font-size:18px;font-weight:700;color:var(--text)}
.share-state p{margin:0;font-size:14px;line-height:1.5}

.share-status{display:flex;align-items:center;justify-content:center;gap:10px;padding:72px 12px;margin:0;color:var(--text-muted);font-size:14px}
.spinner{width:20px;height:20px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--accent);animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:2.4s}}
```

- [ ] **Step 5: Buat `web/dist/share.js`**

```js
// Read-only view of a shared note. The token lives in the URL fragment, which the
// browser never sends to the server; it only travels in the body of the read request.
(() => {
  'use strict';

  const root = document.getElementById('share');
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  const ATTACH_RE = /^!\[([^\]]*)\]\(attach:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;
  const CHECKLIST_RE = /^(\s*)(🟡|✅)(\s+)(.*)$/;
  const CHECK_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.8 4.6 4.6L19 7.6"/></svg>';
  const PAPERCLIP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 11.5-8.2 8.2a5 5 0 0 1-7-7l8.9-8.9a3.3 3.3 0 0 1 4.7 4.7L9.6 17.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The server stores checklists as "- [ ] " / "- [x] " and older notes may still hold
  // the emoji form. The editor converts both to emoji when it opens a note
  // (app.js normalizeContent); this page does the same before rendering.
  function normalizeContent(content) {
    return String(content || '')
      .replace(/<u>([\s\S]*?)<\/u>/gi, '_$1_')
      .replace(/^(\s*)-\s+\[\s\]\s+/gm, '$1🟡 ')
      .replace(/^(\s*)-\s+\[[xX]\]\s+/gm, '$1✅ ');
  }

  // Same inline rules as the editor overlay (app.js formatInline). The text is
  // escaped first, so nothing from the note is ever interpreted as markup.
  function formatInline(text) {
    return esc(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1<u>$2</u>')
      .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  }

  function renderContent(value) {
    return normalizeContent(value).split('\n').map((line) => {
      const attach = ATTACH_RE.exec(line);
      if (attach) {
        return `<div class="content-line"><span class="attach-label">${PAPERCLIP_SVG}<span class="attach-name">${esc(attach[1])}</span></span></div>`;
      }
      const item = CHECKLIST_RE.exec(line);
      if (!item) return `<div class="content-line">${formatInline(line) || '&nbsp;'}</div>`;
      const done = item[2] === '✅';
      return `<div class="content-line checklist-line">${item[1]}<span class="check${done ? ' done' : ''}" aria-hidden="true">${done ? CHECK_SVG : ''}</span><span class="cl-text${done ? ' done' : ''}">${formatInline(item[4]) || '&nbsp;'}</span></div>`;
    }).join('');
  }

  function showMessage(title, text) {
    root.innerHTML = `<div class="share-state" role="alert"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  }

  async function load() {
    const token = location.hash.slice(1);
    if (!TOKEN_RE.test(token)) {
      showMessage('Link unavailable', 'This link is incomplete or has been turned off.');
      return;
    }
    let res;
    try {
      res = await fetch('/api/v1/shared/read', {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      showMessage('No connection', 'Check your internet connection and reload this page.');
      return;
    }
    if (res.status === 429) {
      showMessage('Too many requests', 'Please wait a moment and reload this page.');
      return;
    }
    const note = res.ok ? await res.json().catch(() => null) : null;
    if (!note) {
      showMessage('Link unavailable', 'This link is unavailable or has been turned off.');
      return;
    }
    const title = note.title || 'Untitled';
    document.title = `${title} · io-notes`;
    root.innerHTML = `<article><h1 class="share-title">${esc(title)}</h1><div class="share-content">${renderContent(note.content)}</div></article>`;
  }

  window.addEventListener('hashchange', () => void load());
  void load();
})();
```

- [ ] **Step 6: Tambah cabang `/s` di `staticFallback` (`main.go`)**

Di `staticFallback`, tepat sebelum baris `path := r.URL.Path`... tidak: sisipkan **setelah** blok `if path == "/sw.js" { ... return }` dan **sebelum** `if path == "/" || strings.HasPrefix(path, "/#") {`:

```go
		if path == "/s" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			page, err := webassets.Dist.ReadFile("dist/share.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			// The link is a credential. Never let it travel in a Referer, and keep it out of search.
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("X-Robots-Tag", "noindex")
			_, _ = w.Write(page)
			return
		}
```

- [ ] **Step 7: Jalankan test Go + `node --check`**

Run: `gofmt -l cmd/ ; go test ./cmd/server -run TestSharePageIsServedAtS -v 2>&1 | tail -5 ; node --check web/dist/share.js && echo "share.js syntax OK"`
Expected: `--- PASS: TestSharePageIsServedAtS`, `share.js syntax OK`.

- [ ] **Step 8: Harness e2e mencatat request ke server**

Di `web/e2e/harness.mjs`, ganti:

```js
  const failures = new Map();
  const proxy = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, base);
```

dengan:

```js
  const failures = new Map();
  // Every request that reaches the server, as "METHOD /path?query". This is the
  // server's own view, so it proves what the browser really put on the wire.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const { pathname } = new URL(req.url, base);
```

dan ganti:

```js
    delays,
    failures,
```

dengan:

```js
    delays,
    failures,
    seen,
```

- [ ] **Step 9: Tulis e2e halaman share**

Buat `web/e2e/share.test.mjs`:

```js
// A shared note opens for someone with no account and no session, straight from the
// link, and the token never travels in a URL.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { signIn, startApp } from './harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const uuid = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

// Puts a note on the server for a signed-in context and returns its id.
async function serverNote(ctx, n, title, content) {
  const id = uuid(n);
  const now = Date.now();
  const res = await ctx.request.post(app.base + '/api/v1/sync/push', {
    data: { device_id: 'e2e', mutations: [{ mutation_id: uuid(n + 1000), note: { id, title, content, created_at: now, updated_at: now, deleted_at: null, folder_id: '', is_pinned: false } }] },
  });
  assert.ok(res.ok(), `push failed: HTTP ${res.status()}`);
  return id;
}

async function shareLink(ctx, id, data = {}) {
  const res = await ctx.request.put(`${app.base}/api/v1/notes/${id}/share`, { data });
  assert.ok(res.ok(), `share failed: HTTP ${res.status()}`);
  return (await res.json()).token;
}

async function owner(email) {
  const ctx = await app.newContext();
  await signIn(ctx, app.base, email);
  return ctx;
}

test('a share link renders the note for a visitor with no session', async () => {
  const ctx = await owner('share-owner@example.com');
  const visitor = await app.newContext(); // fresh browser: no cookies, no storage
  try {
    const id = await serverNote(ctx, 1, 'Weekly plan', [
      '**Bold** and `code`',
      '- [ ] todo item',
      '- [x] done item',
      '![report.pdf](attach:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)',
    ].join('\n'));
    const token = await shareLink(ctx, id);

    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();

    assert.equal(await page.locator('.share-title').textContent(), 'Weekly plan');
    assert.equal(await page.locator('.share-content strong').textContent(), 'Bold');
    assert.equal(await page.locator('.share-content code').textContent(), 'code');
    assert.equal(await page.locator('.checklist-line').count(), 2);
    assert.equal(await page.locator('.checklist-line .check.done').count(), 1);
    assert.equal(await page.locator('.attach-label .attach-name').textContent(), 'report.pdf');
    assert.equal(await page.locator('#shell, .login-card, #app').count(), 0, 'the app shell or a login card appeared');
    assert.equal(await page.title(), 'Weekly plan · io-notes');

    // What the server received: the read happened, and no request URL carried the token.
    assert.ok(app.seen.some((s) => s.startsWith('POST /api/v1/shared/read')), 'the proxy never saw the read request, so this check proves nothing');
    assert.deepEqual(app.seen.filter((s) => s.includes(token)), [], 'the token reached the server inside a URL');
  } finally {
    await visitor.close();
    await ctx.close();
  }
});

test('markup in a shared note is shown as text and never runs', async () => {
  const ctx = await owner('share-xss@example.com');
  const visitor = await app.newContext();
  try {
    const id = await serverNote(ctx, 2, '<img src=x onerror="window.__pwned=1">', [
      '<script>window.__pwned=1</script>',
      '<img src=x onerror="window.__pwned=1">',
      '[click](javascript:window.__pwned=1)',
    ].join('\n'));
    const token = await shareLink(ctx, id);

    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();

    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'note markup executed');
    assert.equal(await page.locator('#share img, #share script, #share a').count(), 0, 'note markup became elements');
    assert.match((await page.locator('.share-title').textContent()) || '', /<img src=x onerror=/);
    assert.match((await page.locator('.share-content').textContent()) || '', /<script>window\.__pwned=1<\/script>/);
  } finally {
    await visitor.close();
    await ctx.close();
  }
});

test('a turned-off, malformed or missing link shows the same unavailable page', async () => {
  const ctx = await owner('share-off@example.com');
  const visitor = await app.newContext();
  try {
    const id = await serverNote(ctx, 3, 'Soon private', 'text');
    const token = await shareLink(ctx, id);
    const page = await visitor.newPage();

    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();

    const off = await ctx.request.delete(`${app.base}/api/v1/notes/${id}/share`);
    assert.ok(off.ok());
    await page.reload();
    await page.locator('.share-state').waitFor();
    assert.match((await page.locator('.share-state h1').textContent()) || '', /Link unavailable/);

    // A fragment that cannot be a token must not even ask the server.
    const reads = () => app.seen.filter((s) => s.startsWith('POST /api/v1/shared/read')).length;
    const before = reads();
    await page.goto(`${app.base}/s#not-a-token`);
    await page.reload();
    await page.locator('.share-state').waitFor();
    assert.equal(reads(), before, 'a malformed fragment still produced a read request');

    await page.goto(`${app.base}/s`);
    await page.reload();
    await page.locator('.share-state').waitFor();
    assert.match((await page.locator('.share-state h1').textContent()) || '', /Link unavailable/);
  } finally {
    await visitor.close();
    await ctx.close();
  }
});
```

- [ ] **Step 10: Jalankan e2e halaman share, pastikan lulus**

Run: `cd web/e2e && node --test --test-concurrency=1 share.test.mjs 2>&1 | tail -25`
Expected: 3 test `✔`, `fail 0`. (Run pertama membangun binary Go, beberapa detik.)

- [ ] **Step 11: Probe**

Jalankan `cd web/e2e && node --test --test-concurrency=1 share.test.mjs 2>&1 | tail -20` setelah tiap perubahan, lalu kembalikan:

1. Di `share.js`, ganti `${esc(title)}` pada `<h1 class="share-title">` jadi `${title}` → test "markup ... never runs" harus gagal.
2. Di `share.js`, ganti `${formatInline(line) || '&nbsp;'}` (cabang non-checklist) jadi `${line || '&nbsp;'}` → test yang sama harus gagal.
3. Di `share.js`, kirim token lewat query: ganti `'/api/v1/shared/read'` di `fetch(...)` jadi `'/api/v1/shared/read?token=' + token` → test pertama harus gagal di "the token reached the server inside a URL".
4. Di `main.go`, hapus `w.Header().Set("Referrer-Policy", "no-referrer")` di cabang `/s` → `TestSharePageIsServedAtS` harus gagal.

Kembalikan semuanya; jalankan ulang Step 10 dan `go test ./cmd/server`, harus PASS.

- [ ] **Step 12: Checkpoint (TANPA commit)**

Run: `gofmt -l cmd/ ; go vet ./... && go test ./... 2>&1 | tail -3 ; node --check web/dist/share.js && git status --short`
Expected: bersih; `git status` menampilkan `?? web/dist/share.html`, `?? web/dist/share.js`, `?? web/dist/share.css`, `?? web/e2e/share.test.mjs`, `M web/e2e/harness.mjs`, `M cmd/server/main.go`, dan file Task 1–2.

---

### Task 4: UI owner di editor + versi aset

**Files:**
- Modify: `web/dist/app.js` (icon, click handler, header button, `shareMenu`)
- Modify: `web/dist/app.css` (style `.share-row`)
- Modify: `web/dist/index.html`, `web/dist/sw.js` (versi aset 69 → 70)
- Test: `web/e2e/share.test.mjs` (tambah dua test)

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/v1/notes/{id}/share` (Task 1); helper di `app.js`: `currentNote()`, `ensureOnServer(n)`, `api(path, opts)`, `modal({...})`, `toast(msg)`, `netMessage(e)`, `icon(name, size)`, `esc`, `$`, `state.online`.
- Produces: button `[data-act="share"]` di header editor; dialog dengan `#share-url` (input read-only), `[data-share-copy]`, dan choice `Create link` / `Regenerate link` / `Turn off link`.

- [ ] **Step 1: Tulis e2e UI yang gagal**

Ubah import di `web/e2e/share.test.mjs`:

```js
import { returningUser, saveNewNote, signIn, startApp } from './harness.mjs';
```

Tambahkan di akhir file:

```js
const TOKEN_TAIL = /^[A-Za-z0-9_-]{43}$/;

// Opens a share link in a browser that has never seen the app and returns what it shows.
async function visit(url) {
  const visitor = await app.newContext();
  try {
    const page = await visitor.newPage();
    await page.goto(url);
    await page.locator('.share-title, .share-state').first().waitFor();
    return {
      unavailable: (await page.locator('.share-state').count()) > 0,
      text: await page.locator('#share').textContent(),
    };
  } finally {
    await visitor.close();
  }
}

test('the owner creates, copies, regenerates and turns off a link from the editor', async () => {
  const { ctx, page } = await returningUser(app, 'share-ui@example.com');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
  try {
    await saveNewNote(page, 'shared from the editor');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });

    await page.locator('[data-act="share"]').click();
    await page.getByRole('button', { name: 'Create link', exact: true }).click();
    const input = page.locator('#share-url');
    await input.waitFor();
    const first = await input.inputValue();
    assert.ok(first.startsWith(`${app.base}/s#`), `link is ${first}`);
    assert.match(first.slice(`${app.base}/s#`.length), TOKEN_TAIL);

    // Copy: the button confirms inline and the clipboard really holds the link.
    await page.locator('[data-share-copy]').click();
    await page.locator('[data-share-copy]', { hasText: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), first);

    // Pressing Enter in the read-only field must not submit the dialog's form (a reload).
    await input.press('Enter');
    assert.equal(await page.locator('#share-url').count(), 1, 'Enter closed or reloaded the dialog');

    const live = await visit(first);
    assert.equal(live.unavailable, false);
    assert.match(live.text, /shared from the editor/);

    // Regenerate: the old link dies at once, the new one works.
    await page.getByRole('button', { name: 'Regenerate link', exact: true }).click();
    await page.getByRole('heading', { name: 'Regenerate link?' }).waitFor();
    await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await page.waitForFunction((old) => document.querySelector('#share-url')?.value !== old, first);
    const second = await page.locator('#share-url').inputValue();
    assert.notEqual(second, first);
    assert.equal((await visit(first)).unavailable, true, 'the old link still works after regenerate');
    assert.equal((await visit(second)).unavailable, false);

    // Turn off: back to the create state, and the link is dead.
    await page.getByRole('button', { name: 'Turn off link', exact: true }).click();
    await page.getByRole('heading', { name: 'Turn off link?' }).waitFor();
    await page.getByRole('button', { name: 'Turn off link', exact: true }).click();
    await page.getByRole('button', { name: 'Create link', exact: true }).waitFor();
    assert.equal((await visit(second)).unavailable, true, 'the link still works after it was turned off');
  } finally {
    await ctx.close();
  }
});

test('a locked note cannot be shared from the editor', async () => {
  const { ctx, page } = await returningUser(app, 'share-locked@example.com');
  try {
    await saveNewNote(page, 'secret plans');
    await page.waitForSelector('#sync[data-state="synced"]', { timeout: 10000 });

    await page.locator('[data-act="lock"]').click();
    await page.fill('#mf-password', 'password123');
    await page.fill('#mf-confirm', 'password123');
    await page.getByRole('button', { name: 'Lock note', exact: true }).click();
    await page.locator('#toasts').getByText('Note locked', { exact: true }).waitFor();

    await page.locator('[data-act="share"]').click();
    await page.locator('#toasts').getByText('Locked notes cannot be shared', { exact: false }).waitFor();
    assert.equal(await page.locator('#share-url').count(), 0, 'a share dialog opened for a locked note');
    assert.equal(await page.getByRole('button', { name: 'Create link', exact: true }).count(), 0);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `cd web/e2e && node --test --test-concurrency=1 --test-name-pattern='owner creates|locked note cannot' share.test.mjs 2>&1 | tail -20`
Expected: kedua test gagal (timeout menunggu `[data-act="share"]`).

- [ ] **Step 3: Tambah icon `link` dan `copy` di `app.js`**

Ganti baris penutup `ICON_PATHS` (entri `warn` + `};`):

```js
    warn: '<path d="M12 4.6 2.8 20.2h18.4z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
  };
```

dengan:

```js
    warn: '<path d="M12 4.6 2.8 20.2h18.4z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.1 1.1"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.1-1.1"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6.2A2.2 2.2 0 0 1 7.2 4H16"/>',
  };
```

- [ ] **Step 4: Tambah handler klik dan button header**

Di `onShellClick`, setelah baris `if (act === 'lock') return void lockMenu();`, tambah:

```js
    if (act === 'share') return void shareMenu();
```

Di `editorHTML`, pada string `actions` untuk note non-Trash, sisipkan button Share **tepat sebelum** button lock. Ganti substring:

```
<button class="icon-btn ${n.is_locked ? 'on' : ''}" data-act="lock"
```

dengan:

```
<button class="icon-btn" data-act="share" aria-label="Share note" title="Share">${icon('link')}</button><button class="icon-btn ${n.is_locked ? 'on' : ''}" data-act="lock"
```

Pastikan substring aslinya unik dulu: `grep -c 'data-act="lock"' web/dist/app.js` harus `1`. Sesudah edit, `grep -c 'data-act="share"' web/dist/app.js` harus `1`.

- [ ] **Step 5: Tambah `shareMenu` dkk di `app.js`**

Sisipkan blok ini **tepat sebelum** baris komentar `  /* ------------------------------------------------------------ note lock */`:

```js
  /* ----------------------------------------------------------- note share */

  const shareURL = (token) => `${location.origin}/s#${token}`;
  const shareEndpoint = (n) => `/api/v1/notes/${encodeURIComponent(n.id)}/share`;
  const SHARE_LOCKED_MESSAGE = 'Locked notes cannot be shared. Remove the password first.';

  // Online-only, like attachments: the link lives on the server and never enters the
  // note sync model. The note has to exist there first, hence ensureOnServer.
  async function shareMenu() {
    const n = currentNote();
    if (!n || n.deleted_at) return;
    if (!state.online) { toast('Sharing requires internet connection.'); return; }
    const ready = await ensureOnServer(n);
    if (!ready) { toast('Note not synced yet. Please try again shortly.'); return; }
    try {
      let status = await api(shareEndpoint(ready));
      while (status) status = await shareDialog(ready, status);
    } catch (e) {
      toast(e.code === 'NOTE_LOCKED' ? SHARE_LOCKED_MESSAGE : netMessage(e));
    }
  }

  // Shows the dialog for the current share status and returns the status that
  // results from the chosen action, or null once the dialog is dismissed.
  async function shareDialog(n, status) {
    if (!status.shared) {
      if (n.is_locked) { toast(SHARE_LOCKED_MESSAGE); return null; }
      const choice = await modal({
        title: 'Share note',
        description: 'Anyone with the link can read this note without signing in. Attachments are not shared. You can turn the link off at any time.',
        choices: [{ value: 'create', label: 'Create link', icon: 'link' }],
        cancelText: 'Close',
      });
      if (choice !== 'create') return null;
      const created = await api(shareEndpoint(n), { method: 'PUT', body: '{}' });
      return { shared: true, active: true, token: created.token };
    }

    const url = shareURL(status.token);
    const pending = modal({
      title: 'Share note',
      description: status.active
        ? 'Anyone with this link can read the latest version of this note.'
        : 'This link is inactive while the note is locked.',
      previewHTML: `<div class="field"><label for="share-url">Link</label><div class="share-row"><input id="share-url" type="text" readonly value="${esc(url)}"><button type="button" class="btn" data-share-copy>${icon('copy', 15)} Copy</button></div></div>`,
      choices: [
        { value: 'regenerate', label: 'Regenerate link', icon: 'restore' },
        { value: 'revoke', label: 'Turn off link', icon: 'trash', danger: true },
      ],
      cancelText: 'Close',
    });
    // modal() builds the dialog synchronously, so the Copy button exists already.
    wireShareCopy(url);
    const choice = await pending;

    if (choice === 'regenerate') {
      const ok = await modal({ title: 'Regenerate link?', description: 'The current link stops working immediately. Anyone who has it loses access.', confirmText: 'Regenerate', danger: true });
      if (!ok) return status;
      const fresh = await api(shareEndpoint(n), { method: 'PUT', body: JSON.stringify({ regenerate: true }) });
      return { shared: true, active: true, token: fresh.token };
    }
    if (choice === 'revoke') {
      const ok = await modal({ title: 'Turn off link?', description: 'Anyone with the link loses access to this note.', confirmText: 'Turn off link', danger: true });
      if (!ok) return status;
      await api(shareEndpoint(n), { method: 'DELETE' });
      return { shared: false };
    }
    return null;
  }

  function wireShareCopy(url) {
    const form = $('#modal-form');
    const button = $('[data-share-copy]');
    if (!form || !button) return;
    // Choice dialogs have no submit handler, and Enter in the read-only input would
    // otherwise submit the form and reload the page.
    form.addEventListener('submit', (e) => e.preventDefault());
    button.addEventListener('click', async () => {
      const label = button.innerHTML;
      try {
        await navigator.clipboard.writeText(url);
        button.innerHTML = `${icon('check', 15)} Copied`;
      } catch {
        // Toasts sit under the <dialog> while it is open, so feedback stays inline.
        const input = $('#share-url');
        input?.focus();
        input?.select();
        button.textContent = 'Press Ctrl/Cmd+C';
      }
      setTimeout(() => { if (button.isConnected) button.innerHTML = label; }, 1800);
    });
  }

```

- [ ] **Step 6: Tambah style di `app.css`**

Append di akhir `web/dist/app.css`:

```css

/* ---------- share dialog ---------- */
.share-row{display:flex;gap:8px;align-items:center}
.share-row input{flex:1;width:auto;min-width:0;height:34px;font-size:12px;color:var(--text)}
.share-row .btn{flex:none}
```

- [ ] **Step 7: Naikkan versi aset 69 → 70**

`app.js` dan `app.css` berubah, dan aset berversi disajikan `immutable`: tanpa bump, browser yang sudah punya v69 tidak pernah menerima UI baru.

Run:

```bash
cd /Users/mthidayat/Dev-Labs/litenotes
sed -i '' 's/v=69/v=70/g; s/shell-v69/shell-v70/g' web/dist/index.html web/dist/sw.js
grep -rn -E 'v=69|v69' web/dist cmd || echo "no v69 left"
grep -n -E 'v=70|v70' web/dist/index.html web/dist/sw.js | cut -c1-120
```

Expected: `no v69 left`; `index.html` menampilkan 3 baris `v=70` (manifest, css, js); `sw.js` baris 1 `io-notes-shell-v70` dan baris 2 dengan `/app.css?v=70`, `/app.js?v=70`, `/manifest.webmanifest?v=70`.

- [ ] **Step 8: Cek syntax dan jalankan e2e UI**

Run: `node --check web/dist/app.js && node --check web/dist/sw.js && echo "syntax OK" && cd web/e2e && node --test --test-concurrency=1 share.test.mjs 2>&1 | tail -20`
Expected: `syntax OK`; kelima test di `share.test.mjs` `✔`, `fail 0`.

- [ ] **Step 9: Probe**

Jalankan e2e `share.test.mjs` setelah tiap perubahan (`cd web/e2e && node --test --test-concurrency=1 share.test.mjs 2>&1 | tail -20`), lalu kembalikan:

1. Hapus baris `if (n.is_locked) { toast(SHARE_LOCKED_MESSAGE); return null; }` di `shareDialog` → test "a locked note cannot be shared" gagal.
2. Hapus baris `form.addEventListener('submit', (e) => e.preventDefault());` di `wireShareCopy` → test "owner creates..." gagal di langkah Enter (dialog hilang/reload). Jika test tetap lulus, catat di laporan bahwa Enter pada input read-only tidak men-submit di Chromium, lalu **tetap pertahankan** guard-nya (Safari/Firefox belum diuji).
3. Ganti `body: JSON.stringify({ regenerate: true })` jadi `body: '{}'` → test "owner creates..." gagal ("the old link still works after regenerate").

- [ ] **Step 10: Checkpoint (TANPA commit)**

Run: `gofmt -l cmd/ ; go vet ./... && go test ./... 2>&1 | tail -3 ; git status --short`
Expected: bersih; `M web/dist/app.js`, `M web/dist/app.css`, `M web/dist/index.html`, `M web/dist/sw.js` ikut muncul.

---

### Task 5: Dokumentasi + verifikasi akhir

**Files:**
- Modify: `README.md`, `PRD-notepad-pwa.md`

**Interfaces:** tidak ada yang baru.

- [ ] **Step 1: README: Highlights**

Di `README.md`, setelah bullet `- 📎 **Private Attachments & Preview**: ...`, tambah:

```markdown
- 🔗 **Share via Link**: Share a note as a read-only link (`/s#<token>`) that opens without signing in. The owner can turn the link off or regenerate it at any time. Attachments are not included.
```

- [ ] **Step 2: README: section Sharing**

Sisipkan section ini tepat sebelum baris `## 🚀 Quick Start (Local Development)` (dengan `---` pemisah seperti section lain):

```markdown
## 🔗 Sharing notes

A shared note is read-only and always shows the latest version. The link carries a random token in the URL fragment (`/s#<token>`), so the token is never sent to the server in a URL, written to access logs, or leaked through `Referer`.

- One link per note, no expiry. **Regenerate** replaces the token (the old link stops working immediately); **Turn off link** deletes it.
- A link only works while the note exists, is not in Trash and is not locked. Locked notes cannot be shared.
- Attachments are not shared; an attachment reference appears as a file name only.
- Every failure (unknown, turned off, in Trash, locked) returns the same `404`, so a link cannot be probed.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/notes/{id}/share` | session | `{shared, token, active}` |
| `PUT /api/v1/notes/{id}/share` | session | Create or fetch the link; `{"regenerate": true}` replaces it |
| `DELETE /api/v1/notes/{id}/share` | session | Turn the link off (idempotent) |
| `POST /api/v1/shared/read` | none, rate limited per IP | Body `{"token"}` → `{title, content, updated_at}` |

---

```

- [ ] **Step 3: README: struktur project**

Di blok `## 📂 Project Structure`, ganti baris:

```
│   ├── attachments.go  # Upload, preview/download, quota, and storage handlers
```

dengan:

```
│   ├── attachments.go  # Upload, preview/download, quota, and storage handlers
│   ├── share.go        # Share links: owner endpoints and the public read endpoint
```

dan ganti baris:

```
│   ├── dist/           # HTML, CSS, JS, PWA Service Worker & icons
```

dengan:

```
│   ├── dist/           # HTML, CSS, JS, PWA Service Worker & icons (share.* = public share page)
```

- [ ] **Step 4: PRD baris 71**

Di `PRD-notepad-pwa.md`, ganti:

```
- Kolaborasi real-time atau shared note.
```

dengan:

```
- Kolaborasi real-time atau shared note yang bisa diedit penerima. (Link share read-only sudah didukung setelah MVP; lihat README.)
```

- [ ] **Step 5: Verifikasi penuh (bukti eksekusi)**

Run semuanya dan simpan outputnya untuk laporan:

```bash
cd /Users/mthidayat/Dev-Labs/litenotes
echo "== gofmt =="; gofmt -l cmd/
echo "== build =="; go build ./... && echo ok
echo "== vet =="; go vet ./... && echo ok
echo "== go test (no cache) =="; go test ./... -count=1 2>&1 | tail -5
echo "== node --check =="; for f in web/dist/app.js web/dist/sw.js web/dist/share.js; do node --check "$f" && echo "ok $f"; done
echo "== version consistency =="; grep -rn -E 'v=69|v69' web/dist cmd || echo "no v69 left"
echo "== e2e (full suite) =="; (cd web/e2e && npm test 2>&1 | tail -14)
```

Expected: `gofmt -l` kosong; build/vet `ok`; `ok litenotes/cmd/server`; tiga `ok <file>`; `no v69 left`; e2e `pass 30` (25 lama + 5 share), `fail 0`.

- [ ] **Step 6: Pemeriksaan visual halaman share**

Buat script di scratchpad `/private/tmp/claude-501/-Users-mthidayat-Dev-Labs-litenotes/c994aaa1-330a-48d2-9134-a58547bb8f11/scratchpad/shot.mjs`:

```js
import { startApp, signIn } from '/Users/mthidayat/Dev-Labs/litenotes/web/e2e/harness.mjs';

const out = '/private/tmp/claude-501/-Users-mthidayat-Dev-Labs-litenotes/c994aaa1-330a-48d2-9134-a58547bb8f11/scratchpad';
const app = await startApp();
try {
  const owner = await app.newContext();
  await signIn(owner, app.base, 'shot@example.com');
  const id = '33333333-3333-4333-8333-000000000001';
  const now = Date.now();
  const content = ['# not a heading, this editor is plain text', '**Bold**, *italic*, _underline_, ==marked==, `code`, ~~gone~~', '', '- [ ] write the plan', '- [x] review the spec', '', '![report.pdf](attach:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)', '', 'A long line '.repeat(20)].join('\n');
  await owner.request.post(app.base + '/api/v1/sync/push', { data: { device_id: 'shot', mutations: [{ mutation_id: '33333333-3333-4333-8333-000000000002', note: { id, title: 'Weekly plan', content, created_at: now, updated_at: now, deleted_at: null, folder_id: '', is_pinned: false } }] } });
  const { token } = await (await owner.request.put(`${app.base}/api/v1/notes/${id}/share`, { data: {} })).json();
  for (const scheme of ['light', 'dark']) {
    for (const [name, viewport] of [['desktop', { width: 1000, height: 700 }], ['phone', { width: 390, height: 780 }]]) {
      const ctx = await app.newContext();
      const page = await ctx.newPage();
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${app.base}/s#${token}`);
      await page.locator('.share-title').waitFor();
      await page.screenshot({ path: `${out}/share-${scheme}-${name}.png` });
      await ctx.close();
    }
  }
} finally {
  await app.stop();
}
```

Run: `cd /Users/mthidayat/Dev-Labs/litenotes/web/e2e && node /private/tmp/claude-501/-Users-mthidayat-Dev-Labs-litenotes/c994aaa1-330a-48d2-9134-a58547bb8f11/scratchpad/shot.mjs`

Lalu `Read` keempat PNG (`share-light-desktop.png`, `share-dark-desktop.png`, `share-light-phone.png`, `share-dark-phone.png`) dan periksa: judul terbaca, checklist (satu terisi hijau), label attachment dengan ikon paperclip, tidak ada horizontal scroll di phone, kontras dark mode wajar. Perbaiki `share.css` kalau ada yang jelek, lalu naikkan `share.css?v=1` dan `share.js?v=1` di `share.html` ke `?v=2` bila `share.css`/`share.js` diubah setelah ini.

- [ ] **Step 7: Cek spec vs hasil**

Buka `docs/superpowers/specs/2026-10-08-share-note-design.md` dan centang tiap butir terhadap kode: tabel `note_shares`, tiga endpoint owner, endpoint publik, guard query, dua limiter, route `/s` + header, `share.*`, UI owner, dan docs. Jika ada butir yang tidak sesuai, perbaiki kodenya (bukan spec) kecuali memang spec yang salah; kalau spec yang diubah, sebutkan di laporan.

- [ ] **Step 8: Checkpoint akhir (TANPA commit)**

Run: `git status --short && git diff --stat`
Laporkan ke owner: daftar file berubah, hasil verifikasi Step 5 apa adanya, screenshot Step 6, dan "belum saya commit". Temuan sampingan (teks modal lock dan non-goals PRD) sudah disampaikan di chat saat plan diserahkan; jangan diulang.
