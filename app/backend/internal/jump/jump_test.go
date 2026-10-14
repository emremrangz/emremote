package jump

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// startEcho runs a TCP server that echoes what it receives, prefixed.
func startEcho(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = c.Write([]byte("hello "))
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().String()
}

// startBastion runs an in-process SSH server that allows direct-tcpip channels.
func startBastion(t *testing.T) *ssh.Client {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					if ch.ChannelType() != "direct-tcpip" {
						_ = ch.Reject(ssh.UnknownChannelType, "no")
						continue
					}
					p := ch.ExtraData()
					hl := binary.BigEndian.Uint32(p)
					host := string(p[4 : 4+hl])
					port := binary.BigEndian.Uint32(p[4+hl:])
					target, err := net.Dial("tcp", net.JoinHostPort(host, itoa(int(port))))
					if err != nil {
						_ = ch.Reject(ssh.ConnectionFailed, err.Error())
						continue
					}
					sc, creqs, _ := ch.Accept()
					go ssh.DiscardRequests(creqs)
					go func() { _, _ = io.Copy(sc, target); sc.Close() }()
					go func() { _, _ = io.Copy(target, sc); target.Close() }()
				}
			}()
		}
	}()
	c, err := ssh.Dial("tcp", ln.Addr().String(), &ssh.ClientConfig{User: "x", HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second}) //nolint:gosec // in-process test server
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestForwardsThroughTheBastionToTheTarget(t *testing.T) {
	target := startEcho(t)
	f, err := Listen(startBastion(t), target, netip.MustParseAddr("127.0.0.1"), []netip.Addr{netip.MustParseAddr("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	addr, port := f.Addr()
	c, err := net.DialTimeout("tcp", net.JoinHostPort(addr.String(), itoa(port)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 6)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hello " {
		t.Fatalf("greeting %q %v", buf, err)
	}
	_, _ = c.Write([]byte("ping"))
	echo := make([]byte, 4)
	if _, err := io.ReadFull(c, echo); err != nil || string(echo) != "ping" {
		t.Fatalf("echo %q %v", echo, err)
	}
	// A second connection works too (RDP may reconnect while negotiating).
	c2, err := net.DialTimeout("tcp", net.JoinHostPort(addr.String(), itoa(port)), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c2.Close()
}

func TestOtherPeersAreRefused(t *testing.T) {
	f, err := Listen(startBastion(t), startEcho(t), netip.MustParseAddr("127.0.0.1"), []netip.Addr{netip.MustParseAddr("10.9.9.9")})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	addr, port := f.Addr()
	c, err := net.DialTimeout("tcp", net.JoinHostPort(addr.String(), itoa(port)), 3*time.Second)
	if err != nil {
		t.Fatal(err) // the TCP handshake completes; the listener closes the socket right away
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if n, err := c.Read(make([]byte, 8)); n != 0 || err == nil {
		t.Fatalf("a peer that is not the gateway got data: %d %v", n, err)
	}
}

func TestCloseStopsListeningAndDropsConnections(t *testing.T) {
	f, err := Listen(startBastion(t), startEcho(t), netip.MustParseAddr("127.0.0.1"), []netip.Addr{netip.MustParseAddr("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	addr, port := f.Addr()
	c, _ := net.DialTimeout("tcp", net.JoinHostPort(addr.String(), itoa(port)), 3*time.Second)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.ReadFull(c, make([]byte, 6))
	f.Close()
	f.Close() // idempotent
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("open connection survived Close")
	}
	if c2, err := net.DialTimeout("tcp", net.JoinHostPort(addr.String(), itoa(port)), time.Second); err == nil {
		c2.Close()
		t.Fatal("still listening after Close")
	}
}

func TestUnusedListenerExpires(t *testing.T) {
	old := UnusedTimeout
	UnusedTimeout = 150 * time.Millisecond
	defer func() { UnusedTimeout = old }()
	f, err := Listen(startBastion(t), startEcho(t), netip.MustParseAddr("127.0.0.1"), []netip.Addr{netip.MustParseAddr("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	addr, port := f.Addr()
	time.Sleep(500 * time.Millisecond)
	if c, err := net.DialTimeout("tcp", net.JoinHostPort(addr.String(), itoa(port)), time.Second); err == nil {
		c.Close()
		t.Fatal("a listener nobody connected to must close itself")
	}
}

func TestListenNeedsPeers(t *testing.T) {
	if _, err := Listen(startBastion(t), "x:1", netip.MustParseAddr("127.0.0.1"), nil); err == nil {
		t.Fatal("no allowed peers must be an error")
	}
}
