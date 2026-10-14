package api

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/emremrangz/emremote/internal/config"
)

func TestSameOrigin(t *testing.T) {
	cases := []struct {
		origin, host string
		upgrade      bool
		want         bool
	}{
		{"https://emremote.lan", "emremote.lan", false, true},
		{"https://evil.example", "emremote.lan", false, false},
		{"https://emremote.lan:8443", "emremote.lan", false, false},
		{"", "emremote.lan", false, true}, // non-browser client; CSRF token still required
		{"", "emremote.lan", true, false}, // browsers always send Origin on WebSocket
		{"null", "emremote.lan", false, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/x", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if c.upgrade {
			r.Header.Set("Upgrade", "websocket")
		}
		if got := sameOrigin(r); got != c.want {
			t.Errorf("origin=%q host=%q upgrade=%v: got %v", c.origin, c.host, c.upgrade, got)
		}
	}
}

func TestClientIPTrustsOnlyConfiguredProxies(t *testing.T) {
	s := &Server{cfg: &config.Config{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("172.31.250.0/24")}}}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "172.31.250.3:5555"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 192.168.1.20")
	if got := s.clientIP(r); got != "192.168.1.20" {
		t.Fatalf("via proxy: got %s", got)
	}
	r.RemoteAddr = "192.168.1.99:5555" // not a proxy: header must be ignored
	if got := s.clientIP(r); got != "192.168.1.99" {
		t.Fatalf("spoofed header honoured: got %s", got)
	}
}

func TestStaticHandlerBlocksTraversal(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("INDEX"), 0o644)
	s := &Server{cfg: &config.Config{WebDir: dir}}
	h := s.staticHandler()
	for _, p := range []string{"/../../etc/passwd", "/..%2f..%2fetc/passwd", "/devices/123"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code == http.StatusOK && rec.Body.String() != "INDEX" {
			t.Errorf("%s served unexpected content", p)
		}
	}
}
