package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/emremrangz/emremote/internal/config"
)

func TestInitMarker(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state") // does not exist yet
	s := &Server{cfg: &config.Config{StateDir: dir}}
	if s.previouslyInitialized() {
		t.Fatal("a new server has no marker")
	}
	s.markInitialized()
	if !s.previouslyInitialized() {
		t.Fatal("the marker must exist after setup")
	}
	s.markInitialized() // idempotent
	if _, err := os.Stat(filepath.Join(dir, ".emremote-initialized")); err != nil {
		t.Fatal(err)
	}
	// without a state folder the guard is simply off
	off := &Server{cfg: &config.Config{}}
	off.markInitialized()
	if off.previouslyInitialized() {
		t.Fatal("no state folder, no guard")
	}
}
