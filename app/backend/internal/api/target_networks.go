package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
)

// The networks emremote may connect to can be changed by an administrator in Settings; what is saved replaces
// EMREMOTE_ALLOWED_TARGET_NETWORKS (the application cannot write the .env file, so the setting lives in the database).
// The reserved addresses (loopback, link-local such as the cloud metadata service, multicast) and emremote's own
// networks stay refused however wide the list is.
const targetNetworksKey = "allowed_target_networks"

// parseTargetNetworks reads one network or address per entry. A single address means just that address, and
// 0.0.0.0 or :: mean every IPv4 or IPv6 address.
func parseTargetNetworks(in []string) ([]netip.Prefix, error) {
	if len(in) > 64 {
		return nil, fmt.Errorf("at most 64 entries")
	}
	var out []netip.Prefix
	seen := map[netip.Prefix]bool{}
	for _, raw := range in {
		x := strings.TrimSpace(raw)
		if x == "" {
			continue
		}
		var p netip.Prefix
		if pp, err := netip.ParsePrefix(x); err == nil {
			p = pp.Masked()
		} else if a, err := netip.ParseAddr(x); err == nil && a.Zone() == "" {
			a = a.Unmap()
			switch {
			case a.IsUnspecified() && a.Is4():
				p = netip.MustParsePrefix("0.0.0.0/0")
			case a.IsUnspecified():
				p = netip.MustParsePrefix("::/0")
			default:
				p = netip.PrefixFrom(a, a.BitLen())
			}
		} else {
			return nil, fmt.Errorf("%q is not an address or a network like 192.168.1.0/24", truncate(x, 40))
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("add at least one network, or use \"Use the default\" to go back to the environment setting")
	}
	return out, nil
}

func targetsEverywhere(ps []netip.Prefix) bool {
	for _, p := range ps {
		if p.Bits() == 0 {
			return true
		}
	}
	return false
}

func (s *Server) applyTargetNetworks(raw []byte) {
	var strs []string
	if json.Unmarshal(raw, &strs) != nil {
		return
	}
	if nets, err := parseTargetNetworks(strs); err == nil {
		s.policy.SetAllowed(nets)
	}
}

func (s *Server) targetNetworksReply(w http.ResponseWriter, r *http.Request) {
	cur := s.policy.Allowed()
	_, saved, _ := s.store.GetSetting(r.Context(), targetNetworksKey)
	writeJSON(w, http.StatusOK, map[string]any{
		"networks":   prefixStrings(cur),
		"saved":      saved,
		"env":        prefixStrings(s.cfg.AllowedTargetNetworks),
		"everywhere": targetsEverywhere(cur),
	})
}

func (s *Server) handleGetTargetNetworks(w http.ResponseWriter, r *http.Request) {
	s.targetNetworksReply(w, r)
}

func (s *Server) handleSetTargetNetworks(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Networks []string `json:"networks"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	nets, err := parseTargetNetworks(req.Networks)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "validation_failed", "Allowed networks: "+err.Error())
		return
	}
	raw, _ := json.Marshal(prefixStrings(nets))
	if err := s.store.SetSetting(r.Context(), targetNetworksKey, raw); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.policy.SetAllowed(nets)
	s.audit(r, "settings.targets", "settings", "", "Allowed target networks", true, map[string]any{"networks": prefixStrings(nets), "everywhere": targetsEverywhere(nets)})
	s.targetNetworksReply(w, r)
}

// handleResetTargetNetworks goes back to the environment setting.
func (s *Server) handleResetTargetNetworks(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteSetting(r.Context(), targetNetworksKey); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.policy.SetAllowed(s.cfg.AllowedTargetNetworks)
	s.audit(r, "settings.targets", "settings", "", "Allowed target networks", true, map[string]any{"reset": true})
	s.targetNetworksReply(w, r)
}
