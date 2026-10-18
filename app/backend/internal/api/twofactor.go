package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/emremrangz/emremote/internal/auth"
)

// ---- Two-factor authentication (TOTP) ----
//
// Sign-in with a second factor is two requests. The first checks the password
// and answers 202 with a short-lived challenge. The second sends the challenge
// and a 6-digit code (or a recovery code) and only then creates the session
// and unlocks the vault. The password waits in memory for those few minutes
// (never in the database or the logs) because unlocking the vault needs it.

const (
	challengeTTL      = 5 * time.Minute
	challengeAttempts = 5
	totpIssuer        = "emremote"
	recoveryCount     = 10
)

type challenge struct {
	userID   string
	password []byte
	ip       string
	expires  time.Time
	attempts int
	remember bool
}

type challengeStore struct {
	mu sync.Mutex
	m  map[string]*challenge
}

func newChallengeStore() *challengeStore { return &challengeStore{m: map[string]*challenge{}} }

func (c *challengeStore) put(userID, password, ip string, remember bool) string {
	tok := auth.RandomToken(32)
	c.mu.Lock()
	c.m[auth.HashToken(tok)] = &challenge{userID: userID, password: []byte(password), ip: ip, remember: remember, expires: time.Now().Add(challengeTTL)}
	c.mu.Unlock()
	return tok
}

func wipe(ch *challenge) {
	for i := range ch.password {
		ch.password[i] = 0
	}
}

// attempt returns the challenge for one try and counts it; after the allowed
// number of tries the challenge is destroyed.
func (c *challengeStore) attempt(tok, ip string) *challenge {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := auth.HashToken(tok)
	ch := c.m[k]
	if ch == nil {
		return nil
	}
	if time.Now().After(ch.expires) || ch.ip != ip {
		wipe(ch)
		delete(c.m, k)
		return nil
	}
	ch.attempts++
	if ch.attempts > challengeAttempts {
		wipe(ch)
		delete(c.m, k)
		return nil
	}
	return ch
}

func (c *challengeStore) finish(tok string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := auth.HashToken(tok)
	if ch := c.m[k]; ch != nil {
		wipe(ch)
		delete(c.m, k)
	}
}

func (c *challengeStore) sweep() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, ch := range c.m {
		if now.After(ch.expires) {
			wipe(ch)
			delete(c.m, k)
		}
	}
}

func totpAAD(userID string) []byte { return []byte("emremote:totp:" + userID) }

// checkSecondFactor verifies a TOTP code or recovery code for a user. It
// returns the factor used ("totp" or "recovery").
func (s *Server) checkSecondFactor(r *http.Request, userID, code string) (string, bool) {
	ctx := r.Context()
	st, err := s.store.GetTOTP(ctx, userID)
	if err != nil || !st.Enabled || len(st.SecretEnc) == 0 {
		return "", false
	}
	if norm, ok := auth.NormalizeRecovery(code); ok {
		used, err := s.store.UseRecoveryCode(ctx, userID, auth.HashRecovery(norm))
		return "recovery", err == nil && used
	}
	raw, err := s.box.Open(st.SecretEnc, totpAAD(userID))
	if err != nil {
		slog.Error("two-factor secret could not be decrypted", "user", userID)
		return "", false
	}
	step, ok := auth.VerifyTOTP(raw, code, time.Now())
	if !ok {
		return "", false
	}
	fresh, err := s.store.AdvanceTOTPStep(ctx, userID, step)
	return "totp", err == nil && fresh
}

func (s *Server) handleLogin2FA(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Challenge string `json:"challenge"`
		Code      string `json:"code"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ip := s.clientIP(r)
	ch := s.challenges.attempt(req.Challenge, ip)
	if ch == nil {
		writeError(w, http.StatusUnauthorized, "challenge_expired", "This sign-in expired. Enter your password again.")
		return
	}
	user, err := s.store.GetUser(r.Context(), ch.userID)
	if err != nil || user.Disabled {
		s.challenges.finish(req.Challenge)
		writeError(w, http.StatusUnauthorized, "challenge_expired", "This sign-in expired. Enter your password again.")
		return
	}
	uname := strings.ToLower(user.Username)
	if ok, wait := s.limiter.Allowed(ip, uname); !ok {
		s.audit(r, "auth.login", "user", user.ID, user.Username, false, map[string]any{"reason": "rate limited"})
		tooMany(w, wait)
		return
	}
	factor, ok := s.checkSecondFactor(r, user.ID, req.Code)
	if !ok {
		s.limiter.Fail(ip, uname)
		r2 := r.WithContext(context.WithValue(r.Context(), ctxUser, user))
		s.audit(r2, "auth.login", "user", user.ID, user.Username, false, map[string]any{"reason": "invalid second factor"})
		writeError(w, http.StatusUnauthorized, "invalid_code", "That code is not valid. Check the code in your authenticator app, or use a recovery code.")
		return
	}
	password := string(ch.password)
	remember := ch.remember
	s.challenges.finish(req.Challenge)
	s.limiter.Succeed(uname)
	s.completeLogin(w, r, user, password, factor, remember)
}

// ---- Managing your own second factor ----

func (s *Server) handleTwoFactorStatus(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	left, _ := s.store.CountRecoveryCodes(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, map[string]any{"enabled": u.TwoFactor, "recovery_codes_left": left})
}

// confirmPassword checks the signed-in user's password, rate limited like a password change.
func (s *Server) confirmPassword(w http.ResponseWriter, r *http.Request, password string) bool {
	u := userFrom(r.Context())
	ip := s.clientIP(r)
	if ok, wait := s.limiter.Allowed(ip, "#2fa:"+u.ID); !ok {
		tooMany(w, wait)
		return false
	}
	if ok, _ := auth.VerifyPassword(password, u.PasswordHash); !ok {
		s.limiter.Fail(ip, "#2fa:"+u.ID)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]apiError{"error": {
			Code: "validation_failed", Message: "Password is incorrect", Fields: map[string]string{"password": "Password is incorrect"}}})
		return false
	}
	return true
}

func (s *Server) handleTwoFactorSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	u := userFrom(r.Context())
	if u.TwoFactor {
		writeError(w, http.StatusConflict, "already_enabled", "Two-factor authentication is already on. Turn it off first to set it up again.")
		return
	}
	if !s.confirmPassword(w, r, req.Password) {
		return
	}
	raw, encoded := auth.NewTOTPSecret()
	enc, err := s.box.SealServer(raw, totpAAD(u.ID))
	if err == nil {
		err = s.store.SetTOTPPending(r.Context(), u.ID, enc)
	}
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"secret":      encoded,
		"otpauth_uri": auth.OTPAuthURI(totpIssuer, u.Username, encoded),
	})
}

func newRecovery() (plain, hashes []string) {
	plain = auth.NewRecoveryCodes(recoveryCount)
	for _, c := range plain {
		n, _ := auth.NormalizeRecovery(c)
		hashes = append(hashes, auth.HashRecovery(n))
	}
	return plain, hashes
}

func (s *Server) handleTwoFactorEnable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	u := userFrom(r.Context())
	ip := s.clientIP(r)
	if ok, wait := s.limiter.Allowed(ip, "#2fa:"+u.ID); !ok {
		tooMany(w, wait)
		return
	}
	st, err := s.store.GetTOTP(r.Context(), u.ID)
	if err != nil || len(st.PendingEnc) == 0 {
		writeError(w, http.StatusConflict, "no_setup", "Start the setup first.")
		return
	}
	raw, err := s.box.Open(st.PendingEnc, totpAAD(u.ID))
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	step, ok := auth.VerifyTOTP(raw, req.Code, time.Now())
	if !ok {
		s.limiter.Fail(ip, "#2fa:"+u.ID)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]apiError{"error": {
			Code: "validation_failed", Message: "That code is not valid", Fields: map[string]string{"code": "That code is not valid. Check the time on your phone."}}})
		return
	}
	plain, hashes := newRecovery()
	if err := s.store.EnableTOTP(r.Context(), u.ID, step, hashes); err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	s.audit(r, "auth.2fa_enabled", "user", u.ID, u.Username, true, nil)
	writeJSON(w, http.StatusOK, map[string]any{"recovery_codes": plain})
}

// handleTwoFactorDisable and handleTwoFactorRecovery both ask for the password
// and a current code, so a stolen session alone cannot weaken the account.
func (s *Server) verifyOwnFactor(w http.ResponseWriter, r *http.Request, password, code string) bool {
	u := userFrom(r.Context())
	if !s.confirmPassword(w, r, password) {
		return false
	}
	if !u.TwoFactor {
		writeError(w, http.StatusConflict, "not_enabled", "Two-factor authentication is not on.")
		return false
	}
	if _, ok := s.checkSecondFactor(r, u.ID, code); !ok {
		s.limiter.Fail(s.clientIP(r), "#2fa:"+u.ID)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]apiError{"error": {
			Code: "validation_failed", Message: "That code is not valid", Fields: map[string]string{"code": "That code is not valid."}}})
		return false
	}
	return true
}

func (s *Server) handleTwoFactorDisable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !s.verifyOwnFactor(w, r, req.Password, req.Code) {
		return
	}
	u := userFrom(r.Context())
	if err := s.store.DisableTOTP(r.Context(), u.ID); err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	s.audit(r, "auth.2fa_disabled", "user", u.ID, u.Username, true, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTwoFactorRecovery(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !s.verifyOwnFactor(w, r, req.Password, req.Code) {
		return
	}
	u := userFrom(r.Context())
	plain, hashes := newRecovery()
	if err := s.store.ReplaceRecoveryCodes(r.Context(), u.ID, hashes); err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	s.audit(r, "auth.2fa_recovery_codes", "user", u.ID, u.Username, true, nil)
	writeJSON(w, http.StatusOK, map[string]any{"recovery_codes": plain})
}

// handleResetUserTwoFactor lets an administrator remove another user's second
// factor (for a lost phone and lost recovery codes) and signs them out.
func (s *Server) handleResetUserTwoFactor(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	target, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	if id == userFrom(r.Context()).ID {
		writeError(w, http.StatusConflict, "self_change", "Turn off your own two-factor authentication under Settings.")
		return
	}
	if err := s.store.DisableTOTP(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	n := s.signOutEverywhere(r.Context(), id)
	s.audit(r, "user.2fa_reset", "user", target.ID, target.Username, true, map[string]any{"revoked_sessions": n})
	w.WriteHeader(http.StatusNoContent)
}
