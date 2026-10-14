// Package sshkey retrieves an SSH server's host key so the user can pin it
// (guacd's "host-key" parameter) instead of connecting without verification.
package sshkey

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

type HostKey struct {
	Type        string `json:"type"`
	Key         string `json:"key"`         // "<type> <base64>" — the value to pin
	Fingerprint string `json:"fingerprint"` // OpenSSH-style SHA256:...
}

var errCaptured = errors.New("host key captured")

// HostKeyAlgorithms is the order in which host key types are requested. It
// must match the preference of the gateway's SSH library (libssh2 in guacd),
// because the pinned key must be the one guacd will be shown.
var HostKeyAlgorithms = []string{
	ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
	ssh.KeyAlgoED25519,
	ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA,
}

// Fetch performs an SSH key exchange with addr:port and returns the host key.
// No authentication is attempted.
func Fetch(ctx context.Context, addr netip.Addr, port int) (*HostKey, error) {
	var d net.Dialer
	return FetchVia(ctx, d.DialContext, addr, port)
}

// DialFunc opens a connection; it lets a fetch run through a jump host.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// FetchVia is Fetch with a custom way of reaching the server.
func FetchVia(ctx context.Context, dial DialFunc, addr netip.Addr, port int) (*HostKey, error) {
	conn, err := dial(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	var captured ssh.PublicKey
	cfg := &ssh.ClientConfig{
		User:              "emremote-host-key-probe",
		HostKeyAlgorithms: HostKeyAlgorithms,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			captured = key
			return errCaptured
		},
	}
	_, _, _, err = ssh.NewClientConn(conn, conn.RemoteAddr().String(), cfg)
	if captured == nil {
		if err == nil {
			err = errors.New("server did not present a host key")
		}
		return nil, err
	}
	sum := sha256.Sum256(captured.Marshal())
	return &HostKey{
		Type:        captured.Type(),
		Key:         captured.Type() + " " + base64.StdEncoding.EncodeToString(captured.Marshal()),
		Fingerprint: "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "="),
	}, nil
}
