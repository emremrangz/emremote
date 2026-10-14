// Package db opens the PostgreSQL pool and applies embedded, versioned migrations.
package db

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Open connects to PostgreSQL, retrying while the database starts up.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 10
	var pool *pgxpool.Pool
	deadline := time.Now().Add(60 * time.Second)
	for {
		pool, err = pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("connect to database: %w", err)
		}
		slog.Info("waiting for database", "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		name := e.Name()
		prefix, _, ok := strings.Cut(name, "_")
		if !ok || !strings.HasSuffix(name, ".sql") {
			return nil, fmt.Errorf("invalid migration filename %q", name)
		}
		v, err := strconv.Atoi(prefix)
		if err != nil {
			return nil, fmt.Errorf("invalid migration version in %q", name)
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: name, sql: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i := 1; i < len(out); i++ {
		if out[i].version == out[i-1].version {
			return nil, fmt.Errorf("duplicate migration version %d", out[i].version)
		}
	}
	return out, nil
}

// Migrate applies pending migrations, each in its own transaction, guarded by
// an advisory lock so that concurrent instances cannot race.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	const lockID = 0x656d72656d6f7465 // "emremote"
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(lockID)); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, int64(lockID)) //nolint:errcheck

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version integer PRIMARY KEY,
		name text NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[int]bool{}
	rows, err := conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, m := range migrations {
		if applied[m.version] {
			continue
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, m.sql); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return fmt.Errorf("apply migration %s: %w", m.name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, m.version, m.name); err != nil {
			tx.Rollback(ctx) //nolint:errcheck
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		slog.Info("applied migration", "name", m.name)
	}
	return nil
}
