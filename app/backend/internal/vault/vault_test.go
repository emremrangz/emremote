package vault

import (
	"strings"
	"testing"
)

func TestGenerateFollowsPolicy(t *testing.T) {
	cases := []Policy{
		DefaultPolicy,
		{Length: 12, Digits: true},
		{Length: 40, Lower: true, Symbols: true},
		{Length: 16, Lower: true, Upper: true, Digits: true, Symbols: true},
	}
	for _, p := range cases {
		for range 200 {
			pw := Generate(p)
			if len(pw) != p.Length {
				t.Fatalf("%+v: length %d", p, len(pw))
			}
			has := func(set string) bool { return strings.ContainsAny(pw, set) }
			if p.Lower != has(lowerSet) || p.Upper != has(upperSet) || p.Digits != has(digitSet) || p.Symbols != has(symbolSet) {
				t.Fatalf("%+v: %q does not match the chosen kinds", p, pw)
			}
			if p.NoAmbiguous && strings.ContainsAny(pw, ambiguous) {
				t.Fatalf("%q contains ambiguous characters", pw)
			}
			if strings.ContainsAny(pw, ":'\"\\` \n") {
				t.Fatalf("%q contains a character that breaks chpasswd or shells", pw)
			}
		}
	}
}

func TestGenerateInvalidPolicyFallsBack(t *testing.T) {
	if pw := Generate(Policy{Length: 3}); len(pw) != DefaultPolicy.Length {
		t.Fatalf("got %q", pw)
	}
}

func TestPolicyValidate(t *testing.T) {
	if (Policy{Length: 11, Lower: true}).Validate() == nil {
		t.Fatal("short length accepted")
	}
	if (Policy{Length: 20}).Validate() == nil {
		t.Fatal("no character kinds accepted")
	}
	if DefaultPolicy.Validate() != nil {
		t.Fatal("default policy invalid")
	}
}

func TestStrength(t *testing.T) {
	for pw, want := range map[string]int{
		"":                         0,
		"password":                 0,
		"P@ssw0rd":                 0,
		"aaaaaaaaaaaaaaaaaaaa":     0,
		"summer2024":               1,
		"Tr0ub4dor&3x":             2,
		"correcthorsebatterystap":  4,
		"x7#Kq9!vB2m$Lp4@Wz8^Nr6&": 4,
	} {
		if got := Strength(pw); got != want {
			t.Errorf("Strength(%q) = %d, want %d", pw, got, want)
		}
	}
	if Strength(Generate(DefaultPolicy)) != 4 {
		t.Error("a generated password should be strong")
	}
}

func TestParseTOTP(t *testing.T) {
	for in, want := range map[string]string{
		"JBSWY3DPEHPK3PXP":    "JBSWY3DPEHPK3PXP",
		"jbsw y3dp ehpk 3pxp": "JBSWY3DPEHPK3PXP",
		"otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP&issuer=x": "JBSWY3DPEHPK3PXP",
	} {
		got, err := ParseTOTP(in)
		if err != nil || got != want {
			t.Errorf("ParseTOTP(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "not base32!", "ABC", "otpauth://totp/x?issuer=y"} {
		if _, err := ParseTOTP(bad); err == nil {
			t.Errorf("ParseTOTP(%q) accepted", bad)
		}
	}
}

func TestValidAccount(t *testing.T) {
	for _, ok := range []string{"root", "svc_backup", "deploy-1", "a.b"} {
		if !ValidAccount(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "-root", "a b", "a:b", "root\n", "x;id", strings.Repeat("a", 40), "$(id)"} {
		if ValidAccount(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}
