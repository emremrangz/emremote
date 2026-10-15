package sshhelper

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Network equipment (switches, routers, firewalls) is inspected with a short list
// of fixed, read-only "show" commands per vendor. Nothing the user types is ever
// part of a command. The vendor is recognised from the output of the first command.

// ErrUnknownNetworkDevice means the device answered but is not one of the supported vendors.
var ErrUnknownNetworkDevice = errors.New("the device did not answer like a supported switch or router (Cisco, Juniper, MikroTik, Huawei, HPE/Aruba)")

type netRunner func(cmd string) string

var (
	reUptimeUnit = regexp.MustCompile(`(?i)(\d+)\s*(year|week|day|hour|minute|second)`)
	reMikroUp    = regexp.MustCompile(`(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?`)
)

// parseUptimeWords reads "2 years, 14 weeks, 3 days, 4 hours" and "10 day(s), 3 hour(s)".
func parseUptimeWords(s string) int64 {
	var total int64
	for _, m := range reUptimeUnit.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.ParseInt(m[1], 10, 64)
		switch strings.ToLower(m[2]) {
		case "year":
			total += n * 365 * 86400
		case "week":
			total += n * 7 * 86400
		case "day":
			total += n * 86400
		case "hour":
			total += n * 3600
		case "minute":
			total += n * 60
		case "second":
			total += n
		}
	}
	return total
}

func parseMikroUptime(s string) int64 {
	m := reMikroUp.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0
	}
	mult := []int64{0, 7 * 86400, 86400, 3600, 60, 1}
	var total int64
	for i := 1; i <= 5; i++ {
		n, _ := strconv.ParseInt(m[i], 10, 64)
		total += n * mult[i]
	}
	return total
}

func firstMatch(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); len(m) > 1 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func digitsOnly(s string) int64 {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	n, _ := strconv.ParseInt(b.String(), 10, 64)
	return n
}

// sizeBytes reads "1024.0MiB", "1GiB", "819.2MiB".
func sizeBytes(s string) int64 {
	m := regexp.MustCompile(`(?i)([\d.]+)\s*([kmgt]i?b)`).FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	mult := map[string]float64{"kb": 1 << 10, "kib": 1 << 10, "mb": 1 << 20, "mib": 1 << 20, "gb": 1 << 30, "gib": 1 << 30, "tb": 1 << 40, "tib": 1 << 40}
	return int64(f * mult[strings.ToLower(m[2])])
}

var (
	reCiscoXE     = regexp.MustCompile(`(?i)Cisco IOS XE Software.*?Version\s+([^\s,]+)`)
	reCiscoIOS    = regexp.MustCompile(`(?i)Cisco IOS Software.*?Version\s+([^\s,]+)`)
	reNXOS        = regexp.MustCompile(`(?i)NXOS:\s*version\s+(\S+)`)
	reCiscoUptime = regexp.MustCompile(`(?m)^(\S+)\s+uptime is\s+(.+)$`)
	reCiscoModel  = regexp.MustCompile(`(?im)^cisco\s+(\S+)(?:\s+\([^)]*\))?\s+(?:processor|\(.*?\)\s+processor)`)
	reCiscoBoard  = regexp.MustCompile(`(?i)Processor board ID\s+(\S+)`)
	reCiscoMem    = regexp.MustCompile(`(?i)with\s+(\d+)K/\d+K\s+bytes of memory`)
	reNXMem       = regexp.MustCompile(`(?i)with\s+(\d+)\s*kB of memory`)
	reNXChassis   = regexp.MustCompile(`(?im)^\s*cisco\s+(\S+(?:\s\S+)?)\s+(?:\(.*?\)\s+)?[Cc]hassis`)
	reNXName      = regexp.MustCompile(`(?i)Device name:\s*(\S+)`)
	reNXKernelUp  = regexp.MustCompile(`(?i)Kernel uptime is\s+(.+)`)
	reCiscoCPU    = regexp.MustCompile(`one minute:\s*(\d+)%`)
	reCiscoPool   = regexp.MustCompile(`Processor Pool Total:\s*(\d+)\s+Used:\s*(\d+)`)
	reNXCPUIdle   = regexp.MustCompile(`([\d.]+)%\s*idle`)
	reNXMemUsage  = regexp.MustCompile(`(\d+)K total,\s*(\d+)K used`)
	reJunHost     = regexp.MustCompile(`(?m)^Hostname:\s*(\S+)`)
	reJunModel    = regexp.MustCompile(`(?m)^Model:\s*(\S+)`)
	reJunVersion  = regexp.MustCompile(`(?m)^Junos:\s*(\S+)`)
	reJunMemPct   = regexp.MustCompile(`Memory utilization\s+(\d+)\s*percent`)
	reJunDRAM     = regexp.MustCompile(`DRAM\s+(\d+)\s*MB`)
	reJunIdle     = regexp.MustCompile(`Idle\s+(\d+)\s*percent`)
	reJunUptime   = regexp.MustCompile(`(?m)^\s*Uptime\s+(.+)$`)
	reJunSerial   = regexp.MustCompile(`(?m)^Chassis\s+(\S+)`)
	reHuaVersion  = regexp.MustCompile(`VRP \(R\) software, Version\s+([^\n(]+?)(?:\s*\(|\s*$)`)
	reHuaModel    = regexp.MustCompile(`(?im)^(?:HUAWEI\s+)?(\S+)\s+(?:Routing Switch|Router|Switch|Terminal)?\s*uptime is`)
	reHuaUptime   = regexp.MustCompile(`(?i)uptime is\s+(.+)`)
	reHuaCPU      = regexp.MustCompile(`(?i)(?:one minute:\s*|cpu use rate is\s*:\s*)(\d+)%`)
	reHuaMemTotal = regexp.MustCompile(`(?i)Total Memory Is:\s*(\d+)\s*bytes`)
	reHuaMemUsed  = regexp.MustCompile(`(?i)Total Memory Used Is:\s*(\d+)\s*bytes`)
	reHuaMemPct   = regexp.MustCompile(`(?i)Memory (?:utilization|Using Percentage Is)\s*(?:is|:)?\s*:?\s*(\d+)%`)
	reMikroVer    = regexp.MustCompile(`(?m)^\s*version:\s*(.+)$`)
	reMikroBoard  = regexp.MustCompile(`(?m)^\s*board-name:\s*(.+)$`)
	reMikroCPU    = regexp.MustCompile(`(?m)^\s*cpu:\s*(.+)$`)
	reMikroCores  = regexp.MustCompile(`(?m)^\s*cpu-count:\s*(\d+)`)
	reMikroLoad   = regexp.MustCompile(`(?m)^\s*cpu-load:\s*(\d+)%`)
	reMikroUptime = regexp.MustCompile(`(?m)^\s*uptime:\s*(\S+)`)
	reMikroTotal  = regexp.MustCompile(`(?m)^\s*total-memory:\s*(.+)$`)
	reMikroFree   = regexp.MustCompile(`(?m)^\s*free-memory:\s*(.+)$`)
	reMikroArch   = regexp.MustCompile(`(?m)^\s*architecture-name:\s*(\S+)`)
	reMikroName   = regexp.MustCompile(`(?m)^\s*name:\s*(.+)$`)
	reMikroSerial = regexp.MustCompile(`(?m)^\s*serial-number:\s*(\S+)`)
	reCXVersion   = regexp.MustCompile(`(?m)^Version\s*:\s*(\S+)`)
	reCXProduct   = regexp.MustCompile(`(?m)^Product Name\s*:\s*(.+)$`)
	reCXSerial    = regexp.MustCompile(`(?m)^Serial Number\s*:\s*(\S+)`)
	reCXUptime    = regexp.MustCompile(`(?m)^Up Time\s*:\s*(.+)$`)
	reCXName      = regexp.MustCompile(`(?m)^Hostname\s*:\s*(\S+)`)
	reProRev      = regexp.MustCompile(`(?i)Software revision\s*:\s*(\S+)`)
	reProName     = regexp.MustCompile(`(?i)System Name\s*:\s*(\S+)`)
	reProUp       = regexp.MustCompile(`(?i)Up Time\s*:\s*(.+)`)
	reProCPU      = regexp.MustCompile(`(?i)CPU Util \(%\)\s*:\s*(\d+)`)
	reProMemTotal = regexp.MustCompile(`(?i)Total Memory\s*:\s*([\d,]+)`)
	reProMemFree  = regexp.MustCompile(`(?im)^\s*Free\s*:\s*([\d,]+)`)
	reProSerial   = regexp.MustCompile(`(?i)Serial Number\s*:\s*(\S+)`)
	reProImage    = regexp.MustCompile(`(?i)Image stamp:`)
	reMikroMarker = regexp.MustCompile(`(?m)^\s*platform:\s*MikroTik`)
)

func pct(v float64) *float64 { return &v }

// InspectNetwork identifies the vendor and reads firmware, model, uptime, CPU and memory.
func InspectNetwork(ctx context.Context, c *ssh.Client) (*SystemInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	start := time.Now()
	run1 := func(cmd string) string {
		out, err := run(ctx, c, cmd, "")
		if err != nil {
			return ""
		}
		return strings.ReplaceAll(out, "\r", "")
	}
	info := inspectNetwork(run1)
	if info == nil {
		return nil, ErrUnknownNetworkDevice
	}
	info.Platform = "network"
	info.Disks, info.Processes, info.Logs = []Disk{}, []Process{}, []LogLine{}
	info.CollectedAt = time.Now().UTC()
	info.DurationMS = time.Since(start).Milliseconds()
	return info, nil
}

// inspectNetwork is separate from InspectNetwork so tests can feed canned output.
func inspectNetwork(run netRunner) *SystemInfo {
	show := run("show version")
	switch {
	case regexp.MustCompile(`(?i)NX-OS|Nexus Operating System`).MatchString(show):
		return ciscoNXOS(run, show)
	case regexp.MustCompile(`(?i)Cisco IOS|Cisco Internetwork Operating`).MatchString(show):
		return ciscoIOS(run, show)
	case regexp.MustCompile(`(?i)\bJunos\b`).MatchString(show):
		return juniper(run, show)
	case regexp.MustCompile(`ArubaOS-CX`).MatchString(show):
		return arubaCX(run, show)
	case reProImage.MatchString(show):
		return procurve(run)
	}
	if out := run("/system resource print"); reMikroMarker.MatchString(out) || (reMikroBoard.MatchString(out) && reMikroVer.MatchString(out)) {
		return mikrotik(run, out)
	}
	if out := run("display version"); strings.Contains(out, "VRP") {
		return huawei(run, out)
	}
	return nil
}

func ciscoIOS(run netRunner, show string) *SystemInfo {
	info := &SystemInfo{Vendor: "Cisco"}
	family, ver := "IOS", firstMatch(reCiscoIOS, show)
	if v := firstMatch(reCiscoXE, show); v != "" {
		family, ver = "IOS XE", v
	}
	info.OS = strings.TrimSpace("Cisco " + family + " " + ver)
	if m := reCiscoUptime.FindStringSubmatch(show); m != nil {
		info.Hostname, info.UptimeSeconds = m[1], parseUptimeWords(m[2])
	}
	info.Model = firstMatch(reCiscoModel, show)
	info.Serial = firstMatch(reCiscoBoard, show)
	info.CPU.Model = info.Model
	if v := firstMatch(reCiscoMem, show); v != "" {
		info.Memory.TotalBytes = atoi64(v) * 1024
	}
	if p := firstMatch(reCiscoCPU, run("show processes cpu")); p != "" {
		info.CPU.UsagePercent = pct(atof(p))
	}
	if m := reCiscoPool.FindStringSubmatch(run("show processes memory")); m != nil {
		info.Memory.TotalBytes, info.Memory.UsedBytes = atoi64(m[1]), atoi64(m[2])
	}
	return info
}

func ciscoNXOS(run netRunner, show string) *SystemInfo {
	info := &SystemInfo{Vendor: "Cisco"}
	info.OS = strings.TrimSpace("Cisco NX-OS " + firstMatch(reNXOS, show))
	info.Hostname = firstMatch(reNXName, show)
	info.Model = firstMatch(reNXChassis, show)
	info.Serial = firstMatch(reCiscoBoard, show)
	info.UptimeSeconds = parseUptimeWords(firstMatch(reNXKernelUp, show))
	info.CPU.Model = info.Model
	res := run("show system resources")
	if idle := firstMatch(reNXCPUIdle, res); idle != "" {
		info.CPU.UsagePercent = pct(100 - atof(idle))
	}
	if m := reNXMemUsage.FindStringSubmatch(res); m != nil {
		info.Memory.TotalBytes, info.Memory.UsedBytes = atoi64(m[1])*1024, atoi64(m[2])*1024
	} else if v := firstMatch(reNXMem, show); v != "" {
		info.Memory.TotalBytes = atoi64(v) * 1024
	}
	return info
}

func juniper(run netRunner, show string) *SystemInfo {
	info := &SystemInfo{Vendor: "Juniper", Hostname: firstMatch(reJunHost, show), Model: firstMatch(reJunModel, show)}
	info.OS = strings.TrimSpace("Junos " + firstMatch(reJunVersion, show))
	info.CPU.Model = info.Model
	re := run("show chassis routing-engine")
	if idle := firstMatch(reJunIdle, re); idle != "" {
		info.CPU.UsagePercent = pct(100 - atof(idle))
	}
	if dram := firstMatch(reJunDRAM, re); dram != "" {
		info.Memory.TotalBytes = atoi64(dram) << 20
		if p := firstMatch(reJunMemPct, re); p != "" {
			info.Memory.UsedBytes = info.Memory.TotalBytes * atoi64(p) / 100
		}
	}
	info.UptimeSeconds = parseUptimeWords(firstMatch(reJunUptime, re))
	info.Serial = firstMatch(reJunSerial, run("show chassis hardware"))
	return info
}

func mikrotik(run netRunner, res string) *SystemInfo {
	info := &SystemInfo{Vendor: "MikroTik", Model: firstMatch(reMikroBoard, res), Arch: firstMatch(reMikroArch, res)}
	info.OS = strings.TrimSpace("MikroTik RouterOS " + strings.Fields(firstMatch(reMikroVer, res) + " ")[0])
	info.UptimeSeconds = parseMikroUptime(firstMatch(reMikroUptime, res))
	info.CPU.Model = firstMatch(reMikroCPU, res)
	info.CPU.Cores = int(atoi64(firstMatch(reMikroCores, res)))
	if l := firstMatch(reMikroLoad, res); l != "" {
		info.CPU.UsagePercent = pct(atof(l))
	}
	info.Memory.TotalBytes = sizeBytes(firstMatch(reMikroTotal, res))
	if free := sizeBytes(firstMatch(reMikroFree, res)); info.Memory.TotalBytes > 0 && free <= info.Memory.TotalBytes {
		info.Memory.UsedBytes = info.Memory.TotalBytes - free
	}
	info.Hostname = firstMatch(reMikroName, run("/system identity print"))
	info.Serial = firstMatch(reMikroSerial, run("/system routerboard print"))
	return info
}

func huawei(run netRunner, ver string) *SystemInfo {
	info := &SystemInfo{Vendor: "Huawei", Model: firstMatch(reHuaModel, ver)}
	info.OS = strings.TrimSpace("Huawei VRP " + firstMatch(reHuaVersion, ver))
	info.UptimeSeconds = parseUptimeWords(firstMatch(reHuaUptime, ver))
	info.CPU.Model = info.Model
	if p := firstMatch(reHuaCPU, run("display cpu-usage")); p != "" {
		info.CPU.UsagePercent = pct(atof(p))
	}
	mem := run("display memory-usage")
	info.Memory.TotalBytes = atoi64(firstMatch(reHuaMemTotal, mem))
	info.Memory.UsedBytes = atoi64(firstMatch(reHuaMemUsed, mem))
	if info.Memory.UsedBytes == 0 && info.Memory.TotalBytes > 0 {
		info.Memory.UsedBytes = info.Memory.TotalBytes * atoi64(firstMatch(reHuaMemPct, mem)) / 100
	}
	return info
}

func arubaCX(run netRunner, show string) *SystemInfo {
	info := &SystemInfo{Vendor: "HPE Aruba", Model: firstMatch(reCXProduct, show), Serial: firstMatch(reCXSerial, show)}
	info.OS = strings.TrimSpace("Aruba AOS-CX " + firstMatch(reCXVersion, show))
	info.CPU.Model = info.Model
	sys := run("show system")
	info.Hostname = firstMatch(reCXName, sys)
	info.UptimeSeconds = parseUptimeWords(firstMatch(reCXUptime, sys))
	return info
}

func procurve(run netRunner) *SystemInfo {
	sys := run("show system information")
	if !reProRev.MatchString(sys) {
		return nil
	}
	info := &SystemInfo{Vendor: "HPE Aruba", Hostname: firstMatch(reProName, sys), Serial: firstMatch(reProSerial, sys)}
	info.OS = strings.TrimSpace("HPE ProCurve " + firstMatch(reProRev, sys))
	info.UptimeSeconds = parseUptimeWords(firstMatch(reProUp, sys))
	if p := firstMatch(reProCPU, sys); p != "" {
		info.CPU.UsagePercent = pct(atof(p))
	}
	info.Memory.TotalBytes = digitsOnly(firstMatch(reProMemTotal, sys))
	if free := digitsOnly(firstMatch(reProMemFree, sys)); free > 0 && free <= info.Memory.TotalBytes {
		info.Memory.UsedBytes = info.Memory.TotalBytes - free
	}
	return info
}
