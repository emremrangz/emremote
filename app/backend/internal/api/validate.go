package api

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/netpolicy"
)

type validator struct {
	errs map[string]string
}

func newValidator() *validator { return &validator{errs: map[string]string{}} }

func (v *validator) ok() bool { return len(v.errs) == 0 }

func (v *validator) fail(field, msg string) {
	if _, exists := v.errs[field]; !exists {
		v.errs[field] = msg
	}
}

func (v *validator) summary() string {
	keys := make([]string, 0, len(v.errs))
	for k := range v.errs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return "Validation failed"
	}
	return v.errs[keys[0]]
}

func hasControl(s string, allowNewlines bool) bool {
	for _, r := range s {
		if allowNewlines && (r == '\n' || r == '\r' || r == '\t') {
			continue
		}
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// text validates a free-form string field and returns it trimmed.
func (v *validator) text(field, s string, required bool, max int, multiline bool) string {
	s = strings.TrimSpace(s)
	switch {
	case !utf8.ValidString(s):
		v.fail(field, "Contains invalid characters")
	case required && s == "":
		v.fail(field, "Required")
	case utf8.RuneCountInString(s) > max:
		v.fail(field, fmt.Sprintf("Must be at most %d characters", max))
	case hasControl(s, multiline):
		v.fail(field, "Contains control characters")
	}
	return s
}

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$`)

func (v *validator) username(field, s string) string {
	s = strings.TrimSpace(s)
	if !usernameRe.MatchString(s) {
		v.fail(field, "Use 1–64 letters, digits, dots, dashes, underscores or @")
	}
	return s
}

func (v *validator) password(field, s string) {
	if err := auth.ValidatePasswordPolicy(s); err != nil {
		v.fail(field, strings.ToUpper(err.Error()[:1])+err.Error()[1:])
	}
}

func (v *validator) oneOf(field, s string, allowed ...string) string {
	for _, a := range allowed {
		if s == a {
			return s
		}
	}
	v.fail(field, "Must be one of: "+strings.Join(allowed, ", "))
	return s
}

func (v *validator) address(field, s string, required bool) string {
	s = strings.TrimSpace(s)
	if s == "" {
		if required {
			v.fail(field, "Required")
		}
		return s
	}
	if err := netpolicy.ValidateAddress(s); err != nil {
		v.fail(field, "Enter a hostname or IP address only (no http://, port or path)")
	}
	return strings.ToLower(s)
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (v *validator) optionalUUID(field string, s *string) *string {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	t := strings.ToLower(strings.TrimSpace(*s))
	if !uuidRe.MatchString(t) {
		v.fail(field, "Invalid identifier")
		return nil
	}
	return &t
}

var tagRe = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} _.:/-]{0,31}$`)

func (v *validator) tags(field string, in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if !tagRe.MatchString(t) {
			v.fail(field, "Tags must be 1–32 letters, digits, spaces or _ . : / -")
			continue
		}
		k := strings.ToLower(t)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, t)
	}
	if len(out) > 20 {
		v.fail(field, "At most 20 tags")
	}
	return out
}

func validUUID(s string) bool { return uuidRe.MatchString(s) }

// jumpID validates the optional jump host reference of a connection.
func (v *validator) jumpID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if id != "" && !uuidRe.MatchString(id) {
		v.fail("settings.jump_connection_id", "Invalid identifier")
	}
	return id
}
