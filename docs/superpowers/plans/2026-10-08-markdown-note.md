# Markdown Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Note punya tipe `md` (field `format` yang tersinkron). Note Markdown terbuka dalam tampilan rendered, bisa diedit sebagai teks polos, dan dirender juga di halaman share.

**Architecture:** Server menambah kolom `notes.format` (`text` | `md`; kosong berarti pertahankan nilai tersimpan). Renderer Markdown buatan sendiri (`web/dist/md.js`, escape-first, tanpa dependency) dipakai app dan halaman share, dan bisa diuji di Node. Editor memisahkan mode View (rendered) dan Edit (textarea polos) untuk note `md`, dan isi note `md` tidak pernah melewati `normalizeContent`/`canonicalContent`.

**Tech Stack:** Go `net/http` + SQLite/libSQL, vanilla JS classic script (`web/dist`), `node --test` untuk unit renderer, Playwright untuk e2e (`web/e2e`).

**Spec:** `docs/superpowers/specs/2026-10-08-markdown-note-design.md`. Kode, skrip patch, dan test di plan ini sudah dijalankan dan lulus pada salinan repo (Go penuh, `md.js` 101 test, e2e penuh 142 test, semua probe), jadi tiap blok di bawah bisa disalin apa adanya. Hash sha256 dicantumkan untuk memeriksa salinan.

## Global Constraints

- **JANGAN `git add` / `git commit` / `git push` / deploy** sampai owner menyuruh. Izin commit dan deploy sebelumnya hanya berlaku untuk fitur share. Plan ini tidak punya step commit; tiap task ditutup dengan checkpoint `git status`.
- Semua perintah dijalankan dari root repo `/Users/mthidayat/Dev-Labs/litenotes`.
- `format` bernilai `text` atau `md`; selain itu 400 `VALIDATION_ERROR` ("format harus text atau md"). **Kosong berarti pertahankan nilai tersimpan** (note baru: `text`), diputuskan sebelum perbandingan `superseded/unchanged` dan sebelum upsert. Mapping `push` di client hanya mengirim `format` jika `n.format` terdefinisi.
- `md.js`: `MAX_BYTES = 512 * 1024` (byte UTF-8), `MAX_DEPTH = 20`, class berawalan `md-`, hanya `http`/`https` yang menjadi link, semua teks di-escape sebelum markup ditambah. **Jangan menulis escape `\u` di source `md.js`**: tool `Write` mengubahnya jadi karakter private-use yang tak terlihat. File di plan dibuat lewat heredoc dan sudah bebas dari itu (cek ada di Task 2).
- Isi note `md` tidak pernah melewati `normalizeContent` / `canonicalContent`.
- Versi aset shell naik dari 70 ke 71 (`index.html`, `sw.js`, nama cache `io-notes-shell-v71`). `md.js` dan `md.css` masuk `ASSETS` dan `ASSET_PATHS` di `sw.js`. `share.js` dan `share.css` naik ke `?v=2`.
- String UI Bahasa Inggris; pesan error server Bahasa Indonesia.
- `build`, `vet`, `test` bersih tanpa warning. Setiap guard di-probe: matikan, test relevan harus GAGAL, kembalikan.
- Baseline sebelum mulai (diverifikasi saat plan ditulis): `go test ./...` hijau, e2e 31 pass.

## Helper probe

Beberapa task memakai fungsi shell ini untuk mematikan satu guard, menjalankan test, lalu mengembalikan file. Definisikan ulang di setiap blok perintah yang memakainya (state shell tidak bertahan antar perintah):

```bash
probe() {  # probe <file> <old> <new> -- <test command...>
  local file="$1" old="$2" new="$3"; shift 4
  local backup; backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path).read()
assert s.count(old) == 1, f"{s.count(old)} occurrences of {old[:60]!r}"
open(path, "w").write(s.replace(old, new))
PYEOF
  "$@"
  cp "$backup" "$file"; rm "$backup"
}
```

## File Structure

| File | Aksi | Tanggung jawab |
|---|---|---|
| `cmd/server/schema.sql`, `cmd/server/main.go` | Modify | Kolom `format`, struct, validasi, aturan "kosong berarti pertahankan", upsert/select/scan |
| `cmd/server/share.go` | Modify | `shared/read` ikut mengirim `format` |
| `cmd/server/format_test.go` | Create | Test `format` di server |
| `cmd/server/shell_test.go` | Create | Guard precache `sw.js` dan kesepakatan versi aset |
| `cmd/server/share_test.go` | Modify | "tepat 3 key" jadi 4 key |
| `web/dist/md.js` | Create | Renderer Markdown (`window.LiteMd` / `module.exports`) |
| `web/dist/md.css` | Create | Style render Markdown, dipakai app dan halaman share |
| `web/dist/index.html`, `web/dist/sw.js` | Modify | Muat dan precache `md.*`, versi 71 |
| `web/dist/app.js`, `web/dist/app.css` | Modify | Tipe note, View/Edit, tombol, sync payload, backup, attachment di View |
| `web/dist/share.html`, `share.js`, `share.css` | Modify | Halaman share merender note `md` |
| `web/e2e/md.test.mjs` | Create | Unit test renderer (Node, tanpa browser) |
| `web/e2e/markdown.test.mjs` | Create | E2E Markdown note |
| `README.md` | Modify | Dokumentasi |

---

### Task 1: Server menyimpan dan mengirim `format`

**Files:**
- Modify: `cmd/server/schema.sql`, `cmd/server/main.go`, `cmd/server/share.go`, `cmd/server/share_test.go`
- Create: `cmd/server/format_test.go`

**Interfaces:**
- Consumes: `newTestApp`, `a.mustUser`, `a.do`, `testUUID` (`main_test.go`); `decodeBody`, `shareToken`, `readShared` (`share_test.go`).
- Produces: field JSON `format` di `pull`, di hasil `push`, dan di `shared/read`; helper test `pushRaw`, `rawNote`, `pulledNote`, `auditRows`.

- [ ] **Step 1: Tulis test yang gagal**

```bash
cat > cmd/server/format_test.go <<'GOEOF'
package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

/* --------------------------------------------------------- test helpers */

// pushRaw sends one mutation exactly as given, so a test can leave `format` out the
// way a client from before the field existed does. It returns the push status and
// the note the server answered with.
func pushRaw(t *testing.T, a *application, u user, note map[string]any, mutationN int) (string, map[string]any) {
	t.Helper()
	body := map[string]any{"device_id": "dev", "mutations": []map[string]any{{"mutation_id": testUUID(mutationN), "note": note}}}
	w := a.do(t, u, "POST", "/api/v1/sync/push", body)
	if w.Code != 200 {
		t.Fatalf("push: status %d body %s", w.Code, w.Body.String())
	}
	var out struct {
		Results []struct {
			Status string         `json:"status"`
			Note   map[string]any `json:"note"`
		} `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || len(out.Results) != 1 {
		t.Fatalf("push response: %s (%v)", w.Body.String(), err)
	}
	return out.Results[0].Status, out.Results[0].Note
}

func rawNote(id string, updatedAt int64, title string, extra map[string]any) map[string]any {
	n := map[string]any{"id": id, "title": title, "content": "body", "created_at": 1000, "updated_at": updatedAt, "deleted_at": nil, "folder_id": "", "is_pinned": false}
	for k, v := range extra {
		n[k] = v
	}
	return n
}

func pulledNote(t *testing.T, a *application, u user, id string) map[string]any {
	t.Helper()
	w := a.do(t, u, "GET", "/api/v1/sync/pull?cursor=0&limit=500", nil)
	var out struct {
		Notes []map[string]any `json:"notes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("pull response: %s (%v)", w.Body.String(), err)
	}
	for _, n := range out.Notes {
		if n["id"] == id {
			return n
		}
	}
	t.Fatalf("note %s was not pulled", id)
	return nil
}

func auditRows(t *testing.T, a *application, userID, noteID string) int {
	t.Helper()
	var n int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM note_audit WHERE user_id=? AND note_id=?", userID, noteID).Scan(&n); err != nil {
		t.Fatalf("count note_audit: %v", err)
	}
	return n
}

/* ----------------------------------------------------------------- tests */

func TestPushStoresTheFormatAndPullReturnsIt(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-1", "format1@example.com")
	md, plain, unset := testUUID(501), testUUID(502), testUUID(503)
	pushRaw(t, a, u, rawNote(md, 2000, "m", map[string]any{"format": "md"}), 601)
	pushRaw(t, a, u, rawNote(plain, 2000, "p", map[string]any{"format": "text"}), 602)
	pushRaw(t, a, u, rawNote(unset, 2000, "u", nil), 603)
	for id, want := range map[string]string{md: "md", plain: "text", unset: "text"} {
		if got := pulledNote(t, a, u, id)["format"]; got != want {
			t.Errorf("note %s: format = %v, want %s", id, got, want)
		}
	}
}

// A client from before this field existed never sends it, and the upsert rewrites
// every column. Without the "empty means keep" rule its edit would turn a Markdown
// note back into a plain one without any error.
func TestPushWithoutFormatKeepsTheStoredFormat(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-2", "format2@example.com")
	id := testUUID(511)
	pushRaw(t, a, u, rawNote(id, 2000, "written as markdown", map[string]any{"format": "md"}), 611)

	status, answered := pushRaw(t, a, u, rawNote(id, 3000, "edited by an old client", nil), 612)
	if status != "applied" {
		t.Fatalf("push status = %s, want applied", status)
	}
	if answered["format"] != "md" {
		t.Errorf("the push response reports format %v, want md", answered["format"])
	}
	n := pulledNote(t, a, u, id)
	if n["format"] != "md" || n["title"] != "edited by an old client" {
		t.Fatalf("after the old client's edit: format=%v title=%v, want md and the new title", n["format"], n["title"])
	}
}

func TestPushRejectsAnUnknownFormat(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-3", "format3@example.com")
	for i, bad := range []string{"html", "MD", "Md", "markdown", " md", "md "} {
		id := testUUID(521 + i)
		body := map[string]any{"device_id": "dev", "mutations": []map[string]any{{"mutation_id": testUUID(621 + i), "note": rawNote(id, 2000, "n", map[string]any{"format": bad})}}}
		w := a.do(t, u, "POST", "/api/v1/sync/push", body)
		if w.Code != 400 {
			t.Errorf("format %q: status %d, want 400", bad, w.Code)
			continue
		}
		if code := decodeBody(t, w)["error"].(map[string]any)["code"]; code != "VALIDATION_ERROR" {
			t.Errorf("format %q: code %v, want VALIDATION_ERROR", bad, code)
		}
		var rows int
		if err := a.db.QueryRow("SELECT COUNT(*) FROM notes WHERE user_id=? AND id=?", u.ID, id).Scan(&rows); err != nil || rows != 0 {
			t.Errorf("format %q: a rejected push left %d rows (%v)", bad, rows, err)
		}
	}
}

func TestChangingOnlyTheFormatIsAChange(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-4", "format4@example.com")
	id := testUUID(531)
	pushRaw(t, a, u, rawNote(id, 2000, "same title", map[string]any{"format": "text"}), 631)
	before := pulledNote(t, a, u, id)["revision"].(float64)
	auditBefore := auditRows(t, a, u.ID, id)

	status, _ := pushRaw(t, a, u, rawNote(id, 3000, "same title", map[string]any{"format": "md"}), 632)
	if status != "applied" {
		t.Fatalf("a format-only change had status %s, want applied", status)
	}
	n := pulledNote(t, a, u, id)
	if n["format"] != "md" {
		t.Errorf("format = %v, want md", n["format"])
	}
	if n["revision"].(float64) <= before {
		t.Errorf("revision %v did not move past %v", n["revision"], before)
	}
	if got := auditRows(t, a, u.ID, id); got != auditBefore+1 {
		t.Errorf("audit rows = %d, want %d", got, auditBefore+1)
	}
}

func TestResendingAFormatChangeIsIdempotent(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-5", "format5@example.com")
	id := testUUID(541)
	pushRaw(t, a, u, rawNote(id, 2000, "n", map[string]any{"format": "text"}), 641)
	change := rawNote(id, 3000, "n", map[string]any{"format": "md"})
	if status, _ := pushRaw(t, a, u, change, 642); status != "applied" {
		t.Fatalf("first send: %s, want applied", status)
	}
	revision := pulledNote(t, a, u, id)["revision"]
	if status, _ := pushRaw(t, a, u, change, 642); status != "unchanged" {
		t.Fatalf("resend of the same mutation: %s, want unchanged", status)
	}
	if got := pulledNote(t, a, u, id)["revision"]; got != revision {
		t.Errorf("revision moved from %v to %v on a resend", revision, got)
	}
}

// Same timestamp and mutation id but a different format is not a duplicate of what
// is stored, so it must not be reported as "unchanged".
func TestSameStampWithADifferentFormatIsNotUnchanged(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-6", "format6@example.com")
	id := testUUID(551)
	pushRaw(t, a, u, rawNote(id, 3000, "n", map[string]any{"format": "md"}), 651)
	status, _ := pushRaw(t, a, u, rawNote(id, 3000, "n", map[string]any{"format": "text"}), 651)
	if status != "superseded" {
		t.Fatalf("status = %s, want superseded", status)
	}
	if got := pulledNote(t, a, u, id)["format"]; got != "md" {
		t.Errorf("stored format = %v, want md to stay", got)
	}
}

func TestSharedReadReturnsTheNoteFormat(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-format-7", "format7@example.com")
	id := testUUID(561)
	pushRaw(t, a, u, rawNote(id, 2000, "doc", map[string]any{"format": "md"}), 661)
	token := shareToken(t, a, u, id, map[string]any{})
	if got := decodeBody(t, readShared(t, a, token))["format"]; got != "md" {
		t.Fatalf("shared format = %v, want md", got)
	}
	pushRaw(t, a, u, rawNote(id, 3000, "doc", map[string]any{"format": "text"}), 662)
	if got := decodeBody(t, readShared(t, a, token))["format"]; got != "text" {
		t.Fatalf("shared format after converting back = %v, want text", got)
	}
}

func TestMigrateAddsFormatToExistingNotes(t *testing.T) {
	db, err := openDB(config{DatabaseURL: "file:" + filepath.Join(t.TempDir(), "old.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := migrate(db); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	// Turn it into a database from before the column existed, holding one note.
	if _, err := db.Exec("ALTER TABLE notes DROP COLUMN format"); err != nil {
		t.Fatalf("cannot simulate an old database: %v", err)
	}
	if _, err := db.Exec("INSERT INTO users(id,google_sub,email,created_at,updated_at) VALUES('u1','g1','old@example.com',1,1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO notes(user_id,id,title,content,folder_id,created_at,updated_at,mutation_id,revision,server_updated_at) VALUES('u1','n1','t','c','',1,1,'m',1,1)"); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("migrate on the old database: %v", err)
	}
	var format string
	if err := db.QueryRow("SELECT format FROM notes WHERE id='n1'").Scan(&format); err != nil || format != "text" {
		t.Fatalf("existing note format = %q (%v), want text", format, err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("migrate must stay idempotent: %v", err)
	}
}
GOEOF
shasum -a 256 cmd/server/format_test.go
```

Expected hash: `056b0b313738430e2d0f91db6c19d411e471f46465470cd3b7115c096a338fec`

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `go test ./cmd/server -run 'Format|SameStamp|Migrate' -count=1 2>&1 | head -20`
Expected: FAIL. `push` dengan field `format` ditolak 400 oleh `DisallowUnknownFields`, dan `DROP COLUMN format` gagal karena kolomnya belum ada.

- [ ] **Step 3: Terapkan patch server**

```bash
python3 - <<'PYEOF'
"""Task 1: add the `format` field to the server. Run from the repository root."""


def patch(path, edits):
    s = open(path).read()
    for old, new in edits:
        assert s.count(old) == 1, f"{path}: expected 1 occurrence, found {s.count(old)}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    open(path, "w").write(s)


# Schema: new databases get the column from CREATE TABLE, existing ones from the ALTER below.
patch("cmd/server/schema.sql", [
    ("is_pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,id)",
     "is_pinned INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT 'text', PRIMARY KEY(user_id,id)"),
])

patch("cmd/server/main.go", [
    # migrate(): existing databases
    ('		"ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",\n',
     '		"ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",\n'
     '		"ALTER TABLE notes ADD COLUMN format TEXT NOT NULL DEFAULT \'text\'",\n'),
    # structs
    ('	IsLocked        bool   `json:"is_locked"`\n	PasswordHash    string `json:"-"`',
     '	IsLocked        bool   `json:"is_locked"`\n	Format          string `json:"format"`\n	PasswordHash    string `json:"-"`'),
    ('	IsPinned  bool   `json:"is_pinned"`\n}\ntype folder struct',
     '	IsPinned  bool   `json:"is_pinned"`\n	Format    string `json:"format"`\n}\ntype folder struct'),
    # validation
    ('	if len([]rune(m.Note.Title)) > 500 {',
     '	if m.Note.Format != "" && m.Note.Format != "text" && m.Note.Format != "md" {\n'
     '		return reject("format harus text atau md")\n'
     '	}\n'
     '	if len([]rune(m.Note.Title)) > 500 {'),
    # candidate carries the format; an empty one is resolved before any comparison
    ('IsPinned: m.Note.IsPinned, CreatedAt: m.Note.CreatedAt,',
     'IsPinned: m.Note.IsPinned, Format: m.Note.Format, CreatedAt: m.Note.CreatedAt,'),
    ('		status := "applied"\n		if found && compare(candidate, current) <= 0 {',
     '		// An empty format means "keep what is stored": a client from before this field\n'
     '		// existed never sends it, and the upsert below overwrites every column.\n'
     '		if candidate.Format == "" {\n'
     '			candidate.Format = "text"\n'
     '			if found {\n'
     '				candidate.Format = current.Format\n'
     '			}\n'
     '		}\n'
     '		status := "applied"\n		if found && compare(candidate, current) <= 0 {'),
    # idempotent re-send and audit
    ('candidate.IsPinned == current.IsPinned && sameDeleted(',
     'candidate.IsPinned == current.IsPinned && candidate.Format == current.Format && sameDeleted('),
    ('current.IsPinned != candidate.IsPinned || !sameDeleted(',
     'current.IsPinned != candidate.IsPinned || current.Format != candidate.Format || !sameDeleted('),
    # upsert
    ('password_hash,is_pinned) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT',
     'password_hash,is_pinned,format) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT'),
    ('is_pinned=excluded.is_pinned`', 'is_pinned=excluded.is_pinned,format=excluded.format`'),
    ('candidate.PasswordHash, candidate.IsPinned)', 'candidate.PasswordHash, candidate.IsPinned, candidate.Format)'),
    # pull and getNote
    ('password_hash,is_pinned FROM notes WHERE user_id=? AND revision>?',
     'password_hash,is_pinned,format FROM notes WHERE user_id=? AND revision>?'),
    ('password_hash,is_pinned FROM notes WHERE user_id=? AND id=?',
     'password_hash,is_pinned,format FROM notes WHERE user_id=? AND id=?'),
])

# scanNote and getNote scan the same column list.
s = open("cmd/server/main.go").read()
old, new = "&n.PasswordHash, &n.IsPinned)", "&n.PasswordHash, &n.IsPinned, &n.Format)"
assert s.count(old) == 2, f"expected scanNote and getNote, found {s.count(old)}"
open("cmd/server/main.go", "w").write(s.replace(old, new))

# Public read returns the format so the share page knows how to render the note.
patch("cmd/server/share.go", [
    ("	var title, content string\n	var updatedAt int64\n	err := a.db.QueryRowContext(r.Context(),\n		`SELECT n.title, n.content, n.updated_at",
     "	var title, content, format string\n	var updatedAt int64\n	err := a.db.QueryRowContext(r.Context(),\n		`SELECT n.title, n.content, n.format, n.updated_at"),
    ("in.Token).Scan(&title, &content, &updatedAt)", "in.Token).Scan(&title, &content, &format, &updatedAt)"),
    ('	jsonOK(w, map[string]any{"title": title, "content": content, "updated_at": updatedAt})',
     '	jsonOK(w, map[string]any{"title": title, "content": content, "format": format, "updated_at": updatedAt})'),
])
print("task 1 server patch applied")
PYEOF
gofmt -w cmd/server/main.go cmd/server/share.go
git diff --stat cmd/server/main.go cmd/server/schema.sql cmd/server/share.go
```

Expected: tiga file berubah. `git diff cmd/server/main.go` harus hanya memuat baris `format` dan penyesuaian alignment `gofmt`.

- [ ] **Step 4: Perbarui test share yang menegaskan jumlah key**

`shared/read` sekarang mengirim empat key. Ganti pengecekan lama di `TestSharedReadReturnsTheLiveNoteWithoutASession`:

```bash
python3 - <<'PYEOF'
p = "cmd/server/share_test.go"
s = open(p).read()
old = """	if len(got) != 3 {
		t.Fatalf("payload has extra keys (must be exactly title, content, updated_at): %v", got)
	}"""
new = """	if got["format"] != "text" {
		t.Fatalf("format = %v, want text for a note that never set one", got["format"])
	}
	if len(got) != 4 {
		t.Fatalf("payload has unexpected keys (must be exactly title, content, format, updated_at): %v", got)
	}"""
assert s.count(old) == 1
open(p, "w").write(s.replace(old, new))
PYEOF
```

- [ ] **Step 5: Jalankan, pastikan lulus**

Run: `gofmt -l cmd/; go vet ./... && go test ./... -count=1 2>&1 | tail -5`
Expected: `gofmt -l` kosong, `ok  	litenotes/cmd/server`.

- [ ] **Step 6: Probe tiap guard**

```bash
probe() {  # probe <file> <old> <new> -- <test command...>
  local file="$1" old="$2" new="$3"; shift 4
  local backup; backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path).read()
assert s.count(old) == 1, f"{s.count(old)} occurrences of {old[:60]!r}"
open(path, "w").write(s.replace(old, new))
PYEOF
  "$@"
  cp "$backup" "$file"; rm "$backup"
}
t() { go test ./cmd/server -run 'Format|SameStamp|Migrate|SharedRead' -count=1 2>&1 | grep -E '^(--- FAIL|ok|FAIL\s)'; }
echo "-- 1 empty format is not kept";      probe cmd/server/main.go 'candidate.Format = current.Format' 'candidate.Format = ""' -- t
echo "-- 2 no validation";                 probe cmd/server/main.go 'if m.Note.Format != "" && m.Note.Format != "text" && m.Note.Format != "md" {' 'if false {' -- t
echo "-- 3 format missing from audit";     probe cmd/server/main.go 'current.IsPinned != candidate.IsPinned || current.Format != candidate.Format || !sameDeleted(' 'current.IsPinned != candidate.IsPinned || !sameDeleted(' -- t
echo "-- 4 format missing from unchanged"; probe cmd/server/main.go 'candidate.IsPinned == current.IsPinned && candidate.Format == current.Format && sameDeleted(' 'candidate.IsPinned == current.IsPinned && sameDeleted(' -- t
echo "-- 5 upsert drops format";           probe cmd/server/main.go 'is_pinned=excluded.is_pinned,format=excluded.format' 'is_pinned=excluded.is_pinned' -- t
echo "-- 6 migration skips the column";    probe cmd/server/main.go "ALTER TABLE notes ADD COLUMN format TEXT NOT NULL DEFAULT 'text'" 'SELECT 1' -- t
go test ./cmd/server -count=1 2>&1 | tail -1
```

Expected: setiap probe mencetak `--- FAIL` (probe 1: `TestPushWithoutFormatKeepsTheStoredFormat`; 2: `TestPushRejectsAnUnknownFormat`; 3: `TestChangingOnlyTheFormatIsAChange`; 4: `TestSameStampWithADifferentFormatIsNotUnchanged`; 5: `TestChangingOnlyTheFormatIsAChange`, `TestResendingAFormatChangeIsIdempotent`, `TestSharedReadReturnsTheNoteFormat`; 6: `TestMigrateAddsFormatToExistingNotes`). Baris terakhir harus `ok`, memastikan semua file sudah kembali.

- [ ] **Step 7: Checkpoint (TANPA commit)**

Run: `gofmt -l cmd/; go build ./... && go vet ./... && git status --short`
Expected: bersih; `M cmd/server/main.go`, `M cmd/server/schema.sql`, `M cmd/server/share.go`, `M cmd/server/share_test.go`, `?? cmd/server/format_test.go`.

---

### Task 2: Renderer `md.js` dengan unit test

**Files:**
- Create: `web/dist/md.js`, `web/e2e/md.test.mjs`

**Interfaces:**
- Produces: `LiteMd.render(source, { attachment(name, id) }) → string`, `LiteMd.MAX_BYTES`, `LiteMd.MAX_DEPTH`. Dipakai Task 3, 4, 6.

- [ ] **Step 1: Tulis unit test yang gagal**

```bash
cat > web/e2e/md.test.mjs <<'MJSEOF'
// Unit tests for the Markdown renderer. Pure Node, no browser: md.js is a classic
// script with a UMD wrapper, so it can be required directly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const MD_PATH = process.env.MD_PATH || '../dist/md.js';
const require = createRequire(import.meta.url);
const LiteMd = require(MD_PATH);
const { render, MAX_BYTES } = LiteMd;

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('exports render and the size limit, as a module and as a browser global', () => {
  assert.equal(typeof render, 'function');
  assert.equal(MAX_BYTES, 512 * 1024);
  const sandbox = {};
  sandbox.self = sandbox;
  vm.runInNewContext(readFileSync(new URL(MD_PATH, import.meta.url), 'utf8'), sandbox);
  assert.equal(typeof sandbox.LiteMd.render, 'function');
  assert.equal(sandbox.LiteMd.render('**x**'), '<p><strong>x</strong></p>');
});

/* ------------------------------------------------------------ golden output */

const GOLDEN = [
  ['empty input', '', ''],
  ['whitespace only', '  \n\t\n', ''],
  ['null and undefined', null, ''],
  ['headings', '# A\n## B ##\n###### F\n####### seven', '<h1>A</h1><h2>B</h2><h6>F</h6><p>####### seven</p>'],
  ['heading needs a space', '#nospace', '<p>#nospace</p>'],
  ['soft wrapped paragraph', 'one\ntwo', '<p>one\ntwo</p>'],
  ['two paragraphs', 'one\n\ntwo', '<p>one</p><p>two</p>'],
  ['hard break with two spaces', 'a  \nb', '<p>a<br>\nb</p>'],
  ['hard break with backslash', 'a\\\nb', '<p>a<br>b</p>'],
  ['windows line endings', 'a\r\nb\r\n\r\nc', '<p>a\nb</p><p>c</p>'],
  ['emphasis', '**b** __b__ *i* _i_ ~~s~~', '<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <s>s</s></p>'],
  ['bold italic', '***both***', '<p><em><strong>both</strong></em></p>'],
  ['nested emphasis', '**bold *and italic* text**', '<p><strong>bold <em>and italic</em> text</strong></p>'],
  ['snake_case stays text', 'snake_case_name and __init__.py', '<p>snake_case_name and <strong>init</strong>.py</p>'],
  ['spaced stars stay text', 'a * b * c', '<p>a * b * c</p>'],
  ['intraword star emphasis', '2*3*4', '<p>2<em>3</em>4</p>'],
  ['inline code', 'use `a < b` here', '<p>use <code>a &lt; b</code> here</p>'],
  ['code with backtick inside', '``a ` b``', '<p><code>a ` b</code></p>'],
  ['markers inside code stay', '`**x** _y_`', '<p><code>**x** _y_</code></p>'],
  ['unmatched backtick', 'a ` b', '<p>a ` b</p>'],
  ['backslash escapes', '\\*not em\\* and \\# and \\`x\\`', '<p>*not em* and # and `x`</p>'],
  ['hr variants', '---\n\n***\n\n* * *\n\n___', '<hr><hr><hr><hr>'],
  ['two dashes is text', '--', '<p>--</p>'],
  ['link', '[go](https://a.com/x?y=1&z=2 "t")', '<p><a href="https://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">go</a></p>'],
  ['link text keeps emphasis and code', '[**b** `c`](https://a.com)', '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer"><strong>b</strong> <code>c</code></a></p>'],
  ['angle autolink', '<https://a.com/p>', '<p><a href="https://a.com/p" target="_blank" rel="noopener noreferrer">https://a.com/p</a></p>'],
  ['bare url drops trailing punctuation', 'Visit https://a.com/x.', '<p>Visit <a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a>.</p>'],
  ['bare url in parentheses', '(see https://a.com/x)', '<p>(see <a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a>)</p>'],
  ['bare url keeps balanced parentheses', 'https://en.wikipedia.org/wiki/Foo_(bar)', '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">https://en.wikipedia.org/wiki/Foo_(bar)</a></p>'],
  ['bare url with underscores is not emphasis', 'https://a.com/a_b_c', '<p><a href="https://a.com/a_b_c" target="_blank" rel="noopener noreferrer">https://a.com/a_b_c</a></p>'],
  ['bare url inside brackets', '[https://a.com]', '<p>[<a href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a>]</p>'],
  ['remote image becomes a label', '![the logo](https://t.com/p.png)', '<p><span class="md-image-label">[Image: the logo]</span></p>'],
  ['bullet list', '- a\n- b\n* c', '<ul><li>a</li><li>b</li><li>c</li></ul>'],
  ['ordered list keeps its start', '3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['ordered list from one has no start', '1) a\n2) b', '<ol><li>a</li><li>b</li></ol>'],
  ['blank lines between items stay one list', '1. a\n\n2. b\n\n3. c', '<ol><li>a</li><li>b</li><li>c</li></ol>'],
  ['nested list, three levels', '- a\n  - b\n    - c\n- d', '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'],
  ['nested list under ordered, 4 spaces', '1. a\n    - b\n2. c', '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>'],
  ['nested list under ordered, 2 spaces', '1. a\n  - b\n2. c', '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>'],
  ['tab indented nested list', '- a\n\t- b', '<ul><li>a<ul><li>b</li></ul></li></ul>'],
  ['bullet then ordered are two lists', '- a\n1. b', '<ul><li>a</li></ul><ol><li>b</li></ol>'],
  ['lazy continuation', '- a\ncontinued', '<ul><li>a\ncontinued</li></ul>'],
  ['two paragraphs in one item', '- a\n\n  b', '<ul><li><p>a</p><p>b</p></li></ul>'],
  ['fenced code inside an item', '- run:\n  ```sh\n  ls -l\n  ```\n- next', '<ul><li>run:<pre class="md-code"><span class="md-code-language">sh</span><code>ls -l</code></pre></li><li>next</li></ul>'],
  ['list interrupts a paragraph', 'Steps:\n1. one\n2. two', '<p>Steps:</p><ol><li>one</li><li>two</li></ol>'],
  ['a year at line start is not a list', 'text\n2024. was a year', '<p>text\n2024. was a year</p>'],
  ['task list', '- [ ] todo\n- [x] done\n- [X] also', '<ul class="md-task-list"><li class="md-task"><input type="checkbox" disabled> todo</li><li class="md-task"><input type="checkbox" disabled checked> done</li><li class="md-task"><input type="checkbox" disabled checked> also</li></ul>'],
  ['blockquote', '> a\n> b', '<blockquote><p>a\nb</p></blockquote>'],
  ['nested blockquote', '> a\n> > b', '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>'],
  ['blockquote with list', '> - a\n> - b', '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>'],
  ['fenced code keeps markers and escapes html', '```js\nlet a = <b>**x**;\n```', '<pre class="md-code"><span class="md-code-language">js</span><code>let a = &lt;b&gt;**x**;</code></pre>'],
  ['tilde fence', '~~~\nx\n~~~', '<pre class="md-code"><code>x</code></pre>'],
  ['closing fence may be longer', '```\nx\n`````', '<pre class="md-code"><code>x</code></pre>'],
  ['unclosed fence runs to the end', '```\ncode\nmore', '<pre class="md-code"><code>code\nmore</code></pre>'],
  ['fence language is sanitized', '```js title="x"\n1\n```', '<pre class="md-code"><span class="md-code-language">js</span><code>1</code></pre>'],
  ['table with alignment and an escaped pipe', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| x \\| y | **z** | 4 |',
    '<div class="md-table-wrap"><table><thead><tr><th class="md-al-left">a</th><th class="md-al-center">b</th><th class="md-al-right">c</th></tr></thead><tbody><tr><td class="md-al-left">1</td><td class="md-al-center">2</td><td class="md-al-right">3</td></tr><tr><td class="md-al-left">x | y</td><td class="md-al-center"><strong>z</strong></td><td class="md-al-right">4</td></tr></tbody></table></div>'],
  ['table without outer pipes', 'a | b\n--|--\n1 | 2', '<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>'],
  ['table pads short rows and drops extra cells', '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |', '<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>'],
  ['header and delimiter must have the same width', '| a | b |\n|---|', '<p>| a | b |\n|---|</p>'],
  ['table ends at a blank line', '| a |\n|---|\n| 1 |\n\nafter', '<div class="md-table-wrap"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div><p>after</p>'],
  ['raw html is shown as text', '<div onclick="x">hi</div>', '<p>&lt;div onclick=&quot;x&quot;&gt;hi&lt;/div&gt;</p>'],
  ['attachment line without a callback is a label', `![a.pdf](attach:${ID})`, '<div class="md-attach"><span class="md-attach-label">a.pdf</span></div>'],
  ['attachment inside a sentence is an image label', `see ![x](attach:${ID}) here`, '<p>see <span class="md-image-label">[Image: x]</span> here</p>'],
];

for (const [name, input, expected] of GOLDEN) {
  test(`renders: ${name}`, () => {
    assert.equal(render(input), expected);
  });
}

test('the attachment callback receives the name and id of a standalone attachment line', () => {
  const calls = [];
  const html = render(`before\n![report.pdf](attach:${ID})\nafter\n\n![remote](https://t.com/a.png)`, {
    attachment: (name, id) => { calls.push([name, id]); return `<b>${name}</b>`; },
  });
  assert.deepEqual(calls, [['report.pdf', ID]]);
  assert.equal(html, '<p>before</p><div class="md-attach"><b>report.pdf</b></div><p>after</p><p><span class="md-image-label">[Image: remote]</span></p>');
});

test('private-use characters in a note cannot reach the placeholder store', () => {
  const open = String.fromCharCode(0xE000);
  const close = String.fromCharCode(0xE001);
  const hard = String.fromCharCode(0xE003);
  const replacement = String.fromCharCode(0xFFFD);
  assert.equal(render(`x${open}0${close}y${hard}`), `<p>x${replacement}0${replacement}y${replacement}</p>`);
});

test('nesting deeper than the limit is shown as text instead of recursing', () => {
  const html = render('> '.repeat(40) + 'deep');
  assert.match(html, /deep/);
  assert.match(html, /&gt;/);
  assert.equal((html.match(/<blockquote>/g) || []).length, LiteMd.MAX_DEPTH);
});

/* ---------------------------------------------------------------- safety */

const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'a', 'input']);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'class', 'type', 'disabled', 'checked', 'start']);

// A real parse of the tags: every tag and attribute must be one the renderer is
// known to emit, every href must be http(s), and no stray angle bracket may remain.
function assertSafe(html, label) {
  const tagRe = /<(\/?)([a-zA-Z0-9]+)([^<>]*)>/g;
  for (const m of html.matchAll(tagRe)) {
    assert.ok(ALLOWED_TAGS.has(m[2].toLowerCase()), `${label}: unexpected tag <${m[2]}> in ${html}`);
    for (const a of m[3].matchAll(/\s+([^\s=]+)(?:="([^"]*)")?/g)) {
      assert.ok(ALLOWED_ATTRS.has(a[1]), `${label}: unexpected attribute ${a[1]} in ${html}`);
      if (a[1] === 'href') assert.match(a[2], /^https?:\/\/[^\s<>"]+$/i, `${label}: unsafe href ${a[2]}`);
    }
    assert.equal(m[3].replace(/\s+[^\s=]+(?:="[^"]*")?/g, '').trim(), '', `${label}: malformed tag ${m[0]}`);
  }
  assert.ok(!/[<>]/.test(html.replace(tagRe, '')), `${label}: raw angle bracket left in text: ${html}`);
}

const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x]( javascript:alert(1))',
  '[x](java&#9;script:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](//evil.example/path)',
  '[x](/relative)',
  '[x](mailto:a@b.c)',
  '[x](https://a.com" onmouseover="alert(1))',
  '[x](https://a.com "title" onmouseover="alert(1)")',
  '<https://a.com" onmouseover="alert(1)>',
  '<javascript:alert(1)>',
  'https://a.com/"onmouseover="alert(1)',
  '![x](javascript:alert(1))',
  '![<img src=x onerror=alert(1)>](https://a.com/p.png)',
  '[<img src=x onerror=alert(1)>](https://a.com)',
  '[x](https://a.com "<script>alert(1)</script>")',
  '`<script>alert(1)</script>`',
  '```\n<script>alert(1)</script>\n```',
  '```"><script>alert(1)</script>\n```',
  '# <script>alert(1)</script>',
  '| <script> | b |\n|---|---|\n| <img onerror=1> | 2 |',
  '> <script>alert(1)</script>',
  '- <script>alert(1)</script>',
  '- [ ] <script>alert(1)</script>',
  '\\<script>alert(1)</script>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  `![<img src=x onerror=alert(1)>](attach:${ID})`,
  '**<img src=x onerror=alert(1)>**',
  '_<script>_',
];

test('hostile input never produces an unexpected tag, attribute or href', () => {
  for (const input of XSS) assertSafe(render(input), JSON.stringify(input));
});

test('only http and https text becomes a link', () => {
  const nonLinks = [
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,hi)', '[x](vbscript:x)',
    '[x](//evil.example)', '[x](/relative)', '[x](mailto:a@b.c)', '[x](java&#9;script:alert(1))',
  ];
  for (const input of nonLinks) assert.ok(!render(input).includes('<a '), `${input} became a link`);
  for (const ok of ['[x](https://a.com)', '[x](HTTP://A.COM)', '<https://a.com>', 'https://a.com']) {
    assert.match(render(ok), /<a href="https?:\/\/[^"]+" target="_blank" rel="noopener noreferrer">/i, ok);
  }
});

/* ------------------------------------------------------------ performance */

function line(n, unit) { return unit.repeat(n); }

const HOSTILE = {
  'open brackets': line(200000, '['),
  'stars': line(200000, '*'),
  'underscores': line(200000, '_'),
  'tildes': line(200000, '~'),
  'backticks': line(200000, '`'),
  'backtick runs of unique lengths': Array.from({ length: 900 }, (_, i) => '`'.repeat(i + 1) + ' ').join(''),
  'pipes': line(100000, '|'),
  'pipe cells': line(60000, '| a '),
  'table of many columns': `${line(20000, '|a')}\n${line(20000, '|-')}\n${line(20000, '|b')}`,
  'unclosed link destinations': line(80000, '[a](b'),
  'unclosed image destinations': line(70000, '![a](b'),
  'angle brackets': line(200000, '<'),
  'bare url starts': line(60000, 'http://'),
  'unmatched bold': line(100000, '**a '),
  'unmatched italics': line(150000, '*a'),
  'unmatched underscores': line(150000, '_a'),
  'backslashes': line(200000, '\\'),
  'only spaces': line(500000, ' '),
  'spaces then text': `# a${line(300000, ' ')}b`,
  'hr lookalike': `${line(100000, '- ')}x`,
  'deep quotes': `${line(5000, '>')} x`,
  'deep list indentation': Array.from({ length: 600 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'),
  'many list items': line(100000, '- a\n'),
  'many blank lines in a list': `- a\n${line(200000, '\n')}  b`,
  'many fences': line(60000, '```\n'),
  'many headings': line(60000, '# h\n'),
  'many table rows': `| a |\n|---|\n${line(60000, '| x |\n')}`,
  'long single line': line(100000, 'word '),
  'nested brackets': `${line(60000, '[')}${line(60000, ']')}(https://a.com)`,
};

for (const [name, input] of Object.entries(HOSTILE)) {
  test(`stays fast on ${name}`, () => {
    assert.ok(Buffer.byteLength(input) <= MAX_BYTES, `${name} fixture is over the size limit and would not exercise the parser`);
    const started = performance.now();
    const html = render(input);
    const ms = performance.now() - started;
    assert.equal(typeof html, 'string');
    assert.ok(ms < 1000, `${name} took ${Math.round(ms)}ms`);
  });
}

/* ---------------------------------------------------------- size limit */

test('input at the limit is rendered, one byte over falls back to plain text', () => {
  const atLimit = 'a'.repeat(MAX_BYTES);
  assert.ok(render(atLimit).startsWith('<p>aaa'));
  const over = render(`${atLimit}b`);
  assert.match(over, /^<p class="md-notice">/);
  assert.match(over, /<pre class="md-plain">a+b<\/pre>$/);
});

test('the limit counts UTF-8 bytes, not characters', () => {
  assert.ok(render('é'.repeat(MAX_BYTES / 2)).startsWith('<p>'));
  assert.match(render('é'.repeat(MAX_BYTES / 2 + 1)), /^<p class="md-notice">/);
});

test('the plain text fallback is escaped', () => {
  const html = render(`<script>x</script>${'a'.repeat(MAX_BYTES)}`);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
});
MJSEOF
shasum -a 256 web/e2e/md.test.mjs
```

Expected hash: `148bd399c4ab5e473f204f7f81f2569b28a6ba061b77b81c94a66eb20fb853d1`

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `(cd web/e2e && node --test md.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)|Cannot find')`
Expected: gagal dengan `Cannot find module '../dist/md.js'`.

- [ ] **Step 3: Buat renderer**

```bash
cat > web/dist/md.js <<'JSEOF'
// LiteMd: a small, safe Markdown renderer (GFM subset) shared by the app and the
// public share page. Every piece of text from a note is escaped before any markup
// is added, and the only URLs that become links use http or https.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiteMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_BYTES = 512 * 1024;
  const MAX_DEPTH = 20;
  const MAX_URL = 2048;
  const NOTICE = 'This note is too large to render as Markdown. Showing plain text instead.';

  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const byteLength = (s) => (encoder ? encoder.encode(s).length : s.length * 3);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // Four private-use characters carry placeholders and hard line breaks through the
  // inline passes. They are built from char codes so the source stays readable, and
  // render() replaces any that appear in a note before parsing starts.
  const OPEN = String.fromCharCode(0xE000);
  const CLOSE = String.fromCharCode(0xE001);
  const BREAK = String.fromCharCode(0xE003);
  const REPLACEMENT = String.fromCharCode(0xFFFD);
  const PRIVATE = new RegExp('[' + OPEN + '-' + BREAK + ']', 'g');
  const PLACEHOLDER = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');
  const BREAK_ALL = new RegExp(BREAK, 'g');
  const BARE_URL = new RegExp('https?://[^\\s<>"\'' + OPEN + '-' + BREAK + ']+', 'iy');
  const AUTOLINK = /<(https?:\/\/[^\s<>"]+)>/iy;
  const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
  const WORD = /[A-Za-z0-9_]/;

  const ATTACH = /^ {0,3}!\[([^\]]*)\]\(attach:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)[ \t]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
  const FENCE = /^( {0,3})(`{3,}|~{3,})/;
  const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  const QUOTE = /^ {0,3}>/;
  const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
  const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
  const DELIM_CELL = /^:?-+:?$/;

  /* ------------------------------------------------------------------ inline */

  function makeStore() {
    const items = [];
    return {
      put(html) {
        items.push(html);
        return OPEN + (items.length - 1) + CLOSE;
      },
      restore(s) {
        return s.replace(PLACEHOLDER, (_, i) => items[Number(i)]).replace(BREAK_ALL, '<br>');
      },
    };
  }

  // Code spans and backslash escapes become placeholders first, so nothing inside
  // them is ever read as Markdown. Backtick runs are indexed once, which keeps the
  // search for a matching run linear however many unmatched runs there are.
  function protect(text, store) {
    const runs = [];
    for (let i = 0; i < text.length;) {
      if (text.charCodeAt(i) === 96) {
        let j = i;
        while (j < text.length && text.charCodeAt(j) === 96) j++;
        runs.push({ start: i, len: j - i });
        i = j;
      } else i++;
    }
    if (!runs.length && text.indexOf('\\') === -1) return text;
    const nextSame = new Array(runs.length).fill(-1);
    const seen = new Map();
    for (let k = runs.length - 1; k >= 0; k--) {
      nextSame[k] = seen.has(runs[k].len) ? seen.get(runs[k].len) : -1;
      seen.set(runs[k].len, k);
    }
    let out = '';
    let i = 0;
    let k = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '\n') { out += BREAK; i += 2; continue; }
        if (ASCII_PUNCT.test(next)) { out += store.put(esc(next)); i += 2; continue; }
      }
      if (ch === '`') {
        while (k < runs.length && runs[k].start < i) k++;
        const open = runs[k];
        const match = nextSame[k];
        if (match !== -1) {
          const close = runs[match];
          let code = text.slice(open.start + open.len, close.start).replace(/\n/g, ' ');
          if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
          out += store.put('<code>' + esc(code) + '</code>');
          i = close.start + close.len;
        } else {
          out += text.slice(open.start, open.start + open.len);
          i = open.start + open.len;
        }
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // Applied to text that is already escaped, so the only tags that can appear are
  // the ones inserted here. Bold may contain a lone star or underscore (italic
  // inside bold); the alternation is deterministic, so each attempt stays linear.
  function emphasis(s) {
    return s
      .replace(/\*\*(?=[^\s*])((?:[^*\n]|\*(?!\*))*?[^\s*])\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^A-Za-z0-9_])__(?=[^\s_])((?:[^_\n]|_(?!_))*?[^\s_])__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>')
      .replace(/(?<![*\\])\*(?=[^\s*])([^*\n]*[^\s*])\*(?!\*)/g, '<em>$1</em>')
      .replace(/(^|[^A-Za-z0-9_])_(?=[^\s_])([^_\n]*[^\s_])_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
      .replace(/~~(?=[^\s~])([^~\n]*[^\s~])~~/g, '<s>$1</s>');
  }

  const isHttpUrl = (url) => /^https?:\/\/[^\s<>"]+$/i.test(url);
  const anchor = (url, innerHtml) => '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + innerHtml + '</a>';

  // Reads "(destination "optional title")" starting at the "(". Returns null for
  // anything that is not a plain, bounded destination.
  function parseDestination(text, open) {
    let i = open + 1;
    while (text[i] === ' ' || text[i] === '\t') i++;
    const begin = i;
    let depth = 0;
    for (; i < text.length && i - begin <= MAX_URL; i++) {
      const c = text[i];
      if (c === '(') { if (++depth > 32) return null; continue; }
      if (c === ')') { if (depth === 0) break; depth--; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '[' || c === '<') break;
    }
    const url = text.slice(begin, i);
    if (!url || i - begin > MAX_URL) return null;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const stop = text.indexOf(quote, i + 1);
      if (stop === -1 || stop - i > 512) return null;
      i = stop + 1;
      while (text[i] === ' ' || text[i] === '\t') i++;
    }
    if (text[i] !== ')') return null;
    return { url, end: i + 1 };
  }

  // Links, images and autolinks. Matching brackets are paired in one pass; link
  // text only gets emphasis (no nested links), so recursion never goes deeper.
  function links(text, store) {
    if (!/[[<]|https?:/i.test(text)) return text;
    const close = new Map();
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') stack.push(i);
      else if (text[i] === ']' && stack.length) close.set(stack.pop(), i);
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      const image = ch === '!' && text[i + 1] === '[';
      if (ch === '[' || image) {
        const open = image ? i + 1 : i;
        const end = close.get(open);
        if (end !== undefined && text[end + 1] === '(') {
          const dest = parseDestination(text, end + 1);
          if (dest) {
            const label = text.slice(open + 1, end);
            if (image) {
              out += store.put('<span class="md-image-label">[Image: ' + esc(label) + ']</span>');
              i = dest.end;
              continue;
            }
            if (isHttpUrl(dest.url)) {
              out += store.put(anchor(dest.url, store.restore(emphasis(esc(label)))));
              i = dest.end;
              continue;
            }
          }
        }
        out += ch;
        i++;
        continue;
      }
      if (ch === '<') {
        AUTOLINK.lastIndex = i;
        const m = AUTOLINK.exec(text);
        if (m) {
          out += store.put(anchor(m[1], esc(m[1])));
          i += m[0].length;
          continue;
        }
      }
      if ((ch === 'h' || ch === 'H') && (i === 0 || !WORD.test(text[i - 1]))) {
        BARE_URL.lastIndex = i;
        const m = BARE_URL.exec(text);
        if (m) {
          let url = m[0];
          for (;;) {
            const last = url[url.length - 1];
            const unbalanced = last === ')' && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length;
            if (/[.,;:!?*_~\]]/.test(last) || unbalanced) url = url.slice(0, -1);
            else break;
          }
          if (isHttpUrl(url)) {
            out += store.put(anchor(url, esc(url)));
            i += url.length;
            continue;
          }
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  function inline(raw) {
    const store = makeStore();
    let text = protect(String(raw), store);
    text = links(text, store);
    return store.restore(emphasis(esc(text)));
  }

  /* ------------------------------------------------------------------ blocks */

  const isBlank = (line) => line.trim() === '';

  function expandIndent(line) {
    const m = /^[ \t]+/.exec(line);
    return m && m[0].indexOf('\t') !== -1 ? m[0].replace(/\t/g, '    ') + line.slice(m[0].length) : line;
  }

  function indentOf(line) {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
  }

  function isHr(line) {
    if (indentOf(line) > 3) return false;
    const mark = line.trim()[0];
    if (mark !== '-' && mark !== '*' && mark !== '_') return false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === mark) count++;
      else if (c !== ' ' && c !== '\t') return false;
    }
    return count >= 3;
  }

  function stripClosingHashes(s) {
    let i = s.length;
    while (i > 0 && s[i - 1] === '#') i--;
    if (i === s.length) return s;
    if (i === 0) return '';
    return s[i - 1] === ' ' || s[i - 1] === '\t' ? s.slice(0, i).trimEnd() : s;
  }

  function fenceOpen(line) {
    const m = FENCE.exec(line);
    if (!m) return null;
    const info = line.slice(m[0].length).trim();
    if (m[2][0] === '`' && info.indexOf('`') !== -1) return null;
    return { indent: m[1].length, char: m[2][0], len: m[2].length, lang: info.split(/\s/)[0].replace(/[^A-Za-z0-9_+.#-]/g, '').slice(0, 30) };
  }

  function listMarker(line) {
    const m = LIST.exec(line);
    if (!m) return null;
    return { indent: m[1].length, marker: m[2], ordered: m[2][0] >= '0' && m[2][0] <= '9', rest: line.slice(m[0].length) };
  }

  function canInterruptParagraph(line) {
    const m = listMarker(line);
    if (!m || m.rest.trim() === '') return false;
    return !m.ordered || parseInt(m.marker, 10) === 1;
  }

  function startsBlock(line) {
    return fenceOpen(line) !== null || HEADING.test(line) || isHr(line) || QUOTE.test(line) || ATTACH.test(line);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s[0] === '|') s = s.slice(1);
    const cells = [];
    let cell = '';
    let closed = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cell += '\\|'; i++; continue; }
      if (c === '|') { cells.push(cell.trim()); cell = ''; closed = true; continue; }
      cell += c;
      closed = false;
    }
    if (!closed || cell.trim() !== '') cells.push(cell.trim());
    return cells;
  }

  function delimiterRow(line) {
    if (line.indexOf('-') === -1) return null;
    const cells = splitRow(line);
    if (!cells.length) return null;
    const aligns = [];
    for (const cell of cells) {
      if (!DELIM_CELL.test(cell)) return null;
      const left = cell[0] === ':';
      const right = cell[cell.length - 1] === ':';
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
    }
    return aligns;
  }

  function tableAt(lines, i) {
    if (i + 1 >= lines.length || lines[i].indexOf('|') === -1) return null;
    const header = splitRow(lines[i]);
    const aligns = delimiterRow(expandIndent(lines[i + 1]));
    return aligns && aligns.length === header.length ? { header, aligns } : null;
  }

  function renderTable(lines, i, t) {
    const cellHtml = (tag, text, align) => '<' + tag + (align ? ' class="md-al-' + align + '"' : '') + '>' + inline(text) + '</' + tag + '>';
    let html = '<div class="md-table-wrap"><table><thead><tr>' + t.header.map((c, k) => cellHtml('th', c, t.aligns[k])).join('') + '</tr></thead><tbody>';
    let j = i + 2;
    while (j < lines.length) {
      const line = expandIndent(lines[j]);
      if (isBlank(line) || startsBlock(line)) break;
      const row = splitRow(line);
      html += '<tr>' + t.header.map((_, k) => cellHtml('td', row[k] || '', t.aligns[k])).join('') + '</tr>';
      j++;
    }
    return { html: html + '</tbody></table></div>', next: j };
  }

  function renderItemBlocks(blocks) {
    const paragraphs = blocks.filter((b) => b.t === 'p').length;
    return blocks.map((b, k) => (b.t === 'p' ? (paragraphs === 1 && k === 0 ? b.inner : '<p>' + b.inner + '</p>') : b.html)).join('');
  }

  function parseList(lines, start, depth, opts) {
    const first = listMarker(expandIndent(lines[start]));
    const ordered = first.ordered;
    const base = first.indent;
    const startNumber = ordered ? parseInt(first.marker, 10) : 1;
    const items = [];
    let anyTask = false;
    let i = start;

    while (i < lines.length) {
      const head = listMarker(expandIndent(lines[i]));
      if (!head || head.indent - base >= 2 || head.ordered !== ordered) break;
      const body = [{ text: head.rest, lazy: false }];
      i++;
      let ended = false;
      while (i < lines.length && !ended) {
        const line = expandIndent(lines[i]);
        if (isBlank(line)) {
          let k = i + 1;
          while (k < lines.length && isBlank(lines[k])) k++;
          if (k >= lines.length) { i = k; ended = true; break; }
          const next = expandIndent(lines[k]);
          if (indentOf(next) - base >= 2) {
            for (let b = i; b < k; b++) body.push({ text: '', lazy: false });
            i = k;
            continue;
          }
          const sibling = listMarker(next);
          if (sibling && sibling.indent - base < 2 && sibling.ordered === ordered) { i = k; break; }
          ended = true;
          break;
        }
        if (indentOf(line) - base >= 2) { body.push({ text: line, lazy: false }); i++; continue; }
        if (listMarker(line)) break;
        if (!startsBlock(line)) { body.push({ text: line.trim(), lazy: true }); i++; continue; }
        break;
      }
      const indented = body.slice(1).filter((b) => !b.lazy && b.text !== '').map((b) => indentOf(b.text));
      const strip = indented.length ? Math.min(...indented) : 0;
      const bodyLines = body.map((b, k) => (k === 0 || b.lazy ? b.text : b.text.slice(Math.min(strip, indentOf(b.text)))));
      let checked = null;
      const task = TASK.exec(bodyLines[0]);
      if (task) {
        checked = task[1] !== ' ';
        bodyLines[0] = bodyLines[0].slice(task[0].length);
        anyTask = true;
      }
      const inner = renderItemBlocks(parseBlocks(bodyLines, depth + 1, opts));
      items.push(checked === null ? '<li>' + inner + '</li>' : '<li class="md-task"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' + inner + '</li>');
      if (ended) break;
    }

    const tag = ordered ? 'ol' : 'ul';
    const attrs = (ordered && startNumber !== 1 ? ' start="' + startNumber + '"' : '') + (anyTask ? ' class="md-task-list"' : '');
    return { html: '<' + tag + attrs + '>' + items.join('') + '</' + tag + '>', next: i };
  }

  function defaultAttachment(name) {
    return '<span class="md-attach-label">' + esc(name) + '</span>';
  }

  // Returns blocks as { t: 'p', inner } for paragraphs and { t: 'x', html } for the
  // rest, so a list item can show a lone paragraph without the <p> wrapper.
  function parseBlocks(lines, depth, opts) {
    if (depth >= MAX_DEPTH) return [{ t: 'x', html: '<p>' + esc(lines.join('\n')) + '</p>' }];
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = expandIndent(lines[i]);
      if (isBlank(line)) { i++; continue; }

      const attach = ATTACH.exec(line);
      if (attach) {
        const render = opts && typeof opts.attachment === 'function' ? opts.attachment : defaultAttachment;
        out.push({ t: 'x', html: '<div class="md-attach">' + render(attach[1], attach[2]) + '</div>' });
        i++;
        continue;
      }

      const fence = fenceOpen(line);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length) {
          const l = expandIndent(lines[i]);
          const close = FENCE_CLOSE.exec(l);
          if (close && close[1][0] === fence.char && close[1].length >= fence.len) { i++; break; }
          code.push(l.slice(Math.min(fence.indent, indentOf(l))));
          i++;
        }
        const lang = fence.lang ? '<span class="md-code-language">' + esc(fence.lang) + '</span>' : '';
        out.push({ t: 'x', html: '<pre class="md-code">' + lang + '<code>' + esc(code.join('\n')) + '</code></pre>' });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push({ t: 'x', html: '<h' + level + '>' + inline(stripClosingHashes(line.slice(heading[0].length).trim())) + '</h' + level + '>' });
        i++;
        continue;
      }

      if (isHr(line)) { out.push({ t: 'x', html: '<hr>' }); i++; continue; }

      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(expandIndent(lines[i]))) {
          inner.push(expandIndent(lines[i]).replace(/^ {0,3}> ?/, ''));
          i++;
        }
        const blocks = parseBlocks(inner, depth + 1, opts);
        out.push({ t: 'x', html: '<blockquote>' + blocks.map((b) => (b.t === 'p' ? '<p>' + b.inner + '</p>' : b.html)).join('') + '</blockquote>' });
        continue;
      }

      if (listMarker(line)) {
        const list = parseList(lines, i, depth, opts);
        out.push({ t: 'x', html: list.html });
        i = list.next;
        continue;
      }

      const table = tableAt(lines, i);
      if (table) {
        const rendered = renderTable(lines, i, table);
        out.push({ t: 'x', html: rendered.html });
        i = rendered.next;
        continue;
      }

      const para = [];
      while (i < lines.length) {
        const l = expandIndent(lines[i]);
        if (isBlank(l) || (para.length && (startsBlock(l) || canInterruptParagraph(l)))) break;
        para.push(l);
        i++;
      }
      const text = para.map((l, k) => {
        const trailing = l.length - l.trimEnd().length;
        return l.trim() + (trailing >= 2 && k < para.length - 1 ? BREAK : '');
      }).join('\n');
      out.push({ t: 'p', inner: inline(text) });
    }
    return out;
  }

  /* ------------------------------------------------------------------ public */

  function render(source, opts) {
    const text = String(source == null ? '' : source);
    if (byteLength(text) > MAX_BYTES) {
      return '<p class="md-notice">' + NOTICE + '</p><pre class="md-plain">' + esc(text) + '</pre>';
    }
    const lines = text.replace(PRIVATE, REPLACEMENT).replace(/\r\n?/g, '\n').split('\n');
    return parseBlocks(lines, 0, opts).map((b) => (b.t === 'p' ? '<p>' + b.inner + '</p>' : b.html)).join('');
  }

  return { render, MAX_BYTES, MAX_DEPTH };
});
JSEOF
shasum -a 256 web/dist/md.js
node --check web/dist/md.js && echo "syntax OK"
echo "private-use characters in md.js (must be 0): $(grep -c -P '[\x{E000}-\x{E003}\x{FFFD}]' web/dist/md.js)"
```

Expected hash: `f244920d5fbe2b7b390fcba21d2cbcc8e8a7caa90f8304e8bf02ed614719388c`. Expected: `syntax OK` dan `0`.

- [ ] **Step 4: Jalankan unit test**

Run: `(cd web/e2e && node --test md.test.mjs 2>&1 | grep -E '^(✖|ℹ (tests|pass|fail))')`
Expected: `tests 101`, `pass 101`, `fail 0`. Input patologis paling lambat sekitar 100 ms (batas tiap kasus 1000 ms).

- [ ] **Step 5: Probe**

```bash
probe() {  # probe <file> <old> <new> -- <test command...>
  local file="$1" old="$2" new="$3"; shift 4
  local backup; backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path).read()
assert s.count(old) == 1, f"{s.count(old)} occurrences of {old[:60]!r}"
open(path, "w").write(s.replace(old, new))
PYEOF
  "$@"
  cp "$backup" "$file"; rm "$backup"
}
run() { (cd web/e2e && node --test md.test.mjs 2>&1 | grep -E '^(✖ [a-z]|ℹ fail)' | sort -u | head -4); }
echo "-- any URL scheme becomes a link"; probe web/dist/md.js 'const isHttpUrl = (url) => /^https?:\/\/[^\s<>"]+$/i.test(url);' 'const isHttpUrl = (url) => url.length > 0;' -- run
echo "-- fenced code not escaped";      probe web/dist/md.js "'<code>' + esc(code.join('\n')) + '</code></pre>'" "'<code>' + code.join('\n') + '</code></pre>'" -- run
echo "-- plain text not escaped";       probe web/dist/md.js '    return store.restore(emphasis(esc(text)));' '    return store.restore(emphasis(text));' -- run
echo "-- no size cap";                  probe web/dist/md.js 'if (byteLength(text) > MAX_BYTES) {' 'if (false) {' -- run
echo "-- no depth cap";                 probe web/dist/md.js 'if (depth >= MAX_DEPTH) return' 'if (false) return' -- run
echo "-- href not escaped";             probe web/dist/md.js "'<a href=\"' + esc(url)" "'<a href=\"' + url" -- run
(cd web/e2e && node --test md.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)')
```

Expected: tiap probe mencetak sedikitnya satu `✖` (skema URL: `hostile input never produces...` dan `only http and https text becomes a link`; escape: `renders: fenced code ...`, `renders: raw html is shown as text`; cap: `input at the limit...`; depth: `nesting deeper than the limit...`; href: `renders: link`). Baris terakhir: `pass 101`, `fail 0`.

- [ ] **Step 6: Checkpoint (TANPA commit)**

Run: `node --check web/dist/md.js && git status --short`
Expected: `?? web/dist/md.js`, `?? web/e2e/md.test.mjs` bertambah.

---

### Task 3: Renderer masuk ke shell app

**Files:**
- Create: `web/dist/md.css`, `cmd/server/shell_test.go`, `web/e2e/markdown.test.mjs`
- Modify: `web/dist/index.html`, `web/dist/sw.js`, `web/dist/app.js`, `web/dist/app.css`

**Interfaces:**
- Consumes: `LiteMd.render` (Task 2).
- Produces: `window.LiteMd` tersedia sebelum `app.js` berjalan; `md.js`/`md.css` ter-precache di `sw.js`; preview attachment `.md` memakai `md.js`; header e2e `markdown.test.mjs` dengan helper `untilNote`, `pulledNotes`, `uuid`, `ATTACHED`.

- [ ] **Step 1: Tulis test yang gagal**

```bash
cat > cmd/server/shell_test.go <<'GOEOF'
package main

import (
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	webassets "litenotes/web"
)

var shellVersion = regexp.MustCompile(`\?v=(\d+)`)

// The service worker precaches its whole list with one addAll(). A single 404 makes the
// install fail, and the app then never updates and never works offline, so every file
// it lists has to exist.
func TestServiceWorkerPrecachesOnlyFilesThatExist(t *testing.T) {
	a := newTestApp(t)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/sw.js", nil))
	list := regexp.MustCompile(`const ASSETS = \[([^\]]*)\];`).FindStringSubmatch(w.Body.String())
	if list == nil {
		t.Fatal("sw.js has no ASSETS list")
	}
	urls := regexp.MustCompile(`'([^']+)'`).FindAllStringSubmatch(list[1], -1)
	if len(urls) < 10 {
		t.Fatalf("found only %d precached urls; the pattern probably stopped matching", len(urls))
	}
	for _, m := range urls {
		rec := httptest.NewRecorder()
		a.routes().ServeHTTP(rec, httptest.NewRequest("GET", m[1], nil))
		if rec.Code != 200 {
			t.Errorf("sw.js precaches %s, which answers %d", m[1], rec.Code)
		}
	}
	for _, want := range []string{"/md.js?v=", "/md.css?v="} {
		if !strings.Contains(list[1], want) {
			t.Errorf("sw.js does not precache %s", want)
		}
	}
}

// Versioned assets are served as immutable. If one place keeps the old number, installed
// clients keep the old file for good, so the page, the worker and its cache name must
// all carry the same version.
func TestShellVersionsAgree(t *testing.T) {
	index, err := webassets.Dist.ReadFile("dist/index.html")
	if err != nil {
		t.Fatal(err)
	}
	sw, err := webassets.Dist.ReadFile("dist/sw.js")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, src := range []string{string(index), string(sw)} {
		for _, m := range shellVersion.FindAllStringSubmatch(src, -1) {
			seen[m[1]] = true
		}
	}
	if len(seen) != 1 {
		t.Fatalf("index.html and sw.js carry more than one asset version: %v", seen)
	}
	var version string
	for v := range seen {
		version = v
	}
	if !strings.Contains(string(sw), "io-notes-shell-v"+version+"'") {
		t.Errorf("the cache name in sw.js is not io-notes-shell-v%s", version)
	}
	// Deferred scripts run in document order, so the renderer must come before the app.
	md, app := strings.Index(string(index), "/md.js?v="), strings.Index(string(index), "/app.js?v=")
	if md < 0 || app < 0 || md > app {
		t.Errorf("index.html must load md.js before app.js (md.js at %d, app.js at %d)", md, app)
	}
	if !strings.Contains(string(index), "/md.css?v="+version) {
		t.Error("index.html does not load md.css")
	}
}
GOEOF
cat > web/e2e/markdown.test.mjs <<'MJSEOF'
// Markdown notes, the way a person uses them: write, read, convert, sync, attach, share.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { firstVisit, returningUser, saveNewNote, signIn, startApp } from './harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const uuid = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

async function pulledNotes(ctx) {
  const res = await ctx.request.get(`${app.base}/api/v1/sync/pull?cursor=0&limit=500`);
  return (await res.json()).notes;
}

// Waits until the server holds a note matching the predicate (sync is asynchronous).
async function untilNote(ctx, predicate) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const notes = await pulledNotes(ctx);
    const found = notes.find(predicate);
    if (found) return found;
    assert.ok(Date.now() < deadline, `the server never received the expected note; it holds ${JSON.stringify(notes.map((n) => ({ format: n.format, content: n.content })))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const ATTACHED = ['# Attached', '', '| k | v |', '|---|---|', '| a | 1 |', '', '- top', '  - nested', ''].join('\n');

test('an attached .md file previews with its table and nested list', async () => {
  const { ctx, page } = await returningUser(app, 'md-preview@example.com');
  try {
    await saveNewNote(page, 'see the attachment');
    await untilNote(ctx, (n) => n.content === 'see the attachment');

    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-act="attach"]').click();
    await (await chooser).setFiles({ name: 'doc.md', mimeType: 'text/markdown', buffer: Buffer.from(ATTACHED) });

    const card = page.locator('#content-render .attach-slot');
    await card.waitFor();
    await card.click();
    const preview = page.locator('.markdown-preview');
    await preview.locator('table').waitFor();
    assert.equal(await preview.locator('h1').textContent(), 'Attached');
    assert.equal(await preview.locator('ul ul li').count(), 1, 'the nested list was flattened');
  } finally {
    await ctx.close();
  }
});
MJSEOF
shasum -a 256 cmd/server/shell_test.go web/e2e/markdown.test.mjs
```

Expected hash: `shell_test.go` = `d4e3de0ff89a6942f8dfe19de0402d171dcc8c14c7bfea81fca580adc140ee9c`, `markdown.test.mjs` (versi Task 3) = `ee759dd2de52a772f861e4b08ad4b09ff4dbffd17a5877bebc93e779de648abb`.

- [ ] **Step 2: Jalankan, pastikan gagal**

```bash
go test ./cmd/server -run 'ServiceWorkerPrecaches|ShellVersions' -count=1 2>&1 | grep -E '^(--- FAIL|ok|FAIL\s)|does not precache|index.html must'
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')
```

Expected: kedua test Go gagal (`sw.js does not precache /md.js?v=`, `index.html must load md.js before app.js`), dan e2e preview gagal (renderer lama tidak mengenal table, jadi `.markdown-preview table` tidak pernah muncul; butuh ~30 detik timeout).

- [ ] **Step 3: Buat `md.css`**

```bash
cat > web/dist/md.css <<'CSSEOF'
/* Rendered Markdown. Shared by the app (note view, attachment preview) and the public
   share page, so it only uses custom properties that both stylesheets define. */

.md{font-size:14px;line-height:1.6;color:var(--text);overflow-wrap:anywhere}
.md>:first-child{margin-top:0}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:1.05em 0 .4em;color:var(--text);line-height:1.25;letter-spacing:-.015em}
.md h1{font-size:1.65em}.md h2{font-size:1.4em}.md h3{font-size:1.2em}
.md h4,.md h5,.md h6{font-size:1em}
.md p{margin:.45em 0}
.md ul,.md ol{margin:.5em 0;padding-left:1.7em}
.md li{margin:.2em 0}
.md li>ul,.md li>ol,.md li>p{margin:.2em 0}
.md a{color:var(--accent-text);text-underline-offset:2px}
.md blockquote{margin:.65em 0;padding:.15em 0 .15em .85em;border-left:3px solid var(--border-strong);color:var(--text-muted)}
.md blockquote>:first-child{margin-top:0}
.md blockquote>:last-child{margin-bottom:0}
.md hr{height:.5px;margin:1.2em 0;border:0;background:var(--border)}
.md .md-code{position:relative;margin:.7em 0;padding:12px;overflow:auto;border-radius:7px;background:var(--surface-3);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.md .md-code-language{display:block;margin:0 0 5px;color:var(--text-tertiary);font:10px/1.2 var(--font);text-transform:uppercase;letter-spacing:.04em}
.md :not(pre)>code{padding:2px 4px;border-radius:4px;background:var(--surface-3);font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* Only the task items drop their bullet; the checkbox takes its place. A list that mixes both keeps the bullets. */
.md .md-task{list-style:none;margin-left:-1.45em}
.md .md-task>input{margin:0 .5em 0 0;vertical-align:-.1em;accent-color:var(--accent)}
.md .md-image-label{color:var(--text-tertiary);font-style:italic}
.md .md-attach{margin:.5em 0}
.md .md-attach-label{color:var(--text-muted)}
.md .md-table-wrap{margin:.7em 0;overflow-x:auto}
.md table{border-collapse:collapse;min-width:min(100%,24em)}
.md th,.md td{padding:6px 10px;border:.5px solid var(--border-strong);text-align:left;vertical-align:top}
.md th{background:var(--surface-2);font-weight:600}
.md .md-al-center{text-align:center}
.md .md-al-right{text-align:right}
.md .md-notice{margin:.5em 0;padding:8px 10px;border-radius:7px;background:var(--surface-2);color:var(--text-muted);font-size:.9em}
.md .md-plain{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.md .md-empty{color:var(--text-tertiary)}
CSSEOF
shasum -a 256 web/dist/md.css
```

Expected hash: `82fae6b9bdbe16e2e081ef026ca19c6b6c2c88dba905ccb9a84a46bf555e5c03`

- [ ] **Step 4: Terapkan patch shell**

```bash
python3 - <<'PYEOF'
"""Task 3: load md.js/md.css in the app shell, precache them, and use md.js for attachment
previews. Run from the repository root, after web/dist/md.js and web/dist/md.css exist."""


def patch(path, edits):
    s = open(path).read()
    for old, new in edits:
        assert s.count(old) == 1, f"{path}: expected 1 occurrence, found {s.count(old)}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    open(path, "w").write(s)


# The shell now loads two more assets, so its version moves from 70 to 71 (assets are served
# immutable: without a new version, installed clients never see them).
patch("web/dist/index.html", [
    ('<link rel="stylesheet" href="/app.css?v=70">\n',
     '<link rel="stylesheet" href="/app.css?v=70">\n<link rel="stylesheet" href="/md.css?v=70">\n'),
    ('<script src="/app.js?v=70" defer></script>',
     '<script src="/md.js?v=70" defer></script>\n<script src="/app.js?v=70" defer></script>'),
])
patch("web/dist/sw.js", [
    ("'/app.js?v=70', ", "'/app.js?v=70', '/md.css?v=70', '/md.js?v=70', "),
    ("const ASSET_PATHS = new Set(['/app.css', '/app.js', ", "const ASSET_PATHS = new Set(['/app.css', '/app.js', '/md.css', '/md.js', "),
])
for path in ("web/dist/index.html", "web/dist/sw.js"):
    s = open(path).read()
    open(path, "w").write(s.replace("v=70", "v=71").replace("shell-v70", "shell-v71"))

# app.js: attachment previews use md.js; the old renderer goes away.
s = open("web/dist/app.js").read()
start = s.index("  // A deliberately small Markdown renderer for attachment previews. It starts\n")
end = s.index("  function attachmentPreviewHTML(meta, id) {\n")
removed = s[start:end]
assert start < end and "function markdownInline" in removed and "function renderMarkdown" in removed
import re
assert re.findall(r"^  function (\w+)", removed, re.M) == ["markdownInline", "renderMarkdown"], "the removed block must hold exactly the two old renderer functions"
s = s[:start] + s[end:]
old = "        host.classList.add('markdown-preview');\n        host.innerHTML = renderMarkdown(text);"
assert s.count(old) == 1
s = s.replace(old, "        host.classList.add('markdown-preview', 'md');\n        host.innerHTML = LiteMd.render(text);")
open("web/dist/app.js", "w").write(s)

# app.css: the preview styles moved into md.css (keep the container rule that starts with .attach-preview-text).
lines = open("web/dist/app.css").read().split("\n")
kept = [l for l in lines if not l.startswith(".markdown-preview")]
assert len(lines) - len(kept) == 16, f"expected to drop 16 preview rules, dropped {len(lines) - len(kept)}"
open("web/dist/app.css", "w").write("\n".join(kept))
print("task 3 shell patch applied")
PYEOF
node --check web/dist/app.js && node --check web/dist/sw.js && echo "syntax OK"
grep -rn -E 'v=70|v70' web/dist/index.html web/dist/sw.js || echo "no v70 left"
grep -n "renderMarkdown\|markdownInline" web/dist/app.js || echo "old renderer removed"
```

Expected: `task 3 shell patch applied`, `syntax OK`, `no v70 left`, `old renderer removed`.

- [ ] **Step 5: Jalankan, pastikan lulus**

```bash
gofmt -l cmd/; go vet ./... && go test ./... -count=1 2>&1 | tail -3
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')
```

Expected: `ok`; e2e `an attached .md file previews with its table and nested list` lulus.

- [ ] **Step 6: Probe**

```bash
BACKUP=$(mktemp)
cp web/dist/sw.js "$BACKUP"
sed -i '' "s#'/md.js?v=71'#'/md.js?v=70'#" web/dist/sw.js
echo "-- one stale version";      go test ./cmd/server -run 'ShellVersions' -count=1 2>&1 | grep -E '^(--- FAIL|ok)|more than one'
cp "$BACKUP" web/dist/sw.js
sed -i '' "s#'/md.css?v=71'#'/missing.css?v=71'#" web/dist/sw.js
echo "-- precache a missing file"; go test ./cmd/server -run 'Precaches' -count=1 2>&1 | grep -E '^(--- FAIL|ok)|answers'
cp "$BACKUP" web/dist/sw.js; rm "$BACKUP"
go test ./cmd/server -count=1 2>&1 | tail -1
```

Expected: probe pertama `more than one asset version: map[70:true 71:true]`, kedua `sw.js precaches /missing.css?v=71, which answers 404`, baris terakhir `ok`.

- [ ] **Step 7: Checkpoint (TANPA commit)**

Run: `git status --short`
Expected: `M web/dist/index.html`, `M web/dist/sw.js`, `M web/dist/app.js`, `M web/dist/app.css`, `?? web/dist/md.css`, `?? cmd/server/shell_test.go`, `?? web/e2e/markdown.test.mjs`, plus file Task 1-2.

---

### Task 4: Tipe Markdown di editor (View, Edit, konversi, sync)

**Files:**
- Modify: `web/dist/app.js`, `web/dist/app.css`
- Test: `web/e2e/markdown.test.mjs`

**Interfaces:**
- Consumes: `LiteMd.render` (Task 2); server `format` (Task 1); helper e2e dari Task 3.
- Produces: `formatOf`, `isMd`, `mdEditing`, `editorText`, `renderMdView`, `wireMdView`, `toggleMdEdit`, `enterMdEdit`, `setFormat`, `toggleFormat`, `newNote(format)`; elemen `#md-view`, `[data-act="new-md"]`, `[data-act="toggle-md"]`, `[data-act="md-edit"]`; helper e2e `SAMPLE`, `newMarkdownNote`, `done`.

- [ ] **Step 1: Tambah test e2e yang gagal**

```bash
cat >> web/e2e/markdown.test.mjs <<'MJSEOF'

const SAMPLE = [
  '# Release notes', '',
  '| name | qty |', '|:-----|----:|', '| apple | 3 |', '',
  '- one', '  - nested', '- [ ] task', '',
  '<u>kept</u> and _this_', '🟡 not a checklist here',
].join('\n');

async function newMarkdownNote(page, text) {
  await page.locator('[data-act="new-md"]:visible').first().click();
  await page.locator('#content').waitFor();
  await page.fill('#content', text);
}

const done = (page) => page.getByRole('button', { name: 'Done', exact: true });

test('a new Markdown note opens in Edit, renders after Done and is stored exactly as typed', async () => {
  const { ctx, page } = await returningUser(app, 'md-basic@example.com');
  try {
    await newMarkdownNote(page, SAMPLE);
    assert.equal(await page.locator('#content-render').count(), 0, 'the plain-note overlay is showing in a Markdown note');
    assert.equal(await page.locator('[data-act="fmt-bold"]').count(), 0, 'plain-note formatting buttons are showing');

    await done(page).click();
    await page.locator('#md-view h1').waitFor();
    assert.equal(await page.locator('#md-view h1').textContent(), 'Release notes');
    assert.equal(await page.locator('#md-view th').count(), 2);
    assert.equal(await page.locator('#md-view ul ul li').count(), 1);
    assert.equal(await page.locator('#md-view input[type="checkbox"]').count(), 1);
    // A list that also holds a task keeps the bullets of its plain items.
    const bullet = await page.locator('#md-view ul > li:not(.md-task)').first().evaluate((el) => getComputedStyle(el).listStyleType);
    assert.notEqual(bullet, 'none', 'a plain item lost its bullet because the list also has a task');
    assert.equal(await page.locator('#content').count(), 0, 'View still shows a textarea');

    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === SAMPLE);
    assert.equal(note.content, SAMPLE, 'the server holds different text than was typed');
  } finally {
    await ctx.close();
  }
});

test('a Markdown note reopens in View, edits as the exact text, and returns to View when reopened', async () => {
  const { ctx, page } = await returningUser(app, 'md-reopen@example.com');
  try {
    await newMarkdownNote(page, SAMPLE);
    await done(page).click();
    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === SAMPLE);

    await page.reload();
    await page.locator('#md-view').waitFor();
    assert.equal(await page.locator('#content').count(), 0, 'a reload came back in Edit');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await page.locator('#content').inputValue(), SAMPLE, 'Edit shows a rewritten version of the note');

    await page.goto(`${app.base}/#/notes`);
    await page.goto(`${app.base}/#/notes/${note.id}`);
    await page.locator('#md-view').waitFor();
    assert.equal(await page.locator('#content').count(), 0, 'leaving the note and coming back kept it in Edit');
  } finally {
    await ctx.close();
  }
});

test('converting a plain note to Markdown and back changes how it looks, never what it says', async () => {
  const { ctx, page } = await returningUser(app, 'md-toggle@example.com');
  try {
    await saveNewNote(page, '- [ ] a\n**b**');
    await untilNote(ctx, (n) => n.content === '- [ ] a\n**b**');

    await page.locator('[data-act="toggle-md"]').click();
    await page.locator('#md-view').waitFor();
    assert.equal(await page.locator('#md-view input[type="checkbox"]').count(), 1);
    assert.equal(await page.locator('#md-view strong').textContent(), 'b');
    await untilNote(ctx, (n) => n.format === 'md' && n.content === '- [ ] a\n**b**');

    await page.locator('[data-act="toggle-md"]').click();
    await page.locator('#content').waitFor();
    assert.equal(await page.locator('#content').inputValue(), '🟡 a\n**b**', 'the plain editor shows its checklist the usual way');
    await untilNote(ctx, (n) => n.format === 'text' && n.content === '- [ ] a\n**b**');
  } finally {
    await ctx.close();
  }
});

test('a change that arrives from another device shows up in an open Markdown view', async () => {
  const { ctx, page } = await returningUser(app, 'md-live@example.com');
  try {
    await newMarkdownNote(page, '# First');
    await done(page).click();
    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === '# First');

    const pushed = await ctx.request.post(`${app.base}/api/v1/sync/push`, {
      data: {
        device_id: 'other-device',
        mutations: [{ mutation_id: uuid(701), note: { id: note.id, title: '', content: '# Second\n\nchanged elsewhere', created_at: note.created_at, updated_at: note.updated_at + 1, deleted_at: null, folder_id: '', is_pinned: false, format: 'md' } }],
      },
    });
    assert.ok(pushed.ok(), `push failed: HTTP ${pushed.status()}`);

    // Coming back to the tab is one of the moments the app syncs.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#md-view h1', { hasText: 'Second' }).waitFor();
    assert.match((await page.locator('#meta-words').textContent()) || '', /^4 words/);
  } finally {
    await ctx.close();
  }
});
MJSEOF
node --check web/e2e/markdown.test.mjs && echo "e2e file OK"
(cd web/e2e && node --test --test-concurrency=1 --test-name-pattern='new Markdown note|reopens in View|converting a plain|another device' markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')
```

Expected: keempat test baru gagal (tidak ada `[data-act="new-md"]` / `toggle-md`; tiap kegagalan menunggu ~30 detik).

- [ ] **Step 2: Terapkan patch client**

```bash
python3 - <<'PYEOF'
"""Task 4: Markdown notes in the editor. Run from the repository root."""
import re


def patch(path, edits):
    s = open(path).read()
    for old, new in edits:
        assert s.count(old) == 1, f"{path}: expected 1 occurrence, found {s.count(old)}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    open(path, "w").write(s)


APP = "web/dist/app.js"

MARKDOWN_BLOCK = r'''  /* ------------------------------------------------------------ markdown notes */

  // What the editor shows for a note. Markdown is kept exactly as written; plain
  // notes go through normalizeContent (checklist emoji, <u> tags).
  function editorText(n) {
    const raw = state.decrypted[n.id]?.content ?? n.content;
    return isMd(n) ? String(raw ?? '') : normalizeContent(raw);
  }

  function renderMdView(n) {
    const host = $('#md-view');
    if (!host) return;
    const source = editorText(n);
    if (host._source === source) return;
    host._source = source;
    host.innerHTML = source.trim()
      ? LiteMd.render(source, { attachment: attachCardHTML })
      : '<p class="md-empty">Nothing to preview. Click Edit to start writing.</p>';
  }

  // Markdown View has no textarea, so only the title can be edited here.
  function wireMdView(n) {
    const title = $('#title');
    title.value = state.decrypted[n.id]?.title ?? n.title;
    autoGrow(title);
    renderMdView(n);
    if (!n.deleted_at) {
      title.addEventListener('input', onEdit);
      title.addEventListener('blur', () => void flushSave());
      title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void toggleMdEdit(); }
      });
    }
    refreshEditorChrome(n);
  }

  async function toggleMdEdit() {
    const n = currentNote();
    if (!n || n.deleted_at || !isMd(n)) return;
    await flushSave();
    if (mdEditing.has(n.id)) mdEditing.delete(n.id); else mdEditing.add(n.id);
    paint();
    if (mdEditing.has(n.id)) requestAnimationFrame(() => $('#content')?.focus({ preventScroll: true }));
  }

  // Synchronous on purpose: a caller that needs the textarea (attaching a file from
  // View) uses it right after this returns.
  function enterMdEdit(n) {
    if (!isMd(n) || n.deleted_at || mdEditing.has(n.id)) return;
    mdEditing.add(n.id);
    paint();
  }

  async function setFormat(n, format) {
    if (formatOf(n) === format) return;
    await flushSave();
    // Markdown is stored as written, so a plain note's checklists are put into their stored form once.
    if (format === 'md') n.content = canonicalContent(n.content);
    n.format = format;
    mdEditing.delete(n.id);
    n.updated_at = stamp(n.updated_at);
    n.mutation_id = uid();
    n.draft = false;
    await saveLocal(n);
    paint();
    scheduleSync();
  }

  async function toggleFormat() {
    const n = currentNote();
    if (!n || n.deleted_at || n.is_locked) return;
    await setFormat(n, isMd(n) ? 'text' : 'md');
  }

'''

FORMAT_BAR = r'''    const formatBar = inTrash ? '' : `<div class="format-bar" role="toolbar" aria-label="Formatting">
      ${!md || mdEdit ? `<div class="history-actions">
        <button type="button" data-act="undo" title="Undo (Cmd+Z)" aria-label="Undo" disabled>${icon('undo', 15)}</button>
        <button type="button" data-act="redo" title="Redo (Cmd+Shift+Z)" aria-label="Redo" disabled>${icon('redo', 15)}</button>
      </div>
      <span class="sep" aria-hidden="true"></span>` : ''}
      ${md ? '' : `<button type="button" data-act="fmt-bold" title="Bold (Cmd+B)" aria-label="Bold">${icon('bold', 16)}</button>
      <button type="button" data-act="fmt-italic" title="Italic (Cmd+I)" aria-label="Italic">${icon('italic', 16)}</button>
      <button type="button" data-act="fmt-underline" title="Underline" aria-label="Underline">${icon('underline', 16)}</button>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="fmt-check" title="Checklist" aria-label="Checklist">${icon('checkCircle', 16)}</button>
      <button type="button" data-act="fmt-bullet" title="Bullet list" aria-label="Bullet list">${icon('list', 16)}</button>`}
      ${attachmentsOn() ? `<button type="button" data-act="attach" title="Attach file" aria-label="Attach file">${icon('paperclip', 16)}</button>` : ''}
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-act="toggle-pin" class="${n.is_pinned ? 'on' : ''}" title="${n.is_pinned ? 'Unpin' : 'Pin'}" aria-label="${n.is_pinned ? 'Unpin' : 'Pin'}">${icon(n.is_pinned ? 'pinFill' : 'pin', 16)}</button>
    </div>`;'''

CONTENT_AREA = r'''    const contentArea = md && !mdEdit
      ? `<div class="md md-view" id="md-view" aria-label="Rendered note"></div>`
      : `<div class="content-wrap${md ? ' content-wrap-plain' : ''}">
             ${md ? '' : '<div class="content-render" id="content-render" aria-hidden="true"></div>'}
             <textarea class="content${md ? ' content-plain' : ''}" id="content" placeholder="Start writing…" aria-label="Note content" ${md ? 'spellcheck="false"' : ''} ${inTrash ? 'readonly' : ''}></textarea>
           </div>`;

'''

MD_BUTTONS = r'''    const mdButtons = inTrash ? '' : `${md ? `<button type="button" class="btn" data-act="md-edit">${mdEdit ? 'Done' : 'Edit'}</button>` : ''}${n.is_locked ? '' : `<button class="icon-btn ${md ? 'on' : ''}" data-act="toggle-md" aria-label="Markdown note" aria-pressed="${md}" title="${md ? 'Markdown note (click to make it a plain note)' : 'Make this a Markdown note'}">${icon('markdown')}</button>`}`;
'''

# ---------------------------------------------------------------- plain edits
patch(APP, [
    # helpers next to isLocked
    ("  const isLocked = (n) => !!n.is_locked && !state.unlocked[n.id];\n",
     "  const isLocked = (n) => !!n.is_locked && !state.unlocked[n.id];\n"
     "  const formatOf = (n) => (n.format === 'md' ? 'md' : 'text');\n"
     "  const isMd = (n) => formatOf(n) === 'md';\n"
     "  // Markdown notes currently in Edit mode. In memory only: every one opens in View.\n"
     "  const mdEditing = new Set();\n"),
    # stored as written
    ("    rest.content = canonicalContent(rest.content);\n",
     "    // Markdown is stored exactly as written; canonicalContent would rewrite its checklists.\n"
     "    rest.content = isMd(rest) ? String(rest.content ?? '') : canonicalContent(rest.content);\n"),
    # the editor re-renders when the format or the mode changes
    ("  let editorKey = '';\n", "  let editorKey = '';\n  let shownNoteId = null;\n"),
    ("    return `note:${n.id}:${n.is_locked ? 'pw' : 'nopw'}:${isLocked(n) ? 'locked' : 'open'}:${n.deleted_at ? 'trash' : 'live'}`;",
     "    return `note:${n.id}:${n.is_locked ? 'pw' : 'nopw'}:${isLocked(n) ? 'locked' : 'open'}:${n.deleted_at ? 'trash' : 'live'}:${formatOf(n)}:${mdEditing.has(n.id) ? 'edit' : 'view'}`;"),
    ("  function paintEditor() {\n    const host = $('#editor');\n    const n = currentNote();\n    const key = editorKeyFor(n);\n",
     "  function paintEditor() {\n    const host = $('#editor');\n    const n = currentNote();\n"
     "    // Every Markdown note opens in View; only a brand-new empty note stays in Edit.\n"
     "    if ((n?.id || null) !== shownNoteId) {\n"
     "      shownNoteId = n?.id || null;\n"
     "      if (n && mdEditing.has(n.id) && String(n.content || '').trim() !== '') mdEditing.delete(n.id);\n"
     "    }\n"
     "    const key = editorKeyFor(n);\n"),
    # editorHTML: format and mode, header buttons
    ("    const inTrash = !!n.deleted_at;\n    const crumb = inTrash\n",
     "    const inTrash = !!n.deleted_at;\n    const md = isMd(n);\n    const mdEdit = md && !inTrash && mdEditing.has(n.id);\n    const crumb = inTrash\n"),
    ("    const actions = inTrash\n", MD_BUTTONS + "    const actions = inTrash\n"),
    ("      : `${attachmentsOn() ? `<button class=\"icon-btn\" data-act=\"attachments\"",
     "      : `${mdButtons}${attachmentsOn() ? `<button class=\"icon-btn\" data-act=\"attachments\""),
    ("    return head(`${crumb}<span class=\"head-spacer\"></span>", CONTENT_AREA + "    return head(`${crumb}<span class=\"head-spacer\"></span>"),
    # wireEditor
    ("    if (!title || !content) {\n      if (isLocked(n)) $('#note-password')?.focus({ preventScroll: true });\n      return;\n    }\n"
     "    const d = state.decrypted[n.id];\n    title.value = d?.title ?? n.title;\n    content.value = normalizeContent(d?.content ?? n.content);",
     "    if (title && !content && $('#md-view')) { wireMdView(n); return; }\n"
     "    if (!title || !content) {\n      if (isLocked(n)) $('#note-password')?.focus({ preventScroll: true });\n      return;\n    }\n"
     "    const d = state.decrypted[n.id];\n    title.value = d?.title ?? n.title;\n    content.value = editorText(n);"),
    ("  function wireEditor(n) {\n", MARKDOWN_BLOCK + "  function wireEditor(n) {\n"),
    # refreshEditorChrome works in View too
    ("    if (!title || !content) return;\n\n    const d = state.decrypted[n.id];\n    const nTitle = d?.title ?? n.title;\n"
     "    const nContent = normalizeContent(d?.content ?? n.content);\n    renderContentOverlay(content.value || nContent);",
     "    const view = $('#md-view');\n    if (!title || (!content && !view)) return;\n\n"
     "    const nTitle = state.decrypted[n.id]?.title ?? n.title;\n    const nContent = editorText(n);\n"
     "    if (content) renderContentOverlay(content.value || nContent);"),
    ("      if (content.value !== nContent) content.value = nContent;\n    }",
     "      if (content && content.value !== nContent) content.value = nContent;\n      if (view) renderMdView(n);\n    }"),
    ("    const words = wordsOf(content.value);\n    $('#meta-words').textContent = `${words} words · ${content.value.length} characters`;",
     "    const text = content ? content.value : nContent;\n    $('#meta-words').textContent = `${wordsOf(text)} words · ${text.length} characters`;"),
    # onEdit: the title can change while there is no textarea
    ("    const content = $('#content');\n    rememberEdit(n, title.value, content.value);\n    n.title = title.value;\n    n.content = content.value;\n"
     "    n.draft = false;\n    dirtyId = n.id;\n    dirtyVersion += 1;\n    if (n.is_locked && state.unlocked[n.id]) {\n"
     "      state.decrypted[n.id] = { title: title.value, content: content.value };\n    }\n    renderContentOverlay(content.value);\n",
     "    const content = $('#content');\n    // Markdown View has no textarea: only the title can change there.\n"
     "    const text = content ? content.value : (state.decrypted[n.id]?.content ?? n.content);\n"
     "    rememberEdit(n, title.value, text);\n    n.title = title.value;\n    n.content = text;\n"
     "    n.draft = false;\n    dirtyId = n.id;\n    dirtyVersion += 1;\n    if (n.is_locked && state.unlocked[n.id]) {\n"
     "      state.decrypted[n.id] = { title: title.value, content: text };\n    }\n    if (content) renderContentOverlay(content.value);\n"),
    # actions
    ("    if (act === 'new') return void newNote();\n",
     "    if (act === 'new') return void newNote();\n    if (act === 'new-md') return void newNote('md');\n"),
    ("    if (act === 'toggle-pin') return void togglePin();\n",
     "    if (act === 'toggle-pin') return void togglePin();\n    if (act === 'toggle-md') return void toggleFormat();\n    if (act === 'md-edit') return void toggleMdEdit();\n"),
    # creating a Markdown note
    ("  function newNote() {\n", "  function newNote(format = 'text') {\n"),
    ("      mutation_id: uid(), revision: 0, server_updated_at: 0, is_locked: false, draft: true,\n    };\n    state.notes.push(n);\n",
     "      mutation_id: uid(), revision: 0, server_updated_at: 0, is_locked: false, draft: true, format,\n    };\n    state.notes.push(n);\n"
     "    if (format === 'md') mdEditing.add(n.id);\n"),
    # icon
    ("    copy: '<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2.2\"/><path d=\"M5 15V6.2A2.2 2.2 0 0 1 7.2 4H16\"/>',\n",
     "    copy: '<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2.2\"/><path d=\"M5 15V6.2A2.2 2.2 0 0 1 7.2 4H16\"/>',\n"
     "    markdown: '<rect x=\"2.6\" y=\"6\" width=\"18.8\" height=\"12\" rx=\"2.4\"/><path d=\"M6 15V9l2.4 3L10.8 9v6\"/><path d=\"M16.2 9v6m-2.2-2.2 2.2 2.2 2.2-2.2\"/>',\n"),
    # list header buttons (mobile and desktop)
    ("      <button class=\"icon-btn accent\" data-act=\"new\" aria-label=\"New note\" title=\"New note (Ctrl+N)\">${icon('plus', 20)}</button>",
     "      <button class=\"icon-btn\" data-act=\"new-md\" aria-label=\"New Markdown note\" title=\"New Markdown note\">${icon('markdown', 20)}</button>\n"
     "      <button class=\"icon-btn accent\" data-act=\"new\" aria-label=\"New note\" title=\"New note (Ctrl+N)\">${icon('plus', 20)}</button>"),
    ("      <button class=\"icon-btn accent\" data-act=\"new\" id=\"btn-new-note-desktop\" aria-label=\"New note\" title=\"New note (Ctrl+N)\" style=\"display:none;margin-left:auto\">${icon('plus', 20)}</button>",
     "      <button class=\"icon-btn\" data-act=\"new-md\" id=\"btn-new-md-desktop\" aria-label=\"New Markdown note\" title=\"New Markdown note\" style=\"display:none;margin-left:auto\">${icon('markdown', 20)}</button>\n"
     "      <button class=\"icon-btn accent\" data-act=\"new\" id=\"btn-new-note-desktop\" aria-label=\"New note\" title=\"New note (Ctrl+N)\" style=\"display:none\">${icon('plus', 20)}</button>"),
    # sync payload: only when the note has a format (a copy from before the field has none, and
    # sending 'text' for it could overwrite a Markdown note set on another device)
    ("folder_id: n.folder_id || '', is_pinned: !!n.is_pinned } };",
     "folder_id: n.folder_id || '', is_pinned: !!n.is_pinned, ...(n.format ? { format: n.format } : {}) } };"),
    # backup export / import
    ("\\n---\\n\\n${canonicalContent(content)}` });",
     "\\n---\\n\\n${isMd(n) ? content : canonicalContent(content)}` });"),
    ("backup.notes.push({ id: n.id, title, content, folder_id: n.folder_id || null, is_pinned: !!n.is_pinned, created_at: n.created_at, updated_at: n.updated_at });",
     "backup.notes.push({ id: n.id, title, content, format: formatOf(n), folder_id: n.folder_id || null, is_pinned: !!n.is_pinned, created_at: n.created_at, updated_at: n.updated_at });"),
    ("            title: String(nn.title ?? ''), content: normalizeContent(nn.content ?? ''),\n",
     "            title: String(nn.title ?? ''), content: nn.format === 'md' ? String(nn.content ?? '') : normalizeContent(nn.content ?? ''),\n"
     "            format: nn.format === 'md' ? 'md' : 'text',\n"),
])

# ---------------------------------------------------------------- formatBar and content area (multi-line blocks)
s = open(APP).read()
start = s.index("    const formatBar = inTrash ? '' : `<div class=\"format-bar\"")
end_marker = "    </div>`;"
end = s.index(end_marker, start) + len(end_marker)
block = s[start:end]
assert "toggle-pin" in block and block.count("data-act=\"fmt-bold\"") == 1, "unexpected formatBar block"
s = s[:start] + FORMAT_BAR + s[end:]

pattern = re.compile(r'<div class="content-wrap">\s*<div class="content-render" id="content-render" aria-hidden="true"></div>\s*<textarea class="content" id="content"[^>]*></textarea>\s*</div>')
assert len(pattern.findall(s)) == 1, "content area markup not found exactly once"
s = pattern.sub("${contentArea}", s, count=1)
open(APP, "w").write(s)

# ---------------------------------------------------------------- css
patch("web/dist/app.css", [
    ("  #btn-new-note-desktop { display: inline-grid !important; }",
     "  #btn-new-note-desktop, #btn-new-md-desktop { display: inline-grid !important; }"),
])
with open("web/dist/app.css", "a") as css:
    css.write("""
/* ---------- markdown notes ---------- */
.md-view{flex:1;min-height:0;overflow:auto;padding:12px 6px 28px;font-size:15px;line-height:1.65;scrollbar-width:thin}
.content.content-plain{color:var(--text);font:13.5px/22px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}
.content.content-plain::selection{background:color-mix(in srgb,var(--accent) 25%,transparent);color:inherit}
""")
print("task 4 client patch applied")
PYEOF
node --check web/dist/app.js && echo "app.js syntax OK"
```

Expected: `task 4 client patch applied`, `app.js syntax OK`.

- [ ] **Step 3: Jalankan, pastikan lulus**

Run: `(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')`
Expected: semua test di file lulus (lima: preview, basic, reopen, toggle, live).

- [ ] **Step 4: Probe**

```bash
probe() {  # probe <file> <old> <new> -- <test command...>
  local file="$1" old="$2" new="$3"; shift 4
  local backup; backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path).read()
assert s.count(old) == 1, f"{s.count(old)} occurrences of {old[:60]!r}"
open(path, "w").write(s.replace(old, new))
PYEOF
  "$@"
  cp "$backup" "$file"; rm "$backup"
}
run() { (cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^✖ [a-z]' | sort -u | head -4); }
echo "-- 1 Edit shows normalized text";      probe web/dist/app.js "return isMd(n) ? String(raw ?? '') : normalizeContent(raw);" 'return normalizeContent(raw);' -- run
echo "-- 2 canonical form applied on save";  probe web/dist/app.js "rest.content = isMd(rest) ? String(rest.content ?? '') : canonicalContent(rest.content);" 'rest.content = canonicalContent(rest.content);' -- run
echo "-- 3 View not repainted on sync";      probe web/dist/app.js '      if (view) renderMdView(n);' '' -- run
echo "-- 4 no reset to View when reopened";  probe web/dist/app.js "if (n && mdEditing.has(n.id) && String(n.content || '').trim() !== '') mdEditing.delete(n.id);" '' -- run
echo "-- 5 format left out of the payload";  probe web/dist/app.js '...(n.format ? { format: n.format } : {}) } };' '} };' -- run
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)')
```

Expected: probe 1 menggagalkan `reopens in View...`, `new Markdown note...`, `converting a plain...`; probe 2 menggagalkan `new Markdown note...` dan `reopens...`; probe 3 menggagalkan `a change that arrives from another device...`; probe 4 menggagalkan `reopens in View...`; probe 5 menggagalkan `live`, `reopens`, dan `new Markdown note`. Baris terakhir: `fail 0`.

- [ ] **Step 5: Checkpoint (TANPA commit)**

Run: `node --check web/dist/app.js && git status --short`
Expected: `M web/dist/app.js`, `M web/dist/app.css` (selain yang sudah tercatat).

---

### Task 5: Attachment di dalam note Markdown

**Files:**
- Modify: `web/dist/app.js`
- Test: `web/e2e/markdown.test.mjs`

**Interfaces:**
- Consumes: `enterMdEdit`, `renderMdView` (Task 4); `insertAttachmentRef`, `rerenderOverlay` yang sudah ada.
- Produces: upload dari mode View memindah note ke Edit dan menyisipkan referensi; kartu attachment di View digambar ulang paksa.

- [ ] **Step 1: Tambah test e2e**

```bash
cat >> web/e2e/markdown.test.mjs <<'MJSEOF'

test('attaching a file while a Markdown note is in View puts the reference in the note', async () => {
  const { ctx, page } = await returningUser(app, 'md-attach@example.com');
  try {
    await newMarkdownNote(page, '# Doc');
    await done(page).click();
    await page.locator('#md-view').waitFor();

    // View keeps pin and attach, and drops what only makes sense while typing.
    assert.equal(await page.locator('[data-act="toggle-pin"]').count(), 1);
    assert.equal(await page.locator('[data-act="attach"]').count(), 1);
    assert.equal(await page.locator('[data-act="fmt-bold"]').count(), 0);
    assert.equal(await page.locator('[data-act="undo"]').count(), 0);

    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-act="attach"]').click();
    await (await chooser).setFiles({ name: 'doc.md', mimeType: 'text/markdown', buffer: Buffer.from(ATTACHED) });

    // The note moved to Edit so the reference could be inserted.
    await page.locator('#content').waitFor();
    await page.waitForFunction(() => /!\[doc\.md\]\(attach:[0-9a-f-]{36}\)/.test(document.querySelector('#content')?.value || ''));
    assert.equal(await page.locator('[data-act="undo"]').count(), 1, 'Edit lost the undo button');

    await done(page).click();
    const card = page.locator('#md-view .attach-slot');
    await card.waitFor();
    await card.click();
    await page.locator('.markdown-preview table').waitFor();
    await page.keyboard.press('Escape');

    // After a reload the cards are drawn before the attachment list has arrived; View has to
    // repaint them once it does, or they would stay marked as missing.
    await page.reload();
    await page.locator('#md-view .attach-slot.attach-link').waitFor();

    // Deleting the attachment from the manager clears its card from View as well.
    await page.locator('[data-act="attachments"]').click();
    await page.getByRole('button', { name: /doc\.md/ }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('heading', { name: 'Delete attachment?' }).waitFor();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#md-view .attach-slot').length === 0);
    await untilNote(ctx, (n) => n.format === 'md' && !n.content.includes('attach:'));
  } finally {
    await ctx.close();
  }
});

test('the format reaches another browser signed in as the same user', async () => {
  const { ctx, page } = await returningUser(app, 'md-sync@example.com');
  const other = await app.newContext();
  try {
    await newMarkdownNote(page, '# Shared everywhere');
    await done(page).click();
    const note = await untilNote(ctx, (n) => n.format === 'md' && n.content === '# Shared everywhere');

    await signIn(other, app.base, 'md-sync@example.com');
    const second = await other.newPage();
    await firstVisit(second, app.base);
    await second.goto(`${app.base}/#/notes/${note.id}`);
    await second.locator('#md-view h1').waitFor();
    assert.equal(await second.locator('#md-view h1').textContent(), 'Shared everywhere');
  } finally {
    await other.close();
    await ctx.close();
  }
});

test('plain notes keep their editor: underline overlay, checklist emoji and the full toolbar', async () => {
  const { ctx, page } = await returningUser(app, 'md-plain@example.com');
  try {
    await saveNewNote(page, '_u_ and **b**\n- [ ] todo');
    assert.equal(await page.locator('[data-act="fmt-bold"]').count(), 1);
    assert.equal(await page.locator('[data-act="md-edit"]').count(), 0, 'a plain note shows the Markdown Edit button');
    assert.equal(await page.locator('#content-render u').count(), 1);

    await page.reload();
    await page.locator('#content').waitFor();
    assert.equal(await page.locator('#content').inputValue(), '_u_ and **b**\n🟡 todo');
    assert.equal(await page.locator('#content-render u').count(), 1);
  } finally {
    await ctx.close();
  }
});
MJSEOF
node --check web/e2e/markdown.test.mjs && echo "e2e file OK"
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')
```

Expected: `attaching a file while a Markdown note is in View...` **gagal** (referensi tidak pernah masuk, karena `insertAttachmentRef` langsung `return` tanpa `#content`). `the format reaches another browser...` dan `plain notes keep their editor...` sudah **lulus** (karakterisasi perilaku dari Task 4; keduanya memang tidak butuh patch Task 5).

- [ ] **Step 2: Terapkan patch**

```bash
python3 - <<'PYEOF'
"""Task 5: attachments inside Markdown notes. Run from the repository root."""


def patch(path, edits):
    s = open(path).read()
    for old, new in edits:
        assert s.count(old) == 1, f"{path}: expected 1 occurrence, found {s.count(old)}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    open(path, "w").write(s)


patch("web/dist/app.js", [
    # Attachment cards depend on attachment metadata that arrives later (and changes when an
    # attachment is deleted), so a Markdown View must be repainted along with the overlay.
    ("  function rerenderOverlay() {\n    const c = $('#content');\n    if (c) renderContentOverlay(c.value);\n  }",
     "  function rerenderOverlay() {\n    const c = $('#content');\n    if (c) renderContentOverlay(c.value);\n"
     "    const view = $('#md-view');\n    const open = currentNote();\n"
     "    if (view && open) { view._source = null; renderMdView(open); }\n  }"),
    # A Markdown note in View has no textarea: without this the file uploads (and uses quota)
    # but its reference never reaches the note.
    ("  function insertAttachmentRef(att) {\n    const c = $('#content');\n    if (!c) return;",
     "  function insertAttachmentRef(att) {\n"
     "    // A Markdown note in View has no textarea; move it to Edit so the reference can be inserted.\n"
     "    const open = currentNote();\n    if (open && isMd(open)) enterMdEdit(open);\n"
     "    const c = $('#content');\n    if (!c) return;"),
])
print("task 5 client patch applied")
PYEOF
node --check web/dist/app.js && echo "app.js syntax OK"
```

- [ ] **Step 3: Jalankan, pastikan lulus**

Run: `(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')`
Expected: semua test lulus (delapan).

- [ ] **Step 4: Probe**

```bash
probe() {  # probe <file> <old> <new> -- <test command...>
  local file="$1" old="$2" new="$3"; shift 4
  local backup; backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path).read()
assert s.count(old) == 1, f"{s.count(old)} occurrences of {old[:60]!r}"
open(path, "w").write(s.replace(old, new))
PYEOF
  "$@"
  cp "$backup" "$file"; rm "$backup"
}
run() { (cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^✖ [a-z]' | sort -u | head -3); }
echo "-- 6 attach from View does not enter Edit"; probe web/dist/app.js 'if (open && isMd(open)) enterMdEdit(open);' '' -- run
echo "-- 7 cards not repainted in View";          probe web/dist/app.js 'if (view && open) { view._source = null; renderMdView(open); }' '' -- run
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)')
```

Expected: kedua probe menggagalkan `attaching a file while a Markdown note is in View...`; baris terakhir `fail 0`.

- [ ] **Step 5: Checkpoint (TANPA commit)**

Run: `git status --short`

---

### Task 6: Halaman share merender note Markdown

**Files:**
- Modify: `web/dist/share.js`, `web/dist/share.html`, `web/dist/share.css`
- Test: `web/e2e/markdown.test.mjs`

**Interfaces:**
- Consumes: `shared/read` dengan `format` (Task 1); `LiteMd.render` (Task 2); `md.js`/`md.css` (Task 3).
- Produces: `.share-content.md` di halaman share untuk note `md`.

- [ ] **Step 1: Tambah test e2e yang gagal**

```bash
cat >> web/e2e/markdown.test.mjs <<'MJSEOF'

// Puts a note on the server for a signed-in context and returns a share link token.
async function sharedNote(ctx, n, title, content, format) {
  const id = uuid(n);
  const now = Date.now();
  const pushed = await ctx.request.post(`${app.base}/api/v1/sync/push`, {
    data: { device_id: 'e2e', mutations: [{ mutation_id: uuid(n + 1), note: { id, title, content, created_at: now, updated_at: now, deleted_at: null, folder_id: '', is_pinned: false, format } }] },
  });
  assert.ok(pushed.ok(), `push failed: HTTP ${pushed.status()}`);
  const shared = await ctx.request.put(`${app.base}/api/v1/notes/${id}/share`, { data: {} });
  assert.ok(shared.ok(), `share failed: HTTP ${shared.status()}`);
  return (await shared.json()).token;
}

test('a shared Markdown note is rendered as Markdown on the share page and stays safe', async () => {
  const owner = await app.newContext();
  await signIn(owner, app.base, 'md-share@example.com');
  const visitor = await app.newContext();
  try {
    const hostile = ['[x](javascript:window.__pwned=1)', '<script>window.__pwned=1</script>', '<img src=x onerror="window.__pwned=1">'].join('\n');
    const token = await sharedNote(owner, 801, 'Doc', `${SAMPLE}\n\n${hostile}`, 'md');

    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-content.md h1').waitFor();
    assert.equal(await page.locator('.share-content.md th').count(), 2);
    assert.equal(await page.locator('.share-content.md ul ul li').count(), 1);
    assert.equal(await page.locator('.share-content.md input[type="checkbox"]').count(), 1);
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'note markup executed');
    assert.equal(await page.locator('#share script, #share a, #share img').count(), 0, 'note markup became elements');
    assert.match((await page.locator('.share-content').textContent()) || '', /<script>window\.__pwned=1<\/script>/);
  } finally {
    await visitor.close();
    await owner.close();
  }
});

test('a shared plain note still shows Markdown-looking text as typed', async () => {
  const owner = await app.newContext();
  await signIn(owner, app.base, 'md-share-plain@example.com');
  const visitor = await app.newContext();
  try {
    const token = await sharedNote(owner, 811, 'Notes', '# not a heading\n**bold** stays bold', 'text');
    const page = await visitor.newPage();
    await page.goto(`${app.base}/s#${token}`);
    await page.locator('.share-title').waitFor();
    assert.equal(await page.locator('#share h1').count(), 1, 'a plain note grew a heading');
    assert.equal(await page.locator('.share-content .content-line').count(), 2);
    assert.equal(await page.locator('.share-content strong').textContent(), 'bold');
  } finally {
    await visitor.close();
    await owner.close();
  }
});
MJSEOF
node --check web/e2e/markdown.test.mjs && echo "e2e file OK"
(cd web/e2e && node --test --test-concurrency=1 --test-name-pattern='shared Markdown note|shared plain note' markdown.test.mjs 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)')
```

Expected: `a shared Markdown note is rendered...` gagal (halaman share masih memperlakukan semua note sebagai teks). `a shared plain note still shows...` lulus (karakterisasi: note `text` tidak boleh berubah).

- [ ] **Step 2: Terapkan patch**

```bash
python3 - <<'PYEOF'
"""Task 6: the public share page renders Markdown notes. Run from the repository root."""


def patch(path, edits):
    s = open(path).read()
    for old, new in edits:
        assert s.count(old) == 1, f"{path}: expected 1 occurrence, found {s.count(old)}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    open(path, "w").write(s)


RENDER_BODY = r'''  const attachmentLabel = (name) => `<span class="attach-label">${PAPERCLIP_SVG}<span class="attach-name">${esc(name)}</span></span>`;

  // Markdown notes use the shared renderer. If it did not load, show the text as it
  // is rather than an empty page.
  function renderBody(note) {
    if (note.format === 'md') {
      if (window.LiteMd) {
        return `<div class="share-content md">${window.LiteMd.render(note.content, { attachment: attachmentLabel })}</div>`;
      }
      return `<div class="share-content">${String(note.content || '').split('\n').map((l) => `<div class="content-line">${esc(l) || '&nbsp;'}</div>`).join('')}</div>`;
    }
    return `<div class="share-content">${renderContent(note.content)}</div>`;
  }

'''

patch("web/dist/share.js", [
    ("  async function load() {\n", RENDER_BODY + "  async function load() {\n"),
    ("    root.innerHTML = `<article><h1 class=\"share-title\">${esc(title)}</h1><div class=\"share-content\">${renderContent(note.content)}</div></article>`;",
     "    root.innerHTML = `<article><h1 class=\"share-title\">${esc(title)}</h1>${renderBody(note)}</article>`;"),
])

# share.js and share.css changed, so their ?v= moves; md.js and md.css share the app's version.
patch("web/dist/share.html", [
    ('<link rel="stylesheet" href="/share.css?v=1">',
     '<link rel="stylesheet" href="/share.css?v=2">\n<link rel="stylesheet" href="/md.css?v=71">'),
    ('<script src="/share.js?v=1" defer></script>',
     '<script src="/md.js?v=71" defer></script>\n<script src="/share.js?v=2" defer></script>'),
])

# md.css uses two custom properties that the share page did not define yet.
patch("web/dist/share.css", [
    ("  --surface-3:#e5e5ea;\n  --border:#e5e5ea;", "  --surface-2:#f2f2f7;\n  --surface-3:#e5e5ea;\n  --border:#e5e5ea;"),
    ("  --accent:#007aff;\n  --folder-yellow", "  --accent:#007aff;\n  --accent-text:#0a3d9e;\n  --folder-yellow"),
    ("    --surface-3:#48484a;\n    --border:#38383a;", "    --surface-2:#3a3a3c;\n    --surface-3:#48484a;\n    --border:#38383a;"),
    ("    --accent:#0a84ff;\n    --ok", "    --accent:#0a84ff;\n    --accent-text:#6ea8ff;\n    --ok"),
])
with open("web/dist/share.css", "a") as css:
    css.write("\n.share-content.md{font-size:16px;line-height:1.65}\n")
print("task 6 share patch applied")
PYEOF
node --check web/dist/share.js && echo "share.js syntax OK"
```

- [ ] **Step 3: Jalankan, pastikan lulus**

```bash
go test ./... -count=1 2>&1 | tail -2
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs share.test.mjs 2>&1 | grep -E '^(✖|ℹ (pass|fail))')
```

Expected: `ok`; `fail 0` (test share lama tetap lulus; halaman share sekarang memuat `md.js` dan `md.css`).

- [ ] **Step 4: Probe**

```bash
probe() {  # probe <file> <old> <new> -- <test command...>
  local file="$1" old="$2" new="$3"; shift 4
  local backup; backup=$(mktemp)
  cp "$file" "$backup"
  python3 - "$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
s = open(path).read()
assert s.count(old) == 1, f"{s.count(old)} occurrences of {old[:60]!r}"
open(path, "w").write(s.replace(old, new))
PYEOF
  "$@"
  cp "$backup" "$file"; rm "$backup"
}
run() { (cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^✖ [a-z]' | sort -u | head -3); }
echo "-- 8 share page ignores the format"; probe web/dist/share.js "if (note.format === 'md') {" 'if (false) {' -- run
(cd web/e2e && node --test --test-concurrency=1 markdown.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)')
```

Expected: probe menggagalkan `a shared Markdown note is rendered as Markdown...`; baris terakhir `fail 0`.

- [ ] **Step 5: Checkpoint (TANPA commit)**

Run: `git status --short`

---

### Task 7: Docs dan verifikasi akhir

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Docs**

```bash
python3 - <<'PYEOF'
"""Task 7: documentation. Run from the repository root."""


def patch(path, edits):
    s = open(path).read()
    for old, new in edits:
        assert s.count(old) == 1, f"{path}: expected 1 occurrence, found {s.count(old)}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    open(path, "w").write(s)


SECTION = """## 📝 Markdown notes

Any note can be a Markdown note. Start one with the Markdown button next to **+** in the note list, or switch an existing note with the Markdown button in its header. The switch only changes how the note is shown; the text is never rewritten, so it can be switched back at any time.

- A Markdown note opens **rendered**. **Edit** shows the exact text in a plain editor and **Done** returns to the rendered view.
- Supported: headings, paragraphs, bold/italic/strikethrough, inline code, fenced code, links, nested lists, task lists (read-only checkboxes), quotes, tables, and horizontal rules.
- Raw HTML is shown as text, only `http` and `https` links are clickable, and remote images appear as labels instead of loading.
- Notes larger than 512 KiB are shown as plain text instead of being rendered.
- The type is stored as the `format` field of the note (`text` or `md`) and syncs like any other field. A shared link to a Markdown note renders it as Markdown.
- The same renderer shows `.md` attachment previews (see below), including tables and nested lists.

---

"""

patch("README.md", [
    ("- 🔗 **Share via Link**:",
     "- 📝 **Markdown Notes**: Switch any note to Markdown, or start one with the Markdown button, and read it rendered by default: headings, nested lists, tables, task lists, code and links. Edit shows the exact text; shared links render Markdown too.\n- 🔗 **Share via Link**:"),
    ("## 🔗 Sharing notes\n", SECTION + "## 🔗 Sharing notes\n"),
    ("| Markdown (`.md`) | Rendered headings, lists, checklists, quotes, links, and code |",
     "| Markdown (`.md`) | Rendered headings, nested lists, tables, task lists, quotes, links, and code |"),
    ("(share.* = public share page)", "(share.* = public share page, md.* = Markdown renderer)"),
])
print("task 7 docs patch applied")
PYEOF
git diff --stat README.md
```

- [ ] **Step 2: Verifikasi penuh (bukti eksekusi)**

```bash
echo "== gofmt =="; gofmt -l cmd/; echo "(empty = clean)"
echo "== build / vet =="; go build ./... && go vet ./... && echo ok
echo "== go test =="; go test ./... -count=1 2>&1 | tail -3
echo "== node --check =="; for f in web/dist/app.js web/dist/sw.js web/dist/share.js web/dist/md.js; do node --check "$f" && echo "ok $f"; done
echo "== no invisible characters in sources =="; grep -c -P '[\x{E000}-\x{E003}\x{FFFD}]' web/dist/md.js web/dist/app.js web/dist/share.js web/e2e/md.test.mjs web/e2e/markdown.test.mjs
echo "== no stale versions =="; grep -rn -E 'v=70|v70|share\.(js|css)\?v=1' web/dist || echo "none"
echo "== e2e + unit (full) =="; (cd web/e2e && npm test 2>&1 | grep -E '^(✖|ℹ (tests|pass|fail))')
```

Expected: `gofmt` kosong; build/vet `ok`; `ok litenotes/cmd/server`; empat `ok <file>`; hitungan karakter tak terlihat `0` untuk tiap file; `none`; e2e penuh `tests 142`, `pass 142`, `fail 0` (101 unit renderer + 31 e2e lama + 10 e2e Markdown).

- [ ] **Step 3: Pemeriksaan visual**

```bash
SHOTDIR=$(mktemp -d)
cat > "$SHOTDIR/shot.mjs" <<'MJSEOF'
import { firstVisit, startApp, signIn } from '/Users/mthidayat/Dev-Labs/litenotes/web/e2e/harness.mjs';

const out = process.argv[2];
const app = await startApp();
try {
  const md = ['# Release notes', '', 'A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).', '',
    '## Table', '', '| name | qty | price |', '|:-----|----:|:-----:|', '| apple | 3 | 1.20 |', '| pear | 12 | 0.80 |', '',
    '## Lists', '', '- one', '  - nested', '    - deeper', '- [x] done', '- [ ] todo', '', '1. first', '2. second', '',
    '> A quote\n> over two lines', '', '```js', 'const answer = 42;', '```', '', '---', '', 'Done.'].join('\n');
  const ctx = await app.newContext();
  await signIn(ctx, app.base, 'shot-md@example.com');
  const id = '44444444-4444-4444-8444-000000000001';
  const now = Date.now();
  await ctx.request.post(`${app.base}/api/v1/sync/push`, { data: { device_id: 'shot', mutations: [{ mutation_id: '44444444-4444-4444-8444-000000000002', note: { id, title: 'Release notes', content: md, created_at: now, updated_at: now, deleted_at: null, folder_id: '', is_pinned: false, format: 'md' } }] } });
  const { token } = await (await ctx.request.put(`${app.base}/api/v1/notes/${id}/share`, { data: {} })).json();
  for (const scheme of ['light', 'dark']) {
    for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 800 }]]) {
      const view = await app.newContext();
      await signIn(view, app.base, 'shot-md@example.com');
      const page = await view.newPage();
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await firstVisit(page, app.base);
      await page.goto(`${app.base}/#/notes/${id}`);
      await page.locator('#md-view h1').waitFor();
      await page.screenshot({ path: `${out}/note-${scheme}-${name}.png` });
      const shared = await app.newContext();
      const sp = await shared.newPage();
      await sp.setViewportSize(viewport);
      await sp.emulateMedia({ colorScheme: scheme });
      await sp.goto(`${app.base}/s#${token}`);
      await sp.locator('.share-content.md h1').waitFor();
      await sp.screenshot({ path: `${out}/share-${scheme}-${name}.png` });
      const overflow = await sp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      console.log(`${scheme}-${name}: share page horizontal overflow = ${overflow}`);
      await view.close(); await shared.close();
    }
  }
} finally {
  await app.stop();
}
MJSEOF
(cd web/e2e && node "$SHOTDIR/shot.mjs" "$SHOTDIR") && ls "$SHOTDIR"/*.png
echo "$SHOTDIR"
```

Lalu `Read` tiap PNG (`note-light-desktop`, `note-dark-desktop`, `note-light-phone`, `note-dark-phone`, dan empat `share-*`) dan periksa: heading, table (alignment kolom, scroll horizontal di phone bila lebar), nested list, checkbox, quote, code block terbaca; kontras dark mode wajar; tidak ada horizontal overflow di halaman share. Perbaiki `md.css` bila ada yang jelek, lalu jalankan ulang Step 2 dan naikkan versi aset bila `md.css` berubah setelah titik ini (di `index.html`, `sw.js`, dan `share.html`, serta test `TestShellVersionsAgree` akan menjaganya).

- [ ] **Step 4: Cek spec vs hasil**

Buka `docs/superpowers/specs/2026-10-08-markdown-note-design.md` dan centang tiap butir terhadap kode: kolom `format` dan aturan kosong, validasi, `shared/read` 4 key, `md.js` (cakupan, keamanan, batas), `md.css`, aset dan versi 71, tombol New Markdown note di header mobile dan desktop, toggle (tersembunyi untuk note locked), Edit/Done, bypass `normalizeContent`/`canonicalContent`, attachment di View, render ulang View saat sync, halaman share, backup export/import (`format`), README. Jika ada butir yang tidak sesuai, perbaiki kodenya kecuali spec yang salah; kalau spec yang diubah, sebut di laporan.

- [ ] **Step 5: Checkpoint akhir (TANPA commit)**

Run: `git status --short && git diff --stat`
Laporkan ke owner: file yang berubah, hasil verifikasi Step 2 apa adanya, hasil pemeriksaan visual, hal yang belum diverifikasi (Safari/Firefox, Turso Cloud, perilaku Markdown di perangkat sentuh), dan "belum saya commit".
