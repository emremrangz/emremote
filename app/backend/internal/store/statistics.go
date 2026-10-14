package store

import (
	"context"
)

// Statistics is the data behind the Statistics page for one user: what they can
// see (devices) and, unless they are an administrator, only their own activity.
type Statistics struct {
	Days   int `json:"days"`
	Totals struct {
		Sessions      int   `json:"sessions"`
		Failed        int   `json:"failed"`
		UniqueDevices int   `json:"unique_devices"`
		TotalSeconds  int64 `json:"total_seconds"`
		Ended         int   `json:"ended"`
	} `json:"totals"`
	ByDay      []DayProtocols `json:"by_day"`
	Heatmap    [7][24]int     `json:"heatmap"` // [weekday 0=Sunday][hour]
	TopDevices []DeviceUsage  `json:"top_devices"`
	Users      []UserUsage    `json:"users"`
	Transfers  struct {
		Uploads       int   `json:"uploads"`
		Downloads     int   `json:"downloads"`
		UploadBytes   int64 `json:"upload_bytes"`
		DownloadBytes int64 `json:"download_bytes"`
	} `json:"transfers"`
	Security struct {
		FailedLogins   int  `json:"failed_logins"`
		Users          int  `json:"users"`
		TwoFactorUsers int  `json:"two_factor_users"`
		AdminView      bool `json:"admin_view"`
		SSHPinned      int  `json:"ssh_pinned"`
		SSHTotal       int  `json:"ssh_total"`
		RDPPinned      int  `json:"rdp_pinned"`
		RDPTotal       int  `json:"rdp_total"`
	} `json:"security"`
	Fleet struct {
		Devices      int            `json:"devices"`
		WithFacts    int            `json:"with_facts"`
		Cores        int64          `json:"cores"`
		MemoryBytes  int64          `json:"memory_bytes"`
		Kinds        map[string]int `json:"kinds"`
		Types        map[string]int `json:"types"`
		NeverUsed    int            `json:"never_used"`
		Idle30       int            `json:"idle_30_days"`
		Tags         []NameCount    `json:"tags"`
		Groups       []NameCount    `json:"groups"`
		Reachability map[string]int `json:"reachability"`
	} `json:"fleet"`
}

type DayProtocols struct {
	Date   string `json:"date"`
	RDP    int    `json:"rdp"`
	SSH    int    `json:"ssh"`
	VNC    int    `json:"vnc"`
	Telnet int    `json:"telnet"`
}

type DeviceUsage struct {
	DeviceID string `json:"device_id"`
	Name     string `json:"name"`
	Sessions int    `json:"sessions"`
	Seconds  int64  `json:"seconds"`
}

type UserUsage struct {
	Username string `json:"username"`
	Sessions int    `json:"sessions"`
	Seconds  int64  `json:"seconds"`
}

type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Statistics gathers the numbers for the last days days; tz is an IANA time zone
// name used to decide which day and hour an event belongs to.
func (s *Store) Statistics(ctx context.Context, u *User, days int, tz string) (*Statistics, error) {
	if _, err := s.pool.Exec(ctx, `SELECT now() AT TIME ZONE $1`, tz); err != nil {
		tz = "UTC"
	}
	var actor *string // nil: everyone's activity (administrators)
	if !u.IsAdmin() {
		actor = &u.ID
	}
	st := &Statistics{Days: days, ByDay: []DayProtocols{}, TopDevices: []DeviceUsage{}, Users: []UserUsage{}}
	st.Fleet.Kinds, st.Fleet.Types, st.Fleet.Reachability = map[string]int{}, map[string]int{}, map[string]int{}
	st.Fleet.Tags, st.Fleet.Groups = []NameCount{}, []NameCount{}
	since := `now() - make_interval(days => $3)`
	// $1 and $2 are mentioned in every query that receives them: PostgreSQL cannot type a parameter that is never used.
	who := `($2::uuid IS NULL OR actor_user_id = $2::uuid) AND $1::uuid IS NOT NULL`

	if err := s.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE success), count(*) FILTER (WHERE NOT success),
		count(DISTINCT details->>'device_id') FILTER (WHERE success)
		FROM audit_events WHERE action = 'session.start' AND occurred_at >= `+since+` AND `+who, u.ID, actor, days).
		Scan(&st.Totals.Sessions, &st.Totals.Failed, &st.Totals.UniqueDevices); err != nil {
		return nil, err
	}
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(sum(NULLIF(details->>'duration_s', '')::bigint), 0), count(*)
		FROM audit_events WHERE action = 'session.end' AND occurred_at >= `+since+` AND `+who, u.ID, actor, days).
		Scan(&st.Totals.TotalSeconds, &st.Totals.Ended); err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `SELECT to_char(g::date, 'YYYY-MM-DD'), COALESCE(c.rdp, 0), COALESCE(c.ssh, 0), COALESCE(c.vnc, 0), COALESCE(c.telnet, 0)
		FROM generate_series((now() AT TIME ZONE $4)::date - ($3 - 1), (now() AT TIME ZONE $4)::date, interval '1 day') g
		LEFT JOIN (SELECT (occurred_at AT TIME ZONE $4)::date AS day,
			count(*) FILTER (WHERE details->>'protocol' = 'rdp') AS rdp, count(*) FILTER (WHERE details->>'protocol' = 'ssh') AS ssh,
			count(*) FILTER (WHERE details->>'protocol' = 'vnc') AS vnc, count(*) FILTER (WHERE details->>'protocol' = 'telnet') AS telnet
			FROM audit_events WHERE action = 'session.start' AND success AND occurred_at >= now() - make_interval(days => $3 + 1) AND `+who+`
			GROUP BY 1) c ON c.day = g::date ORDER BY g`, u.ID, actor, days, tz)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x DayProtocols
		if err := rows.Scan(&x.Date, &x.RDP, &x.SSH, &x.VNC, &x.Telnet); err != nil {
			rows.Close()
			return nil, err
		}
		st.ByDay = append(st.ByDay, x)
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `SELECT extract(dow FROM occurred_at AT TIME ZONE $4)::int, extract(hour FROM occurred_at AT TIME ZONE $4)::int, count(*)
		FROM audit_events WHERE action = 'session.start' AND success AND occurred_at >= `+since+` AND `+who+` GROUP BY 1, 2`, u.ID, actor, days, tz)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var dow, hour, n int
		if err := rows.Scan(&dow, &hour, &n); err != nil {
			rows.Close()
			return nil, err
		}
		if dow >= 0 && dow < 7 && hour >= 0 && hour < 24 {
			st.Heatmap[dow][hour] = n
		}
	}
	rows.Close()

	rows, err = s.pool.Query(ctx, `WITH s AS (SELECT details->>'device_id' did, count(*) n FROM audit_events
			WHERE action = 'session.start' AND success AND occurred_at >= `+since+` AND `+who+` GROUP BY 1),
		e AS (SELECT details->>'device_id' did, sum(NULLIF(details->>'duration_s', '')::bigint) secs FROM audit_events
			WHERE action = 'session.end' AND occurred_at >= `+since+` AND `+who+` GROUP BY 1)
		SELECT d.id, d.name, s.n, COALESCE(e.secs, 0) FROM s JOIN devices d ON d.id::text = s.did LEFT JOIN e ON e.did = s.did
		WHERE d.id IN (SELECT emr_visible_devices($1)) ORDER BY s.n DESC, d.name LIMIT 8`, u.ID, actor, days)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x DeviceUsage
		if err := rows.Scan(&x.DeviceID, &x.Name, &x.Sessions, &x.Seconds); err != nil {
			rows.Close()
			return nil, err
		}
		st.TopDevices = append(st.TopDevices, x)
	}
	rows.Close()

	if u.IsAdmin() {
		rows, err = s.pool.Query(ctx, `SELECT a.actor_name, count(*), COALESCE((SELECT sum(NULLIF(e.details->>'duration_s', '')::bigint) FROM audit_events e
				WHERE e.action = 'session.end' AND e.actor_user_id IS NOT DISTINCT FROM a.actor_user_id AND e.occurred_at >= `+since+`), 0)
			FROM audit_events a WHERE a.action = 'session.start' AND a.success AND a.occurred_at >= `+since+` AND $1::uuid IS NOT NULL AND ($2::uuid IS NULL OR TRUE)
			GROUP BY a.actor_name, a.actor_user_id ORDER BY 2 DESC LIMIT 8`, u.ID, actor, days)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var x UserUsage
			if err := rows.Scan(&x.Username, &x.Sessions, &x.Seconds); err != nil {
				rows.Close()
				return nil, err
			}
			st.Users = append(st.Users, x)
		}
		rows.Close()
	}

	if err := s.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE action = 'file.upload'), count(*) FILTER (WHERE action = 'file.download'),
		COALESCE(sum(NULLIF(details->>'bytes', '')::bigint) FILTER (WHERE action = 'file.upload'), 0),
		COALESCE(sum(NULLIF(details->>'bytes', '')::bigint) FILTER (WHERE action = 'file.download'), 0)
		FROM audit_events WHERE action IN ('file.upload', 'file.download') AND success AND occurred_at >= `+since+` AND `+who, u.ID, actor, days).
		Scan(&st.Transfers.Uploads, &st.Transfers.Downloads, &st.Transfers.UploadBytes, &st.Transfers.DownloadBytes); err != nil {
		return nil, err
	}

	st.Security.AdminView = u.IsAdmin()
	if u.IsAdmin() {
		if err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM audit_events WHERE action = 'auth.login' AND NOT success AND occurred_at >= `+since+` AND $1::uuid IS NOT NULL AND ($2::uuid IS NULL OR TRUE)),
			(SELECT count(*) FROM users), (SELECT count(*) FROM users WHERE totp_enabled)`, u.ID, actor, days).
			Scan(&st.Security.FailedLogins, &st.Security.Users, &st.Security.TwoFactorUsers); err != nil {
			return nil, err
		}
	}
	if err := s.pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE protocol = 'ssh'), count(*) FILTER (WHERE protocol = 'ssh' AND COALESCE(settings->>'host_key', '') <> ''),
		count(*) FILTER (WHERE protocol = 'rdp'), count(*) FILTER (WHERE protocol = 'rdp' AND COALESCE(settings->>'cert_fingerprints', '') <> '')
		FROM connections WHERE device_id IN (SELECT emr_visible_devices($1))`, u.ID).
		Scan(&st.Security.SSHTotal, &st.Security.SSHPinned, &st.Security.RDPTotal, &st.Security.RDPPinned); err != nil {
		return nil, err
	}

	if err := s.pool.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER (WHERE d.facts <> '{}'::jsonb),
		COALESCE(sum(NULLIF(d.facts->>'cpu_cores', '')::bigint), 0), COALESCE(sum(NULLIF(d.facts->>'memory_bytes', '')::bigint), 0),
		count(*) FILTER (WHERE st.last_accessed_at IS NULL), count(*) FILTER (WHERE st.last_accessed_at < now() - interval '30 days')
		FROM devices d LEFT JOIN device_user_state st ON st.device_id = d.id AND st.user_id = $1
		WHERE d.id IN (SELECT emr_visible_devices($1))`, u.ID).
		Scan(&st.Fleet.Devices, &st.Fleet.WithFacts, &st.Fleet.Cores, &st.Fleet.MemoryBytes, &st.Fleet.NeverUsed, &st.Fleet.Idle30); err != nil {
		return nil, err
	}
	count := func(q string, put func(name string, n int)) error {
		r, err := s.pool.Query(ctx, q, u.ID)
		if err != nil {
			return err
		}
		defer r.Close()
		for r.Next() {
			var name string
			var n int
			if err := r.Scan(&name, &n); err != nil {
				return err
			}
			put(name, n)
		}
		return r.Err()
	}
	if err := count(`SELECT COALESCE(NULLIF(d.facts->'virtualization'->>'kind', ''), 'unknown'), count(*) FROM devices d WHERE d.id IN (SELECT emr_visible_devices($1)) GROUP BY 1`,
		func(k string, n int) { st.Fleet.Kinds[k] = n }); err != nil {
		return nil, err
	}
	if err := count(`SELECT device_type, count(*) FROM devices WHERE id IN (SELECT emr_visible_devices($1)) GROUP BY 1`,
		func(k string, n int) { st.Fleet.Types[k] = n }); err != nil {
		return nil, err
	}
	if err := count(`SELECT CASE WHEN status_reachable IS NULL THEN 'unknown' WHEN status_reachable THEN 'reachable' ELSE 'unreachable' END, count(*)
		FROM connections WHERE device_id IN (SELECT emr_visible_devices($1)) GROUP BY 1`, func(k string, n int) { st.Fleet.Reachability[k] = n }); err != nil {
		return nil, err
	}
	if err := count(`SELECT t, count(*) FROM devices d, unnest(d.tags) t WHERE d.id IN (SELECT emr_visible_devices($1)) GROUP BY t ORDER BY 2 DESC, t LIMIT 8`,
		func(k string, n int) { st.Fleet.Tags = append(st.Fleet.Tags, NameCount{k, n}) }); err != nil {
		return nil, err
	}
	if err := count(`SELECT g.name, count(d.id) FROM device_groups g LEFT JOIN devices d ON d.group_id = g.id AND d.id IN (SELECT emr_visible_devices($1))
		WHERE g.id IN (SELECT emr_visible_groups($1)) GROUP BY g.id, g.name ORDER BY 2 DESC, g.name LIMIT 8`,
		func(k string, n int) { st.Fleet.Groups = append(st.Fleet.Groups, NameCount{k, n}) }); err != nil {
		return nil, err
	}
	return st, nil
}
