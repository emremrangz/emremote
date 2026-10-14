package rdpcert

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"
	"unicode/utf16"
)

// ServerInfo is what a Windows RDP server tells anyone who starts a network
// level authentication (NLA) sign-in: the first NTLM reply names the computer
// and carries the Windows build. No credentials are sent.
type ServerInfo struct {
	ComputerName string `json:"computer_name"`
	Domain       string `json:"domain"`
	DNSName      string `json:"dns_name"`
	Major        int    `json:"major"`
	Minor        int    `json:"minor"`
	Build        int    `json:"build"`
	OS           string `json:"os"`
}

var errNoNTLM = errors.New("the server did not answer the sign-in negotiation (NLA is off, or it is not Windows)")

func der(tag byte, content []byte) []byte {
	n := len(content)
	var l []byte
	switch {
	case n < 0x80:
		l = []byte{byte(n)}
	case n < 0x100:
		l = []byte{0x81, byte(n)}
	default:
		l = []byte{0x82, byte(n >> 8), byte(n)}
	}
	out := append([]byte{tag}, l...)
	return append(out, content...)
}

// ntlmNegotiate is an NTLM NEGOTIATE message (type 1) without domain or workstation.
func ntlmNegotiate() []byte {
	m := make([]byte, 40)
	copy(m, "NTLMSSP\x00")
	binary.LittleEndian.PutUint32(m[8:], 1)
	binary.LittleEndian.PutUint32(m[12:], 0xe2088297)
	binary.LittleEndian.PutUint32(m[20:], 40) // empty domain, at offset 40
	binary.LittleEndian.PutUint32(m[28:], 40) // empty workstation
	copy(m[32:], []byte{0x06, 0x01, 0xb1, 0x1d, 0x00, 0x00, 0x00, 0x0f})
	return m
}

// tsRequest wraps an NTLM token in a CredSSP TSRequest (MS-CSSP 2.2.1).
func tsRequest(token []byte) []byte {
	negoToken := der(0xa0, der(0x04, token))
	negoData := der(0x30, der(0x30, negoToken))
	body := append([]byte{0xa0, 0x03, 0x02, 0x01, 0x06}, der(0xa1, negoData)...)
	return der(0x30, body)
}

// Info asks an RDP server for its computer name and Windows version.
func Info(ctx context.Context, dial DialFunc, addr netip.Addr, port int) (*ServerInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	tc, proto, err := handshake(ctx, dial, addr, port)
	if err != nil {
		return nil, err
	}
	defer tc.Close()
	if proto != "nla" && proto != "nla-ext" {
		return nil, errNoNTLM
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = tc.SetDeadline(dl)
	}
	if _, err := tc.Write(tsRequest(ntlmNegotiate())); err != nil {
		return nil, err
	}
	var buf []byte
	chunk := make([]byte, 4096)
	for len(buf) < 16384 {
		n, err := tc.Read(chunk)
		buf = append(buf, chunk[:n]...)
		if info := parseChallenge(buf); info != nil {
			return info, nil
		}
		if err != nil {
			break
		}
	}
	return nil, errNoNTLM
}

// parseChallenge finds an NTLM CHALLENGE message (type 2) in data and reads it.
func parseChallenge(data []byte) *ServerInfo {
	sig := []byte("NTLMSSP\x00\x02\x00\x00\x00")
	at := -1
	for i := 0; i+len(sig) <= len(data); i++ {
		if string(data[i:i+len(sig)]) == string(sig) {
			at = i
			break
		}
	}
	if at < 0 {
		return nil
	}
	m := data[at:]
	if len(m) < 56 {
		return nil
	}
	tiLen, tiOff := int(binary.LittleEndian.Uint16(m[40:])), int(binary.LittleEndian.Uint32(m[44:]))
	if tiOff+tiLen > len(m) {
		return nil // rest still to arrive
	}
	info := &ServerInfo{Major: int(m[48]), Minor: int(m[49]), Build: int(binary.LittleEndian.Uint16(m[50:]))}
	ti := m[tiOff : tiOff+tiLen]
	for len(ti) >= 4 {
		id, l := binary.LittleEndian.Uint16(ti), int(binary.LittleEndian.Uint16(ti[2:]))
		if id == 0 || 4+l > len(ti) {
			break
		}
		val := ti[4 : 4+l]
		u := make([]uint16, len(val)/2)
		for i := range u {
			u[i] = binary.LittleEndian.Uint16(val[2*i:])
		}
		switch id {
		case 1:
			info.ComputerName = string(utf16.Decode(u))
		case 2:
			info.Domain = string(utf16.Decode(u))
		case 3:
			info.DNSName = string(utf16.Decode(u))
		}
		ti = ti[4+l:]
	}
	info.OS = WindowsName(info.Major, info.Minor, info.Build)
	return info
}

// WindowsName turns an NTLM version into a product name. Windows 10 and Windows
// Server 2016/2019 share version numbers with different builds, so some builds
// name both.
func WindowsName(major, minor, build int) string {
	v := fmt.Sprintf("%d.%d.%d", major, minor, build)
	switch {
	case major == 5 && minor == 1:
		return "Windows XP (" + v + ")"
	case major == 5 && minor == 2:
		return "Windows Server 2003 (" + v + ")"
	case major == 6 && minor == 0:
		return "Windows Vista / Server 2008 (" + v + ")"
	case major == 6 && minor == 1:
		return "Windows 7 / Server 2008 R2 (" + v + ")"
	case major == 6 && minor == 2:
		return "Windows 8 / Server 2012 (" + v + ")"
	case major == 6 && minor == 3:
		return "Windows 8.1 / Server 2012 R2 (" + v + ")"
	case major != 10:
		return "Windows (" + v + ")"
	}
	names := map[int]string{
		10240: "Windows 10 1507", 10586: "Windows 10 1511", 14393: "Windows 10 1607 / Server 2016", 15063: "Windows 10 1703",
		16299: "Windows 10 1709", 17134: "Windows 10 1803", 17763: "Windows 10 1809 / Server 2019", 18362: "Windows 10 1903",
		18363: "Windows 10 1909", 19041: "Windows 10 2004", 19042: "Windows 10 20H2", 19043: "Windows 10 21H1",
		19044: "Windows 10 21H2", 19045: "Windows 10 22H2", 20348: "Windows Server 2022", 22000: "Windows 11 21H2",
		22621: "Windows 11 22H2", 22631: "Windows 11 23H2", 26100: "Windows 11 24H2 / Server 2025", 26200: "Windows 11 25H2",
	}
	if n, ok := names[build]; ok {
		return n + " (" + v + ")"
	}
	if build >= 22000 {
		return "Windows 11 / Server (" + v + ")"
	}
	return "Windows 10 / Server (" + strings.TrimSpace(v) + ")"
}
