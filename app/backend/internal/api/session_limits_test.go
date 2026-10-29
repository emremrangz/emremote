package api

import (
	"testing"
	"time"
)

func TestValidateSessionLimits(t *testing.T) {
	ok := savedSessionLimits{IdleMinutes: 120, TTLMinutes: 720}
	if msg := validateSessionLimits(ok); msg != "" {
		t.Fatalf("valid values rejected: %s", msg)
	}
	bad := []savedSessionLimits{
		{IdleMinutes: 1, TTLMinutes: 720},
		{IdleMinutes: 120, TTLMinutes: 10},
		{IdleMinutes: 600, TTLMinutes: 300},
		{IdleMinutes: 20000, TTLMinutes: 720},
	}
	for i, v := range bad {
		if validateSessionLimits(v) == "" {
			t.Errorf("case %d accepted: %+v", i, v)
		}
	}
}

func TestLimitsFromSaved(t *testing.T) {
	l := limitsFromSaved(savedSessionLimits{IdleMinutes: 30, TTLMinutes: 480})
	if l.Idle != 30*time.Minute || l.TTL != 8*time.Hour {
		t.Fatalf("%+v", l)
	}
}
