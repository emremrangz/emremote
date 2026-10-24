package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/emremrangz/emremote/internal/remotestore"
	"github.com/emremrangz/emremote/internal/store"
)

// A network share for recordings. The gateway always writes to this server's recordings folder; when an SMB or NFS
// share is chosen, the application copies each finished recording to it (and removes the local file unless
// "keep a copy" is set). The share password is sealed with the server key alone: copying must work while nobody has
// signed in since the last restart.
const recordingSecretKey = "recording_secret"

var errShareNotSet = errors.New("this recording is on a network share that is not set up in Settings now")

func recordingSecretAAD() []byte { return []byte("emremote:recording-share") }

func (s *Server) recordingSharePassword(ctx context.Context) string {
	raw, ok, err := s.store.GetSetting(ctx, recordingSecretKey)
	if err != nil || !ok {
		return ""
	}
	// Settings are stored as JSON, so the sealed password is kept as a base64 string.
	var enc string
	ct, err := []byte(nil), json.Unmarshal(raw, &enc)
	if err == nil {
		ct, err = base64.StdEncoding.DecodeString(enc)
	}
	if err != nil {
		return ""
	}
	pt, err := s.box.Open(ct, recordingSecretAAD())
	if err != nil {
		slog.Warn("recording share password cannot be decrypted (was EMREMOTE_ENCRYPTION_KEY changed?)")
		return ""
	}
	return string(pt)
}

func (s *Server) hasRecordingSharePassword(ctx context.Context) bool {
	_, ok, _ := s.store.GetSetting(ctx, recordingSecretKey)
	return ok
}

// openShare connects to the share in t. The address is resolved and checked against the target network policy here, and
// the connection goes to that address, so the share can only be somewhere administrators allowed.
func (s *Server) openShare(ctx context.Context, t recordingTarget, password string) (remotestore.Backend, error) {
	if !t.remote() {
		return nil, errShareNotSet
	}
	addr, err := s.policy.Resolve(ctx, t.Host)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	return remotestore.Open(ctx, t.config(password), addr)
}

// syncRecordings copies recordings that are only on this server to the share, one at a time.
func (s *Server) syncRecordings(ctx context.Context) {
	if !s.recSync.TryLock() {
		return
	}
	defer s.recSync.Unlock()
	cfg := s.recordingConfig(ctx)
	if !cfg.Storage.remote() {
		return
	}
	rows, err := s.store.LocalOnlyRecordings(ctx)
	if err != nil || len(rows) == 0 {
		return
	}
	be, err := s.openShare(ctx, cfg.Storage, s.recordingSharePassword(ctx))
	if err != nil {
		slog.Warn("recording share is not reachable; recordings stay on this server for now", "error", err)
		return
	}
	defer be.Close()
	n := 0
	for _, x := range rows {
		if ctx.Err() != nil {
			break
		}
		path := s.recordingFile(x.ID)
		fi, err := os.Stat(path)
		if err != nil || time.Since(fi.ModTime()) < 20*time.Second {
			continue // missing, or the gateway may still be writing it
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		written, err := be.Put(x.ID, f)
		f.Close()
		if err != nil || written != fi.Size() {
			slog.Warn("copy recording to the share failed", "recording", x.ID, "error", err)
			_ = be.Remove(x.ID)
			continue
		}
		loc := "remote"
		if cfg.Storage.KeepLocal {
			loc = "both"
		}
		if err := s.store.SetRecordingLocation(ctx, x.ID, loc, written); err != nil {
			continue
		}
		if loc == "remote" {
			_ = os.Remove(path)
		}
		n++
	}
	if n > 0 {
		slog.Info("copied recordings to the network share", "count", n)
	}
}

// removeRecording deletes the file(s) and the row. be is the open share (may be nil); it is opened on demand.
func (s *Server) removeRecording(ctx context.Context, x *store.Recording, shareOf func() (remotestore.Backend, error)) error {
	if x.Location != "remote" {
		if err := os.Remove(s.recordingFile(x.ID)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if x.Location != "local" {
		be, err := shareOf()
		if err != nil {
			return err
		}
		if err := be.Remove(x.ID); err != nil {
			return err
		}
	}
	return s.store.DeleteRecording(ctx, x.ID)
}

// lazyShare returns a function that connects once, when first needed, and a function that closes it.
func (s *Server) lazyShare(ctx context.Context) (get func() (remotestore.Backend, error), closeIt func()) {
	var be remotestore.Backend
	var openErr error
	tried := false
	return func() (remotestore.Backend, error) {
			if !tried {
				tried = true
				cfg := s.recordingConfig(ctx)
				be, openErr = s.openShare(ctx, cfg.Storage, s.recordingSharePassword(ctx))
			}
			return be, openErr
		}, func() {
			if be != nil {
				be.Close()
			}
		}
}

// pruneRecordings applies the retention settings.
func (s *Server) pruneRecordings(ctx context.Context) {
	c := s.recordingConfig(ctx)
	share, closeShare := s.lazyShare(ctx)
	defer closeShare()
	n := 0
	drop := func(x *store.Recording) bool {
		if err := s.removeRecording(ctx, x, share); err != nil {
			slog.Warn("could not delete a recording; it is tried again later", "recording", x.ID, "error", err)
			return false
		}
		n++
		return true
	}
	if c.RetentionDays > 0 {
		if old, err := s.store.FinishedRecordingsBefore(ctx, time.Now().AddDate(0, 0, -c.RetentionDays)); err == nil {
			for _, x := range old {
				drop(x)
			}
		}
	}
	if c.MaxGB > 0 {
		limit := int64(c.MaxGB) << 30
		if _, total, err := s.store.RecordingTotals(ctx); err == nil && total > limit {
			if oldest, err := s.store.OldestFinishedRecordings(ctx, 500); err == nil {
				for _, x := range oldest {
					if total <= limit {
						break
					}
					if drop(x) {
						total -= x.SizeBytes
					}
				}
			}
		}
	}
	if n > 0 {
		slog.Info("removed old recordings", "count", n)
	}
}

// ---- Handlers ----

func (s *Server) recordingSettingsView(ctx context.Context) map[string]any {
	c := s.recordingConfig(ctx)
	c.Storage.Password = ""
	c.Storage.HasPassword = s.hasRecordingSharePassword(ctx)
	st := s.recordingStorage(ctx)
	if c.Storage.remote() {
		sh := &shareStatus{}
		if rows, err := s.store.LocalOnlyRecordings(ctx); err == nil {
			sh.Pending = len(rows)
		}
		if be, err := s.openShare(ctx, c.Storage, s.recordingSharePassword(ctx)); err != nil {
			sh.Error = err.Error()
		} else {
			sh.Reachable = true
			be.Close()
		}
		st.Share = sh
	}
	return map[string]any{"config": c, "storage": st}
}

func (s *Server) handleGetRecordingSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.recordingSettingsView(r.Context()))
}

// probeShare connects with the settings in t (a saved password is used when none is given) and writes a test file.
func (s *Server) probeShare(ctx context.Context, t recordingTarget) error {
	pw := t.Password
	if pw == "" {
		pw = s.recordingSharePassword(ctx)
	}
	be, err := s.openShare(ctx, t, pw)
	if err != nil {
		return err
	}
	defer be.Close()
	return be.Probe()
}

func (s *Server) handleTestRecordingShare(w http.ResponseWriter, r *http.Request) {
	var c recordingConfig
	if !decodeJSON(w, r, &c) {
		return
	}
	if c.Storage.Kind != "smb" && c.Storage.Kind != "nfs" {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "Choose an SMB or NFS share first.")
		return
	}
	if msg := c.Storage.config("").Validate(); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", msg)
		return
	}
	if err := s.probeShare(r.Context(), c.Storage); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "message": shareError(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Connected, and a test file could be written and removed."})
}

func shareError(err error) string {
	m := err.Error()
	if len(m) > 300 {
		m = m[:300]
	}
	return strings.TrimSpace(m)
}

func (s *Server) handleSetRecordingSettings(w http.ResponseWriter, r *http.Request) {
	var c recordingConfig
	if !decodeJSON(w, r, &c) {
		return
	}
	if msg := validateRecordingConfig(&c); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", msg)
		return
	}
	if c.Enabled && !s.recordingsWritable() {
		writeError(w, http.StatusUnprocessableEntity, "storage_unavailable", "The recordings folder ("+s.cfg.RecordingsDir+") is not writable, so recording cannot be turned on. See the deployment guide.")
		return
	}
	password := c.Storage.Password
	c.Storage.Password, c.Storage.HasPassword = "", false
	if c.Storage.remote() {
		if err := s.probeShare(r.Context(), recordingTarget{Kind: c.Storage.Kind, Host: c.Storage.Host, Share: c.Storage.Share, Dir: c.Storage.Dir, Username: c.Storage.Username, Domain: c.Storage.Domain, UID: c.Storage.UID, GID: c.Storage.GID, Password: password}); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "share_unavailable", "The network share does not work with these settings: "+shareError(err))
			return
		}
		if password != "" {
			enc, err := s.box.SealServer([]byte(password), recordingSecretAAD())
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", "Could not protect the password")
				return
			}
			raw, _ := json.Marshal(base64.StdEncoding.EncodeToString(enc))
			if err := s.store.SetSetting(r.Context(), recordingSecretKey, raw); err != nil {
				writeStoreError(w, r, err, "Setting")
				return
			}
		}
	}
	raw, _ := json.Marshal(c)
	if err := s.store.SetSetting(r.Context(), recordingKey, raw); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.audit(r, "settings.recording", "settings", "", "Session recording", true, map[string]any{
		"enabled": c.Enabled, "record_all": c.RecordAll, "protocols": c.Protocols, "retention_days": c.RetentionDays, "max_gb": c.MaxGB,
		"device_exceptions": len(c.Devices), "storage": c.Storage.Kind, "storage_host": c.Storage.Host, "keep_local": c.Storage.KeepLocal,
	})
	go func() {
		s.pruneRecordings(context.Background())
		s.syncRecordings(context.Background())
	}()
	writeJSON(w, http.StatusOK, s.recordingSettingsView(r.Context()))
}

// openRecordingFile opens the recording for reading, from this server or from the share.
func (s *Server) openRecordingFile(ctx context.Context, x *store.Recording) (rs io.ReadSeeker, size int64, mod time.Time, closeFn func(), err error) {
	if x.Location != "remote" {
		if f, ferr := os.Open(s.recordingFile(x.ID)); ferr == nil {
			fi, serr := f.Stat()
			if serr != nil {
				f.Close()
				return nil, 0, mod, nil, serr
			}
			return f, fi.Size(), fi.ModTime(), func() { f.Close() }, nil
		}
		if x.Location == "local" {
			return nil, 0, mod, nil, os.ErrNotExist
		}
	}
	be, err := s.openShare(ctx, s.recordingConfig(ctx).Storage, s.recordingSharePassword(ctx))
	if err != nil {
		return nil, 0, mod, nil, err
	}
	f, err := be.Open(x.ID)
	if err != nil {
		be.Close()
		return nil, 0, mod, nil, err
	}
	return f, f.Size(), x.StartedAt, func() { f.Close(); be.Close() }, nil
}

// handleRecordingFile streams the recording to the player (or as a download).
func (s *Server) handleRecordingFile(w http.ResponseWriter, r *http.Request) {
	x := s.visibleRecording(w, r)
	if x == nil {
		return
	}
	rs, _, mod, closeFn, err := s.openRecordingFile(r.Context(), x)
	if err != nil {
		switch {
		case errors.Is(err, os.ErrNotExist), errors.Is(err, remotestore.ErrNotFound):
			writeError(w, http.StatusNotFound, "file_missing", "The recording file is no longer where it was stored")
		default:
			writeError(w, http.StatusBadGateway, "share_unavailable", "The recording is on the network share and it cannot be reached right now: "+shareError(err))
		}
		return
	}
	defer closeFn()
	download := r.URL.Query().Get("download") == "1"
	if download || r.Header.Get("Range") == "" {
		s.audit(r, "recording.view", "recording", x.ID, x.DeviceName+" / "+x.ConnectionName, true, map[string]any{"download": download, "owner": x.Username})
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if download {
		name := strings.Map(func(r rune) rune {
			if r < 0x20 || strings.ContainsRune(`"\/:*?<>|`, r) || r > 0x7e {
				return '_'
			}
			return r
		}, x.DeviceName+"-"+x.StartedAt.UTC().Format("2006-01-02-150405"))
		h.Set("Content-Disposition", `attachment; filename="`+name+`.guac"`)
	}
	http.ServeContent(w, r, "", mod, rs)
}

func (s *Server) handleDeleteRecording(w http.ResponseWriter, r *http.Request) {
	x := s.visibleRecording(w, r)
	if x == nil {
		return
	}
	if x.EndedAt == nil {
		writeError(w, http.StatusConflict, "in_progress", "This session is still being recorded")
		return
	}
	share, closeShare := s.lazyShare(r.Context())
	defer closeShare()
	if err := s.removeRecording(r.Context(), x, share); err != nil {
		writeError(w, http.StatusBadGateway, "delete_failed", "The recording could not be deleted: "+shareError(err))
		return
	}
	s.audit(r, "recording.delete", "recording", x.ID, x.DeviceName+" / "+x.ConnectionName, true, map[string]any{"owner": x.Username})
	w.WriteHeader(http.StatusNoContent)
}
