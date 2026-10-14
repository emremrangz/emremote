package transfer

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDriveConfinement(t *testing.T) {
	base := t.TempDir()
	d := New(base)
	if d == nil {
		t.Fatal("drive not created")
	}
	if _, err := d.Upload("dev", "/", "a.txt", strings.NewReader("hi"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Upload("dev", "/", "a.txt", strings.NewReader("x"), false); err == nil {
		t.Fatal("overwrite without flag must fail")
	}
	// ".." cannot escape the device root
	// "/../other" is cleaned to "/other" inside the device root (which does
	// not exist), so the upload fails instead of escaping.
	if _, err := d.Upload("dev", "/../other", "b.txt", strings.NewReader("x"), false); err == nil {
		t.Fatal("expected failure for a non-existent folder")
	}
	if _, err := os.Stat(filepath.Join(base, "other")); err == nil {
		t.Fatal("escaped the device root")
	}
	// symlinks inside the drive are refused
	os.Symlink("/etc", filepath.Join(base, "dev", "etc"))
	if _, err := d.List("dev", "/etc"); err == nil {
		t.Fatal("symlink was followed")
	}
	l, err := d.List("dev", "/")
	if err != nil || len(l.Entries) != 2 {
		t.Fatalf("list: %v %+v", err, l)
	}
	p, err := d.Mkdir("dev", "/", "docs")
	if err != nil || p != "/docs" {
		t.Fatal(err)
	}
	if _, err := d.Rename("dev", "/a.txt", "b.txt"); err != nil {
		t.Fatal(err)
	}
	_, full, _ := d.Stat("dev", "/b.txt")
	var buf bytes.Buffer
	CopyFile(full, &buf)
	if buf.String() != "hi" {
		t.Fatal("content mismatch")
	}
	if _, err := d.Remove("dev", "/", true); err == nil {
		t.Fatal("removing the root must fail")
	}
	if n, err := d.Remove("dev", "/docs", true); err != nil || n != 1 {
		t.Fatalf("remove: %d %v", n, err)
	}
}
