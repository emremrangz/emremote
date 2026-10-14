package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"github.com/emremrangz/emremote/internal/secrets"
)

// Protocol-specific connection settings. Every field maps to a documented
// guacd 1.6 parameter; see buildGuacdParams. Settings are validated and stored
// in normalized form (all fields present) so clients always see the effective
// configuration.

type RDPSettings struct {
	// JumpConnectionID, when set, names the SSH connection to reach this target through.
	JumpConnectionID         string `json:"jump_connection_id"`
	Security                 string `json:"security"`
	IgnoreCert               bool   `json:"ignore_cert"`
	CertFingerprints         string `json:"cert_fingerprints"`
	ColorDepth               int    `json:"color_depth"`
	ResizeMethod             string `json:"resize_method"`
	ForceLossless            bool   `json:"force_lossless"`
	DisableGFX               bool   `json:"disable_gfx"`
	EnableFontSmoothing      bool   `json:"enable_font_smoothing"`
	EnableWallpaper          bool   `json:"enable_wallpaper"`
	EnableTheming            bool   `json:"enable_theming"`
	EnableFullWindowDrag     bool   `json:"enable_full_window_drag"`
	EnableDesktopComposition bool   `json:"enable_desktop_composition"`
	EnableMenuAnimations     bool   `json:"enable_menu_animations"`
	DisableAudio             bool   `json:"disable_audio"`
	Console                  bool   `json:"console"`
	ServerLayout             string `json:"server_layout"`
	DisableCopy              bool   `json:"disable_copy"`
	DisablePaste             bool   `json:"disable_paste"`
	ReadOnly                 bool   `json:"read_only"`
	EnableDrive              bool   `json:"enable_drive"`
	// EnablePrinting offers a virtual printer; documents arrive in the browser as PDF files.
	EnablePrinting   bool `json:"enable_printing"`
	EnableAudioInput bool `json:"enable_audio_input"`
	// RemoteApp opens a single application instead of the desktop (for example "||notepad").
	RemoteApp     string `json:"remote_app"`
	RemoteAppDir  string `json:"remote_app_dir"`
	RemoteAppArgs string `json:"remote_app_args"`
	// PreconnectionBlob (a Hyper-V VM name or id) and PreconnectionID select a VM through
	// Hyper-V's console service (use with security "vmconnect", port 2179).
	PreconnectionBlob string `json:"preconnection_blob"`
	PreconnectionID   int    `json:"preconnection_id"`
}

type VNCSettings struct {
	// JumpConnectionID, when set, names the SSH connection to reach this target through.
	JumpConnectionID  string `json:"jump_connection_id"`
	ColorDepth        int    `json:"color_depth"`
	QualityLevel      int    `json:"quality_level"`  // -1 = server default, 0–9
	CompressLevel     int    `json:"compress_level"` // -1 = server default, 0–9
	ForceLossless     bool   `json:"force_lossless"`
	Cursor            string `json:"cursor"`
	SwapRedBlue       bool   `json:"swap_red_blue"`
	ClipboardEncoding string `json:"clipboard_encoding"`
	DisableCopy       bool   `json:"disable_copy"`
	DisablePaste      bool   `json:"disable_paste"`
	ReadOnly          bool   `json:"read_only"`
}

type SSHSettings struct {
	// JumpConnectionID, when set, names the SSH connection to reach this target through.
	JumpConnectionID    string `json:"jump_connection_id"`
	HostKey             string `json:"host_key"`
	FontName            string `json:"font_name"`
	FontSize            int    `json:"font_size"`
	ColorScheme         string `json:"color_scheme"`
	Scrollback          int    `json:"scrollback"`
	TerminalType        string `json:"terminal_type"`
	ServerAliveInterval int    `json:"server_alive_interval"`
	// Backspace is the code the Backspace key sends: 127 (DEL) or 8 (BS).
	Backspace int `json:"backspace"`
	// Locale for the remote shell, for example en_US.UTF-8 ("" = server default).
	Locale       string `json:"locale"`
	DisableCopy  bool   `json:"disable_copy"`
	DisablePaste bool   `json:"disable_paste"`
	ReadOnly     bool   `json:"read_only"`
}

// TelnetSettings: telnet is unencrypted; offered for network equipment that
// has no SSH. The regexes let guacd type the stored username/password at the
// device's login prompts.
type TelnetSettings struct {
	// JumpConnectionID, when set, names the SSH connection to reach this target through.
	JumpConnectionID  string `json:"jump_connection_id"`
	FontName          string `json:"font_name"`
	FontSize          int    `json:"font_size"`
	ColorScheme       string `json:"color_scheme"`
	Scrollback        int    `json:"scrollback"`
	TerminalType      string `json:"terminal_type"`
	Backspace         int    `json:"backspace"`
	UsernameRegex     string `json:"username_regex"`
	PasswordRegex     string `json:"password_regex"`
	LoginSuccessRegex string `json:"login_success_regex"`
	LoginFailureRegex string `json:"login_failure_regex"`
	DisableCopy       bool   `json:"disable_copy"`
	DisablePaste      bool   `json:"disable_paste"`
	ReadOnly          bool   `json:"read_only"`
}

func defaultTelnet() TelnetSettings {
	return TelnetSettings{FontName: "monospace", FontSize: 12, ColorScheme: "gray-black", Scrollback: 1000, TerminalType: "xterm-256color", Backspace: 127}
}

func defaultRDP() RDPSettings {
	return RDPSettings{
		Security: "any", ColorDepth: 32, ResizeMethod: "display-update",
		EnableFontSmoothing: true, ServerLayout: "auto", EnableDrive: true,
	}
}

func defaultVNC() VNCSettings {
	return VNCSettings{ColorDepth: 24, QualityLevel: -1, CompressLevel: -1, Cursor: "local", ClipboardEncoding: "UTF-8"}
}

func defaultSSH() SSHSettings {
	return SSHSettings{FontName: "monospace", FontSize: 12, ColorScheme: "gray-black", Scrollback: 1000, TerminalType: "xterm-256color", Backspace: 127}
}

func DefaultPort(protocol string) int {
	switch protocol {
	case "rdp":
		return 3389
	case "vnc":
		return 5900
	case "ssh":
		return 22
	case "telnet":
		return 23
	}
	return 0
}

var keyboardLayouts = []string{
	"cs-cz-qwertz", "da-dk-qwerty", "de-ch-qwertz", "de-de-qwertz", "en-gb-qwerty", "en-us-qwerty", "es-es-qwerty",
	"es-latam-qwerty", "failsafe", "fr-be-azerty", "fr-ca-qwerty", "fr-ch-qwertz", "fr-fr-azerty", "hu-hu-qwertz",
	"it-it-qwerty", "ja-jp-qwerty", "no-no-qwerty", "pl-pl-qwerty", "pt-br-qwerty", "pt-pt-qwerty", "ro-ro-qwerty",
	"sv-se-qwerty", "tr-tr-qwerty",
}

var (
	fingerprintRe   = regexp.MustCompile(`^sha(1|256|384|512):[0-9a-fA-F]{2}(:[0-9a-fA-F]{2})+$`)
	sshKeyTypeRe    = regexp.MustCompile(`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|ssh-dss)$`)
	base64Re        = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)
	fontNameRe      = regexp.MustCompile(`^[A-Za-z0-9 _-]{1,64}$`)
	localeRe        = regexp.MustCompile(`^[A-Za-z]{2,3}(_[A-Za-z]{2})?(\.[A-Za-z0-9-]{1,16})?$`)
	preconnectionRe = regexp.MustCompile(`^[A-Za-z0-9 _.{}-]{1,128}$`)
)

func decodeSettings(raw json.RawMessage, dst any) error {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func between(v *validator, field string, n, lo, hi int) {
	if n < lo || n > hi {
		v.fail(field, fmt.Sprintf("Must be between %d and %d", lo, hi))
	}
}

// normalizeSettings validates raw settings for protocol and returns them
// normalized (defaults applied).
func normalizeSettings(v *validator, protocol string, raw json.RawMessage) json.RawMessage {
	var out any
	switch protocol {
	case "rdp":
		s := defaultRDP()
		if err := decodeSettings(raw, &s); err != nil {
			v.fail("settings", "Invalid RDP settings: "+sanitizeJSONError(err))
			return nil
		}
		v.oneOf("settings.security", s.Security, "any", "nla", "nla-ext", "tls", "rdp", "vmconnect")
		v.oneOf("settings.resize_method", s.ResizeMethod, "display-update", "reconnect", "none")
		v.oneOf("settings.server_layout", s.ServerLayout, append([]string{"auto"}, keyboardLayouts...)...)
		if s.ColorDepth != 8 && s.ColorDepth != 16 && s.ColorDepth != 24 && s.ColorDepth != 32 {
			v.fail("settings.color_depth", "Must be 8, 16, 24 or 32")
		}
		var fps []string
		for _, fp := range strings.Split(s.CertFingerprints, ",") {
			fp = strings.ToLower(strings.TrimSpace(fp))
			if fp == "" {
				continue
			}
			if !fingerprintRe.MatchString(fp) {
				v.fail("settings.cert_fingerprints", "Use the form sha256:aa:bb:… (comma-separated)")
				break
			}
			fps = append(fps, fp)
		}
		s.CertFingerprints = strings.Join(fps, ",")
		// A pin is only meaningful over TLS: "any" lets the server (or an
		// attacker in the middle) downgrade to legacy RDP security, which
		// presents no certificate at all.
		if s.CertFingerprints != "" && (s.Security == "any" || s.Security == "rdp") {
			v.fail("settings.security", "With a pinned certificate, choose TLS or NLA security so the connection cannot be downgraded to legacy RDP encryption")
		}
		for field, val := range map[string]string{"remote_app": s.RemoteApp, "remote_app_dir": s.RemoteAppDir, "remote_app_args": s.RemoteAppArgs} {
			if len(val) > 260 || hasControl(val, false) {
				v.fail("settings."+field, "Too long or contains control characters")
			}
		}
		s.PreconnectionBlob = strings.TrimSpace(s.PreconnectionBlob)
		if s.PreconnectionBlob != "" && !preconnectionRe.MatchString(s.PreconnectionBlob) {
			v.fail("settings.preconnection_blob", "Use the VM's name or id (letters, digits, spaces and - _ . { })")
		}
		between(v, "settings.preconnection_id", s.PreconnectionID, 0, 2147483647)
		s.JumpConnectionID = v.jumpID(s.JumpConnectionID)
		out = s
	case "vnc":
		s := defaultVNC()
		if err := decodeSettings(raw, &s); err != nil {
			v.fail("settings", "Invalid VNC settings: "+sanitizeJSONError(err))
			return nil
		}
		if s.ColorDepth != 8 && s.ColorDepth != 16 && s.ColorDepth != 24 && s.ColorDepth != 32 {
			v.fail("settings.color_depth", "Must be 8, 16, 24 or 32")
		}
		between(v, "settings.quality_level", s.QualityLevel, -1, 9)
		between(v, "settings.compress_level", s.CompressLevel, -1, 9)
		v.oneOf("settings.cursor", s.Cursor, "local", "remote")
		v.oneOf("settings.clipboard_encoding", s.ClipboardEncoding, "ISO8859-1", "UTF-8", "UTF-16", "CP1252")
		s.JumpConnectionID = v.jumpID(s.JumpConnectionID)
		out = s
	case "ssh":
		s := defaultSSH()
		if err := decodeSettings(raw, &s); err != nil {
			v.fail("settings", "Invalid SSH settings: "+sanitizeJSONError(err))
			return nil
		}
		s.HostKey = strings.TrimSpace(s.HostKey)
		if s.HostKey != "" {
			if _, _, err := parseHostKey(s.HostKey); err != nil {
				v.fail("settings.host_key", err.Error())
			}
		}
		if !fontNameRe.MatchString(s.FontName) {
			v.fail("settings.font_name", "Invalid font name")
		}
		between(v, "settings.font_size", s.FontSize, 6, 48)
		between(v, "settings.scrollback", s.Scrollback, 0, 20000)
		between(v, "settings.server_alive_interval", s.ServerAliveInterval, 0, 3600)
		v.oneOf("settings.color_scheme", s.ColorScheme, terminalSchemes...)
		v.oneOf("settings.terminal_type", s.TerminalType, "xterm-256color", "xterm", "vt100", "vt220", "linux")
		if s.Backspace != 127 && s.Backspace != 8 {
			v.fail("settings.backspace", "Must be 127 (DEL) or 8 (BS)")
		}
		s.Locale = strings.TrimSpace(s.Locale)
		if s.Locale != "" && !localeRe.MatchString(s.Locale) {
			v.fail("settings.locale", "Use a form like en_US.UTF-8")
		}
		s.JumpConnectionID = v.jumpID(s.JumpConnectionID)
		out = s
	case "telnet":
		s := defaultTelnet()
		if err := decodeSettings(raw, &s); err != nil {
			v.fail("settings", "Invalid Telnet settings: "+sanitizeJSONError(err))
			return nil
		}
		if !fontNameRe.MatchString(s.FontName) {
			v.fail("settings.font_name", "Invalid font name")
		}
		between(v, "settings.font_size", s.FontSize, 6, 48)
		between(v, "settings.scrollback", s.Scrollback, 0, 20000)
		v.oneOf("settings.color_scheme", s.ColorScheme, terminalSchemes...)
		v.oneOf("settings.terminal_type", s.TerminalType, "xterm-256color", "xterm", "vt100", "vt220", "linux", "ansi")
		if s.Backspace != 127 && s.Backspace != 8 {
			v.fail("settings.backspace", "Must be 127 (DEL) or 8 (BS)")
		}
		for field, re := range map[string]string{"username_regex": s.UsernameRegex, "password_regex": s.PasswordRegex,
			"login_success_regex": s.LoginSuccessRegex, "login_failure_regex": s.LoginFailureRegex} {
			if re == "" {
				continue
			}
			if _, err := regexp.Compile(re); err != nil || len(re) > 256 || hasControl(re, false) {
				v.fail("settings."+field, "Invalid regular expression")
			}
		}
		s.JumpConnectionID = v.jumpID(s.JumpConnectionID)
		out = s
	default:
		return nil
	}
	b, _ := json.Marshal(out)
	return b
}

// parseHostKey accepts "<type> <base64>" (optionally prefixed by a known_hosts
// host field) and returns type and key.
func parseHostKey(s string) (string, string, error) {
	f := strings.Fields(s)
	if len(f) == 3 {
		f = f[1:]
	}
	if len(f) != 2 || !sshKeyTypeRe.MatchString(f[0]) || !base64Re.MatchString(f[1]) || len(f[1]) > 4096 {
		return "", "", fmt.Errorf("Use the form \"ssh-ed25519 AAAA…\" (key type and base64 key)")
	}
	return f[0], f[1], nil
}

// resolveLayout picks the RDP keyboard layout: an explicit setting wins;
// "auto" uses the layout detected in the browser if guacd knows it.
func resolveLayout(configured, detected string) string {
	if configured != "" && configured != "auto" {
		return configured
	}
	for _, l := range keyboardLayouts {
		if l == detected {
			return l
		}
	}
	return "en-us-qwerty"
}

func knownHostsName(addr netip.Addr, port int) string {
	if port == 22 {
		return addr.String()
	}
	return "[" + addr.String() + "]:" + strconv.Itoa(port)
}

func b(v bool) string {
	if v {
		return "true"
	}
	return ""
}

// guacdTarget is everything needed to build guacd connection parameters.
type guacdTarget struct {
	Protocol string
	Addr     netip.Addr
	Port     int
	Username string
	Domain   string
	Secret   secrets.Material
	Settings json.RawMessage
	Timezone string
	// DrivePath is the transfer-drive folder to redirect into RDP ("" = none).
	DrivePath string
	// ClientLayout is the keyboard layout detected in the user's browser, used
	// when the connection's layout is "auto".
	ClientLayout string
	// Terminal holds the user's personal terminal appearance (SSH and Telnet).
	Terminal *TerminalPrefs
}

// applyTerminal sets the appearance parameters shared by SSH and Telnet.
func applyTerminal(p map[string]string, fontName string, fontSize int, scheme string, prefs *TerminalPrefs) {
	if prefs != nil {
		if prefs.FontName != "" {
			fontName = prefs.FontName
		}
		if prefs.FontSize != 0 {
			fontSize = prefs.FontSize
		}
		if prefs.ColorScheme != "" {
			scheme = prefs.ColorScheme
		}
	}
	p["font-name"] = fontName
	p["font-size"] = strconv.Itoa(fontSize)
	p["color-scheme"] = guacColorScheme(scheme)
}

func buildGuacdParams(t guacdTarget) (map[string]string, error) {
	p := map[string]string{
		"hostname": t.Addr.String(),
		"port":     strconv.Itoa(t.Port),
		"username": t.Username,
		"password": t.Secret.Password,
	}
	switch t.Protocol {
	case "rdp":
		s := defaultRDP()
		if err := decodeSettings(t.Settings, &s); err != nil {
			return nil, err
		}
		p["domain"] = t.Domain
		p["security"] = s.Security
		p["ignore-cert"] = b(s.IgnoreCert)
		p["cert-fingerprints"] = s.CertFingerprints
		p["color-depth"] = strconv.Itoa(s.ColorDepth)
		p["resize-method"] = s.ResizeMethod
		if s.ResizeMethod == "none" {
			p["resize-method"] = ""
		}
		p["force-lossless"] = b(s.ForceLossless)
		p["disable-gfx"] = b(s.DisableGFX)
		p["enable-font-smoothing"] = b(s.EnableFontSmoothing)
		p["enable-wallpaper"] = b(s.EnableWallpaper)
		p["enable-theming"] = b(s.EnableTheming)
		p["enable-full-window-drag"] = b(s.EnableFullWindowDrag)
		p["enable-desktop-composition"] = b(s.EnableDesktopComposition)
		p["enable-menu-animations"] = b(s.EnableMenuAnimations)
		p["disable-audio"] = b(s.DisableAudio)
		p["console"] = b(s.Console)
		p["server-layout"] = resolveLayout(s.ServerLayout, t.ClientLayout)
		p["disable-copy"] = b(s.DisableCopy)
		p["disable-paste"] = b(s.DisablePaste)
		p["read-only"] = b(s.ReadOnly)
		p["timezone"] = t.Timezone
		p["client-name"] = "emremote"
		if s.EnableDrive && t.DrivePath != "" {
			// Appears inside Windows as a network drive named "emremote".
			p["enable-drive"] = "true"
			p["drive-name"] = "emremote"
			p["drive-path"] = t.DrivePath
			p["create-drive-path"] = "true"
		}
		if s.EnablePrinting {
			p["enable-printing"] = "true"
			p["printer-name"] = "emremote"
		}
		p["enable-audio-input"] = b(s.EnableAudioInput)
		p["remote-app"] = s.RemoteApp
		p["remote-app-dir"] = s.RemoteAppDir
		p["remote-app-args"] = s.RemoteAppArgs
		if s.PreconnectionBlob != "" {
			p["preconnection-blob"] = s.PreconnectionBlob
		}
		if s.PreconnectionID > 0 {
			p["preconnection-id"] = strconv.Itoa(s.PreconnectionID)
		}
		// initial-program is intentionally never exposed.
	case "vnc":
		s := defaultVNC()
		if err := decodeSettings(t.Settings, &s); err != nil {
			return nil, err
		}
		p["color-depth"] = strconv.Itoa(s.ColorDepth)
		if s.QualityLevel >= 0 {
			p["quality-level"] = strconv.Itoa(s.QualityLevel)
		}
		if s.CompressLevel >= 0 {
			p["compress-level"] = strconv.Itoa(s.CompressLevel)
		}
		p["force-lossless"] = b(s.ForceLossless)
		p["cursor"] = s.Cursor
		p["swap-red-blue"] = b(s.SwapRedBlue)
		p["clipboard-encoding"] = s.ClipboardEncoding
		p["disable-copy"] = b(s.DisableCopy)
		p["disable-paste"] = b(s.DisablePaste)
		p["read-only"] = b(s.ReadOnly)
		// VNC usually shares a physical console; never change its resolution.
		// The browser scales the remote screen instead.
		p["disable-display-resize"] = "true"
	case "ssh":
		s := defaultSSH()
		if err := decodeSettings(t.Settings, &s); err != nil {
			return nil, err
		}
		p["private-key"] = t.Secret.PrivateKey
		p["passphrase"] = t.Secret.Passphrase
		if s.HostKey != "" {
			typ, key, err := parseHostKey(s.HostKey)
			if err != nil {
				return nil, err
			}
			p["host-key"] = knownHostsName(t.Addr, t.Port) + " " + typ + " " + key
		}
		applyTerminal(p, s.FontName, s.FontSize, s.ColorScheme, t.Terminal)
		p["scrollback"] = strconv.Itoa(s.Scrollback)
		p["terminal-type"] = s.TerminalType
		p["backspace"] = strconv.Itoa(s.Backspace)
		p["locale"] = s.Locale
		if s.ServerAliveInterval > 0 {
			p["server-alive-interval"] = strconv.Itoa(s.ServerAliveInterval)
		}
		p["disable-copy"] = b(s.DisableCopy)
		p["disable-paste"] = b(s.DisablePaste)
		p["read-only"] = b(s.ReadOnly)
		p["timezone"] = t.Timezone
		// "command" is intentionally not exposed (no arbitrary remote command execution).
	case "telnet":
		s := defaultTelnet()
		if err := decodeSettings(t.Settings, &s); err != nil {
			return nil, err
		}
		applyTerminal(p, s.FontName, s.FontSize, s.ColorScheme, t.Terminal)
		p["scrollback"] = strconv.Itoa(s.Scrollback)
		p["terminal-type"] = s.TerminalType
		p["backspace"] = strconv.Itoa(s.Backspace)
		p["username-regex"] = s.UsernameRegex
		p["password-regex"] = s.PasswordRegex
		p["login-success-regex"] = s.LoginSuccessRegex
		p["login-failure-regex"] = s.LoginFailureRegex
		p["disable-copy"] = b(s.DisableCopy)
		p["disable-paste"] = b(s.DisablePaste)
		p["read-only"] = b(s.ReadOnly)
	default:
		return nil, fmt.Errorf("unsupported protocol %q", t.Protocol)
	}
	return p, nil
}

// joinHostPort is a helper for logs/audit.
func joinHostPort(a netip.Addr, port int) string {
	return net.JoinHostPort(a.String(), strconv.Itoa(port))
}
