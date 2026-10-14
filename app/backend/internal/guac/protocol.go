// Package guac implements the subset of the Apache Guacamole protocol needed to
// act as a tunnel between guacamole-common-js in the browser and guacd.
//
// Protocol reference: https://guacamole.apache.org/doc/gug/guacamole-protocol.html
// Instructions are "LEN.VALUE,LEN.VALUE,...;" where LEN counts Unicode code
// points (not bytes) of VALUE, and the first element is the opcode.
package guac

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxInstructionBytes bounds a single instruction to protect memory. guacd
// splits large images into blobs well below this size.
const MaxInstructionBytes = 8 << 20

var ErrMalformed = errors.New("malformed guacamole instruction")

type Instruction struct {
	Opcode string
	Args   []string
}

func NewInstruction(opcode string, args ...string) Instruction {
	return Instruction{Opcode: opcode, Args: args}
}

func writeElement(b *strings.Builder, s string) {
	b.WriteString(strconv.Itoa(utf8.RuneCountInString(s)))
	b.WriteByte('.')
	b.WriteString(s)
}

func (i Instruction) String() string {
	var b strings.Builder
	writeElement(&b, i.Opcode)
	for _, a := range i.Args {
		b.WriteByte(',')
		writeElement(&b, a)
	}
	b.WriteByte(';')
	return b.String()
}

// Reader reads whole instructions from a stream, returning both the parsed
// instruction and its raw encoded bytes (so they can be forwarded verbatim).
type Reader struct {
	r   *bufio.Reader
	buf []byte
}

func NewReader(r io.Reader) *Reader {
	return &Reader{r: bufio.NewReaderSize(r, 64<<10)}
}

// Buffered reports bytes available without blocking.
func (r *Reader) Buffered() int { return r.r.Buffered() }

// ReadRaw reads one instruction and returns its raw bytes. The returned slice
// is only valid until the next call.
func (r *Reader) ReadRaw() ([]byte, error) {
	r.buf = r.buf[:0]
	for {
		// length prefix
		n := 0
		digits := 0
		for {
			c, err := r.r.ReadByte()
			if err != nil {
				return nil, err
			}
			r.buf = append(r.buf, c)
			if c == '.' {
				break
			}
			if c < '0' || c > '9' || digits >= 9 {
				return nil, ErrMalformed
			}
			n = n*10 + int(c-'0')
			digits++
		}
		if digits == 0 {
			return nil, ErrMalformed
		}
		if len(r.buf)+n > MaxInstructionBytes {
			return nil, fmt.Errorf("%w: instruction too large", ErrMalformed)
		}
		// Read n code points. Every rune is at least one byte, so reading the
		// number of runes still missing never overshoots; afterwards complete
		// any multi-byte rune cut off at the end and recount.
		start := len(r.buf)
		remaining := n
		for remaining > 0 {
			l := len(r.buf)
			r.buf = append(r.buf, make([]byte, remaining)...)
			if _, err := io.ReadFull(r.r, r.buf[l:]); err != nil {
				return nil, err
			}
			for !fullRunesAtEnd(r.buf[start:]) {
				c, err := r.r.ReadByte()
				if err != nil {
					return nil, err
				}
				r.buf = append(r.buf, c)
			}
			remaining = n - utf8.RuneCount(r.buf[start:])
			if remaining < 0 {
				return nil, ErrMalformed
			}
		}
		term, err := r.r.ReadByte()
		if err != nil {
			return nil, err
		}
		r.buf = append(r.buf, term)
		switch term {
		case ';':
			return r.buf, nil
		case ',':
			continue
		default:
			return nil, ErrMalformed
		}
	}
}

// fullRunesAtEnd reports whether b does not end in the middle of a UTF-8 sequence.
func fullRunesAtEnd(b []byte) bool {
	// Walk back to the start of the last rune.
	i := len(b) - 1
	for i > 0 && len(b)-i < utf8.UTFMax && !utf8.RuneStart(b[i]) {
		i--
	}
	return utf8.FullRune(b[i:])
}

// Read reads and parses one instruction.
func (r *Reader) Read() (Instruction, error) {
	raw, err := r.ReadRaw()
	if err != nil {
		return Instruction{}, err
	}
	return Parse(raw)
}

// Parse decodes a single complete instruction.
func Parse(raw []byte) (Instruction, error) {
	ins, rest, err := parseOne(string(raw))
	if err != nil {
		return Instruction{}, err
	}
	if rest != "" {
		return Instruction{}, ErrMalformed
	}
	return ins, nil
}

// ParseAll decodes a buffer containing one or more complete instructions.
func ParseAll(s string) ([]Instruction, error) {
	var out []Instruction
	for s != "" {
		ins, rest, err := parseOne(s)
		if err != nil {
			return nil, err
		}
		out = append(out, ins)
		s = rest
	}
	return out, nil
}

func parseOne(s string) (Instruction, string, error) {
	var elems []string
	for {
		dot := strings.IndexByte(s, '.')
		if dot <= 0 || dot > 9 {
			return Instruction{}, "", ErrMalformed
		}
		n, err := strconv.Atoi(s[:dot])
		if err != nil || n < 0 {
			return Instruction{}, "", ErrMalformed
		}
		s = s[dot+1:]
		// advance n runes
		i := 0
		for k := 0; k < n; k++ {
			if i >= len(s) {
				return Instruction{}, "", ErrMalformed
			}
			_, size := utf8.DecodeRuneInString(s[i:])
			i += size
		}
		if i >= len(s) {
			return Instruction{}, "", ErrMalformed
		}
		elems = append(elems, s[:i])
		term := s[i]
		s = s[i+1:]
		if term == ';' {
			return Instruction{Opcode: elems[0], Args: elems[1:]}, s, nil
		}
		if term != ',' {
			return Instruction{}, "", ErrMalformed
		}
	}
}
