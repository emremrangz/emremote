package api

import "testing"

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
