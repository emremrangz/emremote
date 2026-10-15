package api

import (
	"errors"
	"strings"

	"golang.org/x/crypto/ssh"
)

const maxKeyBytes = 32 << 10

// checkPrivateKey validates an SSH private key supplied by a user and returns it in
// a normal form (LF line endings, one trailing newline). It never echoes key
// material in its errors. A key protected by a passphrase needs that passphrase
// here, so a wrong or missing one is reported when the key is saved and not when the
// first connection fails.
func checkPrivateKey(key, passphrase string) (string, error) {
	key = strings.TrimPrefix(key, "\xef\xbb\xbf")
	key = strings.TrimSpace(strings.ReplaceAll(key, "\r\n", "\n"))
	switch {
	case key == "":
		return "", errors.New("The key file is empty.")
	case len(key) > maxKeyBytes:
		return "", errors.New("That file is too large to be an SSH key (the limit is 32 KB).")
	case strings.Contains(key, "PuTTY-User-Key-File"):
		return "", errors.New("PuTTY .ppk keys are not supported. In PuTTYgen choose Conversions, then Export OpenSSH key, and use that file.")
	case strings.HasPrefix(key, "ssh-") || strings.HasPrefix(key, "ecdsa-") || strings.HasPrefix(key, "sk-") || strings.Contains(key, "BEGIN SSH2 PUBLIC KEY") || (strings.Contains(key, "PUBLIC KEY-----") && !strings.Contains(key, "PRIVATE KEY-----")):
		return "", errors.New("That is a public key (usually the .pub file). Choose the private key instead: the same name without .pub.")
	case strings.Contains(key, "BEGIN ENCRYPTED PRIVATE KEY"):
		return "", errors.New("Keys in the encrypted PKCS#8 format are not supported. Convert it with: ssh-keygen -p -m PEM -f <keyfile>")
	case !strings.HasPrefix(key, "-----BEGIN ") || !strings.Contains(key, "PRIVATE KEY-----"):
		return "", errors.New("This does not look like a private key. It should start with -----BEGIN … PRIVATE KEY-----.")
	}
	key += "\n"
	_, err := ssh.ParseRawPrivateKey([]byte(key))
	var missing *ssh.PassphraseMissingError
	switch {
	case err == nil:
		return key, nil
	case errors.As(err, &missing):
		if passphrase == "" {
			return "", errors.New("This key is protected by a passphrase. Enter the passphrase so emremote can use it.")
		}
		if _, err := ssh.ParseRawPrivateKeyWithPassphrase([]byte(key), []byte(passphrase)); err != nil {
			return "", errors.New("That passphrase does not unlock this key.")
		}
		return key, nil
	default:
		return "", errors.New("This is not a valid or supported private key file (RSA, ECDSA and Ed25519 keys in OpenSSH or PEM format work).")
	}
}
