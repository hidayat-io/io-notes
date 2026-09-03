package main

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

/* ----------------------------------------------------------- response tap */

// respTap records what a handler produced so the access log can report it without
// the handlers having to know a logger exists. jsonError/jsonOK reach back into it
// through recordError/recordCount when they have something worth reporting.
type respTap struct {
	http.ResponseWriter
	status    int
	bytes     int
	errorCode string
	counts    map[string]int
}

func (t *respTap) WriteHeader(status int) {
	if t.status == 0 {
		t.status = status
	}
	t.ResponseWriter.WriteHeader(status)
}

func (t *respTap) Write(b []byte) (int, error) {
	if t.status == 0 {
		t.status = http.StatusOK
	}
	n, err := t.ResponseWriter.Write(b)
	t.bytes += n
	return n, err
}

func recordError(w http.ResponseWriter, code string) {
	if t, ok := w.(*respTap); ok {
		t.errorCode = code
	}
}

func recordCount(w http.ResponseWriter, key string, n int) {
	t, ok := w.(*respTap)
	if !ok {
		return
	}
	if t.counts == nil {
		t.counts = map[string]int{}
	}
	t.counts[key] = n
}

/* ------------------------------------------------------------ access logs */

var uuidSegment = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// routeTemplate collapses identifiers out of the path so logs group by route and
// never carry user data (PRD 17.1).
func routeTemplate(path string) string {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if uuidSegment.MatchString(p) {
			parts[i] = "{id}"
		}
	}
	return strings.Join(parts, "/")
}

func (a *application) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Static asset noise would drown the signal; only the API is worth a line each.
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		tap := &respTap{ResponseWriter: w}
		requestID := uuid()
		tap.Header().Set("X-Request-Id", requestID)
		next.ServeHTTP(tap, r)
		if tap.status == 0 {
			tap.status = http.StatusOK
		}

		fields := []any{
			"request_id", requestID,
			"method", r.Method,
			"route", routeTemplate(r.URL.Path),
			"status", tap.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"response_bytes", tap.bytes,
		}
		if tap.errorCode != "" {
			fields = append(fields, "error_code", tap.errorCode)
		}
		for k, v := range tap.counts {
			fields = append(fields, k, v)
		}
		a.logger.Info("http_request", fields...)
	})
}

/* ---------------------------------------------------------- rate limiting */

type bucket struct {
	tokens float64
	last   time.Time
}

// limiter is a best-effort in-memory token bucket. It is per-process only: with more
// than one instance the effective limit multiplies (PRD 14.3 accepts this for MVP).
type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens per second
	burst   float64
}

func newLimiter(perMinute, burst float64) *limiter {
	l := &limiter{buckets: map[string]*bucket{}, rate: perMinute / 60, burst: burst}
	go l.janitor()
	return l
}

func (l *limiter) janitor() {
	for range time.Tick(5 * time.Minute) {
		cutoff := time.Now().Add(-10 * time.Minute)
		l.mu.Lock()
		for k, b := range l.buckets {
			if b.last.Before(cutoff) {
				delete(l.buckets, k)
			}
		}
		l.mu.Unlock()
	}
}

// allow reports whether the key may proceed, and if not, how long to wait.
func (l *limiter) allow(key string) (bool, time.Duration) {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
		return false, wait
	}
	b.tokens--
	return true, 0
}

// clientIP only trusts a forwarded header when the operator explicitly names one,
// so a spoofed X-Forwarded-For cannot dodge the limiter (PRD 14.3).
func (a *application) clientIP(r *http.Request) string {
	if h := a.cfg.ClientIPHeader; h != "" {
		if v := strings.TrimSpace(strings.Split(r.Header.Get(h), ",")[0]); v != "" {
			return v
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *application) limitBy(l *limiter, key func(*http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ok, wait := l.allow(key(r)); !ok {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(wait.Seconds())+1))
			jsonError(w, http.StatusTooManyRequests, "RATE_LIMITED", "terlalu banyak permintaan, coba lagi sebentar")
			return
		}
		next(w, r)
	}
}

func (a *application) byIP(next http.HandlerFunc) http.HandlerFunc {
	return a.limitBy(a.loginLimit, a.clientIP, next)
}

// byUser must run inside withAuth so the verified session is already in context.
func (a *application) byUser(l *limiter, next http.HandlerFunc) http.HandlerFunc {
	return a.limitBy(l, func(r *http.Request) string {
		if u, ok := r.Context().Value(userKey{}).(user); ok {
			return u.ID
		}
		return a.clientIP(r)
	}, next)
}

/* ---------------------------------------------------------------- headers */

var inlineScript = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// cspFor derives the script hashes from the shipped index.html, so the theme
// bootstrap keeps working under a strict CSP without anyone maintaining a hash
// by hand — edit the HTML and the policy follows.
func cspFor(indexHTML []byte, cfg config) string {
	var hashes []string
	for _, m := range inlineScript.FindAllSubmatch(indexHTML, -1) {
		sum := sha256.Sum256(m[1])
		hashes = append(hashes, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	scriptSrc := "'self' https://accounts.google.com/gsi/client"
	if len(hashes) > 0 {
		scriptSrc += " " + strings.Join(hashes, " ")
	}
	connectSrc := "'self' https://accounts.google.com/gsi/"
	if cfg.R2AccountID != "" {
		connectSrc += " https://" + cfg.R2AccountID + ".r2.cloudflarestorage.com"
	}
	return strings.Join([]string{
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"script-src " + scriptSrc,
		// The PRD baseline omits 'unsafe-inline' here, but Google Identity Services
		// injects both a <style> element and style attributes into our document, so
		// the strict form silently breaks the sign-in button. Verified in a browser.
		// Scripts stay locked down by hash — that is where XSS actually bites; style
		// injection cannot execute code, and nothing here renders untrusted HTML.
		"style-src 'self' https://accounts.google.com/gsi/style 'unsafe-inline'",
		"img-src 'self' data: https:",
		"connect-src " + connectSrc,
		// Same-origin frames are used only for authenticated PDF attachment previews.
		"frame-src 'self' https://accounts.google.com/gsi/",
		"manifest-src 'self'",
		"worker-src 'self'",
	}, "; ")
}
