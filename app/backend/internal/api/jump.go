package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/emremrangz/emremote/internal/jump"
	"github.com/emremrangz/emremote/internal/netpolicy"
	"github.com/emremrangz/emremote/internal/sshhelper"
	"github.com/emremrangz/emremote/internal/store"
)

// ---- Jump hosts ----
//
// A connection can name another SSH connection (a "bastion") to be reached
// through. The feature is off unless EMREMOTE_JUMP_TARGET_NETWORKS lists the
// networks that lie behind bastions. Such targets must be given as IP
// addresses inside those networks (never loopback, link-local or denied
// ranges), the bastion itself must be an ordinary allowed target, and the
// bastion's host key is pinned like any other SSH server's.

func (s *Server) jumpEnabled() bool { return len(s.jumpNets()) > 0 }

// jumpNets returns the networks behind jump hosts: what an administrator saved in
// Settings, or EMREMOTE_JUMP_TARGET_NETWORKS until then.
func (s *Server) jumpNets() []netip.Prefix {
	if p := s.jumpNetworks.Load(); p != nil {
		return *p
	}
	return s.cfg.JumpTargetNetworks
}

const jumpSettingKey = "jump_target_networks"

// LoadSettings reads the settings saved in the web interface.
func (s *Server) LoadSettings(ctx context.Context) {
	if raw, ok, err := s.store.GetSetting(ctx, sessionLimitsKey); err == nil && ok {
		s.loadSessionLimits(raw)
	}
	if raw, ok, err := s.store.GetSetting(ctx, targetNetworksKey); err == nil && ok {
		s.applyTargetNetworks(raw)
	}
	raw, ok, err := s.store.GetSetting(ctx, jumpSettingKey)
	if err != nil || !ok {
		return
	}
	var strs []string
	if json.Unmarshal(raw, &strs) != nil {
		return
	}
	nets := []netip.Prefix{}
	for _, x := range strs {
		if p, err := netip.ParsePrefix(x); err == nil {
			nets = append(nets, p.Masked())
		}
	}
	s.jumpNetworks.Store(&nets)
}

func prefixStrings(ps []netip.Prefix) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.String()
	}
	return out
}

// handleGetJumpSettings shows the networks behind jump hosts (administrators only).
func (s *Server) handleGetJumpSettings(w http.ResponseWriter, r *http.Request) {
	_, saved, _ := s.store.GetSetting(r.Context(), jumpSettingKey)
	writeJSON(w, http.StatusOK, map[string]any{"networks": prefixStrings(s.jumpNets()), "saved": saved, "env": prefixStrings(s.cfg.JumpTargetNetworks)})
}

// handleSetJumpSettings saves them. An empty list turns jump hosts off.
func (s *Server) handleSetJumpSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Networks []string `json:"networks"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	nets := []netip.Prefix{}
	seen := map[string]bool{}
	if len(req.Networks) > 32 {
		v.fail("networks", "At most 32 networks")
	}
	for _, x := range req.Networks {
		x = strings.TrimSpace(x)
		if x == "" {
			continue
		}
		p, err := netip.ParsePrefix(x)
		if err != nil {
			v.fail("networks", "\""+truncate(x, 40)+"\" is not a network like 192.168.50.0/24")
			continue
		}
		p = p.Masked()
		a := p.Addr()
		switch {
		case a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsMulticast() || a.IsUnspecified():
			v.fail("networks", p.String()+" is a reserved range and can never be a target")
		case a.Is4() && p.Bits() < 8, a.Is6() && p.Bits() < 32:
			v.fail("networks", p.String()+" is too wide; use the actual network behind the jump host")
		default:
			if !seen[p.String()] {
				seen[p.String()] = true
				nets = append(nets, p)
			}
		}
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	raw, _ := json.Marshal(prefixStrings(nets))
	if err := s.store.SetSetting(r.Context(), jumpSettingKey, raw); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.jumpNetworks.Store(&nets)
	s.audit(r, "settings.jump", "settings", "", "Jump host networks", true, map[string]any{"networks": prefixStrings(nets)})
	writeJSON(w, http.StatusOK, map[string]any{"networks": prefixStrings(nets), "saved": true})
}

// jumpIDOf returns the jump_connection_id stored in connection settings.
func jumpIDOf(settings json.RawMessage) string {
	var m struct {
		ID string `json:"jump_connection_id"`
	}
	_ = json.Unmarshal(settings, &m)
	return m.ID
}

// validateJump checks the jump host chosen for a connection that is being saved.
// owner is the device's owner; selfID is the connection's own id ("" for a new one).
func (s *Server) validateJump(ctx context.Context, v *validator, settings json.RawMessage, owner *string, selfID, deviceAddr string) {
	id := jumpIDOf(settings)
	if id == "" {
		return
	}
	const field = "settings.jump_connection_id"
	if !s.jumpEnabled() {
		v.fail(field, "Jump hosts are turned off. An administrator can turn them on in Settings.")
		return
	}
	if id == selfID {
		v.fail(field, "A connection cannot be its own jump host")
		return
	}
	b, err := s.store.GetConnection(ctx, id)
	if err != nil || !sameOwner(b.DeviceOwnerID, owner) {
		v.fail(field, "Jump host does not exist")
		return
	}
	if b.Protocol != "ssh" {
		v.fail(field, "A jump host must be an SSH connection")
		return
	}
	if jumpIDOf(b.Settings) != "" {
		v.fail(field, "The jump host cannot itself use a jump host")
		return
	}
	addr, err := netip.ParseAddr(deviceAddr)
	if err != nil {
		v.fail(field, "Devices behind a jump host need an IP address (not a hostname)")
		return
	}
	if err := s.policy.CheckBehindJump(addr, s.jumpNets()); err != nil {
		v.fail(field, "This address is not in a network reachable through jump hosts ("+addrList(s.jumpNets())+")")
	}
}

func addrList(ps []netip.Prefix) string {
	out := ""
	for i, p := range ps {
		if i > 0 {
			out += ", "
		}
		out += p.String()
	}
	return out
}

// resolvedTarget is where to connect for a connection: directly, or through a bastion.
type resolvedTarget struct {
	Addr netip.Addr
	Port int
	// Via is a logged-in bastion client; the caller owns it and must close it.
	Via *ssh.Client
}

// prepareTarget applies the network policy, reaches the target (through its jump
// host if it has one) and records its identity on first use. On failure it has
// already written the response.
func (s *Server) prepareTarget(w http.ResponseWriter, r *http.Request, c *store.Connection) (*resolvedTarget, bool) {
	if jumpIDOf(c.Settings) == "" {
		ok, addr := s.resolveTarget(w, r, c)
		if !ok {
			return nil, false
		}
		s.ensureIdentityPinned(r, c, addr)
		return &resolvedTarget{Addr: addr, Port: c.Port}, true
	}
	via, addr, err := s.dialBastion(r.Context(), r, c)
	if err != nil {
		status, code, msg := http.StatusBadGateway, "jump_failed", "Could not reach the jump host: "+err.Error()
		switch {
		case errors.Is(err, errJumpDisabled):
			status, code, msg = http.StatusUnprocessableEntity, "jump_disabled", err.Error()
		case errors.Is(err, netpolicy.ErrNotAllowed):
			status, code, msg = http.StatusUnprocessableEntity, "target_not_allowed", err.Error()
		case errors.Is(err, sshhelper.ErrHostKeyMismatch):
			msg = "The jump host's key has changed since it was first used. If it was reinstalled, accept the new key in its connection's security settings."
		case errors.Is(err, sshhelper.ErrAuthenticationBad):
			msg = "Signing in to the jump host failed. Check the username and password saved on the jump host's connection."
		case errors.Is(err, sshhelper.ErrNoCredentials):
			msg = "The jump host needs a saved username and password (it cannot be asked for them)."
		}
		writeError(w, status, code, msg)
		return nil, false
	}
	// Try the forwarded connection once so a refusal is explained now, not as a
	// mysterious gateway error later.
	probe, err := via.Dial("tcp", net.JoinHostPort(addr.String(), strconv.Itoa(c.Port)))
	if err != nil {
		via.Close()
		msg := "The jump host could not open a connection to " + net.JoinHostPort(addr.String(), strconv.Itoa(c.Port)) + ": " + err.Error()
		var oe *ssh.OpenChannelError
		if errors.As(err, &oe) {
			if oe.Reason == ssh.Prohibited {
				msg = "The jump host refused to forward the connection. Its SSH server must allow TCP forwarding (AllowTcpForwarding yes in sshd_config)."
			} else {
				msg = "The jump host could not connect to " + net.JoinHostPort(addr.String(), strconv.Itoa(c.Port)) + ". Check that the device is on and the port is right."
			}
		}
		writeError(w, http.StatusBadGateway, "jump_failed", msg)
		return nil, false
	}
	probe.Close()
	// First use: record the target's identity, looking at it through the bastion.
	dial := func(_ context.Context, network, address string) (net.Conn, error) { return via.Dial(network, address) }
	s.pinIdentity(r, c, addr, true, dial)
	return &resolvedTarget{Addr: addr, Port: c.Port, Via: via}, true
}

var errJumpDisabled = errors.New("jump hosts are turned off on this server")

// dialBastion logs in to the jump host of c and checks that c's own address may
// be reached through it. It returns the bastion client and c's address.
func (s *Server) dialBastion(ctx context.Context, r *http.Request, c *store.Connection) (*ssh.Client, netip.Addr, error) {
	var zero netip.Addr
	if !s.jumpEnabled() {
		return nil, zero, errJumpDisabled
	}
	target, err := netip.ParseAddr(c.DeviceAddress)
	if err != nil {
		return nil, zero, errors.New("a device behind a jump host needs an IP address")
	}
	if err := s.policy.CheckBehindJump(target, s.jumpNets()); err != nil {
		return nil, zero, err
	}
	b, err := s.store.GetConnection(ctx, jumpIDOf(c.Settings))
	if err != nil || b.Protocol != "ssh" || !sameOwner(b.DeviceOwnerID, c.DeviceOwnerID) {
		return nil, zero, errors.New("the jump host no longer exists")
	}
	if jumpIDOf(b.Settings) != "" {
		return nil, zero, errors.New("the jump host cannot itself use a jump host")
	}
	baddr, err := s.policy.Resolve(ctx, b.DeviceAddress)
	if err != nil {
		return nil, zero, err
	}
	s.ensureIdentityPinned(r, b, baddr)
	var bs SSHSettings
	_ = decodeSettings(b.Settings, &bs)
	if bs.HostKey == "" {
		return nil, zero, errors.New("could not read the jump host's key; check that its SSH server is on")
	}
	user, material, err := s.connectionCredentials(ctx, b)
	if err != nil {
		return nil, zero, err
	}
	client, err := sshhelper.Dial(ctx, sshhelper.Target{Addr: baddr, Port: b.Port, Username: user, Secret: material, HostKey: bs.HostKey, Legacy: bs.AllowLegacyAlgorithms})
	if err != nil {
		return nil, zero, err
	}
	return client, target, nil
}

// startForwarder exposes a bastion-reachable target to the gateway. The
// forwarder takes over closing via.
func (s *Server) startForwarder(t *resolvedTarget) (*jump.Forwarder, error) {
	bind, peers, err := jump.Facing(s.cfg.GuacdAddr)
	if err != nil {
		return nil, err
	}
	return jump.Listen(t.Via, jump.HostPort(t.Addr.String(), t.Port), bind, peers)
}

// jumpUsers counts the connections that use connection id as their jump host.
func (s *Server) jumpUsers(ctx context.Context, id string) int {
	n, _ := s.store.CountJumpUsers(ctx, id)
	return n
}

// jumpUsersAllOn reports whether every user of connection id lives on deviceID itself
// (deleting the device then removes them too).
func (s *Server) jumpUsersAllOn(ctx context.Context, id, deviceID string) bool {
	n, err := s.store.CountJumpUsersOutside(ctx, id, deviceID)
	return err == nil && n == 0
}
