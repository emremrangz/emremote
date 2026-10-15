// Package api implements the emremote HTTP API, the guacd WebSocket tunnel
// endpoint and static serving of the web UI.
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/config"
	"github.com/emremrangz/emremote/internal/netpolicy"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/status"
	"github.com/emremrangz/emremote/internal/store"
	"github.com/emremrangz/emremote/internal/transfer"
)

type Server struct {
	cfg     *config.Config
	store   *store.Store
	box     *secrets.Box
	policy  *netpolicy.Policy
	checker *status.Checker
	limiter *auth.LoginLimiter
	tunnels *tunnelRegistry
	tickets *ticketStore
	shares  *shareStore
	// jumpNetworks, once an administrator saved them in Settings, replace the environment default.
	jumpNetworks atomic.Pointer[[]netip.Prefix]
	access       *accessRegistry
	drive        *transfer.Drive
	copies       *copyRegistry
	quick        *quickRegistry
	challenges   *challengeStore

	setupMu   sync.Mutex
	setupOpen bool // true while no user exists
	// setupBlocked: no users, but this server was set up before (the database looks lost).
	setupBlocked bool
	version      string
}

type Options struct {
	Config  *config.Config
	Store   *store.Store
	Box     *secrets.Box
	Policy  *netpolicy.Policy
	Checker *status.Checker
	Version string
}

func New(o Options) *Server {
	return &Server{
		cfg:        o.Config,
		store:      o.Store,
		box:        o.Box,
		policy:     o.Policy,
		checker:    o.Checker,
		limiter:    auth.NewLoginLimiter(),
		tunnels:    newTunnelRegistry(),
		tickets:    newTicketStore(),
		shares:     newShareStore(),
		access:     newAccessRegistry(),
		drive:      transfer.New(o.Config.TransferDir),
		copies:     newCopyRegistry(),
		quick:      newQuickRegistry(),
		challenges: newChallengeStore(),
		version:    o.Version,
	}
}

// PrepareSetup opens first-run setup if no administrator exists yet: the web
// interface then offers to create one. No secret is printed; see handleSetup for
// who may do it.
func (s *Server) PrepareSetup(ctx context.Context) error {
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		s.markInitialized()
		return nil
	}
	if s.previouslyInitialized() {
		if s.cfg.AllowEmptyDatabase {
			_ = os.Remove(s.markerPath())
			fmt.Fprintf(os.Stderr, "\nEMREMOTE_ALLOW_EMPTY_DATABASE is set: starting over with an empty database.\n\n")
		} else {
			s.setupMu.Lock()
			s.setupBlocked = true
			s.setupMu.Unlock()
			fmt.Fprintf(os.Stderr, "\n================ emremote: database looks empty ================\n"+
				"This server was set up before, but the database has no accounts.\n"+
				"The data folder or database volume is probably not mounted correctly\n"+
				"(for example a changed EMREMOTE_DATA_DIR). Nothing has been changed.\n"+
				"First-time setup is switched off. Fix the mount and restart, or set\n"+
				"EMREMOTE_ALLOW_EMPTY_DATABASE=true to start over on purpose.\n"+
				"==================================================================\n\n")
			return nil
		}
	}
	s.setupMu.Lock()
	s.setupOpen = true
	s.setupMu.Unlock()
	how := "Open the web interface from a computer on your network and create the administrator account."
	if s.cfg.SetupToken != "" {
		how = "Open the web interface and create the administrator account. EMREMOTE_SETUP_TOKEN is required."
	}
	fmt.Fprintf(os.Stderr, "\n================ emremote first run ================\n"+
		"No administrator account exists yet.\n%s\n"+
		"====================================================\n\n", how)
	return nil
}

// Background runs periodic maintenance until ctx is cancelled.
func (s *Server) Background(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	tunnels := time.NewTicker(time.Minute)
	defer tunnels.Stop()
	audit := time.NewTicker(6 * time.Hour)
	defer audit.Stop()
	s.pruneAudit(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tunnels.C:
			s.syncTunnelSessions(ctx)
			s.access.sweep()
			s.copies.prune()
			s.quick.sweep()
		case <-audit.C:
			s.pruneAudit(ctx)
		case <-t.C:
			if n, err := s.store.DeleteExpiredSessions(ctx, s.cfg.SessionIdle); err != nil {
				slog.Warn("session cleanup failed", "error", err)
			} else if n > 0 {
				slog.Info("removed expired sessions", "count", n)
			}
			s.limiter.Sweep()
			s.tickets.sweep()
			s.shares.sweep()
			s.challenges.sweep()
		}
	}
}

// syncTunnelSessions ties live remote sessions to the browser session that
// opened them: an active tunnel counts as activity (so a long RDP session does
// not idle-expire the user), and a revoked or absolutely expired browser
// session terminates its tunnels.
func (s *Server) syncTunnelSessions(ctx context.Context) {
	seen := map[string]bool{}
	for _, a := range s.tunnels.list() {
		if seen[a.sessionID] {
			continue
		}
		seen[a.sessionID] = true
		sess, err := s.store.GetSession(ctx, a.sessionID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && time.Now().After(sess.ExpiresAt)) {
			slog.Info("terminating remote sessions of expired browser session")
			s.endBrowserSession(a.sessionID)
			continue
		}
		if err == nil {
			_ = s.store.TouchSession(ctx, a.sessionID)
		}
	}
}

// Shutdown terminates active remote sessions.
func (s *Server) Shutdown() {
	s.tunnels.terminateAll()
	s.access.closeAll()
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /api/setup", s.handleSetupStatus)
	mux.HandleFunc("POST /api/setup", s.handleSetup)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/login/2fa", s.handleLogin2FA)

	// Authenticated
	a := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireAuth(h)) }
	a("GET /api/auth/me", s.handleMe)
	a("POST /api/auth/logout", s.handleLogout)
	a("POST /api/auth/password", s.handleChangePassword)
	a("GET /api/auth/2fa", s.handleTwoFactorStatus)
	a("POST /api/auth/2fa/setup", s.handleTwoFactorSetup)
	a("POST /api/auth/2fa/enable", s.handleTwoFactorEnable)
	a("POST /api/auth/2fa/disable", s.handleTwoFactorDisable)
	a("POST /api/auth/2fa/recovery", s.handleTwoFactorRecovery)
	a("GET /api/auth/sessions", s.handleListSessions)
	a("DELETE /api/auth/sessions", s.handleRevokeOtherSessions)

	a("GET /api/dashboard", s.handleDashboard)
	a("GET /api/system", s.handleSystem)

	// Shorthands for the permissions a route needs (see access.go).
	inv, files, quick, creds, connect := store.PermInventory, store.PermFiles, store.PermQuick, store.PermCredentials, store.PermConnect

	// Users and teams (administrators)
	a("GET /api/users", s.adminOnly(s.handleListUsers))
	a("POST /api/users", s.adminOnly(s.handleCreateUser))
	a("PUT /api/users/{id}", s.adminOnly(s.handleUpdateUser))
	a("DELETE /api/users/{id}", s.adminOnly(s.handleDeleteUser))
	a("POST /api/users/{id}/password", s.adminOnly(s.handleResetUserPassword))
	a("POST /api/users/{id}/sign-out", s.adminOnly(s.handleSignOutUser))
	a("POST /api/users/{id}/2fa/reset", s.adminOnly(s.handleResetUserTwoFactor))
	a("GET /api/teams", s.adminOnly(s.handleListTeams))
	a("POST /api/teams", s.adminOnly(s.handleCreateTeam))
	a("PUT /api/teams/{id}", s.adminOnly(s.handleUpdateTeam))
	a("DELETE /api/teams/{id}", s.adminOnly(s.handleDeleteTeam))

	// Inventory: everyone sees what they were given; changes need permission and ownership.
	a("GET /api/export", s.handleExport)
	a("POST /api/import/preview", s.withPerm(inv, s.handleImportPreview))
	a("POST /api/import", s.withPerm(inv, s.handleImport))

	a("GET /api/groups", s.handleListGroups)
	a("POST /api/groups", s.withPerm(inv, s.handleCreateGroup))
	a("PUT /api/groups/{id}", s.group(s.handleUpdateGroup))
	a("DELETE /api/groups/{id}", s.group(s.handleDeleteGroup))

	a("GET /api/devices", s.handleListDevices)
	a("POST /api/devices", s.withPerm(inv, s.handleCreateDevice))
	a("GET /api/devices/{id}", s.dev(needUse, "", s.handleGetDevice))
	a("PUT /api/devices/{id}", s.dev(needManage, "", s.handleUpdateDevice))
	a("DELETE /api/devices/{id}", s.dev(needManage, "", s.handleDeleteDevice))
	a("PUT /api/devices/{id}/favorite", s.dev(needUse, "", s.handleSetFavorite))
	a("POST /api/devices/{id}/check", s.dev(needUse, "", s.handleCheckDevice))
	a("POST /api/devices/{id}/wake", s.dev(needUse, connect, s.handleWakeDevice))
	a("GET /api/devices/{id}/connections", s.dev(needUse, "", s.handleListDeviceConnections))
	a("POST /api/devices/{id}/connections", s.dev(needManage, "", s.handleCreateConnection))
	a("POST /api/devices/{id}/ssh-auto", s.dev(needManage, files, s.handleAutoSSH))
	a("POST /api/devices/{id}/probe-rdp", s.dev(needManage, files, s.handleProbeRDP))
	a("GET /api/devices/{id}/transfer", s.dev(needUse, files, s.handleTransferList))
	a("GET /api/devices/{id}/transfer/download", s.dev(needUse, files, s.handleTransferDownload))
	a("POST /api/devices/{id}/transfer/upload", s.dev(needUse, files, s.handleTransferUpload))
	a("POST /api/devices/{id}/transfer/mkdir", s.dev(needUse, files, s.handleTransferMkdir))
	a("POST /api/devices/{id}/transfer/rename", s.dev(needUse, files, s.handleTransferRename))
	a("POST /api/devices/{id}/transfer/delete", s.dev(needUse, files, s.handleTransferDelete))

	a("GET /api/connections", s.handleListConnections)
	a("GET /api/connections/{id}", s.conn(needUse, "", s.handleGetConnection))
	a("PUT /api/connections/{id}", s.conn(needManage, "", s.handleUpdateConnection))
	a("DELETE /api/connections/{id}", s.conn(needManage, "", s.handleDeleteConnection))
	a("POST /api/connections/{id}/rdp-certificate", s.conn(needManage, "", s.handleFetchRDPCertificate))
	a("POST /api/connections/{id}/ssh-host-key", s.conn(needManage, "", s.handleFetchSSHHostKey))
	a("POST /api/connections/{id}/sessions", s.conn(needUse, connect, s.handleCreateSessionTicket))
	a("POST /api/connections/{id}/ssh-access", s.conn(needUse, files, s.handleOpenSSHAccess))
	a("PUT /api/connections/{id}/keyboard-layout", s.conn(needUse, connect, s.handleSetKeyboardLayout))

	a("POST /api/quick-connections", s.withPerm(quick, s.handleCreateQuick))
	a("GET /api/quick-connections/{id}", s.withPerm(quick, s.handleGetQuick))
	a("PATCH /api/quick-connections/{id}", s.withPerm(quick, s.handleUpdateQuickSettings))
	a("DELETE /api/quick-connections/{id}", s.withPerm(quick, s.handleDeleteQuick))
	a("POST /api/quick-connections/{id}/sessions", s.withPerm(quick, s.handleQuickTicket))

	a("POST /api/copy-jobs", s.withPerm(files, s.handleStartCopy))
	a("GET /api/copy-jobs", s.withPerm(files, s.handleListCopies))
	a("DELETE /api/copy-jobs/{id}", s.withPerm(files, s.handleCancelCopy))

	a("DELETE /api/ssh-access/{aid}", s.handleCloseSSHAccess)
	a("GET /api/ssh-access/{aid}/system", s.withPerm(files, s.handleSystemInfo))
	a("GET /api/ssh-access/{aid}/files", s.withPerm(files, s.handleListFiles))
	a("GET /api/ssh-access/{aid}/files/download", s.withPerm(files, s.handleDownloadFile))
	a("POST /api/ssh-access/{aid}/files/upload", s.withPerm(files, s.handleUploadFile))
	a("POST /api/ssh-access/{aid}/files/mkdir", s.withPerm(files, s.handleMkdir))
	a("POST /api/ssh-access/{aid}/files/rename", s.withPerm(files, s.handleRename))
	a("POST /api/ssh-access/{aid}/files/delete", s.withPerm(files, s.handleDeleteFiles))

	a("GET /api/credentials", s.handleListCredentials)
	a("POST /api/credentials", s.withPerm(creds, s.handleCreateCredential))
	a("PUT /api/credentials/{id}", s.credential(s.handleUpdateCredential))
	a("DELETE /api/credentials/{id}", s.credential(s.handleDeleteCredential))

	a("GET /api/snippets", s.withPerm(connect, s.handleListSnippets))
	a("POST /api/snippets", s.withPerm(connect, s.handleCreateSnippet))
	a("PUT /api/snippets/{id}", s.withPerm(connect, s.handleUpdateSnippet))
	a("DELETE /api/snippets/{id}", s.withPerm(connect, s.handleDeleteSnippet))
	a("POST /api/snippets/{id}/used", s.withPerm(connect, s.handleSnippetUsed))

	a("GET /api/active-sessions", s.handleListActiveSessions)
	a("DELETE /api/active-sessions/{id}", s.handleTerminateActiveSession)
	a("GET /api/active-sessions/{id}/share", s.withPerm(connect, s.handleShareStatus))
	a("POST /api/active-sessions/{id}/share", s.withPerm(connect, s.handleCreateShare))
	a("DELETE /api/active-sessions/{id}/share", s.withPerm(connect, s.handleStopShare))
	a("GET /api/watch/{token}", s.withPerm(connect, s.handleWatchInfo))
	a("GET /api/watch-tunnel", s.withPerm(connect, s.handleWatchTunnel))

	a("GET /api/settings/jump", s.adminOnly(s.handleGetJumpSettings))
	a("PUT /api/settings/jump", s.adminOnly(s.handleSetJumpSettings))

	a("GET /api/statistics", s.handleStatistics)
	a("GET /api/audit", s.handleListAudit)

	a("GET /api/tunnel", s.handleTunnel)

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "Unknown API endpoint")
	})
	mux.Handle("/", s.staticHandler())

	return s.recoverer(s.securityHeaders(s.logRequests(s.checkOrigin(mux))))
}

// ---- JSON helpers ----

type apiError struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]apiError{"error": {Code: code, Message: msg}})
}

func writeValidation(w http.ResponseWriter, v *validator) {
	writeJSON(w, http.StatusUnprocessableEntity, map[string]apiError{"error": {
		Code: "validation_failed", Message: v.summary(), Fields: v.errs,
	}})
}

// writeStoreError maps persistence errors to HTTP responses without leaking internals.
func writeStoreError(w http.ResponseWriter, r *http.Request, err error, what string) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", what+" not found")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", what+" with this name already exists")
	default:
		slog.Error("request failed", "path", r.URL.Path, "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "Internal server error")
	}
}

const maxBodyBytes = 1 << 20

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	return decodeJSONBody(w, r, dst)
}

// decodeJSONBody decodes a JSON request whose body size limit the caller already set.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if ct != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be application/json")
		return false
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Request body too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "bad_request", "Invalid JSON request body: "+sanitizeJSONError(err))
		return false
	}
	return true
}

func sanitizeJSONError(err error) string {
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// ---- Client IP ----

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	remote = remote.Unmap()
	if !s.trusted(remote) {
		return remote.String()
	}
	// Walk X-Forwarded-For from the right, skipping trusted proxies.
	xff := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(xff) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(xff[i]))
		if err != nil {
			break
		}
		a = a.Unmap()
		if !s.trusted(a) {
			return a.String()
		}
	}
	return remote.String()
}

func (s *Server) trusted(a netip.Addr) bool {
	for _, p := range s.cfg.TrustedProxies {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// ---- Middleware ----

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController (and the websocket upgrader) reach the
// underlying writer's Hijacker.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	r.status = http.StatusSwitchingProtocols
	return http.NewResponseController(r.ResponseWriter).Hijack()
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if strings.HasPrefix(r.URL.Path, "/api/") || rec.status >= 400 {
			// Path only: query strings may carry one-time tunnel tickets.
			slog.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status,
				"duration_ms", time.Since(start).Milliseconds(), "ip", s.clientIP(r))
		}
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				slog.Error("panic", "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "internal", "Internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		host := r.Host
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://"+host+" ws://"+host+"; "+
			"media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// checkOrigin rejects state-changing requests and WebSocket upgrades whose
// Origin does not match the requested host (CSRF / cross-site WebSocket hijacking).
func (s *Server) checkOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		unsafe := r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions
		upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if (unsafe || upgrade) && strings.HasPrefix(r.URL.Path, "/api/") {
			if !sameOrigin(r) {
				writeError(w, http.StatusForbidden, "bad_origin", "Cross-origin request rejected")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Browsers always send Origin on WebSocket and cross-origin POST;
		// non-browser clients have no ambient cookies to abuse, but they
		// still need the CSRF header for authenticated mutations.
		return !strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	}
	i := strings.Index(origin, "://")
	if i < 0 {
		return false
	}
	return strings.EqualFold(origin[i+3:], r.Host)
}

// ---- Static UI ----

func (s *Server) staticHandler() http.Handler {
	root := s.cfg.WebDir
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
			return
		}
		clean := path.Clean("/" + r.URL.Path)
		file := filepath.Join(root, filepath.FromSlash(clean))
		if st, err := os.Stat(file); err == nil && !st.IsDir() {
			if strings.HasPrefix(clean, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.ServeFile(w, r, file)
			return
		}
		if path.Ext(clean) != "" {
			http.NotFound(w, r)
			return
		}
		// SPA fallback
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "database": "down"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	gw := "reachable"
	conn, err := net.DialTimeout("tcp", s.cfg.GuacdAddr, 2*time.Second)
	if err != nil {
		gw = "unreachable"
	} else {
		conn.Close()
	}
	nets := func(ps []netip.Prefix) []string {
		out := make([]string, len(ps))
		for i, p := range ps {
			out[i] = p.String()
		}
		return out
	}
	allowed, denied := nets(s.policy.Allowed()), nets(s.policy.Denied())
	if !userFrom(r.Context()).IsAdmin() {
		allowed, denied = []string{}, []string{} // network layout is for administrators
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":                 s.version,
		"gateway":                 gw,
		"allowed_target_networks": allowed,
		"denied_target_networks":  denied,
		"status_check_interval_s": int(s.cfg.StatusCheckInterval.Seconds()),
		"session_ttl_s":           int(s.cfg.SessionTTL.Seconds()),
		"session_idle_timeout_s":  int(s.cfg.SessionIdle.Seconds()),
		"secure_cookies":          s.cfg.CookieSecure,
		"max_upload_mb":           s.cfg.MaxUploadBytes >> 20,
		"transfer_drive":          s.drive != nil,
		"jump_enabled":            s.jumpEnabled(),
		"donate":                  !s.cfg.HideDonate,
		"audit_retention_days":    s.cfg.AuditRetentionDays,
		"audit_max_entries":       s.cfg.AuditMaxEntries,
	})
}

// pruneAudit applies the audit log retention settings.
func (s *Server) pruneAudit(ctx context.Context) {
	n, err := s.store.PruneAudit(ctx, s.cfg.AuditRetentionDays, s.cfg.AuditMaxEntries)
	if err != nil {
		slog.Warn("audit log cleanup failed", "error", err)
	} else if n > 0 {
		slog.Info("removed old audit entries", "count", n, "retention_days", s.cfg.AuditRetentionDays, "max_entries", s.cfg.AuditMaxEntries)
	}
}
