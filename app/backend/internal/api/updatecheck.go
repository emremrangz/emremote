package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// releaseURL is fixed on purpose: the check never takes an address from user input.
const (
	releaseURL = "https://api.github.com/repos/emremrangz/emremote/releases/latest"
	repoURL    = "https://api.github.com/repos/emremrangz/emremote"
)

// latestRelease is the newest published version, refreshed in the background.
type latestRelease struct {
	mu      sync.RWMutex
	version string
	url     string
}

func (l *latestRelease) get() (string, string) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.version, l.url
}

func (l *latestRelease) set(v, u string) {
	l.mu.Lock()
	l.version, l.url = v, u
	l.mu.Unlock()
}

// updateLoop asks GitHub for the latest release now and then every hour.
// Failures (no internet, rate limit) are ignored: the interface then shows no update notice.
func (s *Server) updateLoop(ctx context.Context) {
	if !s.cfg.UpdateCheck {
		return
	}
	get := func(url string, out any) bool {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
		if err != nil {
			return false
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "emremote/"+s.version)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			slog.Debug("update check failed", "error", err)
			return false
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			slog.Debug("update check failed", "status", resp.StatusCode)
			return false
		}
		return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out) == nil
	}
	check := func() bool {
		ok := true
		var repo struct {
			Stars int `json:"stargazers_count"`
		}
		if get(repoURL, &repo) && repo.Stars >= 0 {
			s.stars.Store(int64(repo.Stars))
		} else {
			ok = false
		}
		var rel struct {
			Tag   string `json:"tag_name"`
			URL   string `json:"html_url"`
			Draft bool   `json:"draft"`
			Pre   bool   `json:"prerelease"`
		}
		if !get(releaseURL, &rel) {
			return false
		}
		if rel.Draft || rel.Pre {
			return ok
		}
		v := strings.TrimPrefix(rel.Tag, "v")
		if _, valid := parseSemver(v); !valid || !strings.HasPrefix(rel.URL, "https://github.com/emremrangz/emremote/") {
			return ok
		}
		s.latest.set(v, rel.URL)
		return ok
	}
	// After a failure (no internet, GitHub's rate limit) try again soon instead of waiting half a day.
	next := func(ok bool) time.Duration {
		if ok {
			return time.Hour
		}
		return 10 * time.Minute
	}
	timer := time.NewTimer(next(check()))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			timer.Reset(next(check()))
		}
	}
}

func parseSemver(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// isNewer reports whether latest is a higher version than current.
func isNewer(latest, current string) bool {
	l, ok1 := parseSemver(latest)
	c, ok2 := parseSemver(current)
	if !ok1 || !ok2 {
		return false
	}
	for i := range l {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}
