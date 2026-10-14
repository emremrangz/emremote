package api

import (
	"net/http"
	"strconv"
)

// handleStatistics returns the numbers for the Statistics page.
func (s *Server) handleStatistics(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days != 7 && days != 90 {
		days = 30
	}
	tz := r.URL.Query().Get("tz")
	if tz == "" || len(tz) > 64 || !timezoneRe.MatchString(tz) {
		tz = "UTC"
	}
	st, err := s.store.Statistics(r.Context(), userFrom(r.Context()), days, tz)
	if err != nil {
		writeStoreError(w, r, err, "Statistics")
		return
	}
	writeJSON(w, http.StatusOK, st)
}
