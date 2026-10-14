// Package config loads emremote runtime configuration from environment variables.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// DefaultAllowedTargetNetworks are the private address ranges remote targets may
// live in when EMREMOTE_ALLOWED_TARGET_NETWORKS is not set.
const DefaultAllowedTargetNetworks = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7"

type Config struct {
	ListenAddr     string
	DatabaseURL    string
	GuacdAddr      string
	WebDir         string
	EncryptionKey  []byte
	SessionTTL     time.Duration
	SessionIdle    time.Duration
	CookieSecure   bool
	TrustedProxies []netip.Prefix

	// AllowedTargetNetworks restricts which resolved IP addresses may be used as
	// remote targets (and reachability-checked). DeniedTargetNetworks always win.
	AllowedTargetNetworks []netip.Prefix
	DeniedTargetNetworks  []netip.Prefix

	// JumpTargetNetworks are the networks that can only be reached through a
	// jump host. Empty (the default) turns the jump host feature off.
	JumpTargetNetworks []netip.Prefix

	// SetupToken, when set, is required to create the first administrator. Without it
	// the first-run screen is open to anyone on a private network.
	SetupToken string

	StatusCheckInterval time.Duration
	LogLevel            string
	MaxUploadBytes      int64
	TransferDir         string
	AutoSSHPort         int
}

func Load() (*Config, error) {
	c := &Config{
		ListenAddr:  env("EMREMOTE_LISTEN_ADDR", ":8080"),
		DatabaseURL: os.Getenv("EMREMOTE_DATABASE_URL"),
		GuacdAddr:   env("EMREMOTE_GUACD_ADDR", "guacd:4822"),
		WebDir:      env("EMREMOTE_WEB_DIR", "/app/web"),
		LogLevel:    env("EMREMOTE_LOG_LEVEL", "info"),
		TransferDir: env("EMREMOTE_TRANSFER_DIR", "/transfer"),
	}
	var errs []error

	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("EMREMOTE_DATABASE_URL is required"))
	}

	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("EMREMOTE_ENCRYPTION_KEY")))
	switch {
	case err != nil:
		errs = append(errs, fmt.Errorf("EMREMOTE_ENCRYPTION_KEY must be base64: %w", err))
	case len(key) != 32:
		errs = append(errs, errors.New("EMREMOTE_ENCRYPTION_KEY must decode to exactly 32 bytes (generate with: openssl rand -base64 32)"))
	default:
		c.EncryptionKey = key
	}

	c.SessionTTL, err = duration("EMREMOTE_SESSION_TTL", 12*time.Hour)
	errs = appendErr(errs, err)
	c.SessionIdle, err = duration("EMREMOTE_SESSION_IDLE_TIMEOUT", 2*time.Hour)
	errs = appendErr(errs, err)
	c.StatusCheckInterval, err = duration("EMREMOTE_STATUS_CHECK_INTERVAL", 60*time.Second)
	errs = appendErr(errs, err)
	if c.StatusCheckInterval != 0 && c.StatusCheckInterval < 10*time.Second {
		errs = append(errs, errors.New("EMREMOTE_STATUS_CHECK_INTERVAL must be 0 (disabled) or at least 10s"))
	}

	if v := env("EMREMOTE_MAX_UPLOAD_MB", "2048"); v != "" {
		mb, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil || mb < 1 || mb > 1<<20 {
			errs = append(errs, fmt.Errorf("EMREMOTE_MAX_UPLOAD_MB: invalid value %q", v))
		}
		c.MaxUploadBytes = mb << 20
	}

	c.AutoSSHPort = 22
	if v := env("EMREMOTE_AUTO_SSH_PORT", ""); v != "" {
		port, perr := strconv.Atoi(v)
		if perr != nil || port < 1 || port > 65535 {
			errs = append(errs, fmt.Errorf("EMREMOTE_AUTO_SSH_PORT: invalid port %q", v))
		}
		c.AutoSSHPort = port
	}

	c.CookieSecure, err = boolean("EMREMOTE_COOKIE_SECURE", true)
	errs = appendErr(errs, err)

	c.TrustedProxies, err = prefixes("EMREMOTE_TRUSTED_PROXIES", "")
	errs = appendErr(errs, err)
	c.AllowedTargetNetworks, err = prefixes("EMREMOTE_ALLOWED_TARGET_NETWORKS", DefaultAllowedTargetNetworks)
	errs = appendErr(errs, err)
	c.DeniedTargetNetworks, err = prefixes("EMREMOTE_DENIED_TARGET_NETWORKS", "")
	errs = appendErr(errs, err)
	c.JumpTargetNetworks, err = prefixes("EMREMOTE_JUMP_TARGET_NETWORKS", "")
	errs = appendErr(errs, err)
	c.SetupToken = strings.TrimSpace(os.Getenv("EMREMOTE_SETUP_TOKEN"))
	if c.SetupToken != "" && len(c.SetupToken) < 12 {
		errs = append(errs, errors.New("EMREMOTE_SETUP_TOKEN must be at least 12 characters"))
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return c, nil
}

func env(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func appendErr(errs []error, err error) []error {
	if err != nil {
		return append(errs, err)
	}
	return errs
}

func duration(name string, def time.Duration) (time.Duration, error) {
	v := env(name, "")
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("%s: invalid duration %q", name, v)
	}
	return d, nil
}

func boolean(name string, def bool) (bool, error) {
	v := env(name, "")
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s: invalid boolean %q", name, v)
	}
	return b, nil
}

func prefixes(name, def string) ([]netip.Prefix, error) {
	return ParsePrefixes(env(name, def))
}

// ParsePrefixes parses a comma-separated list of CIDR prefixes or single IPs.
func ParsePrefixes(list string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			addr, err := netip.ParseAddr(part)
			if err != nil {
				return nil, fmt.Errorf("invalid network %q", part)
			}
			out = append(out, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("invalid network %q", part)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}
