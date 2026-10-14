package auth

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHashing(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$") {
		t.Fatalf("unexpected hash format %q", h)
	}
	if ok, err := VerifyPassword("correct horse battery staple", h); !ok || err != nil {
		t.Fatalf("verify failed: %v", err)
	}
	if ok, _ := VerifyPassword("wrong", h); ok {
		t.Fatal("wrong password verified")
	}
	h2, _ := HashPassword("correct horse battery staple")
	if h == h2 {
		t.Fatal("hashes must be salted")
	}
	if _, err := VerifyPassword("x", "$bcrypt$foo"); err == nil {
		t.Fatal("expected invalid hash error")
	}
}

func TestPasswordPolicy(t *testing.T) {
	if ValidatePasswordPolicy("short") == nil {
		t.Fatal("short password accepted")
	}
	if ValidatePasswordPolicy("long-enough-password") != nil {
		t.Fatal("valid password rejected")
	}
}

func TestLoginLimiter(t *testing.T) {
	l := NewLoginLimiter()
	now := time.Unix(1000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 5; i++ {
		if ok, _ := l.Allowed("1.1.1.1", "admin"); !ok {
			t.Fatalf("attempt %d blocked too early", i)
		}
		l.Fail("1.1.1.1", "admin")
	}
	if ok, wait := l.Allowed("1.1.1.1", "admin"); ok || wait <= 0 {
		t.Fatal("6th attempt for user should be blocked")
	}
	if ok, _ := l.Allowed("1.1.1.1", "other"); !ok {
		t.Fatal("other username from same IP should still be allowed")
	}
	now = now.Add(16 * time.Minute)
	if ok, _ := l.Allowed("1.1.1.1", "admin"); !ok {
		t.Fatal("block should expire after the window")
	}
}

func TestHashTokenStable(t *testing.T) {
	if HashToken("abc") != HashToken("abc") || HashToken("abc") == HashToken("abd") || len(RandomToken(32)) < 40 {
		t.Fatal("token helpers misbehave")
	}
}
