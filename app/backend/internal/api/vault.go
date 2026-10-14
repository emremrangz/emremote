package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/store"
)

// errVaultNeedsAdmin: a user without a wrapped key signs in while the data key
// is still locked (after a restart) and other users hold it.
var errVaultNeedsAdmin = errors.New("vault key unavailable until another user signs in")

// openVault unlocks (or, on first use, creates) the password vault with the
// password the user just signed in with, and moves any secrets still in the
// legacy format into the vault.
func (s *Server) openVault(r *http.Request, user *store.User, password string) error {
	ctx := r.Context()
	k, err := s.store.GetVaultKey(ctx, user.ID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		dek, ok := s.box.DEK()
		if !ok {
			// A new data key is only created on a fresh install. If other users hold
			// the key, wait until one of them has signed in and unlocked it.
			if n, cerr := s.store.CountVaultKeys(ctx); cerr != nil {
				return cerr
			} else if n > 0 {
				return errVaultNeedsAdmin
			}
			dek = secrets.NewDEK()
		}
		if err := s.wrapVault(ctx, user.ID, password, dek); err != nil {
			return err
		}
		if err := s.box.Unlock(dek); err != nil {
			return err
		}
		n := s.migrateLegacySecrets(ctx)
		s.audit(r, "vault.created", "user", user.ID, user.Username, true, map[string]any{"migrated_secrets": n})
		return nil
	case err != nil:
		return err
	}
	dek, err := s.box.UnwrapDEK(user.ID, password, k.Salt, k.WrappedDEK, k.KDFParams)
	if err != nil {
		return err
	}
	if err := s.box.Unlock(dek); err != nil {
		return err
	}
	if n := s.migrateLegacySecrets(ctx); n > 0 {
		s.audit(r, "vault.migrated", "user", user.ID, user.Username, true, map[string]any{"migrated_secrets": n})
	}
	return nil
}

func (s *Server) wrapVault(ctx context.Context, userID, password string, dek []byte) error {
	salt := secrets.NewSalt()
	wrapped, err := s.box.WrapDEK(userID, password, salt, dek)
	if err != nil {
		return err
	}
	return s.store.PutVaultKey(ctx, store.VaultKey{UserID: userID, Salt: salt, KDFParams: secrets.KDFParams, WrappedDEK: wrapped})
}

// rewrapVault re-protects the vault after a password change.
func (s *Server) rewrapVault(ctx context.Context, userID, newPassword string) error {
	dek, ok := s.box.DEK()
	if !ok {
		return secrets.ErrLocked
	}
	return s.wrapVault(ctx, userID, newPassword, dek)
}

// migrateLegacySecrets re-encrypts secrets sealed with the server key alone
// (format 0x01) under the vault data key. Returns how many were moved.
func (s *Server) migrateLegacySecrets(ctx context.Context) int {
	rows, err := s.store.ListSecrets(ctx)
	if err != nil {
		slog.Error("list secrets for vault migration", "error", err)
		return 0
	}
	n := 0
	for _, row := range rows {
		if !secrets.IsLegacy(row.Enc) {
			continue
		}
		m, err := s.box.OpenMaterial(row.Kind, row.ID, row.Enc)
		if err != nil {
			slog.Warn("legacy secret could not be decrypted; leaving it", "kind", row.Kind, "id", row.ID)
			continue
		}
		ct, err := s.box.SealMaterial(row.Kind, row.ID, m)
		if err != nil {
			continue
		}
		row.Enc = ct
		if err := s.store.ReplaceSecret(ctx, row); err == nil {
			n++
		}
	}
	if n > 0 {
		slog.Info("moved saved secrets into the vault", "count", n)
	}
	return n
}
