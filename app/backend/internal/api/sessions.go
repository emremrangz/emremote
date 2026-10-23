package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/guac"
	"github.com/emremrangz/emremote/internal/jump"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/store"
)

// ---- One-time tunnel tickets ----
//
// Launching a session is two steps: an authenticated, CSRF-protected POST
// validates the request and returns a short-lived single-use ticket; the
// browser then opens the WebSocket with that ticket. The ticket is bound to
// the browser session that created it.

const ticketTTL = 30 * time.Second

type ticket struct {
	sessionID   string
	user        *store.User
	conn        *store.Connection
	params      guac.HandshakeParams
	target      string
	expires     time.Time
	clientIP    string
	credentialN string
	// forwarder carries the session through a jump host (nil for direct targets).
	forwarder *jump.Forwarder
	jumpName  string
	// recording is set when the gateway records this session.
	recording *recordingPlan
}

type ticketStore struct {
	mu sync.Mutex
	m  map[string]*ticket
}

func newTicketStore() *ticketStore { return &ticketStore{m: map[string]*ticket{}} }

func (t *ticketStore) put(tk *ticket) string {
	id := auth.RandomToken(32)
	t.mu.Lock()
	t.m[auth.HashToken(id)] = tk
	t.mu.Unlock()
	return id
}

func (t *ticketStore) take(id string) *ticket {
	t.mu.Lock()
	defer t.mu.Unlock()
	k := auth.HashToken(id)
	tk := t.m[k]
	delete(t.m, k)
	if tk == nil {
		return nil
	}
	if time.Now().After(tk.expires) {
		tk.forwarder.Close()
		return nil
	}
	return tk
}

func (t *ticketStore) sweep() {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, tk := range t.m {
		if now.After(tk.expires) {
			tk.forwarder.Close()
			delete(t.m, k)
		}
	}
}

// ---- Active tunnel registry ----

type ActiveSession struct {
	ID             string    `json:"id"`
	UserID         string    `json:"user_id"`
	ConnectionID   string    `json:"connection_id"`
	ConnectionName string    `json:"connection_name"`
	DeviceID       string    `json:"device_id"`
	DeviceName     string    `json:"device_name"`
	Protocol       string    `json:"protocol"`
	Username       string    `json:"username"`
	ClientIP       string    `json:"client_ip"`
	StartedAt      time.Time `json:"started_at"`
	// Viewers is how many people are watching through a share link.
	Viewers   int  `json:"viewers"`
	Shared    bool `json:"shared"`
	Recording bool `json:"recording"`
	sessionID string
	cancel    context.CancelFunc
	// guacdID is the gateway's id for this connection, which watchers join.
	guacdID       string
	viewerCancels map[int]context.CancelFunc
	nextViewer    int
}

type tunnelRegistry struct {
	mu sync.Mutex
	m  map[string]*ActiveSession
}

func newTunnelRegistry() *tunnelRegistry { return &tunnelRegistry{m: map[string]*ActiveSession{}} }

func (t *tunnelRegistry) add(a *ActiveSession) {
	t.mu.Lock()
	t.m[a.ID] = a
	t.mu.Unlock()
}

// get returns a copy of the active session with that id.
func (t *tunnelRegistry) get(id string) (ActiveSession, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	a, ok := t.m[id]
	if !ok {
		return ActiveSession{}, false
	}
	return *a, true
}

const maxViewers = 5

// addViewer registers a watcher; it returns a key for removeViewer and the session's gateway id.
func (t *tunnelRegistry) addViewer(id string, cancel context.CancelFunc) (key int, guacdID string, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	a := t.m[id]
	if a == nil || a.Viewers >= maxViewers {
		return 0, "", false
	}
	a.nextViewer++
	a.viewerCancels[a.nextViewer] = cancel
	a.Viewers = len(a.viewerCancels)
	return a.nextViewer, a.guacdID, true
}

func (t *tunnelRegistry) removeViewer(id string, key int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if a := t.m[id]; a != nil {
		delete(a.viewerCancels, key)
		a.Viewers = len(a.viewerCancels)
	}
}

// disconnectViewers ends every watcher of the session.
func (t *tunnelRegistry) disconnectViewers(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if a := t.m[id]; a != nil {
		for _, c := range a.viewerCancels {
			c()
		}
	}
}

func (t *tunnelRegistry) setShared(id string, v bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if a := t.m[id]; a != nil {
		a.Shared = v
	}
}

func (t *tunnelRegistry) remove(id string) {
	t.mu.Lock()
	delete(t.m, id)
	t.mu.Unlock()
}

func (t *tunnelRegistry) list() []ActiveSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]ActiveSession, 0, len(t.m))
	for _, a := range t.m {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

func (t *tunnelRegistry) terminate(match func(*ActiveSession) bool) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, a := range t.m {
		if match(a) {
			a.cancel()
			n++
		}
	}
	return n
}

func (t *tunnelRegistry) terminateSession(sessionID string) {
	t.terminate(func(a *ActiveSession) bool { return a.sessionID == sessionID })
}

func (t *tunnelRegistry) terminateConnection(connID string) {
	t.terminate(func(a *ActiveSession) bool { return a.ConnectionID == connID })
}

func (t *tunnelRegistry) terminateAll() { t.terminate(func(*ActiveSession) bool { return true }) }

// ---- Handlers ----

type sessionRequest struct {
	Width    int      `json:"width"`
	Height   int      `json:"height"`
	DPI      int      `json:"dpi"`
	Image    []string `json:"image"`
	Audio    []string `json:"audio"`
	Video    []string `json:"video"`
	Timezone string   `json:"timezone"`
	// KeyboardLayout is the layout detected in the browser (e.g. "tr-tr-qwerty").
	KeyboardLayout string `json:"keyboard_layout"`
	// Terminal is the user's own terminal appearance (SSH and Telnet).
	Terminal *TerminalPrefs `json:"terminal"`
}

var (
	audioMimeRe = regexp.MustCompile(`^audio/L(8|16)(;rate=\d{4,6},channels=[12])?$`)
	videoMimeRe = regexp.MustCompile(`^video/[a-z0-9.+-]{1,32}(; ?codecs="[A-Za-z0-9., ]{1,64}")?$`)
	timezoneRe  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}$`)
	imageMimes  = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true}
)

func filterMimes(in []string, ok func(string) bool, max int) []string {
	out := []string{}
	for _, m := range in {
		if len(out) >= max {
			break
		}
		if ok(m) {
			out = append(out, m)
		}
	}
	return out
}

func (s *Server) decodeSessionRequest(w http.ResponseWriter, r *http.Request) (sessionRequest, bool) {
	var req sessionRequest
	if !decodeJSON(w, r, &req) {
		return req, false
	}
	v := newValidator()
	between(v, "width", req.Width, 64, 8192)
	between(v, "height", req.Height, 64, 8192)
	between(v, "dpi", req.DPI, 48, 480)
	req.Terminal = v.terminalPrefs(req.Terminal)
	if req.Timezone != "" && (len(req.Timezone) > 64 || !timezoneRe.MatchString(req.Timezone)) {
		req.Timezone = ""
	}
	if !v.ok() {
		writeValidation(w, v)
		return req, false
	}
	return req, true
}

func (s *Server) handleCreateSessionTicket(w http.ResponseWriter, r *http.Request) {
	req, ok := s.decodeSessionRequest(w, r)
	if !ok {
		return
	}
	c, err := s.store.GetConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	material, err := s.box.OpenMaterial("connection", c.ID, c.SecretEnc)
	if err != nil {
		slog.Error("decrypt connection secret", "connection", c.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "secret_unavailable", "Stored secret could not be decrypted. Was EMREMOTE_ENCRYPTION_KEY changed?")
		return
	}
	s.issueTicket(w, r, req, c, material, nil)
}

// issueTicket resolves the target, pins its identity, merges a linked
// credential and returns a one-time tunnel ticket. pin stores a newly pinned
// identity for quick connections (nil for saved ones).
func (s *Server) issueTicket(w http.ResponseWriter, r *http.Request, req sessionRequest, c *store.Connection, material secrets.Material, pin func(json.RawMessage)) {
	var tgt *resolvedTarget
	if pin == nil {
		var ok bool
		if tgt, ok = s.prepareTarget(w, r, c); !ok {
			s.audit(r, "session.start", "connection", c.ID, c.DeviceName+" / "+c.Name, false,
				map[string]any{"protocol": c.Protocol, "reason": "target not allowed or unresolvable"})
			return
		}
	} else {
		// Quick connections never use a jump host.
		ok, addr := s.resolveTarget(w, r, c)
		if !ok {
			s.audit(r, "session.start", "connection", c.ID, c.DeviceName+" / "+c.Name, false,
				map[string]any{"protocol": c.Protocol, "reason": "target not allowed or unresolvable"})
			return
		}
		if s.pinIdentity(r, c, addr, false, nil) {
			pin(c.Settings)
		}
		tgt = &resolvedTarget{Addr: addr, Port: c.Port}
	}
	// Through a jump host the gateway connects to a temporary local listener instead.
	addr, port := tgt.Addr, tgt.Port
	var fwd *jump.Forwarder
	jumpName := ""
	if tgt.Via != nil {
		f, err := s.startForwarder(tgt)
		if err != nil {
			tgt.Via.Close()
			slog.Error("jump forwarder", "error", err)
			writeError(w, http.StatusBadGateway, "jump_failed", "Could not prepare the jump host tunnel: "+err.Error())
			return
		}
		fwd = f
		addr, port = f.Addr()
		if b, err := s.store.GetConnection(r.Context(), jumpIDOf(c.Settings)); err == nil {
			jumpName = b.DeviceName
		}
	}
	started := false
	defer func() {
		if !started {
			fwd.Close()
		}
	}()

	// Resolve credentials: connection-level values win over a linked credential.
	username, domain := c.Username, c.Domain
	credName := ""
	if c.CredentialID != nil {
		cred, err := s.store.GetCredential(r.Context(), *c.CredentialID)
		if err == nil {
			credName = cred.Name
			cm, err := s.box.OpenMaterial("credential", cred.ID, cred.SecretEnc)
			if err != nil {
				slog.Error("decrypt credential secret", "credential", cred.ID, "error", err)
				writeError(w, http.StatusInternalServerError, "secret_unavailable", "Stored credential could not be decrypted. Was EMREMOTE_ENCRYPTION_KEY changed?")
				return
			}
			if username == "" {
				username = cred.Username
			}
			if domain == "" && c.Protocol == "rdp" {
				domain = cred.Domain
			}
			if material.Password == "" {
				material.Password = cm.Password
			}
			if material.PrivateKey == "" && c.Protocol == "ssh" {
				material.PrivateKey, material.Passphrase = cm.PrivateKey, cm.Passphrase
			}
		}
	}

	drive := ""
	if c.DeviceID != "" {
		drive = s.drivePath(c.DeviceID)
	}
	values, err := buildGuacdParams(guacdTarget{
		Protocol: c.Protocol, Addr: addr, Port: port, Username: username, Domain: domain,
		Secret: material, Settings: c.Settings, Timezone: req.Timezone, DrivePath: drive, ClientLayout: req.KeyboardLayout, Terminal: req.Terminal,
	})
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	rec := s.planRecording(r.Context(), c.Protocol, c.DeviceID, values)
	image := filterMimes(req.Image, func(m string) bool { return imageMimes[m] }, 3)
	if len(image) == 0 {
		image = []string{"image/png", "image/jpeg"}
	}
	tk := &ticket{
		sessionID: sessionFrom(r.Context()).ID,
		user:      userFrom(r.Context()),
		conn:      c,
		target:    joinHostPort(tgt.Addr, tgt.Port),
		forwarder: fwd,
		jumpName:  jumpName,
		recording: rec,
		expires:   time.Now().Add(ticketTTL),
		clientIP:  s.clientIP(r),
		params: guac.HandshakeParams{
			Protocol: c.Protocol,
			Values:   values,
			Width:    req.Width,
			Height:   req.Height,
			DPI:      req.DPI,
			Image:    image,
			Audio:    filterMimes(req.Audio, audioMimeRe.MatchString, 8),
			Video:    filterMimes(req.Video, videoMimeRe.MatchString, 8),
			Timezone: req.Timezone,
		},
		credentialN: credName,
	}
	started = true
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket":     s.tickets.put(tk),
		"expires_in": int(ticketTTL.Seconds()),
		"protocol":   c.Protocol,
		// Tells the client whether guacd may prompt for missing credentials.
		"has_password": material.Password != "" || material.PrivateKey != "",
		"username":     username,
		"recording":    rec != nil,
	})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  16 << 10,
	WriteBufferSize: 64 << 10,
	Subprotocols:    []string{"guacamole"},
	// Origin is enforced by the checkOrigin middleware (same-origin only).
	CheckOrigin: sameOrigin,
}

func (s *Server) handleTunnel(w http.ResponseWriter, r *http.Request) {
	tk := s.tickets.take(r.URL.Query().Get("ticket"))
	sess := sessionFrom(r.Context())
	if tk == nil || tk.sessionID != sess.ID {
		writeError(w, http.StatusForbidden, "invalid_ticket", "Invalid or expired session ticket")
		return
	}
	defer tk.forwarder.Close() // the jump host tunnel lives exactly as long as the session
	wsc, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // upgrader already wrote an error response
	}
	wsc.SetReadLimit(4 << 20)
	ws := &guac.WSConn{Conn: wsc}
	c := tk.conn
	targetName := c.DeviceName + " / " + c.Name
	baseDetails := map[string]any{"protocol": c.Protocol, "target": tk.target, "username": tk.params.Values["username"], "device_id": c.DeviceID}
	if tk.credentialN != "" {
		baseDetails["credential"] = tk.credentialN
	}
	if tk.jumpName != "" {
		baseDetails["jump_host"] = tk.jumpName
	}
	if l := tk.params.Values["server-layout"]; l != "" {
		baseDetails["keyboard_layout"] = l
	}

	gd, err := net.DialTimeout("tcp", s.cfg.GuacdAddr, 5*time.Second)
	if err != nil {
		slog.Error("connect to guacd", "addr", s.cfg.GuacdAddr, "error", err)
		s.audit(r, "session.start", "connection", c.ID, targetName, false, merge(baseDetails, map[string]any{"reason": "gateway unreachable"}))
		ws.SendErrorAndClose("Remote access gateway (guacd) is unreachable", guac.StatusUpstreamNotFound)
		return
	}
	reader, guacdID, err := guac.Handshake(gd, tk.params)
	if err != nil {
		gd.Close()
		slog.Warn("guacd handshake failed", "connection", c.ID, "error", err)
		status := guac.StatusServerError
		var ge *guac.GuacdError
		if errors.As(err, &ge) {
			status = ge.Status
		}
		s.audit(r, "session.start", "connection", c.ID, targetName, false, merge(baseDetails, map[string]any{"reason": "gateway handshake failed"}))
		ws.SendErrorAndClose("Gateway handshake failed", status)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	active := &ActiveSession{
		ID: auth.RandomToken(12), UserID: tk.user.ID, ConnectionID: c.ID, ConnectionName: c.Name, DeviceID: c.DeviceID,
		DeviceName: c.DeviceName, Protocol: c.Protocol, Username: tk.user.Username, ClientIP: tk.clientIP,
		StartedAt: time.Now(), Recording: tk.recording != nil, sessionID: tk.sessionID, cancel: cancel, guacdID: guacdID, viewerCancels: map[int]context.CancelFunc{},
	}
	s.tunnels.add(active)
	defer s.tunnels.remove(active.ID)
	defer s.shares.revokeSession(active.ID)

	if c.DeviceID != "" {
		_ = s.store.TouchConnectionUsed(r.Context(), tk.user.ID, c.ID, c.DeviceID)
	}
	if tk.recording != nil {
		s.beginRecording(r.Context(), tk.recording, active, active.StartedAt)
		defer s.endRecording(tk.recording)
		baseDetails["recording_id"] = tk.recording.id
	}
	s.audit(r, "session.start", "connection", c.ID, targetName, true, merge(baseDetails, map[string]any{
		"session_id": active.ID, "gateway_connection_id": guacdID,
	}))
	slog.Info("remote session started", "session", active.ID, "connection", c.ID, "protocol", c.Protocol)

	// guacd's VNC client can stall on a resize request; VNC sessions are
	// scaled in the browser instead.
	res := guac.Proxy(ctx, ws, gd, reader, active.ID, c.Protocol != "vnc")

	dur := time.Since(active.StartedAt).Round(time.Second)
	end := map[string]any{"session_id": active.ID, "duration_s": int(dur.Seconds()), "closed_by": res.ClosedBy, "protocol": c.Protocol, "device_id": c.DeviceID}
	if res.Error != "" {
		end["gateway_error"] = truncate(res.Error, 200)
	}
	s.audit(r, "session.end", "connection", c.ID, targetName, res.Error == "", end)
	slog.Info("remote session ended", "session", active.ID, "duration", dur, "closed_by", res.ClosedBy)
}

func merge(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// visibleTunnels lists the live remote sessions a user may see: all of them for
// administrators, otherwise their own.
func (s *Server) visibleTunnels(u *store.User) []ActiveSession {
	all := s.tunnels.list()
	if u.IsAdmin() {
		return all
	}
	out := []ActiveSession{}
	for _, a := range all {
		if a.UserID == u.ID {
			out = append(out, a)
		}
	}
	return out
}

func (s *Server) handleListActiveSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.visibleTunnels(userFrom(r.Context())))
}

func (s *Server) handleTerminateActiveSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var found *ActiveSession
	for _, a := range s.visibleTunnels(userFrom(r.Context())) {
		if a.ID == id {
			a := a
			found = &a
		}
	}
	if found == nil || s.tunnels.terminate(func(a *ActiveSession) bool { return a.ID == id }) == 0 {
		writeError(w, http.StatusNotFound, "not_found", "Active session not found")
		return
	}
	s.audit(r, "session.terminate", "connection", found.ConnectionID, found.DeviceName+" / "+found.ConnectionName, true,
		map[string]any{"session_id": id})
	w.WriteHeader(http.StatusNoContent)
}
