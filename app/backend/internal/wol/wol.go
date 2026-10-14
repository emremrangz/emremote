// Package wol sends Wake-on-LAN "magic packets".
package wol

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"
)

// ParseMAC accepts aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff and aabbccddeeff, and returns the canonical lowercase colon form.
func ParseMAC(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	h := strings.NewReplacer(":", "", "-", "", ".", "").Replace(s)
	if len(h) != 12 {
		return "", errors.New("A MAC address has six pairs of hex digits, like aa:bb:cc:dd:ee:ff")
	}
	hw, err := net.ParseMAC(fmt.Sprintf("%s:%s:%s:%s:%s:%s", h[0:2], h[2:4], h[4:6], h[6:8], h[8:10], h[10:12]))
	if err != nil {
		return "", errors.New("A MAC address has six pairs of hex digits, like aa:bb:cc:dd:ee:ff")
	}
	return hw.String(), nil
}

// Packet builds the magic packet: six 0xff bytes followed by the MAC sixteen times.
func Packet(mac string) ([]byte, error) {
	hw, err := net.ParseMAC(mac)
	if err != nil || len(hw) != 6 {
		return nil, errors.New("invalid MAC address")
	}
	p := make([]byte, 0, 102)
	for i := 0; i < 6; i++ {
		p = append(p, 0xff)
	}
	for i := 0; i < 16; i++ {
		p = append(p, hw...)
	}
	return p, nil
}

// Broadcast guesses the broadcast address of a device's network: the last
// address of its /24 (IPv4 only).
func Broadcast(addr netip.Addr) (netip.Addr, bool) {
	addr = addr.Unmap()
	if !addr.Is4() {
		return netip.Addr{}, false
	}
	b := addr.As4()
	b[3] = 255
	return netip.AddrFrom4(b), true
}

// Send transmits the magic packet to each destination (UDP port 9) and reports
// how many sends worked.
func Send(mac string, dests []netip.Addr) (int, error) {
	pkt, err := Packet(mac)
	if err != nil {
		return 0, err
	}
	sent := 0
	var last error
	for _, d := range dests {
		c, err := net.DialTimeout("udp", net.JoinHostPort(d.String(), "9"), 2*time.Second)
		if err != nil {
			last = err
			continue
		}
		_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if _, err := c.Write(pkt); err != nil {
			last = err
		} else {
			sent++
		}
		c.Close()
	}
	if sent == 0 && last != nil {
		return 0, last
	}
	return sent, nil
}
