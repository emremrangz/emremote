package auth

import (
	"sync"
	"time"
)

// LoginLimiter throttles failed logins per client IP and per username using a
// sliding window. It is in-memory: a restart clears it, which is acceptable for
// a single-instance home-lab deployment.
type LoginLimiter struct {
	mu       sync.Mutex
	window   time.Duration
	maxIP    int
	maxUser  int
	failures map[string][]time.Time
	now      func() time.Time
}

func NewLoginLimiter() *LoginLimiter {
	return &LoginLimiter{
		window:   15 * time.Minute,
		maxIP:    20,
		maxUser:  5,
		failures: map[string][]time.Time{},
		now:      time.Now,
	}
}

// Allowed reports whether a login attempt may proceed and, if not, how long
// the caller should wait.
func (l *LoginLimiter) Allowed(ip, username string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if wait := l.check("ip:"+ip, l.maxIP, now); wait > 0 {
		return false, wait
	}
	if wait := l.check("user:"+username, l.maxUser, now); wait > 0 {
		return false, wait
	}
	return true, 0
}

func (l *LoginLimiter) check(key string, max int, now time.Time) time.Duration {
	times := l.prune(key, now)
	if len(times) < max {
		return 0
	}
	return times[0].Add(l.window).Sub(now)
}

func (l *LoginLimiter) prune(key string, now time.Time) []time.Time {
	times := l.failures[key]
	i := 0
	for i < len(times) && now.Sub(times[i]) >= l.window {
		i++
	}
	times = times[i:]
	if len(times) == 0 {
		delete(l.failures, key)
		return nil
	}
	l.failures[key] = times
	return times
}

func (l *LoginLimiter) Fail(ip, username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for _, k := range []string{"ip:" + ip, "user:" + username} {
		l.failures[k] = append(l.prune(k, now), now)
	}
}

// Succeed clears the username counter (the IP counter keeps decaying so a
// valid login cannot be used to reset brute-force pressure from one address).
func (l *LoginLimiter) Succeed(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, "user:"+username)
}

// Sweep removes expired entries; call periodically.
func (l *LoginLimiter) Sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k := range l.failures {
		l.prune(k, now)
	}
}
