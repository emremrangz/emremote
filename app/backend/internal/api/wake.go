package api

import (
	"net/http"
	"net/netip"
	"sync"
	"time"

	"github.com/emremrangz/emremote/internal/wol"
)

var (
	wakeMu   sync.Mutex
	wakeLast = map[string]time.Time{}
)

// handleWakeDevice sends a Wake-on-LAN magic packet to the device. The packet
// goes only to addresses inside the allowed target networks: the device's own
// address and the broadcast address of its network.
func (s *Server) handleWakeDevice(w http.ResponseWriter, r *http.Request) {
	d, err := s.getDevice(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	if d.MAC == "" {
		writeError(w, http.StatusUnprocessableEntity, "no_mac", "Add the device's MAC address first (Edit device). It is filled in automatically after emremote has connected over SSH once.")
		return
	}
	wakeMu.Lock()
	if t, ok := wakeLast[d.ID]; ok && time.Since(t) < 5*time.Second {
		wakeMu.Unlock()
		writeError(w, http.StatusTooManyRequests, "too_fast", "A wake-up packet was just sent. Give the device a moment.")
		return
	}
	wakeLast[d.ID] = time.Now()
	wakeMu.Unlock()

	addr, err := s.policy.Resolve(r.Context(), d.Address)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "target_not_allowed", err.Error())
		return
	}
	dests := []netip.Addr{addr}
	bc, ok := netip.Addr{}, false
	if d.WOLBroadcast != "" {
		if a, err := netip.ParseAddr(d.WOLBroadcast); err == nil {
			bc, ok = a, true
		}
	} else {
		bc, ok = wol.Broadcast(addr)
	}
	if ok {
		if err := s.policy.Check(bc); err == nil {
			dests = append(dests, bc)
		}
	}
	n, err := wol.Send(d.MAC, dests)
	if err != nil || n == 0 {
		s.audit(r, "device.wake", "device", d.ID, d.Name, false, map[string]any{"mac": d.MAC})
		writeError(w, http.StatusBadGateway, "wake_failed", "Could not send the wake-up packet from this server.")
		return
	}
	s.audit(r, "device.wake", "device", d.ID, d.Name, true, map[string]any{"mac": d.MAC, "sent_to": len(dests)})
	writeJSON(w, http.StatusOK, map[string]any{"sent": n})
}
