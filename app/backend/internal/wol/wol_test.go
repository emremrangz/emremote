package wol

import (
	"bytes"
	"net/netip"
	"testing"
)

func TestParseMAC(t *testing.T) {
	for in, want := range map[string]string{"AA:BB:CC:DD:EE:FF": "aa:bb:cc:dd:ee:ff", "aa-bb-cc-dd-ee-ff": "aa:bb:cc:dd:ee:ff", "aabb.ccdd.eeff": "aa:bb:cc:dd:ee:ff", "001122334455": "00:11:22:33:44:55"} {
		got, err := ParseMAC(in)
		if err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "aa:bb", "zz:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff:00"} {
		if _, err := ParseMAC(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestPacket(t *testing.T) {
	p, err := Packet("aa:bb:cc:dd:ee:ff")
	if err != nil || len(p) != 102 || !bytes.Equal(p[:6], bytes.Repeat([]byte{0xff}, 6)) || !bytes.Equal(p[96:], []byte{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}) {
		t.Fatalf("bad packet len=%d err=%v", len(p), err)
	}
}

func TestBroadcast(t *testing.T) {
	b, ok := Broadcast(netip.MustParseAddr("192.168.1.77"))
	if !ok || b.String() != "192.168.1.255" {
		t.Errorf("got %v %v", b, ok)
	}
	if _, ok := Broadcast(netip.MustParseAddr("fd00::1")); ok {
		t.Error("IPv6 has no broadcast")
	}
}
