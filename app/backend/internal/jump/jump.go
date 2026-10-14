// Package jump reaches targets that are only visible from a bastion (jump
// host). emremote logs in to the bastion over SSH and opens "direct-tcpip"
// channels to the target. The gateway (guacd), which speaks RDP, VNC, SSH and
// Telnet itself, is pointed at a temporary TCP listener here instead of at the
// target.
//
// The listener is created per session, bound to the one interface that faces
// the gateway, accepts only the gateway's addresses and disappears with the
// session (or after a short time if the session never starts).
package jump

import (
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// UnusedTimeout is how long a listener waits for its first connection.
var UnusedTimeout = 45 * time.Second

type Forwarder struct {
	ln      net.Listener
	client  *ssh.Client
	target  string
	allowed map[netip.Addr]bool

	mu     sync.Mutex
	conns  map[net.Conn]struct{}
	used   bool
	timer  *time.Timer
	closed bool
	once   sync.Once
}

// Listen starts forwarding connections to target ("host:port", resolved by the
// bastion) through client. It binds an unused port on bind and accepts
// connections only from the allowed addresses. Closing the Forwarder also
// closes client.
func Listen(client *ssh.Client, target string, bind netip.Addr, allowed []netip.Addr) (*Forwarder, error) {
	if len(allowed) == 0 {
		return nil, errors.New("no allowed peer addresses")
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(bind.String(), "0"))
	if err != nil {
		return nil, err
	}
	f := &Forwarder{ln: ln, client: client, target: target, allowed: map[netip.Addr]bool{}, conns: map[net.Conn]struct{}{}}
	for _, a := range allowed {
		f.allowed[a.Unmap()] = true
	}
	f.timer = time.AfterFunc(UnusedTimeout, f.Close)
	go f.serve()
	return f, nil
}

// Addr is where the gateway should connect.
func (f *Forwarder) Addr() (netip.Addr, int) {
	ta := f.ln.Addr().(*net.TCPAddr)
	a, _ := netip.AddrFromSlice(ta.IP)
	return a.Unmap(), ta.Port
}

func (f *Forwarder) serve() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		ta, ok := c.RemoteAddr().(*net.TCPAddr)
		if !ok {
			c.Close()
			continue
		}
		ip, _ := netip.AddrFromSlice(ta.IP)
		if !f.allowed[ip.Unmap()] {
			c.Close()
			continue
		}
		f.mu.Lock()
		if f.closed {
			f.mu.Unlock()
			c.Close()
			return
		}
		if !f.used {
			f.used = true
			f.timer.Stop()
		}
		f.conns[c] = struct{}{}
		f.mu.Unlock()
		go f.handle(c)
	}
}

func (f *Forwarder) handle(c net.Conn) {
	defer func() {
		c.Close()
		f.mu.Lock()
		delete(f.conns, c)
		f.mu.Unlock()
	}()
	rc, err := f.client.Dial("tcp", f.target)
	if err != nil {
		return
	}
	defer rc.Close()
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		done <- struct{}{}
	}
	go pipe(rc, c)
	go pipe(c, rc)
	<-done
}

// Close stops listening, drops open connections and the bastion login.
func (f *Forwarder) Close() {
	if f == nil {
		return // convenient for direct (non-jump) sessions
	}
	f.once.Do(func() {
		f.mu.Lock()
		f.closed = true
		f.timer.Stop()
		conns := make([]net.Conn, 0, len(f.conns))
		for c := range f.conns {
			conns = append(conns, c)
		}
		f.mu.Unlock()
		f.ln.Close()
		for _, c := range conns {
			c.Close()
		}
		f.client.Close()
	})
}

// Facing finds the local address on the network shared with the gateway and
// the gateway's own addresses, from a "host:port" such as "guacd:4822".
func Facing(hostport string) (bind netip.Addr, peers []netip.Addr, err error) {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		return bind, nil, err
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return bind, nil, err
	}
	ifaces, err := net.InterfaceAddrs()
	if err != nil {
		return bind, nil, err
	}
	for _, ia := range ifaces {
		n, ok := ia.(*net.IPNet)
		if !ok || n.IP.To4() == nil {
			continue
		}
		var shared []netip.Addr
		for _, ip := range ips {
			if n.Contains(ip) {
				if a, ok := netip.AddrFromSlice(ip); ok {
					shared = append(shared, a.Unmap())
				}
			}
		}
		if len(shared) > 0 {
			la, _ := netip.AddrFromSlice(n.IP)
			return la.Unmap(), shared, nil
		}
	}
	return bind, nil, errors.New("no network is shared with the gateway")
}

// HostPort joins a target for Dial.
func HostPort(host string, port int) string { return net.JoinHostPort(host, strconv.Itoa(port)) }
