package secrets

import (
	"bytes"
	"testing"
)

func TestSealOpenBoundToRow(t *testing.T) {
	box, err := New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	box.Unlock(NewDEK())
	m := Material{Password: "hunter2-very-secret", Passphrase: "pp"}
	ct, err := box.SealMaterial("connection", "id-1", m)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ct, []byte("hunter2")) {
		t.Fatal("ciphertext contains plaintext")
	}
	got, err := box.OpenMaterial("connection", "id-1", ct)
	if err != nil || got != m {
		t.Fatalf("open: %v %#v", err, got)
	}
	if _, err := box.OpenMaterial("connection", "id-2", ct); err == nil {
		t.Fatal("ciphertext must not decrypt for another row")
	}
	other, _ := New(bytes.Repeat([]byte{8}, 32))
	other.Unlock(NewDEK())
	if _, err := other.OpenMaterial("connection", "id-1", ct); err == nil {
		t.Fatal("ciphertext must not decrypt with another key")
	}
	if ct2, _ := box.SealMaterial("connection", "id-1", Material{}); ct2 != nil {
		t.Fatal("empty material should store nothing")
	}
	if f := m.Fields(); len(f) != 2 || f[0] != "passphrase" || f[1] != "password" {
		t.Fatalf("fields: %v", f)
	}
}
