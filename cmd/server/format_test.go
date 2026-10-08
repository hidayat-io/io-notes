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
