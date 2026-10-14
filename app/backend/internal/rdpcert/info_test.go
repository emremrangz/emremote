package rdpcert

import (
	"bytes"
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

func u16(s string) []byte {
	var b bytes.Buffer
	for _, c := range utf16.Encode([]rune(s)) {
		_ = binary.Write(&b, binary.LittleEndian, c)
	}
	return b.Bytes()
}

func av(id uint16, v []byte) []byte {
	h := make([]byte, 4)
	binary.LittleEndian.PutUint16(h, id)
	binary.LittleEndian.PutUint16(h[2:], uint16(len(v)))
	return append(h, v...)
}

func TestParseChallenge(t *testing.T) {
	ti := append(av(1, u16("DC01")), av(2, u16("HOME"))...)
	ti = append(ti, av(3, u16("dc01.home.local"))...)
	ti = append(ti, av(0, nil)...)
	m := make([]byte, 56)
	copy(m, "NTLMSSP\x00\x02\x00\x00\x00")
	binary.LittleEndian.PutUint16(m[40:], uint16(len(ti)))
	binary.LittleEndian.PutUint32(m[44:], 56)
	m[48], m[49] = 10, 0
	binary.LittleEndian.PutUint16(m[50:], 20348)
	m = append(m, ti...)
	data := append([]byte{0x30, 0x82, 0x01, 0x00, 0xa1}, m...) // wrapped in some CredSSP bytes
	if parseChallenge(data[:len(data)-6]) != nil {
		t.Error("a truncated challenge must wait for more data")
	}
	info := parseChallenge(data)
	if info == nil || info.ComputerName != "DC01" || info.Domain != "HOME" || info.DNSName != "dc01.home.local" || info.Build != 20348 {
		t.Fatalf("got %+v", info)
	}
	if info.OS != "Windows Server 2022 (10.0.20348)" {
		t.Errorf("os = %q", info.OS)
	}
}

func TestTSRequestShape(t *testing.T) {
	r := tsRequest(ntlmNegotiate())
	if r[0] != 0x30 || !bytes.Contains(r, []byte("NTLMSSP\x00\x01\x00\x00\x00")) {
		t.Fatalf("unexpected TSRequest % x", r[:16])
	}
	if int(r[1]) != len(r)-2 && r[1] != 0x81 && r[1] != 0x82 {
		t.Errorf("bad length byte %d for %d bytes", r[1], len(r))
	}
}

func TestWindowsName(t *testing.T) {
	for _, c := range []struct {
		a, b, c int
		want    string
	}{
		{10, 0, 22631, "Windows 11 23H2 (10.0.22631)"},
		{6, 1, 7601, "Windows 7 / Server 2008 R2 (6.1.7601)"},
		{10, 0, 17763, "Windows 10 1809 / Server 2019 (10.0.17763)"},
	} {
		if got := WindowsName(c.a, c.b, c.c); got != c.want {
			t.Errorf("got %q want %q", got, c.want)
		}
	}
}
