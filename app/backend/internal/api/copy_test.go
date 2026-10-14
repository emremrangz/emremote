package api

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/emremrangz/emremote/internal/transfer"
)

func TestCopyPlanSkipsSymlinks(t *testing.T) {
	base := t.TempDir()
	s := &Server{drive: transfer.New(base)}
	src := &driveFS{s: s, deviceID: "a"}
	root := filepath.Join(base, "a")
	os.MkdirAll(filepath.Join(root, "dir", "sub"), 0o750)
	os.WriteFile(filepath.Join(root, "dir", "f.txt"), []byte("hello"), 0o640)
	os.WriteFile(filepath.Join(root, "dir", "sub", "g.txt"), []byte("hi"), 0o640)
	os.Symlink("/etc", filepath.Join(root, "dir", "link"))

	items, err := plan(context.Background(), src, []string{"/dir"}, "/target")
	if err != nil {
		t.Fatal(err)
	}
	var files, dirs int
	var bytes int64
	for _, it := range items {
		if it.dir {
			dirs++
		} else {
			files++
			bytes += it.size
		}
		if filepath.Base(it.src) == "link" {
			t.Fatal("symlink must not be copied")
		}
	}
	if files != 2 || dirs != 2 || bytes != 7 {
		t.Fatalf("files=%d dirs=%d bytes=%d", files, dirs, bytes)
	}
	if items[0].dst != "/target/dir" {
		t.Fatalf("dst %q", items[0].dst)
	}

	// Create refuses to clobber unless asked.
	dst := &driveFS{s: s, deviceID: "b"}
	w, err := dst.Create("/f.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	r, _ := src.Open("/dir/f.txt")
	io.Copy(w, r)
	w.Close()
	if _, err := dst.Create("/f.txt", false); err == nil {
		t.Fatal("expected exists error")
	}
	if b, _ := os.ReadFile(filepath.Join(base, "b", "f.txt")); string(b) != "hello" {
		t.Fatalf("content %q", b)
	}
}
