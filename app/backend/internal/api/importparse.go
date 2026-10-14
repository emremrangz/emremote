package api

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// ---- Inventory import: parsers ----
//
// Three sources are understood: emremote's own JSON export, an OpenSSH client
// config (~/.ssh/config) and a CSV table. They all produce the same neutral
// shape, which is then validated like any other device the user could create.
// Secrets never travel through any of these formats.

const (
	maxImportDevices = 2000
	maxImportBytes   = 4 << 20
	exportFormatName = "emremote-inventory"
)

type importConn struct {
	Name     string          `json:"name"`
	Protocol string          `json:"protocol"`
	Port     int             `json:"port"`
	Username string          `json:"username"`
	Domain   string          `json:"domain"`
	Settings json.RawMessage `json:"settings,omitempty"`
}

type importDevice struct {
	Name        string       `json:"name"`
	Hostname    string       `json:"hostname"`
	Address     string       `json:"address"`
	OS          string       `json:"os"`
	DeviceType  string       `json:"device_type"`
	Description string       `json:"description"`
	Notes       string       `json:"notes"`
	Tags        []string     `json:"tags"`
	Group       string       `json:"group"`
	Favorite    bool         `json:"favorite"`
	Connections []importConn `json:"connections"`
}

type importGroup struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type importDoc struct {
	Format     string         `json:"format"`
	Version    int            `json:"version"`
	ExportedAt string         `json:"exported_at,omitempty"`
	Groups     []importGroup  `json:"groups"`
	Devices    []importDevice `json:"devices"`
}

type parsed struct {
	Format   string
	Groups   []importGroup
	Devices  []importDevice
	Warnings []string
}

var errImportFormat = errors.New("unrecognised format")

// detectFormat guesses the source: JSON object, an ssh config ("Host ..."), else CSV.
func detectFormat(content string) string {
	t := strings.TrimSpace(strings.TrimPrefix(content, "\ufeff"))
	switch {
	case strings.HasPrefix(t, "{"):
		return "emremote"
	}
	sc := bufio.NewScanner(strings.NewReader(t))
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		f := strings.Fields(l)
		if len(f) >= 2 && strings.EqualFold(f[0], "host") {
			return "ssh-config"
		}
		break
	}
	return "csv"
}

func parseImport(format, content string) (*parsed, error) {
	content = strings.TrimPrefix(content, "\ufeff")
	if strings.TrimSpace(content) == "" {
		return nil, errors.New("nothing to import")
	}
	if format == "" || format == "auto" {
		format = detectFormat(content)
	}
	var p *parsed
	var err error
	switch format {
	case "emremote":
		p, err = parseEmremoteJSON(content)
	case "ssh-config":
		p, err = parseSSHConfig(content)
	case "csv":
		p, err = parseCSV(content)
	default:
		return nil, fmt.Errorf("%w: %q", errImportFormat, format)
	}
	if err != nil {
		return nil, err
	}
	p.Format = format
	if len(p.Devices) == 0 {
		return nil, errors.New("no devices found in this file")
	}
	if len(p.Devices) > maxImportDevices {
		return nil, fmt.Errorf("too many devices: at most %d can be imported at once", maxImportDevices)
	}
	return p, nil
}

func parseEmremoteJSON(content string) (*parsed, error) {
	var doc importDoc
	dec := json.NewDecoder(strings.NewReader(content))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("not a valid emremote export: %s", sanitizeJSONError(err))
	}
	if doc.Format != exportFormatName {
		return nil, errors.New("this JSON file is not an emremote inventory export")
	}
	if doc.Version != 1 {
		return nil, fmt.Errorf("unsupported export version %d", doc.Version)
	}
	return &parsed{Groups: doc.Groups, Devices: doc.Devices}, nil
}

// parseSSHConfig reads Host blocks. Wildcard hosts, Match blocks and options
// other than HostName/Port/User are ignored (with a note for ProxyJump).
func parseSSHConfig(content string) (*parsed, error) {
	type block struct {
		aliases []string
		host    string
		port    int
		user    string
	}
	var blocks []*block
	var cur *block
	warn := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(content))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := splitSSHLine(line)
		if !ok {
			continue
		}
		switch strings.ToLower(key) {
		case "host":
			cur = &block{}
			for _, a := range strings.Fields(val) {
				if strings.ContainsAny(a, "*?!") {
					continue
				}
				cur.aliases = append(cur.aliases, a)
			}
			blocks = append(blocks, cur)
		case "match":
			cur = nil
			warn["Match blocks were skipped."] = true
		case "hostname":
			if cur != nil {
				cur.host = val
			}
		case "port":
			if cur != nil {
				if n, err := strconv.Atoi(val); err == nil {
					cur.port = n
				}
			}
		case "user":
			if cur != nil {
				cur.user = val
			}
		case "proxyjump", "proxycommand":
			warn["ProxyJump and ProxyCommand lines were ignored: set up a jump host on the connection instead."] = true
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	p := &parsed{}
	for w := range warn {
		p.Warnings = append(p.Warnings, w)
	}
	for _, b := range blocks {
		for _, alias := range b.aliases {
			addr := b.host
			if addr == "" {
				addr = alias
			}
			port := b.port
			if port == 0 {
				port = 22
			}
			p.Devices = append(p.Devices, importDevice{
				Name: alias, Address: addr, OS: "linux", DeviceType: "server", Tags: []string{"ssh-config"},
				Connections: []importConn{{Name: "SSH", Protocol: "ssh", Port: port, Username: b.user}},
			})
		}
	}
	return p, nil
}

// splitSSHLine splits "Key value" and "Key=value".
func splitSSHLine(line string) (key, val string, ok bool) {
	i := strings.IndexAny(line, " \t=")
	if i <= 0 {
		return "", "", false
	}
	key = line[:i]
	val = strings.Trim(strings.TrimSpace(strings.TrimLeft(line[i:], " \t=")), `"`)
	return key, val, val != ""
}

var csvColumns = map[string]bool{
	"name": true, "address": true, "hostname": true, "os": true, "device_type": true, "protocol": true, "port": true,
	"username": true, "domain": true, "group": true, "tags": true, "description": true,
}

// parseCSV reads a header row plus one row per device and protocol; rows with
// the same name and address become one device with several connections.
func parseCSV(content string) (*parsed, error) {
	r := csv.NewReader(bytes.NewReader([]byte(content)))
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true
	head, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("could not read the CSV header: %w", err)
	}
	idx := map[string]int{}
	for i, h := range head {
		h = strings.ToLower(strings.TrimSpace(h))
		if !csvColumns[h] {
			return nil, fmt.Errorf("unknown CSV column %q (allowed: name, address, hostname, os, device_type, protocol, port, username, domain, group, tags, description)", h)
		}
		idx[h] = i
	}
	if _, ok := idx["name"]; !ok {
		return nil, errors.New("the CSV needs a \"name\" column")
	}
	if _, ok := idx["address"]; !ok {
		return nil, errors.New("the CSV needs an \"address\" column")
	}
	get := func(rec []string, col string) string {
		if i, ok := idx[col]; ok && i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}
	p := &parsed{}
	seen := map[string]int{}
	for line := 2; ; line++ {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("CSV line %d: %w", line, err)
		}
		if len(p.Devices) > maxImportDevices {
			break
		}
		name, addr := get(rec, "name"), get(rec, "address")
		if name == "" && addr == "" {
			continue
		}
		key := strings.ToLower(name) + "\x00" + strings.ToLower(addr)
		i, ok := seen[key]
		if !ok {
			d := importDevice{
				Name: name, Address: addr, Hostname: get(rec, "hostname"), OS: strings.ToLower(get(rec, "os")),
				DeviceType: strings.ToLower(get(rec, "device_type")), Description: get(rec, "description"), Group: get(rec, "group"),
			}
			if d.OS == "" {
				d.OS = "other"
			}
			if d.DeviceType == "" {
				d.DeviceType = "other"
			}
			for _, t := range strings.FieldsFunc(get(rec, "tags"), func(r rune) bool { return r == ';' || r == '|' }) {
				d.Tags = append(d.Tags, strings.TrimSpace(t))
			}
			p.Devices = append(p.Devices, d)
			i = len(p.Devices) - 1
			seen[key] = i
		}
		if proto := strings.ToLower(get(rec, "protocol")); proto != "" {
			c := importConn{Name: strings.ToUpper(proto), Protocol: proto, Username: get(rec, "username"), Domain: get(rec, "domain")}
			if ps := get(rec, "port"); ps != "" {
				n, err := strconv.Atoi(ps)
				if err != nil {
					return nil, fmt.Errorf("CSV line %d: port %q is not a number", line, ps)
				}
				c.Port = n
			}
			p.Devices[i].Connections = append(p.Devices[i].Connections, c)
		}
	}
	return p, nil
}
