package api

import (
	"context"
	"encoding/json"
	"github.com/emremrangz/emremote/internal/rdpcert"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/emremrangz/emremote/internal/sshhelper"
)

// rememberFacts stores what a system inspection learned on the device record,
// so the device page can show it without opening a session.
func (s *Server) rememberFacts(ctx context.Context, deviceID string, info *sshhelper.SystemInfo) {
	facts, _ := json.Marshal(map[string]any{
		"platform":       info.Platform,
		"os":             info.OS,
		"kernel":         info.Kernel,
		"arch":           info.Arch,
		"hostname":       info.Hostname,
		"cpu_model":      info.CPU.Model,
		"cpu_cores":      info.CPU.Cores,
		"memory_bytes":   info.Memory.TotalBytes,
		"uptime_s":       info.UptimeSeconds,
		"mac":            info.MAC,
		"vendor":         info.Vendor,
		"model":          info.Model,
		"serial":         info.Serial,
		"virtualization": info.Virtualization,
		"collected_at":   time.Now().UTC().Format(time.RFC3339),
	})
	host := strings.ToLower(strings.TrimSpace(info.Hostname))
	if len(host) > 253 || strings.ContainsAny(host, " /\\:") {
		host = ""
	}
	if err := s.store.SetDeviceFacts(ctx, deviceID, facts, info.Platform, host, info.MAC); err != nil {
		slog.Warn("could not save device facts", "device", deviceID, "error", err)
	}
}

// handleProbeRDP learns the Windows version and computer name of a device that
// only has RDP, from the sign-in negotiation (no credentials involved). It
// never overwrites facts that came from a fuller SSH inspection.
func (s *Server) handleProbeRDP(w http.ResponseWriter, r *http.Request) {
	d, err := s.getDevice(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	var existing struct {
		Kernel string `json:"kernel"`
	}
	_ = json.Unmarshal(d.Facts, &existing)
	if existing.Kernel != "" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "skipped"})
		return
	}
	conns, err := s.store.ListConnections(r.Context(), userFrom(r.Context()).ID, d.ID)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	port := 0
	for _, c := range conns {
		if c.Protocol == "rdp" && jumpIDOf(c.Settings) == "" {
			port = c.Port
			break
		}
	}
	if port == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"status": "skipped"})
		return
	}
	addr, err := s.policy.Resolve(r.Context(), d.Address)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "target_not_allowed", err.Error())
		return
	}
	var dialer net.Dialer
	info, err := rdpcert.Info(r.Context(), dialer.DialContext, addr, port)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "unavailable", "reason": err.Error()})
		return
	}
	facts, _ := json.Marshal(map[string]any{
		"platform": "windows", "os": info.OS, "hostname": info.ComputerName, "domain": info.Domain, "source": "rdp",
		"collected_at": time.Now().UTC().Format(time.RFC3339),
	})
	host := strings.ToLower(strings.TrimSpace(info.ComputerName))
	if err := s.store.SetDeviceFacts(r.Context(), d.ID, facts, "windows", host, ""); err != nil {
		slog.Warn("could not save device facts", "device", d.ID, "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
