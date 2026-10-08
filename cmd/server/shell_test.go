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
