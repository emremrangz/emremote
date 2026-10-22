package api

import (
	"context"
	"math"
	"net/http"
	"net/netip"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/emremrangz/emremote/internal/store"
	"github.com/emremrangz/emremote/internal/wol"
)

// ---- Groups ----

type groupRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (req groupRequest) validate() (*validator, groupRequest) {
	v := newValidator()
	req.Name = v.text("name", req.Name, true, 64, false)
	req.Description = v.text("description", req.Description, false, 500, false)
	return v, req
}

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	groups, err := s.store.ListGroups(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, r, err, "group")
		return
	}
	if groups == nil {
		groups = []store.Group{}
	}
	for i := range groups {
		groups[i].CanManage = canManageOwner(u, groups[i].OwnerID, store.PermInventory)
	}
	writeJSON(w, http.StatusOK, groups)
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	var req groupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, req := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	u := userFrom(r.Context())
	g, err := s.store.CreateGroup(r.Context(), u.OwnerScope(), req.Name, req.Description)
	if err != nil {
		writeStoreError(w, r, err, "Group")
		return
	}
	g.CanManage = true
	s.audit(r, "group.create", "group", g.ID, g.Name, true, nil)
	writeJSON(w, http.StatusCreated, g)
}

func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validUUID(id) {
		writeError(w, http.StatusNotFound, "not_found", "Group not found")
		return
	}
	var req groupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, req := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	g, err := s.store.UpdateGroup(r.Context(), id, req.Name, req.Description)
	if err != nil {
		writeStoreError(w, r, err, "Group")
		return
	}
	g.CanManage = true
	s.audit(r, "group.update", "group", g.ID, g.Name, true, nil)
	writeJSON(w, http.StatusOK, g)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	g, err := s.store.GetGroup(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Group")
		return
	}
	if err := s.store.DeleteGroup(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Group")
		return
	}
	s.audit(r, "group.delete", "group", g.ID, g.Name, true, map[string]any{"devices_ungrouped": g.DeviceCount})
	w.WriteHeader(http.StatusNoContent)
}

// ---- Devices ----

type deviceRequest struct {
	Name        string   `json:"name"`
	Hostname    string   `json:"hostname"`
	Address     string   `json:"address"`
	OS          string   `json:"os"`
	DeviceType  string   `json:"device_type"`
	Description string   `json:"description"`
	Notes       string   `json:"notes"`
	Tags        []string `json:"tags"`
	// GroupID is the older single-group form; GroupIDs lists every group, the first one being the main group.
	GroupID  *string  `json:"group_id"`
	GroupIDs []string `json:"group_ids"`
	Favorite bool     `json:"favorite"`
	// MAC and WOLBroadcast are optional; leaving them out keeps what is stored, "" clears.
	MAC          *string `json:"mac"`
	WOLBroadcast *string `json:"wol_broadcast"`
	// Location is where the device is. Leaving it out keeps what is stored; sending latitude and longitude as null clears it.
	Location *locationRequest `json:"location"`
}

type locationRequest struct {
	Label     string   `json:"label"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
}

func (req deviceRequest) validate() (*validator, store.DeviceInput) {
	v := newValidator()
	in := store.DeviceInput{
		Name:        v.text("name", req.Name, true, 128, false),
		Hostname:    v.address("hostname", req.Hostname, false),
		Address:     v.address("address", req.Address, true),
		OS:          v.oneOf("os", req.OS, "windows", "macos", "linux", "network", "esxi", "other"),
		DeviceType:  v.oneOf("device_type", req.DeviceType, "desktop", "laptop", "server", "virtual_machine", "network", "other"),
		Description: v.text("description", req.Description, false, 500, false),
		Notes:       v.text("notes", req.Notes, false, 10000, true),
		Tags:        v.tags("tags", req.Tags),
		Favorite:    req.Favorite,
	}
	switch {
	case req.GroupIDs != nil:
		in.SetGroups = true
		if len(req.GroupIDs) > 12 {
			v.fail("group_ids", "A device can be in at most 12 groups")
		}
		seen := map[string]bool{}
		for _, g := range req.GroupIDs {
			g := g
			if id := v.optionalUUID("group_ids", &g); id != nil && !seen[*id] {
				seen[*id] = true
				in.GroupIDs = append(in.GroupIDs, *id)
			}
		}
	case req.GroupID != nil:
		in.SetGroups = true
		if id := v.optionalUUID("group_id", req.GroupID); id != nil {
			in.GroupIDs = []string{*id}
		}
	}
	if req.MAC != nil {
		m := strings.TrimSpace(*req.MAC)
		if m != "" {
			if canon, err := wol.ParseMAC(m); err != nil {
				v.fail("mac", err.Error())
			} else {
				m = canon
			}
		}
		in.MAC = &m
	}
	if req.WOLBroadcast != nil {
		bc := strings.TrimSpace(*req.WOLBroadcast)
		if bc != "" {
			if a, err := netip.ParseAddr(bc); err != nil || !a.Is4() {
				v.fail("wol_broadcast", "Enter an IPv4 address, for example 192.168.1.255")
			}
		}
		in.WOLBroadcast = &bc
	}
	if req.Location != nil {
		in.SetLocation = true
		l := req.Location
		label := v.text("location.label", l.Label, false, 100, false)
		switch {
		case l.Latitude == nil && l.Longitude == nil:
			// clears the location
		case l.Latitude == nil || l.Longitude == nil:
			v.fail("location", "Give both latitude and longitude")
		case *l.Latitude < -90 || *l.Latitude > 90 || math.IsNaN(*l.Latitude):
			v.fail("location.latitude", "Latitude must be between -90 and 90")
		case *l.Longitude < -180 || *l.Longitude > 180 || math.IsNaN(*l.Longitude):
			v.fail("location.longitude", "Longitude must be between -180 and 180")
		default:
			in.Location = &store.Location{Label: label, Latitude: *l.Latitude, Longitude: *l.Longitude}
		}
	}
	return v, in
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	devices, err := s.store.ListDevices(r.Context(), u.ID)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	for _, d := range devices {
		d.CanManage = canManageOwner(u, d.OwnerID, store.PermInventory)
	}
	writeJSON(w, http.StatusOK, devices)
}

func (s *Server) handleGetDevice(w http.ResponseWriter, r *http.Request) {
	d, err := s.getDevice(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	d.CanManage = canManageOwner(userFrom(r.Context()), d.OwnerID, store.PermInventory)
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleCreateDevice(w http.ResponseWriter, r *http.Request) {
	var req deviceRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, in := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	u := userFrom(r.Context())
	if !s.groupsUsable(r.Context(), in.GroupIDs, u.OwnerScope()) {
		v.fail("group_ids", "A group does not exist")
		writeValidation(w, v)
		return
	}
	d, err := s.store.CreateDevice(r.Context(), u.ID, u.OwnerScope(), in)
	if err != nil {
		if err == store.ErrNotFound {
			v.fail("group_ids", "A group does not exist")
			writeValidation(w, v)
			return
		}
		writeStoreError(w, r, err, "Device")
		return
	}
	d.CanManage = true
	s.audit(r, "device.create", "device", d.ID, d.Name, true, map[string]any{"address": d.Address, "os": d.OS, "shared": d.OwnerID == nil})
	writeJSON(w, http.StatusCreated, d)
}

func (s *Server) handleUpdateDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	before, err := s.getDevice(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	var req deviceRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, in := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	if in.SetGroups && !s.groupsUsable(r.Context(), in.GroupIDs, before.OwnerID) {
		v.fail("group_ids", "A group does not exist")
		writeValidation(w, v)
		return
	}
	if in.Address != before.Address {
		// Connections that go through a jump host need an address behind it.
		if conns, err := s.store.ListConnections(r.Context(), userFrom(r.Context()).ID, id); err == nil {
			for _, c := range conns {
				if jumpIDOf(c.Settings) == "" {
					continue
				}
				jv := newValidator()
				s.validateJump(r.Context(), jv, c.Settings, before.OwnerID, c.ID, in.Address)
				if !jv.ok() {
					v.fail("address", "The "+c.Name+" connection uses a jump host: "+jv.summary())
					writeValidation(w, v)
					return
				}
			}
		}
	}
	d, err := s.store.UpdateDevice(r.Context(), userFrom(r.Context()).ID, id, in)
	if err != nil {
		if err == store.ErrNotFound {
			v.fail("group_id", "Group does not exist")
			writeValidation(w, v)
			return
		}
		writeStoreError(w, r, err, "Device")
		return
	}
	d.CanManage = true
	s.audit(r, "device.update", "device", d.ID, d.Name, true, map[string]any{"changed": changedDeviceFields(before, d)})
	writeJSON(w, http.StatusOK, d)
	if before.Address != d.Address {
		go s.checkDeviceAsync(d.ID)
	}
}

func changedDeviceFields(a, b *store.Device) []string {
	var out []string
	cmp := func(name string, x, y any) {
		if !reflect.DeepEqual(x, y) {
			out = append(out, name)
		}
	}
	cmp("name", a.Name, b.Name)
	cmp("hostname", a.Hostname, b.Hostname)
	cmp("address", a.Address, b.Address)
	cmp("os", a.OS, b.OS)
	cmp("device_type", a.DeviceType, b.DeviceType)
	cmp("description", a.Description, b.Description)
	cmp("notes", a.Notes, b.Notes)
	cmp("tags", a.Tags, b.Tags)
	cmp("groups", a.Groups, b.Groups)
	cmp("favorite", a.Favorite, b.Favorite)
	if out == nil {
		out = []string{}
	}
	return out
}

func (s *Server) handleDeleteDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d, err := s.getDevice(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	for _, c := range d.Connections {
		if n := s.jumpUsers(r.Context(), c.ID); n > 0 {
			if !s.jumpUsersAllOn(r.Context(), c.ID, d.ID) {
				writeError(w, http.StatusConflict, "jump_in_use", "A connection of this device is the jump host of connections on other devices. Change those first.")
				return
			}
		}
	}
	// Close any live sessions to this device first.
	for _, c := range d.Connections {
		s.tunnels.terminateConnection(c.ID)
		s.access.closeConnection(c.ID)
	}
	if err := s.store.DeleteDevice(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	s.audit(r, "device.delete", "device", d.ID, d.Name, true, map[string]any{"address": d.Address, "connections_deleted": len(d.Connections)})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSetFavorite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Favorite bool `json:"favorite"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	id := r.PathValue("id")
	if err := s.store.SetFavorite(r.Context(), userFrom(r.Context()).ID, id, req.Favorite); err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	d, err := s.getDevice(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	d.CanManage = canManageOwner(userFrom(r.Context()), d.OwnerID, store.PermInventory)
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) handleCheckDevice(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.getDevice(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.checker.CheckAll(ctx, id); err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	d, err := s.getDevice(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	d.CanManage = canManageOwner(userFrom(r.Context()), d.OwnerID, store.PermInventory)
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) checkDeviceAsync(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = s.checker.CheckAll(ctx, id)
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	d, err := s.store.Dashboard(r.Context(), u)
	if err != nil {
		writeStoreError(w, r, err, "Dashboard")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"stats":           d,
		"active_sessions": s.visibleTunnels(u),
	})
}

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.AuditFilter{
		Action:   q.Get("action"),
		TargetID: q.Get("target_id"),
		Query:    truncate(q.Get("q"), 100),
		Failures: q.Get("failures") == "true",
		DeviceID: q.Get("device_id"),
	}
	if u := userFrom(r.Context()); !u.IsAdmin() {
		f.ActorID = u.ID // members see their own activity only
	}
	if f.DeviceID != "" && !validUUID(f.DeviceID) {
		writeError(w, http.StatusBadRequest, "bad_request", "Invalid device_id")
		return
	}
	if c := q.Get("cursor"); c != "" {
		n, err := strconv.ParseInt(c, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "bad_request", "Invalid cursor")
			return
		}
		f.Before = n
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 200 {
			writeError(w, http.StatusBadRequest, "bad_request", "Invalid limit (1–200)")
			return
		}
		f.Limit = n
	}
	if f.Action != "" && !slices.Contains(knownActionFilters, f.Action) {
		writeError(w, http.StatusBadRequest, "bad_request", "Unknown action filter")
		return
	}
	events, next, err := s.store.ListAudit(r.Context(), f)
	if err != nil {
		writeStoreError(w, r, err, "Audit event")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "next_cursor": next})
}

var knownActionFilters = []string{
	"auth.", "device.", "group.", "settings.", "connection.", "credential.", "session.", "file.", "ssh.", "user.", "team.", "inventory.", "snippet.", "system.",
	"auth.login", "auth.logout", "auth.setup", "auth.password_change", "auth.password_reset", "auth.sessions_revoked",
	"session.start", "session.end", "session.terminate", "connection.identity_pinned",
}
