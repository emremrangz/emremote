package secrets

import (
	"bytes"
	"testing"
)

func TestVaultWrapRequiresPasswordAndServerKey(t *testing.T) {
	box, _ := New(bytes.Repeat([]byte{1}, 32))
	dek, salt := NewDEK(), NewSalt()
	wrapped, err := box.WrapDEK("u1", "correct horse battery", salt, dek)
	if err != nil {
		t.Fatal(err)
	}
	got, err := box.UnwrapDEK("u1", "correct horse battery", salt, wrapped, KDFParams)
	if err != nil || !bytes.Equal(got, dek) {
		t.Fatalf("unwrap: %v", err)
	}
	if _, err := box.UnwrapDEK("u1", "wrong password", salt, wrapped, KDFParams); err == nil {
		t.Fatal("wrong password unwrapped the vault")
	}
	other, _ := New(bytes.Repeat([]byte{2}, 32))
	if _, err := other.UnwrapDEK("u1", "correct horse battery", salt, wrapped, KDFParams); err == nil {
		t.Fatal("a different server key unwrapped the vault")
	}
	if _, err := box.UnwrapDEK("u2", "correct horse battery", salt, wrapped, KDFParams); err == nil {
		t.Fatal("wrapped key is not bound to its user")
	}
}

func TestLockedBoxAndLegacyFormat(t *testing.T) {
	key := bytes.Repeat([]byte{3}, 32)
	box, _ := New(key)
	if _, err := box.SealMaterial("connection", "c1", Material{Password: "pw"}); err != ErrLocked {
		t.Fatalf("sealing must require the vault: %v", err)
	}
	// legacy ciphertext (format 0x01) still opens while locked
	aead, _ := newAEAD(key)
	legacy, _ := seal(aead, formatV1, []byte(`{"password":"old"}`), aadFor("connection", "c1"))
	m, err := box.OpenMaterial("connection", "c1", legacy)
	if err != nil || m.Password != "old" || !IsLegacy(legacy) {
		t.Fatalf("legacy open: %v %+v", err, m)
	}
	box.Unlock(NewDEK())
	ct, _ := box.SealMaterial("connection", "c1", Material{Password: "new"})
	if IsLegacy(ct) {
		t.Fatal("new secrets must use the vault format")
	}
	fresh, _ := New(key) // after a restart: locked
	if _, err := fresh.OpenMaterial("connection", "c1", ct); err != ErrLocked {
		t.Fatalf("vault secrets must not open without the data key: %v", err)
	}
}
