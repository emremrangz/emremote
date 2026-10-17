package api

import (
	"bufio"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Updating from the interface works through files in the state folder, shared with the optional
// "updater" container (deploy/updater.sh). The application never talks to Docker: it only asks for an
// update by creating update.request and shows what the updater writes to update.log and update.status.
const (
	updateRequestFile = "update.request"
	updateStatusFile  = "update.status"
	updateLogFile     = "update.log"
	updaterAliveFile  = "updater.alive"

	updaterAliveMax = 30 * time.Second // the updater touches its heartbeat every 5 seconds
	updateLogLines  = 200
	updateLogBytes  = 64 << 10
)

type updateState struct {
	Updater    string   `json:"updater"` // "ready" or "missing"
	State      string   `json:"state"`   // idle, running, done or failed
	From       string   `json:"from,omitempty"`
	StartedAt  int64    `json:"started_at,omitempty"`
	FinishedAt int64    `json:"finished_at,omitempty"`
	Log        []string `json:"log"`
}

// readUpdateState reads what the updater left in dir. now is a parameter so tests can fix the time.
func readUpdateState(dir string, now time.Time) updateState {
	st := updateState{Updater: "missing", State: "idle", Log: []string{}}
	if dir == "" {
		return st
	}
	if b, err := os.ReadFile(filepath.Join(dir, updaterAliveFile)); err == nil {
		if ts, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && now.Sub(time.Unix(ts, 0)) < updaterAliveMax && now.Sub(time.Unix(ts, 0)) > -time.Minute {
			st.Updater = "ready"
		}
	}
	if f, err := os.Open(filepath.Join(dir, updateStatusFile)); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			k, v, ok := strings.Cut(sc.Text(), "=")
			if !ok {
				continue
			}
			switch k {
			case "state":
				if v == "running" || v == "done" || v == "failed" {
					st.State = v
				}
			case "from":
				st.From = truncate(v, 40)
			case "started":
				st.StartedAt, _ = strconv.ParseInt(v, 10, 64)
			case "finished":
				st.FinishedAt, _ = strconv.ParseInt(v, 10, 64)
			}
		}
		f.Close()
	}
	// A request that is still waiting counts as running, so a second click cannot queue another update.
	if _, err := os.Stat(filepath.Join(dir, updateRequestFile)); err == nil {
		st.State = "running"
	}
	// "running" with a dead updater would never end: report it as failed instead.
	if st.State == "running" && st.Updater != "ready" {
		st.State = "failed"
		st.Log = append(st.Log, "The updater stopped answering.")
	}
	if b, err := os.ReadFile(filepath.Join(dir, updateLogFile)); err == nil {
		if len(b) > updateLogBytes {
			b = b[len(b)-updateLogBytes:]
		}
		lines := strings.Split(strings.TrimRight(strings.ReplaceAll(string(b), "\r", ""), "\n"), "\n")
		if len(lines) == 1 && lines[0] == "" {
			lines = nil
		}
		if len(lines) > updateLogLines {
			lines = lines[len(lines)-updateLogLines:]
		}
		st.Log = append(lines, st.Log...)
	}
	return st
}

func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	st := readUpdateState(s.cfg.StateDir, time.Now())
	latest, _ := s.latest.get()
	available := isNewer(latest, s.version)
	writeJSON(w, http.StatusOK, map[string]any{
		"current":   s.version,
		"latest":    latest,
		"available": available,
		"updater":   st.Updater,
		"state":     st.State,
		"from":      st.From,
		"started":   st.StartedAt,
		"finished":  st.FinishedAt,
		"log":       st.Log,
	})
}

func (s *Server) handleUpdateStart(w http.ResponseWriter, r *http.Request) {
	st := readUpdateState(s.cfg.StateDir, time.Now())
	if st.Updater != "ready" {
		writeError(w, http.StatusConflict, "updater_missing", "The updater is not running. See docs/DEPLOYMENT.md, \"Updating from the interface\", or run scripts/update.sh on the server.")
		return
	}
	if st.State == "running" {
		writeError(w, http.StatusConflict, "update_running", "An update is already running.")
		return
	}
	latest, _ := s.latest.get()
	if !isNewer(latest, s.version) {
		writeError(w, http.StatusConflict, "no_update", "There is no newer version to install.")
		return
	}
	// The content is only a note for people reading the file; the updater never uses it.
	if err := os.WriteFile(filepath.Join(s.cfg.StateDir, updateRequestFile), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o640); err != nil {
		writeError(w, http.StatusInternalServerError, "update_request_failed", "Could not ask the updater: "+err.Error())
		return
	}
	s.audit(r, "system.update", "system", "", "emremote", true, map[string]any{"from": s.version, "to": latest})
	writeJSON(w, http.StatusAccepted, map[string]any{"state": "running"})
}
