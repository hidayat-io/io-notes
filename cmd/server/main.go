package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/tursodatabase/libsql-client-go/libsql"
	"golang.org/x/crypto/bcrypt"
	"google.golang.org/api/idtoken"
	webassets "litenotes/web"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema embed.FS

type config struct {
	Port, AppOrigin, AppEnv, AuthMode, GoogleClientID, SessionSecret, DatabaseURL, TursoToken        string
	ListenHost, ClientIPHeader                                                                       string
	SessionTTL                                                                                       time.Duration
	BrevoAPIKey, ResetEmailFrom, ResetEmailFromName, ResetSMTPAddr, ResetSMTPUser, ResetSMTPPassword string
}

type user struct {
	ID         string  `json:"id"`
	Email      string  `json:"email"`
	Name       string  `json:"name"`
	PictureURL *string `json:"picture_url"`
}
type note struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	Content         string `json:"content"`
	MutationID      string `json:"mutation_id"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
	DeletedAt       *int64 `json:"deleted_at"`
	Revision        int64  `json:"revision"`
	ServerUpdatedAt int64  `json:"server_updated_at"`
	FolderID        string `json:"folder_id"`
	IsLocked        bool   `json:"is_locked"`
	PasswordHash    string `json:"-"`
}
type mutation struct {
	MutationID string    `json:"mutation_id"`
	Note       noteInput `json:"note"`
}
type noteInput struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	DeletedAt *int64 `json:"deleted_at"`
	FolderID  string `json:"folder_id"`
}
type folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("invalid_config", "error", err)
		os.Exit(1)
	}
	db, err := openDB(cfg)
	if err != nil {
		logger.Error("database_open_failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := migrate(db); err != nil {
		logger.Error("database_migration_failed", "error", err)
		os.Exit(1)
	}

	app := newApplication(cfg, db, logger)
	listenHost := cfg.ListenHost
	server := &http.Server{Addr: listenHost + ":" + cfg.Port, Handler: app.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		logger.Info("server_started",
			"port", cfg.Port, "listen_host", listenHost, "auth_mode", cfg.AuthMode,
			"env", cfg.AppEnv, "schema_version", schemaVersion, "version", buildVersion())
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server_failed", "error", err)
		os.Exit(1)
	}
}

func loadConfig() (config, error) {
	c := config{Port: getenv("PORT", "8091"), AppOrigin: getenv("APP_ORIGIN", "http://localhost:8091"), AppEnv: getenv("APP_ENV", "development"), AuthMode: getenv("AUTH_MODE", "google"), GoogleClientID: os.Getenv("GOOGLE_CLIENT_ID"), SessionSecret: os.Getenv("SESSION_SECRET"), DatabaseURL: getenv("TURSO_DATABASE_URL", "file:./data/litenotes.db"), TursoToken: os.Getenv("TURSO_AUTH_TOKEN"), SessionTTL: 30 * 24 * time.Hour, BrevoAPIKey: os.Getenv("BREVO_API_KEY"), ResetEmailFrom: getenv("RESET_EMAIL_FROM", "admin@indoomega.my.id"), ResetEmailFromName: getenv("RESET_EMAIL_FROM_NAME", "LiteNotes"), ResetSMTPAddr: os.Getenv("RESET_SMTP_ADDR"), ResetSMTPUser: os.Getenv("RESET_SMTP_USER"), ResetSMTPPassword: os.Getenv("RESET_SMTP_PASSWORD")}
	if raw := os.Getenv("SESSION_TTL"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			return c, fmt.Errorf("SESSION_TTL: %w", err)
		}
		c.SessionTTL = d
	}
	if c.AppEnv == "production" && len(c.SessionSecret) < 32 {
		return c, errors.New("SESSION_SECRET must be at least 32 characters in production")
	}
	if c.AuthMode == "google" && c.GoogleClientID == "" && c.AppEnv == "production" {
		return c, errors.New("GOOGLE_CLIENT_ID is required in production")
	}
	if c.AppOrigin == "" {
		return c, errors.New("APP_ORIGIN is required")
	}
	if err := validateDatabaseConfig(c); err != nil {
		return c, err
	}
	// Bind to loopback by default. Production sits behind cloudflared, so exposing
	// the port on every interface would let clients bypass the tunnel and its TLS.
	c.ListenHost = getenv("LISTEN_HOST", "127.0.0.1")
	c.ClientIPHeader = os.Getenv("CLIENT_IP_HEADER")
	return c, nil
}

// validateDatabaseConfig enforces remote Turso in production so a dead VPS does not
// take the only copy of notes with it. Local file: is still allowed for dev/tests and
// for an explicit escape hatch during emergency cutover.
func validateDatabaseConfig(c config) error {
	remote := isRemoteDatabaseURL(c.DatabaseURL)
	if remote && c.TursoToken == "" {
		return errors.New("TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is remote (libsql:// or https://)")
	}
	if c.AppEnv == "production" && !remote && os.Getenv("ALLOW_LOCAL_SQLITE") != "1" {
		return errors.New("production requires remote TURSO_DATABASE_URL (libsql://...); set ALLOW_LOCAL_SQLITE=1 only as a temporary escape hatch")
	}
	return nil
}

func isRemoteDatabaseURL(raw string) bool {
	return strings.HasPrefix(raw, "libsql://") || strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "http://")
}

// schemaVersion tracks cmd/server/schema.sql; bump it whenever the schema changes.
const schemaVersion = 1

func readEmbeddedIndex() ([]byte, error) { return webassets.Dist.ReadFile("dist/index.html") }

func buildVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return "unknown"
}
func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

func openDB(c config) (*sql.DB, error) {
	if strings.HasPrefix(c.DatabaseURL, "file:") {
		path := strings.TrimPrefix(c.DatabaseURL, "file:")
		if dir := filepath.Dir(path); dir != "." && dir != "" {
			if err := os.MkdirAll(dir, 0750); err != nil {
				return nil, fmt.Errorf("create sqlite dir: %w", err)
			}
		}
		db, err := sql.Open("sqlite", path)
		if err != nil {
			return nil, err
		}
		// Local SQLite is single-writer; keep the pool tiny to avoid lock storms.
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		if err := pingDB(db, 5*time.Second); err != nil {
			_ = db.Close()
			return nil, err
		}
		return db, nil
	}

	dsn, err := libsqlDSN(c.DatabaseURL, c.TursoToken)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("libsql", dsn)
	if err != nil {
		return nil, err
	}
	// Remote Turso: modest pool. Too many open HTTP/ws sessions burns free-tier quota.
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(2 * time.Minute)
	if err := pingDB(db, 10*time.Second); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("turso unreachable: %w", err)
	}
	return db, nil
}

// libsqlDSN appends authToken via url.Values so special characters in the token
// are escaped correctly (raw string concat used to break tokens with +/=).
func libsqlDSN(rawURL, token string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("TURSO_DATABASE_URL: %w", err)
	}
	if token != "" {
		q := u.Query()
		q.Set("authToken", token)
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

func pingDB(db *sql.DB, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return db.PingContext(ctx)
}

func migrate(db *sql.DB) error {
	b, err := schema.ReadFile("schema.sql")
	if err != nil {
		return err
	}
	// Remote libSQL may reject multi-statement Exec; run one statement at a time.
	for _, stmt := range splitSQLStatements(string(b)) {
		if _, err = db.Exec(stmt); err != nil {
			return fmt.Errorf("migrate statement failed: %w\nSQL: %s", err, stmt)
		}
	}
	for _, alter := range []string{
		"ALTER TABLE notes ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE notes ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''",
	} {
		if err := execIgnoreDuplicateColumn(db, alter); err != nil {
			return err
		}
	}
	return nil
}

func execIgnoreDuplicateColumn(db *sql.DB, sqlText string) error {
	_, err := db.Exec(sqlText)
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "duplicate column") || strings.Contains(msg, "already exists") {
		return nil
	}
	return err
}

// splitSQLStatements splits schema.sql on semicolons. Safe for our embedded DDL
// (no string literals containing ';'). Blank lines and full-line comments are dropped.
func splitSQLStatements(src string) []string {
	parts := strings.Split(src, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		// Drop pure comment-only chunks.
		lines := strings.Split(p, "\n")
		kept := make([]string, 0, len(lines))
		for _, line := range lines {
			trim := strings.TrimSpace(line)
			if trim == "" || strings.HasPrefix(trim, "--") {
				continue
			}
			kept = append(kept, line)
		}
		if len(kept) == 0 {
			continue
		}
		out = append(out, strings.Join(kept, "\n"))
	}
	return out
}

type application struct {
	cfg    config
	db     *sql.DB
	logger *slog.Logger
	csp    string

	loginLimit *limiter
	pushLimit  *limiter
	pullLimit  *limiter
}

// newApplication wires the derived state (CSP hashes, rate limiters) that both
// main and the tests need, so neither can drift from the other.
func newApplication(cfg config, db *sql.DB, logger *slog.Logger) *application {
	indexHTML, _ := readEmbeddedIndex()
	return &application{
		cfg:        cfg,
		db:         db,
		logger:     logger,
		csp:        cspFor(indexHTML),
		loginLimit: newLimiter(10, 20), // PRD 14.3
		pushLimit:  newLimiter(30, 60), // burst covers a reconnect flush
		pullLimit:  newLimiter(120, 180),
	}
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /readyz", a.ready)
	mux.HandleFunc("GET /config.js", a.configJS)
	mux.HandleFunc("POST /api/v1/auth/google", a.byIP(a.loginGoogle))
	mux.HandleFunc("POST /api/v1/auth/dev", a.byIP(a.loginDev))
	mux.HandleFunc("POST /api/v1/auth/logout", a.logout)
	mux.HandleFunc("GET /api/v1/me", a.withAuth(a.me))
	mux.HandleFunc("GET /api/v1/folders", a.withAuth(a.listFolders))
	mux.HandleFunc("POST /api/v1/folders", a.withAuth(a.createFolder))
	mux.HandleFunc("PATCH /api/v1/folders/{id}", a.withAuth(a.renameFolder))
	mux.HandleFunc("DELETE /api/v1/folders/{id}", a.withAuth(a.deleteFolder))
	mux.HandleFunc("POST /api/v1/sync/push", a.withAuth(a.byUser(a.pushLimit, a.push)))
	mux.HandleFunc("GET /api/v1/sync/pull", a.withAuth(a.byUser(a.pullLimit, a.pull)))
	mux.HandleFunc("PUT /api/v1/notes/{id}/password", a.withAuth(a.setNotePassword))
	mux.HandleFunc("DELETE /api/v1/notes/{id}/password", a.withAuth(a.removeNotePassword))
	mux.HandleFunc("POST /api/v1/notes/{id}/unlock", a.withAuth(a.unlockNote))
	mux.HandleFunc("POST /api/v1/notes/{id}/password/reset-request", a.withAuth(a.requestPasswordReset))
	mux.HandleFunc("POST /api/v1/notes/{id}/password/reset", a.byIP(a.resetNotePassword))
	return a.security(a.accessLog(a.staticFallback(mux)))
}

func (a *application) staticFallback(api http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" || r.URL.Path == "/readyz" || r.URL.Path == "/config.js" {
			api.ServeHTTP(w, r)
			return
		}
		path := r.URL.Path
		if path == "/" || strings.HasPrefix(path, "/#") {
			path = "/index.html"
		}
		data, err := webassets.Dist.ReadFile("dist" + path)
		if err != nil {
			if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") && filepath.Ext(path) == "" {
				data, err = webassets.Dist.ReadFile("dist/index.html")
			}
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType(path))
		if path == "/sw.js" || path == "/index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		} else if strings.Contains(path, ".") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		_, _ = w.Write(data)
	})
}
func contentType(p string) string {
	switch filepath.Ext(p) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "application/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json", ".webmanifest":
		return "application/manifest+json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	}
	return "application/octet-stream"
}
func (a *application) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", a.csp)
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.URL.Path != "/healthz" {
			if o := r.Header.Get("Origin"); o != "" && o != a.cfg.AppOrigin {
				jsonError(w, http.StatusForbidden, "ORIGIN_NOT_ALLOWED", "origin tidak diizinkan")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *application) configJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "no-store")
	authMode := a.cfg.AuthMode
	if authMode == "dev" && !isLocalHost(r.Host) {
		authMode = "google"
	}
	fmt.Fprintf(w, "window.__LITENOTES_CONFIG__=%s;", mustJSON(map[string]string{"authMode": authMode, "googleClientId": a.cfg.GoogleClientID}))
}
func (a *application) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.db.PingContext(ctx); err != nil {
		http.Error(w, "not ready\n", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, "ready\n")
}

func (a *application) loginDev(w http.ResponseWriter, r *http.Request) {
	if a.cfg.AuthMode != "dev" || !isLocalHost(r.Host) {
		jsonError(w, 404, "NOT_FOUND", "not found")
		return
	}
	var in struct{ Email, Name string }
	if err := decodeJSON(r, &in, 2048); err != nil || in.Email == "" {
		jsonError(w, 400, "VALIDATION_ERROR", "email wajib diisi")
		return
	}
	u, err := a.upsertUser(r.Context(), "dev:"+strings.ToLower(in.Email), in.Email, in.Name, nil)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat user")
		return
	}
	a.setSession(w, u)
	jsonOK(w, map[string]any{"user": u, "server_time": time.Now().UnixMilli()})
}

func isLocalHost(host string) bool {
	host = strings.Split(host, ":")[0]
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}
func (a *application) loginGoogle(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken string `json:"id_token"`
	}
	if err := decodeJSON(r, &in, 20000); err != nil || in.IDToken == "" {
		jsonError(w, 400, "VALIDATION_ERROR", "id_token wajib diisi")
		return
	}
	if a.cfg.GoogleClientID == "" {
		jsonError(w, 503, "AUTH_NOT_CONFIGURED", "Google login belum dikonfigurasi")
		return
	}
	p, err := idtoken.Validate(r.Context(), in.IDToken, a.cfg.GoogleClientID)
	if err != nil {
		jsonError(w, 401, "UNAUTHENTICATED", "credential Google tidak valid")
		return
	}
	email, _ := p.Claims["email"].(string)
	verified, _ := p.Claims["email_verified"].(bool)
	if p.Subject == "" || email == "" || !verified {
		jsonError(w, 401, "UNAUTHENTICATED", "credential Google tidak valid")
		return
	}
	name, _ := p.Claims["name"].(string)
	picture, _ := p.Claims["picture"].(string)
	var pp *string
	if picture != "" {
		pp = &picture
	}
	u, err := a.upsertUser(r.Context(), p.Subject, email, name, pp)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menyimpan user")
		return
	}
	a.setSession(w, u)
	jsonOK(w, map[string]any{"user": u, "server_time": time.Now().UnixMilli()})
}
func (a *application) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName(a.cfg), Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: a.cfg.AppEnv == "production", SameSite: http.SameSiteLaxMode})
	jsonOK(w, map[string]any{"ok": true, "server_time": time.Now().UnixMilli()})
}
func (a *application) me(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	jsonOK(w, map[string]any{"user": u, "server_time": time.Now().UnixMilli()})
}

func (a *application) listFolders(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	rows, err := a.db.QueryContext(r.Context(), "SELECT id,name,created_at,updated_at FROM folders WHERE user_id=? ORDER BY name COLLATE NOCASE", u.ID)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer rows.Close()
	items := []folder{}
	for rows.Next() {
		var f folder
		if err := rows.Scan(&f.ID, &f.Name, &f.CreatedAt, &f.UpdatedAt); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca folder")
			return
		}
		items = append(items, f)
	}
	jsonOK(w, map[string]any{"folders": items, "server_time": time.Now().UnixMilli()})
}

func (a *application) createFolder(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	var in struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &in, 4096); err != nil || strings.TrimSpace(in.Name) == "" || len([]rune(in.Name)) > 80 {
		jsonError(w, 400, "VALIDATION_ERROR", "nama folder wajib diisi dan maksimal 80 karakter")
		return
	}
	f := folder{ID: uuid(), Name: strings.TrimSpace(in.Name), CreatedAt: time.Now().UnixMilli()}
	f.UpdatedAt = f.CreatedAt
	if _, err := a.db.ExecContext(r.Context(), "INSERT INTO folders(user_id,id,name,created_at,updated_at) VALUES(?,?,?,?,?)", u.ID, f.ID, f.Name, f.CreatedAt, f.UpdatedAt); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat folder")
		return
	}
	jsonOK(w, map[string]any{"folder": f, "server_time": time.Now().UnixMilli()})
}

func (a *application) renameFolder(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	id := r.PathValue("id")
	var in struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &in, 4096); err != nil || strings.TrimSpace(in.Name) == "" || len([]rune(in.Name)) > 80 {
		jsonError(w, 400, "VALIDATION_ERROR", "nama folder wajib diisi dan maksimal 80 karakter")
		return
	}
	name := strings.TrimSpace(in.Name)
	now := time.Now().UnixMilli()
	res, err := a.db.ExecContext(r.Context(), "UPDATE folders SET name=?,updated_at=? WHERE user_id=? AND id=?", name, now, u.ID, id)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal mengubah folder")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		jsonError(w, 404, "NOT_FOUND", "folder tidak ditemukan")
		return
	}
	jsonOK(w, map[string]any{"folder": folder{ID: id, Name: name, UpdatedAt: now}, "server_time": time.Now().UnixMilli()})
}

func (a *application) deleteFolder(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	id := r.PathValue("id")
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer tx.Rollback()
	// Detaching notes from the folder is a syncable change: every affected note needs a
	// fresh revision, otherwise pull (which is cursor-ordered by revision) never replays
	// it and other devices keep showing the deleted folder forever.
	rows, err := tx.QueryContext(r.Context(), "SELECT id FROM notes WHERE user_id=? AND folder_id=?", u.ID, id)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	var affected []string
	for rows.Next() {
		var noteID string
		if err = rows.Scan(&noteID); err != nil {
			rows.Close()
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
			return
		}
		affected = append(affected, noteID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	if n := len(affected); n > 0 {
		if _, err = tx.ExecContext(r.Context(), "UPDATE user_sync_state SET last_revision=last_revision+? WHERE user_id=?", n, u.ID); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat revision")
			return
		}
		var last int64
		if err = tx.QueryRowContext(r.Context(), "SELECT last_revision FROM user_sync_state WHERE user_id=?", u.ID).Scan(&last); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca revision")
			return
		}
		// updated_at stays untouched so the deleted_at=updated_at CHECK keeps holding and
		// the client's LWW comparator does not treat this as a content edit.
		now := time.Now().UnixMilli()
		base := last - int64(n)
		for i, noteID := range affected {
			if _, err = tx.ExecContext(r.Context(), "UPDATE notes SET folder_id='',revision=?,server_updated_at=? WHERE user_id=? AND id=?", base+int64(i)+1, now, u.ID, noteID); err != nil {
				jsonError(w, 500, "INTERNAL_ERROR", "gagal memindahkan note")
				return
			}
		}
	}
	res, err := tx.ExecContext(r.Context(), "DELETE FROM folders WHERE user_id=? AND id=?", u.ID, id)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menghapus folder")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		jsonError(w, 404, "NOT_FOUND", "folder tidak ditemukan")
		return
	}
	if err = tx.Commit(); err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	jsonOK(w, map[string]any{"ok": true, "server_time": time.Now().UnixMilli()})
}

type userKey struct{}

func (a *application) withAuth(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName(a.cfg))
		if err != nil {
			jsonError(w, 401, "UNAUTHENTICATED", "login diperlukan")
			return
		}
		claims, err := verifyJWT(c.Value, a.cfg.SessionSecret)
		if err != nil {
			jsonError(w, 401, "UNAUTHENTICATED", "session tidak valid")
			return
		}
		u, err := a.findUser(r.Context(), claims.Subject)
		if err != nil {
			jsonError(w, 401, "UNAUTHENTICATED", "user tidak ditemukan")
			return
		}
		fn(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	}
}
func cookieName(c config) string {
	if c.AppEnv == "production" {
		return "__Host-litenotes_session"
	}
	return "litenotes_session"
}

type jwtClaims struct {
	Subject   string `json:"sub"`
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func (a *application) setSession(w http.ResponseWriter, u user) {
	now := time.Now()
	c := jwtClaims{Subject: u.ID, Issuer: "litenotes", Audience: "litenotes-web", IssuedAt: now.Unix(), ExpiresAt: now.Add(a.cfg.SessionTTL).Unix()}
	token := signJWT(c, a.cfg.SessionSecret)
	http.SetCookie(w, &http.Cookie{Name: cookieName(a.cfg), Value: token, Path: "/", HttpOnly: true, Secure: a.cfg.AppEnv == "production", SameSite: http.SameSiteLaxMode, MaxAge: int(a.cfg.SessionTTL.Seconds())})
}
func signJWT(c jwtClaims, secret string) string {
	enc := base64.RawURLEncoding
	h := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	p := enc.EncodeToString(mustJSON(c))
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(h + "." + p))
	return h + "." + p + "." + enc.EncodeToString(mac.Sum(nil))
}
func verifyJWT(t, secret string) (jwtClaims, error) {
	var c jwtClaims
	parts := strings.Split(t, ".")
	if len(parts) != 3 {
		return c, errors.New("bad token")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return c, errors.New("bad signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(raw, &c) != nil || c.Issuer != "litenotes" || c.Audience != "litenotes-web" || c.Subject == "" || time.Now().Unix() >= c.ExpiresAt {
		return c, errors.New("expired token")
	}
	return c, nil
}

func (a *application) upsertUser(ctx context.Context, sub, email, name string, picture *string) (user, error) {
	now := time.Now().UnixMilli()
	id := uuid()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return user{}, err
	}
	defer tx.Rollback()
	var existing string
	err = tx.QueryRowContext(ctx, "SELECT id FROM users WHERE google_sub=?", sub).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, "INSERT INTO users(id,google_sub,email,email_verified,name,picture_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", id, sub, email, 1, name, picture, now, now)
	} else if err == nil {
		id = existing
		_, err = tx.ExecContext(ctx, "UPDATE users SET email=?,name=?,picture_url=?,updated_at=? WHERE id=?", email, name, picture, now, id)
	}
	if err != nil {
		return user{}, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO user_sync_state(user_id,last_revision) VALUES(?,0) ON CONFLICT(user_id) DO NOTHING", id); err != nil {
		return user{}, err
	}
	if err = tx.Commit(); err != nil {
		return user{}, err
	}
	return user{ID: id, Email: email, Name: name, PictureURL: picture}, nil
}
func (a *application) findUser(ctx context.Context, id string) (user, error) {
	var u user
	var p sql.NullString
	err := a.db.QueryRowContext(ctx, "SELECT id,email,name,picture_url FROM users WHERE id=?", id).Scan(&u.ID, &u.Email, &u.Name, &p)
	if p.Valid {
		u.PictureURL = &p.String
	}
	return u, err
}

func (a *application) push(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	var in struct {
		DeviceID  string     `json:"device_id"`
		Mutations []mutation `json:"mutations"`
	}
	if err := decodeJSON(r, &in, 2<<20); err != nil || len(in.Mutations) == 0 || len(in.Mutations) > 100 {
		a.logger.Warn("sync_push_rejected", "user", u.Email, "decode_err", fmt.Sprint(err), "mutations", len(in.Mutations))
		jsonError(w, 400, "VALIDATION_ERROR", "mutations harus berisi 1 sampai 100 item")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer tx.Rollback()
	results := make([]any, 0, len(in.Mutations))
	serverNow := time.Now().UnixMilli()
	for _, m := range in.Mutations {
		if err := validateMutation(m, serverNow); err != nil {
			status, code, msg := 400, "VALIDATION_ERROR", err.Error()
			var ve validationError
			if errors.As(err, &ve) {
				status, code, msg = ve.status, ve.code, ve.msg
			}
			a.logger.Warn("sync_push_note_rejected", "note_id", m.Note.ID, "code", code, "message", msg)
			jsonError(w, status, code, msg)
			return
		}
		current, found, err := getNote(r.Context(), tx, u.ID, m.Note.ID)
		if err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
			return
		}
		candidate := note{ID: m.Note.ID, Title: m.Note.Title, Content: m.Note.Content, FolderID: m.Note.FolderID, CreatedAt: m.Note.CreatedAt, UpdatedAt: m.Note.UpdatedAt, DeletedAt: m.Note.DeletedAt, MutationID: m.MutationID}
		status := "applied"
		if found && compare(candidate, current) <= 0 {
			status = "superseded"
			if candidate.UpdatedAt == current.UpdatedAt && candidate.MutationID == current.MutationID && candidate.Title == current.Title && candidate.Content == current.Content && candidate.FolderID == current.FolderID && sameDeleted(candidate.DeletedAt, current.DeletedAt) {
				status = "unchanged"
			}
			results = append(results, map[string]any{"mutation_id": m.MutationID, "status": status, "note": current})
			continue
		}
		if found {
			candidate.CreatedAt = current.CreatedAt
			candidate.PasswordHash = current.PasswordHash
			candidate.IsLocked = current.PasswordHash != ""
		}
		if _, err = tx.ExecContext(r.Context(), "UPDATE user_sync_state SET last_revision=last_revision+1 WHERE user_id=?", u.ID); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat revision")
			return
		}
		var rev int64
		if err = tx.QueryRowContext(r.Context(), "SELECT last_revision FROM user_sync_state WHERE user_id=?", u.ID).Scan(&rev); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca revision")
			return
		}
		now := time.Now().UnixMilli()
		_, err = tx.ExecContext(r.Context(), `INSERT INTO notes(user_id,id,title,content,folder_id,created_at,updated_at,deleted_at,mutation_id,revision,server_updated_at,password_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET title=excluded.title,content=excluded.content,folder_id=excluded.folder_id,created_at=excluded.created_at,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,mutation_id=excluded.mutation_id,revision=excluded.revision,server_updated_at=excluded.server_updated_at,password_hash=excluded.password_hash`, u.ID, candidate.ID, candidate.Title, candidate.Content, candidate.FolderID, candidate.CreatedAt, candidate.UpdatedAt, candidate.DeletedAt, candidate.MutationID, rev, now, candidate.PasswordHash)
		if err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal menyimpan note")
			return
		}
		candidate.Revision, candidate.ServerUpdatedAt = rev, now
		results = append(results, map[string]any{"mutation_id": m.MutationID, "status": "applied", "note": candidate})
	}
	if err = tx.Commit(); err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	recordCount(w, "mutation_count", len(in.Mutations))
	jsonOK(w, map[string]any{"results": results, "server_time": time.Now().UnixMilli()})
}

func (a *application) pull(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	if cursor < 0 {
		cursor = 0
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := a.db.QueryContext(r.Context(), "SELECT id,title,content,folder_id,created_at,updated_at,deleted_at,mutation_id,revision,server_updated_at,password_hash FROM notes WHERE user_id=? AND revision>? ORDER BY revision ASC LIMIT ?", u.ID, cursor, limit+1)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer rows.Close()
	notes := make([]note, 0, limit)
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca notes")
			return
		}
		notes = append(notes, n)
	}
	hasMore := len(notes) > limit
	if hasMore {
		notes = notes[:limit]
	}
	next := cursor
	if len(notes) > 0 {
		next = notes[len(notes)-1].Revision
	}
	var latest int64
	_ = a.db.QueryRowContext(r.Context(), "SELECT last_revision FROM user_sync_state WHERE user_id=?", u.ID).Scan(&latest)
	recordCount(w, "note_count", len(notes))
	jsonOK(w, map[string]any{"notes": notes, "next_cursor": next, "has_more": hasMore, "latest_cursor": latest, "server_time": time.Now().UnixMilli()})
}

func (a *application) setNotePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &in, 4096); err != nil {
		jsonError(w, 400, "BAD_JSON", "request password tidak valid")
		return
	}
	if in.Password != "" && (len(in.Password) < 8 || len(in.Password) > 128) {
		jsonError(w, 400, "VALIDATION_ERROR", "password harus 8 sampai 128 karakter")
		return
	}
	a.changeNotePassword(w, r, in.Password)
}

func (a *application) removeNotePassword(w http.ResponseWriter, r *http.Request) {
	a.changeNotePassword(w, r, "")
}

func (a *application) changeNotePassword(w http.ResponseWriter, r *http.Request, password string) {
	u := r.Context().Value(userKey{}).(user)
	noteID := r.PathValue("id")
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer tx.Rollback()
	_, found, err := getNote(r.Context(), tx, u.ID, noteID)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	if !found {
		jsonError(w, 404, "NOT_FOUND", "note tidak ditemukan")
		return
	}
	hash := ""
	if password != "" {
		b, hashErr := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if hashErr != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal mengamankan password")
			return
		}
		hash = string(b)
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE user_sync_state SET last_revision=last_revision+1 WHERE user_id=?", u.ID); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat revision")
		return
	}
	var rev int64
	if err = tx.QueryRowContext(r.Context(), "SELECT last_revision FROM user_sync_state WHERE user_id=?", u.ID).Scan(&rev); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca revision")
		return
	}
	now := time.Now().UnixMilli()
	if _, err = tx.ExecContext(r.Context(), "UPDATE notes SET password_hash=?,revision=?,server_updated_at=? WHERE user_id=? AND id=?", hash, rev, now, u.ID, noteID); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menyimpan password")
		return
	}
	if err = tx.Commit(); err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	jsonOK(w, map[string]any{"ok": true, "is_locked": hash != "", "revision": rev, "server_time": time.Now().UnixMilli()})
}

func (a *application) unlockNote(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	noteID := r.PathValue("id")
	var in struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &in, 4096); err != nil {
		jsonError(w, 400, "BAD_JSON", "request password tidak valid")
		return
	}
	n, found, err := getNote(r.Context(), a.db, u.ID, noteID)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	if !found {
		jsonError(w, 404, "NOT_FOUND", "note tidak ditemukan")
		return
	}
	if n.PasswordHash != "" && bcrypt.CompareHashAndPassword([]byte(n.PasswordHash), []byte(in.Password)) != nil {
		jsonError(w, 401, "WRONG_PASSWORD", "password note salah")
		return
	}
	jsonOK(w, map[string]any{"ok": true, "server_time": time.Now().UnixMilli()})
}

func (a *application) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	noteID := r.PathValue("id")
	if a.cfg.BrevoAPIKey == "" && (a.cfg.ResetSMTPAddr == "" || a.cfg.ResetSMTPUser == "" || a.cfg.ResetSMTPPassword == "") {
		jsonError(w, 503, "EMAIL_NOT_CONFIGURED", "email reset belum dikonfigurasi")
		return
	}
	_, found, err := getNote(r.Context(), a.db, u.ID, noteID)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca note")
		return
	}
	if !found {
		jsonError(w, 404, "NOT_FOUND", "note tidak ditemukan")
		return
	}
	token := randomToken()
	tokenHash := sha256.Sum256([]byte(token))
	now := time.Now().UnixMilli()
	expires := now + 15*60*1000
	if _, err = a.db.ExecContext(r.Context(), "INSERT INTO note_password_resets(id,user_id,note_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)", uuid(), u.ID, noteID, hex.EncodeToString(tokenHash[:]), expires, now); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat token reset")
		return
	}
	if err = a.sendPasswordResetEmail(r.Context(), u, noteID, token); err != nil {
		a.logger.Error("password_reset_email_failed", "error", err)
		jsonError(w, 503, "EMAIL_SEND_FAILED", "email reset gagal dikirim")
		return
	}
	jsonOK(w, map[string]any{"ok": true, "server_time": time.Now().UnixMilli()})
}

func (a *application) resetNotePassword(w http.ResponseWriter, r *http.Request) {
	noteID := r.PathValue("id")
	var raw struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &raw, 8192); err != nil {
		jsonError(w, 400, "BAD_JSON", "request reset tidak valid")
		return
	}
	if len(raw.Token) < 20 || len(raw.Password) < 8 || len(raw.Password) > 128 {
		jsonError(w, 400, "VALIDATION_ERROR", "token atau password tidak valid")
		return
	}
	tokenHash := sha256.Sum256([]byte(raw.Token))
	var resetID, userID string
	var expires int64
	var used sql.NullInt64
	err := a.db.QueryRowContext(r.Context(), "SELECT id,user_id,expires_at,used_at FROM note_password_resets WHERE note_id=? AND token_hash=? ORDER BY created_at DESC LIMIT 1", noteID, hex.EncodeToString(tokenHash[:])).Scan(&resetID, &userID, &expires, &used)
	if errors.Is(err, sql.ErrNoRows) || used.Valid || expires < time.Now().UnixMilli() {
		jsonError(w, 400, "RESET_TOKEN_INVALID", "token reset tidak valid atau sudah kedaluwarsa")
		return
	}
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal memeriksa token reset")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(raw.Password), bcrypt.DefaultCost)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal mengamankan password")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), "UPDATE user_sync_state SET last_revision=last_revision+1 WHERE user_id=?", userID); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membuat revision")
		return
	}
	var rev int64
	if err = tx.QueryRowContext(r.Context(), "SELECT last_revision FROM user_sync_state WHERE user_id=?", userID).Scan(&rev); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca revision")
		return
	}
	now := time.Now().UnixMilli()
	if _, err = tx.ExecContext(r.Context(), "UPDATE notes SET password_hash=?,revision=?,server_updated_at=? WHERE user_id=? AND id=?", string(hash), rev, now, userID, noteID); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menyimpan password")
		return
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE note_password_resets SET used_at=? WHERE id=? AND used_at IS NULL", now, resetID); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menutup token reset")
		return
	}
	if err = tx.Commit(); err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	jsonOK(w, map[string]any{"ok": true, "server_time": time.Now().UnixMilli()})
}

func (a *application) sendPasswordResetEmail(ctx context.Context, u user, noteID, token string) error {
	link := a.cfg.AppOrigin + "/#/reset-note-password?note=" + url.QueryEscape(noteID) + "&token=" + url.QueryEscape(token)
	bodyHTML := "<p>Gunakan link berikut untuk membuat password baru note rahasia kamu:</p><p><a href=\"" + html.EscapeString(link) + "\">Reset password note</a></p><p>Link ini berlaku 15 menit dan hanya bisa digunakan sekali.</p>"
	if a.cfg.ResetSMTPAddr != "" && a.cfg.ResetSMTPUser != "" && a.cfg.ResetSMTPPassword != "" {
		from := a.cfg.ResetEmailFrom
		if a.cfg.ResetEmailFromName != "" {
			from = a.cfg.ResetEmailFromName + " <" + from + ">"
		}
		msg := "From: " + from + "\r\nTo: " + u.Email + "\r\nSubject: Reset password note LiteNotes\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n" + bodyHTML
		host := a.cfg.ResetSMTPAddr
		if i := strings.IndexByte(host, ':'); i >= 0 {
			host = host[:i]
		}
		return smtp.SendMail(a.cfg.ResetSMTPAddr, smtp.PlainAuth("", a.cfg.ResetSMTPUser, a.cfg.ResetSMTPPassword, host), a.cfg.ResetEmailFrom, []string{u.Email}, []byte(msg))
	}
	payload := map[string]any{"sender": map[string]string{"email": a.cfg.ResetEmailFrom, "name": a.cfg.ResetEmailFromName}, "to": []map[string]string{{"email": u.Email, "name": u.Name}}, "subject": "Reset password note LiteNotes", "htmlContent": bodyHTML}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.brevo.com/v3/smtp/email", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("api-key", a.cfg.BrevoAPIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("brevo status %d", resp.StatusCode)
	}
	return nil
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// validationError carries the HTTP shape so the caller does not have to guess
// whether a rejection is a plain 400 or the recoverable 422 CLOCK_SKEW.
type validationError struct {
	status    int
	code, msg string
}

func (e validationError) Error() string { return e.msg }

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER: timestamps beyond it
// cannot round-trip through the client (PRD 4.4).
const maxSafeInteger = int64(9007199254740991)

// clockSkewGrace matches PRD 4.5: anything further ahead than this is rejected so
// a wrong device clock cannot poison the LWW ordering for every other device.
const clockSkewGrace = 5 * 60 * 1000

func validateMutation(m mutation, serverNow int64) error {
	reject := func(msg string) error { return validationError{400, "VALIDATION_ERROR", msg} }
	if !canonicalUUID.MatchString(m.MutationID) || !canonicalUUID.MatchString(m.Note.ID) {
		return reject("mutation_id dan note.id harus UUID v4 canonical lowercase")
	}
	if len([]rune(m.Note.Title)) > 500 {
		return reject("title maksimal 500 karakter")
	}
	if len(m.Note.Content) > 1_000_000 {
		return reject("content terlalu panjang")
	}
	if m.Note.CreatedAt <= 0 || m.Note.UpdatedAt < m.Note.CreatedAt {
		return reject("timestamp note tidak valid")
	}
	if m.Note.UpdatedAt > maxSafeInteger || m.Note.CreatedAt > maxSafeInteger {
		return reject("timestamp di luar rentang yang aman")
	}
	if m.Note.DeletedAt != nil && *m.Note.DeletedAt != m.Note.UpdatedAt {
		return reject("deleted_at harus sama dengan updated_at")
	}
	if m.Note.UpdatedAt > serverNow+clockSkewGrace {
		return validationError{422, "CLOCK_SKEW", "jam perangkat terlalu jauh di depan jam server"}
	}
	return nil
}
func compare(a, b note) int {
	if a.UpdatedAt > b.UpdatedAt {
		return 1
	}
	if a.UpdatedAt < b.UpdatedAt {
		return -1
	}
	if a.MutationID > b.MutationID {
		return 1
	}
	if a.MutationID < b.MutationID {
		return -1
	}
	return 0
}
func sameDeleted(a, b *int64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

type rowScanner interface{ Scan(...any) error }

func scanNote(s rowScanner) (note, error) {
	var n note
	var d sql.NullInt64
	err := s.Scan(&n.ID, &n.Title, &n.Content, &n.FolderID, &n.CreatedAt, &n.UpdatedAt, &d, &n.MutationID, &n.Revision, &n.ServerUpdatedAt, &n.PasswordHash)
	n.IsLocked = n.PasswordHash != ""
	if d.Valid {
		n.DeletedAt = &d.Int64
	}
	return n, err
}
func getNote(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, userID, id string) (note, bool, error) {
	var n note
	var d sql.NullInt64
	err := q.QueryRowContext(ctx, "SELECT id,title,content,folder_id,created_at,updated_at,deleted_at,mutation_id,revision,server_updated_at,password_hash FROM notes WHERE user_id=? AND id=?", userID, id).Scan(&n.ID, &n.Title, &n.Content, &n.FolderID, &n.CreatedAt, &n.UpdatedAt, &d, &n.MutationID, &n.Revision, &n.ServerUpdatedAt, &n.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return note{}, false, nil
	}
	if d.Valid {
		n.DeletedAt = &d.Int64
	}
	n.IsLocked = n.PasswordHash != ""
	return n, true, err
}

func decodeJSON(r *http.Request, dst any, max int64) error {
	if r.Method != http.MethodGet {
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			return errors.New("content type harus application/json")
		}
	}
	r.Body = io.NopCloser(io.LimitReader(r.Body, max+1))
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return errors.New("trailing json")
	}
	return nil
}
func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}
func jsonError(w http.ResponseWriter, status int, code, msg string) {
	recordError(w, code)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": msg}, "server_time": time.Now().UnixMilli()})
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func uuid() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
