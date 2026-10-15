package sshhelper

import (
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestApplyLegacyKeepsModernFirst(t *testing.T) {
	cfg := &ssh.ClientConfig{}
	ApplyLegacy(cfg)
	strong, weak := ssh.SupportedAlgorithms(), ssh.InsecureAlgorithms()
	if cfg.KeyExchanges[0] != strong.KeyExchanges[0] || cfg.Ciphers[0] != strong.Ciphers[0] || cfg.MACs[0] != strong.MACs[0] {
		t.Fatal("modern algorithms must stay first")
	}
	if len(cfg.KeyExchanges) != len(strong.KeyExchanges)+len(weak.KeyExchanges) || len(weak.KeyExchanges) == 0 {
		t.Fatal("weak key exchanges were not appended")
	}
	if len(cfg.Ciphers) <= len(strong.Ciphers) || len(cfg.MACs) <= len(strong.MACs) {
		t.Fatal("weak ciphers/MACs were not appended")
	}
}
