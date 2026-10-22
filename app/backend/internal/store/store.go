// Package store is the PostgreSQL persistence layer.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("already exists")
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// mapErr converts driver errors into store sentinel errors.
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return ErrConflict
		case "23503", "22P02": // foreign_key_violation, invalid_text_representation (bad uuid)
			return ErrNotFound
		}
	}
	return err
}

func execOne(ctx context.Context, db interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, sql string, args ...any) error {
	tag, err := db.Exec(ctx, sql, args...)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Users ----

type User struct {
	ID                string     `json:"id"`
	Username          string     `json:"username"`
	PasswordHash      string     `json:"-"`
	Role              string     `json:"role"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	PasswordChangedAt time.Time  `json:"password_changed_at"`
	LastLoginAt       *time.Time `json:"last_login_at"`
	Disabled          bool       `json:"disabled"`
	// Permissions granted to this user directly; the team adds more.
	Permissions   []string `json:"permissions"`
	InventoryMode string   `json:"inventory_mode"`
	TeamID        *string  `json:"team_id"`
	TeamName      *string  `json:"team_name"`
	// Not part of the account itself: filled from the team.
	TeamPermissions   []string `json:"team_permissions"`
	TeamInventoryMode string   `json:"team_inventory_mode"`
	// Everything the user may do (administrators: all permissions).
	Effective []string `json:"effective_permissions"`
	// TwoFactor reports whether a second sign-in factor is active.
	TwoFactor bool `json:"two_factor_enabled"`
}

const userCols = `u.id, u.username, u.password_hash, u.role, u.created_at, u.updated_at, u.password_changed_at, u.last_login_at,
	u.disabled, u.permissions, u.inventory_mode, u.team_id, t.name, COALESCE(t.permissions, '{}'), COALESCE(t.inventory_mode, 'none'), u.totp_enabled`

const userFrom = ` FROM users u LEFT JOIN teams t ON t.id = u.team_id `

func scanUser(row pgx.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.CreatedAt, &u.UpdatedAt, &u.PasswordChangedAt, &u.LastLoginAt,
		&u.Disabled, &u.Permissions, &u.InventoryMode, &u.TeamID, &u.TeamName, &u.TeamPermissions, &u.TeamInventoryMode, &u.TwoFactor)
	if err != nil {
		return nil, mapErr(err)
	}
	if u.Permissions == nil {
		u.Permissions = []string{}
	}
	if u.TeamPermissions == nil {
		u.TeamPermissions = []string{}
	}
	u.Effective = u.EffectivePermissions()
	return &u, nil
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// CreateFirstUser creates the initial administrator only if no user exists,
// atomically, so two concurrent setup requests cannot both succeed.
func (s *Store) CreateFirstUser(ctx context.Context, username, hash string) (*User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `LOCK TABLE users IN EXCLUSIVE MODE`); err != nil {
		return nil, err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, ErrConflict
	}
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`, username, hash).Scan(&id); err != nil {
		return nil, mapErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetUser(ctx, id)
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userCols+userFrom+`WHERE lower(u.username) = lower($1)`, username))
}

func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userCols+userFrom+`WHERE u.id = $1`, id))
}

func (s *Store) TouchLogin(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `UPDATE users SET last_login_at = now() WHERE id = $1`, id)
}

func (s *Store) UpdatePassword(ctx context.Context, id, hash string) error {
	return execOne(ctx, s.pool, `UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1`, id, hash)
}

// ---- Sessions ----

type Session struct {
	ID         string    `json:"-"`
	UserID     string    `json:"-"`
	CSRFToken  string    `json:"-"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	IP         string    `json:"ip"`
	UserAgent  string    `json:"user_agent"`
	// Remember marks a session the user asked to keep ("remember me"): it has its own, longer limits.
	Remember bool `json:"remember"`
}

func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	return mapErr(s.pool.QueryRow(ctx, `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent, remember)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at, last_seen_at`,
		sess.ID, sess.UserID, sess.CSRFToken, sess.ExpiresAt, sess.IP, sess.UserAgent, sess.Remember).Scan(&sess.CreatedAt, &sess.LastSeenAt))
}

func (s *Store) GetSession(ctx context.Context, id string) (*Session, error) {
	var sess Session
	err := s.pool.QueryRow(ctx, `SELECT id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent, remember
		FROM sessions WHERE id = $1`, id).Scan(&sess.ID, &sess.UserID, &sess.CSRFToken, &sess.CreatedAt,
		&sess.LastSeenAt, &sess.ExpiresAt, &sess.IP, &sess.UserAgent, &sess.Remember)
	if err != nil {
		return nil, mapErr(err)
	}
	return &sess, nil
}

func (s *Store) TouchSession(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, id)
	return err
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id)
	return err
}

// DeleteUserSessions removes all of a user's sessions except keepID (may be "").
func (s *Store) DeleteUserSessions(ctx context.Context, userID, keepID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id`, userID, keepID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (s *Store) ListUserSessions(ctx context.Context, userID string) ([]Session, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent
		FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Session, error) {
		var sess Session
		err := r.Scan(&sess.ID, &sess.UserID, &sess.CSRFToken, &sess.CreatedAt, &sess.LastSeenAt, &sess.ExpiresAt, &sess.IP, &sess.UserAgent)
		return sess, err
	})
}

func (s *Store) DeleteExpiredSessions(ctx context.Context, idle, rememberIdle time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()
		OR last_seen_at <= now() - make_interval(secs => CASE WHEN remember THEN $2::float8 ELSE $1::float8 END)`, idle.Seconds(), rememberIdle.Seconds())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// GetSetting returns a server-wide setting; ok is false when it was never saved.
func (s *Store) GetSetting(ctx context.Context, key string) (value []byte, ok bool, err error) {
	err = s.pool.QueryRow(ctx, `SELECT value FROM app_settings WHERE key = $1`, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return value, err == nil, err
}

// SetSetting saves a server-wide setting.
// DeleteSetting removes a saved server-wide setting, so its default applies again.
func (s *Store) DeleteSetting(ctx context.Context, key string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM app_settings WHERE key = $1`, key)
	return err
}

func (s *Store) SetSetting(ctx context.Context, key string, value []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO app_settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, value)
	return err
}
