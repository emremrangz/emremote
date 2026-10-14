package sshhelper

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

type Entry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	Type     string    `json:"type"` // "dir", "file", "link", "other"
	Size     int64     `json:"size"`
	Mode     string    `json:"mode"`
	Modified time.Time `json:"modified"`
	Target   string    `json:"target,omitempty"` // symlink target type: "dir" or "file"
}

type Listing struct {
	Path    string  `json:"path"`
	Parent  string  `json:"parent"`
	Entries []Entry `json:"entries"`
}

var ErrInvalidPath = errors.New("invalid path")

// CleanPath normalizes a remote absolute path. Remote access is limited by the
// remote account's permissions; this only rejects malformed input.
func CleanPath(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) || len(p) > 4096 {
		return "", ErrInvalidPath
	}
	if !strings.HasPrefix(p, "/") {
		// Windows OpenSSH exposes drives as /C:/...; everything is absolute.
		p = "/" + p
	}
	return path.Clean(p), nil
}

// ValidName checks a single path component used for new files/folders.
func ValidName(n string) bool {
	return n != "" && n != "." && n != ".." && len(n) <= 255 && !strings.ContainsAny(n, "/\x00")
}

func entryType(m fs.FileMode) string {
	switch {
	case m.IsDir():
		return "dir"
	case m&fs.ModeSymlink != 0:
		return "link"
	case m.IsRegular():
		return "file"
	default:
		return "other"
	}
}

func Home(c *sftp.Client) (string, error) {
	wd, err := c.Getwd()
	if err != nil || wd == "" {
		return "/", nil //nolint:nilerr // fall back to root
	}
	return CleanPath(wd)
}

func List(c *sftp.Client, dir string) (*Listing, error) {
	dir, err := CleanPath(dir)
	if err != nil {
		return nil, err
	}
	infos, err := c.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := &Listing{Path: dir, Parent: path.Dir(dir), Entries: make([]Entry, 0, len(infos))}
	for _, fi := range infos {
		e := Entry{
			Name:     fi.Name(),
			Path:     path.Join(dir, fi.Name()),
			Type:     entryType(fi.Mode()),
			Size:     fi.Size(),
			Mode:     fi.Mode().String(),
			Modified: fi.ModTime().UTC(),
		}
		if e.Type == "link" {
			if st, err := c.Stat(e.Path); err == nil {
				e.Target = entryType(st.Mode())
			}
		}
		out.Entries = append(out.Entries, e)
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		ad, bd := a.Type == "dir" || a.Target == "dir", b.Type == "dir" || b.Target == "dir"
		if ad != bd {
			return ad
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}

func Stat(c *sftp.Client, p string) (os.FileInfo, error) { return c.Stat(p) }

// CopyFile streams a remote file into w.
func CopyFile(c *sftp.Client, p string, w io.Writer) (int64, error) {
	f, err := c.Open(p)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return io.Copy(w, f)
}

// ZipDir streams a remote directory as a zip archive into w. Symlinks are not
// followed, which avoids loops.
func ZipDir(c *sftp.Client, root string, w io.Writer) error {
	zw := zip.NewWriter(w)
	base := path.Dir(root)
	walker := c.Walk(root)
	for walker.Step() {
		if err := walker.Err(); err != nil {
			continue // unreadable entries are skipped
		}
		fi := walker.Stat()
		rel := strings.TrimPrefix(walker.Path(), base)
		rel = strings.TrimPrefix(rel, "/")
		if fi.IsDir() {
			if _, err := zw.Create(rel + "/"); err != nil {
				return err
			}
			continue
		}
		if !fi.Mode().IsRegular() {
			continue
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name = rel
		hdr.Method = zip.Deflate
		dst, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		if _, err := CopyFile(c, walker.Path(), dst); err != nil {
			return err
		}
	}
	return zw.Close()
}

// Upload writes r to dir/name. It refuses to overwrite unless overwrite is set.
func Upload(c *sftp.Client, dir, name string, r io.Reader, overwrite bool) (int64, error) {
	dir, err := CleanPath(dir)
	if err != nil || !ValidName(name) {
		return 0, ErrInvalidPath
	}
	dst := path.Join(dir, name)
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if !overwrite {
		flags |= os.O_EXCL
	}
	f, err := c.OpenFile(dst, flags)
	if err != nil {
		if !overwrite {
			if _, serr := c.Stat(dst); serr == nil {
				return 0, fs.ErrExist
			}
		}
		return 0, err
	}
	n, err := f.ReadFrom(r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = c.Remove(dst) // do not leave a partial file behind
	}
	return n, err
}

func Mkdir(c *sftp.Client, dir, name string) (string, error) {
	dir, err := CleanPath(dir)
	if err != nil || !ValidName(name) {
		return "", ErrInvalidPath
	}
	p := path.Join(dir, name)
	return p, c.Mkdir(p)
}

func Rename(c *sftp.Client, from, newName string) (string, error) {
	from, err := CleanPath(from)
	if err != nil || !ValidName(newName) || from == "/" {
		return "", ErrInvalidPath
	}
	to := path.Join(path.Dir(from), newName)
	if _, err := c.Lstat(to); err == nil {
		return "", fs.ErrExist
	}
	return to, c.Rename(from, to)
}

// Remove deletes a file, symlink or (with recursive) a directory tree.
// It returns the number of entries removed.
func Remove(c *sftp.Client, p string, recursive bool) (int, error) {
	p, err := CleanPath(p)
	if err != nil || p == "/" {
		return 0, ErrInvalidPath
	}
	fi, err := c.Lstat(p)
	if err != nil {
		return 0, err
	}
	if !fi.IsDir() {
		return 1, c.Remove(p)
	}
	if !recursive {
		return 1, c.RemoveDirectory(p)
	}
	// Collect depth-first, then delete children before parents.
	var files, dirs []string
	walker := c.Walk(p)
	for walker.Step() {
		if err := walker.Err(); err != nil {
			return 0, fmt.Errorf("%s: %w", walker.Path(), err)
		}
		if walker.Stat().IsDir() {
			dirs = append(dirs, walker.Path())
		} else {
			files = append(files, walker.Path())
		}
	}
	n := 0
	for _, f := range files {
		if err := c.Remove(f); err != nil {
			return n, fmt.Errorf("%s: %w", f, err)
		}
		n++
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := c.RemoveDirectory(dirs[i]); err != nil {
			return n, fmt.Errorf("%s: %w", dirs[i], err)
		}
		n++
	}
	return n, nil
}
