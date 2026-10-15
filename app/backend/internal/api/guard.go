package api

import (
	"log/slog"
	"os"
	"path/filepath"
)

// A server that has had users leaves a small marker in its state volume. If the
// database later has no users but the marker is there, the database (or its data
// folder) is missing rather than new, and offering first-run setup would let
// anyone put a fresh administrator on top of an empty database. The marker lives
// in a Docker volume of its own, so it survives a changed or lost data folder.

const initMarkerName = ".emremote-initialized"

func (s *Server) markerPath() string { return filepath.Join(s.cfg.StateDir, initMarkerName) }

// markInitialized records that this server has been set up (best effort).
func (s *Server) markInitialized() {
	if s.cfg.StateDir == "" {
		return
	}
	if err := os.MkdirAll(s.cfg.StateDir, 0o750); err != nil {
		slog.Warn("cannot use the state folder; the empty-database guard is off", "dir", s.cfg.StateDir, "error", err)
		return
	}
	if _, err := os.Stat(s.markerPath()); err == nil {
		return
	}
	if err := os.WriteFile(s.markerPath(), []byte("this server has been set up before\n"), 0o640); err != nil {
		slog.Warn("cannot write the state marker; the empty-database guard is off", "error", err)
	}
}

// previouslyInitialized reports whether the marker exists.
func (s *Server) previouslyInitialized() bool {
	if s.cfg.StateDir == "" {
		return false
	}
	_, err := os.Stat(s.markerPath())
	return err == nil
}

// setupIsBlocked reports whether first-run setup is refused because the database looks lost.
func (s *Server) setupIsBlocked() bool {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	return s.setupBlocked
}
