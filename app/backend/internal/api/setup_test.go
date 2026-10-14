package api

import "testing"

func TestLocalSource(t *testing.T) {
	for ip, want := range map[string]bool{
		"127.0.0.1": true, "::1": true, "10.1.2.3": true, "172.16.5.4": true, "172.31.250.9": true, "192.168.0.10": true,
		"100.64.1.2": true, "169.254.1.1": true, "fd12:3456::1": true, "::ffff:192.168.1.5": true,
		"8.8.8.8": false, "1.1.1.1": false, "172.32.0.1": false, "100.128.0.1": false, "2001:db8::1": false, "": false, "not-an-ip": false,
	} {
		if got := localSource(ip); got != want {
			t.Errorf("localSource(%q) = %v, want %v", ip, got, want)
		}
	}
}
