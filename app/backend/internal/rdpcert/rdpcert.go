// Package rdpcert retrieves the TLS certificate presented by an RDP server so
// the user can pin its fingerprint (guacd's "cert-fingerprints" parameter)
// instead of disabling certificate verification.
package rdpcert

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type Certificate struct {
	Subject     string    `json:"subject"`
	Issuer      string    `json:"issuer"`
	NotBefore   time.Time `json:"not_before"`
	NotAfter    time.Time `json:"not_after"`
	SelfSigned  bool      `json:"self_signed"`
	SHA256      string    `json:"sha256"`      // aa:bb:... lowercase
	Fingerprint string    `json:"fingerprint"` // value for guacd cert-fingerprints
	Protocol    string    `json:"protocol"`    // negotiated RDP security protocol
}

var ErrNoTLS = errors.New("the server negotiated standard RDP security without TLS; there is no certificate to pin")

// x224ConnectionRequest is a TPKT + X.224 Connection Request carrying an
// RDP_NEG_REQ asking for TLS | CredSSP | CredSSP-EX (MS-RDPBCGR 2.2.1.1).
var x224ConnectionRequest = []byte{
	0x03, 0x00, 0x00, 0x13, // TPKT, length 19
	0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 CR
	0x01, 0x00, 0x08, 0x00, 0x0b, 0x00, 0x00, 0x00, // RDP_NEG_REQ: PROTOCOL_SSL|HYBRID|HYBRID_EX
}

// Fetch connects to addr:port, negotiates TLS and returns the leaf certificate.
// The caller must have validated addr against the network policy.
func Fetch(ctx context.Context, addr netip.Addr, port int) (*Certificate, error) {
	var d net.Dialer
	return FetchVia(ctx, d.DialContext, addr, port)
}

// DialFunc opens a connection; it lets a fetch run through a jump host.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// FetchVia is Fetch with a custom way of reaching the server.
func FetchVia(ctx context.Context, dial DialFunc, addr netip.Addr, port int) (*Certificate, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tc, proto, err := handshake(ctx, dial, addr, port)
	if err != nil {
		return nil, err
	}
	defer tc.Close()
	return certificateOf(tc, proto)
}

// handshake runs the X.224 negotiation and the TLS handshake. The caller closes the result.
func handshake(ctx context.Context, dial DialFunc, addr netip.Addr, port int) (*tls.Conn, string, error) {
	conn, err := dial(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		return nil, "", err
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}

	if _, err := conn.Write(x224ConnectionRequest); err != nil {
		return nil, "", err
	}
	hdr := make([]byte, 4)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return nil, "", fmt.Errorf("not an RDP server (no X.224 response): %w", err)
	}
	if hdr[0] != 0x03 {
		return nil, "", errors.New("not an RDP server (unexpected response)")
	}
	n := int(binary.BigEndian.Uint16(hdr[2:4]))
	if n < 11 || n > 512 {
		return nil, "", errors.New("not an RDP server (bad TPKT length)")
	}
	body := make([]byte, n-4)
	if _, err := io.ReadFull(conn, body); err != nil {
		return nil, "", err
	}
	// body: X.224 CC (7 bytes) + optional RDP_NEG_RSP/RDP_NEG_FAILURE (8 bytes)
	if len(body) < 15 {
		return nil, "", ErrNoTLS
	}
	neg := body[7:]
	switch neg[0] {
	case 0x02: // RDP_NEG_RSP
	case 0x03: // RDP_NEG_FAILURE
		return nil, "", fmt.Errorf("server refused security negotiation (failure code %d)", binary.LittleEndian.Uint32(neg[4:8]))
	default:
		return nil, "", ErrNoTLS
	}
	selected := binary.LittleEndian.Uint32(neg[4:8])
	proto := map[uint32]string{0: "rdp", 1: "tls", 2: "nla", 8: "nla-ext"}[selected]
	if selected == 0 {
		return nil, "", ErrNoTLS
	}

	// We deliberately skip chain verification here: the purpose is to show the
	// presented certificate to the user so they can decide to pin it. Nothing
	// is sent over this connection.
	tc := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS10}) //nolint:gosec
	if err := tc.HandshakeContext(ctx); err != nil {
		return nil, "", fmt.Errorf("TLS handshake failed: %w", err)
	}
	ok = true
	return tc, proto, nil
}

func certificateOf(tc *tls.Conn, proto string) (*Certificate, error) {
	certs := tc.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, errors.New("server presented no certificate")
	}
	leaf := certs[0]
	sum := sha256.Sum256(leaf.Raw)
	hexParts := make([]string, len(sum))
	for i, b := range sum {
		hexParts[i] = fmt.Sprintf("%02x", b)
	}
	fp := strings.Join(hexParts, ":")
	return &Certificate{
		Subject:     leaf.Subject.String(),
		Issuer:      leaf.Issuer.String(),
		NotBefore:   leaf.NotBefore,
		NotAfter:    leaf.NotAfter,
		SelfSigned:  leaf.Subject.String() == leaf.Issuer.String(),
		SHA256:      fp,
		Fingerprint: "sha256:" + fp,
		Protocol:    proto,
	}, nil
}
