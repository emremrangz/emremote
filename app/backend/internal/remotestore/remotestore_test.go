package remotestore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/netip"
	"os"
	"testing"
)

func TestValidate(t *testing.T) {
	ok := []Config{
		{Kind: "smb", Host: "nas.lan", Share: "recordings", Username: "rec"},
		{Kind: "nfs", Host: "10.0.0.5", Share: "/export/emremote", Dir: "rec-1", UID: 1000, GID: 1000},
	}
	for i, c := range ok {
		if msg := c.Validate(); msg != "" {
			t.Errorf("valid config %d refused: %s", i, msg)
		}
	}
	bad := []Config{
		{Kind: "ftp", Host: "x", Share: "a"},
		{Kind: "smb", Host: "", Share: "a"},
		{Kind: "smb", Host: "x", Share: "a/b"},
		{Kind: "smb", Host: "x", Share: "..\\x"},
		{Kind: "nfs", Host: "x", Share: "export"},
		{Kind: "nfs", Host: "x", Share: "/e", Dir: "a/b"},
		{Kind: "nfs", Host: "x", Share: "/e", Dir: ".."},
		{Kind: "nfs", Host: "x", Share: "/e", UID: 70000},
	}
	for i, c := range bad {
		if c.Validate() == "" {
			t.Errorf("bad config %d accepted: %+v", i, c)
		}
	}
}

func TestCheckName(t *testing.T) {
	for _, n := range []string{"", ".", "..", "a/b", "a\\b", "x y"} {
		if checkName(n) == nil {
			t.Errorf("%q should be refused", n)
		}
	}
	if checkName("0b1f2a3c-aaaa-4bbb-8ccc-1234567890ab") != nil {
		t.Error("a recording id must be accepted")
	}
}

// Real file servers: set REMOTESTORE_KIND (smb or nfs), REMOTESTORE_HOST (an IP address), REMOTESTORE_SHARE and, for SMB,
// REMOTESTORE_USER and REMOTESTORE_PASSWORD. tests/stack.sh starts such servers.
func TestAgainstServer(t *testing.T) {
	kind, host := os.Getenv("REMOTESTORE_KIND"), os.Getenv("REMOTESTORE_HOST")
	if kind == "" || host == "" {
		t.Skip("no file server configured")
	}
	addr := netip.MustParseAddr(host)
	c := Config{Kind: kind, Host: host, Share: os.Getenv("REMOTESTORE_SHARE"), Dir: "emremote-test", Username: os.Getenv("REMOTESTORE_USER"), Password: os.Getenv("REMOTESTORE_PASSWORD"), UID: 1000, GID: 1000}
	be, err := Open(context.Background(), c, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer be.Close()
	if err := be.Probe(); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("0123456789abcdef"), 200_000) // 3.2 MB, several read and write calls
	n, err := be.Put("rec-test-1", bytes.NewReader(data))
	if err != nil || n != int64(len(data)) {
		t.Fatalf("put: %d %v", n, err)
	}
	f, err := be.Open("rec-test-1")
	if err != nil {
		t.Fatal(err)
	}
	if f.Size() != int64(len(data)) {
		t.Fatalf("size %d", f.Size())
	}
	got, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("read back differs: %v", err)
	}
	if end, err := f.Seek(0, io.SeekEnd); err != nil || end != int64(len(data)) {
		t.Fatalf("seek to the end: %d %v", end, err)
	}
	if _, err := f.Seek(1_000_000, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	part := make([]byte, 32)
	if _, err := io.ReadFull(f, part); err != nil || !bytes.Equal(part, data[1_000_000:1_000_032]) {
		t.Fatalf("seek read differs: %v", err)
	}
	f.Close()
	// Replacing works, and removing twice is not an error.
	if _, err := be.Put("rec-test-1", bytes.NewReader([]byte("short"))); err != nil {
		t.Fatal(err)
	}
	f, _ = be.Open("rec-test-1")
	if f.Size() != 5 {
		t.Fatalf("replace left size %d", f.Size())
	}
	f.Close()
	if err := be.Remove("rec-test-1"); err != nil {
		t.Fatal(err)
	}
	if err := be.Remove("rec-test-1"); err != nil {
		t.Fatalf("second remove: %v", err)
	}
	if _, err := be.Open("rec-test-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("open of a removed file: %v", err)
	}
	// A wrong password or share must fail clearly.
	bad := c
	bad.Password = "wrong-password"
	if kind == "smb" {
		if _, err := Open(context.Background(), bad, addr); err == nil {
			t.Fatal("a wrong password was accepted")
		}
	}
	bad = c
	bad.Share = map[string]string{"smb": "nosuchshare", "nfs": "/nosuch"}[kind]
	if _, err := Open(context.Background(), bad, addr); err == nil {
		t.Fatal("a wrong share was accepted")
	}
}
