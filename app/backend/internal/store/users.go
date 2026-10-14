package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Grants are the shared devices and device groups a user or team may use.
type Grants struct {
	DeviceIDs []string `json:"device_ids"`
	GroupIDs  []string `json:"group_ids"`
}

func emptyGrants() Grants { return Grants{DeviceIDs: []string{}, GroupIDs: []string{}} }

// UserRow is a user as shown in the administration screen.
type UserRow struct {
	User
	Grants         Grants `json:"grants"`
	OwnedDevices   int    `json:"owned_devices"`
	ActiveSessions int    `json:"active_sessions"`
}

func (s *Store) ListUsers(ctx context.Context) ([]UserRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+userCols+`,
		(SELECT count(*) FROM devices d WHERE d.owner_id = u.id),
		(SELECT count(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > now())
		`+userFrom+` ORDER BY u.role, lower(u.username)`)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (UserRow, error) {
		var x UserRow
		err := r.Scan(&x.ID, &x.Username, &x.PasswordHash, &x.Role, &x.CreatedAt, &x.UpdatedAt, &x.PasswordChangedAt, &x.LastLoginAt,
			&x.Disabled, &x.Permissions, &x.InventoryMode, &x.TeamID, &x.TeamName, &x.TeamPermissions, &x.TeamInventoryMode, &x.TwoFactor,
			&x.OwnedDevices, &x.ActiveSessions)
		x.PasswordHash = ""
		if x.Permissions == nil {
			x.Permissions = []string{}
		}
		if x.TeamPermissions == nil {
			x.TeamPermissions = []string{}
		}
		x.Effective = x.EffectivePermissions()
		x.Grants = emptyGrants()
		return x, err
	})
	if err != nil {
		return nil, err
	}
	grants, err := s.allGrants(ctx, "user_id")
	if err != nil {
		return nil, err
	}
	for i := range out {
		if g, ok := grants[out[i].ID]; ok {
			out[i].Grants = g
		}
	}
	return out, nil
}

// allGrants returns the grants of every user (col = "user_id") or team (col = "team_id").
func (s *Store) allGrants(ctx context.Context, col string) (map[string]Grants, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+col+`::text, device_id::text, group_id::text FROM access_grants WHERE `+col+` IS NOT NULL ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Grants{}
	for rows.Next() {
		var sub string
		var dev, grp *string
		if err := rows.Scan(&sub, &dev, &grp); err != nil {
			return nil, err
		}
		g, ok := out[sub]
		if !ok {
			g = emptyGrants()
		}
		if dev != nil {
			g.DeviceIDs = append(g.DeviceIDs, *dev)
		}
		if grp != nil {
			g.GroupIDs = append(g.GroupIDs, *grp)
		}
		out[sub] = g
	}
	return out, rows.Err()
}

// UserInput holds the administrator-editable account fields.
type UserInput struct {
	Role          string
	TeamID        *string
	Permissions   []string
	InventoryMode string
	Grants        Grants
}

func setGrants(ctx context.Context, tx pgx.Tx, col, id string, g Grants) error {
	if _, err := tx.Exec(ctx, `DELETE FROM access_grants WHERE `+col+` = $1`, id); err != nil {
		return err
	}
	for _, d := range g.DeviceIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO access_grants (`+col+`, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, d); err != nil {
			return mapErr(err)
		}
	}
	for _, grp := range g.GroupIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO access_grants (`+col+`, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, grp); err != nil {
			return mapErr(err)
		}
	}
	return nil
}

// CreateUser adds a member or administrator with an already-hashed password.
func (s *Store) CreateUser(ctx context.Context, username, hash string, in UserInput) (*User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO users (username, password_hash, role, team_id, permissions, inventory_mode)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		username, hash, in.Role, in.TeamID, in.Permissions, in.InventoryMode).Scan(&id)
	if err != nil {
		return nil, mapErr(err)
	}
	if err := setGrants(ctx, tx, "user_id", id, in.Grants); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetUser(ctx, id)
}

func (s *Store) UpdateUser(ctx context.Context, id string, in UserInput) (*User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := execOne(ctx, tx, `UPDATE users SET role = $2, team_id = $3, permissions = $4, inventory_mode = $5, updated_at = now() WHERE id = $1`,
		id, in.Role, in.TeamID, in.Permissions, in.InventoryMode); err != nil {
		return nil, err
	}
	if err := setGrants(ctx, tx, "user_id", id, in.Grants); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetUser(ctx, id)
}

func (s *Store) SetUserDisabled(ctx context.Context, id string, disabled bool) error {
	return execOne(ctx, s.pool, `UPDATE users SET disabled = $2, updated_at = now() WHERE id = $1`, id, disabled)
}

// CountActiveAdmins counts administrators that can still sign in, excluding one user.
func (s *Store) CountActiveAdmins(ctx context.Context, except string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE role = 'admin' AND NOT disabled AND id::text <> $1`, except).Scan(&n)
	return n, err
}

// DeleteUser removes an account. With keepInventory its devices, groups and
// credentials move to the shared inventory (names get a suffix so they cannot
// collide); otherwise they are deleted with it.
func (s *Store) DeleteUser(ctx context.Context, id string, keepInventory bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if keepInventory {
		var name string
		if err := tx.QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, id).Scan(&name); err != nil {
			return mapErr(err)
		}
		suffix := " (from " + name + ")"
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{`UPDATE device_groups SET owner_id = NULL, name = left(name, 64 - char_length($2::text)) || $2::text WHERE owner_id = $1`, []any{id, suffix}},
			{`UPDATE credentials SET owner_id = NULL, name = left(name, 128 - char_length($2::text)) || $2::text WHERE owner_id = $1`, []any{id, suffix}},
			{`UPDATE devices SET owner_id = NULL WHERE owner_id = $1`, []any{id}},
		} {
			if _, err := tx.Exec(ctx, q.sql, q.args...); err != nil {
				return mapErr(err)
			}
		}
		// Per-user state of devices that just became shared stays with the user and is removed by the cascade.
	}
	if err := execOne(ctx, tx, `DELETE FROM users WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---- Teams ----

type Team struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	Permissions   []string  `json:"permissions"`
	InventoryMode string    `json:"inventory_mode"`
	Grants        Grants    `json:"grants"`
	MemberCount   int       `json:"member_count"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type TeamInput struct {
	Name          string
	Description   string
	Permissions   []string
	InventoryMode string
	Grants        Grants
}

const teamCols = `t.id, t.name, t.description, t.permissions, t.inventory_mode,
	(SELECT count(*) FROM users u WHERE u.team_id = t.id), t.created_at, t.updated_at`

func scanTeam(r pgx.Row) (Team, error) {
	var t Team
	err := r.Scan(&t.ID, &t.Name, &t.Description, &t.Permissions, &t.InventoryMode, &t.MemberCount, &t.CreatedAt, &t.UpdatedAt)
	if t.Permissions == nil {
		t.Permissions = []string{}
	}
	t.Grants = emptyGrants()
	return t, err
}

func (s *Store) ListTeams(ctx context.Context) ([]Team, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+teamCols+` FROM teams t ORDER BY lower(t.name)`)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Team, error) { return scanTeam(r) })
	if err != nil {
		return nil, err
	}
	grants, err := s.allGrants(ctx, "team_id")
	if err != nil {
		return nil, err
	}
	for i := range out {
		if g, ok := grants[out[i].ID]; ok {
			out[i].Grants = g
		}
	}
	if out == nil {
		out = []Team{}
	}
	return out, nil
}

func (s *Store) GetTeam(ctx context.Context, id string) (*Team, error) {
	t, err := scanTeam(s.pool.QueryRow(ctx, `SELECT `+teamCols+` FROM teams t WHERE t.id = $1`, id))
	if err != nil {
		return nil, mapErr(err)
	}
	grants, err := s.allGrants(ctx, "team_id")
	if err != nil {
		return nil, err
	}
	if g, ok := grants[t.ID]; ok {
		t.Grants = g
	}
	return &t, nil
}

func (s *Store) CreateTeam(ctx context.Context, in TeamInput) (*Team, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO teams (name, description, permissions, inventory_mode) VALUES ($1, $2, $3, $4) RETURNING id`,
		in.Name, in.Description, in.Permissions, in.InventoryMode).Scan(&id); err != nil {
		return nil, mapErr(err)
	}
	if err := setGrants(ctx, tx, "team_id", id, in.Grants); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetTeam(ctx, id)
}

func (s *Store) UpdateTeam(ctx context.Context, id string, in TeamInput) (*Team, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := execOne(ctx, tx, `UPDATE teams SET name = $2, description = $3, permissions = $4, inventory_mode = $5, updated_at = now() WHERE id = $1`,
		id, in.Name, in.Description, in.Permissions, in.InventoryMode); err != nil {
		return nil, err
	}
	if err := setGrants(ctx, tx, "team_id", id, in.Grants); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetTeam(ctx, id)
}

func (s *Store) DeleteTeam(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM teams WHERE id = $1`, id)
}

// UserIDsOfTeam lists a team's members (to end their sessions when access changes is not needed;
// permissions are read on every request).
func (s *Store) UserIDsOfTeam(ctx context.Context, teamID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM users WHERE team_id = $1`, teamID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// AllShared reports whether every id names an existing shared (unowned) device
// and every group id an existing shared group; used before granting access.
func (s *Store) AllShared(ctx context.Context, g Grants) (bool, error) {
	var nd, ng int
	err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM devices WHERE id = ANY($1::uuid[]) AND owner_id IS NULL),
		(SELECT count(*) FROM device_groups WHERE id = ANY($2::uuid[]) AND owner_id IS NULL)`,
		g.DeviceIDs, g.GroupIDs).Scan(&nd, &ng)
	if err != nil {
		return false, mapErr(err)
	}
	return nd == len(g.DeviceIDs) && ng == len(g.GroupIDs), nil
}
