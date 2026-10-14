package auth

import (
	"testing"
	"time"
)

// RFC 6238 appendix B test vectors (SHA-1 secret "12345678901234567890"); the
// RFC lists 8 digits, these are the last 6.
func TestTOTPVectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	for ts, want := range map[int64]string{59: "287082", 1111111109: "081804", 1111111111: "050471", 1234567890: "005924", 2000000000: "279037", 20000000000: "353130"} {
		if got := TOTPCode(secret, ts/TOTPPeriod); got != want {
			t.Errorf("t=%d: got %s want %s", ts, got, want)
		}
	}
}

func TestVerifyTOTPWindowAndFormat(t *testing.T) {
	secret, enc := NewTOTPSecret()
	if len(secret) != 20 || len(enc) != 32 {
		t.Fatalf("secret %d bytes, %d chars", len(secret), len(enc))
	}
	now := time.Unix(1_700_000_000, 0)
	cur := TOTPStep(now)
	for _, tc := range []struct {
		step int64
		ok   bool
	}{{cur, true}, {cur - 1, true}, {cur + 1, true}, {cur - 2, false}, {cur + 2, false}} {
		step, ok := VerifyTOTP(secret, TOTPCode(secret, tc.step), now)
		if ok != tc.ok || (ok && step != tc.step) {
			t.Errorf("step %+d: ok=%v step=%d", tc.step-cur, ok, step)
		}
	}
	good := TOTPCode(secret, cur)
	if _, ok := VerifyTOTP(secret, good[:3]+" "+good[3:], now); !ok {
		t.Error("spaces inside the code are fine")
	}
	for _, bad := range []string{"", "12345", "1234567", "abcdef", "000000x"} {
		if _, ok := VerifyTOTP(secret, bad, now); ok && bad != good {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestOTPAuthURI(t *testing.T) {
	u := OTPAuthURI("emremote", "admin@home", "JBSWY3DPEHPK3PXP")
	for _, want := range []string{"otpauth://totp/emremote:admin@home?", "secret=JBSWY3DPEHPK3PXP", "issuer=emremote", "period=30", "digits=6"} {
		if !contains(u, want) {
			t.Errorf("%q missing from %s", want, u)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestRecoveryCodes(t *testing.T) {
	codes := NewRecoveryCodes(10)
	seen := map[string]bool{}
	for _, c := range codes {
		n, ok := NormalizeRecovery(c)
		if !ok || len(c) != 11 || c[5] != '-' || seen[n] {
			t.Fatalf("bad or repeated code %q", c)
		}
		seen[n] = true
		if n2, ok := NormalizeRecovery(" " + c[:5] + " " + c[6:] + " "); !ok || n2 != n {
			t.Fatalf("separators and spaces must not matter for %q", c)
		}
		if HashRecovery(n) == HashRecovery(n+"x") || len(HashRecovery(n)) != 64 {
			t.Fatal("hash")
		}
	}
	for _, bad := range []string{"", "12345", "abcde-fghi0", "ABCDE-FGHI!"} {
		if _, ok := NormalizeRecovery(bad); ok {
			t.Errorf("accepted %q", bad)
		}
	}
}
