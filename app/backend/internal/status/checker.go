// Package status performs TCP reachability probes against configured
// connection ports. A successful probe means "the service port accepted a TCP
// connection from the emremote server" — not that a user is logged in, nor
// that the device is healthy. Devices with no probe result are "unknown".
package status

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/emremrangz/emremote/internal/netpolicy"
	"github.com/emremrangz/emremote/internal/store"
)

type Checker struct {
	store    *store.Store
	policy   *netpolicy.Policy
	interval time.Duration
	timeout  time.Duration
	mu       sync.Mutex // serializes full sweeps
}

func New(st *store.Store, policy *netpolicy.Policy, interval time.Duration) *Checker {
	return &Checker{store: st, policy: policy, interval: interval, timeout: 3 * time.Second}
}

// Run probes all connections periodically until ctx is cancelled.
func (c *Checker) Run(ctx context.Context) {
	if c.interval <= 0 {
		slog.Info("reachability checks disabled")
		return
	}
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		if err := c.CheckAll(ctx, ""); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("reachability sweep failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckAll probes every connection of deviceID (or all devices if empty).
func (c *Checker) CheckAll(ctx context.Context, deviceID string) error {
	if deviceID == "" {
		c.mu.Lock()
		defer c.mu.Unlock()
	}
	targets, err := c.store.ListProbeTargets(ctx, deviceID)
	if err != nil {
		return err
	}
	sem := make(chan struct{}, 16)
	var wg sync.WaitGroup
	for _, t := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(t store.ProbeTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			ok, detail := c.probe(ctx, t.Address, t.Port)
			if ctx.Err() != nil {
				return
			}
			if err := c.store.UpdateConnectionStatus(ctx, t.ConnectionID, ok, detail, time.Now()); err != nil {
				slog.Warn("store probe result", "error", err)
			}
		}(t)
	}
	wg.Wait()
	return ctx.Err()
}

func (c *Checker) probe(ctx context.Context, host string, port int) (bool, string) {
	addr, err := c.policy.Resolve(ctx, host)
	if err != nil {
		return false, err.Error()
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var d net.Dialer
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return false, "no response within " + c.timeout.String()
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return false, "no response within " + c.timeout.String()
		}
		return false, "connection refused or unreachable"
	}
	conn.Close()
	return true, "port open (" + time.Since(start).Round(time.Millisecond).String() + ")"
}
