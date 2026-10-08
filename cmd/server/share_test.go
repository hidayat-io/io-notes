package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
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
