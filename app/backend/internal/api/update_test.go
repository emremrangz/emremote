package api

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadUpdateState(t *testing.T) {
	now := time.Now()
	alive := strconv.FormatInt(now.Add(-3*time.Second).Unix(), 10)

	// No updater at all.
	dir := t.TempDir()
	if st := readUpdateState(dir, now); st.Updater != "missing" || st.State != "idle" || len(st.Log) != 0 {
		t.Fatalf("empty folder: %+v", st)
	}
	if st := readUpdateState("", now); st.Updater != "missing" {
		t.Fatalf("no folder: %+v", st)
	}

	// An updater that is alive, a finished update.
	write(t, dir, updaterAliveFile, alive+"\n")
	write(t, dir, updateStatusFile, "state=done\nfrom=0.1.8\nstarted=100\nfinished=130\n")
	write(t, dir, updateLogFile, "Backing up...\nDone.\n")
	st := readUpdateState(dir, now)
	if st.Updater != "ready" || st.State != "done" || st.From != "0.1.8" || st.StartedAt != 100 || st.FinishedAt != 130 || len(st.Log) != 2 {
		t.Fatalf("finished: %+v", st)
	}

	// A waiting request counts as running, so a second click cannot start another update.
	write(t, dir, updateRequestFile, "now\n")
	if st := readUpdateState(dir, now); st.State != "running" {
		t.Fatalf("request pending: %+v", st)
	}
	os.Remove(filepath.Join(dir, updateRequestFile))

	// Running with a heartbeat that stopped is a failure, not an endless wait.
	write(t, dir, updateStatusFile, "state=running\nfrom=0.1.8\nstarted=100\n")
	write(t, dir, updaterAliveFile, strconv.FormatInt(now.Add(-5*time.Minute).Unix(), 10))
	if st := readUpdateState(dir, now); st.Updater != "missing" || st.State != "failed" {
		t.Fatalf("dead updater: %+v", st)
	}

	// Garbage and a huge log do not break it; only the newest lines are kept.
	write(t, dir, updaterAliveFile, alive)
	write(t, dir, updateStatusFile, "state=exploded\nnonsense\nstarted=abc\n")
	write(t, dir, updateLogFile, strings.Repeat("line\n", 5000))
	st = readUpdateState(dir, now)
	if st.State != "idle" || len(st.Log) != updateLogLines {
		t.Fatalf("garbage: state=%s log=%d", st.State, len(st.Log))
	}
}
