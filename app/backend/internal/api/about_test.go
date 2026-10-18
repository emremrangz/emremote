package api

import "testing"

func TestPrettyOSName(t *testing.T) {
	in := "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\n"
	if got := prettyOSName(in); got != "Debian GNU/Linux 12 (bookworm)" {
		t.Fatalf("got %q", got)
	}
	if got := prettyOSName("NAME=x\n"); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := prettyOSName("PRETTY_NAME='Alpine Linux v3.22'"); got != "Alpine Linux v3.22" {
		t.Fatalf("got %q", got)
	}
}
