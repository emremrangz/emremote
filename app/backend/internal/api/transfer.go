package api

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/sshhelper"
	"github.com/emremrangz/emremote/internal/sshkey"
	"github.com/emremrangz/emremote/internal/store"
	"github.com/emremrangz/emremote/internal/transfer"
)

// ---- RDP transfer drive (files on the emremote host, redirected into RDP) ----

func (s *Server) transferDevice(w http.ResponseWriter, r *http.Request) *store.Device {
	if s.drive == nil {
		writeError(w, http.StatusServiceUnavailable, "transfer_unavailable", transfer.ErrUnavailable.Error())
		return nil
	}
	d, err := s.getDevice(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return nil
	}
	return d
}

func (s *Server) transferAudit(r *http.Request, d *store.Device, action string, success bool, details map[string]any) {
	details["device_id"] = d.ID
	details["drive"] = "rdp-transfer"
	s.audit(r, action, "device", d.ID, d.Name+" / transfer drive", success, details)
}

func (s *Server) handleTransferList(w http.ResponseWriter, r *http.Request) {
	d := s.transferDevice(w, r)
	if d == nil {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		p = "/"
	}
	l, err := s.drive.List(d.ID, p)
	if err != nil {
		remoteErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (s *Server) handleTransferDownload(w http.ResponseWriter, r *http.Request) {
	d := s.transferDevice(w, r)
	if d == nil {
		return
	}
	fi, full, err := s.drive.Stat(d.ID, r.URL.Query().Get("path"))
	if err != nil {
		remoteErr(w, err)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	var n int64
	if fi.IsDir() {
		w.Header().Set("Content-Disposition", contentDisposition(fi.Name()+".zip"))
		cw := &countingWriter{w: w}
		err = transfer.ZipDir(full, cw)
		n = cw.n
	} else {
		w.Header().Set("Content-Disposition", contentDisposition(fi.Name()))
		w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
		n, err = transfer.CopyFile(full, w)
	}
	s.transferAudit(r, d, "file.download", err == nil, map[string]any{"path": r.URL.Query().Get("path"), "bytes": n})
}

func (s *Server) handleTransferUpload(w http.ResponseWriter, r *http.Request) {
	d := s.transferDevice(w, r)
	if d == nil {
		return
	}
	q := r.URL.Query()
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(6 * time.Hour))
	n, err := s.drive.Upload(d.ID, q.Get("dir"), q.Get("name"), http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes), q.Get("overwrite") == "true")
	target := path.Join(q.Get("dir"), q.Get("name"))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "File exceeds the upload limit (EMREMOTE_MAX_UPLOAD_MB)")
			return
		}
		remoteErr(w, err)
		return
	}
	s.transferAudit(r, d, "file.upload", true, map[string]any{"path": target, "bytes": n})
	writeJSON(w, http.StatusCreated, map[string]any{"path": target, "bytes": n})
}

func (s *Server) handleTransferMkdir(w http.ResponseWriter, r *http.Request) {
	d := s.transferDevice(w, r)
	if d == nil {
		return
	}
	var req struct {
		Dir  string `json:"dir"`
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	p, err := s.drive.Mkdir(d.ID, req.Dir, strings.TrimSpace(req.Name))
	if err != nil {
		remoteErr(w, err)
		return
	}
	s.transferAudit(r, d, "file.mkdir", true, map[string]any{"path": p})
	writeJSON(w, http.StatusCreated, map[string]string{"path": p})
}

func (s *Server) handleTransferRename(w http.ResponseWriter, r *http.Request) {
	d := s.transferDevice(w, r)
	if d == nil {
		return
	}
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	to, err := s.drive.Rename(d.ID, req.Path, strings.TrimSpace(req.Name))
	if err != nil {
		remoteErr(w, err)
		return
	}
	s.transferAudit(r, d, "file.rename", true, map[string]any{"path": req.Path, "new_path": to})
	writeJSON(w, http.StatusOK, map[string]string{"path": to})
}

func (s *Server) handleTransferDelete(w http.ResponseWriter, r *http.Request) {
	d := s.transferDevice(w, r)
	if d == nil {
		return
	}
	var req struct {
		Paths     []string `json:"paths"`
		Recursive bool     `json:"recursive"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Paths) == 0 || len(req.Paths) > 500 {
		writeError(w, http.StatusBadRequest, "bad_request", "Select between 1 and 500 items")
		return
	}
	total := 0
	for _, p := range req.Paths {
		n, err := s.drive.Remove(d.ID, p, req.Recursive)
		total += n
		if err != nil {
			remoteErr(w, err)
			return
		}
		s.transferAudit(r, d, "file.delete", true, map[string]any{"path": p, "removed": n})
	}
	writeJSON(w, http.StatusOK, map[string]int{"removed": total})
}

func (s *Server) drivePath(deviceID string) string {
	if s.drive == nil {
		return ""
	}
	return s.drive.HostPath(deviceID)
}

// ---- Automatic SSH discovery for devices that only have RDP/VNC ----
//
// Windows ships an OpenSSH server as an optional built-in feature. If the
// device answers on port 22 and accepts the sign-in already saved for its
// RDP/VNC method, emremote adds an SSH method automatically, so system
// information and full file access work without any manual setup.

func (s *Server) handleAutoSSH(w http.ResponseWriter, r *http.Request) {
	d, err := s.getDevice(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	conns, err := s.store.ListConnections(r.Context(), userFrom(r.Context()).ID, d.ID)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	var source *store.Connection
	for _, c := range conns {
		if c.Protocol == "ssh" {
			writeJSON(w, http.StatusOK, map[string]any{"status": "exists", "connection": c})
			return
		}
		if source == nil && (c.Protocol == "rdp" || c.Protocol == "vnc") {
			source = c
		}
	}
	addr, err := s.policy.Resolve(r.Context(), d.Address)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "target_not_allowed", err.Error())
		return
	}
	port := s.cfg.AutoSSHPort
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "closed"})
		return
	}
	conn.Close()
	key, err := sshkey.Fetch(ctx, addr, port)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "closed"})
		return
	}
	if source == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "needs_credentials"})
		return
	}
	username, material, err := s.connectionCredentials(r.Context(), source)
	if err != nil || username == "" || material.Password == "" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "needs_credentials"})
		return
	}
	sshUser := username
	if source.Domain != "" && !strings.ContainsAny(username, `\@`) {
		sshUser = source.Domain + `\` + username
	}
	client, err := sshhelper.Dial(ctx, sshhelper.Target{Addr: addr, Port: port, Username: sshUser, Secret: secrets.Material{Password: material.Password}, HostKey: key.Key})
	if err != nil {
		slog.Info("automatic SSH discovery: sign-in failed", "device", d.ID, "error", err)
		writeJSON(w, http.StatusOK, map[string]any{"status": "auth_failed", "username": sshUser})
		return
	}
	client.Close()

	in := store.ConnectionInput{Name: "SSH", Protocol: "ssh", Port: port, Settings: nil}
	v := newValidator()
	in.Settings = normalizeSettings(v, "ssh", []byte(`{"host_key":"`+key.Key+`"}`))
	if source.CredentialID != nil && source.Username == "" {
		in.CredentialID = source.CredentialID
		in.Username = sshUser
		if sshUser == username {
			in.Username = ""
		}
	} else {
		in.Username = sshUser
	}
	var seal func(string) ([]byte, []string, error)
	if in.CredentialID == nil {
		m := secrets.Material{Password: material.Password}
		seal = func(id string) ([]byte, []string, error) {
			ct, err := s.box.SealMaterial("connection", id, m)
			return ct, m.Fields(), err
		}
	}
	created, err := s.store.CreateConnection(r.Context(), d.ID, in, seal)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	s.audit(r, "connection.create", "connection", created.ID, d.Name+" / SSH", true, map[string]any{
		"device_id": d.ID, "protocol": "ssh", "port": port, "automatic": true, "credentials_from": source.Name,
		"host_key_fingerprint": key.Fingerprint,
	})
	writeJSON(w, http.StatusCreated, map[string]any{"status": "created", "connection": created})
}
