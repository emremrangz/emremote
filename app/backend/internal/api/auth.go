package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"time"
	"unicode"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/store"
)

const csrfHeader = "X-CSRF-Token"

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxSession
)

func userFrom(ctx context.Context) *store.User { u, _ := ctx.Value(ctxUser).(*store.User); return u }
func sessionFrom(ctx context.Context) *store.Session {
	s, _ := ctx.Value(ctxSession).(*store.Session)
	return s
}

func (s *Server) cookieName() string {
	if s.cfg.CookieSecure {
		// __Host- prefix: browser enforces Secure, Path=/ and no Domain.
		return "__Host-emremote_session"
	}
	return "emremote_session"
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName(),
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: s.cookieName(), Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteStrictMode,
	})
}

// loadSession resolves the session cookie to a valid session and user.
// loadSession resolves the cookie to a valid session. touch records the request as activity, which keeps an
// idle session alive; the browser's background check passes false so a forgotten tab still times out.
func (s *Server) loadSession(r *http.Request, touch bool) (*store.Session, *store.User, error) {
	c, err := r.Cookie(s.cookieName())
	if err != nil || c.Value == "" || len(c.Value) > 128 {
		return nil, nil, errors.New("no session")
	}
	sess, err := s.store.GetSession(r.Context(), auth.HashToken(c.Value))
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	lim := s.limits()
	if now.After(sess.ExpiresAt) || now.Sub(sess.LastSeenAt) > lim.Idle {
		_ = s.store.DeleteSession(r.Context(), sess.ID)
		return nil, nil, errors.New("session expired")
	}
	user, err := s.store.GetUser(r.Context(), sess.UserID)
	if err != nil {
		return nil, nil, err
	}
	if user.Disabled {
		_ = s.store.DeleteSession(r.Context(), sess.ID)
		return nil, nil, errors.New("session expired")
	}
	// Coarse-grained activity tracking keeps writes low.
	if touch && now.Sub(sess.LastSeenAt) > time.Minute {
		_ = s.store.TouchSession(r.Context(), sess.ID)
	}
	return sess, user, nil
}

func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return s.requireAuthTouch(next, true)
}

func (s *Server) requireAuthTouch(next http.HandlerFunc, touch bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, user, err := s.loadSession(r, touch)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) && err.Error() != "no session" && err.Error() != "session expired" {
				slog.Error("session lookup failed", "error", err)
			}
			s.clearSessionCookie(w)
			// A cookie that no longer matches a session means the sign-in ended on the server (timed out, signed out
			// elsewhere, password changed). No cookie at all means the browser did not send one: say nothing then, so
			// the sign-in screen tells the two apart.
			if c, cerr := r.Cookie(s.cookieName()); cerr == nil && c.Value != "" {
				writeError(w, http.StatusUnauthorized, "session_ended", "Your sign-in ended (it timed out or was ended elsewhere). Sign in again.")
				return
			}
			writeError(w, http.StatusUnauthorized, "unauthenticated", "Authentication required")
			return
		}
		if !s.box.Unlocked() {
			// emremote restarted: saved passwords stay encrypted until someone
			// signs in again with their password.
			_ = s.store.DeleteSession(r.Context(), sess.ID)
			s.clearSessionCookie(w)
			writeError(w, http.StatusUnauthorized, "vault_locked", "emremote was restarted. Sign in again to unlock saved passwords.")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !auth.ConstantTimeEqual(r.Header.Get(csrfHeader), sess.CSRFToken) {
				writeError(w, http.StatusForbidden, "csrf", "Missing or invalid CSRF token")
				return
			}
		}
		ctx := context.WithValue(r.Context(), ctxUser, user)
		ctx = context.WithValue(ctx, ctxSession, sess)
		next(w, r.WithContext(ctx))
	})
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, user *store.User) (*store.Session, error) {
	token := auth.RandomToken(32)
	ttl := s.limits().TTL
	sess := &store.Session{
		ID:        auth.HashToken(token),
		UserID:    user.ID,
		CSRFToken: auth.RandomToken(32),
		ExpiresAt: time.Now().Add(ttl),
		IP:        s.clientIP(r),
		UserAgent: truncate(r.UserAgent(), 300),
	}
	if err := s.store.CreateSession(r.Context(), sess); err != nil {
		return nil, err
	}
	s.setSessionCookie(w, token, sess.ExpiresAt)
	return sess, nil
}

type meResponse struct {
	User      *store.User `json:"user"`
	CSRFToken string      `json:"csrf_token"`
	ExpiresAt time.Time   `json:"expires_at"`
}

// ---- Setup ----

func (s *Server) setupPending() bool {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	return s.setupOpen
}

func (s *Server) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"setup_required": s.setupPending(), "token_required": s.cfg.SetupToken != "", "setup_blocked": s.setupIsBlocked()})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SetupToken string `json:"setup_token"`
		Username   string `json:"username"`
		Password   string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ip := s.clientIP(r)
	if ok, wait := s.limiter.Allowed(ip, "#setup"); !ok {
		tooMany(w, wait)
		return
	}
	if s.setupIsBlocked() {
		writeError(w, http.StatusConflict, "setup_blocked", "This server was set up before but its database is empty. Check the data folder mount (see the server log) instead of creating a new account.")
		return
	}
	if !s.setupPending() {
		writeError(w, http.StatusConflict, "already_configured", "emremote is already set up")
		return
	}
	if expected := s.cfg.SetupToken; expected != "" {
		// The operator asked for a token (for instances reachable from outside).
		if !auth.ConstantTimeEqual(strings.TrimSpace(req.SetupToken), expected) {
			s.limiter.Fail(ip, "#setup")
			s.audit(r, "auth.setup", "user", "", req.Username, false, map[string]any{"reason": "invalid setup token"})
			writeError(w, http.StatusForbidden, "invalid_setup_token", "Invalid setup token. It is the EMREMOTE_SETUP_TOKEN value from the server's .env file.")
			return
		}
	} else if !localSource(ip) {
		// Without a token the first account may only be created from a private network, so an
		// instance published to the internet by mistake cannot be claimed by a stranger.
		s.audit(r, "auth.setup", "user", "", req.Username, false, map[string]any{"reason": "setup from a public address"})
		writeError(w, http.StatusForbidden, "setup_local_only", "First-time setup is only offered to computers on a private network. Open emremote from your local network, or set EMREMOTE_SETUP_TOKEN in .env and restart.")
		return
	}
	v := newValidator()
	username := v.username("username", req.Username)
	v.password("password", req.Password)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	user, err := s.store.CreateFirstUser(r.Context(), username, hash)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "already_configured", "emremote is already set up")
		return
	}
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	s.setupMu.Lock()
	s.setupOpen = false
	s.setupMu.Unlock()
	s.markInitialized()
	// A new installation starts with the usual shared groups; rename or delete them freely.
	for _, g := range []struct{ name, desc string }{
		{"Workstations", "Desktops and laptops"},
		{"Servers", "Physical and virtual servers"},
		{"Network", "Switches, routers and firewalls"},
	} {
		if _, err := s.store.CreateGroup(r.Context(), nil, g.name, g.desc); err != nil {
			slog.Warn("could not create a default group", "group", g.name, "error", err)
		}
	}

	ctx := context.WithValue(r.Context(), ctxUser, user)
	r = r.WithContext(ctx)
	if err := s.openVault(r, user, req.Password); err != nil {
		writeStoreError(w, r, err, "Vault")
		return
	}
	s.audit(r, "auth.setup", "user", user.ID, user.Username, true, nil)
	sess, err := s.startSession(w, r, user)
	if err != nil {
		writeStoreError(w, r, err, "session")
		return
	}
	_ = s.store.TouchLogin(r.Context(), user.ID)
	writeJSON(w, http.StatusCreated, meResponse{User: user, CSRFToken: sess.CSRFToken, ExpiresAt: sess.ExpiresAt})
}

// ---- Login / logout ----

func tooMany(w http.ResponseWriter, wait time.Duration) {
	secs := int(wait.Seconds()) + 1
	w.Header().Set("Retry-After", fmt.Sprint(secs))
	writeError(w, http.StatusTooManyRequests, "rate_limited",
		fmt.Sprintf("Too many failed attempts. Try again in %d minute(s).", (secs+59)/60))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		// Accepted and ignored: "remember me" was removed, older clients still send it.
		Remember bool `json:"remember"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ip := s.clientIP(r)
	uname := strings.ToLower(strings.TrimSpace(req.Username))
	if uname == "" || req.Password == "" || len(uname) > 64 || len(req.Password) > auth.MaxPasswordLength {
		writeError(w, http.StatusBadRequest, "bad_request", "Username and password are required")
		return
	}
	if ok, wait := s.limiter.Allowed(ip, uname); !ok {
		s.audit(r, "auth.login", "user", "", uname, false, map[string]any{"reason": "rate limited"})
		tooMany(w, wait)
		return
	}
	user, err := s.store.GetUserByUsername(r.Context(), uname)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeStoreError(w, r, err, "user")
		return
	}
	valid := false
	if user != nil {
		valid, err = auth.VerifyPassword(req.Password, user.PasswordHash)
		if err != nil {
			slog.Error("password hash verification error", "user", user.ID, "error", err)
		}
	} else {
		auth.VerifyDummy(req.Password)
	}
	if !valid {
		s.limiter.Fail(ip, uname)
		s.audit(r, "auth.login", "user", "", truncate(uname, 64), false, map[string]any{"reason": "invalid credentials"})
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Invalid username or password")
		return
	}
	r = r.WithContext(context.WithValue(r.Context(), ctxUser, user))
	if user.Disabled {
		s.limiter.Succeed(uname)
		s.audit(r, "auth.login", "user", user.ID, user.Username, false, map[string]any{"reason": "account disabled"})
		writeError(w, http.StatusForbidden, "account_disabled", "This account is disabled. Ask an administrator to enable it.")
		return
	}
	if user.TwoFactor {
		// The password is right; the second factor decides. Failures there count
		// against the same limiter, so the counters are only reset after it.
		ch := s.challenges.put(user.ID, req.Password, ip)
		writeJSON(w, http.StatusAccepted, map[string]any{"two_factor_required": true, "challenge": ch, "expires_in": int(challengeTTL.Seconds())})
		return
	}
	s.limiter.Succeed(uname)
	s.completeLogin(w, r, user, req.Password, "")
}

// completeLogin unlocks the vault, starts the session and answers the sign-in
// request. factor names the second factor used ("" when none).
func (s *Server) completeLogin(w http.ResponseWriter, r *http.Request, user *store.User, password, factor string) {
	r = r.WithContext(context.WithValue(r.Context(), ctxUser, user))
	if err := s.openVault(r, user, password); err != nil {
		if errors.Is(err, errVaultNeedsAdmin) {
			s.audit(r, "auth.login", "user", user.ID, user.Username, false, map[string]any{"reason": "vault key missing"})
			writeError(w, http.StatusServiceUnavailable, "vault_unavailable",
				"emremote was restarted and your saved-password key is missing. Ask another user to sign in first, then try again.")
			return
		}
		slog.Error("vault could not be unlocked", "user", user.ID, "error", err)
		s.audit(r, "auth.login", "user", user.ID, user.Username, false, map[string]any{"reason": "vault could not be unlocked"})
		writeError(w, http.StatusInternalServerError, "vault_unavailable",
			"Your password is correct, but saved passwords could not be unlocked (was EMREMOTE_ENCRYPTION_KEY changed?). See TROUBLESHOOTING.md: reset-password --forget-saved-passwords.")
		return
	}
	sess, err := s.startSession(w, r, user)
	if err != nil {
		writeStoreError(w, r, err, "session")
		return
	}
	_ = s.store.TouchLogin(r.Context(), user.ID)
	details := map[string]any{}
	if factor != "" {
		details["second_factor"] = factor
	}
	s.audit(r, "auth.login", "user", user.ID, user.Username, true, details)
	writeJSON(w, http.StatusOK, meResponse{User: user, CSRFToken: sess.CSRFToken, ExpiresAt: sess.ExpiresAt})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	writeJSON(w, http.StatusOK, meResponse{User: userFrom(r.Context()), CSRFToken: sess.CSRFToken, ExpiresAt: sess.ExpiresAt})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if err := s.store.DeleteSession(r.Context(), sess.ID); err != nil {
		writeStoreError(w, r, err, "session")
		return
	}
	s.endBrowserSession(sess.ID)
	s.clearSessionCookie(w)
	u := userFrom(r.Context())
	s.audit(r, "auth.logout", "user", u.ID, u.Username, true, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	u := userFrom(r.Context())
	sess := sessionFrom(r.Context())
	ip := s.clientIP(r)
	if ok, wait := s.limiter.Allowed(ip, "#pw:"+u.ID); !ok {
		tooMany(w, wait)
		return
	}
	ok, _ := auth.VerifyPassword(req.CurrentPassword, u.PasswordHash)
	if !ok {
		s.limiter.Fail(ip, "#pw:"+u.ID)
		s.audit(r, "auth.password_change", "user", u.ID, u.Username, false, map[string]any{"reason": "wrong current password"})
		writeJSON(w, http.StatusUnprocessableEntity, map[string]apiError{"error": {
			Code: "validation_failed", Message: "Current password is incorrect",
			Fields: map[string]string{"current_password": "Current password is incorrect"}}})
		return
	}
	v := newValidator()
	v.password("new_password", req.NewPassword)
	if req.NewPassword == req.CurrentPassword {
		v.fail("new_password", "New password must differ from the current password")
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	if err := s.rewrapVault(r.Context(), u.ID, req.NewPassword); err != nil {
		writeStoreError(w, r, err, "Vault")
		return
	}
	if err := s.store.UpdatePassword(r.Context(), u.ID, hash); err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	// Sign out every other browser session and their remote sessions.
	revoked, err := s.store.DeleteUserSessions(r.Context(), u.ID, sess.ID)
	if err == nil {
		for _, id := range revoked {
			s.endBrowserSession(id)
		}
	}
	s.audit(r, "auth.password_change", "user", u.ID, u.Username, true, map[string]any{"revoked_sessions": len(revoked)})
	w.WriteHeader(http.StatusNoContent)
}

type sessionView struct {
	store.Session
	Current bool `json:"current"`
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	cur := sessionFrom(r.Context())
	list, err := s.store.ListUserSessions(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, r, err, "session")
		return
	}
	out := make([]sessionView, 0, len(list))
	for _, sess := range list {
		out = append(out, sessionView{Session: sess, Current: sess.ID == cur.ID})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	cur := sessionFrom(r.Context())
	revoked, err := s.store.DeleteUserSessions(r.Context(), u.ID, cur.ID)
	if err != nil {
		writeStoreError(w, r, err, "session")
		return
	}
	for _, id := range revoked {
		s.endBrowserSession(id)
	}
	s.audit(r, "auth.sessions_revoked", "user", u.ID, u.Username, true, map[string]any{"count": len(revoked)})
	writeJSON(w, http.StatusOK, map[string]int{"revoked": len(revoked)})
}

// ---- Audit helper ----

func (s *Server) audit(r *http.Request, action, targetType, targetID, targetName string, success bool, details map[string]any) {
	e := store.AuditEvent{
		Action: action, TargetType: targetType, TargetID: targetID, TargetName: truncate(targetName, 200),
		IP: s.clientIP(r), Success: success,
	}
	if u := userFrom(r.Context()); u != nil {
		e.ActorUserID = &u.ID
		e.ActorName = u.Username
	}
	if details != nil {
		b, _ := json.Marshal(details)
		e.Details = b
	}
	// Use a detached context so the event is recorded even if the client disconnects.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if err := s.store.InsertAudit(ctx, e); err != nil {
		slog.Error("audit write failed", "action", action, "error", err)
	}
}

func truncate(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func utf8RuneStart(b byte) bool { return b&0xC0 != 0x80 }

// localSource reports whether ip is on a private or local network: loopback,
// RFC 1918 and unique-local ranges, link-local and carrier-grade NAT (Tailscale).
func localSource(ip string) bool {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	a = a.Unmap()
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || netip.MustParsePrefix("100.64.0.0/10").Contains(a)
}
