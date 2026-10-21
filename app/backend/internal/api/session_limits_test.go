package api

import (
	"testing"
	"time"
)

func TestValidateSessionLimits(t *testing.T) {
	ok := savedSessionLimits{IdleMinutes: 120, TTLMinutes: 720, RememberDays: 30}
	if msg := validateSessionLimits(ok); msg != "" {
		t.Fatalf("valid values rejected: %s", msg)
	}
	bad := []savedSessionLimits{
		{IdleMinutes: 1, TTLMinutes: 720, RememberDays: 30},
		{IdleMinutes: 120, TTLMinutes: 10, RememberDays: 30},
		{IdleMinutes: 600, TTLMinutes: 300, RememberDays: 30},
		{IdleMinutes: 120, TTLMinutes: 720, RememberDays: -1},
		{IdleMinutes: 120, TTLMinutes: 720, RememberDays: 400},
		{IdleMinutes: 20000, TTLMinutes: 720, RememberDays: 30},
	}
	for i, v := range bad {
		if validateSessionLimits(v) == "" {
			t.Errorf("case %d accepted: %+v", i, v)
		}
	}
}

func TestLimitsFromSaved(t *testing.T) {
	l := limitsFromSaved(savedSessionLimits{IdleMinutes: 30, TTLMinutes: 480, RememberDays: 3})
	if l.Idle != 30*time.Minute || l.TTL != 8*time.Hour || l.RememberTTL != 72*time.Hour {
		t.Fatalf("%+v", l)
	}
	if l.RememberIdle != 72*time.Hour { // never longer than the remembered lifetime
		t.Fatalf("remember idle %v", l.RememberIdle)
	}
	if off := limitsFromSaved(savedSessionLimits{IdleMinutes: 30, TTLMinutes: 480}); off.RememberTTL != 0 {
		t.Fatalf("remember should be off: %+v", off)
	}
}
