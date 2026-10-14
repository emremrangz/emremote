package guac

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Guacamole status codes used when closing tunnels (see Guacamole.Status.Code).
const (
	StatusSuccess          = 0x0000
	StatusServerError      = 0x0200
	StatusUpstreamNotFound = 0x0207
	StatusSessionClosed    = 0x020B
)

const (
	handshakeTimeout           = 15 * time.Second
	wsWriteTimeout             = 30 * time.Second
	wsReadTimeout              = 30 * time.Second // the browser client pings every 500 ms
	maxBatchBytes              = 256 << 10
	protocolVersionPlaceholder = "VERSION_1_5_0"
)

// HandshakeParams describes a connection to be established through guacd.
type HandshakeParams struct {
	Protocol string
	// Values maps guacd parameter names to values. Unknown names are ignored
	// by construction: only names guacd advertises in "args" are sent.
	Values   map[string]string
	Width    int
	Height   int
	DPI      int
	Audio    []string
	Video    []string
	Image    []string
	Timezone string
}

// GuacdError is an error reported by guacd during the handshake.
type GuacdError struct {
	Message string
	Status  int
}

func (e *GuacdError) Error() string { return fmt.Sprintf("guacd: %s (status %d)", e.Message, e.Status) }

// Handshake performs the Guacamole client handshake on conn and returns a
// reader positioned after the "ready" instruction plus guacd's connection id.
func Handshake(conn net.Conn, p HandshakeParams) (*Reader, string, error) {
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	defer conn.SetDeadline(time.Time{}) //nolint:errcheck

	r := NewReader(conn)
	send := func(ins Instruction) error {
		_, err := conn.Write([]byte(ins.String()))
		return err
	}

	if err := send(NewInstruction("select", p.Protocol)); err != nil {
		return nil, "", err
	}
	args, err := expect(r, "args")
	if err != nil {
		return nil, "", err
	}

	steps := []Instruction{
		NewInstruction("size", strconv.Itoa(p.Width), strconv.Itoa(p.Height), strconv.Itoa(p.DPI)),
		NewInstruction("audio", p.Audio...),
		NewInstruction("video", p.Video...),
		NewInstruction("image", p.Image...),
	}
	if p.Timezone != "" {
		steps = append(steps, NewInstruction("timezone", p.Timezone))
	}
	values := make([]string, len(args.Args))
	for i, name := range args.Args {
		if strings.HasPrefix(name, "VERSION_") {
			values[i] = protocolVersionPlaceholder
			continue
		}
		values[i] = p.Values[name]
	}
	steps = append(steps, NewInstruction("connect", values...))
	var b strings.Builder
	for _, s := range steps {
		b.WriteString(s.String())
	}
	if _, err := conn.Write([]byte(b.String())); err != nil {
		return nil, "", err
	}

	ready, err := expect(r, "ready")
	if err != nil {
		return nil, "", err
	}
	if len(ready.Args) == 0 {
		return nil, "", ErrMalformed
	}
	return r, ready.Args[0], nil
}

func expect(r *Reader, opcode string) (Instruction, error) {
	ins, err := r.Read()
	if err != nil {
		return ins, fmt.Errorf("guacd handshake: %w", err)
	}
	if ins.Opcode == "error" {
		ge := &GuacdError{Message: "unknown error", Status: StatusServerError}
		if len(ins.Args) > 0 {
			ge.Message = ins.Args[0]
		}
		if len(ins.Args) > 1 {
			if n, err := strconv.Atoi(ins.Args[1]); err == nil {
				ge.Status = n
			}
		}
		return ins, ge
	}
	if ins.Opcode != opcode {
		return ins, fmt.Errorf("guacd handshake: expected %q, got %q", opcode, ins.Opcode)
	}
	return ins, nil
}

// clientOpcodes are the instructions a browser client may send to guacd.
// Anything else (including handshake opcodes) is dropped.
var clientOpcodes = map[string]bool{
	"ack": true, "argv": true, "blob": true, "clipboard": true, "disconnect": true, "end": true,
	"key": true, "mouse": true, "nop": true, "size": true, "sync": true, "touch": true,
}

// WSConn serializes writes to a websocket connection.
type WSConn struct {
	*websocket.Conn
	mu sync.Mutex
}

func (c *WSConn) WriteText(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return c.WriteMessage(websocket.TextMessage, b)
}

// SendErrorAndClose reports a failure to guacamole-common-js: it sends an
// "error" instruction and closes the socket with the numeric status as reason,
// which is how the official client derives the status code.
func (c *WSConn) SendErrorAndClose(message string, status int) {
	_ = c.WriteText([]byte(NewInstruction("error", message, strconv.Itoa(status)).String()))
	c.Close(status)
}

func (c *WSConn) Close(status int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	code := websocket.CloseNormalClosure
	reason := ""
	if status != StatusSuccess {
		reason = strconv.Itoa(status)
		code = websocket.CloseInternalServerErr
	}
	_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	_ = c.Conn.Close()
}

// Result summarizes a finished tunnel.
type Result struct {
	ClosedBy string // "client", "server", "terminated"
	Error    string // last error reported by guacd, if any
}

// Proxy relays instructions between the browser and guacd until either side
// closes or ctx is cancelled. guacd output is forwarded in batches of whole
// instructions so the browser never receives a partial instruction.
func Proxy(ctx context.Context, ws *WSConn, guacd net.Conn, r *Reader, tunnelID string, allowResize bool) Result {
	return proxy(ctx, ws, guacd, r, tunnelID, allowResize, clientOpcodes)
}

// viewerOpcodes are all a view-only participant may send: keepalive and
// flow-control acknowledgements, never input, clipboard or resize.
var viewerOpcodes = map[string]bool{"ack": true, "nop": true, "sync": true, "disconnect": true}

// ProxyViewer relays a read-only participant of a shared session. Input is dropped here as well as by guacd.
func ProxyViewer(ctx context.Context, ws *WSConn, guacd net.Conn, r *Reader, tunnelID string) Result {
	return proxy(ctx, ws, guacd, r, tunnelID, false, viewerOpcodes)
}

func proxy(ctx context.Context, ws *WSConn, guacd net.Conn, r *Reader, tunnelID string, allowResize bool, ops map[string]bool) Result {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		once   sync.Once
		result Result
		mu     sync.Mutex
	)
	finish := func(by string) {
		once.Do(func() {
			mu.Lock()
			result.ClosedBy = by
			mu.Unlock()
			cancel()
		})
	}

	// Announce the tunnel UUID (internal instruction with empty opcode).
	if err := ws.WriteText([]byte(NewInstruction("", tunnelID).String())); err != nil {
		return Result{ClosedBy: "client"}
	}

	// guacd -> browser
	go func() {
		batch := make([]byte, 0, 64<<10)
		for {
			raw, err := r.ReadRaw()
			if err != nil {
				finish("server")
				return
			}
			if len(raw) > 7 && string(raw[:8]) == "5.error," {
				if ins, perr := Parse(raw); perr == nil && len(ins.Args) > 0 {
					mu.Lock()
					result.Error = ins.Args[0]
					mu.Unlock()
				}
			}
			batch = append(batch, raw...)
			if r.Buffered() == 0 || len(batch) >= maxBatchBytes {
				if err := ws.WriteText(batch); err != nil {
					finish("client")
					return
				}
				batch = batch[:0]
			}
		}
	}()

	// browser -> guacd
	go func() {
		for {
			_ = ws.SetReadDeadline(time.Now().Add(wsReadTimeout))
			mt, msg, err := ws.ReadMessage()
			if err != nil {
				finish("client")
				return
			}
			if mt != websocket.TextMessage {
				continue
			}
			instructions, err := ParseAll(string(msg))
			if err != nil {
				finish("client")
				return
			}
			var out strings.Builder
			for _, ins := range instructions {
				if ins.Opcode == "" {
					// Internal tunnel instruction; answer pings, drop the rest.
					if len(ins.Args) > 0 && ins.Args[0] == "ping" {
						_ = ws.WriteText([]byte(ins.String()))
					}
					continue
				}
				if !ops[ins.Opcode] || (ins.Opcode == "size" && !allowResize) {
					continue
				}
				out.WriteString(ins.String())
			}
			if out.Len() > 0 {
				_ = guacd.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
				if _, err := guacd.Write([]byte(out.String())); err != nil {
					finish("server")
					return
				}
			}
		}
	}()

	<-ctx.Done()
	finish("terminated") // no-op if a side already finished
	_ = guacd.Close()
	mu.Lock()
	res := result
	mu.Unlock()
	status := StatusSuccess
	if res.ClosedBy == "terminated" {
		status = StatusSessionClosed
	}
	ws.Close(status)
	return res
}
