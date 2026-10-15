package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSecretEnv(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "key")
	if err := os.WriteFile(file, []byte("  from-the-file\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EMREMOTE_TEST_SECRET", "from-env")
	if v, err := secretEnv("EMREMOTE_TEST_SECRET"); err != nil || v != "from-env" {
		t.Fatalf("env value: %q %v", v, err)
	}
	t.Setenv("EMREMOTE_TEST_SECRET_FILE", file)
	if v, err := secretEnv("EMREMOTE_TEST_SECRET"); err != nil || v != "from-the-file" {
		t.Fatalf("the file must win and be trimmed: %q %v", v, err)
	}
	t.Setenv("EMREMOTE_TEST_SECRET_FILE", filepath.Join(dir, "missing"))
	if _, err := secretEnv("EMREMOTE_TEST_SECRET"); err == nil || !strings.Contains(err.Error(), "cannot read") {
		t.Fatalf("a missing file must be an error, never a silent fallback: %v", err)
	}
	empty := filepath.Join(dir, "empty")
	_ = os.WriteFile(empty, []byte("\n"), 0o600)
	t.Setenv("EMREMOTE_TEST_SECRET_FILE", empty)
	if _, err := secretEnv("EMREMOTE_TEST_SECRET"); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("an empty file must be an error: %v", err)
	}
	// the error names the variable, never the secret
	big := filepath.Join(dir, "big")
	_ = os.WriteFile(big, []byte(strings.Repeat("x", 70<<10)), 0o600)
	t.Setenv("EMREMOTE_TEST_SECRET_FILE", big)
	if _, err := secretEnv("EMREMOTE_TEST_SECRET"); err == nil {
		t.Fatal("a huge file must be refused")
	}
}

func TestNonNegativeInt(t *testing.T) {
	t.Setenv("EMREMOTE_TEST_N", "")
	if n, err := nonNegativeInt("EMREMOTE_TEST_N", 7); err != nil || n != 7 {
		t.Fatalf("default: %d %v", n, err)
	}
	t.Setenv("EMREMOTE_TEST_N", "30")
	if n, err := nonNegativeInt("EMREMOTE_TEST_N", 7); err != nil || n != 30 {
		t.Fatalf("value: %d %v", n, err)
	}
	for _, bad := range []string{"-1", "abc", "1.5"} {
		t.Setenv("EMREMOTE_TEST_N", bad)
		if _, err := nonNegativeInt("EMREMOTE_TEST_N", 7); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}
