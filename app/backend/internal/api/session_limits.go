package api

import (
	"encoding/json"
	"net/http"
	"time"
)

// How long a sign-in lasts can be changed by an administrator in Settings. What is saved there replaces the
// environment defaults (EMREMOTE_SESSION_IDLE_TIMEOUT, EMREMOTE_SESSION_TTL, EMREMOTE_REMEMBER_DAYS).
const sessionLimitsKey = "session_limits"

type sessionLimits struct {
	Idle         time.Duration // unused for this long: signed out
	TTL          time.Duration // signed out at the latest after this long
	RememberTTL  time.Duration // the same for "remember me" sessions; 0 turns the option off
	RememberIdle time.Duration
}

// saved is the stored form: whole minutes and days, so the file stays readable.
type savedSessionLimits struct {
	IdleMinutes  int `json:"idle_minutes"`
	TTLMinutes   int `json:"ttl_minutes"`
	RememberDays int `json:"remember_days"`
}

func limitsFromSaved(v savedSessionLimits) sessionLimits {
	l := sessionLimits{
		Idle:        time.Duration(v.IdleMinutes) * time.Minute,
		TTL:         time.Duration(v.TTLMinutes) * time.Minute,
		RememberTTL: time.Duration(v.RememberDays) * 24 * time.Hour,
	}
	l.RememberIdle = min(7*24*time.Hour, l.RememberTTL)
	return l
}

func (s *Server) envSessionLimits() savedSessionLimits {
	return savedSessionLimits{
		IdleMinutes:  int(s.cfg.SessionIdle / time.Minute),
		TTLMinutes:   int(s.cfg.SessionTTL / time.Minute),
		RememberDays: int(s.cfg.RememberTTL / (24 * time.Hour)),
	}
}

// limits returns the sign-in limits in force: the saved ones, or the environment defaults.
func (s *Server) limits() sessionLimits {
	if p := s.sessionLimits.Load(); p != nil {
		return *p
	}
	l := limitsFromSaved(s.envSessionLimits())
	// The environment value of the idle limit for remembered sessions is kept as configured.
	l.RememberIdle = s.cfg.RememberIdle
	return l
}

func (s *Server) loadSessionLimits(raw []byte) {
	var v savedSessionLimits
	if json.Unmarshal(raw, &v) != nil || validateSessionLimits(v) != "" {
		return
	}
	l := limitsFromSaved(v)
	s.sessionLimits.Store(&l)
}

// validateSessionLimits returns what is wrong with the values, or "".
func validateSessionLimits(v savedSessionLimits) string {
	switch {
	case v.IdleMinutes < 5 || v.IdleMinutes > 7*24*60:
		return "The idle timeout must be between 5 minutes and 7 days."
	case v.TTLMinutes < 15 || v.TTLMinutes > 30*24*60:
		return "The longest sign-in must be between 15 minutes and 30 days."
	case v.TTLMinutes < v.IdleMinutes:
		return "The longest sign-in cannot be shorter than the idle timeout."
	case v.RememberDays < 0 || v.RememberDays > 365:
		return "Remember me must be between 0 (off) and 365 days."
	}
	return ""
}

func (s *Server) handleGetSessionLimits(w http.ResponseWriter, r *http.Request) {
	l := s.limits()
	_, saved, _ := s.store.GetSetting(r.Context(), sessionLimitsKey)
	writeJSON(w, http.StatusOK, map[string]any{
		"idle_minutes":  int(l.Idle / time.Minute),
		"ttl_minutes":   int(l.TTL / time.Minute),
		"remember_days": int(l.RememberTTL / (24 * time.Hour)),
		"saved":         saved,
		"env":           s.envSessionLimits(),
	})
}

func (s *Server) handleSetSessionLimits(w http.ResponseWriter, r *http.Request) {
	var req savedSessionLimits
	if !decodeJSON(w, r, &req) {
		return
	}
	if msg := validateSessionLimits(req); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", msg)
		return
	}
	raw, _ := json.Marshal(req)
	if err := s.store.SetSetting(r.Context(), sessionLimitsKey, raw); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.loadSessionLimits(raw)
	s.audit(r, "settings.sessions", "settings", "", "Sign-in limits", true, map[string]any{"idle_minutes": req.IdleMinutes, "ttl_minutes": req.TTLMinutes, "remember_days": req.RememberDays})
	s.handleGetSessionLimits(w, r)
}
