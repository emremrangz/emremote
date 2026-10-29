package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- Privileged access vault ----

// Vault access levels a user can hold on an entry, weakest first.
const (
	VaultUse    = "use"    // see it, check it out, connect with it
	VaultReveal = "reveal" // also show or copy the secret
	VaultManage = "manage" // also edit, share, rotate (owner, or administrators for shared entries)
)

type Checkout struct {
	ID           string     `json:"id"`
	CredentialID string     `json:"credential_id"`
	UserID       *string    `json:"user_id"`
	Username     string     `json:"username"`
	RequestID    *string    `json:"request_id"`
	Reason       string     `json:"reason"`
	BreakGlass   bool       `json:"break_glass"`
	StartedAt    time.Time  `json:"started_at"`
	ExpiresAt    time.Time  `json:"expires_at"`
	CheckedInAt  *time.Time `json:"checked_in_at"`
	CheckedInBy  string     `json:"checked_in_by"`
	// Filled for listings.
	CredentialName string `json:"credential_name,omitempty"`
}

const checkoutCols = `k.id, k.credential_id, k.user_id, k.username, k.request_id, k.reason, k.break_glass, k.started_at,
	k.expires_at, k.checked_in_at, k.checked_in_by`

func checkoutDest(k *Checkout) []any {
	return []any{&k.ID, &k.CredentialID, &k.UserID, &k.Username, &k.RequestID, &k.Reason, &k.BreakGlass, &k.StartedAt,
		&k.ExpiresAt, &k.CheckedInAt, &k.CheckedInBy}
}

type VaultRequest struct {
	ID             string     `json:"id"`
	CredentialID   string     `json:"credential_id"`
	CredentialName string     `json:"credential_name"`
	UserID         string     `json:"user_id"`
	Username       string     `json:"username"`
	Reason         string     `json:"reason"`
	Minutes        int        `json:"minutes"`
	Status         string     `json:"status"`
	DecidedByName  string     `json:"decided_by_name"`
	DecisionNote   string     `json:"decision_note"`
	DecidedAt      *time.Time `json:"decided_at"`
	ValidUntil     *time.Time `json:"valid_until"`
	CreatedAt      time.Time  `json:"created_at"`
}

const requestCols = `q.id, q.credential_id, cr.name, q.user_id, u.username, q.reason, q.minutes, q.status, q.decided_by_name,
	q.decision_note, q.decided_at, q.valid_until, q.created_at`

const requestFrom = ` FROM vault_requests q JOIN credentials cr ON cr.id = q.credential_id JOIN users u ON u.id = q.user_id`

func scanRequest(row pgx.Row) (*VaultRequest, error) {
	var q VaultRequest
	err := row.Scan(&q.ID, &q.CredentialID, &q.CredentialName, &q.UserID, &q.Username, &q.Reason, &q.Minutes, &q.Status,
		&q.DecidedByName, &q.DecisionNote, &q.DecidedAt, &q.ValidUntil, &q.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &q, nil
}

// VaultEntry is a credential as one user sees it in the vault.
type VaultEntry struct {
	Credential
	Access          string        `json:"access"`
	Checkout        *Checkout     `json:"checkout"`
	MyRequest       *VaultRequest `json:"my_request"`
	PendingRequests int           `json:"pending_requests"`
	Grants          []VaultGrant  `json:"grants,omitempty"`
}

// vaultLevelSQL computes the access level of user $1 (team $2, administrator $3).
const vaultLevelSQL = `CASE
	WHEN cr.owner_id = $1 THEN 'manage'
	WHEN cr.owner_id IS NULL AND $3::boolean THEN 'manage'
	WHEN cr.owner_id IS NULL THEN (SELECT CASE max(CASE g.level WHEN 'reveal' THEN 2 ELSE 1 END) WHEN 2 THEN 'reveal' WHEN 1 THEN 'use' END
		FROM vault_grants g WHERE g.credential_id = cr.id AND (g.user_id = $1 OR (g.team_id IS NOT NULL AND g.team_id = $2)))
	END`

// ListVault returns every entry u can see, with u's access level, the open
// check-out and u's own open request.
func (s *Store) ListVault(ctx context.Context, u *User) ([]*VaultEntry, error) {
	return s.queryVault(ctx, u, "")
}

// GetVaultEntry returns one entry as u sees it; ErrNotFound if u cannot see it.
func (s *Store) GetVaultEntry(ctx context.Context, u *User, id string) (*VaultEntry, error) {
	list, err := s.queryVault(ctx, u, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return list[0], nil
}

func (s *Store) queryVault(ctx context.Context, u *User, id string) ([]*VaultEntry, error) {
	rows, err := s.pool.Query(ctx, `SELECT * FROM (SELECT `+credCols+`, `+vaultLevelSQL+` AS access,
		(SELECT count(*) FROM vault_requests q WHERE q.credential_id = cr.id AND q.status = 'pending')
		FROM credentials cr WHERE ($4 = '' OR cr.id::text = $4)) v WHERE access IS NOT NULL ORDER BY lower(folder), lower(name)`,
		u.ID, u.TeamID, u.IsAdmin(), id)
	if err != nil {
		return nil, mapErr(err)
	}
	var out []*VaultEntry
	for rows.Next() {
		var e VaultEntry
		var strength *int16
		dest := append(credDest(&e.Credential, &strength), &e.Access, &e.PendingRequests)
		if err := rows.Scan(dest...); err != nil {
			rows.Close()
			return nil, mapErr(err)
		}
		e.finish(strength)
		if e.Access != VaultManage {
			e.PendingRequests = 0
		}
		out = append(out, &e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, mapErr(err)
	}
	if len(out) == 0 {
		return []*VaultEntry{}, nil
	}
	byID := map[string]*VaultEntry{}
	ids := make([]string, len(out))
	for i, e := range out {
		byID[e.ID] = e
		ids[i] = e.ID
	}
	krows, err := s.pool.Query(ctx, `SELECT `+checkoutCols+` FROM vault_checkouts k
		WHERE k.checked_in_at IS NULL AND k.credential_id::text = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	for krows.Next() {
		var k Checkout
		if err := krows.Scan(checkoutDest(&k)...); err != nil {
			krows.Close()
			return nil, err
		}
		byID[k.CredentialID].Checkout = &k
	}
	krows.Close()
	qrows, err := s.pool.Query(ctx, `SELECT `+requestCols+requestFrom+`
		WHERE q.user_id = $1 AND q.status IN ('pending', 'approved') AND q.credential_id::text = ANY($2)`, u.ID, ids)
	if err != nil {
		return nil, err
	}
	for qrows.Next() {
		q, err := scanRequest(qrows)
		if err != nil {
			qrows.Close()
			return nil, err
		}
		byID[q.CredentialID].MyRequest = q
	}
	qrows.Close()
	return out, qrows.Err()
}

// ---- Versions ----

type CredentialVersion struct {
	ID           string    `json:"id"`
	CredentialID string    `json:"credential_id"`
	SecretEnc    []byte    `json:"-"`
	SecretFields []string  `json:"secret_fields"`
	Source       string    `json:"source"`
	ActorName    string    `json:"actor_name"`
	CreatedAt    time.Time `json:"created_at"`
}

// keepVersions is how many versions of a secret are kept.
const keepVersions = 20

// AddCredentialVersion stores a sealed value of a credential's secret and drops
// the oldest versions beyond keepVersions.
func (s *Store) AddCredentialVersion(ctx context.Context, v CredentialVersion) error {
	if v.SecretFields == nil {
		v.SecretFields = []string{}
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO credential_versions (id, credential_id, secret_enc, secret_fields, source, actor_name)
		VALUES ($1, $2, $3, $4, $5, $6)`, v.ID, v.CredentialID, v.SecretEnc, v.SecretFields, v.Source, v.ActorName); err != nil {
		return mapErr(err)
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM credential_versions WHERE credential_id = $1 AND id NOT IN
		(SELECT id FROM credential_versions WHERE credential_id = $1 ORDER BY created_at DESC LIMIT $2)`, v.CredentialID, keepVersions)
	return err
}

func (s *Store) ListCredentialVersions(ctx context.Context, credID string) ([]*CredentialVersion, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, credential_id, secret_enc, secret_fields, source, actor_name, created_at
		FROM credential_versions WHERE credential_id = $1 ORDER BY created_at DESC`, credID)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*CredentialVersion, error) {
		var v CredentialVersion
		err := r.Scan(&v.ID, &v.CredentialID, &v.SecretEnc, &v.SecretFields, &v.Source, &v.ActorName, &v.CreatedAt)
		return &v, err
	})
	if out == nil {
		out = []*CredentialVersion{}
	}
	return out, err
}

func (s *Store) GetCredentialVersion(ctx context.Context, credID, id string) (*CredentialVersion, error) {
	var v CredentialVersion
	err := s.pool.QueryRow(ctx, `SELECT id, credential_id, secret_enc, secret_fields, source, actor_name, created_at
		FROM credential_versions WHERE credential_id = $1 AND id = $2`, credID, id).
		Scan(&v.ID, &v.CredentialID, &v.SecretEnc, &v.SecretFields, &v.Source, &v.ActorName, &v.CreatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &v, nil
}

// SetVersionSource relabels a version (a rotation attempt that turned out to work).
func (s *Store) SetVersionSource(ctx context.Context, id, source string) error {
	return execOne(ctx, s.pool, `UPDATE credential_versions SET source = $2 WHERE id = $1`, id, source)
}

func (s *Store) DeleteCredentialVersion(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM credential_versions WHERE id = $1`, id)
}

// ---- Grants ----

type VaultGrant struct {
	UserID *string `json:"user_id"`
	TeamID *string `json:"team_id"`
	Name   string  `json:"name"`
	Level  string  `json:"level"`
}

func (s *Store) ListVaultGrants(ctx context.Context, credID string) ([]VaultGrant, error) {
	rows, err := s.pool.Query(ctx, `SELECT g.user_id, g.team_id, COALESCE(u.username, t.name, ''), g.level
		FROM vault_grants g LEFT JOIN users u ON u.id = g.user_id LEFT JOIN teams t ON t.id = g.team_id
		WHERE g.credential_id = $1 ORDER BY g.team_id IS NULL, 3`, credID)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (VaultGrant, error) {
		var g VaultGrant
		err := r.Scan(&g.UserID, &g.TeamID, &g.Name, &g.Level)
		return g, err
	})
	if out == nil {
		out = []VaultGrant{}
	}
	return out, err
}

// SetVaultGrants replaces the grants of an entry.
func (s *Store) SetVaultGrants(ctx context.Context, credID string, grants []VaultGrant) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM vault_grants WHERE credential_id = $1`, credID); err != nil {
		return err
	}
	for _, g := range grants {
		if _, err := tx.Exec(ctx, `INSERT INTO vault_grants (credential_id, user_id, team_id, level) VALUES ($1, $2, $3, $4)`,
			credID, g.UserID, g.TeamID, g.Level); err != nil {
			return mapErr(err)
		}
	}
	return tx.Commit(ctx)
}

// ---- Check-outs ----

var ErrCheckedOut = errors.New("checked out by someone else")

// OpenCheckout returns the open check-out of an entry, or nil.
func (s *Store) OpenCheckout(ctx context.Context, credID string) (*Checkout, error) {
	var k Checkout
	err := s.pool.QueryRow(ctx, `SELECT `+checkoutCols+` FROM vault_checkouts k WHERE k.credential_id = $1 AND k.checked_in_at IS NULL`, credID).
		Scan(checkoutDest(&k)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &k, nil
}

// StartCheckout opens a check-out; ErrCheckedOut if another one is open. A
// request it uses is marked as used in the same transaction.
func (s *Store) StartCheckout(ctx context.Context, k Checkout) (*Checkout, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, err = tx.Exec(ctx, `INSERT INTO vault_checkouts (id, credential_id, user_id, username, request_id, reason, break_glass, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, k.ID, k.CredentialID, k.UserID, k.Username, k.RequestID, k.Reason, k.BreakGlass, k.ExpiresAt)
	if err != nil {
		if errors.Is(mapErr(err), ErrConflict) {
			return nil, ErrCheckedOut
		}
		return nil, mapErr(err)
	}
	if k.RequestID != nil {
		if err := execOne(ctx, tx, `UPDATE vault_requests SET status = 'used' WHERE id = $1 AND status = 'approved'`, *k.RequestID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.OpenCheckout(ctx, k.CredentialID)
}

// EndCheckout closes a check-out. by is the username, or "expired".
func (s *Store) EndCheckout(ctx context.Context, id, by string) error {
	return execOne(ctx, s.pool, `UPDATE vault_checkouts SET checked_in_at = now(), checked_in_by = $2
		WHERE id = $1 AND checked_in_at IS NULL`, id, by)
}

// ExpiredCheckouts lists open check-outs whose time is up.
func (s *Store) ExpiredCheckouts(ctx context.Context) ([]*Checkout, error) {
	return s.listCheckouts(ctx, `WHERE k.checked_in_at IS NULL AND k.expires_at <= now()`)
}

// ListCheckouts returns open check-outs plus the most recent closed ones (for the activity view).
func (s *Store) ListCheckouts(ctx context.Context, credID string, limit int) ([]*Checkout, error) {
	return s.listCheckouts(ctx, `WHERE k.credential_id = $1 ORDER BY k.started_at DESC LIMIT $2`, credID, limit)
}

func (s *Store) listCheckouts(ctx context.Context, where string, args ...any) ([]*Checkout, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+checkoutCols+`, cr.name FROM vault_checkouts k
		JOIN credentials cr ON cr.id = k.credential_id `+where, args...)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Checkout, error) {
		var k Checkout
		err := r.Scan(append(checkoutDest(&k), &k.CredentialName)...)
		return &k, err
	})
	if out == nil {
		out = []*Checkout{}
	}
	return out, err
}

// ---- Requests ----

func (s *Store) CreateVaultRequest(ctx context.Context, id, credID, userID, reason string, minutes int) (*VaultRequest, error) {
	if _, err := s.pool.Exec(ctx, `INSERT INTO vault_requests (id, credential_id, user_id, reason, minutes) VALUES ($1, $2, $3, $4, $5)`,
		id, credID, userID, reason, minutes); err != nil {
		return nil, mapErr(err)
	}
	return s.GetVaultRequest(ctx, id)
}

func (s *Store) GetVaultRequest(ctx context.Context, id string) (*VaultRequest, error) {
	return scanRequest(s.pool.QueryRow(ctx, `SELECT `+requestCols+requestFrom+` WHERE q.id = $1`, id))
}

// ListVaultRequests returns requests, newest first: all of them (userID nil) or one user's.
func (s *Store) ListVaultRequests(ctx context.Context, userID *string, limit int) ([]*VaultRequest, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+requestCols+requestFrom+`
		WHERE ($1::uuid IS NULL OR q.user_id = $1) ORDER BY q.status <> 'pending', q.created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*VaultRequest, error) { return scanRequest(r) })
	if out == nil {
		out = []*VaultRequest{}
	}
	return out, err
}

// DecideVaultRequest approves or rejects a pending request.
func (s *Store) DecideVaultRequest(ctx context.Context, id, status, byID, byName, note string, validUntil *time.Time) error {
	return execOne(ctx, s.pool, `UPDATE vault_requests SET status = $2, decided_by = $3, decided_by_name = $4,
		decision_note = $5, decided_at = now(), valid_until = $6 WHERE id = $1 AND status = 'pending'`,
		id, status, byID, byName, note, validUntil)
}

// CancelVaultRequest withdraws a pending or approved, unused request.
func (s *Store) CancelVaultRequest(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `UPDATE vault_requests SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'approved')`, id)
}

// ExpireVaultRequests ends approvals that were not used in time and pending
// requests older than a day. Returns how many.
func (s *Store) ExpireVaultRequests(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE vault_requests SET status = 'expired'
		WHERE (status = 'approved' AND valid_until <= now()) OR (status = 'pending' AND created_at <= now() - interval '1 day')`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// CountPendingVaultRequests counts requests waiting for an administrator.
func (s *Store) CountPendingVaultRequests(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM vault_requests WHERE status = 'pending'`).Scan(&n)
	return n, err
}

// ---- Rotation ----

// SetRotationResult records the outcome of a rotation attempt.
func (s *Store) SetRotationResult(ctx context.Context, id, status, errText string) error {
	return execOne(ctx, s.pool, `UPDATE credentials SET rotation_status = $2, rotation_error = $3,
		rotated_at = CASE WHEN $2 IN ('ok', 'unverified') THEN now() ELSE rotated_at END WHERE id = $1`, id, status, errText)
}

// RotationDue lists entries whose scheduled rotation is due: an interval, a
// rotation connection, no open check-out, and the secret older than the interval
// (failed attempts wait an hour before the next try).
func (s *Store) RotationDue(ctx context.Context) ([]*Credential, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+credCols+` FROM credentials cr
		WHERE cr.rotation_interval_days > 0 AND cr.rotation_connection_id IS NOT NULL
		  AND COALESCE(cr.secret_changed_at, cr.created_at) <= now() - make_interval(days => cr.rotation_interval_days)
		  AND NOT (cr.rotation_status = 'failed' AND cr.updated_at > now() - interval '1 hour')
		  AND NOT EXISTS (SELECT 1 FROM vault_checkouts k WHERE k.credential_id = cr.id AND k.checked_in_at IS NULL)`)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Credential, error) { return scanCredential(r) })
	return out, err
}

// TouchCredential bumps updated_at (used to space out failed rotation attempts).
func (s *Store) TouchCredential(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `UPDATE credentials SET updated_at = now() WHERE id = $1`, id)
}

// ConnectionsUsingCredential lists the connections that sign in with a credential.
func (s *Store) ConnectionsUsingCredential(ctx context.Context, credID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM connections WHERE credential_id = $1`, credID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
