package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/emremrangz/emremote/internal/store"
)

// ---- Inventory export and import ----
//
// Export writes what the user can see: devices, their groups and connection
// methods with their (non-secret) settings. Passwords, keys and saved
// credentials are never exported, and credentials are not imported. Import
// creates items in the importing user's own scope (administrators: the shared
// inventory, members: their private one), after the same validation as the
// forms use.

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "csv" {
		writeError(w, http.StatusBadRequest, "bad_request", "format must be json or csv")
		return
	}
	devices, err := s.store.ListDevices(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	conns, err := s.store.ListConnections(r.Context(), u.ID, "")
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	byDevice := map[string][]importConn{}
	for _, c := range conns {
		settings := stripPortable(c.Settings)
		byDevice[c.DeviceID] = append(byDevice[c.DeviceID], importConn{
			Name: c.Name, Protocol: c.Protocol, Port: c.Port, Username: c.Username, Domain: c.Domain, Settings: settings,
		})
	}
	doc := importDoc{Format: exportFormatName, Version: 1, ExportedAt: time.Now().UTC().Format(time.RFC3339), Groups: []importGroup{}, Devices: []importDevice{}}
	groups, _ := s.store.ListGroups(r.Context(), u.ID)
	used := map[string]bool{}
	for _, d := range devices {
		id := importDevice{
			Name: d.Name, Hostname: d.Hostname, Address: d.Address, OS: d.OS, DeviceType: d.DeviceType, Description: d.Description,
			Notes: d.Notes, Tags: d.Tags, Favorite: d.Favorite, Connections: byDevice[d.ID],
		}
		if id.Connections == nil {
			id.Connections = []importConn{}
		}
		if d.GroupName != nil {
			id.Group = *d.GroupName
			used[*d.GroupName] = true
		}
		doc.Devices = append(doc.Devices, id)
	}
	for _, g := range groups {
		if used[g.Name] {
			doc.Groups = append(doc.Groups, importGroup{Name: g.Name, Description: g.Description})
		}
	}
	s.audit(r, "inventory.export", "inventory", "", "Inventory export", true, map[string]any{"format": format, "devices": len(doc.Devices)})
	stamp := time.Now().Format("20060102")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if format == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="emremote-inventory-`+stamp+`.csv"`)
		writeCSV(w, doc)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="emremote-inventory-`+stamp+`.json"`)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(doc)
}

// stripPortable drops settings that only make sense on this server.
func stripPortable(raw json.RawMessage) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	delete(m, "jump_connection_id")
	out, _ := json.Marshal(m)
	return out
}

// csvSafe stops spreadsheet programs from treating a cell as a formula.
func csvSafe(v string) string {
	if v != "" && strings.ContainsRune("=+-@\t\r", rune(v[0])) {
		return "'" + v
	}
	return v
}

func writeCSV(w http.ResponseWriter, doc importDoc) {
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"name", "address", "hostname", "os", "device_type", "protocol", "port", "username", "domain", "group", "tags", "description"})
	for _, d := range doc.Devices {
		base := []string{csvSafe(d.Name), csvSafe(d.Address), csvSafe(d.Hostname), d.OS, d.DeviceType}
		tail := []string{csvSafe(d.Group), csvSafe(strings.Join(d.Tags, ";")), csvSafe(d.Description)}
		if len(d.Connections) == 0 {
			_ = cw.Write(append(append(append([]string{}, base...), "", "", "", ""), tail...))
			continue
		}
		for _, c := range d.Connections {
			_ = cw.Write(append(append(append([]string{}, base...), c.Protocol, strconv.Itoa(c.Port), csvSafe(c.Username), csvSafe(c.Domain)), tail...))
		}
	}
	cw.Flush()
}

type importRequest struct {
	Format     string `json:"format"`
	Content    string `json:"content"`
	OnConflict string `json:"on_conflict"`
}

type importItem struct {
	Name        string   `json:"name"`
	Address     string   `json:"address"`
	Group       string   `json:"group"`
	Connections []string `json:"connections"`
	Conflict    bool     `json:"conflict"`
	Problems    []string `json:"problems"`
}

type importPreview struct {
	Format   string       `json:"format"`
	Items    []importItem `json:"items"`
	Warnings []string     `json:"warnings"`
	Valid    int          `json:"valid"`
	Conflict int          `json:"conflicts"`
	Invalid  int          `json:"invalid"`
}

// planned is a device that passed validation, ready to be created.
type planned struct {
	device store.DeviceInput
	group  string
	conns  []store.ConnectionInput
}

// plan validates every parsed device the way the forms do.
func (s *Server) plan(ctx context.Context, u *store.User, p *parsed) ([]planned, []importItem, error) {
	owner := u.OwnerScope()
	existing, err := s.store.ListDevices(ctx, u.ID)
	if err != nil {
		return nil, nil, err
	}
	have := map[string]bool{}
	for _, d := range existing {
		if sameOwner(d.OwnerID, owner) {
			have[strings.ToLower(d.Name)+"\x00"+strings.ToLower(d.Address)] = true
		}
	}
	plans := make([]planned, len(p.Devices))
	items := make([]importItem, len(p.Devices))
	for i, d := range p.Devices {
		req := deviceRequest{Name: d.Name, Hostname: d.Hostname, Address: d.Address, OS: d.OS, DeviceType: d.DeviceType,
			Description: d.Description, Notes: d.Notes, Tags: d.Tags, Favorite: d.Favorite}
		v, in := req.validate()
		item := importItem{Name: strings.TrimSpace(d.Name), Address: strings.TrimSpace(d.Address), Group: strings.TrimSpace(d.Group), Problems: []string{}, Connections: []string{}}
		for f, m := range v.errs {
			item.Problems = append(item.Problems, f+": "+m)
		}
		if g := strings.TrimSpace(d.Group); g != "" {
			gv := newValidator()
			gv.text("group", g, true, 64, false)
			if !gv.ok() {
				item.Problems = append(item.Problems, "group: "+gv.summary())
			}
		}
		if len(d.Connections) > 8 {
			item.Problems = append(item.Problems, "connections: at most 8 per device")
		}
		var cins []store.ConnectionInput
		for _, c := range d.Connections {
			// A jump host reference means nothing on another server, so it is never imported.
			cr := connectionRequest{Name: c.Name, Protocol: c.Protocol, Port: c.Port, Username: c.Username, Domain: c.Domain, Settings: stripPortable(c.Settings)}
			cv, cin, _, _ := s.validateConnection(ctx, owner, "", in.Address, cr)
			for f, m := range cv.errs {
				item.Problems = append(item.Problems, strings.ToUpper(c.Protocol)+" "+f+": "+m)
			}
			if cv.ok() {
				cins = append(cins, cin)
				item.Connections = append(item.Connections, fmt.Sprintf("%s:%d", strings.ToUpper(cin.Protocol), cin.Port))
			}
		}
		sort.Strings(item.Problems)
		item.Conflict = have[strings.ToLower(item.Name)+"\x00"+strings.ToLower(item.Address)]
		items[i] = item
		plans[i] = planned{device: in, group: item.Group, conns: cins}
		if len(item.Problems) > 0 {
			plans[i] = planned{}
		}
	}
	return plans, items, nil
}

func decodeImportRequest(w http.ResponseWriter, r *http.Request) (importRequest, bool) {
	var req importRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes+64<<10)
	if !decodeJSONBody(w, r, &req) {
		return req, false
	}
	if len(req.Content) > maxImportBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "The file is too large (4 MB at most)")
		return req, false
	}
	return req, true
}

func (s *Server) handleImportPreview(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeImportRequest(w, r)
	if !ok {
		return
	}
	p, err := parseImport(req.Format, req.Content)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "import_failed", err.Error())
		return
	}
	_, items, err := s.plan(r.Context(), userFrom(r.Context()), p)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	out := importPreview{Format: p.Format, Items: items, Warnings: p.Warnings}
	if out.Warnings == nil {
		out.Warnings = []string{}
	}
	for _, it := range items {
		switch {
		case len(it.Problems) > 0:
			out.Invalid++
		case it.Conflict:
			out.Conflict++
		default:
			out.Valid++
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type importResult struct {
	CreatedDevices     int      `json:"created_devices"`
	CreatedConnections int      `json:"created_connections"`
	CreatedGroups      int      `json:"created_groups"`
	Skipped            int      `json:"skipped"`
	Renamed            int      `json:"renamed"`
	Invalid            int      `json:"invalid"`
	Errors             []string `json:"errors"`
}

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeImportRequest(w, r)
	if !ok {
		return
	}
	if req.OnConflict != "skip" && req.OnConflict != "rename" {
		writeError(w, http.StatusBadRequest, "bad_request", "on_conflict must be skip or rename")
		return
	}
	u := userFrom(r.Context())
	p, err := parseImport(req.Format, req.Content)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "import_failed", err.Error())
		return
	}
	plans, items, err := s.plan(r.Context(), u, p)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	owner := u.OwnerScope()
	res := importResult{Errors: []string{}}

	// Groups: reuse the importer's own groups by name, create the rest.
	groupIDs := map[string]string{}
	existingGroups, _ := s.store.ListGroups(r.Context(), u.ID)
	for _, g := range existingGroups {
		if sameOwner(g.OwnerID, owner) {
			groupIDs[strings.ToLower(g.Name)] = g.ID
		}
	}
	descr := map[string]string{}
	for _, g := range p.Groups {
		descr[strings.ToLower(strings.TrimSpace(g.Name))] = strings.TrimSpace(g.Description)
	}
	groupFor := func(name string) *string {
		if name == "" {
			return nil
		}
		key := strings.ToLower(name)
		if id, ok := groupIDs[key]; ok {
			return &id
		}
		g, err := s.store.CreateGroup(r.Context(), owner, name, descr[key])
		if err != nil {
			res.Errors = append(res.Errors, "group "+name+": "+errorText(err))
			return nil
		}
		groupIDs[key] = g.ID
		res.CreatedGroups++
		return &g.ID
	}

	taken := map[string]bool{}
	existing, _ := s.store.ListDevices(r.Context(), u.ID)
	for _, d := range existing {
		if sameOwner(d.OwnerID, owner) {
			taken[strings.ToLower(d.Name)] = true
		}
	}
	for i, pl := range plans {
		it := items[i]
		if len(it.Problems) > 0 {
			res.Invalid++
			continue
		}
		in := pl.device
		if it.Conflict {
			if req.OnConflict == "skip" {
				res.Skipped++
				continue
			}
			base := in.Name
			for n := 2; taken[strings.ToLower(in.Name)] || n == 2; n++ {
				in.Name = fmt.Sprintf("%s (%d)", base, n)
				if !taken[strings.ToLower(in.Name)] {
					break
				}
			}
			res.Renamed++
		}
		taken[strings.ToLower(in.Name)] = true
		in.GroupID = groupFor(pl.group)
		d, err := s.store.CreateDevice(r.Context(), u.ID, owner, in)
		if err != nil {
			res.Errors = append(res.Errors, in.Name+": "+errorText(err))
			continue
		}
		res.CreatedDevices++
		for _, c := range pl.conns {
			if _, err := s.store.CreateConnection(r.Context(), d.ID, c, nil); err != nil {
				res.Errors = append(res.Errors, in.Name+" "+c.Protocol+": "+errorText(err))
				continue
			}
			res.CreatedConnections++
		}
		go s.checkDeviceAsync(d.ID)
	}
	s.audit(r, "inventory.import", "inventory", "", "Inventory import", len(res.Errors) == 0, map[string]any{
		"format": p.Format, "devices": res.CreatedDevices, "connections": res.CreatedConnections, "groups": res.CreatedGroups,
		"skipped": res.Skipped, "renamed": res.Renamed, "invalid": res.Invalid, "on_conflict": req.OnConflict, "shared": owner == nil,
	})
	writeJSON(w, http.StatusOK, res)
}

func errorText(err error) string {
	switch {
	case errors.Is(err, store.ErrConflict):
		return "already exists"
	case errors.Is(err, store.ErrNotFound):
		return "not found"
	}
	return "could not be saved"
}
