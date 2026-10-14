package api

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/sshhelper"
	"github.com/emremrangz/emremote/internal/store"
)

// ---- SSH access sessions (server-side SFTP + system inspection) ----
//
// An access session is an authenticated SSH connection that emremote holds
// on behalf of one browser session. It is closed after 10 minutes without
// use, after 1 hour in total, on logout and when the connection is deleted.

const (
	accessIdle     = 10 * time.Minute
	accessLifetime = time.Hour
	maxAccessPerUI = 6
)

type sshAccess struct {
	ID         string
	sessionID  string
	connection *store.Connection
	username   string
	client     *ssh.Client
	via        *ssh.Client // the jump host login this session runs through, if any
	created    time.Time

	mu       sync.Mutex
	lastUsed time.Time
	sftp     *sftp.Client
}

func (a *sshAccess) sftpClient() (*sftp.Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sftp != nil {
		return a.sftp, nil
	}
	c, err := sftp.NewClient(a.client, sftp.UseConcurrentWrites(true), sftp.UseConcurrentReads(true))
	if err != nil {
		return nil, err
	}
	a.sftp = c
	return c, nil
}

func (a *sshAccess) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sftp != nil {
		a.sftp.Close()
	}
	a.client.Close()
	if a.via != nil {
		a.via.Close()
	}
}

type accessRegistry struct {
	mu sync.Mutex
	m  map[string]*sshAccess
}

func newAccessRegistry() *accessRegistry { return &accessRegistry{m: map[string]*sshAccess{}} }

func (r *accessRegistry) add(a *sshAccess) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, x := range r.m {
		if x.sessionID == a.sessionID {
			n++
		}
	}
	if n >= maxAccessPerUI {
		return errors.New("too many open file/system sessions; close some first")
	}
	r.m[a.ID] = a
	return nil
}

func (r *accessRegistry) get(id, sessionID string) *sshAccess {
	r.mu.Lock()
	defer r.mu.Unlock()
	a := r.m[id]
	if a == nil || a.sessionID != sessionID {
		return nil
	}
	a.mu.Lock()
	a.lastUsed = time.Now()
	a.mu.Unlock()
	return a
}

// peek returns an access session without refreshing its idle timer.
func (r *accessRegistry) peek(id string) *sshAccess {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.m[id]
}

func (r *accessRegistry) remove(match func(*sshAccess) bool) int {
	r.mu.Lock()
	var victims []*sshAccess
	for id, a := range r.m {
		if match(a) {
			victims = append(victims, a)
			delete(r.m, id)
		}
	}
	r.mu.Unlock()
	for _, a := range victims {
		a.close()
	}
	return len(victims)
}

func (r *accessRegistry) closeSession(sessionID string) {
	r.remove(func(a *sshAccess) bool { return a.sessionID == sessionID })
}

func (r *accessRegistry) closeConnection(connID string) {
	r.remove(func(a *sshAccess) bool { return a.connection.ID == connID })
}

func (r *accessRegistry) sweep() {
	now := time.Now()
	r.remove(func(a *sshAccess) bool {
		a.mu.Lock()
		idle := now.Sub(a.lastUsed)
		a.mu.Unlock()
		return idle > accessIdle || now.Sub(a.created) > accessLifetime
	})
}

func (r *accessRegistry) closeAll() { r.remove(func(*sshAccess) bool { return true }) }

// endBrowserSession releases everything tied to a browser session.
func (s *Server) endBrowserSession(sessionID string) {
	s.tunnels.terminateSession(sessionID)
	s.access.closeSession(sessionID)
	s.copies.cancelSession(sessionID)
	s.quick.closeSession(sessionID)
}

// ---- Handlers ----

func (s *Server) handleOpenSSHAccess(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	c, err := s.store.GetConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	if c.Protocol != "ssh" {
		writeError(w, http.StatusBadRequest, "bad_request", "Files and system information need an SSH connection method")
		return
	}
	tgt, ok := s.prepareTarget(w, r, c)
	if !ok {
		return
	}
	// A bastion login (if any) belongs to this access session from here on.
	keep := false
	defer func() {
		if !keep && tgt.Via != nil {
			tgt.Via.Close()
		}
	}()
	var settings SSHSettings
	_ = decodeSettings(c.Settings, &settings)
	if settings.HostKey == "" {
		writeError(w, http.StatusBadGateway, "ssh_unreachable", "Could not reach the SSH server to read its host key. Check that it is on and SSH is enabled.")
		return
	}
	username, material, credErr := s.connectionCredentials(r.Context(), c)
	if credErr != nil {
		writeError(w, http.StatusInternalServerError, "secret_unavailable", credErr.Error())
		return
	}
	// Credentials typed by the user are used once for this access session and never stored.
	if req.Username != "" {
		username = strings.TrimSpace(req.Username)
	}
	if req.Password != "" {
		if len(req.Password) > 1024 {
			writeError(w, http.StatusBadRequest, "bad_request", "Password too long")
			return
		}
		material = secrets.Material{Password: req.Password}
	}
	targetName := c.DeviceName + " / " + c.Name
	client, err := sshhelper.Dial(r.Context(), sshhelper.Target{Addr: tgt.Addr, Port: tgt.Port, Username: username, Secret: material, HostKey: settings.HostKey, Via: tgt.Via})
	if err != nil {
		code, status := "ssh_failed", http.StatusBadGateway
		msg := "Could not connect over SSH: " + err.Error()
		switch {
		case errors.Is(err, sshhelper.ErrNoCredentials):
			code, status, msg = "credentials_required", http.StatusUnprocessableEntity, "Enter the username and password for this server."
		case errors.Is(err, sshhelper.ErrAuthenticationBad):
			code, status, msg = "authentication_failed", http.StatusUnprocessableEntity, "Authentication failed. Check the username and password."
		case errors.Is(err, sshhelper.ErrHostKeyMismatch):
			code, msg = "host_key_mismatch", "The server's host key has changed since the first connection. If the server was reinstalled, accept the new key in the connection's security settings; otherwise someone may be impersonating it."
		}
		if code != "credentials_required" {
			s.audit(r, "ssh.access", "connection", c.ID, targetName, false, map[string]any{"device_id": c.DeviceID, "username": username, "reason": code})
		}
		writeError(w, status, code, msg)
		return
	}
	a := &sshAccess{
		ID: auth.RandomToken(16), sessionID: sessionFrom(r.Context()).ID, connection: c, username: username,
		client: client, via: tgt.Via, created: time.Now(), lastUsed: time.Now(),
	}
	if err := s.access.add(a); err != nil {
		client.Close()
		writeError(w, http.StatusTooManyRequests, "too_many_sessions", err.Error())
		return
	}
	keep = true
	s.audit(r, "ssh.access", "connection", c.ID, targetName, true, map[string]any{"device_id": c.DeviceID, "username": username})
	writeJSON(w, http.StatusCreated, map[string]any{"id": a.ID, "username": username, "idle_timeout_s": int(accessIdle.Seconds())})
}

// connectionCredentials resolves username and secrets for a connection,
// falling back to its linked saved credential.
func (s *Server) connectionCredentials(ctx context.Context, c *store.Connection) (string, secrets.Material, error) {
	username := c.Username
	material, err := s.box.OpenMaterial("connection", c.ID, c.SecretEnc)
	if err != nil {
		return "", material, errors.New("stored secret could not be decrypted (was EMREMOTE_ENCRYPTION_KEY changed?)")
	}
	if c.CredentialID != nil {
		if cred, err := s.store.GetCredential(ctx, *c.CredentialID); err == nil {
			cm, err := s.box.OpenMaterial("credential", cred.ID, cred.SecretEnc)
			if err != nil {
				return "", material, errors.New("stored credential could not be decrypted (was EMREMOTE_ENCRYPTION_KEY changed?)")
			}
			if username == "" {
				username = cred.Username
			}
			if material.Password == "" {
				material.Password = cm.Password
			}
			if material.PrivateKey == "" {
				material.PrivateKey, material.Passphrase = cm.PrivateKey, cm.Passphrase
			}
		}
	}
	return username, material, nil
}

func (s *Server) accessFrom(w http.ResponseWriter, r *http.Request) *sshAccess {
	a := s.access.get(r.PathValue("aid"), sessionFrom(r.Context()).ID)
	if a == nil {
		writeError(w, http.StatusGone, "access_expired", "The file/system session expired. Reconnect to continue.")
	}
	return a
}

func (s *Server) handleCloseSSHAccess(w http.ResponseWriter, r *http.Request) {
	sid := sessionFrom(r.Context()).ID
	id := r.PathValue("aid")
	s.access.remove(func(a *sshAccess) bool { return a.ID == id && a.sessionID == sid })
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
		return
	}
	info, err := sshhelper.Inspect(r.Context(), a.client, a.connection.DeviceOS)
	if err != nil {
		writeError(w, http.StatusBadGateway, "inspect_failed", "Could not read system information: "+err.Error())
		return
	}
	s.rememberFacts(r.Context(), a.connection.DeviceID, info)
	writeJSON(w, http.StatusOK, map[string]any{"info": info, "username": a.username})
}

func remoteErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sshhelper.ErrInvalidPath):
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid path or name")
	case errors.Is(err, fs.ErrExist):
		writeError(w, http.StatusConflict, "exists", "A file or folder with that name already exists")
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, "not_found", "No such file or folder")
	case errors.Is(err, fs.ErrPermission):
		writeError(w, http.StatusForbidden, "permission_denied", "Permission denied on the remote computer")
	default:
		msg := err.Error()
		var se *sftp.StatusError
		if errors.As(err, &se) {
			switch se.FxCode() {
			case sftp.ErrSSHFxPermissionDenied:
				writeError(w, http.StatusForbidden, "permission_denied", "Permission denied on the remote computer")
				return
			case sftp.ErrSSHFxNoSuchFile:
				writeError(w, http.StatusNotFound, "not_found", "No such file or folder")
				return
			case sftp.ErrSSHFxFailure:
				msg = "The remote server refused the operation (for example, the folder is not empty or the file is in use)"
			}
		}
		writeError(w, http.StatusBadGateway, "remote_error", truncate(msg, 300))
	}
}

func (s *Server) fileAudit(r *http.Request, a *sshAccess, action string, success bool, details map[string]any) {
	details["device_id"] = a.connection.DeviceID
	details["username"] = a.username
	s.audit(r, action, "connection", a.connection.ID, a.connection.DeviceName+" / "+a.connection.Name, success, details)
}

func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
		return
	}
	c, err := a.sftpClient()
	if err != nil {
		writeError(w, http.StatusBadGateway, "sftp_unavailable", "The server does not offer SFTP: "+err.Error())
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		p, _ = sshhelper.Home(c)
	}
	listing, err := sshhelper.List(c, p)
	if err != nil {
		remoteErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, listing)
}

func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	return `attachment; filename="` + ascii + `"; filename*=UTF-8''` + url.PathEscape(name)
}

func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
		return
	}
	c, err := a.sftpClient()
	if err != nil {
		remoteErr(w, err)
		return
	}
	p, err := sshhelper.CleanPath(r.URL.Query().Get("path"))
	if err != nil {
		remoteErr(w, err)
		return
	}
	fi, err := c.Stat(p)
	if err != nil {
		remoteErr(w, err)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	name := path.Base(p)
	var n int64
	if fi.IsDir() {
		w.Header().Set("Content-Disposition", contentDisposition(name+".zip"))
		cw := &countingWriter{w: w}
		err = sshhelper.ZipDir(c, p, cw)
		n = cw.n
	} else {
		w.Header().Set("Content-Disposition", contentDisposition(name))
		w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
		n, err = sshhelper.CopyFile(c, p, w)
	}
	if err != nil {
		slog.Warn("download interrupted", "error", err)
	}
	s.fileAudit(r, a, "file.download", err == nil, map[string]any{"path": p, "bytes": n, "folder": fi.IsDir()})
}

type countingWriter struct {
	w http.ResponseWriter
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func (s *Server) handleUploadFile(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
		return
	}
	c, err := a.sftpClient()
	if err != nil {
		remoteErr(w, err)
		return
	}
	q := r.URL.Query()
	dir, name := q.Get("dir"), q.Get("name")
	if !sshhelper.ValidName(name) {
		writeError(w, http.StatusBadRequest, "invalid_path", "Invalid file name")
		return
	}
	// Large uploads outlive the server's default read timeout.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(6 * time.Hour))
	body := http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)
	n, err := sshhelper.Upload(c, dir, name, body, q.Get("overwrite") == "true")
	target := path.Join(dir, name)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "File exceeds the upload limit (EMREMOTE_MAX_UPLOAD_MB)")
			return
		}
		if !errors.Is(err, fs.ErrExist) {
			s.fileAudit(r, a, "file.upload", false, map[string]any{"path": target, "reason": truncate(err.Error(), 200)})
		}
		remoteErr(w, err)
		return
	}
	s.fileAudit(r, a, "file.upload", true, map[string]any{"path": target, "bytes": n})
	writeJSON(w, http.StatusCreated, map[string]any{"path": target, "bytes": n})
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
		return
	}
	var req struct {
		Dir  string `json:"dir"`
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	c, err := a.sftpClient()
	if err != nil {
		remoteErr(w, err)
		return
	}
	p, err := sshhelper.Mkdir(c, req.Dir, strings.TrimSpace(req.Name))
	if err != nil {
		if _, serr := c.Stat(p); serr == nil && p != "" {
			err = fs.ErrExist
		}
		remoteErr(w, err)
		return
	}
	s.fileAudit(r, a, "file.mkdir", true, map[string]any{"path": p})
	writeJSON(w, http.StatusCreated, map[string]string{"path": p})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
		return
	}
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	c, err := a.sftpClient()
	if err != nil {
		remoteErr(w, err)
		return
	}
	to, err := sshhelper.Rename(c, req.Path, strings.TrimSpace(req.Name))
	if err != nil {
		remoteErr(w, err)
		return
	}
	s.fileAudit(r, a, "file.rename", true, map[string]any{"path": req.Path, "new_path": to})
	writeJSON(w, http.StatusOK, map[string]string{"path": to})
}

func (s *Server) handleDeleteFiles(w http.ResponseWriter, r *http.Request) {
	a := s.accessFrom(w, r)
	if a == nil {
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
	c, err := a.sftpClient()
	if err != nil {
		remoteErr(w, err)
		return
	}
	total := 0
	for _, p := range req.Paths {
		n, err := sshhelper.Remove(c, p, req.Recursive)
		total += n
		if err != nil {
			s.fileAudit(r, a, "file.delete", false, map[string]any{"path": p, "removed": total, "reason": truncate(err.Error(), 200)})
			remoteErr(w, err)
			return
		}
		s.fileAudit(r, a, "file.delete", true, map[string]any{"path": p, "removed": n, "recursive": req.Recursive})
	}
	writeJSON(w, http.StatusOK, map[string]int{"removed": total})
}
