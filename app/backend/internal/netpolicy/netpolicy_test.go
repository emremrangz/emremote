package netpolicy

import (
	"context"
	"net/netip"
	"testing"
)

func TestValidateAddress(t *testing.T) {
	good := []string{"192.168.1.10", "fd00::1", "pc-01", "pc-01.lan", "nas.home.arpa", "FILESERVER"}
	bad := []string{"", " 10.0.0.1", "http://10.0.0.1", "10.0.0.1:3389", "host/path", "a..b", "-bad.lan",
		"fe80::1%eth0", "1.2.3", "host name", "evil.com\n"}
	for _, s := range good {
		if err := ValidateAddress(s); err != nil {
			t.Errorf("%q should be valid: %v", s, err)
		}
	}
	for _, s := range bad {
		if err := ValidateAddress(s); err == nil {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestPolicyCheck(t *testing.T) {
	p := New(
		[]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("192.168.0.0/16")},
		[]netip.Prefix{netip.MustParsePrefix("10.99.0.0/16")},
	)
	allowed := []string{"10.1.2.3", "192.168.1.1", "::ffff:10.1.2.3"}
	denied := []string{"127.0.0.1", "0.0.0.0", "169.254.169.254", "8.8.8.8", "10.99.1.1", "224.0.0.1", "::1", "172.17.0.2"}
	for _, s := range allowed {
		if err := p.Check(netip.MustParseAddr(s)); err != nil {
			t.Errorf("%s should be allowed: %v", s, err)
		}
	}
	for _, s := range denied {
		if err := p.Check(netip.MustParseAddr(s)); err == nil {
			t.Errorf("%s should be denied", s)
		}
	}
}

func TestResolveLiteralAndLocalhost(t *testing.T) {
	p := New([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}, nil)
	if a, err := p.Resolve(context.Background(), "10.0.0.5"); err != nil || a.String() != "10.0.0.5" {
		t.Fatalf("literal: %v %v", a, err)
	}
	if _, err := p.Resolve(context.Background(), "localhost"); err == nil {
		t.Fatal("localhost must never be allowed")
	}
}

func TestCheckBehindJump(t *testing.T) {
	p := New([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}, []netip.Prefix{netip.MustParsePrefix("172.29.99.0/24")})
	behind := []netip.Prefix{netip.MustParsePrefix("172.29.0.0/16")}
	for addr, ok := range map[string]bool{
		"172.29.77.10":    true,  // behind the bastion
		"172.29.99.5":     false, // explicitly denied
		"10.1.2.3":        false, // reachable directly, not a jump target network
		"127.0.0.1":       false, // loopback is never a target
		"169.254.169.254": false,
	} {
		err := p.CheckBehindJump(netip.MustParseAddr(addr), behind)
		if (err == nil) != ok {
			t.Errorf("%s: err=%v want ok=%v", addr, err, ok)
		}
	}
	if p.Check(netip.MustParseAddr("172.29.77.10")) == nil {
		t.Error("jump target networks must not widen the normal allow-list")
	}
	if p.CheckBehindJump(netip.MustParseAddr("172.29.77.10"), nil) == nil {
		t.Error("an empty list allows nothing")
	}
}
