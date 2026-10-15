package sshhelper

import "testing"

func canned(m map[string]string) netRunner { return func(cmd string) string { return m[cmd] } }

func TestInspectCiscoIOSXE(t *testing.T) {
	info := inspectNetwork(canned(map[string]string{
		"show version": `Cisco IOS XE Software, Version 17.06.04
Cisco IOS Software [Bengaluru], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.6.4, RELEASE SOFTWARE (fc1)
sw-core uptime is 1 week, 2 days, 3 hours, 4 minutes
cisco C9300-48P (X86) processor with 1392760K/6147K bytes of memory.
Processor board ID FCW2345A0BC
`,
		"show processes cpu":    "CPU utilization for five seconds: 3%/1%; one minute: 7%; five minutes: 4%\n",
		"show processes memory": "Processor Pool Total: 1000000 Used: 250000 Free: 750000\n",
	}))
	if info == nil {
		t.Fatal("not recognised")
	}
	if info.Vendor != "Cisco" || info.OS != "Cisco IOS XE 17.06.04" || info.Model != "C9300-48P" || info.Serial != "FCW2345A0BC" || info.Hostname != "sw-core" {
		t.Fatalf("%+v", info)
	}
	if info.UptimeSeconds != 7*86400+2*86400+3*3600+4*60 {
		t.Fatalf("uptime %d", info.UptimeSeconds)
	}
	if info.CPU.UsagePercent == nil || *info.CPU.UsagePercent != 7 || info.Memory.TotalBytes != 1000000 || info.Memory.UsedBytes != 250000 {
		t.Fatalf("%+v %+v", info.CPU, info.Memory)
	}
}

func TestInspectCiscoNXOS(t *testing.T) {
	info := inspectNetwork(canned(map[string]string{
		"show version": `Cisco Nexus Operating System (NX-OS) Software
  NXOS: version 9.3(8)
  cisco Nexus9000 C9336C-FX2 Chassis
  Processor Board ID FDO12345678
  Device name: n9k-1
Kernel uptime is 10 day(s), 3 hour(s), 4 minute(s), 5 second(s)
`,
		"show system resources": "CPU states  :   1.56% user,   1.04% kernel,   97.40% idle\nMemory usage:   16401276K total,   7122460K used,   9278816K free\n",
	}))
	if info == nil || info.OS != "Cisco NX-OS 9.3(8)" || info.Hostname != "n9k-1" || info.Serial != "FDO12345678" {
		t.Fatalf("%+v", info)
	}
	if info.CPU.UsagePercent == nil || int(*info.CPU.UsagePercent*10+0.5) != 26 || info.Memory.UsedBytes != 7122460*1024 {
		t.Fatalf("%+v %+v", info.CPU, info.Memory)
	}
}

func TestInspectJunos(t *testing.T) {
	info := inspectNetwork(canned(map[string]string{
		"show version": "Hostname: ex4300-1\nModel: ex4300-48t\nJunos: 21.4R3-S2.3\nJUNOS Base OS boot [21.4R3-S2.3]\n",
		"show chassis routing-engine": `Routing Engine status:
    Memory utilization          36 percent
    DRAM                      2048 MB (2048 MB installed)
    CPU utilization:
      User                       3 percent
      Idle                      94 percent
    Start time                  2024-01-01 10:00:00 UTC
    Uptime                      1 day, 2 hours, 3 minutes, 4 seconds
`,
		"show chassis hardware": "Hardware inventory:\nItem             Version  Part number  Serial number     Description\nChassis                                PE3716270001      EX4300-48T\n",
	}))
	if info == nil || info.Vendor != "Juniper" || info.OS != "Junos 21.4R3-S2.3" || info.Hostname != "ex4300-1" || info.Serial != "PE3716270001" {
		t.Fatalf("%+v", info)
	}
	if *info.CPU.UsagePercent != 6 || info.Memory.TotalBytes != 2048<<20 || info.UptimeSeconds != 86400+2*3600+3*60+4 {
		t.Fatalf("%+v %+v %d", info.CPU, info.Memory, info.UptimeSeconds)
	}
}

func TestInspectMikroTik(t *testing.T) {
	info := inspectNetwork(canned(map[string]string{
		"/system resource print": `                   uptime: 1w2d3h4m5s
                  version: 7.11.2 (stable)
              free-memory: 768.0MiB
             total-memory: 1024.0MiB
                      cpu: ARM
                cpu-count: 4
                 cpu-load: 3%
        architecture-name: arm
               board-name: RB4011iGS+
                 platform: MikroTik
`,
		"/system identity print":    "  name: edge-rtr\n",
		"/system routerboard print": "       routerboard: yes\n     serial-number: ABC123\n",
	}))
	if info == nil || info.OS != "MikroTik RouterOS 7.11.2" || info.Model != "RB4011iGS+" || info.Hostname != "edge-rtr" || info.Serial != "ABC123" {
		t.Fatalf("%+v", info)
	}
	if info.UptimeSeconds != 9*86400+3*3600+4*60+5 || info.CPU.Cores != 4 || info.Memory.TotalBytes != 1024<<20 || info.Memory.UsedBytes != 256<<20 {
		t.Fatalf("%+v %+v %d", info.CPU, info.Memory, info.UptimeSeconds)
	}
}

func TestInspectHuawei(t *testing.T) {
	info := inspectNetwork(canned(map[string]string{
		"display version": `Huawei Versatile Routing Platform Software
VRP (R) software, Version 5.170 (S5720 V200R011C10SPC600)
HUAWEI S5720-28X-LI-AC Routing Switch uptime is 12 weeks, 3 days, 4 hours, 5 minutes
`,
		"display cpu-usage":    "CPU utilization for five seconds: 3%: one minute: 5%: five minutes: 4%.\n",
		"display memory-usage": "System Total Memory Is: 1000 bytes\nTotal Memory Used Is: 400 bytes\n",
	}))
	if info == nil || info.Vendor != "Huawei" || info.OS != "Huawei VRP 5.170" || info.Model != "S5720-28X-LI-AC" {
		t.Fatalf("%+v", info)
	}
	if *info.CPU.UsagePercent != 5 || info.Memory.UsedBytes != 400 || info.UptimeSeconds != 12*7*86400+3*86400+4*3600+5*60 {
		t.Fatalf("%+v %+v", info.CPU, info.Memory)
	}
}

func TestInspectProCurveAndUnknown(t *testing.T) {
	info := inspectNetwork(canned(map[string]string{
		"show version": "Image stamp:    /ws/swbuildm/K_15_18\n               Jan 1 2020\n               K.15.18.0012\n",
		"show system information": `  System Name        : sw-edge
  Software revision  : K.15.18.0012
  Up Time            : 22 days
  CPU Util (%)       : 5
  Total Memory       : 1,000
  Free               : 400
  Serial Number      : SG123
`,
	}))
	if info == nil || info.OS != "HPE ProCurve K.15.18.0012" || info.Hostname != "sw-edge" || info.Memory.UsedBytes != 600 || *info.CPU.UsagePercent != 5 {
		t.Fatalf("%+v", info)
	}
	if inspectNetwork(canned(map[string]string{"show version": "% Invalid input detected"})) != nil {
		t.Fatal("unknown device was recognised")
	}
}
