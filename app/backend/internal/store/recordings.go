package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Recording describes one recorded remote session; the file is named after its id.
type Recording struct {
	ID             string     `json:"id"`
	SessionID      string     `json:"session_id"`
	UserID         *string    `json:"user_id"`
	Username       string     `json:"username"`
	DeviceID       *string    `json:"device_id"`
	DeviceName     string     `json:"device_name"`
	ConnectionName string     `json:"connection_name"`
	Protocol       string     `json:"protocol"`
	StartedAt      time.Time  `json:"started_at"`
	EndedAt        *time.Time `json:"ended_at"`
	SizeBytes      int64      `json:"size_bytes"`
	// Location is "local" (this server), "remote" (the network share) or "both".
	Location string `json:"location"`
}

const recordingCols = `id, session_id, user_id, username, device_id, device_name, connection_name, protocol, started_at, ended_at, size_bytes, location`

func scanRecording(r pgx.Row) (*Recording, error) {
	var x Recording
	err := r.Scan(&x.ID, &x.SessionID, &x.UserID, &x.Username, &x.DeviceID, &x.DeviceName, &x.ConnectionName, &x.Protocol, &x.StartedAt, &x.EndedAt, &x.SizeBytes, &x.Location)
	if err != nil {
		return nil, mapErr(err)
	}
	return &x, nil
}

func collectRecordings(rows pgx.Rows, err error) ([]*Recording, error) {
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Recording, error) { return scanRecording(r) })
	if out == nil {
		out = []*Recording{}
	}
	return out, err
}

func (s *Store) CreateRecording(ctx context.Context, x *Recording) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO recordings (id, session_id, user_id, username, device_id, device_name, connection_name, protocol, started_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		x.ID, x.SessionID, x.UserID, x.Username, x.DeviceID, x.DeviceName, x.ConnectionName, x.Protocol, x.StartedAt)
	return mapErr(err)
}

// FinishRecording notes when a recording ended and how large the file is.
func (s *Store) FinishRecording(ctx context.Context, id string, ended time.Time, size int64) error {
	return execOne(ctx, s.pool, `UPDATE recordings SET ended_at = $2, size_bytes = $3 WHERE id = $1`, id, ended, size)
}

func (s *Store) GetRecording(ctx context.Context, id string) (*Recording, error) {
	return scanRecording(s.pool.QueryRow(ctx, `SELECT `+recordingCols+` FROM recordings WHERE id = $1`, id))
}

// RecordingFilter narrows a listing. An empty UserID means everyone's recordings.
type RecordingFilter struct {
	UserID   string
	DeviceID string
	Protocol string
	Limit    int
	Offset   int
}

func (s *Store) ListRecordings(ctx context.Context, f RecordingFilter) ([]*Recording, int, error) {
	where := `WHERE ($1 = '' OR user_id::text = $1) AND ($2 = '' OR device_id::text = $2) AND ($3 = '' OR protocol = $3)`
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM recordings `+where, f.UserID, f.DeviceID, f.Protocol).Scan(&total); err != nil {
		return nil, 0, err
	}
	out, err := collectRecordings(s.pool.Query(ctx, `SELECT `+recordingCols+` FROM recordings `+where+` ORDER BY started_at DESC LIMIT $4 OFFSET $5`,
		f.UserID, f.DeviceID, f.Protocol, f.Limit, f.Offset))
	return out, total, err
}

func (s *Store) DeleteRecording(ctx context.Context, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM recordings WHERE id = $1`, id)
}

// UnfinishedRecordings are rows whose session never reported an end (the server stopped meanwhile).
func (s *Store) UnfinishedRecordings(ctx context.Context) ([]*Recording, error) {
	return collectRecordings(s.pool.Query(ctx, `SELECT `+recordingCols+` FROM recordings WHERE ended_at IS NULL`))
}

// FinishedRecordingsBefore lists finished recordings that started before t.
func (s *Store) FinishedRecordingsBefore(ctx context.Context, t time.Time) ([]*Recording, error) {
	return collectRecordings(s.pool.Query(ctx, `SELECT `+recordingCols+` FROM recordings WHERE ended_at IS NOT NULL AND started_at < $1`, t))
}

// OldestFinishedRecordings lists the oldest finished recordings first.
func (s *Store) OldestFinishedRecordings(ctx context.Context, limit int) ([]*Recording, error) {
	return collectRecordings(s.pool.Query(ctx, `SELECT `+recordingCols+` FROM recordings WHERE ended_at IS NOT NULL ORDER BY started_at LIMIT $1`, limit))
}

// RecordingTotals returns how many recordings exist and how many bytes they take.
func (s *Store) RecordingTotals(ctx context.Context) (count int, bytes int64, err error) {
	err = s.pool.QueryRow(ctx, `SELECT count(*), coalesce(sum(size_bytes), 0) FROM recordings`).Scan(&count, &bytes)
	return
}

// SetRecordingLocation notes where the file now is (and its size on disk).
func (s *Store) SetRecordingLocation(ctx context.Context, id, location string, size int64) error {
	return execOne(ctx, s.pool, `UPDATE recordings SET location = $2, size_bytes = $3 WHERE id = $1`, id, location, size)
}

// LocalOnlyRecordings are finished recordings whose file is only on this server.
func (s *Store) LocalOnlyRecordings(ctx context.Context) ([]*Recording, error) {
	return collectRecordings(s.pool.Query(ctx, `SELECT `+recordingCols+` FROM recordings WHERE ended_at IS NOT NULL AND location = 'local' ORDER BY started_at`))
}
