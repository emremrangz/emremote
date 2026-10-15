package api

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func openssh(t *testing.T, key any, pass string) string {
	t.Helper()
	var b *pem.Block
	var err error
	if pass == "" {
		b, err = ssh.MarshalPrivateKey(key, "")
	} else {
		b, err = ssh.MarshalPrivateKeyWithPassphrase(key, "", []byte(pass))
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(b))
}

func TestCheckPrivateKey(t *testing.T) {
	_, ed, _ := ed25519.GenerateKey(rand.Reader)
	rsaKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	rsaPEM := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)}))
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(ec)
	pkcs8PEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	pub, _ := ssh.NewPublicKey(&rsaKey.PublicKey)

	ok := map[string]string{
		"openssh ed25519": openssh(t, ed, ""), "rsa pem": rsaPEM, "pkcs8 ecdsa": pkcs8PEM,
		"windows line endings": strings.ReplaceAll(openssh(t, ed, ""), "\n", "\r\n"),
		"surrounding blanks":   "\n\n" + rsaPEM + "\n\n",
	}
	for name, k := range ok {
		got, err := checkPrivateKey(k, "")
		if err != nil || !strings.HasSuffix(got, "\n") || strings.Contains(got, "\r") {
			t.Errorf("%s: err=%v", name, err)
		}
	}

	enc := openssh(t, ed, "correct horse")
	if _, err := checkPrivateKey(enc, ""); err == nil || !strings.Contains(err.Error(), "passphrase") {
		t.Errorf("an encrypted key without its passphrase must be refused: %v", err)
	}
	if _, err := checkPrivateKey(enc, "wrong"); err == nil || !strings.Contains(err.Error(), "does not unlock") {
		t.Errorf("a wrong passphrase must be refused: %v", err)
	}
	if _, err := checkPrivateKey(enc, "correct horse"); err != nil {
		t.Errorf("the right passphrase must work: %v", err)
	}

	bad := map[string]string{
		"public key (.pub)": string(ssh.MarshalAuthorizedKey(pub)),
		"putty":             "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\n",
		"encrypted pkcs8":   "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
		"garbage":           "hello world",
		"broken key":        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
		"empty":             "  ",
		"huge":              strings.Repeat("A", 40000),
	}
	for name, k := range bad {
		_, err := checkPrivateKey(k, "")
		if err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), "AAAA") {
			t.Errorf("%s: the error repeats key material: %v", name, err)
		}
	}
}
