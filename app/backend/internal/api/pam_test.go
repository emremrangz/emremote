package api

import (
	"testing"
	"time"

	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/store"
)

func TestMergeMaterialKeepsUntypedFields(t *testing.T) {
	cur := secrets.Material{Password: "old", PrivateKey: "key", Note: "note", TOTP: "SEED"}
	got := mergeMaterial(cur, secrets.Material{Password: "new", Token: "tok"})
	want := secrets.Material{Password: "new", PrivateKey: "key", Note: "note", TOTP: "SEED", Token: "tok"}
	if got != want {
		t.Fatalf("got %+v", got)
	}
}

func TestVaultLevels(t *testing.T) {
	cases := []struct {
		level, need string
		ok          bool
	}{
		{store.VaultUse, store.VaultUse, true},
		{store.VaultUse, store.VaultReveal, false},
		{store.VaultReveal, store.VaultUse, true},
		{store.VaultReveal, store.VaultManage, false},
		{store.VaultManage, store.VaultReveal, true},
		{"", store.VaultUse, false},
	}
	for _, c := range cases {
		if atLeast(c.level, c.need) != c.ok {
			t.Errorf("atLeast(%q, %q) != %v", c.level, c.need, c.ok)
		}
	}
}

func TestHoldsCheckout(t *testing.T) {
	alice, bob := "a", "b"
	u := &store.User{ID: alice}
	live := &store.Checkout{UserID: &alice, ExpiresAt: time.Now().Add(time.Minute)}
	if !holdsCheckout(live, u) {
		t.Fatal("holder not recognised")
	}
	if holdsCheckout(&store.Checkout{UserID: &bob, ExpiresAt: live.ExpiresAt}, u) {
		t.Fatal("someone else's check-out accepted")
	}
	if holdsCheckout(&store.Checkout{UserID: &alice, ExpiresAt: time.Now().Add(-time.Second)}, u) {
		t.Fatal("an expired check-out still counts")
	}
	if holdsCheckout(nil, u) || holdsCheckout(&store.Checkout{ExpiresAt: live.ExpiresAt}, u) {
		t.Fatal("no check-out or a deleted holder counts")
	}
}

func TestStrengthOf(t *testing.T) {
	if strengthOf(secrets.Material{PrivateKey: "k"}) != nil {
		t.Fatal("strength without a password")
	}
	if s := strengthOf(secrets.Material{Password: "password"}); s == nil || *s != 0 {
		t.Fatal("common password not very weak")
	}
}
