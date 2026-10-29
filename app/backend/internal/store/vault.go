package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type VaultKey struct {
	UserID     string
	Salt       []byte
	KDFParams  string
	WrappedDEK []byte
}

func (s *Store) GetVaultKey(ctx context.Context, userID string) (*VaultKey, error) {
	var k VaultKey
	err := s.pool.QueryRow(ctx, `SELECT user_id, salt, kdf_params, wrapped_dek FROM vault_keys WHERE user_id = $1`, userID).
		Scan(&k.UserID, &k.Salt, &k.KDFParams, &k.WrappedDEK)
	if err != nil {
		return nil, mapErr(err)
	}
	return &k, nil
}

func (s *Store) PutVaultKey(ctx context.Context, k VaultKey) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO vault_keys (user_id, salt, kdf_params, wrapped_dek) VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET salt = EXCLUDED.salt, kdf_params = EXCLUDED.kdf_params,
		wrapped_dek = EXCLUDED.wrapped_dek, updated_at = now()`, k.UserID, k.Salt, k.KDFParams, k.WrappedDEK)
	return err
}

func (s *Store) DeleteVaultKey(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM vault_keys WHERE user_id = $1`, userID)
	return err
}

// SecretRow is an encrypted secret of a connection or saved credential.
type SecretRow struct {
	Kind string // "connection", "credential" or "credential_version"
	ID   string
	Enc  []byte
}

// ListSecrets returns every stored secret (both tables).
func (s *Store) ListSecrets(ctx context.Context) ([]SecretRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT 'connection', id::text, secret_enc FROM connections WHERE secret_enc IS NOT NULL
		UNION ALL SELECT 'credential', id::text, secret_enc FROM credentials WHERE secret_enc IS NOT NULL
		UNION ALL SELECT 'credential_version', id::text, secret_enc FROM credential_versions`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (SecretRow, error) {
		var x SecretRow
		err := r.Scan(&x.Kind, &x.ID, &x.Enc)
		return x, err
	})
}

func (s *Store) ReplaceSecret(ctx context.Context, row SecretRow) error {
	table := "connections"
	switch row.Kind {
	case "credential":
		table = "credentials"
	case "credential_version":
		table = "credential_versions"
	}
	_, err := s.pool.Exec(ctx, `UPDATE `+table+` SET secret_enc = $2 WHERE id = $1`, row.ID, row.Enc)
	return err
}

// ForgetVaultSecrets removes every vault-encrypted secret (used when the vault
// key is lost, e.g. after an offline password reset). Returns how many.
func (s *Store) ForgetVaultSecrets(ctx context.Context) (int64, error) {
	var n int64
	for _, table := range []string{"connections", "credentials"} {
		tag, err := s.pool.Exec(ctx, `UPDATE `+table+` SET secret_enc = NULL, secret_fields = '{}', updated_at = now()
			WHERE secret_enc IS NOT NULL AND get_byte(secret_enc, 0) = 2`)
		if err != nil {
			return n, err
		}
		n += tag.RowsAffected()
	}
	// Old versions sealed with the lost key are useless too.
	tag, err := s.pool.Exec(ctx, `DELETE FROM credential_versions WHERE get_byte(secret_enc, 0) = 2`)
	if err != nil {
		return n, err
	}
	return n + tag.RowsAffected(), nil
}

// CountVaultKeys reports how many users hold a wrapped copy of the data key.
func (s *Store) CountVaultKeys(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM vault_keys`).Scan(&n)
	return n, err
}
