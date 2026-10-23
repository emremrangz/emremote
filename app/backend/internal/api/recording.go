package api

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/emremrangz/emremote/internal/store"
)

// Screen recording. The gateway (guacd) writes every recorded session to a file on the recordings volume; this
// file decides which sessions are recorded, lists them for playback and removes old ones. Recordings show what the
// screen shows (what a person types is recorded only as far as the remote computer echoes it): the keyboard itself is
// never recorded (recording-include-keys stays off), so a password typed at a hidden prompt is not captured.
const recordingKey = "recording"

var recordingProtocols = []string{"ssh", "rdp", "vnc", "telnet"}

type recordingConfig struct {
	// Enabled is the master switch: nothing is recorded while it is off.
	Enabled bool `json:"enabled"`
	// RecordAll records every connection of the chosen protocols; otherwise only devices set to "on" are recorded.
	RecordAll bool     `json:"record_all"`
	Protocols []string `json:"protocols"`
	// RetentionDays deletes recordings older than this many days (0 keeps them).
	RetentionDays int `json:"retention_days"`
	// MaxGB deletes the oldest recordings when they take more than this many gigabytes (0 = no limit).
	MaxGB int `json:"max_gb"`
	// Devices holds per-device exceptions: "on" always records, "off" never records.
	Devices map[string]string `json:"devices"`
}

func defaultRecordingConfig() recordingConfig {
	return recordingConfig{RecordAll: true, Protocols: slices.Clone(recordingProtocols), RetentionDays: 30, Devices: map[string]string{}}
}

// shouldRecord says whether a session to this device with this protocol is recorded.
func (c recordingConfig) shouldRecord(protocol, deviceID string) bool {
	if !c.Enabled {
		return false
	}
	switch c.Devices[deviceID] {
	case "off":
		return false
	case "on":
		return true
	}
	return c.RecordAll && slices.Contains(c.Protocols, protocol)
}

func validateRecordingConfig(c *recordingConfig) string {
	if c.Devices == nil {
		c.Devices = map[string]string{}
	}
	switch {
	case c.RetentionDays < 0 || c.RetentionDays > 3650:
		return "Keep recordings for between 0 (forever) and 3650 days."
	case c.MaxGB < 0 || c.MaxGB > 100000:
		return "The size limit must be between 0 (no limit) and 100000 GB."
	case len(c.Devices) > 1000:
		return "At most 1000 device exceptions."
	}
	for _, p := range c.Protocols {
		if !slices.Contains(recordingProtocols, p) {
			return "Unknown protocol " + truncate(p, 20) + "."
		}
	}
	for id, v := range c.Devices {
		if !validUUID(id) || (v != "on" && v != "off") {
			return "Device exceptions must be \"on\" or \"off\"."
		}
	}
	c.Protocols = slices.Compact(slices.Sorted(slices.Values(c.Protocols)))
	if c.Protocols == nil {
		c.Protocols = []string{}
	}
	return ""
}

func (s *Server) recordingConfig(ctx context.Context) recordingConfig {
	c := defaultRecordingConfig()
	if raw, ok, err := s.store.GetSetting(ctx, recordingKey); err == nil && ok {
		_ = json.Unmarshal(raw, &c)
		if validateRecordingConfig(&c) != "" {
			return defaultRecordingConfig()
		}
	}
	return c
}

// recordingPlan is a session that will be recorded.
type recordingPlan struct {
	id string
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// planRecording decides whether this session is recorded and, if so, adds the gateway's recording parameters.
func (s *Server) planRecording(ctx context.Context, protocol, deviceID string, values map[string]string) *recordingPlan {
	if !s.recordingConfig(ctx).shouldRecord(protocol, deviceID) {
		return nil
	}
	if !s.recordingsWritable() {
		slog.Warn("recording is on but the recordings folder is not writable; this session is not recorded", "dir", s.cfg.RecordingsDir)
		return nil
	}
	id := newUUID()
	values["recording-path"] = s.cfg.RecordingsDir
	values["recording-name"] = id
	values["create-recording-path"] = "false"
	values["recording-include-keys"] = "false"
	return &recordingPlan{id: id}
}

func (s *Server) recordingFile(id string) string { return filepath.Join(s.cfg.RecordingsDir, id) }

func (s *Server) recordingsWritable() bool {
	f, err := os.CreateTemp(s.cfg.RecordingsDir, ".probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	return os.Remove(name) == nil
}

// beginRecording stores the row of a recording that has just started.
func (s *Server) beginRecording(ctx context.Context, p *recordingPlan, a *ActiveSession, started time.Time) {
	x := &store.Recording{
		ID: p.id, SessionID: a.ID, Username: a.Username, DeviceName: a.DeviceName, ConnectionName: a.ConnectionName,
		Protocol: a.Protocol, StartedAt: started,
	}
	if a.UserID != "" {
		x.UserID = &a.UserID
	}
	if a.DeviceID != "" {
		x.DeviceID = &a.DeviceID
	}
	if err := s.store.CreateRecording(ctx, x); err != nil {
		slog.Error("save recording", "error", err)
	}
}

// endRecording notes the final size of the file.
func (s *Server) endRecording(p *recordingPlan) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var size int64
	if fi, err := os.Stat(s.recordingFile(p.id)); err == nil {
		size = fi.Size()
	}
	if err := s.store.FinishRecording(ctx, p.id, time.Now(), size); err != nil {
		slog.Warn("finish recording", "error", err)
	}
}

// finishStaleRecordings closes the rows of sessions that were running when the server last stopped.
func (s *Server) finishStaleRecordings(ctx context.Context) {
	rows, err := s.store.UnfinishedRecordings(ctx)
	if err != nil {
		return
	}
	for _, x := range rows {
		ended, size := x.StartedAt, int64(0)
		if fi, err := os.Stat(s.recordingFile(x.ID)); err == nil {
			ended, size = fi.ModTime(), fi.Size()
		}
		_ = s.store.FinishRecording(ctx, x.ID, ended, size)
	}
}

func (s *Server) removeRecording(ctx context.Context, x *store.Recording) {
	if err := os.Remove(s.recordingFile(x.ID)); err != nil && !os.IsNotExist(err) {
		slog.Warn("delete recording file", "recording", x.ID, "error", err)
		return
	}
	_ = s.store.DeleteRecording(ctx, x.ID)
}

// pruneRecordings applies the retention settings.
func (s *Server) pruneRecordings(ctx context.Context) {
	c := s.recordingConfig(ctx)
	n := 0
	if c.RetentionDays > 0 {
		if old, err := s.store.FinishedRecordingsBefore(ctx, time.Now().AddDate(0, 0, -c.RetentionDays)); err == nil {
			for _, x := range old {
				s.removeRecording(ctx, x)
				n++
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
					s.removeRecording(ctx, x)
					total -= x.SizeBytes
					n++
				}
			}
		}
	}
	if n > 0 {
		slog.Info("removed old recordings", "count", n)
	}
}

// ---- Storage status ----

type recordingStorage struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"` // volume, nfs, smb
	FSType     string `json:"fs_type"`
	Writable   bool   `json:"writable"`
	TotalBytes uint64 `json:"total_bytes"`
	FreeBytes  uint64 `json:"free_bytes"`
	Count      int    `json:"count"`
	UsedBytes  int64  `json:"used_bytes"`
}

// mountType returns the file system type of the mount that holds dir.
func mountType(dir string) string {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	defer f.Close()
	best, typ := "", ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		parts := strings.Split(sc.Text(), " - ")
		if len(parts) != 2 {
			continue
		}
		left, right := strings.Fields(parts[0]), strings.Fields(parts[1])
		if len(left) < 5 || len(right) < 1 {
			continue
		}
		mp := strings.ReplaceAll(left[4], `\040`, " ")
		if (dir == mp || strings.HasPrefix(dir, strings.TrimSuffix(mp, "/")+"/")) && len(mp) >= len(best) {
			best, typ = mp, right[0]
		}
	}
	return typ
}

func storageKind(fsType string) string {
	switch {
	case strings.HasPrefix(fsType, "nfs"):
		return "nfs"
	case fsType == "cifs" || fsType == "smb3" || fsType == "smbfs":
		return "smb"
	}
	return "volume"
}

func (s *Server) recordingStorage(ctx context.Context) recordingStorage {
	st := recordingStorage{Path: s.cfg.RecordingsDir}
	st.FSType = mountType(s.cfg.RecordingsDir)
	st.Kind = storageKind(st.FSType)
	st.Writable = s.recordingsWritable()
	var fs syscall.Statfs_t
	if syscall.Statfs(s.cfg.RecordingsDir, &fs) == nil {
		st.TotalBytes = fs.Blocks * uint64(fs.Bsize)
		st.FreeBytes = fs.Bavail * uint64(fs.Bsize)
	}
	st.Count, st.UsedBytes, _ = s.store.RecordingTotals(ctx)
	return st
}

// ---- Handlers ----

func (s *Server) handleGetRecordingSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"config": s.recordingConfig(r.Context()), "storage": s.recordingStorage(r.Context())})
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
	raw, _ := json.Marshal(c)
	if err := s.store.SetSetting(r.Context(), recordingKey, raw); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.audit(r, "settings.recording", "settings", "", "Session recording", true, map[string]any{
		"enabled": c.Enabled, "record_all": c.RecordAll, "protocols": c.Protocols, "retention_days": c.RetentionDays, "max_gb": c.MaxGB, "device_exceptions": len(c.Devices),
	})
	go s.pruneRecordings(context.Background())
	s.handleGetRecordingSettings(w, r)
}

// visibleRecording loads a recording the signed-in user may see: administrators any, others their own.
func (s *Server) visibleRecording(w http.ResponseWriter, r *http.Request) *store.Recording {
	id := r.PathValue("id")
	u := userFrom(r.Context())
	if !validUUID(id) {
		writeError(w, http.StatusNotFound, "not_found", "Recording not found")
		return nil
	}
	x, err := s.store.GetRecording(r.Context(), id)
	if err != nil || (!u.IsAdmin() && (x.UserID == nil || *x.UserID != u.ID)) {
		writeError(w, http.StatusNotFound, "not_found", "Recording not found")
		return nil
	}
	return x
}

func (s *Server) handleListRecordings(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	q := r.URL.Query()
	f := store.RecordingFilter{DeviceID: q.Get("device_id"), Protocol: q.Get("protocol"), Limit: 100}
	if f.DeviceID != "" && !validUUID(f.DeviceID) {
		f.DeviceID = "00000000-0000-0000-0000-000000000000"
	}
	if !u.IsAdmin() {
		f.UserID = u.ID
	} else if uid := q.Get("user_id"); validUUID(uid) {
		f.UserID = uid
	}
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 && n <= 500 {
		f.Limit = n
	}
	if n, err := strconv.Atoi(q.Get("offset")); err == nil && n > 0 {
		f.Offset = n
	}
	items, total, err := s.store.ListRecordings(r.Context(), f)
	if err != nil {
		writeStoreError(w, r, err, "Recordings")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// handleRecordingFile streams the recording to the player (or as a download).
func (s *Server) handleRecordingFile(w http.ResponseWriter, r *http.Request) {
	x := s.visibleRecording(w, r)
	if x == nil {
		return
	}
	f, err := os.Open(s.recordingFile(x.ID))
	if err != nil {
		writeError(w, http.StatusNotFound, "file_missing", "The recording file is no longer on the server")
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusNotFound, "file_missing", "The recording file is no longer on the server")
		return
	}
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
	http.ServeContent(w, r, "", fi.ModTime(), f)
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
	s.removeRecording(r.Context(), x)
	s.audit(r, "recording.delete", "recording", x.ID, x.DeviceName+" / "+x.ConnectionName, true, map[string]any{"owner": x.Username})
	w.WriteHeader(http.StatusNoContent)
}
