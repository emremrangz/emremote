package api

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
)

// castRecorder writes a built-in terminal session as an asciicast v2 file: a JSON header line, then one line per
// event. Only what the server sends to the screen is written ("o" events) plus size changes ("r"); the keyboard is
// never recorded, like the gateway's recordings, so a password typed at a prompt that does not echo is not captured.
type castRecorder struct {
	mu    sync.Mutex
	f     *os.File
	w     *bufio.Writer
	start time.Time
	// carry holds the start of a UTF-8 character cut off at the end of the last chunk.
	carry []byte
}

type castHeader struct {
	Version   int               `json:"version"`
	Width     int               `json:"width"`
	Height    int               `json:"height"`
	Timestamp int64             `json:"timestamp"`
	Title     string            `json:"title,omitempty"`
	Env       map[string]string `json:"env"`
}

func newCastRecorder(path string, cols, rows int, term, title string, start time.Time) (*castRecorder, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return nil, err
	}
	c := &castRecorder{f: f, w: bufio.NewWriterSize(f, 64<<10), start: start}
	h, _ := json.Marshal(castHeader{Version: 2, Width: cols, Height: rows, Timestamp: start.Unix(), Title: title, Env: map[string]string{"TERM": term}})
	c.w.Write(h)
	c.w.WriteByte('\n')
	return c, nil
}

// incompleteTail returns how many bytes at the end of p start a UTF-8 character that is not complete yet.
func incompleteTail(p []byte) int {
	for i := len(p) - 1; i >= 0 && i >= len(p)-utf8.UTFMax; i-- {
		b := p[i]
		if b < 0x80 {
			return 0 // ASCII: nothing pending
		}
		if b >= 0xC0 { // the first byte of a multi-byte character
			need := 2
			switch {
			case b >= 0xF0:
				need = 4
			case b >= 0xE0:
				need = 3
			}
			if len(p)-i < need {
				return len(p) - i
			}
			return 0
		}
	}
	return 0
}

func (c *castRecorder) event(kind, data string) {
	t := strconv.FormatFloat(time.Since(c.start).Seconds(), 'f', 6, 64)
	s, _ := json.Marshal(data) // invalid bytes become U+FFFD, so the file stays valid JSON
	c.w.WriteString("[" + t + `, "` + kind + `", `)
	c.w.Write(s)
	c.w.WriteString("]\n")
}

// output records what the server sent to the screen.
func (c *castRecorder) output(p []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	data := append(c.carry, p...)
	cut := len(data) - incompleteTail(data)
	c.carry = append([]byte(nil), data[cut:]...)
	if cut > 0 {
		c.event("o", string(data[:cut]))
	}
}

// resize records a new terminal size.
func (c *castRecorder) resize(cols, rows int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.event("r", strconv.Itoa(cols)+"x"+strconv.Itoa(rows))
}

func (c *castRecorder) flush() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.w.Flush()
}

func (c *castRecorder) close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.carry) > 0 {
		c.event("o", string(c.carry))
		c.carry = nil
	}
	c.w.Flush()
	c.f.Close()
}
