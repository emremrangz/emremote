package sshhelper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/crypto/ssh"
)

// System inspection runs ONE of three fixed, read-only scripts (Linux, macOS,
// Windows PowerShell). No user input is ever interpolated into a command.

type CPU struct {
	Model        string    `json:"model"`
	Cores        int       `json:"cores"`
	UsagePercent *float64  `json:"usage_percent"`
	Load         []float64 `json:"load,omitempty"`
}

type Memory struct {
	TotalBytes     int64 `json:"total_bytes"`
	UsedBytes      int64 `json:"used_bytes"`
	SwapTotalBytes int64 `json:"swap_total_bytes"`
	SwapUsedBytes  int64 `json:"swap_used_bytes"`
}

type Disk struct {
	Mount      string `json:"mount"`
	Filesystem string `json:"filesystem"`
	TotalBytes int64  `json:"total_bytes"`
	UsedBytes  int64  `json:"used_bytes"`
}

type Process struct {
	PID        int      `json:"pid"`
	Name       string   `json:"name"`
	CPUPercent *float64 `json:"cpu_percent,omitempty"`
	MemPercent *float64 `json:"mem_percent,omitempty"`
	CPUSeconds *float64 `json:"cpu_seconds,omitempty"`
	MemBytes   *int64   `json:"mem_bytes,omitempty"`
}

type LogLine struct {
	Time    string `json:"time,omitempty"`
	Level   string `json:"level,omitempty"`
	Source  string `json:"source,omitempty"`
	Message string `json:"message"`
}

type SystemInfo struct {
	CollectedAt   time.Time `json:"collected_at"`
	Platform      string    `json:"platform"`
	Hostname      string    `json:"hostname"`
	OS            string    `json:"os"`
	Kernel        string    `json:"kernel"`
	Arch          string    `json:"arch"`
	UptimeSeconds int64     `json:"uptime_seconds"`
	CPU           CPU       `json:"cpu"`
	Memory        Memory    `json:"memory"`
	Disks         []Disk    `json:"disks"`
	Processes     []Process `json:"processes"`
	LogSource     string    `json:"log_source"`
	Logs          []LogLine `json:"logs"`
	DurationMS    int64     `json:"duration_ms"`
	// Virtualization says whether the device runs on a hypervisor or in a container.
	Virtualization *Virtualization `json:"virtualization,omitempty"`
	// Vendor, Model and Serial are filled for network equipment (OS then holds the firmware).
	Vendor string `json:"vendor,omitempty"`
	Model  string `json:"model,omitempty"`
	Serial string `json:"serial,omitempty"`
	// MAC is the hardware address of the network card used by the default route (for Wake-on-LAN).
	MAC string `json:"mac,omitempty"`
}

const maxOutput = 512 << 10

const linuxScript = `export LC_ALL=C
echo "@@hostname"; hostname 2>/dev/null || cat /proc/sys/kernel/hostname
echo "@@os"; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s
echo "@@kernel"; uname -r
echo "@@arch"; uname -m
echo "@@mac"; cat "/sys/class/net/$(ip route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')/address" 2>/dev/null
echo "@@virt"; systemd-detect-virt 2>/dev/null || true
echo "@@dmi"; echo "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"; echo "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"; echo "$(cat /sys/class/dmi/id/bios_vendor 2>/dev/null)"
echo "@@uptime"; cut -d' ' -f1 /proc/uptime
echo "@@loadavg"; cat /proc/loadavg
echo "@@cpus"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo "@@cpumodel"; grep -m1 -E '^(model name|Hardware|Processor)' /proc/cpuinfo | cut -d: -f2-
echo "@@stat1"; head -n1 /proc/stat; sleep 1; echo "@@stat2"; head -n1 /proc/stat
echo "@@meminfo"; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo "@@df"; df -P -k 2>/dev/null
echo "@@ps"; ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 8 || ps -o pid,comm | head -n 8
if command -v journalctl >/dev/null 2>&1 && journalctl -n 1 --no-pager -q >/dev/null 2>&1; then
  echo "@@logsource"; echo "systemd journal (warnings and errors)"
  echo "@@logs"; journalctl -p warning -n 30 --no-pager -o short-iso -q 2>/dev/null
elif [ -r /var/log/syslog ]; then echo "@@logsource"; echo "/var/log/syslog (warnings and errors)"; echo "@@logs"; tail -n 5000 /var/log/syslog | grep -iE 'warn|err|crit|fail|alert|emerg|panic' | tail -n 30
elif [ -r /var/log/messages ]; then echo "@@logsource"; echo "/var/log/messages (warnings and errors)"; echo "@@logs"; tail -n 5000 /var/log/messages | grep -iE 'warn|err|crit|fail|alert|emerg|panic' | tail -n 30
else echo "@@logsource"; echo ""; fi
`

const macScript = `export LC_ALL=C
echo "@@hostname"; hostname
echo "@@os"; echo "macOS $(sw_vers -productVersion)"
echo "@@kernel"; uname -r
echo "@@arch"; uname -m
echo "@@mac"; ifconfig en0 2>/dev/null | awk '/ether/{print $2; exit}'
echo "@@vmm"; sysctl -n kern.hv_vmm_present 2>/dev/null
echo "@@model"; sysctl -n hw.model 2>/dev/null
echo "@@boottime"; sysctl -n kern.boottime
echo "@@loadavg"; sysctl -n vm.loadavg
echo "@@cpus"; sysctl -n hw.ncpu
echo "@@cpumodel"; sysctl -n machdep.cpu.brand_string
echo "@@cpuusage"; top -l 2 -n 0 -s 1 | grep "CPU usage" | tail -n 1
echo "@@memsize"; sysctl -n hw.memsize
echo "@@vmstat"; vm_stat
echo "@@swap"; sysctl -n vm.swapusage
echo "@@df"; df -P -k
echo "@@ps"; ps -Arco pid,pcpu,pmem,comm | head -n 8
echo "@@logsource"; echo "unified log (errors, last 10 minutes)"
echo "@@logs"; log show --last 10m --style syslog --predicate 'messageType == error' 2>/dev/null | tail -n 30
`

const windowsScript = `$ErrorActionPreference='SilentlyContinue'
$os=Get-CimInstance Win32_OperatingSystem
$cs=Get-CimInstance Win32_ComputerSystem
$cpu=@(Get-CimInstance Win32_Processor)
$load=($cpu | Measure-Object -Property LoadPercentage -Average).Average
$disks=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")
$procs=@(Get-Process | Sort-Object CPU -Descending | Select-Object -First 7)
$events=@(Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2,3} -MaxEvents 30)
[pscustomobject]@{
 manufacturer=$cs.Manufacturer; model=$cs.Model; mac=(@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1)).MacAddress
 hostname=$env:COMPUTERNAME; os=$os.Caption; version=$os.Version; arch=$os.OSArchitecture
 uptime=[int64]((Get-Date)-$os.LastBootUpTime).TotalSeconds
 memTotalKB=[int64]$os.TotalVisibleMemorySize; memFreeKB=[int64]$os.FreePhysicalMemory
 pageTotalKB=[int64]$os.SizeStoredInPagingFiles; pageFreeKB=[int64]$os.FreeSpaceInPagingFiles
 cpuModel=$cpu[0].Name; cpus=[int]$cs.NumberOfLogicalProcessors; cpuLoad=$load
 disks=@($disks | ForEach-Object { [pscustomobject]@{ mount=$_.DeviceID; fs=$_.FileSystem; size=[int64]$_.Size; free=[int64]$_.FreeSpace } })
 procs=@($procs | ForEach-Object { [pscustomobject]@{ pid=$_.Id; name=$_.ProcessName; cpu=[double]$_.CPU; mem=[int64]$_.WorkingSet64 } })
 events=@($events | ForEach-Object { [pscustomobject]@{ time=$_.TimeCreated.ToUniversalTime().ToString('o'); level=$_.LevelDisplayName; source=$_.ProviderName; message=(($_.Message -split "` + "`" + `n")[0]).Trim() } })
} | ConvertTo-Json -Depth 4 -Compress
`

func run(ctx context.Context, c *ssh.Client, cmd string, stdin string) (string, error) {
	s, err := c.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	var out bytes.Buffer
	s.Stdout = &limitedWriter{w: &out, n: maxOutput}
	if stdin != "" {
		s.Stdin = strings.NewReader(stdin)
	}
	done := make(chan error, 1)
	go func() { done <- s.Run(cmd) }()
	select {
	case err := <-done:
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			err = nil // partial output is still useful (e.g. a missing tool)
		}
		return out.String(), err
	case <-ctx.Done():
		_ = s.Signal(ssh.SIGKILL)
		return out.String(), ctx.Err()
	}
}

type limitedWriter struct {
	w *bytes.Buffer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.w.Len()+len(p) > l.n {
		p = p[:max(0, l.n-l.w.Len())]
	}
	l.w.Write(p)
	return len(p), nil
}

func encodePowerShell(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, r := range u {
		binary.LittleEndian.PutUint16(b[i*2:], r)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// Inspect detects the platform and collects a snapshot. osHint is the
// device's configured OS ("windows", "macos", "linux", "other").
func Inspect(ctx context.Context, c *ssh.Client, osHint string) (*SystemInfo, error) {
	if osHint == "network" {
		return InspectNetwork(ctx, c)
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	start := time.Now()
	// Try the configured OS first, then the other family: devices are
	// sometimes registered with the wrong OS.
	detectUnix := func() string {
		if out, err := run(ctx, c, "uname -s", ""); err == nil {
			switch strings.TrimSpace(out) {
			case "Linux":
				return "linux"
			case "Darwin":
				return "macos"
			}
		}
		return ""
	}
	detectWindows := func() string {
		if out, err := run(ctx, c, "powershell -NoProfile -NonInteractive -Command \"$PSVersionTable.PSVersion.Major\"", ""); err == nil && strings.TrimSpace(out) != "" {
			return "windows"
		}
		return ""
	}
	order := []func() string{detectUnix, detectWindows}
	if osHint == "windows" {
		order = []func() string{detectWindows, detectUnix}
	}
	platform := ""
	for _, detect := range order {
		if platform = detect(); platform != "" {
			break
		}
	}
	var info *SystemInfo
	var err error
	switch platform {
	case "linux":
		var out string
		out, err = run(ctx, c, "/bin/sh -s", linuxScript)
		if err == nil {
			info = ParseLinux(out)
		}
	case "macos":
		var out string
		out, err = run(ctx, c, "/bin/sh -s", macScript)
		if err == nil {
			info = ParseMac(out)
		}
	case "windows":
		var out string
		out, err = run(ctx, c, "powershell -NoProfile -NonInteractive -EncodedCommand "+encodePowerShell(windowsScript), "")
		if err == nil {
			info, err = ParseWindows(out)
		}
	default:
		// Registered as the wrong kind of device? A switch or router answers no shell command.
		if ni, nerr := InspectNetwork(ctx, c); nerr == nil {
			return ni, nil
		}
		return nil, errors.New("unsupported remote platform (Linux, macOS and Windows with PowerShell are supported)")
	}
	if err != nil {
		return nil, err
	}
	info.Platform = platform
	info.CollectedAt = time.Now().UTC()
	info.DurationMS = time.Since(start).Milliseconds()
	return info, nil
}

// ---- Parsers (exported for tests) ----

func sections(out string) map[string]string {
	m := map[string]string{}
	cur := ""
	var b strings.Builder
	flush := func() {
		if cur != "" {
			m[cur] = strings.TrimRight(b.String(), "\n")
		}
		b.Reset()
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "@@") {
			flush()
			cur = strings.TrimSpace(line[2:])
			continue
		}
		b.WriteString(strings.TrimRight(line, "\r"))
		b.WriteByte('\n')
	}
	flush()
	return m
}

func atoi64(s string) int64 { n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64); return n }
func atof(s string) float64 { f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return f }
func pf(f float64) *float64 { return &f }

func firstField(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return ""
}

var skipFS = map[string]bool{"tmpfs": true, "devtmpfs": true, "overlay": true, "squashfs": true, "udev": true, "none": true,
	"shm": true, "devfs": true, "efivarfs": true, "cgroup": true, "proc": true, "sysfs": true}

// parseDF reads `df -P -k` output. Entries for the same device and size (bind
// mounts, e.g. files mounted into containers) are reported once, under the
// shortest mount path.
func parseDF(s string, keep func(fs, mount string) bool) []Disk {
	disks := []Disk{}
	seen := map[string]bool{}
	byDevice := map[string]int{}
	for i, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 6 {
			continue
		}
		fsName, mount := f[0], strings.Join(f[5:], " ")
		total, used := atoi64(f[1])*1024, atoi64(f[2])*1024
		if total == 0 || skipFS[fsName] || strings.HasPrefix(fsName, "map ") || !keep(fsName, mount) || seen[mount] {
			continue
		}
		seen[mount] = true
		key := fsName + "|" + strconv.FormatInt(total, 10)
		if i, dup := byDevice[key]; dup && strings.HasPrefix(fsName, "/") {
			if len(mount) < len(disks[i].Mount) {
				disks[i].Mount = mount
			}
			continue
		}
		byDevice[key] = len(disks)
		disks = append(disks, Disk{Mount: mount, Filesystem: fsName, TotalBytes: total, UsedBytes: used})
	}
	return disks
}

func parsePS(s string) []Process {
	procs := []Process{}
	for i, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 4 {
			continue
		}
		pid, err := strconv.Atoi(f[0])
		if err != nil {
			continue
		}
		procs = append(procs, Process{PID: pid, CPUPercent: pf(atof(f[1])), MemPercent: pf(atof(f[2])), Name: strings.Join(f[3:], " ")})
	}
	return procs
}

func cpuTimes(line string) (idle, total float64) {
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return 0, 0
	}
	for i, v := range f[1:] {
		x := atof(v)
		total += x
		if i == 3 || i == 4 { // idle + iowait
			idle += x
		}
	}
	return idle, total
}

var (
	logLevelRe = regexp.MustCompile(`(?i)\b(emerg|alert|crit(ical)?|err(or)?|warn(ing)?|fail(ed|ure)?)\b`)
	// syslog "facility.level" token, e.g. "daemon.err" (BusyBox/rsyslog files)
	sysLevelRe = regexp.MustCompile(`\b(?:kern|user|mail|daemon|auth|syslog|lpr|news|uucp|cron|authpriv|ftp|local[0-7])\.(emerg|alert|crit|err|warn|warning|notice|info|debug)\b`)
)

func rawLogs(s string) []LogLine {
	lines := []LogLine{}
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "-- ") || strings.HasPrefix(l, "Timestamp ") {
			continue
		}
		ll := LogLine{Message: l}
		if m := sysLevelRe.FindStringSubmatch(l); m != nil {
			// The line states its own severity; trust it over keywords.
			switch m[1] {
			case "info", "notice", "debug":
				continue
			}
			ll.Level = m[1]
		} else if m := logLevelRe.FindString(l); m != "" {
			ll.Level = strings.ToLower(m)
		}
		lines = append(lines, ll)
	}
	return lines
}

func ParseLinux(out string) *SystemInfo {
	s := sections(out)
	info := &SystemInfo{
		Hostname: strings.TrimSpace(s["hostname"]), OS: strings.TrimSpace(s["os"]),
		Kernel: strings.TrimSpace(s["kernel"]), Arch: strings.TrimSpace(s["arch"]),
		UptimeSeconds: int64(atof(firstField(s["uptime"]))), LogSource: strings.TrimSpace(s["logsource"]),
	}
	info.CPU.Cores = int(atoi64(s["cpus"]))
	info.CPU.Model = strings.TrimSpace(s["cpumodel"])
	dmi := strings.Split(s["dmi"], "\n")
	for len(dmi) < 3 {
		dmi = append(dmi, "")
	}
	info.Virtualization = ClassifyVirtualization(strings.TrimSpace(s["virt"]), dmi[0], dmi[1], dmi[2])
	info.MAC = cleanMAC(s["mac"])
	if f := strings.Fields(s["loadavg"]); len(f) >= 3 {
		info.CPU.Load = []float64{atof(f[0]), atof(f[1]), atof(f[2])}
	}
	i1, t1 := cpuTimes(s["stat1"])
	i2, t2 := cpuTimes(s["stat2"])
	if dt := t2 - t1; dt > 0 {
		info.CPU.UsagePercent = pf((1 - (i2-i1)/dt) * 100)
	}
	mem := map[string]int64{}
	for _, l := range strings.Split(s["meminfo"], "\n") {
		k, v, ok := strings.Cut(l, ":")
		if ok {
			mem[k] = atoi64(strings.TrimSuffix(strings.TrimSpace(v), " kB")) * 1024
		}
	}
	avail, ok := mem["MemAvailable"]
	if !ok {
		avail = mem["MemFree"] + mem["Buffers"] + mem["Cached"]
	}
	info.Memory = Memory{TotalBytes: mem["MemTotal"], UsedBytes: mem["MemTotal"] - avail,
		SwapTotalBytes: mem["SwapTotal"], SwapUsedBytes: mem["SwapTotal"] - mem["SwapFree"]}
	info.Disks = parseDF(s["df"], func(fs, mount string) bool {
		return !strings.HasPrefix(mount, "/proc") && !strings.HasPrefix(mount, "/sys") && !strings.HasPrefix(mount, "/run") &&
			!strings.HasPrefix(mount, "/dev") && !strings.HasPrefix(mount, "/snap/")
	})
	info.Processes = parsePS(s["ps"])
	info.Logs = rawLogs(s["logs"])
	return info
}

var (
	macBootRe  = regexp.MustCompile(`sec = (\d+)`)
	macCPURe   = regexp.MustCompile(`([\d.]+)% idle`)
	macPageRe  = regexp.MustCompile(`page size of (\d+) bytes`)
	macSwapRe  = regexp.MustCompile(`total = ([\d.]+)M\s+used = ([\d.]+)M`)
	macVMValRe = regexp.MustCompile(`^(.+?):\s+(\d+)\.?$`)
)

func ParseMac(out string) *SystemInfo {
	s := sections(out)
	info := &SystemInfo{
		Hostname: strings.TrimSpace(s["hostname"]), OS: strings.TrimSpace(s["os"]),
		Kernel: "Darwin " + strings.TrimSpace(s["kernel"]), Arch: strings.TrimSpace(s["arch"]),
		LogSource: strings.TrimSpace(s["logsource"]),
	}
	info.MAC = cleanMAC(s["mac"])
	info.Virtualization = ClassifyVirtualization(map[bool]string{true: "vmm", false: "none"}[strings.TrimSpace(s["vmm"]) == "1"], "", strings.TrimSpace(s["model"]), "")
	if m := macBootRe.FindStringSubmatch(s["boottime"]); m != nil {
		info.UptimeSeconds = time.Now().Unix() - atoi64(m[1])
	}
	if f := strings.Fields(strings.Trim(strings.TrimSpace(s["loadavg"]), "{}")); len(f) >= 3 {
		info.CPU.Load = []float64{atof(f[0]), atof(f[1]), atof(f[2])}
	}
	info.CPU.Cores = int(atoi64(s["cpus"]))
	info.CPU.Model = strings.TrimSpace(s["cpumodel"])
	if m := macCPURe.FindStringSubmatch(s["cpuusage"]); m != nil {
		info.CPU.UsagePercent = pf(100 - atof(m[1]))
	}
	total := atoi64(s["memsize"])
	page := int64(4096)
	if m := macPageRe.FindStringSubmatch(s["vmstat"]); m != nil {
		page = atoi64(m[1])
	}
	vm := map[string]int64{}
	for _, l := range strings.Split(s["vmstat"], "\n") {
		if m := macVMValRe.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
			vm[m[1]] = atoi64(m[2]) * page
		}
	}
	used := vm["Pages active"] + vm["Pages wired down"] + vm["Pages occupied by compressor"]
	info.Memory = Memory{TotalBytes: total, UsedBytes: min(used, total)}
	if m := macSwapRe.FindStringSubmatch(s["swap"]); m != nil {
		info.Memory.SwapTotalBytes = int64(atof(m[1]) * 1024 * 1024)
		info.Memory.SwapUsedBytes = int64(atof(m[2]) * 1024 * 1024)
	}
	info.Disks = parseDF(s["df"], func(_, mount string) bool {
		return mount == "/" || mount == "/System/Volumes/Data" || strings.HasPrefix(mount, "/Volumes/")
	})
	info.Processes = parsePS(s["ps"])
	info.Logs = rawLogs(s["logs"])
	return info
}

type winOut struct {
	MAC          string  `json:"mac"`
	Manufacturer string  `json:"manufacturer"`
	Model        string  `json:"model"`
	Hostname     string  `json:"hostname"`
	OS           string  `json:"os"`
	Version      string  `json:"version"`
	Arch         string  `json:"arch"`
	Uptime       int64   `json:"uptime"`
	MemTotalKB   int64   `json:"memTotalKB"`
	MemFreeKB    int64   `json:"memFreeKB"`
	PageTotalKB  int64   `json:"pageTotalKB"`
	PageFreeKB   int64   `json:"pageFreeKB"`
	CPUModel     string  `json:"cpuModel"`
	CPUs         int     `json:"cpus"`
	CPULoad      float64 `json:"cpuLoad"`
	Disks        []struct {
		Mount string `json:"mount"`
		FS    string `json:"fs"`
		Size  int64  `json:"size"`
		Free  int64  `json:"free"`
	} `json:"disks"`
	Procs []struct {
		PID  int     `json:"pid"`
		Name string  `json:"name"`
		CPU  float64 `json:"cpu"`
		Mem  int64   `json:"mem"`
	} `json:"procs"`
	Events []struct {
		Time    string `json:"time"`
		Level   string `json:"level"`
		Source  string `json:"source"`
		Message string `json:"message"`
	} `json:"events"`
}

func ParseWindows(out string) (*SystemInfo, error) {
	out = strings.TrimSpace(out)
	if i := strings.IndexByte(out, '{'); i > 0 {
		out = out[i:]
	}
	var w winOut
	if err := json.Unmarshal([]byte(out), &w); err != nil {
		return nil, fmt.Errorf("unexpected PowerShell output: %w", err)
	}
	info := &SystemInfo{
		Hostname: w.Hostname, OS: w.OS, Kernel: "Windows " + w.Version, Arch: w.Arch, UptimeSeconds: w.Uptime,
		LogSource: "Windows System event log (errors and warnings)",
	}
	info.CPU = CPU{Model: strings.TrimSpace(w.CPUModel), Cores: w.CPUs, UsagePercent: pf(w.CPULoad)}
	info.Virtualization = ClassifyVirtualization("", w.Manufacturer, w.Model, "")
	info.MAC = cleanMAC(w.MAC)
	info.Memory = Memory{TotalBytes: w.MemTotalKB * 1024, UsedBytes: (w.MemTotalKB - w.MemFreeKB) * 1024,
		SwapTotalBytes: w.PageTotalKB * 1024, SwapUsedBytes: (w.PageTotalKB - w.PageFreeKB) * 1024}
	info.Disks = []Disk{}
	for _, d := range w.Disks {
		if d.Size > 0 {
			info.Disks = append(info.Disks, Disk{Mount: d.Mount, Filesystem: d.FS, TotalBytes: d.Size, UsedBytes: d.Size - d.Free})
		}
	}
	info.Processes = []Process{}
	for _, p := range w.Procs {
		cpu, mem := p.CPU, p.Mem
		info.Processes = append(info.Processes, Process{PID: p.PID, Name: p.Name, CPUSeconds: &cpu, MemBytes: &mem})
	}
	info.Logs = []LogLine{}
	for _, e := range w.Events {
		info.Logs = append(info.Logs, LogLine{Time: e.Time, Level: strings.ToLower(e.Level), Source: e.Source, Message: e.Message})
	}
	return info, nil
}

// cleanMAC returns a hardware address as aa:bb:cc:dd:ee:ff, or "" when it is not one.
func cleanMAC(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "-", ":")
	if len(s) != 17 || s == "00:00:00:00:00:00" {
		return ""
	}
	for i, c := range s {
		if i%3 == 2 {
			if c != ':' {
				return ""
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return ""
		}
	}
	return s
}
