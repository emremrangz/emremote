// Package transfer manages the per-device "transfer drive": a folder on the
// emremote host that guacd redirects into RDP sessions as a network drive
// (named "emremote" inside Windows). It lets users exchange files with RDP-only
// machines without anything installed or enabled on them.
//
// All paths are relative to the device's root and are confined to it:
// symlinks are never followed and ".." cannot escape.
package transfer

import (
	"archive/zip"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/emremrangz/emremote/internal/sshhelper"
)

var ErrUnavailable = errors.New("the transfer drive is not available (EMREMOTE_TRANSFER_DIR is not writable)")

type Drive struct {
	base string
}

// New returns a Drive rooted at base, or nil if base is not a writable directory.
func New(base string) *Drive {
	if base == "" {
		return nil
	}
	if err := os.MkdirAll(base, 0o750); err != nil {
		return nil
	}
	probe := filepath.Join(base, ".emremote-write-test")
	if err := os.WriteFile(probe, nil, 0o600); err != nil {
		return nil
	}
	os.Remove(probe)
	return &Drive{base: base}
}

// HostPath is the directory of a device's drive (shared with guacd at the same path).
func (d *Drive) HostPath(deviceID string) string { return filepath.Join(d.base, deviceID) }

// resolve maps a virtual absolute path ("/", "/docs/a.txt") to a host path
// inside the device root, refusing symlinks anywhere along the way.
func (d *Drive) resolve(deviceID, virtual string) (string, string, error) {
	root := d.HostPath(deviceID)
	if err := os.MkdirAll(root, 0o750); err != nil {
		return "", "", err
	}
	v, err := sshhelper.CleanPath(virtual)
	if err != nil {
		return "", "", err
	}
	full := filepath.Join(root, filepath.FromSlash(v))
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", sshhelper.ErrInvalidPath
	}
	cur := root
	if rel != "." {
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			cur = filepath.Join(cur, part)
			fi, err := os.Lstat(cur)
			if errors.Is(err, fs.ErrNotExist) {
				break // the remainder does not exist yet (e.g. upload target)
			}
			if err != nil {
				return "", "", err
			}
			if fi.Mode()&fs.ModeSymlink != 0 {
				return "", "", sshhelper.ErrInvalidPath
			}
		}
	}
	return full, v, nil
}

func (d *Drive) List(deviceID, dir string) (*sshhelper.Listing, error) {
	full, v, err := d.resolve(deviceID, dir)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(full)
	if err != nil {
		return nil, err
	}
	out := &sshhelper.Listing{Path: v, Parent: path.Dir(v), Entries: []sshhelper.Entry{}}
	for _, it := range items {
		fi, err := it.Info()
		if err != nil {
			continue
		}
		typ := "other"
		switch {
		case fi.IsDir():
			typ = "dir"
		case fi.Mode()&fs.ModeSymlink != 0:
			typ = "link"
		case fi.Mode().IsRegular():
			typ = "file"
		}
		out.Entries = append(out.Entries, sshhelper.Entry{
			Name: it.Name(), Path: path.Join(v, it.Name()), Type: typ, Size: fi.Size(),
			Mode: fi.Mode().String(), Modified: fi.ModTime().UTC(),
		})
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if (a.Type == "dir") != (b.Type == "dir") {
			return a.Type == "dir"
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}

func (d *Drive) Stat(deviceID, p string) (os.FileInfo, string, error) {
	full, _, err := d.resolve(deviceID, p)
	if err != nil {
		return nil, "", err
	}
	fi, err := os.Lstat(full)
	return fi, full, err
}

func CopyFile(full string, w io.Writer) (int64, error) {
	f, err := os.Open(full)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return io.Copy(w, f)
}

func ZipDir(full string, w io.Writer) error {
	zw := zip.NewWriter(w)
	base := filepath.Dir(full)
	err := filepath.WalkDir(full, func(p string, de fs.DirEntry, err error) error {
		if err != nil || de.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		rel, _ := filepath.Rel(base, p)
		rel = filepath.ToSlash(rel)
		if de.IsDir() {
			_, err := zw.Create(rel + "/")
			return err
		}
		fi, err := de.Info()
		if err != nil || !fi.Mode().IsRegular() {
			return nil
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name, hdr.Method = rel, zip.Deflate
		dst, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		_, err = CopyFile(p, dst)
		return err
	})
	if err != nil {
		return err
	}
	return zw.Close()
}

func (d *Drive) Upload(deviceID, dir, name string, r io.Reader, overwrite bool) (int64, error) {
	if !sshhelper.ValidName(name) {
		return 0, sshhelper.ErrInvalidPath
	}
	full, _, err := d.resolve(deviceID, path.Join(dir, name))
	if err != nil {
		return 0, err
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if !overwrite {
		flags |= os.O_EXCL
	}
	f, err := os.OpenFile(full, flags, 0o640)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(full)
	}
	return n, err
}

func (d *Drive) Mkdir(deviceID, dir, name string) (string, error) {
	if !sshhelper.ValidName(name) {
		return "", sshhelper.ErrInvalidPath
	}
	full, v, err := d.resolve(deviceID, path.Join(dir, name))
	if err != nil {
		return "", err
	}
	return v, os.Mkdir(full, 0o750)
}

func (d *Drive) Rename(deviceID, from, name string) (string, error) {
	if !sshhelper.ValidName(name) {
		return "", sshhelper.ErrInvalidPath
	}
	src, v, err := d.resolve(deviceID, from)
	if err != nil || v == "/" {
		return "", sshhelper.ErrInvalidPath
	}
	dst, nv, err := d.resolve(deviceID, path.Join(path.Dir(v), name))
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(dst); err == nil {
		return "", fs.ErrExist
	}
	return nv, os.Rename(src, dst)
}

func (d *Drive) Remove(deviceID, p string, recursive bool) (int, error) {
	full, v, err := d.resolve(deviceID, p)
	if err != nil || v == "/" {
		return 0, sshhelper.ErrInvalidPath
	}
	fi, err := os.Lstat(full)
	if err != nil {
		return 0, err
	}
	if !fi.IsDir() || !recursive {
		return 1, os.Remove(full)
	}
	n := 0
	_ = filepath.WalkDir(full, func(string, fs.DirEntry, error) error { n++; return nil })
	return n, os.RemoveAll(full)
}

// Usage returns the total size of a device's drive.
func (d *Drive) Usage(deviceID string) int64 {
	var total int64
	_ = filepath.WalkDir(d.HostPath(deviceID), func(_ string, de fs.DirEntry, err error) error {
		if err == nil && !de.IsDir() {
			if fi, err := de.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total
}

// ---- Raw access used by server-to-server copies ----

// Open opens a regular file for reading.
func (d *Drive) Open(deviceID, p string) (*os.File, error) {
	full, _, err := d.resolve(deviceID, p)
	if err != nil {
		return nil, err
	}
	fi, err := os.Lstat(full)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, sshhelper.ErrInvalidPath
	}
	return os.Open(full)
}

// Create creates (or, with overwrite, truncates) a file for writing.
func (d *Drive) Create(deviceID, p string, overwrite bool) (*os.File, error) {
	full, v, err := d.resolve(deviceID, p)
	if err != nil || v == "/" {
		return nil, sshhelper.ErrInvalidPath
	}
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if !overwrite {
		flags |= os.O_EXCL
	}
	return os.OpenFile(full, flags, 0o640)
}

// MkdirAll creates a directory (and parents) inside the device root.
func (d *Drive) MkdirAll(deviceID, p string) error {
	full, _, err := d.resolve(deviceID, p)
	if err != nil {
		return err
	}
	return os.MkdirAll(full, 0o750)
}

// ReadDir lists a directory (symlinks are reported but never followed).
func (d *Drive) ReadDir(deviceID, p string) ([]os.FileInfo, error) {
	full, _, err := d.resolve(deviceID, p)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(full)
	if err != nil {
		return nil, err
	}
	out := make([]os.FileInfo, 0, len(entries))
	for _, e := range entries {
		if fi, err := e.Info(); err == nil {
			out = append(out, fi)
		}
	}
	return out, nil
}
