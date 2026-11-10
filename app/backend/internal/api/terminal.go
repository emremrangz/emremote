package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/sshhelper"
	"github.com/emremrangz/emremote/internal/store"
)

// Built-in SSH terminal. The browser runs a terminal emulator (xterm.js) and emremote's own SSH client carries the
// session, so the screen is drawn in the browser instead of as images by the gateway: typing and scrolling are as quick
// as in a desktop SSH client, and a paste reaches the remote program as one bracketed paste, so editors such as nano and
// vim keep its indentation. As for files and system information, the host key must be pinned.
//
// The WebSocket carries binary frames with terminal data in both directions. Text frames are JSON control messages:
// the browser sends {"type":"resize","cols":..,"rows":..}; the server sends {"type":"ready","session_id":..} once the
// shell runs and {"type":"exit","status":..,"reason":..} when it ends.

// builtinTerminal says whether an SSH connection uses the built-in terminal.
func builtinTerminal(settings json.RawMessage) bool {
	var s SSHSettings
	_ = decodeSettings(settings, &s)
	return s.Terminal != "gateway"
}

// terminalPlan is an SSH connection that is open and waiting for the browser to attach.
type terminalPlan struct {
	client    *ssh.Client
	via       *ssh.Client // the jump host login, if any
	termType  string
	locale    string
	timezone  string
	keepalive int
	readOnly  bool
	username  string
}

func (p *terminalPlan) close() {
	if p == nil {
		return
	}
	p.client.Close()
	if p.via != nil {
		p.via.Close()
	}
}

// issueTerminalTicket signs in over SSH now, so a wrong password or a changed host key is reported before the
// terminal opens, and hands the open connection to a one-time ticket. It owns tgt.Via from here on.
func (s *Server) issueTerminalTicket(w http.ResponseWriter, r *http.Request, req sessionRequest, c *store.Connection, tgt *resolvedTarget,
	username string, material secrets.Material, credName, jumpName string) {
	keep := false
	defer func() {
		if !keep && tgt.Via != nil {
			tgt.Via.Close()
		}
	}()
	settings := defaultSSH()
	_ = decodeSettings(c.Settings, &settings)
	targetName := c.DeviceName + " / " + c.Name
	if settings.HostKey == "" {
		writeError(w, http.StatusBadGateway, "ssh_unreachable", "Could not reach the SSH server to read its host key. Check that it is on and SSH is enabled.")
		return
	}
	// Credentials typed by the user are used for this session only and never stored.
	if req.Username != "" {
		username = req.Username
	}
	if req.Password != "" {
		material = secrets.Material{Password: req.Password}
	}
	client, err := sshhelper.Dial(r.Context(), sshhelper.Target{Addr: tgt.Addr, Port: tgt.Port, Username: username, Secret: material,
		HostKey: settings.HostKey, Via: tgt.Via, Legacy: settings.AllowLegacyAlgorithms})
	if err != nil {
		code, status := "ssh_failed", http.StatusBadGateway
		msg := "Could not connect over SSH: " + err.Error()
		switch {
		case errors.Is(err, sshhelper.ErrNoCredentials):
			code, status, msg = "credentials_required", http.StatusUnprocessableEntity, "Enter the username and password for this server."
		case errors.Is(err, sshhelper.ErrAuthenticationBad):
			code, status, msg = "authentication_failed", http.StatusUnprocessableEntity, "Authentication failed. Check the username and password."
		case errors.Is(err, sshhelper.ErrHostKeyMismatch):
			code, msg = "host_key_mismatch", "The server's host key has changed since the first connection. If the server was reinstalled, accept the new key in the connection's security settings; otherwise someone may be impersonating it."
		}
		if code != "credentials_required" {
			s.audit(r, "session.start", "connection", c.ID, targetName, false,
				map[string]any{"protocol": c.Protocol, "username": username, "device_id": c.DeviceID, "reason": code})
		}
		writeError(w, status, code, msg)
		return
	}
	rec := s.newRecordingPlan(r.Context(), c.Protocol, c.DeviceID, "cast")
	tk := &ticket{
		sessionID:   sessionFrom(r.Context()).ID,
		user:        userFrom(r.Context()),
		conn:        c,
		target:      joinHostPort(tgt.Addr, tgt.Port),
		jumpName:    jumpName,
		recording:   rec,
		expires:     time.Now().Add(ticketTTL),
		clientIP:    s.clientIP(r),
		credentialN: credName,
		term: &terminalPlan{client: client, via: tgt.Via, termType: settings.TerminalType, locale: settings.Locale, timezone: req.Timezone,
			keepalive: settings.ServerAliveInterval, readOnly: settings.ReadOnly, username: username},
	}
	keep = true
	scheme, font, size := settings.ColorScheme, settings.FontName, settings.FontSize
	if p := req.Terminal; p != nil {
		if p.ColorScheme != "" {
			scheme = p.ColorScheme
		}
		if p.FontName != "" {
			font = p.FontName
		}
		if p.FontSize != 0 {
			size = p.FontSize
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket":     s.tickets.put(tk),
		"expires_in": int(ticketTTL.Seconds()),
		"protocol":   c.Protocol,
		"engine":     "terminal",
		"username":   username,
		"recording":  rec != nil,
		"terminal": map[string]any{
			"color_scheme": scheme, "font_name": font, "font_size": size, "scrollback": settings.Scrollback,
			"backspace": settings.Backspace, "read_only": settings.ReadOnly,
			"disable_copy": settings.DisableCopy, "disable_paste": settings.DisablePaste,
		},
	})
}

var terminalUpgrader = websocket.Upgrader{
	ReadBufferSize:  16 << 10,
	WriteBufferSize: 64 << 10,
	// Origin is enforced by the checkOrigin middleware (same-origin only).
	CheckOrigin: sameOrigin,
}

// termSize reads a terminal size, falling back to 80x24.
func termSize(cols, rows string) (int, int) {
	c, _ := strconv.Atoi(cols)
	r, _ := strconv.Atoi(rows)
	if c < 10 || c > 1000 || r < 4 || r > 500 {
		return 80, 24
	}
	return c, r
}

// wsWriter serializes writes to a WebSocket (gorilla allows one writer at a time).
type wsWriter struct {
	mu sync.Mutex
	c  *websocket.Conn
}

func (w *wsWriter) write(kind int, p []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(20 * time.Second))
	return w.c.WriteMessage(kind, p)
}

func (w *wsWriter) json(v any) error {
	b, _ := json.Marshal(v)
	return w.write(websocket.TextMessage, b)
}

func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	tk := s.tickets.take(r.URL.Query().Get("ticket"))
	sess := sessionFrom(r.Context())
	if tk == nil || tk.sessionID != sess.ID || tk.term == nil {
		if tk != nil {
			tk.release()
		}
		writeError(w, http.StatusForbidden, "invalid_ticket", "Invalid or expired session ticket")
		return
	}
	plan := tk.term
	defer plan.close()
	wsc, err := terminalUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // the upgrader already answered
	}
	defer wsc.Close()
	wsc.SetReadLimit(4 << 20) // a large paste arrives as one message
	out := &wsWriter{c: wsc}
	c := tk.conn
	targetName := c.DeviceName + " / " + c.Name
	details := map[string]any{"protocol": c.Protocol, "target": tk.target, "username": plan.username, "device_id": c.DeviceID, "terminal": "builtin"}
	if tk.credentialN != "" {
		details["credential"] = tk.credentialN
	}
	if tk.jumpName != "" {
		details["jump_host"] = tk.jumpName
	}
	cols, rows := termSize(r.URL.Query().Get("cols"), r.URL.Query().Get("rows"))

	fail := func(reason, msg string) {
		s.audit(r, "session.start", "connection", c.ID, targetName, false, merge(details, map[string]any{"reason": reason}))
		_ = out.json(map[string]any{"type": "exit", "status": -1, "reason": msg})
	}
	shell, err := plan.client.NewSession()
	if err != nil {
		fail("ssh session refused", "The server refused to open a session: "+err.Error())
		return
	}
	defer shell.Close()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 115200, ssh.TTY_OP_OSPEED: 115200}
	if err := shell.RequestPty(plan.termType, rows, cols, modes); err != nil {
		fail("no terminal", "The server did not give a terminal: "+err.Error())
		return
	}
	// Servers may refuse these (AcceptEnv); the session works without them.
	if plan.locale != "" {
		_ = shell.Setenv("LANG", plan.locale)
	}
	if plan.timezone != "" {
		_ = shell.Setenv("TZ", plan.timezone)
	}
	stdin, err := shell.StdinPipe()
	if err != nil {
		fail("ssh session failed", err.Error())
		return
	}
	stdout, _ := shell.StdoutPipe()
	stderr, _ := shell.StderrPipe()
	if err := shell.Shell(); err != nil {
		fail("no shell", "The server did not start a shell: "+err.Error())
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closedBy := "remote"
	var once sync.Once
	end := func(by string) {
		once.Do(func() {
			closedBy = by
			cancel()
		})
	}
	hub := newTermHub(cols, rows)
	defer hub.close()
	active := &ActiveSession{
		ID: auth.RandomToken(12), UserID: tk.user.ID, ConnectionID: c.ID, ConnectionName: c.Name, DeviceID: c.DeviceID,
		DeviceName: c.DeviceName, Protocol: c.Protocol, Username: tk.user.Username, ClientIP: tk.clientIP,
		StartedAt: time.Now(), Recording: tk.recording != nil, sessionID: tk.sessionID,
		// Ended from outside: an administrator, signing out, a password change or a vault check-in.
		cancel:        func() { end("terminated") },
		viewerCancels: map[int]context.CancelFunc{}, term: hub,
	}
	s.tunnels.add(active)
	defer s.tunnels.remove(active.ID)
	defer s.shares.revokeSession(active.ID)
	if c.DeviceID != "" {
		_ = s.store.TouchConnectionUsed(r.Context(), tk.user.ID, c.ID, c.DeviceID)
	}
	var rec *castRecorder
	if tk.recording != nil {
		rec, err = newCastRecorder(s.recordingFile(tk.recording.id), cols, rows, plan.termType, targetName, active.StartedAt)
		if err != nil {
			slog.Warn("terminal recording could not start; the session is not recorded", "error", err)
			active.Recording = false
		} else {
			s.beginRecording(r.Context(), tk.recording, active, active.StartedAt)
			details["recording_id"] = tk.recording.id
			defer s.endRecording(tk.recording)
			defer rec.close()
		}
	}
	s.audit(r, "session.start", "connection", c.ID, targetName, true, merge(details, map[string]any{"session_id": active.ID}))
	slog.Info("remote session started", "session", active.ID, "connection", c.ID, "protocol", c.Protocol, "terminal", "builtin")
	_ = out.json(map[string]any{"type": "ready", "session_id": active.ID, "recording": rec != nil})

	// Screen output: to the browser, the recording and any watchers.
	pump := func(src io.Reader) {
		buf := make([]byte, 32<<10)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				rec.output(chunk)
				hub.write(chunk)
				if werr := out.write(websocket.BinaryMessage, chunk); werr != nil {
					end("browser")
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go pump(stdout)
	go pump(stderr)

	// Keyboard and control messages from the browser.
	go func() {
		_ = wsc.SetReadDeadline(time.Now().Add(90 * time.Second))
		wsc.SetPongHandler(func(string) error { return wsc.SetReadDeadline(time.Now().Add(90 * time.Second)) })
		for {
			kind, msg, err := wsc.ReadMessage()
			if err != nil {
				end("user")
				return
			}
			_ = wsc.SetReadDeadline(time.Now().Add(90 * time.Second))
			switch kind {
			case websocket.BinaryMessage:
				if plan.readOnly || len(msg) == 0 {
					continue
				}
				if _, err := stdin.Write(msg); err != nil {
					end("remote")
					return
				}
			case websocket.TextMessage:
				var m struct {
					Type string `json:"type"`
					Cols int    `json:"cols"`
					Rows int    `json:"rows"`
				}
				if json.Unmarshal(msg, &m) != nil || m.Type != "resize" {
					continue
				}
				nc, nr := termSize(strconv.Itoa(m.Cols), strconv.Itoa(m.Rows))
				if nc != m.Cols || nr != m.Rows {
					continue
				}
				_ = shell.WindowChange(nr, nc)
				rec.resize(nc, nr)
				hub.resize(nc, nr)
			}
		}
	}()

	// The shell ending ends the session.
	exited := make(chan int, 1)
	go func() {
		err := shell.Wait()
		status := 0
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			status = exit.ExitStatus()
		}
		exited <- status
		end("remote")
	}()

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	flush := time.NewTicker(time.Second)
	defer flush.Stop()
	var alive <-chan time.Time
	if plan.keepalive > 0 {
		t := time.NewTicker(time.Duration(plan.keepalive) * time.Second)
		defer t.Stop()
		alive = t.C
	}
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ping.C:
			if out.write(websocket.PingMessage, nil) != nil {
				end("browser")
			}
		case <-flush.C:
			rec.flush()
		case <-alive:
			if _, _, err := plan.client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				end("remote")
			}
		}
	}
	status := 0
	if closedBy == "remote" {
		// Let the last output reach the browser before saying goodbye.
		time.Sleep(100 * time.Millisecond)
		select {
		case status = <-exited:
		default:
		}
	}
	reason := map[string]string{
		"remote":     "The session ended on the server.",
		"terminated": "emremote ended this session (an administrator, signing out or a vault check-in).",
	}[closedBy]
	_ = out.json(map[string]any{"type": "exit", "status": status, "reason": reason})
	_ = out.write(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))

	dur := time.Since(active.StartedAt).Round(time.Second)
	s.audit(r, "session.end", "connection", c.ID, targetName, true, map[string]any{"session_id": active.ID, "duration_s": int(dur.Seconds()),
		"closed_by": closedBy, "protocol": c.Protocol, "device_id": c.DeviceID, "exit_status": status})
	slog.Info("remote session ended", "session", active.ID, "duration", dur, "closed_by", closedBy)
}

// ---- Watchers ----

// termHub passes a terminal session's output to read-only watchers (shared sessions). It keeps the most recent
// output, so someone who joins late sees the current screen.
type termHub struct {
	mu         sync.Mutex
	backlog    []byte
	cols, rows int
	subs       map[chan hubMsg]struct{}
	closed     bool
}

type hubMsg struct {
	data       []byte
	cols, rows int // set for a size change
}

const hubBacklog = 256 << 10

func newTermHub(cols, rows int) *termHub {
	return &termHub{cols: cols, rows: rows, subs: map[chan hubMsg]struct{}{}}
}

func (h *termHub) send(m hubMsg) {
	for ch := range h.subs {
		select {
		case ch <- m:
		default: // a watcher that cannot keep up is dropped rather than slowing the session down
			delete(h.subs, ch)
			close(ch)
		}
	}
}

func (h *termHub) write(p []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.backlog = append(h.backlog, p...)
	if over := len(h.backlog) - hubBacklog; over > 0 {
		// Start at a line break where possible, so the backlog does not begin inside an escape sequence.
		if i := bytes.IndexByte(h.backlog[over:min(len(h.backlog), over+4096)], '\n'); i >= 0 {
			over += i + 1
		}
		h.backlog = append([]byte(nil), h.backlog[over:]...)
	}
	if len(h.subs) > 0 {
		h.send(hubMsg{data: append([]byte(nil), p...)})
	}
}

func (h *termHub) resize(cols, rows int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cols, h.rows = cols, rows
	h.send(hubMsg{cols: cols, rows: rows})
}

// subscribe returns a channel of new output plus what came before.
func (h *termHub) subscribe() (ch chan hubMsg, backlog []byte, cols, rows int, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, nil, 0, 0, false
	}
	ch = make(chan hubMsg, 256)
	h.subs[ch] = struct{}{}
	return ch, append([]byte(nil), h.backlog...), h.cols, h.rows, true
}

func (h *termHub) unsubscribe(ch chan hubMsg) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

func (h *termHub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for ch := range h.subs {
		delete(h.subs, ch)
		close(ch)
	}
}

// watchTerminal shows a shared built-in terminal session to a read-only watcher.
func (s *Server) watchTerminal(w http.ResponseWriter, r *http.Request, id string, a ActiveSession) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	key, _, ok := s.tunnels.addViewer(id, cancel)
	if !ok {
		writeError(w, http.StatusConflict, "unavailable", "The session has ended or already has the maximum number of viewers.")
		return
	}
	defer s.tunnels.removeViewer(id, key)
	ch, backlog, cols, rows, ok := a.term.subscribe()
	if !ok {
		writeError(w, http.StatusConflict, "unavailable", "The session has ended.")
		return
	}
	defer a.term.unsubscribe(ch)
	wsc, err := terminalUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer wsc.Close()
	out := &wsWriter{c: wsc}
	targetName := a.DeviceName + " / " + a.ConnectionName
	viewer := userFrom(r.Context())
	s.audit(r, "session.watch", "connection", a.ConnectionID, targetName, true,
		map[string]any{"session_id": id, "owner": a.Username, "viewer": viewer.Username, "device_id": a.DeviceID})
	start := time.Now()
	// Watchers only read; anything they send ends the read loop when they leave.
	go func() {
		for {
			if _, _, err := wsc.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()
	_ = out.json(map[string]any{"type": "size", "cols": cols, "rows": rows})
	if len(backlog) > 0 {
		_ = out.write(websocket.BinaryMessage, backlog)
	}
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ping.C:
			if out.write(websocket.PingMessage, nil) != nil {
				break loop
			}
		case m, open := <-ch:
			if !open {
				_ = out.json(map[string]any{"type": "exit", "reason": "The session has ended."})
				break loop
			}
			var err error
			if m.data != nil {
				err = out.write(websocket.BinaryMessage, m.data)
			} else {
				err = out.json(map[string]any{"type": "size", "cols": m.cols, "rows": m.rows})
			}
			if err != nil {
				break loop
			}
		}
	}
	s.audit(r, "session.watch.end", "connection", a.ConnectionID, targetName, true,
		map[string]any{"session_id": id, "viewer": viewer.Username, "duration_s": int(time.Since(start).Seconds()), "device_id": a.DeviceID})
}
