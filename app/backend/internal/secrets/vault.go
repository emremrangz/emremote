package secrets

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
)

// The vault data key (DEK) is stored only in wrapped form. The wrapping key is
// derived from BOTH the user's sign-in password (Argon2id) and
// EMREMOTE_ENCRYPTION_KEY, so a copy of the database together with .env is
// still not enough to recover saved passwords without the sign-in password.

const (
	kdfTime    = 3
	kdfMemory  = 64 * 1024
	kdfThreads = 2
	// KDFParams is stored next to each wrapped key for future upgrades.
	KDFParams = "argon2id;t=3;m=65536;p=2"
)

var ErrWrongPassword = errors.New("vault key could not be unwrapped")

// NewDEK returns a fresh random 256-bit data key.
func NewDEK() []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		panic(err)
	}
	return k
}

func NewSalt() []byte {
	s := make([]byte, 16)
	if _, err := rand.Read(s); err != nil {
		panic(err)
	}
	return s
}

func (b *Box) kek(password string, salt []byte) []byte {
	stretched := argon2.IDKey([]byte(password), salt, kdfTime, kdfMemory, kdfThreads, 32)
	mac := hmac.New(sha256.New, b.envKey)
	mac.Write([]byte("emremote vault kek v1"))
	mac.Write(stretched)
	return mac.Sum(nil)
}

// WrapDEK encrypts dek for userID under a key derived from password.
func (b *Box) WrapDEK(userID, password string, salt, dek []byte) ([]byte, error) {
	aead, err := newAEAD(b.kek(password, salt))
	if err != nil {
		return nil, err
	}
	return seal(aead, formatV2, dek, []byte("emremote:vault:"+userID))
}

// UnwrapDEK reverses WrapDEK.
func (b *Box) UnwrapDEK(userID, password string, salt, wrapped []byte, params string) ([]byte, error) {
	if params != KDFParams {
		return nil, fmt.Errorf("unsupported vault parameters %q", params)
	}
	aead, err := newAEAD(b.kek(password, salt))
	if err != nil {
		return nil, err
	}
	dek, err := open(aead, wrapped, []byte("emremote:vault:"+userID))
	if err != nil {
		return nil, ErrWrongPassword
	}
	return dek, nil
}
