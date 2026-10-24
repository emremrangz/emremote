package remotestore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/willscott/go-nfs-client/nfs"
	"github.com/willscott/go-nfs-client/nfs/rpc"
)

// NFS version 3 over TCP. The client cannot use a privileged source port (the application runs without privileges), so
// the export must allow it: "insecure" in /etc/exports on Linux servers.
type nfsBackend struct {
	mnt    *nfs.Mount
	target *nfs.Target
	dir    string
}

func openNFS(ctx context.Context, c Config, addr netip.Addr) (Backend, error) {
	type result struct {
		b   *nfsBackend
		err error
	}
	// The library has no context support, so the connection attempt runs aside and is abandoned on timeout.
	ch := make(chan result, 1)
	go func() {
		mnt, err := nfs.DialMount(addr.String(), time.Minute)
		if err != nil {
			ch <- result{err: fmt.Errorf("cannot reach the NFS service (portmapper on port 111): %w", err)}
			return
		}
		auth := rpc.NewAuthUnix("emremote", c.UID, c.GID)
		target, err := mnt.Mount(c.Share, auth.Auth())
		if err != nil {
			mnt.Close()
			ch <- result{err: fmt.Errorf("cannot mount the export %q (is this machine allowed in the export list, with the insecure option?): %w", c.Share, err)}
			return
		}
		b := &nfsBackend{mnt: mnt, target: target, dir: c.Dir}
		if c.Dir != "" {
			if _, _, err := target.Lookup(c.Dir); err != nil {
				if _, err := target.Mkdir(c.Dir, 0o755); err != nil {
					b.Close()
					ch <- result{err: fmt.Errorf("cannot create the folder %q on the export: %w", c.Dir, err)}
					return
				}
			}
		}
		ch <- result{b: b}
	}()
	select {
	case r := <-ch:
		return r.b, r.err
	case <-time.After(3 * dialTimeout):
		go func() {
			if r := <-ch; r.b != nil {
				r.b.Close()
			}
		}()
		return nil, errors.New("the NFS server did not answer in time")
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.b != nil {
				r.b.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

func (b *nfsBackend) p(name string) string {
	if b.dir == "" {
		return name
	}
	return path.Join(b.dir, name)
}

func (b *nfsBackend) Put(name string, src io.Reader) (int64, error) {
	if err := checkName(name); err != nil {
		return 0, err
	}
	p := b.p(name)
	_ = b.target.Remove(p)
	f, err := b.target.OpenFile(p, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.CopyBuffer(f, struct{ io.Reader }{src}, make([]byte, nfsChunk))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return n, err
}

type nfsFile struct {
	*nfs.File
	size int64
}

func (f nfsFile) Size() int64 { return f.size }

// The client library does not handle replies that arrive in several RPC fragments, which large reads can produce, so
// reads are kept small.
const nfsChunk = 32 << 10

// The library cannot seek from the end, which http.ServeContent does to learn the size; the size is known here.
func (f nfsFile) Seek(offset int64, whence int) (int64, error) {
	if whence == io.SeekEnd {
		return f.File.Seek(f.size+offset, io.SeekStart)
	}
	return f.File.Seek(offset, whence)
}

func (f nfsFile) Read(p []byte) (int, error) {
	if len(p) > nfsChunk {
		p = p[:nfsChunk]
	}
	return f.File.Read(p)
}

func (b *nfsBackend) Open(name string) (File, error) {
	if err := checkName(name); err != nil {
		return nil, err
	}
	p := b.p(name)
	fi, _, err := b.target.Lookup(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	f, err := b.target.Open(p)
	if err != nil {
		return nil, err
	}
	return nfsFile{File: f, size: fi.Size()}, nil
}

func (b *nfsBackend) Remove(name string) error {
	if err := checkName(name); err != nil {
		return err
	}
	err := b.target.Remove(b.p(name))
	if err != nil && (errors.Is(err, os.ErrNotExist)) {
		return nil
	}
	return err
}

func (b *nfsBackend) Probe() error {
	name := probeName()
	if _, err := b.Put(name, strings.NewReader("emremote "+strconv.FormatInt(time.Now().Unix(), 10))); err != nil {
		return fmt.Errorf("the export is not writable: %w", err)
	}
	return b.Remove(name)
}

func (b *nfsBackend) Close() error {
	_ = b.mnt.Unmount()
	b.target.Close()
	b.mnt.Close()
	return nil
}
