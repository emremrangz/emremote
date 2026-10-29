package api

import (
	"encoding/json"
	"net/http"
	"time"
)

// How long a sign-in lasts can be changed by an administrator in Settings. What is saved there replaces the
// environment defaults (EMREMOTE_SESSION_IDLE_TIMEOUT, EMREMOTE_SESSION_TTL).
const sessionLimitsKey = "session_limits"

type sessionLimits struct {
	Idle time.Duration // unused for this long: signed out
	TTL  time.Duration // signed out at the latest after this long
}

// saved is the stored form: whole minutes, so the file stays readable.
type savedSessionLimits struct {
	IdleMinutes int `json:"idle_minutes"`
	TTLMinutes  int `json:"ttl_minutes"`
}

func limitsFromSaved(v savedSessionLimits) sessionLimits {
	return sessionLimits{
		Idle: time.Duration(v.IdleMinutes) * time.Minute,
		TTL:  time.Duration(v.TTLMinutes) * time.Minute,
	}
}

func (s *Server) envSessionLimits() savedSessionLimits {
	return savedSessionLimits{
		IdleMinutes: int(s.cfg.SessionIdle / time.Minute),
		TTLMinutes:  int(s.cfg.SessionTTL / time.Minute),
	}
}

// limits returns the sign-in limits in force: the saved ones, or the environment defaults.
func (s *Server) limits() sessionLimits {
	if p := s.sessionLimits.Load(); p != nil {
		return *p
	}
	return limitsFromSaved(s.envSessionLimits())
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
	}
	return ""
}

func (s *Server) handleGetSessionLimits(w http.ResponseWriter, r *http.Request) {
	l := s.limits()
	_, saved, _ := s.store.GetSetting(r.Context(), sessionLimitsKey)
	writeJSON(w, http.StatusOK, map[string]any{
		"idle_minutes": int(l.Idle / time.Minute),
		"ttl_minutes":  int(l.TTL / time.Minute),
		"saved":        saved,
		"env":          s.envSessionLimits(),
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
	s.audit(r, "settings.sessions", "settings", "", "Sign-in limits", true, map[string]any{"idle_minutes": req.IdleMinutes, "ttl_minutes": req.TTLMinutes})
	s.handleGetSessionLimits(w, r)
}
