package api

import (
	"fmt"
	"strings"
	"testing"
)

func TestDetectFormat(t *testing.T) {
	for in, want := range map[string]string{
		`{"format":"emremote-inventory"}`:            "emremote",
		"# my hosts\n\nHost web\n  HostName 1.2.3.4": "ssh-config",
		"name,address\nweb,10.0.0.1":                 "csv",
		"\ufeffname,address\nweb,10.0.0.1":           "csv",
	} {
		if got := detectFormat(in); got != want {
			t.Errorf("%q: got %s want %s", in, got, want)
		}
	}
}

func TestParseSSHConfig(t *testing.T) {
	p, err := parseImport("auto", `
# comment
Host *
  ServerAliveInterval 30
Host web db
  HostName 10.0.0.5
  Port 2222
  User deploy
  ProxyJump bastion
Host bastion
  User root
Host=eq
  HostName=10.0.0.9
Match host x
  User nobody
`)
	if err != nil {
		t.Fatal(err)
	}
	if p.Format != "ssh-config" || len(p.Devices) != 4 {
		t.Fatalf("%s %d devices: %+v", p.Format, len(p.Devices), p.Devices)
	}
	web, bastion := p.Devices[0], p.Devices[2]
	if web.Name != "web" || web.Address != "10.0.0.5" || web.Connections[0].Port != 2222 || web.Connections[0].Username != "deploy" {
		t.Errorf("web: %+v", web)
	}
	if bastion.Address != "bastion" || bastion.Connections[0].Port != 22 {
		t.Errorf("host without HostName falls back to the alias: %+v", bastion)
	}
	if len(p.Warnings) != 2 {
		t.Errorf("warnings: %v", p.Warnings)
	}
}

func TestParseCSV(t *testing.T) {
	p, err := parseImport("csv", "Name, Address, OS, Protocol, Port, Username, Group, Tags\nweb,10.0.0.1,linux,ssh,22,root,Prod,a;b\nweb,10.0.0.1,linux,vnc,5900,,Prod,a;b\nnas,10.0.0.2,,,,,,\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Devices) != 2 || len(p.Devices[0].Connections) != 2 || len(p.Devices[1].Connections) != 0 {
		t.Fatalf("%+v", p.Devices)
	}
	if d := p.Devices[0]; d.Group != "Prod" || len(d.Tags) != 2 || d.Connections[1].Protocol != "vnc" {
		t.Errorf("%+v", d)
	}
	if p.Devices[1].OS != "other" {
		t.Error("missing OS defaults to other")
	}
	for name, bad := range map[string]string{
		"unknown column": "name,address,password\nx,1.2.3.4,secret",
		"no address":     "name\nx",
		"bad port":       "name,address,protocol,port\nx,1.2.3.4,ssh,abc",
	} {
		if _, err := parseImport("csv", bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseEmremoteJSON(t *testing.T) {
	ok := `{"format":"emremote-inventory","version":1,"groups":[{"name":"Lab","description":""}],"devices":[{"name":"a","address":"10.0.0.1","os":"linux","device_type":"server","tags":[],"group":"Lab","connections":[{"name":"SSH","protocol":"ssh","port":22,"username":"u","domain":""}]}]}`
	p, err := parseImport("auto", ok)
	if err != nil || len(p.Devices) != 1 || p.Groups[0].Name != "Lab" {
		t.Fatalf("%v %+v", err, p)
	}
	for name, bad := range map[string]string{
		"wrong format":  `{"format":"other","version":1,"devices":[]}`,
		"wrong version": `{"format":"emremote-inventory","version":2,"devices":[]}`,
		"secret field":  `{"format":"emremote-inventory","version":1,"devices":[{"name":"a","address":"1.2.3.4","password":"x"}]}`,
		"empty":         `{"format":"emremote-inventory","version":1,"devices":[]}`,
	} {
		if _, err := parseImport("emremote", bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := parseImport("auto", "   "); err == nil {
		t.Error("empty input")
	}
	var b strings.Builder
	b.WriteString("name,address\n")
	for i := 0; i <= maxImportDevices; i++ {
		fmt.Fprintf(&b, "d%d,10.0.0.1\n", i)
	}
	if _, err := parseImport("csv", b.String()); err == nil {
		t.Error("device limit")
	}
}
