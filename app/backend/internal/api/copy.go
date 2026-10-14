package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/sshhelper"
)

// ---- Server-to-server file copies ----
//
// Files flow source → emremote → destination as a stream; nothing is buffered
// on disk and nothing passes through the browser. Endpoints are either an SSH
// access session (SFTP) or a device's RDP transfer drive.

type endpointRef struct {
	Kind     string `json:"kind"` // "ssh" or "drive"
	AccessID string `json:"access_id,omitempty"`
	DeviceID string `json:"device_id,omitempty"`
}

// copyFS is the minimal filesystem surface a copy needs.
type copyFS interface {
	Stat(p string) (os.FileInfo, error)
	ReadDir(p string) ([]os.FileInfo, error)
	Open(p string) (io.ReadCloser, error)
	Create(p string, overwrite bool) (io.WriteCloser, error)
	MkdirAll(p string) error
	Label() string
	touch()
}

type sftpFS struct {
	c     *sftp.Client
	label string
	keep  func()
}

func (f *sftpFS) Stat(p string) (os.FileInfo, error)      { return f.c.Lstat(p) }
func (f *sftpFS) ReadDir(p string) ([]os.FileInfo, error) { return f.c.ReadDir(p) }
func (f *sftpFS) Open(p string) (io.ReadCloser, error)    { return f.c.Open(p) }
func (f *sftpFS) MkdirAll(p string) error                 { return f.c.MkdirAll(p) }
func (f *sftpFS) Label() string                           { return f.label }
func (f *sftpFS) touch()                                  { f.keep() }
func (f *sftpFS) Create(p string, overwrite bool) (io.WriteCloser, error) {
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if !overwrite {
		flags |= os.O_EXCL
	}
	return f.c.OpenFile(p, flags)
}

type driveFS struct {
	s        *Server
	deviceID string
	label    string
}

func (f *driveFS) Stat(p string) (os.FileInfo, error) {
	fi, _, err := f.s.drive.Stat(f.deviceID, p)
	return fi, err
}
func (f *driveFS) ReadDir(p string) ([]os.FileInfo, error) { return f.s.drive.ReadDir(f.deviceID, p) }
func (f *driveFS) Open(p string) (io.ReadCloser, error)    { return f.s.drive.Open(f.deviceID, p) }
func (f *driveFS) MkdirAll(p string) error                 { return f.s.drive.MkdirAll(f.deviceID, p) }
func (f *driveFS) Label() string                           { return f.label }
func (f *driveFS) touch()                                  {}
func (f *driveFS) Create(p string, overwrite bool) (io.WriteCloser, error) {
	return f.s.drive.Create(f.deviceID, p, overwrite)
}

// endpointKey identifies where files physically live (for "copy into itself" checks).
func (e endpointRef) key(s *Server) string {
	if e.Kind == "drive" {
		return "drive:" + e.DeviceID
	}
	if a := s.access.peek(e.AccessID); a != nil {
		return "ssh:" + a.connection.ID
	}
	return "ssh:" + e.AccessID
}

func (s *Server) openEndpoint(r *http.Request, e endpointRef) (copyFS, error) {
	sid := sessionFrom(r.Context()).ID
	switch e.Kind {
	case "ssh":
		a := s.access.get(e.AccessID, sid)
		if a == nil {
			return nil, errors.New("the file session expired; reopen the server and try again")
		}
		c, err := a.sftpClient()
		if err != nil {
			return nil, err
		}
		id := e.AccessID
		return &sftpFS{c: c, label: a.connection.DeviceName + " (SFTP)", keep: func() { s.access.get(id, sid) }}, nil
	case "drive":
		if s.drive == nil {
			return nil, errors.New("the transfer drive is not available")
		}
		u := userFrom(r.Context())
		visible, _, err := s.store.DeviceAccess(r.Context(), u.ID, e.DeviceID)
		if err != nil || !visible {
			return nil, errors.New("device not found")
		}
		d, err := s.getDevice(r.Context(), e.DeviceID)
		if err != nil {
			return nil, errors.New("device not found")
		}
		return &driveFS{s: s, deviceID: d.ID, label: d.Name + " (transfer drive)"}, nil
	}
	return nil, errors.New("unknown endpoint")
}

type CopyJob struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"` // scanning, copying, done, failed, cancelled
	Source      string     `json:"source"`
	Destination string     `json:"destination"`
	TargetDir   string     `json:"target_dir"`
	TotalFiles  int        `json:"total_files"`
	TotalBytes  int64      `json:"total_bytes"`
	DoneFiles   int        `json:"done_files"`
	DoneBytes   int64      `json:"done_bytes"`
	Skipped     int        `json:"skipped"`
	Current     string     `json:"current"`
	Error       string     `json:"error,omitempty"`
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`

	sessionID string
	cancel    context.CancelFunc
}

type copyRegistry struct {
	mu   sync.Mutex
	jobs map[string]*CopyJob
}

func newCopyRegistry() *copyRegistry { return &copyRegistry{jobs: map[string]*CopyJob{}} }

func (r *copyRegistry) snapshot(sessionID string) []CopyJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []CopyJob{}
	for _, j := range r.jobs {
		if j.sessionID == sessionID {
			out = append(out, *j)
		}
	}
	sort.Slice(out, func(i, k int) bool { return out[i].StartedAt.After(out[k].StartedAt) })
	return out
}

func (r *copyRegistry) update(j *CopyJob, f func(*CopyJob)) {
	r.mu.Lock()
	f(j)
	r.mu.Unlock()
}

// prune forgets finished jobs older than an hour.
func (r *copyRegistry) prune() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, j := range r.jobs {
		if j.FinishedAt != nil && time.Since(*j.FinishedAt) > time.Hour {
			delete(r.jobs, id)
		}
	}
}

func (r *copyRegistry) cancelSession(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, j := range r.jobs {
		if j.sessionID == sessionID && j.FinishedAt == nil {
			j.cancel()
		}
	}
}

type copyItem struct {
	src, dst string
	dir      bool
	size     int64
}

// plan walks the selected paths and lists every directory and file to copy.
// Symlinks are skipped (never followed), which also avoids loops.
func plan(ctx context.Context, src copyFS, paths []string, dstDir string) ([]copyItem, error) {
	var items []copyItem
	var walk func(sp, dp string, depth int) error
	walk = func(sp, dp string, depth int) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if depth > 64 {
			return fmt.Errorf("%s: folder nesting too deep", sp)
		}
		fi, err := src.Stat(sp)
		if err != nil {
			return fmt.Errorf("%s: %w", sp, err)
		}
		switch {
		case fi.Mode()&fs.ModeSymlink != 0:
			return nil
		case fi.IsDir():
			items = append(items, copyItem{src: sp, dst: dp, dir: true})
			children, err := src.ReadDir(sp)
			if err != nil {
				return fmt.Errorf("%s: %w", sp, err)
			}
			for _, c := range children {
				if c.Mode()&fs.ModeSymlink != 0 {
					continue
				}
				if err := walk(path.Join(sp, c.Name()), path.Join(dp, c.Name()), depth+1); err != nil {
					return err
				}
			}
		case fi.Mode().IsRegular():
			items = append(items, copyItem{src: sp, dst: dp, size: fi.Size()})
		}
		return nil
	}
	for _, p := range paths {
		if err := walk(p, path.Join(dstDir, path.Base(p)), 0); err != nil {
			return nil, err
		}
	}
	return items, nil
}

type countingReader struct {
	r   io.Reader
	ctx context.Context
	add func(int64)
}

func (c *countingReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := c.r.Read(p)
	if n > 0 {
		c.add(int64(n))
	}
	return n, err
}

func (s *Server) runCopy(ctx context.Context, r *http.Request, job *CopyJob, src, dst copyFS, paths []string, dir string, overwrite bool) {
	defer job.cancel()
	fail := func(err error) {
		now := time.Now()
		status := "failed"
		if errors.Is(err, context.Canceled) {
			status = "cancelled"
		}
		s.copies.update(job, func(j *CopyJob) {
			j.Status, j.Error, j.FinishedAt, j.Current = status, truncate(err.Error(), 300), &now, ""
		})
	}
	items, err := plan(ctx, src, paths, dir)
	if err != nil {
		fail(err)
		s.copyAudit(r, job, false)
		return
	}
	var total int64
	files := 0
	for _, it := range items {
		if !it.dir {
			total += it.size
			files++
		}
	}
	s.copies.update(job, func(j *CopyJob) { j.Status, j.TotalBytes, j.TotalFiles = "copying", total, files })

	for _, it := range items {
		src.touch()
		dst.touch()
		if it.dir {
			if err := dst.MkdirAll(it.dst); err != nil {
				fail(fmt.Errorf("create folder %s: %w", it.dst, err))
				s.copyAudit(r, job, false)
				return
			}
			continue
		}
		s.copies.update(job, func(j *CopyJob) { j.Current = it.src })
		if !overwrite {
			if _, err := dst.Stat(it.dst); err == nil {
				s.copies.update(job, func(j *CopyJob) { j.Skipped++; j.DoneBytes += it.size })
				continue
			}
		}
		// O_EXCL (when not overwriting) still guards against a file appearing meanwhile.
		w, err := dst.Create(it.dst, overwrite)
		if err != nil {
			fail(fmt.Errorf("create %s: %w", it.dst, err))
			s.copyAudit(r, job, false)
			return
		}
		rd, err := src.Open(it.src)
		if err != nil {
			w.Close()
			fail(fmt.Errorf("open %s: %w", it.src, err))
			s.copyAudit(r, job, false)
			return
		}
		_, err = io.Copy(w, &countingReader{r: rd, ctx: ctx, add: func(n int64) {
			s.copies.update(job, func(j *CopyJob) { j.DoneBytes += n })
		}})
		rd.Close()
		if cerr := w.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			fail(fmt.Errorf("copy %s: %w", it.src, err))
			s.copyAudit(r, job, false)
			return
		}
		s.copies.update(job, func(j *CopyJob) { j.DoneFiles++ })
	}
	now := time.Now()
	s.copies.update(job, func(j *CopyJob) { j.Status, j.FinishedAt, j.Current = "done", &now, "" })
	s.copyAudit(r, job, true)
}

func (s *Server) copyAudit(r *http.Request, job *CopyJob, ok bool) {
	var j CopyJob
	s.copies.update(job, func(x *CopyJob) { j = *x })
	s.audit(r, "file.copy", "transfer", j.ID, j.Source+" → "+j.Destination, ok, map[string]any{
		"source": j.Source, "destination": j.Destination, "target_dir": j.TargetDir, "status": j.Status,
		"files": j.DoneFiles, "bytes": j.DoneBytes, "skipped": j.Skipped, "error": j.Error,
	})
}

func (s *Server) handleStartCopy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Source      endpointRef `json:"source"`
		Destination endpointRef `json:"destination"`
		Paths       []string    `json:"paths"`
		Dir         string      `json:"dir"`
		OnConflict  string      `json:"on_conflict"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Paths) == 0 || len(req.Paths) > 500 {
		writeError(w, http.StatusBadRequest, "bad_request", "Select between 1 and 500 items")
		return
	}
	if req.OnConflict != "skip" && req.OnConflict != "overwrite" {
		writeError(w, http.StatusBadRequest, "bad_request", "on_conflict must be skip or overwrite")
		return
	}
	dir, err := sshhelper.CleanPath(req.Dir)
	if err != nil {
		remoteErr(w, err)
		return
	}
	paths := make([]string, 0, len(req.Paths))
	for _, p := range req.Paths {
		cp, err := sshhelper.CleanPath(p)
		if err != nil || cp == "/" {
			writeError(w, http.StatusBadRequest, "invalid_path", "Invalid source path")
			return
		}
		paths = append(paths, cp)
	}
	// Refuse copying a folder into itself (or onto itself) on the same server.
	if req.Source.key(s) == req.Destination.key(s) {
		for _, p := range paths {
			if dir == p || strings.HasPrefix(dir+"/", p+"/") || path.Dir(p) == dir {
				writeError(w, http.StatusBadRequest, "same_location", "Choose a different destination folder: "+p+" cannot be copied into itself or onto itself")
				return
			}
		}
	}
	src, err := s.openEndpoint(r, req.Source)
	if err != nil {
		writeError(w, http.StatusBadRequest, "source_unavailable", "Source: "+err.Error())
		return
	}
	dst, err := s.openEndpoint(r, req.Destination)
	if err != nil {
		writeError(w, http.StatusBadRequest, "destination_unavailable", "Destination: "+err.Error())
		return
	}
	if fi, err := dst.Stat(dir); err != nil || !fi.IsDir() {
		writeError(w, http.StatusBadRequest, "destination_unavailable", "The destination folder does not exist")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &CopyJob{
		ID: auth.RandomToken(9), Status: "scanning", Source: src.Label(), Destination: dst.Label(), TargetDir: dir,
		StartedAt: time.Now(), sessionID: sessionFrom(r.Context()).ID, cancel: cancel,
	}
	s.copies.mu.Lock()
	s.copies.jobs[job.ID] = job
	s.copies.mu.Unlock()
	// Detached request for audit attribution (user and IP) after this handler returns.
	bg := r.Clone(context.WithoutCancel(r.Context()))
	go func() {
		defer func() {
			if v := recover(); v != nil {
				slog.Error("copy job panic", "panic", v)
			}
		}()
		s.runCopy(ctx, bg, job, src, dst, paths, dir, req.OnConflict == "overwrite")
	}()
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleListCopies(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.copies.snapshot(sessionFrom(r.Context()).ID))
}

func (s *Server) handleCancelCopy(w http.ResponseWriter, r *http.Request) {
	sid := sessionFrom(r.Context()).ID
	s.copies.mu.Lock()
	j := s.copies.jobs[r.PathValue("id")]
	s.copies.mu.Unlock()
	if j == nil || j.sessionID != sid {
		writeError(w, http.StatusNotFound, "not_found", "Transfer not found")
		return
	}
	j.cancel()
	w.WriteHeader(http.StatusNoContent)
}
