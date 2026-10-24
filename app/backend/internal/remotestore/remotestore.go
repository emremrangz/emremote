// Package remotestore keeps files on a network share (SMB or NFS) with clients that run inside the application:
// nothing is mounted, so the container needs no extra privileges. The caller resolves and checks the address first
// and passes the address, so the name cannot point somewhere else later.
package remotestore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"time"
)

// Config says where the share is and how to sign in. Password is never stored here by the caller in plain text.
type Config struct {
	Kind     string `json:"kind"`  // "smb" or "nfs"
	Host     string `json:"host"`  // address or name of the file server
	Share    string `json:"share"` // SMB share name, or NFS export path such as /export/emremote
	Dir      string `json:"dir"`   // one folder inside the share for the files; empty means the top of the share
	Username string `json:"username"`
	Domain   string `json:"domain"`
	UID      uint32 `json:"uid"` // NFS: the user id the server sees
	GID      uint32 `json:"gid"`

	Password string `json:"-"`
}

var (
	shareRe  = regexp.MustCompile(`^[A-Za-z0-9 ._$-]{1,80}$`)
	dirRe    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	exportRe = regexp.MustCompile(`^/[A-Za-z0-9 ._/-]{0,200}$`)
	nameRe   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
)

// Validate returns what is wrong with the settings, or "".
func (c Config) Validate() string {
	switch c.Kind {
	case "smb":
		if !shareRe.MatchString(c.Share) {
			return "The SMB share name is the name shown by the file server, for example recordings (letters, digits, space, dot, dash, underscore)."
		}
	case "nfs":
		if !exportRe.MatchString(c.Share) || c.Share == "" {
			return "The NFS export is a path that starts with /, for example /export/emremote."
		}
	default:
		return "Choose SMB or NFS."
	}
	if c.Host == "" || len(c.Host) > 253 {
		return "Enter the address of the file server."
	}
	if c.Dir != "" && (!dirRe.MatchString(c.Dir) || c.Dir == "." || c.Dir == "..") {
		return "The folder is one name (letters, digits, dot, dash, underscore), not a path."
	}
	if len(c.Username) > 128 || len(c.Domain) > 128 || len(c.Password) > 256 {
		return "The user name, domain or password is too long."
	}
	if c.Kind == "nfs" && (c.UID > 65535 || c.GID > 65535) {
		return "The NFS user and group ids are between 0 and 65535."
	}
	return ""
}

// Backend is an open connection to a share.
type Backend interface {
	// Put writes the file name (a plain file name, no folders), replacing an existing one.
	Put(name string, src io.Reader) (int64, error)
	// Open reads a file; the caller closes it.
	Open(name string) (File, error)
	Remove(name string) error
	// Probe writes and deletes a small file to prove that the share can be written.
	Probe() error
	Close() error
}

// File is a file on the share that can be read and seeked.
type File interface {
	io.ReadSeeker
	io.Closer
	Size() int64
}

// ErrNotFound is returned when the file is not on the share.
var ErrNotFound = errors.New("file not found on the share")

const dialTimeout = 10 * time.Second

// Open connects to the share at addr.
func Open(ctx context.Context, c Config, addr netip.Addr) (Backend, error) {
	if msg := c.Validate(); msg != "" {
		return nil, errors.New(msg)
	}
	switch c.Kind {
	case "smb":
		return openSMB(ctx, c, addr)
	default:
		return openNFS(ctx, c, addr)
	}
}

func checkName(name string) error {
	if !nameRe.MatchString(name) || name == "." || name == ".." {
		return fmt.Errorf("invalid file name %q", name)
	}
	return nil
}

func probeName() string { return fmt.Sprintf(".emremote-probe-%d", time.Now().UnixNano()) }
