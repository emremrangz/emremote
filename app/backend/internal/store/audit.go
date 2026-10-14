package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type AuditEvent struct {
	ID          int64           `json:"id"`
	OccurredAt  time.Time       `json:"occurred_at"`
	ActorUserID *string         `json:"actor_user_id"`
	ActorName   string          `json:"actor_name"`
	Action      string          `json:"action"`
	TargetType  string          `json:"target_type"`
	TargetID    string          `json:"target_id"`
	TargetName  string          `json:"target_name"`
	IP          string          `json:"ip"`
	Success     bool            `json:"success"`
	Details     json.RawMessage `json:"details"`
}

func (s *Store) InsertAudit(ctx context.Context, e AuditEvent) error {
	details := e.Details
	if len(details) == 0 {
		details = json.RawMessage(`{}`)
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO audit_events (actor_user_id, actor_name, action, target_type, target_id, target_name, ip, success, details)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		e.ActorUserID, e.ActorName, e.Action, e.TargetType, e.TargetID, e.TargetName, e.IP, e.Success, details)
	return err
}

type AuditFilter struct {
	Action   string // exact action or prefix ending in "." (e.g. "device.")
	TargetID string
	Query    string
	Failures bool
	DeviceID string // events about the device or any of its connections
	ActorID  string // only events caused by this user
	Before   int64  // cursor: return events with id < Before
	Limit    int
}

// ListAudit returns events newest first, plus the cursor for the next page (0 = end).
func (s *Store) ListAudit(ctx context.Context, f AuditFilter) ([]AuditEvent, int64, error) {
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	var where []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if f.Action != "" {
		if strings.HasSuffix(f.Action, ".") {
			add("action LIKE $%d || '%%'", f.Action)
		} else {
			add("action = $%d", f.Action)
		}
	}
	if f.TargetID != "" {
		add("target_id = $%d", f.TargetID)
	}
	if f.Query != "" {
		add("(target_name ILIKE '%%' || $%[1]d || '%%' OR actor_name ILIKE '%%' || $%[1]d || '%%' OR ip ILIKE '%%' || $%[1]d || '%%')", f.Query)
	}
	if f.DeviceID != "" {
		add("(target_id = $%[1]d OR details->>'device_id' = $%[1]d OR target_id IN (SELECT id::text FROM connections WHERE device_id::text = $%[1]d))", f.DeviceID)
	}
	if f.ActorID != "" {
		add("actor_user_id::text = $%d", f.ActorID)
	}
	if f.Failures {
		where = append(where, "NOT success")
	}
	if f.Before > 0 {
		add("id < $%d", f.Before)
	}
	q := `SELECT id, occurred_at, actor_user_id, actor_name, action, target_type, target_id, target_name, ip, success, details FROM audit_events`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, f.Limit+1)
	q += fmt.Sprintf(" ORDER BY id DESC LIMIT $%d", len(args))
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	events, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (AuditEvent, error) {
		var e AuditEvent
		err := r.Scan(&e.ID, &e.OccurredAt, &e.ActorUserID, &e.ActorName, &e.Action, &e.TargetType, &e.TargetID, &e.TargetName, &e.IP, &e.Success, &e.Details)
		return e, err
	})
	if err != nil {
		return nil, 0, err
	}
	var next int64
	if len(events) > f.Limit {
		events = events[:f.Limit]
		next = events[len(events)-1].ID
	}
	if events == nil {
		events = []AuditEvent{}
	}
	return events, next, nil
}
