package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/* ------------------------------------------------------------- test setup */

func newTestApp(t *testing.T) *application {
	t.Helper()
	cfg := config{
		Port: "0", AppOrigin: "http://127.0.0.1:8091", AppEnv: "test", AuthMode: "dev",
		SessionSecret: "test-secret-that-is-long-enough-32", SessionTTL: time.Hour,
		DatabaseURL: "file:" + filepath.Join(t.TempDir(), "test.db"),
	}
	db, err := openDB(cfg)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := migrate(db); err != nil {
		t.Fatalf("migrate on empty database: %v", err)
	}
	return newApplication(cfg, db, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
}

func TestValidateDatabaseConfig(t *testing.T) {
	cases := []struct {
		name    string
		cfg     config
		env     map[string]string
		wantErr bool
	}{
		{
			name: "dev file ok",
			cfg:  config{AppEnv: "development", DatabaseURL: "file:./data/litenotes.db"},
		},
		{
			name:    "remote without token",
			cfg:     config{AppEnv: "development", DatabaseURL: "libsql://demo-org.turso.io"},
			wantErr: true,
		},
		{
			name: "remote with token",
			cfg:  config{AppEnv: "development", DatabaseURL: "libsql://demo-org.turso.io", TursoToken: "tok"},
		},
		{
			name:    "production file blocked",
			cfg:     config{AppEnv: "production", DatabaseURL: "file:/opt/litenotes/data/litenotes.db"},
			wantErr: true,
		},
		{
			name: "production file escape hatch",
			cfg:  config{AppEnv: "production", DatabaseURL: "file:/opt/litenotes/data/litenotes.db"},
			env:  map[string]string{"ALLOW_LOCAL_SQLITE": "1"},
		},
		{
			name: "production remote ok",
			cfg:  config{AppEnv: "production", DatabaseURL: "libsql://demo-org.turso.io", TursoToken: "tok"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			err := validateDatabaseConfig(tc.cfg)
			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestLibsqlDSNEncodesAuthToken(t *testing.T) {
	t.Parallel()
	dsn, err := libsqlDSN("libsql://demo-org.turso.io", "a+b/c=d")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dsn, "authToken=") {
		t.Fatalf("token not present in dsn: %s", dsn)
	}
	if !strings.Contains(dsn, "%2B") || !strings.Contains(dsn, "%2F") || !strings.Contains(dsn, "%3D") {
		t.Fatalf("authToken not percent-encoded: %s", dsn)
	}
}

func TestSplitSQLStatements(t *testing.T) {
	t.Parallel()
	src := `
-- header
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS a (id TEXT);
CREATE INDEX IF NOT EXISTS idx_a ON a(id);
`
	got := splitSQLStatements(src)
	if len(got) != 3 {
		t.Fatalf("got %d statements: %#v", len(got), got)
	}
	if !strings.HasPrefix(got[0], "PRAGMA") {
		t.Fatalf("first statement: %q", got[0])
	}
}

func TestMigrateIdempotent(t *testing.T) {
	cfg := config{DatabaseURL: "file:" + filepath.Join(t.TempDir(), "migrate.db")}
	db, err := openDB(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := migrate(db); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("second migrate (idempotent): %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("notes table count=%d", n)
	}
}

func (a *application) mustUser(t *testing.T, sub, email string) user {
	t.Helper()
	u, err := a.upsertUser(context.Background(), sub, email, email, nil)
	if err != nil {
		t.Fatalf("upsertUser: %v", err)
	}
	return u
}

// do issues an authenticated request through the full router.
func (a *application) do(t *testing.T, u user, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload io.Reader
	if body != nil {
		payload = strings.NewReader(string(mustJSON(body)))
	}
	r := httptest.NewRequest(method, path, payload)
	r.Header.Set("Content-Type", "application/json")
	if u.ID != "" {
		claims := jwtClaims{Subject: u.ID, Issuer: "litenotes", Audience: "litenotes-web", IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()}
		r.AddCookie(&http.Cookie{Name: cookieName(a.cfg), Value: signJWT(claims, a.cfg.SessionSecret)})
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func testUUID(n int) string { return fmt.Sprintf("11111111-1111-4111-8111-%012d", n) }

func pushOne(t *testing.T, a *application, u user, id string, updatedAt int64, title string, deleted *int64) map[string]any {
	t.Helper()
	m := mutation{MutationID: testUUID(int(time.Now().UnixNano() % 1e12)), Note: noteInput{
		ID: id, Title: title, Content: "body", CreatedAt: 1000, UpdatedAt: updatedAt, DeletedAt: deleted,
	}}
	w := a.do(t, u, "POST", "/api/v1/sync/push", map[string]any{"device_id": "dev", "mutations": []mutation{m}})
	if w.Code != 200 {
		t.Fatalf("push %s: status %d body %s", id, w.Code, w.Body.String())
	}
	var out struct {
		Results []map[string]any `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode push: %v", err)
	}
	return out.Results[0]
}

/* ------------------------------------------------------- 18.1 LWW compare */

func TestCompareLWW(t *testing.T) {
	base := note{UpdatedAt: 100, MutationID: "bbb"}
	cases := []struct {
		name string
		a, b note
		want int
	}{
		{"newer wins", note{UpdatedAt: 200, MutationID: "aaa"}, base, 1},
		{"older loses", note{UpdatedAt: 50, MutationID: "zzz"}, base, -1},
		{"tie broken by higher mutation_id", note{UpdatedAt: 100, MutationID: "ccc"}, base, 1},
		{"tie broken by lower mutation_id", note{UpdatedAt: 100, MutationID: "aaa"}, base, -1},
		{"exact retry is equal", note{UpdatedAt: 100, MutationID: "bbb"}, base, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := compare(tc.a, tc.b); got != tc.want {
				t.Fatalf("compare = %d, want %d", got, tc.want)
			}
		})
	}
}

/* ------------------------------------------------------- 18.1 validation */

func TestValidateMutation(t *testing.T) {
	now := int64(1_700_000_000_000)
	ok := mutation{MutationID: testUUID(1), Note: noteInput{ID: testUUID(2), CreatedAt: 1000, UpdatedAt: 2000}}
	deletedMismatch := int64(999)
	deletedOK := int64(2000)

	cases := []struct {
		name    string
		mutate  func(m *mutation)
		wantErr bool
		code    string
	}{
		{"valid", func(*mutation) {}, false, ""},
		{"valid soft delete", func(m *mutation) { m.Note.DeletedAt = &deletedOK }, false, ""},
		{"lowercase hex uuid accepted", func(m *mutation) { m.Note.ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }, false, ""},
		{"uppercase uuid rejected", func(m *mutation) { m.Note.ID = "3F2504E0-4F89-41D3-9A0C-0305E82C3301" }, true, "VALIDATION_ERROR"},
		{"non-v4 uuid rejected", func(m *mutation) { m.Note.ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }, true, "VALIDATION_ERROR"},
		{"non-uuid rejected", func(m *mutation) { m.MutationID = "not-a-uuid" }, true, "VALIDATION_ERROR"},
		{"title over 500 runes", func(m *mutation) { m.Note.Title = strings.Repeat("é", 501) }, true, "VALIDATION_ERROR"},
		{"title exactly 500 runes", func(m *mutation) { m.Note.Title = strings.Repeat("é", 500) }, false, ""},
		{"content over 1MB", func(m *mutation) { m.Note.Content = strings.Repeat("x", 1_000_001) }, true, "VALIDATION_ERROR"},
		{"updated before created", func(m *mutation) { m.Note.UpdatedAt = 500 }, true, "VALIDATION_ERROR"},
		{"deleted_at must equal updated_at", func(m *mutation) { m.Note.DeletedAt = &deletedMismatch }, true, "VALIDATION_ERROR"},
		{"timestamp beyond MAX_SAFE_INTEGER", func(m *mutation) { m.Note.UpdatedAt = maxSafeInteger + 1 }, true, "VALIDATION_ERROR"},
		{"clock skew past grace", func(m *mutation) { m.Note.UpdatedAt = now + clockSkewGrace + 1 }, true, "CLOCK_SKEW"},
		{"clock skew inside grace", func(m *mutation) { m.Note.UpdatedAt = now + clockSkewGrace - 1 }, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := ok
			tc.mutate(&m)
			err := validateMutation(m, now)
			if tc.wantErr != (err != nil) {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				ve, isVE := err.(validationError)
				if !isVE || ve.code != tc.code {
					t.Fatalf("got %#v, want code %s", err, tc.code)
				}
			}
		})
	}
}

func TestPushRejectsClockSkewWith422(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-skew", "skew@example.com")
	future := time.Now().UnixMilli() + clockSkewGrace + 60_000
	m := mutation{MutationID: testUUID(1), Note: noteInput{ID: testUUID(2), CreatedAt: 1000, UpdatedAt: future}}
	w := a.do(t, u, "POST", "/api/v1/sync/push", map[string]any{"device_id": "d", "mutations": []mutation{m}})
	if w.Code != 422 {
		t.Fatalf("status = %d, want 422; body %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "CLOCK_SKEW") {
		t.Fatalf("body missing CLOCK_SKEW: %s", w.Body.String())
	}
}

/* -------------------------------------------------------------- 18.1 JWT */

func TestVerifyJWT(t *testing.T) {
	secret := "test-secret-that-is-long-enough-32"
	valid := jwtClaims{Subject: "u1", Issuer: "litenotes", Audience: "litenotes-web", IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()}

	t.Run("valid", func(t *testing.T) {
		if _, err := verifyJWT(signJWT(valid, secret), secret); err != nil {
			t.Fatalf("valid token rejected: %v", err)
		}
	})
	t.Run("expired", func(t *testing.T) {
		c := valid
		c.ExpiresAt = time.Now().Add(-time.Minute).Unix()
		if _, err := verifyJWT(signJWT(c, secret), secret); err == nil {
			t.Fatal("expired token accepted")
		}
	})
	t.Run("wrong issuer", func(t *testing.T) {
		c := valid
		c.Issuer = "evil"
		if _, err := verifyJWT(signJWT(c, secret), secret); err == nil {
			t.Fatal("wrong issuer accepted")
		}
	})
	t.Run("wrong audience", func(t *testing.T) {
		c := valid
		c.Audience = "someone-else"
		if _, err := verifyJWT(signJWT(c, secret), secret); err == nil {
			t.Fatal("wrong audience accepted")
		}
	})
	t.Run("wrong secret", func(t *testing.T) {
		if _, err := verifyJWT(signJWT(valid, secret), "another-secret-entirely-32-chars!!"); err == nil {
			t.Fatal("token signed with another secret accepted")
		}
	})
	t.Run("tampered payload", func(t *testing.T) {
		parts := strings.Split(signJWT(valid, secret), ".")
		parts[1] = parts[1][:len(parts[1])-2] + "AA"
		if _, err := verifyJWT(strings.Join(parts, "."), secret); err == nil {
			t.Fatal("tampered payload accepted")
		}
	})
	t.Run("alg none", func(t *testing.T) {
		parts := strings.Split(signJWT(valid, secret), ".")
		if _, err := verifyJWT(parts[0]+"."+parts[1]+".", secret); err == nil {
			t.Fatal("unsigned token accepted")
		}
	})
	t.Run("malformed", func(t *testing.T) {
		if _, err := verifyJWT("garbage", secret); err == nil {
			t.Fatal("malformed token accepted")
		}
	})
}

/* ---------------------------------------------------------- 18.1 decoder */

func TestDecodeJSON(t *testing.T) {
	type target struct {
		Name string `json:"name"`
	}
	newReq := func(body string) *http.Request {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return r
	}
	t.Run("accepts known fields", func(t *testing.T) {
		var v target
		if err := decodeJSON(newReq(`{"name":"a"}`), &v, 1024); err != nil {
			t.Fatalf("unexpected: %v", err)
		}
	})
	t.Run("rejects unknown field", func(t *testing.T) {
		var v target
		if err := decodeJSON(newReq(`{"name":"a","evil":1}`), &v, 1024); err == nil {
			t.Fatal("unknown field accepted")
		}
	})
	t.Run("rejects trailing json", func(t *testing.T) {
		var v target
		if err := decodeJSON(newReq(`{"name":"a"}{"name":"b"}`), &v, 1024); err == nil {
			t.Fatal("trailing json accepted")
		}
	})
	t.Run("rejects oversized body", func(t *testing.T) {
		var v target
		big := `{"name":"` + strings.Repeat("x", 4096) + `"}`
		if err := decodeJSON(newReq(big), &v, 64); err == nil {
			t.Fatal("oversized body accepted")
		}
	})
	t.Run("rejects wrong content type", func(t *testing.T) {
		var v target
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"a"}`))
		r.Header.Set("Content-Type", "text/plain")
		if err := decodeJSON(r, &v, 1024); err == nil {
			t.Fatal("non-json content type accepted")
		}
	})
}

/* ------------------------------------------------- 18.1 static + headers */

func TestStaticFallbackDoesNotServeHTMLForMissingAssets(t *testing.T) {
	a := newTestApp(t)
	for _, path := range []string{"/missing.js", "/missing.css"} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatalf("%s: status = %d, want 404", path, w.Code)
		}
		if strings.Contains(w.Body.String(), "<!doctype html") {
			t.Fatalf("%s: served the SPA shell instead of 404", path)
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	a := newTestApp(t)
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	want := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "strict-origin-when-cross-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
	}
	for k, v := range want {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	csp := w.Header().Get("Content-Security-Policy")
	for _, needle := range []string{"default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "frame-src 'self'", "https://accounts.google.com/gsi/client"} {
		if !strings.Contains(csp, needle) {
			t.Errorf("CSP missing %q; got %s", needle, csp)
		}
	}
	if strings.Contains(csp, "unsafe-eval") {
		t.Errorf("CSP must never allow eval; got %s", csp)
	}
	// style-src carries 'unsafe-inline' for Google Identity Services, but script-src
	// must stay hash-locked. Guard that the relaxation never leaks into scripts.
	for _, directive := range strings.Split(csp, ";") {
		d := strings.TrimSpace(directive)
		if strings.HasPrefix(d, "script-src") && strings.Contains(d, "unsafe-inline") {
			t.Errorf("script-src must not allow inline scripts; got %s", d)
		}
	}
}

// The shipped index.html bootstraps the theme inline; the CSP has to cover it by
// hash or the app renders unstyled for anyone on a stored dark theme.
func TestCSPCoversInlineScripts(t *testing.T) {
	indexHTML, err := readEmbeddedIndex()
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	if !strings.Contains(string(indexHTML), "<script>") {
		t.Skip("no inline script in index.html")
	}
	if !strings.Contains(cspFor(indexHTML, config{}), "'sha256-") {
		t.Fatal("CSP has no hash for the inline bootstrap script")
	}
}

func TestRouteTemplateStripsIdentifiers(t *testing.T) {
	got := routeTemplate("/api/v1/notes/3f2504e0-4f89-41d3-9a0c-0305e82c3301/password")
	if got != "/api/v1/notes/{id}/password" {
		t.Fatalf("routeTemplate = %q", got)
	}
}

/* ------------------------------------------------------ 18.1 rate limits */

func TestLimiterBurstThenRefill(t *testing.T) {
	l := &limiter{buckets: map[string]*bucket{}, rate: 60.0 / 60, burst: 3} // 1/s, burst 3
	for i := 0; i < 3; i++ {
		if ok, _ := l.allow("k"); !ok {
			t.Fatalf("request %d denied inside burst", i+1)
		}
	}
	ok, wait := l.allow("k")
	if ok {
		t.Fatal("burst exceeded but request allowed")
	}
	if wait <= 0 {
		t.Fatal("denied without a Retry-After hint")
	}
	// Keys are independent.
	if ok, _ := l.allow("other"); !ok {
		t.Fatal("a different key was throttled")
	}
	l.buckets["k"].last = time.Now().Add(-2 * time.Second)
	if ok, _ := l.allow("k"); !ok {
		t.Fatal("bucket did not refill over time")
	}
}

func TestLoginIsRateLimited(t *testing.T) {
	a := newTestApp(t)
	var lastCode int
	for i := 0; i < 30; i++ {
		w := a.do(t, user{}, "POST", "/api/v1/auth/dev", map[string]any{"email": "a@b.c", "name": "A"})
		lastCode = w.Code
		if w.Code == 429 {
			if w.Header().Get("Retry-After") == "" {
				t.Fatal("429 without Retry-After")
			}
			return
		}
	}
	t.Fatalf("login never rate limited; last status %d", lastCode)
}

/* ------------------------------------------- 18.2 repository integration */

func TestPushRevisionAccounting(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-a", "a@example.com")
	id := testUUID(7)

	first := pushOne(t, a, u, id, 2000, "v1", nil)
	if first["status"] != "applied" {
		t.Fatalf("first push status = %v", first["status"])
	}
	rev1 := revisionOf(t, first)

	// An older mutation must lose and must not consume a revision.
	older := pushOne(t, a, u, id, 1500, "stale", nil)
	if older["status"] != "superseded" {
		t.Fatalf("older push status = %v, want superseded", older["status"])
	}
	if got := revisionOf(t, older); got != rev1 {
		t.Fatalf("superseded push moved revision %d -> %d", rev1, got)
	}

	// A newer mutation wins and takes exactly one revision.
	newer := pushOne(t, a, u, id, 3000, "v2", nil)
	if newer["status"] != "applied" {
		t.Fatalf("newer push status = %v", newer["status"])
	}
	if got := revisionOf(t, newer); got != rev1+1 {
		t.Fatalf("revision = %d, want %d", got, rev1+1)
	}
}

func TestPushWritesPreviousNoteToAuditHistory(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-audit", "audit@example.com")
	id := testUUID(9)
	pushOne(t, a, u, id, 2000, "before", nil)
	m := mutation{MutationID: testUUID(10), Note: noteInput{ID: id, Title: "after", Content: "new content", CreatedAt: 1000, UpdatedAt: 3000}}
	if w := a.do(t, u, "POST", "/api/v1/sync/push", map[string]any{"device_id": "dev", "mutations": []mutation{m}}); w.Code != 200 {
		t.Fatalf("second push: %d %s", w.Code, w.Body.String())
	}
	var title, content string
	if err := a.db.QueryRow("SELECT title,content FROM note_audit WHERE user_id=? AND note_id=? ORDER BY id DESC LIMIT 1", u.ID, id).Scan(&title, &content); err != nil {
		t.Fatalf("audit row: %v", err)
	}
	if title != "before" || content != "body" {
		t.Fatalf("audit snapshot = %q/%q, want before/body", title, content)
	}
	w := a.do(t, u, "GET", "/api/v1/notes/"+id+"/history", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "before") || !strings.Contains(w.Body.String(), "body") {
		t.Fatalf("history response = %d %s", w.Code, w.Body.String())
	}
}

func TestDeleteAndRestoreEachCreateRevisions(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-d", "d@example.com")
	id := testUUID(8)
	pushOne(t, a, u, id, 2000, "keep", nil)

	del := int64(3000)
	deleted := pushOne(t, a, u, id, 3000, "keep", &del)
	if deleted["status"] != "applied" {
		t.Fatalf("delete status = %v", deleted["status"])
	}
	restored := pushOne(t, a, u, id, 4000, "keep", nil)
	if restored["status"] != "applied" {
		t.Fatalf("restore status = %v", restored["status"])
	}
	if revisionOf(t, restored) <= revisionOf(t, deleted) {
		t.Fatal("restore did not create a newer revision")
	}
}

func TestPullPaginationCoversEveryNote(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-p", "p@example.com")
	const total = 12
	for i := 0; i < total; i++ {
		pushOne(t, a, u, testUUID(100+i), int64(2000+i), fmt.Sprintf("n%d", i), nil)
	}

	seen := map[string]bool{}
	cursor := int64(0)
	for page := 0; page < 20; page++ {
		w := a.do(t, u, "GET", fmt.Sprintf("/api/v1/sync/pull?cursor=%d&limit=5", cursor), nil)
		if w.Code != 200 {
			t.Fatalf("pull: %d %s", w.Code, w.Body.String())
		}
		var out struct {
			Notes      []note `json:"notes"`
			NextCursor int64  `json:"next_cursor"`
			HasMore    bool   `json:"has_more"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode pull: %v", err)
		}
		for _, n := range out.Notes {
			if seen[n.ID] {
				t.Fatalf("note %s returned twice", n.ID)
			}
			seen[n.ID] = true
		}
		cursor = out.NextCursor
		if !out.HasMore {
			break
		}
	}
	if len(seen) != total {
		t.Fatalf("pull returned %d notes, want %d", len(seen), total)
	}
}

// PRD 14.2: the most important rule in the whole service.
func TestUsersAreIsolated(t *testing.T) {
	a := newTestApp(t)
	alice := a.mustUser(t, "sub-alice", "alice@example.com")
	bob := a.mustUser(t, "sub-bob", "bob@example.com")

	secret := testUUID(200)
	pushOne(t, a, alice, secret, 2000, "alice private", nil)

	w := a.do(t, bob, "GET", "/api/v1/sync/pull?cursor=0&limit=100", nil)
	if strings.Contains(w.Body.String(), "alice private") {
		t.Fatalf("bob pulled alice's note: %s", w.Body.String())
	}

	// Bob writing to the same note id must create his own row, not touch Alice's.
	pushOne(t, a, bob, secret, 5000, "bob overwrite", nil)
	var aliceTitle string
	if err := a.db.QueryRow("SELECT title FROM notes WHERE user_id=? AND id=?", alice.ID, secret).Scan(&aliceTitle); err != nil {
		t.Fatalf("read alice note: %v", err)
	}
	if aliceTitle != "alice private" {
		t.Fatalf("alice's note was overwritten by bob: %q", aliceTitle)
	}

	// Bob must not be able to lock or read Alice's note through the note endpoints.
	if w := a.do(t, bob, "POST", "/api/v1/notes/"+secret+"/unlock", map[string]any{"password": "x"}); w.Code == 200 {
		// Bob owns his own row with the same id, so a 200 here is his note, not Alice's.
		var bobTitle string
		_ = a.db.QueryRow("SELECT title FROM notes WHERE user_id=? AND id=?", bob.ID, secret).Scan(&bobTitle)
		if bobTitle != "bob overwrite" {
			t.Fatalf("unlock crossed the user boundary")
		}
	}
}

func TestUnauthenticatedAccessIsRejected(t *testing.T) {
	a := newTestApp(t)
	for _, path := range []string{"/api/v1/me", "/api/v1/folders", "/api/v1/sync/pull?cursor=0"} {
		if w := a.do(t, user{}, "GET", path, nil); w.Code != 401 {
			t.Errorf("%s: status = %d, want 401", path, w.Code)
		}
	}
}

// Regression: deleting a folder detaches notes, and that detach has to be pullable.
func TestDeleteFolderBumpsNoteRevisions(t *testing.T) {
	a := newTestApp(t)
	u := a.mustUser(t, "sub-f", "f@example.com")

	w := a.do(t, u, "POST", "/api/v1/folders", map[string]any{"name": "Kerja"})
	if w.Code != 200 {
		t.Fatalf("create folder: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Folder folder `json:"folder"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode folder: %v", err)
	}

	id := testUUID(300)
	m := mutation{MutationID: testUUID(301), Note: noteInput{ID: id, Title: "in folder", CreatedAt: 1000, UpdatedAt: 2000, FolderID: created.Folder.ID}}
	if w := a.do(t, u, "POST", "/api/v1/sync/push", map[string]any{"device_id": "d", "mutations": []mutation{m}}); w.Code != 200 {
		t.Fatalf("push: %d %s", w.Code, w.Body.String())
	}

	var revBefore int64
	if err := a.db.QueryRow("SELECT revision FROM notes WHERE user_id=? AND id=?", u.ID, id).Scan(&revBefore); err != nil {
		t.Fatalf("read revision: %v", err)
	}

	if w := a.do(t, u, "DELETE", "/api/v1/folders/"+created.Folder.ID, nil); w.Code != 200 {
		t.Fatalf("delete folder: %d %s", w.Code, w.Body.String())
	}

	var revAfter int64
	var folderID string
	if err := a.db.QueryRow("SELECT revision, folder_id FROM notes WHERE user_id=? AND id=?", u.ID, id).Scan(&revAfter, &folderID); err != nil {
		t.Fatalf("read after delete: %v", err)
	}
	if folderID != "" {
		t.Fatalf("note still points at the deleted folder: %q", folderID)
	}
	if revAfter <= revBefore {
		t.Fatalf("revision %d -> %d: the detach is invisible to pull", revBefore, revAfter)
	}

	// And it must actually come back from a pull positioned just before the change.
	w = a.do(t, u, "GET", fmt.Sprintf("/api/v1/sync/pull?cursor=%d&limit=50", revBefore), nil)
	if !strings.Contains(w.Body.String(), id) {
		t.Fatalf("pull after cursor %d missed the detached note: %s", revBefore, w.Body.String())
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	a := newTestApp(t)
	if err := migrate(a.db); err != nil {
		t.Fatalf("second migrate failed: %v", err)
	}
}

/* ------------------------------------------------------------- utilities */

func revisionOf(t *testing.T, result map[string]any) int64 {
	t.Helper()
	n, ok := result["note"].(map[string]any)
	if !ok {
		t.Fatalf("result has no note: %#v", result)
	}
	rev, ok := n["revision"].(float64)
	if !ok {
		t.Fatalf("note has no revision: %#v", n)
	}
	return int64(rev)
}
