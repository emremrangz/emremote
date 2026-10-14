package sshhelper

import (
	"strings"
	"testing"
)

const linuxSample = `@@hostname
web-01
@@os
Debian GNU/Linux 12 (bookworm)
@@kernel
6.1.0-18-amd64
@@arch
x86_64
@@uptime
86523.42 170000.10
@@loadavg
0.52 0.40 0.31 1/234 5678
@@cpus
4
@@cpumodel
 Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
@@stat1
cpu  1000 0 500 8000 500 0 0 0 0 0
@@stat2
cpu  1100 0 550 8300 550 0 0 0 0 0
@@meminfo
MemTotal:        8000000 kB
MemFree:          500000 kB
MemAvailable:    6000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
@@df
Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         41152736 20576368  18463192      53% /
tmpfs              4000000        0   4000000       0% /dev/shm
/dev/sdb1        976762584 488381292 488381292     50% /srv/data files
/dev/sda1         41152736 20576368  18463192      53% /etc/hostname
overlay           41152736 20576368  18463192      53% /var/lib/docker/overlay2/x/merged
@@ps
    PID %CPU %MEM COMMAND
   1234 12.5  3.1 postgres
      1  0.0  0.1 systemd
@@logsource
systemd journal (warnings and errors)
@@logs
2026-10-13T10:00:01+0000 web-01 kernel: EXT4-fs warning: mounting fs with errors
-- No entries --
2026-10-13T10:05:00+0000 web-01 sshd[1]: error: kex_exchange_identification
`

func TestParseLinux(t *testing.T) {
	i := ParseLinux(linuxSample)
	if i.Hostname != "web-01" || i.OS != "Debian GNU/Linux 12 (bookworm)" || i.UptimeSeconds != 86523 || i.CPU.Cores != 4 {
		t.Fatalf("basic fields: %+v", i)
	}
	// 500 ticks elapsed, 350 of them idle or iowait: 30% busy.
	if i.CPU.UsagePercent == nil || *i.CPU.UsagePercent < 29.9 || *i.CPU.UsagePercent > 30.1 {
		t.Fatalf("cpu usage: %v", *i.CPU.UsagePercent)
	}
	if i.Memory.TotalBytes != 8000000*1024 || i.Memory.UsedBytes != 2000000*1024 || i.Memory.SwapUsedBytes != 500000*1024 {
		t.Fatalf("memory: %+v", i.Memory)
	}
	if len(i.Disks) != 2 || i.Disks[1].Mount != "/srv/data files" {
		t.Fatalf("disks: %+v", i.Disks)
	}
	if len(i.Processes) != 2 || i.Processes[0].Name != "postgres" || *i.Processes[0].CPUPercent != 12.5 {
		t.Fatalf("procs: %+v", i.Processes)
	}
	if len(i.Logs) != 2 || i.Logs[1].Level != "error" || i.Logs[0].Level != "warning" {
		t.Fatalf("logs: %+v", i.Logs)
	}
}

func TestRawLogsTrustsSyslogSeverity(t *testing.T) {
	l := rawLogs("Oct 13 14:54:24 h daemon.info xrdp[1]: [INFO ] caps: error 0\nOct 13 14:54:25 h daemon.err xrdp[1]: [ERROR] failed\nOct 13 h daemon.warn x: low disk")
	if len(l) != 2 || l[0].Level != "err" || l[1].Level != "warn" {
		t.Fatalf("got %+v", l)
	}
}

func TestParseMac(t *testing.T) {
	out := `@@hostname
mbp
@@os
macOS 15.1
@@kernel
24.1.0
@@cpus
10
@@cpumodel
Apple M1 Pro
@@cpuusage
CPU usage: 7.50% user, 5.00% sys, 87.50% idle
@@memsize
17179869184
@@vmstat
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               100000.
Pages active:                             300000.
Pages wired down:                         100000.
Pages occupied by compressor:              50000.
@@swap
total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)
@@df
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   971350180  10000000 500000000     2%    /
devfs                  200       200         0   100%    /dev
/dev/disk3s5     971350180 400000000 500000000    45%    /System/Volumes/Data
map auto_home            0         0         0   100%    /System/Volumes/Data/home
@@ps
  PID  %CPU %MEM COMM
  500  25.0  4.0 WindowServer
`
	i := ParseMac(out)
	if *i.CPU.UsagePercent != 12.5 || i.Memory.UsedBytes != 450000*16384 || i.Memory.SwapUsedBytes != 512*1024*1024 {
		t.Fatalf("mac parse: cpu=%v mem=%+v", *i.CPU.UsagePercent, i.Memory)
	}
	if len(i.Disks) != 2 || i.Disks[1].Mount != "/System/Volumes/Data" {
		t.Fatalf("mac disks: %+v", i.Disks)
	}
}

func TestParseWindows(t *testing.T) {
	out := "#< CLIXML\r\n" + `{"hostname":"PC-01","os":"Microsoft Windows 11 Pro","version":"10.0.22631","arch":"64-bit","uptime":3600,"memTotalKB":16000000,"memFreeKB":6000000,"pageTotalKB":2000000,"pageFreeKB":1000000,"cpuModel":"AMD Ryzen 7","cpus":16,"cpuLoad":9,"disks":[{"mount":"C:","fs":"NTFS","size":500000000000,"free":200000000000}],"procs":[{"pid":4,"name":"System","cpu":120.5,"mem":1000}],"events":[{"time":"2026-10-13T10:00:00Z","level":"Warning","source":"disk","message":"Reset to device"}]}`
	i, err := ParseWindows(out)
	if err != nil {
		t.Fatal(err)
	}
	if i.Memory.UsedBytes != 10000000*1024 || i.Disks[0].UsedBytes != 300000000000 || *i.Processes[0].CPUSeconds != 120.5 || i.Logs[0].Level != "warning" {
		t.Fatalf("windows parse: %+v", i)
	}
}

func TestEncodePowerShellIsUTF16(t *testing.T) {
	if encodePowerShell("ab") != "YQBiAA==" {
		t.Fatal("powershell encoding must be UTF-16LE base64")
	}
}

func TestPathHelpers(t *testing.T) {
	for in, want := range map[string]string{"/home/u/../x": "/home/x", "C:/Users": "/C:/Users", "/": "/"} {
		if got, err := CleanPath(in); err != nil || got != want {
			t.Errorf("CleanPath(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := CleanPath("a\x00b"); err == nil {
		t.Error("NUL accepted")
	}
	for _, bad := range []string{"", ".", "..", "a/b", strings.Repeat("x", 256)} {
		if ValidName(bad) {
			t.Errorf("ValidName(%q) should be false", bad)
		}
	}
	if !ValidName("report 2026.pdf") {
		t.Error("valid name rejected")
	}
}

func TestDialRefusesUnpinnedHost(t *testing.T) {
	if _, err := Dial(t.Context(), Target{Username: "u"}); err != ErrHostKeyNotPinned {
		t.Fatalf("expected ErrHostKeyNotPinned, got %v", err)
	}
}

func TestClassifyVirtualization(t *testing.T) {
	cases := []struct{ virt, vendor, product, bios, kind, platform string }{
		{"kvm", "QEMU", "Standard PC (Q35 + ICH9, 2009)", "SeaBIOS", "vm", "KVM / QEMU"},
		{"vmware", "VMware, Inc.", "VMware20,1", "", "vm", "VMware"},
		{"microsoft", "Microsoft Corporation", "Virtual Machine", "", "vm", "Hyper-V"},
		{"oracle", "innotek GmbH", "VirtualBox", "", "vm", "VirtualBox"},
		{"lxc", "", "", "", "container", "LXC container"},
		{"docker", "", "", "", "container", "Docker container"},
		{"none", "Dell Inc.", "PowerEdge R740", "Dell Inc.", "physical", "Physical machine"},
		{"", "VMware, Inc.", "VMware7,1", "", "vm", "VMware"},
		{"", "Dell Inc.", "OptiPlex 7090", "", "physical", "Physical machine"},
		{"vmm", "", "VirtualMac2,1", "", "vm", "Apple Virtualization"},
		{"none", "", "MacBookPro18,1", "", "physical", "Physical machine"},
		{"", "Amazon EC2", "t3.micro", "", "vm", "Amazon EC2"},
	}
	for _, c := range cases {
		v := ClassifyVirtualization(c.virt, c.vendor, c.product, c.bios)
		if v.Kind != c.kind || v.Platform != c.platform {
			t.Errorf("%+v: got %s / %s", c, v.Kind, v.Platform)
		}
	}
	if v := ClassifyVirtualization("kvm", "QEMU", "Standard PC (i440FX + PIIX, 1996)", "SeaBIOS"); !strings.Contains(v.Note, "Proxmox") {
		t.Errorf("a default QEMU machine should carry the Proxmox note, got %q", v.Note)
	}
	if v := ClassifyVirtualization("kvm", "Red Hat", "KVM", "SeaBIOS"); v.Note != "" {
		t.Errorf("no Proxmox note for other KVM hosts, got %q", v.Note)
	}
}
