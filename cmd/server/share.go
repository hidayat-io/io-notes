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
