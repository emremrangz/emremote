package api

import (
	"encoding/json"
	"strings"
	"testing"
)

const dev1 = "11111111-1111-4111-8111-111111111111"

func TestShouldRecord(t *testing.T) {
	c := defaultRecordingConfig()
	if c.shouldRecord("ssh", dev1) {
		t.Fatal("recording must be off until an administrator turns it on")
	}
	c.Enabled = true
	if !c.shouldRecord("rdp", dev1) {
		t.Fatal("record-all should record every protocol by default")
	}
	c.Protocols = []string{"ssh"}
	if c.shouldRecord("rdp", dev1) || !c.shouldRecord("ssh", dev1) {
		t.Fatal("protocol filter not applied")
	}
	c.Devices[dev1] = "on"
	if !c.shouldRecord("rdp", dev1) {
		t.Fatal("a device set to on is always recorded")
	}
	c.Devices[dev1] = "off"
	if c.shouldRecord("ssh", dev1) {
		t.Fatal("a device set to off is never recorded")
	}
	c.RecordAll = false
	c.Devices = map[string]string{}
	if c.shouldRecord("ssh", dev1) {
		t.Fatal("only chosen devices are recorded when record-all is off")
	}
	c.Enabled = false
	c.Devices[dev1] = "on"
	if c.shouldRecord("ssh", dev1) {
		t.Fatal("the master switch wins over a device exception")
	}
}

func TestValidateRecordingConfig(t *testing.T) {
	bad := []recordingConfig{
		{RetentionDays: -1},
		{MaxGB: -1},
		{Protocols: []string{"ftp"}},
		{Devices: map[string]string{"nope": "on"}},
		{Devices: map[string]string{dev1: "maybe"}},
	}
	for i, c := range bad {
		if validateRecordingConfig(&c) == "" {
			t.Errorf("case %d should be refused", i)
		}
	}
	ok := recordingConfig{Protocols: []string{"rdp", "ssh", "ssh"}, Devices: map[string]string{dev1: "off"}}
	if msg := validateRecordingConfig(&ok); msg != "" || len(ok.Protocols) != 2 {
		t.Fatalf("valid config refused or not normalized: %q %v", msg, ok.Protocols)
	}
}

func TestStorageKind(t *testing.T) {
	for in, want := range map[string]string{"nfs4": "nfs", "nfs": "nfs", "cifs": "smb", "smb3": "smb", "ext4": "volume", "overlay": "volume"} {
		if got := storageKind(in); got != want {
			t.Errorf("%s: got %s want %s", in, got, want)
		}
	}
}

func TestRecordingShareValidation(t *testing.T) {
	c := defaultRecordingConfig()
	if validateRecordingConfig(&c) != "" || c.Storage.Kind != "local" {
		t.Fatal("the default (this server) must be valid")
	}
	good := defaultRecordingConfig()
	good.Storage = recordingTarget{Kind: "smb", Host: "nas.lan", Share: "recordings", Dir: "emremote", Username: "u"}
	if msg := validateRecordingConfig(&good); msg != "" {
		t.Fatalf("a valid share refused: %s", msg)
	}
	for name, mod := range map[string]func(*recordingTarget){
		"unknown kind":   func(t *recordingTarget) { t.Kind = "ftp" },
		"no host":        func(t *recordingTarget) { t.Host = "" },
		"path in dir":    func(t *recordingTarget) { t.Dir = "../x" },
		"dots as dir":    func(t *recordingTarget) { t.Dir = ".." },
		"slash in share": func(t *recordingTarget) { t.Share = "a/b" },
	} {
		c := defaultRecordingConfig()
		c.Storage = recordingTarget{Kind: "smb", Host: "nas.lan", Share: "recordings"}
		mod(&c.Storage)
		if validateRecordingConfig(&c) == "" {
			t.Errorf("%s should be refused", name)
		}
	}
}

func TestShareSecretNeverInSavedSettings(t *testing.T) {
	c := defaultRecordingConfig()
	c.Storage = recordingTarget{Kind: "smb", Host: "h", Share: "s", Password: "hunter2", HasPassword: true}
	c.Storage.Password, c.Storage.HasPassword = "", false
	raw, _ := json.Marshal(c)
	if strings.Contains(string(raw), "hunter2") || strings.Contains(string(raw), `"password"`) {
		t.Fatalf("password leaked into the saved settings: %s", raw)
	}
}
