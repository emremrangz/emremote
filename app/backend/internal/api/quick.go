package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/store"
)

// ---- Quick connect ----
//
// A quick connection is a one-off target that is never written to the
// database. It lives in memory, belongs to the browser session that created
// it, and its password never leaves the server. The same network policy and
// identity pinning (in memory) apply as for saved connections.

const (
	quickPrefix     = "q_"
	quickIdle       = 12 * time.Hour
	maxQuickPerUser = 20
)

type quickConn struct {
	sessionID string
	conn      store.Connection
	material  secrets.Material
	lastUsed  time.Time
}

type quickRegistry struct {
	mu sync.Mutex
	m  map[string]*quickConn
}

func newQuickRegistry() *quickRegistry { return &quickRegistry{m: map[string]*quickConn{}} }

// get returns a copy of the connection (safe to mutate) and its secret.
func (q *quickRegistry) get(id, sessionID string) (*store.Connection, secrets.Material, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	e := q.m[id]
	if e == nil || e.sessionID != sessionID {
		return nil, secrets.Material{}, false
	}
	e.lastUsed = time.Now()
	c := e.conn
	return &c, e.material, true
}

func (q *quickRegistry) setSettings(id string, raw json.RawMessage) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if e := q.m[id]; e != nil {
		e.conn.Settings = raw
	}
}

func (q *quickRegistry) remove(match func(*quickConn) bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for id, e := range q.m {
		if match(e) {
			delete(q.m, id)
		}
	}
}

func (q *quickRegistry) closeSession(sessionID string) {
	q.remove(func(e *quickConn) bool { return e.sessionID == sessionID })
}

func (q *quickRegistry) sweep() {
	now := time.Now()
	q.remove(func(e *quickConn) bool { return now.Sub(e.lastUsed) > quickIdle })
}

type quickRequest struct {
	connectionRequest
	Host string `json:"host"`
}

func (s *Server) handleCreateQuick(w http.ResponseWriter, r *http.Request) {
	var req quickRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, in, _, material := s.validateConnection(r.Context(), userFrom(r.Context()).OwnerScope(), "", req.Host, req.connectionRequest)
	host := v.address("host", req.Host, true)
	if v.ok() && jumpIDOf(in.Settings) != "" {
		v.fail("settings.jump_connection_id", "Quick connect cannot use a jump host. Add the device to use one.")
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	// Refuse early if policy forbids the target, so the dialog can show it.
	if _, err := s.policy.Resolve(r.Context(), host); err != nil {
		v.fail("host", err.Error())
		writeValidation(w, v)
		return
	}
	sid := sessionFrom(r.Context()).ID
	now := time.Now()
	c := store.Connection{
		ConnectionSummary: store.ConnectionSummary{
			ID: quickPrefix + auth.RandomToken(12), Name: "Quick connect", Protocol: in.Protocol, Port: in.Port,
		},
		DeviceName: host, DeviceAddress: host, DeviceOS: "other",
		Username: in.Username, Domain: in.Domain, CredentialID: in.CredentialID,
		Settings: in.Settings, CreatedAt: now, UpdatedAt: now,
	}
	c.SecretFields = material.Fields()
	if c.CredentialID != nil {
		if cred, err := s.store.GetCredential(r.Context(), *c.CredentialID); err == nil {
			c.CredentialName = &cred.Name
		}
	}

	s.quick.mu.Lock()
	n := 0
	for _, e := range s.quick.m {
		if e.sessionID == sid {
			n++
		}
	}
	if n >= maxQuickPerUser {
		// Forget the least recently used one rather than refusing.
		var oldest string
		for id, e := range s.quick.m {
			if e.sessionID == sid && (oldest == "" || e.lastUsed.Before(s.quick.m[oldest].lastUsed)) {
				oldest = id
			}
		}
		delete(s.quick.m, oldest)
	}
	s.quick.m[c.ID] = &quickConn{sessionID: sid, conn: c, material: material, lastUsed: now}
	s.quick.mu.Unlock()

	s.audit(r, "connection.quick", "connection", c.ID, host, true, map[string]any{"protocol": c.Protocol, "port": c.Port, "username": c.Username})
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) quickFrom(w http.ResponseWriter, r *http.Request) (*store.Connection, secrets.Material, bool) {
	c, m, ok := s.quick.get(r.PathValue("id"), sessionFrom(r.Context()).ID)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "This quick connection has expired. Start a new one from Overview.")
	}
	return c, m, ok
}

func (s *Server) handleGetQuick(w http.ResponseWriter, r *http.Request) {
	if c, _, ok := s.quickFrom(w, r); ok {
		writeJSON(w, http.StatusOK, c)
	}
}

func (s *Server) handleQuickTicket(w http.ResponseWriter, r *http.Request) {
	req, ok := s.decodeSessionRequest(w, r)
	if !ok {
		return
	}
	c, m, ok := s.quickFrom(w, r)
	if !ok {
		return
	}
	s.issueTicket(w, r, req, c, m, func(raw json.RawMessage) { s.quick.setSettings(c.ID, raw) })
}

// handleUpdateQuickSettings changes display settings (e.g. the keyboard
// layout picked in the session toolbar). Pinned identities cannot be changed.
func (s *Server) handleUpdateQuickSettings(w http.ResponseWriter, r *http.Request) {
	c, _, ok := s.quickFrom(w, r)
	if !ok {
		return
	}
	var req struct {
		Settings json.RawMessage `json:"settings"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	var cur, upd map[string]any
	_ = json.Unmarshal(c.Settings, &cur)
	if err := json.Unmarshal(req.Settings, &upd); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "Invalid settings")
		return
	}
	for k, val := range upd {
		if k == "host_key" || k == "cert_fingerprints" || k == "security" || k == "ignore_cert" || strings.HasSuffix(k, "_regex") {
			continue
		}
		cur[k] = val
	}
	raw, _ := json.Marshal(cur)
	v := newValidator()
	norm := normalizeSettings(v, c.Protocol, raw)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	s.quick.setSettings(c.ID, norm)
	c.Settings = norm
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteQuick(w http.ResponseWriter, r *http.Request) {
	id, sid := r.PathValue("id"), sessionFrom(r.Context()).ID
	s.quick.remove(func(e *quickConn) bool { return e.sessionID == sid && e.conn.ID == id })
	s.tunnels.terminate(func(a *ActiveSession) bool { return a.sessionID == sid && a.ConnectionID == id })
	w.WriteHeader(http.StatusNoContent)
}
