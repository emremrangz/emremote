package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ---- Two-factor authentication ----

// TOTPState is what the sign-in flow needs about a user's second factor.
type TOTPState struct {
	Enabled    bool
	SecretEnc  []byte
	PendingEnc []byte
	LastStep   int64
}

func (s *Store) GetTOTP(ctx context.Context, userID string) (*TOTPState, error) {
	var t TOTPState
	err := s.pool.QueryRow(ctx, `SELECT totp_enabled, totp_secret_enc, totp_pending_enc, totp_last_step FROM users WHERE id = $1`, userID).
		Scan(&t.Enabled, &t.SecretEnc, &t.PendingEnc, &t.LastStep)
	if err != nil {
		return nil, mapErr(err)
	}
	return &t, nil
}

// SetTOTPPending stores a secret awaiting confirmation.
func (s *Store) SetTOTPPending(ctx context.Context, userID string, enc []byte) error {
	return execOne(ctx, s.pool, `UPDATE users SET totp_pending_enc = $2 WHERE id = $1`, userID, enc)
}

// EnableTOTP activates the pending secret and replaces the recovery codes.
func (s *Store) EnableTOTP(ctx context.Context, userID string, step int64, recoveryHashes []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := execOne(ctx, tx, `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = true,
		totp_last_step = $2, updated_at = now() WHERE id = $1 AND totp_pending_enc IS NOT NULL`, userID, step); err != nil {
		return err
	}
	if err := replaceRecovery(ctx, tx, userID, recoveryHashes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func replaceRecovery(ctx context.Context, db pgx.Tx, userID string, hashes []string) error {
	if _, err := db.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id = $1`, userID); err != nil {
		return err
	}
	for _, h := range hashes {
		if _, err := db.Exec(ctx, `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, userID, h); err != nil {
			return err
		}
	}
	return nil
}

// ReplaceRecoveryCodes issues a fresh set of recovery codes.
func (s *Store) ReplaceRecoveryCodes(ctx context.Context, userID string, hashes []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := replaceRecovery(ctx, tx, userID, hashes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DisableTOTP removes the second factor and its recovery codes.
func (s *Store) DisableTOTP(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := execOne(ctx, tx, `UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_pending_enc = NULL,
		totp_last_step = 0, updated_at = now() WHERE id = $1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id = $1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AdvanceTOTPStep records an accepted step; false means it (or a newer one)
// was already used, i.e. a replay.
func (s *Store) AdvanceTOTPStep(ctx context.Context, userID string, step int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2`, userID, step)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// UseRecoveryCode consumes a recovery code; false if it is unknown or used.
func (s *Store) UseRecoveryCode(ctx context.Context, userID, hash string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`, userID, hash)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) CountRecoveryCodes(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`, userID).Scan(&n)
	return n, err
}
