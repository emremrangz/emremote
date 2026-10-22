package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- Groups ----

type Group struct {
	ID          string    `json:"id"`
	OwnerID     *string   `json:"owner_id"`
	CanManage   bool      `json:"can_manage"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	DeviceCount int       `json:"device_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// ListGroups returns the groups a user can see; counts include only visible devices.
func (s *Store) ListGroups(ctx context.Context, uid string) ([]Group, error) {
	rows, err := s.pool.Query(ctx, `SELECT g.id, g.owner_id, g.name, g.description, count(d.id), g.created_at, g.updated_at
		FROM device_groups g LEFT JOIN device_group_members m ON m.group_id = g.id
		LEFT JOIN devices d ON d.id = m.device_id AND d.id IN (SELECT emr_visible_devices($1))
		WHERE g.id IN (SELECT emr_visible_groups($1))
		GROUP BY g.id ORDER BY lower(g.name)`, uid)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Group, error) {
		var g Group
		err := r.Scan(&g.ID, &g.OwnerID, &g.Name, &g.Description, &g.DeviceCount, &g.CreatedAt, &g.UpdatedAt)
		return g, err
	})
}

func (s *Store) GetGroup(ctx context.Context, id string) (*Group, error) {
	var g Group
	err := s.pool.QueryRow(ctx, `SELECT g.id, g.owner_id, g.name, g.description,
		(SELECT count(*) FROM device_group_members m WHERE m.group_id = g.id), g.created_at, g.updated_at
		FROM device_groups g WHERE g.id = $1`, id).Scan(&g.ID, &g.OwnerID, &g.Name, &g.Description, &g.DeviceCount, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &g, nil
}

func (s *Store) CreateGroup(ctx context.Context, owner *string, name, description string) (*Group, error) {
	var id string
	if err := s.pool.QueryRow(ctx, `INSERT INTO device_groups (owner_id, name, description) VALUES ($1, $2, $3) RETURNING id`, owner, name, description).Scan(&id); err != nil {
		return nil, mapErr(err)
	}
	return s.GetGroup(ctx, id)
}

func (s *Store) UpdateGroup(ctx context.Context, id, name, description string) (*Group, error) {
	if err := execOne(ctx, s.pool, `UPDATE device_groups SET name = $2, description = $3, updated_at = now() WHERE id = $1`, id, name, description); err != nil {
		return nil, err
	}
	return s.GetGroup(ctx, id)
}

func (s *Store) DeleteGroup(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM device_groups WHERE id = $1`, id)
}

// ---- Devices ----

type Device struct {
	ID          string   `json:"id"`
	OwnerID     *string  `json:"owner_id"`
	CanManage   bool     `json:"can_manage"`
	Name        string   `json:"name"`
	Hostname    string   `json:"hostname"`
	Address     string   `json:"address"`
	OS          string   `json:"os"`
	DeviceType  string   `json:"device_type"`
	Description string   `json:"description"`
	Notes       string   `json:"notes"`
	Tags        []string `json:"tags"`
	// GroupID and GroupName are the first group; Groups lists all of them, in order.
	GroupID        *string             `json:"group_id"`
	GroupName      *string             `json:"group_name"`
	Groups         []GroupRef          `json:"groups"`
	Favorite       bool                `json:"favorite"`
	CreatedAt      time.Time           `json:"created_at"`
	UpdatedAt      time.Time           `json:"updated_at"`
	LastAccessedAt *time.Time          `json:"last_accessed_at"`
	Connections    []ConnectionSummary `json:"connections"`
	// Facts are details read from the device itself (os, kernel, arch, cpu, memory), empty until known.
	Facts json.RawMessage `json:"facts"`
	// MAC and WOLBroadcast support Wake-on-LAN.
	MAC          string `json:"mac"`
	WOLBroadcast string `json:"wol_broadcast"`
	// Location is where the device is (for the map); nil when not set.
	Location *Location `json:"location"`
}

// GroupRef names a group a device belongs to.
type GroupRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Location is a place on the map with an optional name ("Istanbul, Turkey").
type Location struct {
	Label     string  `json:"label"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// DeviceInput holds the user-editable device fields.
type DeviceInput struct {
	Name        string
	Hostname    string
	Address     string
	OS          string
	DeviceType  string
	Description string
	Notes       string
	Tags        []string
	// GroupIDs are the groups the device belongs to; the first one is its main group.
	GroupIDs []string
	// SetGroups says whether GroupIDs is to be stored on an update (a request that does not mention groups keeps them).
	SetGroups bool
	Favorite  bool
	// MAC and WOLBroadcast: nil keeps the stored value.
	MAC          *string
	WOLBroadcast *string
	// SetLocation says whether Location is to be stored (nil Location then clears it); false keeps what is stored.
	SetLocation bool
	Location    *Location
}

// Devices are always read for a viewer (the user whose favorites and "last
// opened" times are shown); that user id is parameter $1 of every query.
const deviceCols = `d.id, d.owner_id, d.name, d.hostname, d.address, d.os, d.device_type, d.description, d.notes, d.tags,
	pg.group_id, pg.name, COALESCE(st.favorite, false), d.created_at, d.updated_at, st.last_accessed_at, d.facts, d.mac, d.wol_broadcast,
	d.latitude, d.longitude, d.location,
	COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.group_id, 'name', g3.name) ORDER BY m.position, lower(g3.name))
		FROM device_group_members m JOIN device_groups g3 ON g3.id = m.group_id WHERE m.device_id = d.id), '[]'::jsonb)`

const deviceFrom = ` FROM devices d LEFT JOIN LATERAL (
		SELECT m.group_id, g2.name FROM device_group_members m JOIN device_groups g2 ON g2.id = m.group_id
		WHERE m.device_id = d.id ORDER BY m.position, lower(g2.name) LIMIT 1) pg ON true
	LEFT JOIN device_user_state st ON st.device_id = d.id AND st.user_id = $1 `

func scanDevice(row pgx.Row) (*Device, error) {
	var d Device
	var lat, lon *float64
	var label string
	var groupsJSON []byte
	err := row.Scan(&d.ID, &d.OwnerID, &d.Name, &d.Hostname, &d.Address, &d.OS, &d.DeviceType, &d.Description, &d.Notes, &d.Tags,
		&d.GroupID, &d.GroupName, &d.Favorite, &d.CreatedAt, &d.UpdatedAt, &d.LastAccessedAt, &d.Facts, &d.MAC, &d.WOLBroadcast, &lat, &lon, &label, &groupsJSON)
	if err != nil {
		return nil, mapErr(err)
	}
	if lat != nil && lon != nil {
		d.Location = &Location{Label: label, Latitude: *lat, Longitude: *lon}
	}
	if d.Tags == nil {
		d.Tags = []string{}
	}
	if err := json.Unmarshal(groupsJSON, &d.Groups); err != nil || d.Groups == nil {
		d.Groups = []GroupRef{}
	}
	d.Connections = []ConnectionSummary{}
	return &d, nil
}

// ListDevices returns the devices uid can see.
func (s *Store) ListDevices(ctx context.Context, uid string) ([]*Device, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+deviceCols+deviceFrom+`
		WHERE d.id IN (SELECT emr_visible_devices($1)) ORDER BY COALESCE(st.favorite, false) DESC, lower(d.name)`, uid)
	if err != nil {
		return nil, err
	}
	devices, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Device, error) { return scanDevice(r) })
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*Device, len(devices))
	for _, d := range devices {
		byID[d.ID] = d
	}
	summaries, err := s.listConnectionSummaries(ctx, "")
	if err != nil {
		return nil, err
	}
	for _, c := range summaries {
		if d := byID[c.DeviceID]; d != nil {
			d.Connections = append(d.Connections, c)
		}
	}
	if devices == nil {
		devices = []*Device{}
	}
	return devices, nil
}

// GetDevice reads one device regardless of visibility (callers check access first).
func (s *Store) GetDevice(ctx context.Context, uid, id string) (*Device, error) {
	d, err := scanDevice(s.pool.QueryRow(ctx, `SELECT `+deviceCols+deviceFrom+` WHERE d.id = $2`, uid, id))
	if err != nil {
		return nil, err
	}
	d.Connections, err = s.listConnectionSummaries(ctx, id)
	return d, err
}

// DeviceAccess reports whether uid can see a device and who owns it
// (nil owner = shared inventory). ErrNotFound if the device does not exist.
func (s *Store) DeviceAccess(ctx context.Context, uid, id string) (visible bool, owner *string, err error) {
	err = s.pool.QueryRow(ctx, `SELECT d.id IN (SELECT emr_visible_devices($1)), d.owner_id FROM devices d WHERE d.id = $2`, uid, id).Scan(&visible, &owner)
	return visible, owner, mapErr(err)
}

// ConnectionDevice returns the device a connection belongs to.
func (s *Store) ConnectionDevice(ctx context.Context, id string) (string, error) {
	var dev string
	err := s.pool.QueryRow(ctx, `SELECT device_id::text FROM connections WHERE id = $1`, id).Scan(&dev)
	return dev, mapErr(err)
}

// GroupOwner returns a group's owner (nil = shared). ErrNotFound if missing.
func (s *Store) GroupOwner(ctx context.Context, id string) (*string, error) {
	var owner *string
	err := s.pool.QueryRow(ctx, `SELECT owner_id FROM device_groups WHERE id = $1`, id).Scan(&owner)
	return owner, mapErr(err)
}

// CreateDevice adds a device owned by owner (nil = shared); uid's favorite flag is set from in.Favorite.
func (s *Store) CreateDevice(ctx context.Context, uid string, owner *string, in DeviceInput) (*Device, error) {
	var id string
	lat, lon, label := locationColumns(in.Location)
	err := s.pool.QueryRow(ctx, `INSERT INTO devices (owner_id, name, hostname, address, os, device_type, description, notes, tags, mac, wol_broadcast, latitude, longitude, location)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, ''), COALESCE($11, ''), $12, $13, $14) RETURNING id`,
		owner, in.Name, in.Hostname, in.Address, in.OS, in.DeviceType, in.Description, in.Notes, in.Tags, in.MAC, in.WOLBroadcast, lat, lon, label).Scan(&id)
	if err != nil {
		return nil, mapErr(err)
	}
	if err := s.setDeviceGroups(ctx, id, in.GroupIDs); err != nil {
		_ = s.DeleteDevice(ctx, id)
		return nil, err
	}
	if in.Favorite {
		if err := s.SetFavorite(ctx, uid, id, true); err != nil {
			return nil, err
		}
	}
	return s.GetDevice(ctx, uid, id)
}

func (s *Store) UpdateDevice(ctx context.Context, uid, id string, in DeviceInput) (*Device, error) {
	err := execOne(ctx, s.pool, `UPDATE devices SET name = $2, hostname = $3, address = $4, os = $5, device_type = $6,
		description = $7, notes = $8, tags = $9, mac = COALESCE($10, mac), wol_broadcast = COALESCE($11, wol_broadcast),
		latitude = CASE WHEN $12 THEN $13::float8 ELSE latitude END, longitude = CASE WHEN $12 THEN $14::float8 ELSE longitude END,
		location = CASE WHEN $12 THEN $15 ELSE location END, updated_at = now() WHERE id = $1`,
		id, in.Name, in.Hostname, in.Address, in.OS, in.DeviceType, in.Description, in.Notes, in.Tags, in.MAC, in.WOLBroadcast,
		in.SetLocation, locLat(in.Location), locLon(in.Location), locLabel(in.Location))
	if err != nil {
		return nil, err
	}
	if in.SetGroups {
		if err := s.setDeviceGroups(ctx, id, in.GroupIDs); err != nil {
			return nil, err
		}
	}
	if err := s.SetFavorite(ctx, uid, id, in.Favorite); err != nil {
		return nil, err
	}
	// Reachability results are for the old address; clear them.
	if _, err := s.pool.Exec(ctx, `UPDATE connections SET status_reachable = NULL, status_checked_at = NULL, status_detail = ''
		WHERE device_id = $1`, id); err != nil {
		return nil, err
	}
	return s.GetDevice(ctx, uid, id)
}

// SetFavorite stars a device for one user only.
func (s *Store) SetFavorite(ctx context.Context, uid, id string, fav bool) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO device_user_state (user_id, device_id, favorite) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, device_id) DO UPDATE SET favorite = EXCLUDED.favorite`, uid, id, fav)
	return mapErr(err)
}

func (s *Store) DeleteDevice(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM devices WHERE id = $1`, id)
}

// ---- Dashboard ----

type Dashboard struct {
	DeviceCount      int            `json:"device_count"`
	FavoriteCount    int            `json:"favorite_count"`
	ConnectionCount  int            `json:"connection_count"`
	CredentialCount  int            `json:"credential_count"`
	GroupCount       int            `json:"group_count"`
	Protocols        map[string]int `json:"protocols"`
	OperatingSystems map[string]int `json:"operating_systems"`
	Reachability     map[string]int `json:"reachability"`
	RecentlyAccessed []*Device      `json:"recently_accessed"`
	RecentlyCreated  []*Device      `json:"recently_created"`
	Favorites        []*Device      `json:"favorites"`
	RecentActivity   []AuditEvent   `json:"recent_activity"`
	// SessionsByDay counts remote sessions started on each of the last 14 days (oldest first).
	SessionsByDay []DayCount `json:"sessions_by_day"`
	// TopDevices are the most used devices of the last 30 days.
	TopDevices []DeviceUse `json:"top_devices"`
	// Attention lists connection methods whose last check failed.
	Attention []Unreachable `json:"attention"`
}

type DayCount struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

type DeviceUse struct {
	DeviceID string `json:"device_id"`
	Name     string `json:"name"`
	Sessions int    `json:"sessions"`
}

type Unreachable struct {
	DeviceID  string     `json:"device_id"`
	Name      string     `json:"name"`
	Address   string     `json:"address"`
	Protocol  string     `json:"protocol"`
	Port      int        `json:"port"`
	Detail    string     `json:"detail"`
	CheckedAt *time.Time `json:"checked_at"`
}

// Dashboard summarises what u can see: their visible devices, their own
// saved credentials and, unless u is an administrator, only their own activity.
func (s *Store) Dashboard(ctx context.Context, u *User) (*Dashboard, error) {
	d := &Dashboard{Protocols: map[string]int{}, OperatingSystems: map[string]int{}, Reachability: map[string]int{}}
	err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM devices WHERE id IN (SELECT emr_visible_devices($1))),
		(SELECT count(*) FROM device_user_state st WHERE st.user_id = $1 AND st.favorite AND st.device_id IN (SELECT emr_visible_devices($1))),
		(SELECT count(*) FROM connections WHERE device_id IN (SELECT emr_visible_devices($1))),
		(SELECT count(*) FROM credentials WHERE owner_id IS NOT DISTINCT FROM $2::uuid),
		(SELECT count(*) FROM device_groups WHERE id IN (SELECT emr_visible_groups($1)))`, u.ID, u.OwnerScope()).
		Scan(&d.DeviceCount, &d.FavoriteCount, &d.ConnectionCount, &d.CredentialCount, &d.GroupCount)
	if err != nil {
		return nil, err
	}
	var protocols, oses, reach []byte
	err = s.pool.QueryRow(ctx, `WITH vd AS (SELECT emr_visible_devices($1) AS id)
		SELECT
		COALESCE((SELECT jsonb_object_agg(protocol, n) FROM (SELECT protocol, count(*) n FROM connections WHERE device_id IN (SELECT id FROM vd) GROUP BY protocol) p), '{}'),
		COALESCE((SELECT jsonb_object_agg(os, n) FROM (SELECT os, count(*) n FROM devices WHERE id IN (SELECT id FROM vd) GROUP BY os) o), '{}'),
		COALESCE((SELECT jsonb_object_agg(state, n) FROM (
			SELECT CASE WHEN status_reachable IS NULL THEN 'unknown' WHEN status_reachable THEN 'reachable' ELSE 'unreachable' END state,
			count(*) n FROM connections WHERE device_id IN (SELECT id FROM vd) GROUP BY 1) r), '{}')`, u.ID).Scan(&protocols, &oses, &reach)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(protocols, &d.Protocols)
	_ = json.Unmarshal(oses, &d.OperatingSystems)
	_ = json.Unmarshal(reach, &d.Reachability)

	all, err := s.ListDevices(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	d.RecentlyAccessed = topDevices(all, func(x *Device) *time.Time { return x.LastAccessedAt }, 6)
	d.RecentlyCreated = topDevices(all, func(x *Device) *time.Time { return &x.CreatedAt }, 6)
	d.Favorites = []*Device{}
	for _, x := range all {
		if x.Favorite && len(d.Favorites) < 8 {
			d.Favorites = append(d.Favorites, x)
		}
	}
	f := AuditFilter{Limit: 10}
	if !u.IsAdmin() {
		f.ActorID = u.ID
	}
	d.RecentActivity, _, err = s.ListAudit(ctx, f)
	if err != nil {
		return nil, err
	}
	d.SessionsByDay, d.TopDevices, d.Attention = []DayCount{}, []DeviceUse{}, []Unreachable{}
	var actor *string // nil: everyone's sessions (administrators)
	if !u.IsAdmin() {
		actor = &u.ID
	}
	rows, err := s.pool.Query(ctx, `SELECT to_char(g::date, 'YYYY-MM-DD'), COALESCE(c.n, 0)
		FROM generate_series(current_date - 13, current_date, interval '1 day') g
		LEFT JOIN (SELECT occurred_at::date AS day, count(*) AS n FROM audit_events
			WHERE action = 'session.start' AND success AND occurred_at >= current_date - 13 AND ($1::uuid IS NULL OR actor_user_id = $1::uuid)
			GROUP BY 1) c ON c.day = g::date ORDER BY g`, actor)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x DayCount
		if err := rows.Scan(&x.Date, &x.Count); err != nil {
			rows.Close()
			return nil, err
		}
		d.SessionsByDay = append(d.SessionsByDay, x)
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT dv.id, dv.name, count(*) FROM audit_events a
		JOIN devices dv ON dv.id::text = a.details->>'device_id'
		WHERE a.action = 'session.start' AND a.success AND a.occurred_at >= now() - interval '30 days'
			AND dv.id IN (SELECT emr_visible_devices($1)) AND ($2::uuid IS NULL OR a.actor_user_id = $2::uuid)
		GROUP BY dv.id, dv.name ORDER BY count(*) DESC, dv.name LIMIT 5`, u.ID, actor)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x DeviceUse
		if err := rows.Scan(&x.DeviceID, &x.Name, &x.Sessions); err != nil {
			rows.Close()
			return nil, err
		}
		d.TopDevices = append(d.TopDevices, x)
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT dv.id, dv.name, dv.address, c.protocol, c.port, c.status_detail, c.status_checked_at
		FROM connections c JOIN devices dv ON dv.id = c.device_id
		WHERE c.status_reachable = false AND dv.id IN (SELECT emr_visible_devices($1))
		ORDER BY c.status_checked_at DESC NULLS LAST LIMIT 6`, u.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x Unreachable
		if err := rows.Scan(&x.DeviceID, &x.Name, &x.Address, &x.Protocol, &x.Port, &x.Detail, &x.CheckedAt); err != nil {
			rows.Close()
			return nil, err
		}
		d.Attention = append(d.Attention, x)
	}
	rows.Close()
	return d, nil
}

func topDevices(all []*Device, key func(*Device) *time.Time, n int) []*Device {
	out := []*Device{}
	for _, d := range all {
		if key(d) != nil {
			out = append(out, d)
		}
	}
	// insertion sort, newest first; inventories are small
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && key(out[j]).After(*key(out[j-1])); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// SetDeviceFacts records what was read from the device. The configured OS
// is only filled in while it is still "other"; hostname only while empty.
func (s *Store) SetDeviceFacts(ctx context.Context, id string, facts json.RawMessage, os, hostname, mac string) error {
	_, err := s.pool.Exec(ctx, `UPDATE devices SET facts = $2,
		os = CASE WHEN os = 'other' AND $3 <> '' THEN $3 ELSE os END,
		hostname = CASE WHEN hostname = '' THEN $4 ELSE hostname END,
		mac = CASE WHEN mac = '' THEN $5 ELSE mac END WHERE id = $1`, id, facts, os, hostname, mac)
	return err
}

func locationColumns(l *Location) (lat, lon *float64, label string) {
	return locLat(l), locLon(l), locLabel(l)
}

func locLat(l *Location) *float64 {
	if l == nil {
		return nil
	}
	return &l.Latitude
}

func locLon(l *Location) *float64 {
	if l == nil {
		return nil
	}
	return &l.Longitude
}

func locLabel(l *Location) string {
	if l == nil {
		return ""
	}
	return l.Label
}

// setDeviceGroups makes ids the groups of a device, in that order (the first is its main group). A group that does not
// exist is ErrNotFound. devices.group_id is kept equal to the first one for older readers.
func (s *Store) setDeviceGroups(ctx context.Context, deviceID string, ids []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM device_group_members WHERE device_id = $1`, deviceID); err != nil {
		return err
	}
	var first *string
	for i, g := range ids {
		if _, err := tx.Exec(ctx, `INSERT INTO device_group_members (device_id, group_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, deviceID, g, i); err != nil {
			return mapErr(err)
		}
		if first == nil {
			g := g
			first = &g
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE devices SET group_id = $2 WHERE id = $1`, deviceID, first); err != nil {
		return mapErr(err)
	}
	return tx.Commit(ctx)
}
