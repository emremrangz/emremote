package api

import "net/http"

// handleSessionCheck answers 200 while the sign-in is valid (requireAuth answers 401 otherwise).
func (s *Server) handleSessionCheck(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"expires_at": sess.ExpiresAt})
}
