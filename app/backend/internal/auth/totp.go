package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 authenticator apps use HMAC-SHA1
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Time-based one-time passwords (RFC 6238) as used by authenticator apps:
// HMAC-SHA1, 30-second steps, 6 digits.

const (
	TOTPPeriod = 30
	totpDigits = 6
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a random 160-bit secret and its base32 form.
func NewTOTPSecret() (raw []byte, encoded string) {
	raw = make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return raw, b32.EncodeToString(raw)
}

// TOTPCode computes the code for one 30-second step.
func TOTPCode(secret []byte, step int64) string {
	mac := hmac.New(sha1.New, secret)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := (uint32(sum[off])&0x7f)<<24 | uint32(sum[off+1])<<16 | uint32(sum[off+2])<<8 | uint32(sum[off+3])
	return fmt.Sprintf("%0*d", totpDigits, n%1_000_000)
}

// TOTPStep is the step number containing t.
func TOTPStep(t time.Time) int64 { return t.Unix() / TOTPPeriod }

// VerifyTOTP checks a code against the current step and its neighbours (clock
// drift). It returns the matching step; callers must reject steps that are not
// newer than the last accepted one so that a code works only once.
func VerifyTOTP(secret []byte, code string, now time.Time) (int64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return 0, false
	}
	cur := TOTPStep(now)
	matched := int64(-1)
	for _, step := range []int64{cur - 1, cur, cur + 1} {
		if subtle.ConstantTimeCompare([]byte(TOTPCode(secret, step)), []byte(code)) == 1 {
			matched = step // keep looping: constant work regardless of which step matched
		}
	}
	return matched, matched >= 0
}

// OTPAuthURI is what authenticator apps read from a QR code.
func OTPAuthURI(issuer, account, secretBase32 string) string {
	q := url.Values{}
	q.Set("secret", secretBase32)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(TOTPPeriod))
	return "otpauth://totp/" + url.PathEscape(issuer) + ":" + url.PathEscape(account) + "?" + q.Encode()
}

// ---- Recovery codes ----

const recoveryAlphabet = "abcdefghjkmnpqrstuvwxyz23456789" // no look-alikes (i, l, o, 0, 1)

// NewRecoveryCodes returns n codes shaped like "abcde-fghij" (about 49 bits each).
func NewRecoveryCodes(n int) []string {
	out := make([]string, n)
	for i := range out {
		b := make([]byte, 10)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		for j := range b {
			b[j] = recoveryAlphabet[int(b[j])%len(recoveryAlphabet)]
		}
		out[i] = string(b[:5]) + "-" + string(b[5:])
	}
	return out
}

// NormalizeRecovery lower-cases a code and drops separators; ok is false when
// it cannot be a recovery code.
func NormalizeRecovery(s string) (string, bool) {
	s = strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(s)))
	if len(s) != 10 {
		return "", false
	}
	for _, r := range s {
		if !strings.ContainsRune(recoveryAlphabet, r) {
			return "", false
		}
	}
	return s, true
}

// HashRecovery is the storage form of a normalised recovery code. The codes
// are random with enough entropy that a plain SHA-256 is appropriate.
func HashRecovery(normalized string) string {
	sum := sha256.Sum256([]byte("emremote recovery " + normalized))
	return hex.EncodeToString(sum[:])
}
