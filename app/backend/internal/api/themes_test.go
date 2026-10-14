package api

import (
	"net/netip"
	"regexp"
	"strings"
	"testing"
)

var hexRe = regexp.MustCompile(`^#[0-9a-f]{6}$`)

func TestThemesAreComplete(t *testing.T) {
	for name, th := range terminalThemes {
		if !hexRe.MatchString(th.fg) || !hexRe.MatchString(th.bg) {
			t.Errorf("%s: bad foreground/background", name)
		}
		for i, c := range th.ansi {
			if !hexRe.MatchString(c) {
				t.Errorf("%s: color%d %q", name, i, c)
			}
		}
	}
	cs := guacColorScheme("solarized-dark")
	for _, want := range []string{"foreground: rgb:83/94/96;", "background: rgb:00/2b/36;", "color0: rgb:07/36/42;", "color15: rgb:fd/f6/e3;"} {
		if !strings.Contains(cs, want) {
			t.Errorf("missing %q in %q", want, cs)
		}
	}
	if guacColorScheme("gray-black") != "gray-black" {
		t.Error("built-in schemes are passed through")
	}
}

func TestTerminalPrefsAreValidatedAndApplied(t *testing.T) {
	v := newValidator()
	if got := v.terminalPrefs(&TerminalPrefs{ColorScheme: "dracula", FontName: "Terminus", FontSize: 16}); got == nil || !v.ok() {
		t.Fatalf("valid prefs rejected: %v", v.errs)
	}
	for _, bad := range []TerminalPrefs{{ColorScheme: "neon"}, {FontName: "Comic Sans"}, {FontSize: 200}, {FontName: "x; rm -rf"}} {
		v := newValidator()
		v.terminalPrefs(&bad)
		if v.ok() {
			t.Errorf("accepted %+v", bad)
		}
	}
	if newValidator().terminalPrefs(&TerminalPrefs{}) != nil {
		t.Error("empty prefs mean 'use the connection's'")
	}

	base := guacdTarget{Protocol: "ssh", Addr: netip.MustParseAddr("10.0.0.5"), Port: 22, Settings: []byte(`{"font_size":12,"color_scheme":"gray-black"}`)}
	p, err := buildGuacdParams(base)
	if err != nil || p["color-scheme"] != "gray-black" || p["font-size"] != "12" {
		t.Fatalf("defaults: %v %v", p, err)
	}
	base.Terminal = &TerminalPrefs{ColorScheme: "nord", FontSize: 18, FontName: "Liberation Mono"}
	p, _ = buildGuacdParams(base)
	if !strings.Contains(p["color-scheme"], "background: rgb:2e/34/40;") || p["font-size"] != "18" || p["font-name"] != "Liberation Mono" {
		t.Fatalf("personal prefs must win: %v", p)
	}
	base.Protocol = "telnet"
	base.Settings = nil
	if p, _ = buildGuacdParams(base); p["font-size"] != "18" {
		t.Fatal("telnet uses personal prefs too")
	}
}
