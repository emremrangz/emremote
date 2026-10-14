// Package netpolicy validates device addresses and decides which resolved IPs
// emremote may connect to. It is the SSRF boundary: every outbound connection
// to a remote target (gateway sessions, reachability probes, certificate
// fetches) must go through Resolve.
package netpolicy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"time"
)

var (
	ErrInvalidAddress = errors.New("address must be a hostname or an IP address (no scheme, port or path)")
	ErrNotAllowed     = errors.New("target address is not in the allowed target networks")
)

var hostnameLabel = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

// ValidateAddress checks that s is a bare IP address or DNS hostname.
func ValidateAddress(s string) error {
	if s == "" || len(s) > 253 || strings.TrimSpace(s) != s {
		return ErrInvalidAddress
	}
	if addr, err := netip.ParseAddr(s); err == nil {
		if addr.Zone() != "" {
			return ErrInvalidAddress
		}
		return nil
	}
	labels := strings.Split(strings.TrimSuffix(s, "."), ".")
	for _, l := range labels {
		if !hostnameLabel.MatchString(l) {
			return ErrInvalidAddress
		}
	}
	// A purely numeric last label would be an (invalid) IP, not a hostname.
	if strings.Trim(labels[len(labels)-1], "0123456789") == "" {
		return ErrInvalidAddress
	}
	return nil
}

type Policy struct {
	allowed  []netip.Prefix
	denied   []netip.Prefix
	resolver *net.Resolver
}

func New(allowed, denied []netip.Prefix) *Policy {
	return &Policy{allowed: allowed, denied: denied, resolver: net.DefaultResolver}
}

// DenyLocalInterfaces adds every network attached to this host/container to the
// deny list, so targets can never point at emremote's own container networks
// (database, gateway, reverse proxy).
func (p *Policy) DenyLocalInterfaces() error {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return err
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		pfx, err := netip.ParsePrefix(ipn.String())
		if err != nil {
			continue
		}
		pfx = pfx.Masked()
		if pfx.Addr().Is4() || !pfx.Addr().IsLinkLocalUnicast() {
			p.denied = append(p.denied, pfx)
		}
	}
	return nil
}

func (p *Policy) Allowed() []netip.Prefix { return slices.Clone(p.allowed) }
func (p *Policy) Denied() []netip.Prefix  { return slices.Clone(p.denied) }

// Check reports whether a single IP may be used as a target.
func (p *Policy) Check(addr netip.Addr) error { return p.checkIn(addr, p.allowed) }

// CheckBehindJump is Check for a target that is only reachable through a jump
// host: it must lie in one of the jump target networks instead of the usual
// allowed networks, and the reserved and denied ranges still apply.
func (p *Policy) CheckBehindJump(addr netip.Addr, networks []netip.Prefix) error {
	return p.checkIn(addr, networks)
}

func (p *Policy) checkIn(addr netip.Addr, allowed []netip.Prefix) error {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsUnspecified() || addr.IsLoopback() || addr.IsMulticast() ||
		addr.IsInterfaceLocalMulticast() || addr.IsLinkLocalMulticast() || addr == netip.MustParseAddr("255.255.255.255") {
		return fmt.Errorf("%w: %s is a reserved address", ErrNotAllowed, addr)
	}
	for _, d := range p.denied {
		if d.Contains(addr) {
			return fmt.Errorf("%w: %s is in a denied network (%s)", ErrNotAllowed, addr, d)
		}
	}
	for _, a := range allowed {
		if a.Contains(addr) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrNotAllowed, addr)
}

// Resolve validates host, resolves it and returns one permitted IP (IPv4
// preferred). Callers must connect to the returned IP rather than re-resolving
// the hostname, which prevents DNS-rebinding between check and use.
func (p *Policy) Resolve(ctx context.Context, host string) (netip.Addr, error) {
	if err := ValidateAddress(host); err != nil {
		return netip.Addr{}, err
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.Unmap(), p.Check(addr)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := p.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("could not resolve %s: %w", host, err)
	}
	slices.SortStableFunc(addrs, func(a, b netip.Addr) int {
		switch {
		case a.Unmap().Is4() && !b.Unmap().Is4():
			return -1
		case !a.Unmap().Is4() && b.Unmap().Is4():
			return 1
		}
		return 0
	})
	var firstErr error
	for _, a := range addrs {
		if err := p.Check(a); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		return a.Unmap(), nil
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("%s did not resolve to any address", host)
	}
	return netip.Addr{}, firstErr
}
