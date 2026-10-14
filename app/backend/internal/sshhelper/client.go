// Package sshhelper opens server-side SSH connections to a device for file
// management (SFTP) and read-only system inspection.
//
// Unlike browser terminal sessions (which run inside guacd), these connections
// are made by emremote itself, so the host key MUST be pinned: Dial refuses to
// connect otherwise.
package sshhelper

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/emremrangz/emremote/internal/secrets"
)

var (
	ErrHostKeyNotPinned  = errors.New("the SSH host key of this connection is not pinned")
	ErrNoCredentials     = errors.New("no credentials available for this connection")
	ErrHostKeyMismatch   = errors.New("the server presented a different host key than the pinned one")
	ErrAuthenticationBad = errors.New("authentication failed")
)

// hostKeyAlgorithms returns the algorithms to negotiate for a pinned key type,
// so the server presents exactly the key that was pinned.
func hostKeyAlgorithms(keyType string) []string {
	switch keyType {
	case ssh.KeyAlgoRSA:
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	default:
		return []string{keyType}
	}
}

// ParsePinnedKey parses the "type base64" (optionally "host type base64") form
// stored in connection settings.
func ParsePinnedKey(s string) (ssh.PublicKey, error) {
	f := strings.Fields(s)
	if len(f) == 3 {
		f = f[1:]
	}
	if len(f) != 2 {
		return nil, ErrHostKeyNotPinned
	}
	raw, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil {
		return nil, fmt.Errorf("pinned host key: %w", err)
	}
	key, err := ssh.ParsePublicKey(raw)
	if err != nil {
		return nil, fmt.Errorf("pinned host key: %w", err)
	}
	if key.Type() != f[0] {
		return nil, fmt.Errorf("pinned host key type mismatch")
	}
	return key, nil
}

type Target struct {
	Addr     netip.Addr // already checked against the network policy
	Port     int
	Username string
	Secret   secrets.Material
	HostKey  string // pinned "type base64"
	// Via, when set, is a logged-in bastion; the connection to Addr goes through it.
	Via *ssh.Client
}

// Dial connects and authenticates. Password, keyboard-interactive (answering
// with the password) and public-key authentication are supported.
func Dial(ctx context.Context, t Target) (*ssh.Client, error) {
	if strings.TrimSpace(t.HostKey) == "" {
		return nil, ErrHostKeyNotPinned
	}
	pinned, err := ParsePinnedKey(t.HostKey)
	if err != nil {
		return nil, err
	}
	if t.Username == "" || (t.Secret.Password == "" && t.Secret.PrivateKey == "") {
		return nil, ErrNoCredentials
	}
	// attempted records whether the server got as far as asking for our
	// credentials, so a failed handshake afterwards is reported as an
	// authentication failure rather than a generic error.
	attempted := false
	var auths []ssh.AuthMethod
	if t.Secret.PrivateKey != "" {
		var signer ssh.Signer
		if t.Secret.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(t.Secret.PrivateKey), []byte(t.Secret.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(t.Secret.PrivateKey))
		}
		if err != nil {
			return nil, fmt.Errorf("private key: %w", err)
		}
		auths = append(auths, ssh.PublicKeysCallback(func() ([]ssh.Signer, error) {
			attempted = true
			return []ssh.Signer{signer}, nil
		}))
	}
	if pw := t.Secret.Password; pw != "" {
		auths = append(auths, ssh.PasswordCallback(func() (string, error) {
			attempted = true
			return pw, nil
		}), ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			attempted = true
			answers := make([]string, len(questions))
			for i := range answers {
				answers[i] = pw
			}
			return answers, nil
		}))
	}
	mismatch := false
	cfg := &ssh.ClientConfig{
		User:              t.Username,
		Auth:              auths,
		HostKeyAlgorithms: hostKeyAlgorithms(pinned.Type()),
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if err := ssh.FixedHostKey(pinned)("", nil, key); err != nil {
				mismatch = true
				return ErrHostKeyMismatch
			}
			return nil
		},
		Timeout: 10 * time.Second,
	}
	var d net.Dialer
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var conn net.Conn
	if t.Via != nil {
		conn, err = t.Via.Dial("tcp", net.JoinHostPort(t.Addr.String(), strconv.Itoa(t.Port)))
	} else {
		conn, err = d.DialContext(dctx, "tcp", net.JoinHostPort(t.Addr.String(), strconv.Itoa(t.Port)))
	}
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	c, chans, reqs, err := ssh.NewClientConn(conn, conn.RemoteAddr().String(), cfg)
	if err != nil {
		conn.Close()
		if mismatch {
			return nil, ErrHostKeyMismatch
		}
		if attempted || strings.Contains(err.Error(), "unable to authenticate") {
			return nil, ErrAuthenticationBad
		}
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(c, chans, reqs), nil
}
