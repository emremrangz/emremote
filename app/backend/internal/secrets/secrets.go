// Package secrets encrypts credential material at rest with AES-256-GCM.
//
// Two ciphertext formats exist (version byte || 12-byte nonce || GCM ct+tag):
//
//	0x01  legacy: sealed directly with EMREMOTE_ENCRYPTION_KEY
//	0x02  vault:  sealed with a random data key (DEK) that is only held in
//	      memory after an administrator signs in (see vault.go)
//
// The associated data binds each ciphertext to the row it belongs to, so a
// ciphertext copied into another row fails to decrypt.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
)

const (
	formatV1 = 0x01
	formatV2 = 0x02
)

var (
	ErrDecrypt = errors.New("secret could not be decrypted (wrong EMREMOTE_ENCRYPTION_KEY or corrupted data)")
	// ErrLocked means the vault data key is not in memory (nobody has signed in
	// since emremote started).
	ErrLocked = errors.New("saved passwords are locked; sign in again to unlock them")
)

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("encryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

type Box struct {
	envKey []byte
	legacy cipher.AEAD // EMREMOTE_ENCRYPTION_KEY

	mu     sync.RWMutex
	dek    cipher.AEAD // vault data key; nil while locked
	dekRaw []byte
}

func New(key []byte) (*Box, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	return &Box{envKey: append([]byte(nil), key...), legacy: aead}, nil
}

// Unlock installs the vault data key.
func (b *Box) Unlock(dek []byte) error {
	aead, err := newAEAD(dek)
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.dek = aead
	b.dekRaw = append([]byte(nil), dek...)
	b.mu.Unlock()
	return nil
}

// DEK returns the in-memory data key (for re-wrapping), if unlocked.
func (b *Box) DEK() ([]byte, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.dekRaw == nil {
		return nil, false
	}
	return append([]byte(nil), b.dekRaw...), true
}

func (b *Box) Unlocked() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.dek != nil
}

func (b *Box) current() (cipher.AEAD, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.dek == nil {
		return nil, ErrLocked
	}
	return b.dek, nil
}

func seal(aead cipher.AEAD, version byte, plaintext, aad []byte) ([]byte, error) {
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+aead.Overhead())
	out = append(out, version)
	out = append(out, nonce...)
	return aead.Seal(out, nonce, plaintext, aad), nil
}

func open(aead cipher.AEAD, ciphertext, aad []byte) ([]byte, error) {
	ns := aead.NonceSize()
	if len(ciphertext) < 1+ns+aead.Overhead() {
		return nil, ErrDecrypt
	}
	pt, err := aead.Open(nil, ciphertext[1:1+ns], ciphertext[1+ns:], aad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}

// Seal encrypts with the vault data key (format 0x02).
func (b *Box) Seal(plaintext, aad []byte) ([]byte, error) {
	aead, err := b.current()
	if err != nil {
		return nil, err
	}
	return seal(aead, formatV2, plaintext, aad)
}

// SealServer encrypts with EMREMOTE_ENCRYPTION_KEY alone (format 0x01). It works
// while the vault is locked, for data needed before anyone has signed in, such
// as two-factor secrets. Open decrypts it like any other value.
func (b *Box) SealServer(plaintext, aad []byte) ([]byte, error) {
	return seal(b.legacy, formatV1, plaintext, aad)
}

// Open decrypts either format.
func (b *Box) Open(ciphertext, aad []byte) ([]byte, error) {
	if len(ciphertext) == 0 {
		return nil, ErrDecrypt
	}
	switch ciphertext[0] {
	case formatV1:
		return open(b.legacy, ciphertext, aad)
	case formatV2:
		aead, err := b.current()
		if err != nil {
			return nil, err
		}
		return open(aead, ciphertext, aad)
	}
	return nil, ErrDecrypt
}

// IsLegacy reports whether a ciphertext still uses the pre-vault format.
func IsLegacy(ct []byte) bool { return len(ct) > 0 && ct[0] == formatV1 }

// Material is the set of secret fields that may be attached to a connection
// or stored credential.
type Material struct {
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	// Vault entries only: an API token, a secure note and a TOTP seed (base32).
	Token string `json:"token,omitempty"`
	Note  string `json:"note,omitempty"`
	TOTP  string `json:"totp,omitempty"`
}

// Fields lists the non-empty fields, for reporting presence without values.
func (m Material) Fields() []string {
	f := []string{}
	if m.Password != "" {
		f = append(f, "password")
	}
	if m.PrivateKey != "" {
		f = append(f, "private_key")
	}
	if m.Passphrase != "" {
		f = append(f, "passphrase")
	}
	if m.Token != "" {
		f = append(f, "token")
	}
	if m.Note != "" {
		f = append(f, "note")
	}
	if m.TOTP != "" {
		f = append(f, "totp")
	}
	sort.Strings(f)
	return f
}

func (m Material) Empty() bool { return len(m.Fields()) == 0 }

// SealMaterial encrypts m for the row identified by kind/id. An empty Material
// yields nil (nothing stored).
func (b *Box) SealMaterial(kind, id string, m Material) ([]byte, error) {
	if m.Empty() {
		return nil, nil
	}
	pt, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	return b.Seal(pt, aadFor(kind, id))
}

func (b *Box) OpenMaterial(kind, id string, ct []byte) (Material, error) {
	var m Material
	if len(ct) == 0 {
		return m, nil
	}
	pt, err := b.Open(ct, aadFor(kind, id))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(pt, &m); err != nil {
		return m, fmt.Errorf("decode secret: %w", err)
	}
	return m, nil
}

func aadFor(kind, id string) []byte { return []byte("emremote:" + kind + ":" + id) }
