package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// ConnectionSummary is the non-secret view of a connection embedded in devices.
type ConnectionSummary struct {
	ID              string     `json:"id"`
	DeviceID        string     `json:"device_id"`
	Name            string     `json:"name"`
	Protocol        string     `json:"protocol"`
	Port            int        `json:"port"`
	LastUsedAt      *time.Time `json:"last_used_at"`
	StatusReachable *bool      `json:"status_reachable"`
	StatusCheckedAt *time.Time `json:"status_checked_at"`
	StatusDetail    string     `json:"status_detail"`
}

func (s *Store) listConnectionSummaries(ctx context.Context, deviceID string) ([]ConnectionSummary, error) {
	q := `SELECT id, device_id, name, protocol, port, last_used_at, status_reachable, status_checked_at, status_detail
		FROM connections`
	args := []any{}
	if deviceID != "" {
		q += ` WHERE device_id = $1`
		args = append(args, deviceID)
	}
	q += ` ORDER BY CASE protocol WHEN 'rdp' THEN 0 WHEN 'vnc' THEN 1 WHEN 'ssh' THEN 2 ELSE 3 END, lower(name)`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, mapErr(err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (ConnectionSummary, error) {
		var c ConnectionSummary
		err := r.Scan(&c.ID, &c.DeviceID, &c.Name, &c.Protocol, &c.Port, &c.LastUsedAt, &c.StatusReachable, &c.StatusCheckedAt, &c.StatusDetail)
		return c, err
	})
	if out == nil {
		out = []ConnectionSummary{}
	}
	return out, err
}

// Connection is a full connection profile. SecretEnc is never serialized.
type Connection struct {
	ConnectionSummary
	DeviceOwnerID  *string         `json:"device_owner_id"`
	CanManage      bool            `json:"can_manage"`
	DeviceName     string          `json:"device_name"`
	DeviceAddress  string          `json:"device_address"`
	DeviceOS       string          `json:"device_os"`
	Username       string          `json:"username"`
	Domain         string          `json:"domain"`
	CredentialID   *string         `json:"credential_id"`
	CredentialName *string         `json:"credential_name"`
	SecretEnc      []byte          `json:"-"`
	SecretFields   []string        `json:"secret_fields"`
	Settings       json.RawMessage `json:"settings"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

type ConnectionInput struct {
	Name         string
	Protocol     string
	Port         int
	Username     string
	Domain       string
	CredentialID *string
	Settings     json.RawMessage
}

const connCols = `c.id, c.device_id, c.name, c.protocol, c.port, c.last_used_at, c.status_reachable, c.status_checked_at,
	c.status_detail, d.owner_id, d.name, d.address, d.os, c.username, c.domain, c.credential_id, cr.name, c.secret_enc, c.secret_fields,
	c.settings, c.created_at, c.updated_at`

const connFrom = ` FROM connections c JOIN devices d ON d.id = c.device_id LEFT JOIN credentials cr ON cr.id = c.credential_id `

func scanConnection(row pgx.Row) (*Connection, error) {
	var c Connection
	err := row.Scan(&c.ID, &c.DeviceID, &c.Name, &c.Protocol, &c.Port, &c.LastUsedAt, &c.StatusReachable, &c.StatusCheckedAt,
		&c.StatusDetail, &c.DeviceOwnerID, &c.DeviceName, &c.DeviceAddress, &c.DeviceOS, &c.Username, &c.Domain, &c.CredentialID, &c.CredentialName,
		&c.SecretEnc, &c.SecretFields, &c.Settings, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	if c.SecretFields == nil {
		c.SecretFields = []string{}
	}
	return &c, nil
}

// ListConnections returns connections of the devices uid can see (optionally one device).
func (s *Store) ListConnections(ctx context.Context, uid, deviceID string) ([]*Connection, error) {
	q := `SELECT ` + connCols + connFrom + ` WHERE c.device_id IN (SELECT emr_visible_devices($1))`
	args := []any{uid}
	if deviceID != "" {
		q += ` AND c.device_id = $2`
		args = append(args, deviceID)
	}
	q += ` ORDER BY lower(d.name), CASE c.protocol WHEN 'rdp' THEN 0 WHEN 'vnc' THEN 1 ELSE 2 END, lower(c.name)`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, mapErr(err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Connection, error) { return scanConnection(r) })
	if out == nil {
		out = []*Connection{}
	}
	return out, err
}

func (s *Store) GetConnection(ctx context.Context, id string) (*Connection, error) {
	return scanConnection(s.pool.QueryRow(ctx, `SELECT `+connCols+connFrom+` WHERE c.id = $1`, id))
}

// CreateConnection inserts a connection. sealSecret is called with the new
// row's id so the ciphertext can be bound to it; it may return nil.
func (s *Store) CreateConnection(ctx context.Context, deviceID string, in ConnectionInput,
	sealSecret func(id string) ([]byte, []string, error)) (*Connection, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO connections (device_id, name, protocol, port, username, domain, credential_id, settings)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		deviceID, in.Name, in.Protocol, in.Port, in.Username, in.Domain, in.CredentialID, in.Settings).Scan(&id)
	if err != nil {
		return nil, mapErr(err)
	}
	if sealSecret != nil {
		ct, fields, err := sealSecret(id)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE connections SET secret_enc = $2, secret_fields = $3 WHERE id = $1`, id, ct, fields); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetConnection(ctx, id)
}

func (s *Store) UpdateConnection(ctx context.Context, id string, in ConnectionInput) (*Connection, error) {
	err := execOne(ctx, s.pool, `UPDATE connections SET name = $2, protocol = $3, port = $4, username = $5, domain = $6,
		credential_id = $7, settings = $8, updated_at = now(),
		status_reachable = CASE WHEN port = $4 THEN status_reachable END,
		status_checked_at = CASE WHEN port = $4 THEN status_checked_at END
		WHERE id = $1`, id, in.Name, in.Protocol, in.Port, in.Username, in.Domain, in.CredentialID, in.Settings)
	if err != nil {
		return nil, err
	}
	return s.GetConnection(ctx, id)
}

// UpdateConnectionSettings replaces only the settings document (used to record
// a server identity on first connection).
func (s *Store) UpdateConnectionSettings(ctx context.Context, id string, settings json.RawMessage) error {
	return execOne(ctx, s.pool, `UPDATE connections SET settings = $2, updated_at = now() WHERE id = $1`, id, settings)
}

// SetConnectionSecret replaces the stored secret (nil clears it).
func (s *Store) SetConnectionSecret(ctx context.Context, id string, ct []byte, fields []string) error {
	if fields == nil {
		fields = []string{}
	}
	return execOne(ctx, s.pool, `UPDATE connections SET secret_enc = $2, secret_fields = $3, updated_at = now() WHERE id = $1`, id, ct, fields)
}

func (s *Store) DeleteConnection(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM connections WHERE id = $1`, id)
}

func (s *Store) TouchConnectionUsed(ctx context.Context, uid, connID, deviceID string) error {
	if _, err := s.pool.Exec(ctx, `UPDATE connections SET last_used_at = now() WHERE id = $1`, connID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO device_user_state (user_id, device_id, last_accessed_at) VALUES ($1, $2, now())
		ON CONFLICT (user_id, device_id) DO UPDATE SET last_accessed_at = now()`, uid, deviceID)
	return err
}

func (s *Store) UpdateConnectionStatus(ctx context.Context, id string, reachable bool, detail string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE connections SET status_reachable = $2, status_detail = $3, status_checked_at = $4 WHERE id = $1`,
		id, reachable, detail, at)
	return err
}

// ProbeTarget is the minimal data needed for a reachability probe.
type ProbeTarget struct {
	ConnectionID string
	DeviceID     string
	Address      string
	Port         int
}

func (s *Store) ListProbeTargets(ctx context.Context, deviceID string) ([]ProbeTarget, error) {
	// Connections that go through a jump host cannot be probed from here.
	q := `SELECT c.id, c.device_id, d.address, c.port FROM connections c JOIN devices d ON d.id = c.device_id
		WHERE COALESCE(c.settings->>'jump_connection_id', '') = ''`
	args := []any{}
	if deviceID != "" {
		q += ` AND c.device_id = $1`
		args = append(args, deviceID)
	}
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, mapErr(err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ProbeTarget, error) {
		var t ProbeTarget
		err := r.Scan(&t.ConnectionID, &t.DeviceID, &t.Address, &t.Port)
		return t, err
	})
}

// ---- Credentials ----

type Credential struct {
	ID           string    `json:"id"`
	OwnerID      *string   `json:"owner_id"`
	CanManage    bool      `json:"can_manage"`
	Name         string    `json:"name"`
	Username     string    `json:"username"`
	Domain       string    `json:"domain"`
	SecretEnc    []byte    `json:"-"`
	SecretFields []string  `json:"secret_fields"`
	UsageCount   int       `json:"usage_count"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	VaultFields
}

// VaultFields are the privileged access vault settings of a credential (none of them secret).
type VaultFields struct {
	Kind                 string     `json:"kind"`
	Folder               string     `json:"folder"`
	Tags                 []string   `json:"tags"`
	URL                  string     `json:"url"`
	Description          string     `json:"description"`
	RevealPolicy         string     `json:"reveal_policy"`
	AccessPolicy         string     `json:"access_policy"`
	MaxCheckoutMinutes   int        `json:"max_checkout_minutes"`
	BreakGlass           bool       `json:"break_glass"`
	RotationConnectionID *string    `json:"rotation_connection_id"`
	RotateAfterCheckin   bool       `json:"rotate_after_checkin"`
	RotationIntervalDays int        `json:"rotation_interval_days"`
	SecretChangedAt      *time.Time `json:"secret_changed_at"`
	RotatedAt            *time.Time `json:"rotated_at"`
	RotationStatus       string     `json:"rotation_status"`
	RotationError        string     `json:"rotation_error"`
	PasswordStrength     *int       `json:"password_strength"`
}

const credCols = `cr.id, cr.owner_id, cr.name, cr.username, cr.domain, cr.secret_enc, cr.secret_fields,
	(SELECT count(*) FROM connections c WHERE c.credential_id = cr.id), cr.created_at, cr.updated_at,
	cr.kind, cr.folder, cr.tags, cr.url, cr.description, cr.reveal_policy, cr.access_policy, cr.max_checkout_minutes,
	cr.break_glass, cr.rotation_connection_id, cr.rotate_after_checkin, cr.rotation_interval_days, cr.secret_changed_at,
	cr.rotated_at, cr.rotation_status, cr.rotation_error, cr.password_strength`

func scanCredential(row pgx.Row) (*Credential, error) {
	var c Credential
	var strength *int16
	if err := row.Scan(credDest(&c, &strength)...); err != nil {
		return nil, mapErr(err)
	}
	c.finish(strength)
	return &c, nil
}

// credDest lists the scan destinations matching credCols.
func credDest(c *Credential, strength **int16) []any {
	return []any{&c.ID, &c.OwnerID, &c.Name, &c.Username, &c.Domain, &c.SecretEnc, &c.SecretFields, &c.UsageCount, &c.CreatedAt, &c.UpdatedAt,
		&c.Kind, &c.Folder, &c.Tags, &c.URL, &c.Description, &c.RevealPolicy, &c.AccessPolicy, &c.MaxCheckoutMinutes,
		&c.BreakGlass, &c.RotationConnectionID, &c.RotateAfterCheckin, &c.RotationIntervalDays, &c.SecretChangedAt,
		&c.RotatedAt, &c.RotationStatus, &c.RotationError, strength}
}

func (c *Credential) finish(strength *int16) {
	if c.SecretFields == nil {
		c.SecretFields = []string{}
	}
	if c.Tags == nil {
		c.Tags = []string{}
	}
	if strength != nil {
		v := int(*strength)
		c.PasswordStrength = &v
	}
}

// ListCredentials returns the saved credentials of one owner (nil = the shared ones).
func (s *Store) ListCredentials(ctx context.Context, owner *string) ([]*Credential, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+credCols+` FROM credentials cr WHERE cr.owner_id IS NOT DISTINCT FROM $1::uuid ORDER BY lower(cr.name)`, owner)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Credential, error) { return scanCredential(r) })
	if out == nil {
		out = []*Credential{}
	}
	return out, err
}

func (s *Store) GetCredential(ctx context.Context, id string) (*Credential, error) {
	return scanCredential(s.pool.QueryRow(ctx, `SELECT `+credCols+` FROM credentials cr WHERE cr.id = $1`, id))
}

func (s *Store) CreateCredential(ctx context.Context, owner *string, name, username, domain string, vf VaultFields,
	sealSecret func(id string) ([]byte, []string, error)) (*Credential, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO credentials (owner_id, name, username, domain, kind, folder, tags, url, description,
		reveal_policy, access_policy, max_checkout_minutes, break_glass, rotation_connection_id, rotate_after_checkin,
		rotation_interval_days) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
		owner, name, username, domain, vf.Kind, vf.Folder, vf.Tags, vf.URL, vf.Description, vf.RevealPolicy, vf.AccessPolicy,
		vf.MaxCheckoutMinutes, vf.BreakGlass, vf.RotationConnectionID, vf.RotateAfterCheckin, vf.RotationIntervalDays).Scan(&id); err != nil {
		return nil, mapErr(err)
	}
	ct, fields, err := sealSecret(id)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE credentials SET secret_enc = $2, secret_fields = $3, secret_changed_at = now(),
		password_strength = $4 WHERE id = $1`, id, ct, fields, vf.PasswordStrength); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetCredential(ctx, id)
}

func (s *Store) UpdateCredential(ctx context.Context, id, name, username, domain string, vf VaultFields) (*Credential, error) {
	if err := execOne(ctx, s.pool, `UPDATE credentials SET name = $2, username = $3, domain = $4, kind = $5, folder = $6,
		tags = $7, url = $8, description = $9, reveal_policy = $10, access_policy = $11, max_checkout_minutes = $12,
		break_glass = $13, rotation_connection_id = $14, rotate_after_checkin = $15, rotation_interval_days = $16,
		updated_at = now() WHERE id = $1`,
		id, name, username, domain, vf.Kind, vf.Folder, vf.Tags, vf.URL, vf.Description, vf.RevealPolicy, vf.AccessPolicy,
		vf.MaxCheckoutMinutes, vf.BreakGlass, vf.RotationConnectionID, vf.RotateAfterCheckin, vf.RotationIntervalDays); err != nil {
		return nil, err
	}
	return s.GetCredential(ctx, id)
}

// SetCredentialSecret replaces the current secret. strength is the new password's
// strength (nil without a password).
func (s *Store) SetCredentialSecret(ctx context.Context, id string, ct []byte, fields []string, strength *int) error {
	if fields == nil {
		fields = []string{}
	}
	return execOne(ctx, s.pool, `UPDATE credentials SET secret_enc = $2, secret_fields = $3, password_strength = $4,
		secret_changed_at = now(), updated_at = now() WHERE id = $1`, id, ct, fields, strength)
}

func (s *Store) DeleteCredential(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM credentials WHERE id = $1`, id)
}

// CountJumpUsers counts connections that use connection id as their jump host.
func (s *Store) CountJumpUsers(ctx context.Context, id string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM connections WHERE settings->>'jump_connection_id' = $1`, id).Scan(&n)
	return n, err
}

// CountJumpUsersOutside counts connections on other devices that use connection id as their jump host.
func (s *Store) CountJumpUsersOutside(ctx context.Context, id, deviceID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM connections WHERE settings->>'jump_connection_id' = $1 AND device_id::text <> $2`, id, deviceID).Scan(&n)
	return n, err
}
