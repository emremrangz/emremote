package remotestore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/netip"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/hirochachacha/go-smb2"
)

type smbBackend struct {
	conn  net.Conn
	sess  *smb2.Session
	share *smb2.Share
	dir   string
}

func openSMB(ctx context.Context, c Config, addr netip.Addr) (Backend, error) {
	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(addr.String(), "445"))
	if err != nil {
		return nil, fmt.Errorf("cannot reach the file server on port 445: %w", err)
	}
	user, pass := c.Username, c.Password
	if user == "" {
		user, pass = "Guest", ""
	}
	dialer := &smb2.Dialer{Initiator: &smb2.NTLMInitiator{User: user, Password: pass, Domain: c.Domain}}
	sess, err := dialer.DialContext(ctx, conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("sign-in to the file server failed: %w", err)
	}
	share, err := sess.Mount(c.Share)
	if err != nil {
		_ = sess.Logoff()
		conn.Close()
		return nil, fmt.Errorf("cannot open the share %q: %w", c.Share, err)
	}
	// The share is not bound to ctx: ctx only limits connecting, and the caller keeps using the share afterwards.
	b := &smbBackend{conn: conn, sess: sess, share: share, dir: c.Dir}
	if c.Dir != "" {
		if err := b.share.MkdirAll(c.Dir, 0o755); err != nil {
			b.Close()
			return nil, fmt.Errorf("cannot create the folder %q on the share: %w", c.Dir, err)
		}
	}
	return b, nil
}

func (b *smbBackend) p(name string) string {
	if b.dir == "" {
		return name
	}
	return path.Join(b.dir, name)
}

func (b *smbBackend) Put(name string, src io.Reader) (int64, error) {
	if err := checkName(name); err != nil {
		return 0, err
	}
	f, err := b.share.Create(b.p(name))
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, src)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return n, err
}

type smbFile struct {
	*smb2.File
	size int64
}

func (f smbFile) Size() int64 { return f.size }

func (b *smbBackend) Open(name string) (File, error) {
	if err := checkName(name); err != nil {
		return nil, err
	}
	f, err := b.share.Open(b.p(name))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return smbFile{File: f, size: fi.Size()}, nil
}

func (b *smbBackend) Remove(name string) error {
	if err := checkName(name); err != nil {
		return err
	}
	err := b.share.Remove(b.p(name))
	if err != nil && errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (b *smbBackend) Probe() error {
	name := probeName()
	if _, err := b.Put(name, strings.NewReader("emremote "+strconv.FormatInt(time.Now().Unix(), 10))); err != nil {
		return fmt.Errorf("the share is not writable: %w", err)
	}
	return b.Remove(name)
}

func (b *smbBackend) Close() error {
	_ = b.share.Umount()
	_ = b.sess.Logoff()
	return b.conn.Close()
}
