package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/guac"
)

// ---- Sharing a live session (view only) ----
//
// The owner of a session (or an administrator) can create a link. Anyone who is
// signed in to emremote with permission to open sessions can then watch that
// one session, read only: input never reaches the remote computer. The link
// stops working when the owner stops sharing, after two hours, or when the
// session ends.

const shareTTL = 2 * time.Hour

type share struct {
	activeID string
	expires  time.Time
}

type shareStore struct {
	mu sync.Mutex
	m  map[string]*share // by token hash
}

func newShareStore() *shareStore { return &shareStore{m: map[string]*share{}} }

func (s *shareStore) create(activeID string) (string, time.Time) {
	tok := auth.RandomToken(32)
	exp := time.Now().Add(shareTTL)
	s.mu.Lock()
	s.m[auth.HashToken(tok)] = &share{activeID: activeID, expires: exp}
	s.mu.Unlock()
	return tok, exp
}

func (s *shareStore) lookup(tok string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := auth.HashToken(tok)
	sh := s.m[k]
	if sh == nil {
		return "", false
	}
	if time.Now().After(sh.expires) {
		delete(s.m, k)
		return "", false
	}
	return sh.activeID, true
}

func (s *shareStore) revokeSession(activeID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, sh := range s.m {
		if sh.activeID == activeID {
			delete(s.m, k)
		}
	}
}

func (s *shareStore) sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, sh := range s.m {
		if now.After(sh.expires) {
			delete(s.m, k)
		}
	}
}

// ownActive finds a live session the caller may manage (their own, or any for administrators).
func (s *Server) ownActive(r *http.Request) (ActiveSession, bool) {
	a, ok := s.tunnels.get(r.PathValue("id"))
	u := userFrom(r.Context())
	if !ok || (a.UserID != u.ID && !u.IsAdmin()) {
		return ActiveSession{}, false
	}
	return a, true
}

func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	a, ok := s.ownActive(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Active session not found")
		return
	}
	tok, exp := s.shares.create(a.ID)
	s.tunnels.setShared(a.ID, true)
	s.audit(r, "session.share", "connection", a.ConnectionID, a.DeviceName+" / "+a.ConnectionName, true,
		map[string]any{"session_id": a.ID, "expires_at": exp.Format(time.RFC3339)})
	writeJSON(w, http.StatusCreated, map[string]any{"path": "/watch/" + tok, "expires_at": exp, "viewers": a.Viewers})
}

func (s *Server) handleStopShare(w http.ResponseWriter, r *http.Request) {
	a, ok := s.ownActive(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Active session not found")
		return
	}
	s.shares.revokeSession(a.ID)
	s.tunnels.disconnectViewers(a.ID)
	s.tunnels.setShared(a.ID, false)
	s.audit(r, "session.unshare", "connection", a.ConnectionID, a.DeviceName+" / "+a.ConnectionName, true, map[string]any{"session_id": a.ID})
	w.WriteHeader(http.StatusNoContent)
}

// handleShareStatus tells the owner whether the session is shared and how many are watching.
func (s *Server) handleShareStatus(w http.ResponseWriter, r *http.Request) {
	a, ok := s.ownActive(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "Active session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shared": a.Shared, "viewers": a.Viewers})
}

// handleWatchInfo describes the shared session to someone opening the link.
func (s *Server) handleWatchInfo(w http.ResponseWriter, r *http.Request) {
	id, ok := s.shares.lookup(r.PathValue("token"))
	a, live := s.tunnels.get(id)
	if !ok || !live {
		writeError(w, http.StatusNotFound, "not_found", "This shared session has ended or the link is no longer valid.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device_name": a.DeviceName, "connection_name": a.ConnectionName, "protocol": a.Protocol,
		"owner": a.Username, "started_at": a.StartedAt,
	})
}

// handleWatchTunnel joins a shared session as a read-only participant.
func (s *Server) handleWatchTunnel(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id, ok := s.shares.lookup(q.Get("token"))
	if !ok {
		writeError(w, http.StatusForbidden, "invalid_share", "This shared session has ended or the link is no longer valid.")
		return
	}
	width, _ := strconv.Atoi(q.Get("width"))
	height, _ := strconv.Atoi(q.Get("height"))
	dpi, _ := strconv.Atoi(q.Get("dpi"))
	if width < 64 || width > 8192 || height < 64 || height > 8192 {
		width, height = 1280, 720
	}
	if dpi < 48 || dpi > 480 {
		dpi = 96
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	key, guacdID, ok := s.tunnels.addViewer(id, cancel)
	if !ok {
		writeError(w, http.StatusConflict, "unavailable", "The session has ended or already has the maximum number of viewers.")
		return
	}
	defer s.tunnels.removeViewer(id, key)

	wsc, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	wsc.SetReadLimit(1 << 20)
	ws := &guac.WSConn{Conn: wsc}
	a, _ := s.tunnels.get(id)
	targetName := a.DeviceName + " / " + a.ConnectionName
	viewer := userFrom(r.Context())

	gd, err := net.DialTimeout("tcp", s.cfg.GuacdAddr, 5*time.Second)
	if err != nil {
		ws.SendErrorAndClose("Remote access gateway (guacd) is unreachable", guac.StatusUpstreamNotFound)
		return
	}
	reader, _, err := guac.Handshake(gd, guac.HandshakeParams{
		Protocol: guacdID, // already "$…": selecting it joins that connection Values: map[string]string{"read-only": "true"},
		Width:    width, Height: height, DPI: dpi, Image: []string{"image/png", "image/jpeg", "image/webp"},
	})
	if err != nil {
		gd.Close()
		slog.Warn("joining shared session failed", "session", id, "error", err)
		ws.SendErrorAndClose("Could not join the shared session", guac.StatusServerError)
		return
	}
	s.audit(r, "session.watch", "connection", a.ConnectionID, targetName, true,
		map[string]any{"session_id": id, "owner": a.Username, "viewer": viewer.Username, "device_id": a.DeviceID})
	start := time.Now()
	guac.ProxyViewer(ctx, ws, gd, reader, id)
	s.audit(r, "session.watch.end", "connection", a.ConnectionID, targetName, true,
		map[string]any{"session_id": id, "viewer": viewer.Username, "duration_s": int(time.Since(start).Seconds()), "device_id": a.DeviceID})
}
