package api

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIncompleteTail(t *testing.T) {
	cases := []struct {
		in   []byte
		want int
	}{
		{[]byte("abc"), 0},
		{[]byte("ğ"), 0},      // complete two-byte character
		{[]byte("ğ")[:1], 1},  // its first byte only
		{[]byte("a€")[:3], 2}, // three-byte character cut after two bytes
		{[]byte("😀")[:3], 3},  // four-byte character cut after three bytes
		{[]byte{}, 0},
	}
	for _, c := range cases {
		if got := incompleteTail(c.in); got != c.want {
			t.Errorf("incompleteTail(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestCastRecorderWritesAsciicast(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rec")
	rec, err := newCastRecorder(path, 120, 40, "xterm-256color", "box / SSH", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	word := []byte("ğüş")
	rec.output([]byte("hello "))
	rec.output(word[:1]) // a character split between two reads
	rec.output(word[1:])
	rec.resize(100, 30)
	rec.output([]byte("\x1b[31mred\x1b[0m\r\n"))
	rec.close()

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan()
	var h castHeader
	if err := json.Unmarshal(sc.Bytes(), &h); err != nil || h.Version != 2 || h.Width != 120 || h.Height != 40 || h.Env["TERM"] != "xterm-256color" {
		t.Fatalf("header %s: %v", sc.Text(), err)
	}
	var text strings.Builder
	kinds := ""
	for sc.Scan() {
		var ev []any
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil || len(ev) != 3 {
			t.Fatalf("event %s: %v", sc.Text(), err)
		}
		kinds += ev[1].(string)
		if ev[1] == "o" {
			text.WriteString(ev[2].(string))
		} else if ev[2] != "100x30" {
			t.Fatalf("resize event %v", ev)
		}
	}
	if kinds != "ooro" { // the split character waits for its second half, so no empty event
		t.Fatalf("event kinds %q", kinds)
	}
	if text.String() != "hello ğüş\x1b[31mred\x1b[0m\r\n" {
		t.Fatalf("text %q", text.String())
	}
}

func TestCastRecorderNilIsSafe(t *testing.T) {
	var rec *castRecorder
	rec.output([]byte("x"))
	rec.resize(1, 1)
	rec.flush()
	rec.close()
}

func TestTermSize(t *testing.T) {
	if c, r := termSize("132", "50"); c != 132 || r != 50 {
		t.Fatal(c, r)
	}
	for _, bad := range [][2]string{{"", ""}, {"5", "50"}, {"80", "9999"}, {"x", "y"}} {
		if c, r := termSize(bad[0], bad[1]); c != 80 || r != 24 {
			t.Fatalf("%v gave %d x %d", bad, c, r)
		}
	}
}

func TestTermHubBacklogAndWatchers(t *testing.T) {
	h := newTermHub(80, 24)
	h.write([]byte("before\n"))
	ch, backlog, cols, rows, ok := h.subscribe()
	if !ok || string(backlog) != "before\n" || cols != 80 || rows != 24 {
		t.Fatalf("subscribe: %q %d %d %v", backlog, cols, rows, ok)
	}
	h.write([]byte("after"))
	h.resize(100, 30)
	if m := <-ch; string(m.data) != "after" {
		t.Fatalf("got %+v", m)
	}
	if m := <-ch; m.data != nil || m.cols != 100 || m.rows != 30 {
		t.Fatalf("got %+v", m)
	}
	// The backlog keeps only the most recent output.
	h.write([]byte(strings.Repeat("x", hubBacklog) + "\nend"))
	_, backlog, _, _, _ = h.subscribe()
	if len(backlog) > hubBacklog || !strings.HasSuffix(string(backlog), "end") {
		t.Fatalf("backlog of %d bytes", len(backlog))
	}
	h.close()
	for range ch { // the output still buffered, then the channel ends (or the test times out)
	}
	if _, _, _, _, ok := h.subscribe(); ok {
		t.Fatal("subscribed to a closed hub")
	}
}

func TestTermHubDropsSlowWatcher(t *testing.T) {
	h := newTermHub(80, 24)
	ch, _, _, _, _ := h.subscribe()
	for i := 0; i < 300; i++ { // more than the channel holds, nobody reading
		h.write([]byte("x"))
	}
	n := 0
	for range ch {
		n++
	}
	if n == 0 || n > 256 {
		t.Fatalf("slow watcher got %d messages before being dropped", n)
	}
}

func TestBuiltinTerminalDefault(t *testing.T) {
	if !builtinTerminal(nil) || !builtinTerminal(json.RawMessage(`{"terminal":"builtin"}`)) {
		t.Fatal("the built-in terminal is the default")
	}
	if builtinTerminal(json.RawMessage(`{"terminal":"gateway"}`)) {
		t.Fatal("gateway was not honoured")
	}
}
