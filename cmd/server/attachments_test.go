package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

/* ---------------------------------------------------------- fake store */

type fakeStore struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func newFakeStore() *fakeStore { return &fakeStore{objs: map[string][]byte{}} }

func (f *fakeStore) PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error) {
	return "fake://put/" + key, nil
}
func (f *fakeStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.objs[key]
	if !ok {
		return nil, errors.New("not found")
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}
func (f *fakeStore) Head(ctx context.Context, key string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.objs[key]
	if !ok {
		return 0, errors.New("not found")
	}
	return int64(len(b)), nil
}
func (f *fakeStore) Delete(ctx context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objs, key)
	return nil
}
func (f *fakeStore) put(key string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objs[key] = data
}
func (f *fakeStore) has(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objs[key]
	return ok
}

func newAttachApp(t *testing.T, store objectStore, mutate func(*config)) *application {
	t.Helper()
	cfg := config{
		Port: "0", AppOrigin: "http://127.0.0.1:8091", AppEnv: "test", AuthMode: "dev",
		SessionSecret: "test-secret-that-is-long-enough-32", SessionTTL: time.Hour,
		DatabaseURL:            "file:" + filepath.Join(t.TempDir(), "test.db"),
		AttachMaxBytes:         2000,
		AttachUserQuotaBytes:   2000,
		AttachGlobalCapBytes:   10000,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	db, err := openDB(cfg)
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return newApplication(cfg, db, slog.New(slog.NewTextHandler(io.Discard, nil)), store)
}

func createAttach(t *testing.T, a *application, u user, filename, contentType string, size int64) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, u, "POST", "/api/v1/attachments", map[string]any{"filename": filename, "content_type": contentType, "size_bytes": size})
}

func decodeAttach(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

/* ------------------------------------------------------------ tests */

func TestAttachHappyPath(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")

	w := createAttach(t, a, u, "foto.png", "image/png", 100)
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	out := decodeAttach(t, w)
	att := out["attachment"].(map[string]any)
	id := att["id"].(string)
	if att["status"].(string) != "pending" || out["upload_url"] == "" {
		t.Fatalf("unexpected create response: %v", out)
	}

	fs.put(u.ID+"/"+id, make([]byte, 100))
	w = a.do(t, u, "POST", "/api/v1/attachments/"+id+"/confirm", map[string]any{})
	if w.Code != 200 {
		t.Fatalf("confirm: %d %s", w.Code, w.Body.String())
	}

	w = a.do(t, u, "GET", "/api/v1/attachments", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "foto.png") {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Attachments []map[string]any `json:"attachments"`
		Quota       map[string]int64 `json:"quota"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Attachments) != 1 || list.Quota["used_bytes"] != 100 {
		t.Fatalf("list quota: %s", w.Body.String())
	}

	w = a.do(t, u, "GET", "/api/v1/attachments/"+id+"/download", nil)
	if w.Code != 200 || w.Body.Len() != 100 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("download: %d len=%d ct=%s", w.Code, w.Body.Len(), w.Header().Get("Content-Type"))
	}

	// confirm is idempotent
	w = a.do(t, u, "POST", "/api/v1/attachments/"+id+"/confirm", map[string]any{})
	if w.Code != 200 {
		t.Fatalf("idempotent confirm: %d", w.Code)
	}
}

func TestAttachQuotaCountsPending(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")

	if w := createAttach(t, a, u, "a.png", "image/png", 1500); w.Code != 200 {
		t.Fatalf("first create: %d %s", w.Code, w.Body.String())
	}
	// pending already reserves quota
	w := createAttach(t, a, u, "b.png", "image/png", 1000)
	if w.Code != 413 || !strings.Contains(w.Body.String(), "QUOTA_EXCEEDED") {
		t.Fatalf("quota: %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["quota_bytes"] == nil || out["used_bytes"] == nil {
		t.Fatalf("quota fields missing: %s", w.Body.String())
	}
}

func TestAttachGlobalCap(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, func(c *config) { c.AttachGlobalCapBytes = 2000 })
	alice := a.mustUser(t, "dev:alice", "alice@test.local")
	bob := a.mustUser(t, "dev:bob", "bob@test.local")

	if w := createAttach(t, a, alice, "a.png", "image/png", 1500); w.Code != 200 {
		t.Fatalf("alice create: %d", w.Code)
	}
	w := createAttach(t, a, bob, "b.png", "image/png", 1000)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "STORAGE_FULL") {
		t.Fatalf("global cap: %d %s", w.Code, w.Body.String())
	}
}

func TestAttachValidation(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")

	if w := createAttach(t, a, u, "page.html", "text/html", 10); w.Code != 400 {
		t.Fatalf("text/html: %d", w.Code)
	}
	if w := createAttach(t, a, u, "evil.exe", "application/octet-stream", 10); w.Code != 400 {
		t.Fatalf("exe: %d", w.Code)
	}
	if w := createAttach(t, a, u, "big.png", "image/png", 5000); w.Code != 413 || !strings.Contains(w.Body.String(), "PAYLOAD_TOO_LARGE") {
		t.Fatalf("size: %d %s", w.Code, w.Body.String())
	}
	if w := createAttach(t, a, u, "zero.png", "image/png", 0); w.Code != 400 {
		t.Fatalf("zero size: %d", w.Code)
	}
	if w := createAttach(t, a, u, "notafile.png", "image/jpeg", 10); w.Code != 400 {
		t.Fatalf("ext mismatch: %d", w.Code)
	}
}

func TestAttachConfirmMismatchFreesQuota(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")

	w := createAttach(t, a, u, "a.png", "image/png", 100)
	if w.Code != 200 {
		t.Fatalf("create: %d", w.Code)
	}
	id := decodeAttach(t, w)["attachment"].(map[string]any)["id"].(string)
	fs.put(u.ID+"/"+id, make([]byte, 50))

	w = a.do(t, u, "POST", "/api/v1/attachments/"+id+"/confirm", map[string]any{})
	if w.Code != 400 || !strings.Contains(w.Body.String(), "UPLOAD_MISMATCH") {
		t.Fatalf("mismatch: %d %s", w.Code, w.Body.String())
	}
	if fs.has(u.ID + "/" + id) {
		t.Fatal("object not cleaned after mismatch")
	}
	// quota freed: a 2000-byte upload now fits
	if w := createAttach(t, a, u, "b.png", "image/png", 1000); w.Code != 200 {
		t.Fatalf("quota after mismatch: %d %s", w.Code, w.Body.String())
	}
}

func TestAttachConfirmIncomplete(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")

	w := createAttach(t, a, u, "a.png", "image/png", 100)
	id := decodeAttach(t, w)["attachment"].(map[string]any)["id"].(string)
	w = a.do(t, u, "POST", "/api/v1/attachments/"+id+"/confirm", map[string]any{})
	if w.Code != 400 || !strings.Contains(w.Body.String(), "UPLOAD_INCOMPLETE") {
		t.Fatalf("incomplete: %d %s", w.Code, w.Body.String())
	}
}

func TestAttachSweepPendingAndDeleted(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")
	old := time.Now().Add(-2 * time.Hour).UnixMilli()

	if _, err := a.db.Exec("INSERT INTO attachments (user_id,id,filename,content_type,size_bytes,kind,status,created_at) VALUES (?,?,?,?,10,'image','pending',?)", u.ID, testUUID(901), "old.png", "image/png", old); err != nil {
		t.Fatal(err)
	}
	fs.put(u.ID+"/"+testUUID(901), make([]byte, 10))

	// fresh pending must survive
	w := createAttach(t, a, u, "fresh.png", "image/png", 10)
	if w.Code != 200 {
		t.Fatalf("fresh create: %d", w.Code)
	}
	freshID := decodeAttach(t, w)["attachment"].(map[string]any)["id"].(string)

	if err := a.sweepAttachments(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var n int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM attachments WHERE id=?", testUUID(901)).Scan(&n); err != nil || n != 0 {
		t.Fatalf("old pending not swept: n=%d err=%v", n, err)
	}
	if fs.has(u.ID + "/" + testUUID(901)) {
		t.Fatal("old object not deleted")
	}
	if err := a.db.QueryRow("SELECT COUNT(*) FROM attachments WHERE id=?", freshID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("fresh pending swept by mistake: n=%d", n)
	}

	// soft-deleted rows are swept after retention
	fs.put(u.ID+"/"+freshID, make([]byte, 10))
	if w = a.do(t, u, "POST", "/api/v1/attachments/"+freshID+"/confirm", map[string]any{}); w.Code != 200 {
		t.Fatalf("confirm fresh: %d %s", w.Code, w.Body.String())
	}
	w = a.do(t, u, "DELETE", "/api/v1/attachments/"+freshID, nil)
	if w.Code != 200 {
		t.Fatalf("delete: %d", w.Code)
	}
	if _, err := a.db.Exec("UPDATE attachments SET created_at=?, deleted_at=? WHERE id=?", old, old, freshID); err != nil {
		t.Fatal(err)
	}
	if err := a.sweepAttachments(context.Background()); err != nil {
		t.Fatalf("sweep2: %v", err)
	}
	if err := a.db.QueryRow("SELECT COUNT(*) FROM attachments WHERE id=?", freshID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("deleted not swept: n=%d", n)
	}
	if fs.has(u.ID + "/" + freshID) {
		t.Fatal("deleted object not removed")
	}
}

func TestAttachSweepPiggybacksOnPush(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	u := a.mustUser(t, "dev:alice", "alice@test.local")
	old := time.Now().Add(-2 * time.Hour).UnixMilli()
	if _, err := a.db.Exec("INSERT INTO attachments (user_id,id,filename,content_type,size_bytes,kind,status,created_at) VALUES (?,?,?,?,10,'image','pending',?)", u.ID, testUUID(902), "old.png", "image/png", old); err != nil {
		t.Fatal(err)
	}
	pushOne(t, a, u, testUUID(1), time.Now().UnixMilli(), "note", nil)
	var n int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM attachments WHERE id=?", testUUID(902)).Scan(&n); err != nil || n != 0 {
		t.Fatalf("push did not sweep: n=%d err=%v", n, err)
	}
}

func TestAttachCrossUserIsolation(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	alice := a.mustUser(t, "dev:alice", "alice@test.local")
	bob := a.mustUser(t, "dev:bob", "bob@test.local")

	w := createAttach(t, a, alice, "a.png", "image/png", 100)
	id := decodeAttach(t, w)["attachment"].(map[string]any)["id"].(string)
	fs.put(alice.ID+"/"+id, make([]byte, 100))
	if w = a.do(t, alice, "POST", "/api/v1/attachments/"+id+"/confirm", map[string]any{}); w.Code != 200 {
		t.Fatalf("confirm: %d", w.Code)
	}

	if w = a.do(t, bob, "GET", "/api/v1/attachments", nil); w.Code != 200 || strings.Contains(w.Body.String(), "a.png") {
		t.Fatalf("bob sees alice attachment: %s", w.Body.String())
	}
	for _, req := range []struct{ method, path string }{
		{"GET", "/api/v1/attachments/" + id + "/download"},
		{"DELETE", "/api/v1/attachments/" + id},
		{"POST", "/api/v1/attachments/" + id + "/confirm"},
	} {
		var body any
		if req.method == "POST" {
			body = map[string]any{}
		}
		if w = a.do(t, bob, req.method, req.path, body); w.Code != 404 {
			t.Fatalf("%s %s as bob: %d", req.method, req.path, w.Code)
		}
	}
}

func TestAttachAuthRequired(t *testing.T) {
	fs := newFakeStore()
	a := newAttachApp(t, fs, nil)
	for _, req := range []struct{ method, path string }{
		{"POST", "/api/v1/attachments"},
		{"GET", "/api/v1/attachments"},
		{"GET", "/api/v1/attachments/1/download"},
		{"DELETE", "/api/v1/attachments/1"},
		{"POST", "/api/v1/attachments/1/confirm"},
	} {
		var body any
		if req.method != "GET" && req.method != "DELETE" {
			body = map[string]any{}
		}
		if w := a.do(t, user{}, req.method, req.path, body); w.Code != 401 {
			t.Fatalf("%s %s unauthenticated: %d", req.method, req.path, w.Code)
		}
	}
}

func TestAttachNotConfigured(t *testing.T) {
	a := newTestApp(t) // nil store
	u := a.mustUser(t, "dev:alice", "alice@test.local")
	if w := createAttach(t, a, u, "a.png", "image/png", 10); w.Code != 503 || !strings.Contains(w.Body.String(), "ATTACHMENTS_NOT_CONFIGURED") {
		t.Fatalf("not configured: %d %s", w.Code, w.Body.String())
	}
	w := a.do(t, u, "GET", "/config.js", nil)
	if !strings.Contains(w.Body.String(), `"attachmentsEnabled":"false"`) {
		t.Fatalf("config.js: %s", w.Body.String())
	}
}

func TestAttachConfigJSWhenEnabled(t *testing.T) {
	a := newAttachApp(t, newFakeStore(), nil)
	w := a.do(t, user{}, "GET", "/config.js", nil)
	body := w.Body.String()
	if !strings.Contains(body, `"attachmentsEnabled":"true"`) || !strings.Contains(body, `"attachMaxBytes":"2000"`) {
		t.Fatalf("config.js: %s", body)
	}
}

func TestValidateAttachConfig(t *testing.T) {
	base := config{AuthMode: "dev"}
	ok := base
	ok.R2AccountID, ok.R2AccessKeyID, ok.R2SecretAccessKey, ok.R2Bucket = "a", "b", "c", "d"
	if err := validateAttachConfig(ok); err != nil {
		t.Fatalf("full r2 set: %v", err)
	}
	partial := base
	partial.R2AccountID = "a"
	if err := validateAttachConfig(partial); err == nil {
		t.Fatal("partial r2 set accepted")
	}
	localProd := config{AuthMode: "google", AttachLocalDir: "/tmp/x"}
	if err := validateAttachConfig(localProd); err == nil {
		t.Fatal("local dir accepted outside dev")
	}
	badQuota := base
	badQuota.AttachMaxBytes, badQuota.AttachUserQuotaBytes = 10, 5
	if err := validateAttachConfig(badQuota); err == nil {
		t.Fatal("max > quota accepted")
	}
}
