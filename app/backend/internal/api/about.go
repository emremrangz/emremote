package api

import (
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

var processStart = time.Now()

// aboutInfo is what the sign-in screen shows next to the logo. It is public, so it holds only
// coarse facts about the application and its container: no host name, kernel, CPU, memory or addresses.
type aboutInfo struct {
	Version      string `json:"version,omitempty"`
	Runtime      string `json:"runtime,omitempty"` // docker, podman or native
	OS           string `json:"os,omitempty"`
	Arch         string `json:"arch,omitempty"`
	Go           string `json:"go,omitempty"`
	UptimeS      int64  `json:"uptime_s,omitempty"`
	RememberDays int    `json:"remember_days"`
}

func containerRuntime() string {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker"
	}
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return "podman"
	}
	return "native"
}

// prettyOSName reads PRETTY_NAME from the contents of an os-release file.
func prettyOSName(osRelease string) string {
	for _, line := range strings.Split(osRelease, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "PRETTY_NAME="); ok {
			return truncate(strings.Trim(v, `"'`), 80)
		}
	}
	return ""
}

func (s *Server) handleAbout(w http.ResponseWriter, r *http.Request) {
	out := aboutInfo{RememberDays: int(s.limits().RememberTTL.Hours() / 24)}
	if s.cfg.LoginInfo {
		out.Version = s.version
		out.Runtime = containerRuntime()
		if b, err := os.ReadFile("/etc/os-release"); err == nil {
			out.OS = prettyOSName(string(b))
		}
		out.Arch = runtime.GOOS + "/" + runtime.GOARCH
		out.Go = runtime.Version()
		out.UptimeS = int64(time.Since(processStart).Seconds())
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}
