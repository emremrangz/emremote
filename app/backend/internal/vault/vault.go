// Package vault holds the pure logic of the privileged access vault: the
// password policy and generator, a strength estimate, and TOTP seed parsing.
// Storage, access rules and rotation live in the api and store packages.
package vault

import (
	"crypto/rand"
	"encoding/base32"
	"errors"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// Policy describes the passwords emremote generates (in forms and when rotating).
type Policy struct {
	Length  int  `json:"length"`
	Lower   bool `json:"lower"`
	Upper   bool `json:"upper"`
	Digits  bool `json:"digits"`
	Symbols bool `json:"symbols"`
	// NoAmbiguous leaves out characters that are easy to misread (0 O o 1 l I |).
	NoAmbiguous bool `json:"no_ambiguous"`
}

// DefaultPolicy is used until an administrator saves another one.
var DefaultPolicy = Policy{Length: 24, Lower: true, Upper: true, Digits: true, Symbols: true, NoAmbiguous: true}

const (
	MinLength = 12
	MaxLength = 128
)

const (
	lowerSet = "abcdefghijklmnopqrstuvwxyz"
	upperSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	digitSet = "0123456789"
	// Symbols that survive shells, chpasswd, RDP and terminal paste: no quotes,
	// backslash, colon, space or backtick.
	symbolSet = "!#$%&()*+,-./;<=>?@[]^_{|}~"
	ambiguous = "0Oo1lI|"
)

// Validate reports what is wrong with a policy, or nil.
func (p Policy) Validate() error {
	if p.Length < MinLength || p.Length > MaxLength {
		return errors.New("length must be between 12 and 128")
	}
	if !p.Lower && !p.Upper && !p.Digits && !p.Symbols {
		return errors.New("choose at least one kind of character")
	}
	return nil
}

func (p Policy) sets() []string {
	strip := func(s string) string {
		if !p.NoAmbiguous {
			return s
		}
		return strings.Map(func(r rune) rune {
			if strings.ContainsRune(ambiguous, r) {
				return -1
			}
			return r
		}, s)
	}
	var out []string
	if p.Lower {
		out = append(out, strip(lowerSet))
	}
	if p.Upper {
		out = append(out, strip(upperSet))
	}
	if p.Digits {
		out = append(out, strip(digitSet))
	}
	if p.Symbols {
		out = append(out, strip(symbolSet))
	}
	return out
}

func randIndex(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return int(v.Int64())
}

// Generate returns a random password that follows the policy and contains at
// least one character of every chosen kind.
func Generate(p Policy) string {
	if p.Validate() != nil {
		p = DefaultPolicy
	}
	sets := p.sets()
	all := strings.Join(sets, "")
	out := make([]byte, p.Length)
	for i := range out {
		out[i] = all[randIndex(len(all))]
	}
	// One of each chosen kind, at distinct random positions.
	pos := make([]int, p.Length)
	for i := range pos {
		pos[i] = i
	}
	for i := len(pos) - 1; i > 0; i-- {
		j := randIndex(i + 1)
		pos[i], pos[j] = pos[j], pos[i]
	}
	for i, set := range sets {
		out[pos[i]] = set[randIndex(len(set))]
	}
	return string(out)
}

var commonPasswords = map[string]bool{
	"password": true, "123456": true, "12345678": true, "qwerty": true, "admin": true, "letmein": true,
	"welcome": true, "root": true, "toor": true, "changeme": true, "passw0rd": true, "p@ssw0rd": true,
	"administrator": true, "default": true, "guest": true, "master": true, "secret": true, "111111": true,
}

// Strength estimates a password from 0 (very weak) to 4 (strong) from its
// length and character variety. It is a rough guide for the health report, not
// a cracking-time estimate.
func Strength(pw string) int {
	if pw == "" {
		return 0
	}
	lower := strings.ToLower(pw)
	if commonPasswords[lower] {
		return 0
	}
	var hasLower, hasUpper, hasDigit, hasOther bool
	distinct := map[rune]bool{}
	for _, r := range pw {
		distinct[r] = true
		switch {
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsDigit(r):
			hasDigit = true
		default:
			hasOther = true
		}
	}
	pool := 0
	if hasLower {
		pool += 26
	}
	if hasUpper {
		pool += 26
	}
	if hasDigit {
		pool += 10
	}
	if hasOther {
		pool += 32
	}
	n := len([]rune(pw))
	// Repeated characters add little: count length by distinct characters, at most double.
	eff := min(n, 2*len(distinct))
	bits := float64(eff) * math.Log2(float64(pool))
	switch {
	case bits < 40:
		return 0
	case bits < 60:
		return 1
	case bits < 80:
		return 2
	case bits < 100:
		return 3
	}
	return 4
}

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// ParseTOTP accepts a base32 seed (any case, spaces or padding allowed) or an
// otpauth:// URI and returns the normalised base32 seed.
func ParseTOTP(s string) (string, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(strings.ToLower(s), "otpauth://") {
		u, err := url.Parse(s)
		if err != nil {
			return "", errors.New("not a valid otpauth:// link")
		}
		s = u.Query().Get("secret")
	}
	s = strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "=", "").Replace(s))
	raw, err := b32.DecodeString(s)
	if err != nil || len(raw) < 10 || len(raw) > 64 {
		return "", errors.New("must be a base32 secret (16 or more characters) or an otpauth:// link")
	}
	return b32.EncodeToString(raw), nil
}

// TOTPKey decodes a seed returned by ParseTOTP.
func TOTPKey(seed string) ([]byte, error) { return b32.DecodeString(seed) }

// accountRe is what rotation accepts as a Unix account name: it is passed to
// chpasswd on stdin, never to a shell, but a strict pattern keeps it that way.
var accountRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,31}$`)

// ValidAccount reports whether name can be rotated.
func ValidAccount(name string) bool { return accountRe.MatchString(name) }
