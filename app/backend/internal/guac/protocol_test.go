package guac

import (
	"bytes"
	"strings"
	"testing"
	"testing/iotest"
)

func TestInstructionRoundTrip(t *testing.T) {
	ins := NewInstruction("clipboard", "1", "text/plain", "çğüşİ 漢字 😀", "")
	enc := ins.String()
	want := "9.clipboard,1.1,10.text/plain,10.çğüşİ 漢字 😀,0.;"
	if enc != want {
		t.Fatalf("encode: got %q want %q", enc, want)
	}
	got, err := Parse([]byte(enc))
	if err != nil {
		t.Fatal(err)
	}
	if got.Opcode != ins.Opcode || strings.Join(got.Args, "|") != strings.Join(ins.Args, "|") {
		t.Fatalf("roundtrip mismatch: %#v", got)
	}
}

func TestReaderStreamsAcrossChunkBoundaries(t *testing.T) {
	stream := NewInstruction("size", "0", "1024", "768").String() +
		NewInstruction("name", "Ünïcödé ✓ 😀😀").String() +
		NewInstruction("", "ping", "123").String()
	// OneByteReader forces every multi-byte rune to be split across reads.
	r := NewReader(iotest.OneByteReader(strings.NewReader(stream)))
	var out bytes.Buffer
	for i := 0; i < 3; i++ {
		raw, err := r.ReadRaw()
		if err != nil {
			t.Fatalf("instruction %d: %v", i, err)
		}
		out.Write(raw)
	}
	if out.String() != stream {
		t.Fatalf("got %q want %q", out.String(), stream)
	}
}

func TestReaderRejectsMalformed(t *testing.T) {
	for _, s := range []string{"x.abc;", "3.ab;", "3.abcd;", "4.size,1.0:", ".;", "9999999999.a;"} {
		_, err := NewReader(strings.NewReader(s)).Read()
		if err == nil {
			t.Errorf("%q: expected error", s)
		}
	}
}

func TestParseAll(t *testing.T) {
	ins, err := ParseAll("3.key,5.65307,1.1;5.mouse,2.10,2.20,1.0;")
	if err != nil || len(ins) != 2 || ins[1].Opcode != "mouse" || ins[1].Args[1] != "20" {
		t.Fatalf("unexpected: %v %#v", err, ins)
	}
	if _, err := ParseAll("3.key,5.65307,1.1"); err == nil {
		t.Fatal("expected error for unterminated instruction")
	}
}
