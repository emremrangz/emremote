package sshhelper

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Password rotation on Unix hosts. Only fixed commands run: `id -u`, `chpasswd`
// (directly or through `sudo -S`) and `passwd`. Account names and passwords are
// written to the command's stdin or terminal, never into a command line.

// ErrRotationUncertain means the change may or may not have been applied (the
// connection broke or timed out after the new password was sent).
var ErrRotationUncertain = errors.New("the password change did not finish; the new password may already be in effect")

const rotateTimeout = 30 * time.Second

// SetPassword sets account's password with chpasswd, as root or through sudo
// (sudoPassword is the signed-in user's own password; empty for key logins with
// passwordless sudo).
func SetPassword(ctx context.Context, c *ssh.Client, account, newPassword, sudoPassword string) error {
	if strings.ContainsAny(account, ":\n") || strings.ContainsAny(newPassword, "\n\r") {
		return errors.New("account or password contains characters chpasswd cannot take")
	}
	ctx, cancel := context.WithTimeout(ctx, rotateTimeout)
	defer cancel()
	uid, err := run(ctx, c, "id -u", "")
	if err != nil {
		return fmt.Errorf("check the signed-in user: %w", err)
	}
	line := account + ":" + newPassword + "\n"
	cmd, stdin := "chpasswd", line
	if strings.TrimSpace(uid) != "0" {
		// -S reads the sudo password from stdin, -p '' hides the prompt, -k ignores
		// cached credentials so the password line is always consumed. Without a
		// password (key login) sudo must not ask (NOPASSWD), so stdin is just the line.
		cmd = "sudo -S -k -p '' chpasswd"
		if sudoPassword != "" {
			stdin = sudoPassword + "\n" + line
		}
	}
	out, code, err := runStatus(ctx, c, cmd, stdin)
	if err != nil {
		if ctx.Err() != nil {
			return ErrRotationUncertain
		}
		return err
	}
	if code != 0 {
		return fmt.Errorf("chpasswd failed (exit %d): %s", code, firstLine(out))
	}
	return nil
}

// ChangeOwnPassword runs passwd as the account itself, answering its prompts.
func ChangeOwnPassword(ctx context.Context, c *ssh.Client, oldPassword, newPassword string) error {
	if strings.ContainsAny(newPassword, "\n\r") {
		return errors.New("password contains a line break")
	}
	ctx, cancel := context.WithTimeout(ctx, rotateTimeout)
	defer cancel()
	s, err := c.NewSession()
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.RequestPty("dumb", 24, 120, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		return fmt.Errorf("terminal: %w", err)
	}
	in, err := s.StdinPipe()
	if err != nil {
		return err
	}
	out := &syncBuffer{}
	s.Stdout, s.Stderr = out, out
	// LC_ALL=C: English prompts, which the patterns below expect.
	if err := s.Start("LC_ALL=C passwd"); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	answered := 0
	sent := false
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			text := out.String()
			var exit *ssh.ExitError
			if errors.As(err, &exit) {
				return fmt.Errorf("passwd refused the change: %s", passwdReason(text))
			}
			if err != nil {
				if sent {
					return ErrRotationUncertain
				}
				return err
			}
			if !sent {
				return fmt.Errorf("passwd ended before asking for the new password: %s", passwdReason(text))
			}
			return nil
		case <-ctx.Done():
			_ = s.Signal(ssh.SIGKILL)
			if sent {
				return ErrRotationUncertain
			}
			return errors.New("passwd did not answer in time")
		case <-tick.C:
			prompt, n := nextPrompt(out.String(), answered)
			if prompt == promptNone {
				continue
			}
			answered = n
			answer := newPassword
			if prompt == promptCurrent {
				answer = oldPassword
			} else {
				sent = true
			}
			if _, err := in.Write([]byte(answer + "\n")); err != nil {
				return err
			}
		}
	}
}

type promptKind int

const (
	promptNone promptKind = iota
	promptCurrent
	promptNew
)

var (
	promptRe  = regexp.MustCompile(`(?im)^[^\n]*password[^\n]*:\s*$`)
	currentRe = regexp.MustCompile(`(?i)(current|old|existing|\(current\))`)
)

// nextPrompt finds the first password prompt after the n-th one already
// answered. It returns the kind and how many prompts have been seen.
func nextPrompt(text string, answered int) (promptKind, int) {
	all := promptRe.FindAllString(text, -1)
	if len(all) <= answered {
		return promptNone, answered
	}
	p := all[answered]
	if currentRe.MatchString(p) && !strings.Contains(strings.ToLower(p), "new") {
		return promptCurrent, answered + 1
	}
	return promptNew, answered + 1
}

// passwdReason picks the most useful line of passwd's output.
func passwdReason(text string) string {
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		low := strings.ToLower(l)
		if strings.Contains(low, "bad password") || strings.Contains(low, "fail") || strings.Contains(low, "error") ||
			strings.Contains(low, "too ") || strings.Contains(low, "not ") || strings.Contains(low, "denied") {
			return l
		}
	}
	return firstLine(text)
}

func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			if len(l) > 200 {
				l = l[:200]
			}
			return l
		}
	}
	return "no output"
}

// runStatus runs a command and returns its combined output and exit status.
func runStatus(ctx context.Context, c *ssh.Client, cmd, stdin string) (string, int, error) {
	s, err := c.NewSession()
	if err != nil {
		return "", 0, err
	}
	defer s.Close()
	var out bytes.Buffer
	lw := &limitedWriter{w: &out, n: 64 << 10}
	s.Stdout, s.Stderr = lw, lw
	s.Stdin = strings.NewReader(stdin)
	done := make(chan error, 1)
	go func() { done <- s.Run(cmd) }()
	select {
	case err := <-done:
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			return out.String(), exit.ExitStatus(), nil
		}
		return out.String(), 0, err
	case <-ctx.Done():
		_ = s.Signal(ssh.SIGKILL)
		return out.String(), 0, ctx.Err()
	}
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.b.Len() > 64<<10 {
		return len(p), nil
	}
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}
