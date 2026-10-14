package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Snippet is a saved piece of text a user can type into their terminal sessions.
type Snippet struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Body       string     `json:"body"`
	Category   string     `json:"category"`
	UseCount   int        `json:"use_count"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

const snippetCols = `id, name, body, category, use_count, last_used_at, created_at, updated_at`

func scanSnippet(r pgx.Row) (*Snippet, error) {
	var s Snippet
	err := r.Scan(&s.ID, &s.Name, &s.Body, &s.Category, &s.UseCount, &s.LastUsedAt, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &s, nil
}

func (s *Store) ListSnippets(ctx context.Context, owner string) ([]*Snippet, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+snippetCols+` FROM snippets WHERE owner_id = $1 ORDER BY lower(category), lower(name)`, owner)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*Snippet, error) { return scanSnippet(r) })
	if out == nil {
		out = []*Snippet{}
	}
	return out, err
}

// GetSnippet returns a snippet only if it belongs to owner.
func (s *Store) GetSnippet(ctx context.Context, owner, id string) (*Snippet, error) {
	return scanSnippet(s.pool.QueryRow(ctx, `SELECT `+snippetCols+` FROM snippets WHERE id = $1 AND owner_id = $2`, id, owner))
}

func (s *Store) CountSnippets(ctx context.Context, owner string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM snippets WHERE owner_id = $1`, owner).Scan(&n)
	return n, err
}

func (s *Store) CreateSnippet(ctx context.Context, owner, name, body, category string) (*Snippet, error) {
	return scanSnippet(s.pool.QueryRow(ctx, `INSERT INTO snippets (owner_id, name, body, category) VALUES ($1, $2, $3, $4) RETURNING `+snippetCols,
		owner, name, body, category))
}

func (s *Store) UpdateSnippet(ctx context.Context, owner, id, name, body, category string) (*Snippet, error) {
	return scanSnippet(s.pool.QueryRow(ctx, `UPDATE snippets SET name = $3, body = $4, category = $5, updated_at = now()
		WHERE id = $1 AND owner_id = $2 RETURNING `+snippetCols, id, owner, name, body, category))
}

func (s *Store) DeleteSnippet(ctx context.Context, owner, id string) error {
	return execOne(ctx, s.pool, `DELETE FROM snippets WHERE id = $1 AND owner_id = $2`, id, owner)
}

// MarkSnippetUsed records a use (the "recent" list).
func (s *Store) MarkSnippetUsed(ctx context.Context, owner, id string) (*Snippet, error) {
	return scanSnippet(s.pool.QueryRow(ctx, `UPDATE snippets SET use_count = use_count + 1, last_used_at = now()
		WHERE id = $1 AND owner_id = $2 RETURNING `+snippetCols, id, owner))
}
