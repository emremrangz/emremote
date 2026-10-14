package api

import (
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"github.com/emremrangz/emremote/internal/secrets"
)

func TestNormalizeSettingsDefaultsAndValidation(t *testing.T) {
	v := newValidator()
	out := normalizeSettings(v, "rdp", json.RawMessage(`{"security":"nla","cert_fingerprints":" SHA256:AA:bb "}`))
	if !v.ok() {
		t.Fatalf("unexpected errors: %v", v.errs)
	}
	var s RDPSettings
	_ = json.Unmarshal(out, &s)
	if s.Security != "nla" || s.ColorDepth != 32 || !s.EnableFontSmoothing || s.CertFingerprints != "sha256:aa:bb" {
		t.Fatalf("normalized: %+v", s)
	}

	for _, bad := range []string{`{"security":"none"}`, `{"color_depth":7}`, `{"unknown":1}`, `{"server_layout":"xx"}`, `{"cert_fingerprints":"md5:zz"}`, `{"security":"any","cert_fingerprints":"sha256:aa:bb"}`} {
		v := newValidator()
		normalizeSettings(v, "rdp", json.RawMessage(bad))
		if v.ok() {
			t.Errorf("%s should be rejected", bad)
		}
	}
	v = newValidator()
	normalizeSettings(v, "ssh", json.RawMessage(`{"host_key":"ssh-ed25519 not*base64"}`))
	if v.ok() {
		t.Error("invalid host key accepted")
	}
}

func TestBuildGuacdParams(t *testing.T) {
	addr := netip.MustParseAddr("10.0.0.5")
	p, err := buildGuacdParams(guacdTarget{Protocol: "ssh", Addr: addr, Port: 2222, Username: "u",
		Secret: secrets.Material{PrivateKey: "KEY"}, Settings: json.RawMessage(`{"host_key":"ssh-ed25519 AAAAC3Nz"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if p["hostname"] != "10.0.0.5" || p["port"] != "2222" || p["private-key"] != "KEY" ||
		p["host-key"] != "[10.0.0.5]:2222 ssh-ed25519 AAAAC3Nz" {
		t.Fatalf("ssh params: %v", p)
	}
	if _, ok := p["command"]; ok {
		t.Fatal("command must never be set")
	}
	p, _ = buildGuacdParams(guacdTarget{Protocol: "rdp", Addr: addr, Port: 3389, Settings: json.RawMessage(`{}`)})
	if p["ignore-cert"] != "" || p["enable-drive"] != "" || p["color-depth"] != "32" || p["resize-method"] != "display-update" {
		t.Fatalf("rdp params: %v", p)
	}
	p, _ = buildGuacdParams(guacdTarget{Protocol: "rdp", Addr: addr, Port: 3389, Settings: json.RawMessage(`{}`), DrivePath: "/transfer/dev-1"})
	if p["enable-drive"] != "true" || p["drive-path"] != "/transfer/dev-1" || p["drive-name"] != "emremote" {
		t.Fatalf("rdp params: %v", p)
	}
	p, _ = buildGuacdParams(guacdTarget{Protocol: "vnc", Addr: addr, Port: 5900, Settings: json.RawMessage(`{"quality_level":8}`)})
	if p["quality-level"] != "8" || p["compress-level"] != "" || p["disable-display-resize"] != "true" {
		t.Fatalf("vnc params: %v", p)
	}
}

func TestTelnetSettings(t *testing.T) {
	v := newValidator()
	out := normalizeSettings(v, "telnet", json.RawMessage(`{"username_regex":"[Ll]ogin:","backspace":8}`))
	if !v.ok() {
		t.Fatalf("errors: %v", v.errs)
	}
	p, err := buildGuacdParams(guacdTarget{Protocol: "telnet", Addr: netip.MustParseAddr("10.0.0.9"), Port: 23, Username: "admin", Settings: out})
	if err != nil || p["username-regex"] != "[Ll]ogin:" || p["backspace"] != "8" || p["port"] != "23" {
		t.Fatalf("telnet params: %v %v", p, err)
	}
	v = newValidator()
	normalizeSettings(v, "telnet", json.RawMessage(`{"password_regex":"(unclosed"}`))
	if v.ok() {
		t.Fatal("invalid regex accepted")
	}
}

func TestKeyboardLayoutAuto(t *testing.T) {
	addr := netip.MustParseAddr("10.0.0.5")
	p, _ := buildGuacdParams(guacdTarget{Protocol: "rdp", Addr: addr, Port: 3389, Settings: json.RawMessage(`{}`), ClientLayout: "tr-tr-qwerty"})
	if p["server-layout"] != "tr-tr-qwerty" {
		t.Fatalf("auto layout should follow the browser: %v", p["server-layout"])
	}
	p, _ = buildGuacdParams(guacdTarget{Protocol: "rdp", Addr: addr, Port: 3389, Settings: json.RawMessage(`{"server_layout":"de-de-qwertz"}`), ClientLayout: "tr-tr-qwerty"})
	if p["server-layout"] != "de-de-qwertz" {
		t.Fatalf("explicit layout must win: %v", p["server-layout"])
	}
	p, _ = buildGuacdParams(guacdTarget{Protocol: "rdp", Addr: addr, Port: 3389, Settings: json.RawMessage(`{}`), ClientLayout: "evil;value"})
	if p["server-layout"] != "en-us-qwerty" {
		t.Fatalf("unknown detected layout must fall back: %v", p["server-layout"])
	}
}

func TestSecretInputValidation(t *testing.T) {
	v := newValidator()
	change, m := (&secretInput{Mode: "set", Password: "pw", PrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"}).validate(v, true)
	if !v.ok() || !change || m.Password != "pw" || !strings.HasSuffix(m.PrivateKey, "\n") {
		t.Fatalf("valid secret rejected: %v", v.errs)
	}
	v = newValidator()
	(&secretInput{Mode: "set", PrivateKey: "not a key"}).validate(v, true)
	if v.ok() {
		t.Fatal("invalid key accepted")
	}
	v = newValidator()
	if change, _ := (*secretInput)(nil).validate(v, false); change {
		t.Fatal("nil secret should mean keep")
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("ab\x00c\nd", 10); got != "abcd" {
		t.Fatalf("control chars not stripped: %q", got)
	}
	if got := truncate("çççç", 3); got != "ç" {
		t.Fatalf("truncate split rune: %q", got)
	}
}
