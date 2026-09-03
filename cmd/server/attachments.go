package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	presignTTL        = 15 * time.Minute
	attachRetention   = 60 * time.Minute
	maxPendingPerUser = 10
	sweepBatch        = 20
)

// objectStore abstracts the byte storage so tests can substitute an in-memory
// fake and dev mode can substitute a local directory for R2.
type objectStore interface {
	PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Head(ctx context.Context, key string) (int64, error)
	Delete(ctx context.Context, key string) error
}

/* ------------------------------------------------------------------ R2 */

type r2Store struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

func newR2Store(cfg config) *r2Store {
	awsCfg := aws.Config{
		Region:      "auto",
		Credentials: credentials.NewStaticCredentialsProvider(cfg.R2AccessKeyID, cfg.R2SecretAccessKey, ""),
	}
	// Path-style keeps every presigned URL on one stable host for the CSP.
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String("https://" + cfg.R2AccountID + ".r2.cloudflarestorage.com")
		o.UsePathStyle = true
	})
	return &r2Store{client: client, presigner: s3.NewPresignClient(client), bucket: cfg.R2Bucket}
}

func (s *r2Store) PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error) {
	in := &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, ContentType: &contentType, ContentLength: aws.Int64(size)}
	out, err := s.presigner.PresignPutObject(ctx, in, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return out.URL, nil
}

func (s *r2Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

func (s *r2Store) Head(ctx context.Context, key string) (int64, error) {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return 0, err
	}
	return aws.ToInt64(out.ContentLength), nil
}

func (s *r2Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key})
	return err
}

func (s *r2Store) bootstrapCORS(ctx context.Context, origin string) error {
	_, err := s.client.PutBucketCors(ctx, &s3.PutBucketCorsInput{
		Bucket: &s.bucket,
		CORSConfiguration: &types.CORSConfiguration{CORSRules: []types.CORSRule{{
			AllowedOrigins: []string{origin},
			AllowedMethods: []string{"PUT", "GET", "HEAD"},
			AllowedHeaders: []string{"*"},
			ExposeHeaders:  []string{"ETag"},
			MaxAgeSeconds:  aws.Int32(3600),
		}}},
	})
	return err
}

/* ------------------------------------------------- local dev store */

// localStore serves the same contract from a directory, exclusively for
// AUTH_MODE=dev so the upload flow can be exercised without R2 credentials.
// The "presigned" URLs point at the dev-only /api/v1/devblob route, which is
// session-authenticated like every other /api route.
type localStore struct{ dir string }

func (s *localStore) PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error) {
	return "/api/v1/devblob/" + key + "?op=put&len=" + strconv.FormatInt(size, 10), nil
}

func (s *localStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	return os.Open(filepath.Join(s.dir, filepath.FromSlash(key)))
}

func (s *localStore) Head(ctx context.Context, key string) (int64, error) {
	fi, err := os.Stat(filepath.Join(s.dir, filepath.FromSlash(key)))
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

func (s *localStore) Delete(ctx context.Context, key string) error {
	base := filepath.Join(s.dir, filepath.FromSlash(key))
	_ = os.Remove(base + ".meta")
	return os.Remove(base)
}

var devBlobKey = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (a *application) devBlob(w http.ResponseWriter, r *http.Request) {
	u := r.Context().Value(userKey{}).(user)
	key := r.PathValue("key")
	if !devBlobKey.MatchString(key) || !strings.HasPrefix(key, u.ID+"/") {
		jsonError(w, 404, "NOT_FOUND", "tidak ditemukan")
		return
	}
	ls, ok := a.store.(*localStore)
	if !ok {
		jsonError(w, 404, "NOT_FOUND", "tidak ditemukan")
		return
	}
	base := filepath.Join(ls.dir, filepath.FromSlash(key))
	switch r.URL.Query().Get("op") {
	case "put":
		max, err := strconv.ParseInt(r.URL.Query().Get("len"), 10, 64)
		if err != nil || max <= 0 || max > a.cfg.AttachMaxBytes {
			jsonError(w, 400, "VALIDATION_ERROR", "ukuran tidak valid")
			return
		}
		if err := os.MkdirAll(filepath.Dir(base), 0750); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal menyimpan")
			return
		}
		f, err := os.Create(base)
		if err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal menyimpan")
			return
		}
		n, err := io.Copy(f, io.LimitReader(r.Body, max+1))
		closeErr := f.Close()
		if err != nil || closeErr != nil || n > max {
			_ = os.Remove(base)
			jsonError(w, 400, "VALIDATION_ERROR", "body upload tidak sesuai")
			return
		}
		ct := r.Header.Get("Content-Type")
		_ = os.WriteFile(base+".meta", []byte(ct), 0640)
		w.WriteHeader(http.StatusOK)
	default:
		jsonError(w, 400, "VALIDATION_ERROR", "op tidak valid")
	}
}

/* ------------------------------------------------------- validation */

type attachRule struct {
	kind string
	exts []string
}

var attachAllowlist = map[string]attachRule{
	"image/jpeg":         {"image", []string{"jpg", "jpeg"}},
	"image/png":          {"image", []string{"png"}},
	"image/webp":         {"image", []string{"webp"}},
	"image/gif":          {"image", []string{"gif"}},
	"application/pdf":    {"document", []string{"pdf"}},
	"application/msword": {"document", []string{"doc"}},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": {"document", []string{"docx"}},
	"application/vnd.ms-excel": {"document", []string{"xls"}},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {"document", []string{"xlsx"}},
	"text/plain":                   {"document", []string{"txt"}},
	"text/markdown":                {"document", []string{"md"}},
	"application/zip":              {"document", []string{"zip"}},
	"application/x-zip-compressed": {"document", []string{"zip"}},
}

func sanitizeFilename(name string) string {
	name = strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	if utf8.RuneCountInString(name) > 255 {
		for utf8.RuneCountInString(name) > 252 {
			name = name[:len(name)-1]
		}
		name += "…"
	}
	return name
}

func sanitizeHeaderFilename(name string) string {
	name = sanitizeFilename(name)
	name = strings.NewReplacer(`"`, "'", "\n", " ", "\r", " ").Replace(name)
	if name == "" {
		name = "lampiran"
	}
	return name
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// Only formats that browsers can display without executing uploaded HTML or
// relying on a third-party document service may be served inline. Markdown and
// plain text are fetched and rendered by the client; PDF uses the browser's
// built-in viewer.
func inlinePreviewType(contentType string) bool {
	switch contentType {
	case "application/pdf", "text/plain", "text/markdown":
		return true
	default:
		return false
	}
}

/* -------------------------------------------------------- handlers */

type attachmentJSON struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	Kind        string `json:"kind"`
	Status      string `json:"status,omitempty"`
	CreatedAt   int64  `json:"created_at"`
}

func (a *application) attachGate(w http.ResponseWriter) bool {
	if !a.attachEnabled || a.store == nil {
		jsonError(w, 503, "ATTACHMENTS_NOT_CONFIGURED", "fitur lampiran tidak dikonfigurasi")
		return false
	}
	return true
}

func (a *application) createAttachment(w http.ResponseWriter, r *http.Request) {
	if !a.attachGate(w) {
		return
	}
	u := r.Context().Value(userKey{}).(user)
	var in struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		SizeBytes   int64  `json:"size_bytes"`
	}
	if err := decodeJSON(r, &in, 4096); err != nil {
		jsonError(w, 400, "BAD_JSON", "body tidak valid")
		return
	}
	name := sanitizeFilename(in.Filename)
	if name == "" {
		jsonError(w, 400, "VALIDATION_ERROR", "nama file wajib diisi")
		return
	}
	if in.SizeBytes <= 0 {
		jsonError(w, 400, "VALIDATION_ERROR", "ukuran file tidak valid")
		return
	}
	if in.SizeBytes > a.cfg.AttachMaxBytes {
		jsonError(w, 413, "PAYLOAD_TOO_LARGE", fmt.Sprintf("file melebihi batas %d MB", a.cfg.AttachMaxBytes>>20))
		return
	}
	rule, ok := attachAllowlist[in.ContentType]
	if !ok {
		jsonError(w, 400, "VALIDATION_ERROR", "jenis file tidak didukung")
		return
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if !containsString(rule.exts, ext) {
		jsonError(w, 400, "VALIDATION_ERROR", "ekstensi file tidak cocok dengan jenisnya")
		return
	}

	_ = a.sweepAttachments(r.Context())

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}
	defer tx.Rollback()

	var pending int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM attachments WHERE user_id=? AND status='pending' AND deleted_at IS NULL", u.ID).Scan(&pending); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal memeriksa kuota")
		return
	}
	if pending >= maxPendingPerUser {
		jsonError(w, 400, "VALIDATION_ERROR", "terlalu banyak upload tertunda, coba lagi sebentar lagi")
		return
	}
	var globalUsed, userUsed int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(size_bytes),0) FROM attachments WHERE deleted_at IS NULL").Scan(&globalUsed); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal memeriksa kuota")
		return
	}
	if globalUsed+in.SizeBytes > a.cfg.AttachGlobalCapBytes {
		jsonError(w, 503, "STORAGE_FULL", "penyimpanan bersama penuh, coba lagi nanti")
		return
	}
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(size_bytes),0) FROM attachments WHERE user_id=? AND deleted_at IS NULL", u.ID).Scan(&userUsed); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal memeriksa kuota")
		return
	}
	if userUsed+in.SizeBytes > a.cfg.AttachUserQuotaBytes {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(413)
		fmt.Fprintf(w, "%s", mustJSON(map[string]any{
			"error":       map[string]string{"code": "QUOTA_EXCEEDED", "message": "kuota lampiran kamu penuh"},
			"used_bytes":  userUsed,
			"quota_bytes": a.cfg.AttachUserQuotaBytes,
			"server_time": time.Now().UnixMilli(),
		}))
		return
	}

	id := uuid()
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(r.Context(),
		"INSERT INTO attachments (user_id,id,filename,content_type,size_bytes,kind,status,created_at) VALUES (?,?,?,?,?,?, 'pending',?)",
		u.ID, id, name, in.ContentType, in.SizeBytes, rule.kind, now); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menyiapkan upload")
		return
	}
	if err := tx.Commit(); err != nil {
		jsonError(w, 503, "DATABASE_UNAVAILABLE", "database tidak tersedia")
		return
	}

	uploadURL, err := a.store.PresignPut(r.Context(), u.ID+"/"+id, in.ContentType, in.SizeBytes, presignTTL)
	if err != nil {
		a.logger.Error("attachment_presign_put_failed", "user", u.ID, "error", err)
		_, _ = a.db.ExecContext(r.Context(), "DELETE FROM attachments WHERE user_id=? AND id=? AND status='pending'", u.ID, id)
		jsonError(w, 500, "INTERNAL_ERROR", "gagal menyiapkan upload")
		return
	}
	jsonOK(w, map[string]any{
		"attachment":  attachmentJSON{ID: id, Filename: name, ContentType: in.ContentType, SizeBytes: in.SizeBytes, Kind: rule.kind, Status: "pending", CreatedAt: now},
		"upload_url":  uploadURL,
		"expires_in":  int(presignTTL / time.Second),
		"server_time": now,
	})
}

func (a *application) confirmAttachment(w http.ResponseWriter, r *http.Request) {
	if !a.attachGate(w) {
		return
	}
	u := r.Context().Value(userKey{}).(user)
	id := r.PathValue("id")
	var in struct{}
	if err := decodeJSON(r, &in, 1024); err != nil {
		jsonError(w, 400, "BAD_JSON", "body tidak valid")
		return
	}
	var status string
	var size int64
	var deletedAt sql.NullInt64
	err := a.db.QueryRowContext(r.Context(), "SELECT status,size_bytes,deleted_at FROM attachments WHERE user_id=? AND id=?", u.ID, id).Scan(&status, &size, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) || deletedAt.Valid {
		jsonError(w, 404, "NOT_FOUND", "tidak ditemukan")
		return
	}
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca lampiran")
		return
	}
	if status == "active" {
		jsonOK(w, map[string]any{"attachment": attachmentJSON{ID: id, Status: "active"}, "server_time": time.Now().UnixMilli()})
		return
	}

	headSize, err := a.store.Head(r.Context(), u.ID+"/"+id)
	if err != nil {
		jsonError(w, 400, "UPLOAD_INCOMPLETE", "upload belum selesai, ulangi upload")
		return
	}
	if headSize != size {
		_ = a.store.Delete(r.Context(), u.ID+"/"+id)
		_, _ = a.db.ExecContext(r.Context(), "DELETE FROM attachments WHERE user_id=? AND id=? AND status='pending'", u.ID, id)
		jsonError(w, 400, "UPLOAD_MISMATCH", "ukuran upload tidak cocok, ulangi upload")
		return
	}
	now := time.Now().UnixMilli()
	if _, err := a.db.ExecContext(r.Context(), "UPDATE attachments SET status='active', confirmed_at=? WHERE user_id=? AND id=? AND status='pending'", now, u.ID, id); err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal mengonfirmasi lampiran")
		return
	}
	jsonOK(w, map[string]any{"attachment": attachmentJSON{ID: id, Status: "active"}, "server_time": now})
}

func (a *application) listAttachments(w http.ResponseWriter, r *http.Request) {
	if !a.attachGate(w) {
		return
	}
	u := r.Context().Value(userKey{}).(user)
	rows, err := a.db.QueryContext(r.Context(),
		"SELECT id,filename,content_type,size_bytes,kind,created_at FROM attachments WHERE user_id=? AND deleted_at IS NULL AND status='active' ORDER BY created_at DESC LIMIT 500", u.ID)
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca lampiran")
		return
	}
	defer rows.Close()
	list := make([]attachmentJSON, 0)
	for rows.Next() {
		var at attachmentJSON
		if err := rows.Scan(&at.ID, &at.Filename, &at.ContentType, &at.SizeBytes, &at.Kind, &at.CreatedAt); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca lampiran")
			return
		}
		list = append(list, at)
	}
	var used int64
	_ = a.db.QueryRowContext(r.Context(), "SELECT COALESCE(SUM(size_bytes),0) FROM attachments WHERE user_id=? AND deleted_at IS NULL", u.ID).Scan(&used)
	jsonOK(w, map[string]any{
		"attachments": list,
		"quota":       map[string]int64{"used_bytes": used, "quota_bytes": a.cfg.AttachUserQuotaBytes},
		"server_time": time.Now().UnixMilli(),
	})
}

func (a *application) downloadAttachment(w http.ResponseWriter, r *http.Request) {
	if !a.attachGate(w) {
		return
	}
	u := r.Context().Value(userKey{}).(user)
	id := r.PathValue("id")
	var status, filename, contentType, kind string
	var size int64
	var deletedAt sql.NullInt64
	err := a.db.QueryRowContext(r.Context(), "SELECT status,filename,content_type,size_bytes,kind,deleted_at FROM attachments WHERE user_id=? AND id=?", u.ID, id).
		Scan(&status, &filename, &contentType, &size, &kind, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) || deletedAt.Valid || status != "active" {
		jsonError(w, 404, "NOT_FOUND", "tidak ditemukan")
		return
	}
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca lampiran")
		return
	}
	body, err := a.store.Get(r.Context(), u.ID+"/"+id)
	if err != nil {
		a.logger.Error("attachment_get_failed", "user", u.ID, "error", err)
		jsonError(w, 404, "NOT_FOUND", "tidak ditemukan")
		return
	}
	defer body.Close()
	if contentType == "text/plain" || contentType == "text/markdown" {
		w.Header().Set("Content-Type", contentType+"; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "private, max-age=300")
	preview := r.URL.Query().Get("preview") == "1" && inlinePreviewType(contentType)
	if r.URL.Query().Get("dl") == "1" || (kind == "document" && !preview) {
		w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeHeaderFilename(filename)+`"`)
	} else if preview {
		w.Header().Set("Content-Disposition", `inline; filename="`+sanitizeHeaderFilename(filename)+`"`)
		// The site shell itself must never be framed, but a PDF preview must be.
		// Keep uploaded inline content sandboxed and restrict its only ancestor to
		// this application instead of inheriting the shell's frame-ancestors 'none'.
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	io.Copy(w, io.LimitReader(body, size))
}

func (a *application) deleteAttachment(w http.ResponseWriter, r *http.Request) {
	if !a.attachGate(w) {
		return
	}
	u := r.Context().Value(userKey{}).(user)
	id := r.PathValue("id")
	var status string
	var deletedAt sql.NullInt64
	err := a.db.QueryRowContext(r.Context(), "SELECT status,deleted_at FROM attachments WHERE user_id=? AND id=?", u.ID, id).Scan(&status, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) || deletedAt.Valid {
		jsonError(w, 404, "NOT_FOUND", "tidak ditemukan")
		return
	}
	if err != nil {
		jsonError(w, 500, "INTERNAL_ERROR", "gagal membaca lampiran")
		return
	}
	if status == "pending" {
		if _, err := a.db.ExecContext(r.Context(), "DELETE FROM attachments WHERE user_id=? AND id=? AND status='pending'", u.ID, id); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal menghapus lampiran")
			return
		}
		if err := a.store.Delete(r.Context(), u.ID+"/"+id); err != nil {
			a.logger.Warn("attachment_orphan", "key", u.ID+"/"+id, "error", err)
		}
	} else {
		if _, err := a.db.ExecContext(r.Context(), "UPDATE attachments SET deleted_at=? WHERE user_id=? AND id=?", time.Now().UnixMilli(), u.ID, id); err != nil {
			jsonError(w, 500, "INTERNAL_ERROR", "gagal menghapus lampiran")
			return
		}
	}
	jsonOK(w, map[string]any{"ok": true, "server_time": time.Now().UnixMilli()})
}

/* ---------------------------------------------------------- sweep */

// sweepAttachmentsInTx removes expired pending rows and long-deleted rows inside
// the caller's transaction and returns their object keys; the caller deletes the
// objects after commit so a failed object delete can never resurrect quota.
func sweepAttachmentsInTx(ctx context.Context, tx *sql.Tx) ([]string, error) {
	cutoff := time.Now().Add(-attachRetention).UnixMilli()
	rows, err := tx.QueryContext(ctx,
		"SELECT user_id,id FROM attachments WHERE (status='pending' AND created_at < ?) OR (deleted_at IS NOT NULL AND deleted_at < ?) LIMIT ?",
		cutoff, cutoff, sweepBatch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var uid, id string
		if err := rows.Scan(&uid, &id); err != nil {
			return nil, err
		}
		keys = append(keys, uid+"/"+id)
	}
	if len(keys) == 0 {
		return nil, nil
	}
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM attachments WHERE (status='pending' AND created_at < ?) OR (deleted_at IS NOT NULL AND deleted_at < ?)",
		cutoff, cutoff); err != nil {
		return nil, err
	}
	return keys, nil
}

func (a *application) sweepAttachments(ctx context.Context) error {
	if a.store == nil {
		return nil
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	keys, err := sweepAttachmentsInTx(ctx, tx)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, k := range keys {
		if err := a.store.Delete(ctx, k); err != nil {
			a.logger.Warn("attachment_orphan", "key", k, "error", err)
		}
	}
	return nil
}
