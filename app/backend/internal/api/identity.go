package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"time"

	"github.com/emremrangz/emremote/internal/rdpcert"
	"github.com/emremrangz/emremote/internal/sshkey"
	"github.com/emremrangz/emremote/internal/store"
)

// Server identities are pinned automatically the first time emremote connects
// (trust on first use, like OpenSSH's StrictHostKeyChecking=accept-new).
// Afterwards a changed host key or certificate is refused, which is what
// protects later connections from impersonation. Users can still review or
// replace a pin in the connection's Security settings.

// ensureIdentityPinned pins the SSH host key or RDP certificate of c if none is
// recorded yet, updating c in place. It never weakens an existing pin and does
// nothing for VNC (which has no server identity) or when the user explicitly
// chose to accept any RDP certificate.
func (s *Server) ensureIdentityPinned(r *http.Request, c *store.Connection, addr netip.Addr) {
	s.pinIdentity(r, c, addr, true, nil)
}

// pinIdentity records the identity in c.Settings and reports whether it did;
// persist also stores it on the saved connection. dial, when set, is how to
// reach the server (through a jump host); nil connects directly.
func (s *Server) pinIdentity(r *http.Request, c *store.Connection, addr netip.Addr, persist bool, dial func(ctx context.Context, network, address string) (net.Conn, error)) bool {
	if dial == nil {
		var d net.Dialer
		dial = d.DialContext
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var settings map[string]any
	if err := json.Unmarshal(c.Settings, &settings); err != nil {
		return false
	}
	details := map[string]any{"device_id": c.DeviceID, "method": "trust on first use"}
	switch c.Protocol {
	case "ssh":
		if hk, _ := settings["host_key"].(string); hk != "" {
			return false
		}
		key, err := sshkey.FetchVia(ctx, dial, addr, c.Port, settings["allow_legacy_algorithms"] == true)
		if err != nil {
			slog.Info("could not record SSH host key", "connection", c.ID, "error", err)
			return false
		}
		settings["host_key"] = key.Key
		details["fingerprint"] = key.Fingerprint
		details["key_type"] = key.Type
	case "rdp":
		fp, _ := settings["cert_fingerprints"].(string)
		ignore, _ := settings["ignore_cert"].(bool)
		security, _ := settings["security"].(string)
		if fp != "" || ignore || security == "rdp" || security == "vmconnect" {
			return false
		}
		cert, err := rdpcert.FetchVia(ctx, dial, addr, c.Port)
		if err != nil {
			if !errors.Is(err, rdpcert.ErrNoTLS) {
				slog.Info("could not record RDP certificate", "connection", c.ID, "error", err)
			}
			return false
		}
		settings["cert_fingerprints"] = cert.Fingerprint
		// Lock the security layer so the pin cannot be bypassed by a downgrade.
		if security == "any" || security == "" {
			settings["security"] = cert.Protocol
			if cert.Protocol == "rdp" {
				settings["security"] = "tls"
			}
		}
		details["fingerprint"] = cert.Fingerprint
		details["subject"] = cert.Subject
	default:
		return false
	}
	raw, _ := json.Marshal(settings)
	if persist {
		if err := s.store.UpdateConnectionSettings(r.Context(), c.ID, raw); err != nil {
			slog.Warn("store pinned identity", "connection", c.ID, "error", err)
			return false
		}
	}
	c.Settings = raw
	s.audit(r, "connection.identity_pinned", "connection", c.ID, c.DeviceName+" / "+c.Name, true, details)
	return true
}
