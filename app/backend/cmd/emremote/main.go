// Command emremote runs the emremote API server, guacd tunnel and web UI.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/emremrangz/emremote/internal/api"
	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/config"
	"github.com/emremrangz/emremote/internal/db"
	"github.com/emremrangz/emremote/internal/netpolicy"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/status"
	"github.com/emremrangz/emremote/internal/store"
)

// version is set at build time via -ldflags.
var version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			os.Exit(healthcheck())
		case "reset-2fa":
			if err := resetTwoFactor(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, "error:", err)
				os.Exit(1)
			}
			return
		case "reset-password":
			if err := resetPassword(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, "error:", err)
				os.Exit(1)
			}
			return
		}
	}
	if err := run(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

// healthcheck is used by the container HEALTHCHECK (the runtime image has no shell or curl).
func healthcheck() int {
	addr := os.Getenv("EMREMOTE_LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// resetPassword is the offline account-recovery path:
//
//	docker compose exec emremote /app/emremote reset-password <username>
//
// It sets a random password, prints it once, signs out every session of that
// user and records the event in the audit log.
//
// Saved connection passwords are protected by the old sign-in password, so
// they cannot be recovered: when a vault exists, the operator must confirm
// with --forget-saved-passwords, and those secrets are deleted.
func resetPassword(args []string) error {
	forget := false
	var names []string
	for _, a := range args {
		if a == "--forget-saved-passwords" {
			forget = true
		} else {
			names = append(names, a)
		}
	}
	if len(names) != 1 {
		return errors.New("usage: emremote reset-password <username> [--forget-saved-passwords]")
	}
	args = names
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	st := store.New(pool)
	user, err := st.GetUserByUsername(ctx, args[0])
	if err != nil {
		return fmt.Errorf("user %q: %w", args[0], err)
	}
	_, vaultErr := st.GetVaultKey(ctx, user.ID)
	hasVault := vaultErr == nil
	// With several users the data key is also wrapped for the others, so
	// nothing is lost: this user simply gets a new wrapped copy at next sign-in
	// (after any other user has signed in once since the restart).
	totalKeys, err := st.CountVaultKeys(ctx)
	if err != nil {
		return err
	}
	othersHoldKey := hasVault && totalKeys > 1
	if hasVault && !forget && !othersHoldKey {
		return errors.New("saved connection passwords are encrypted with this user's current password and cannot be recovered without it.\n" +
			"If you really forgot the password, run again with --forget-saved-passwords: the account is reset and every saved\n" +
			"connection password is deleted (connections then ask for credentials until you save them again)")
	}
	forgotten := int64(0)
	if hasVault {
		if !othersHoldKey {
			if forgotten, err = st.ForgetVaultSecrets(ctx); err != nil {
				return err
			}
		}
		if err := st.DeleteVaultKey(ctx, user.ID); err != nil {
			return err
		}
	}
	password := auth.RandomToken(15)
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	if err := st.UpdatePassword(ctx, user.ID, hash); err != nil {
		return err
	}
	// Offline access to the server is the recovery path, so two-factor is turned off too.
	if user.TwoFactor {
		if err := st.DisableTOTP(ctx, user.ID); err != nil {
			return err
		}
	}
	revoked, err := st.DeleteUserSessions(ctx, user.ID, "")
	if err != nil {
		return err
	}
	details, _ := json.Marshal(map[string]any{"method": "cli", "revoked_sessions": len(revoked), "forgotten_saved_passwords": forgotten})
	_ = st.InsertAudit(ctx, store.AuditEvent{
		Action: "auth.password_reset", TargetType: "user", TargetID: user.ID, TargetName: user.Username,
		ActorName: "cli", Success: true, Details: details,
	})
	fmt.Printf("New password for %s: %s\nAll sessions were signed out. Change it under Settings after signing in.\n", user.Username, password)
	if user.TwoFactor {
		fmt.Println("Two-factor authentication was turned off for this user; set it up again under Settings.")
	}
	if hasVault && othersHoldKey {
		fmt.Println("Saved connection passwords were kept (other users hold the key). Another user must sign in once before this user can.")
	} else if hasVault {
		fmt.Printf("%d saved connection secret(s) were deleted; enter them again where needed.\n", forgotten)
		fmt.Println("Restart emremote (docker compose restart emremote) to clear the old key from memory.")
	}
	return nil
}

// resetTwoFactor turns two-factor sign-in off for one user and signs them out, without touching
// the password or the saved connection passwords:
//
//	docker compose exec emremote /app/emremote reset-2fa <username>
//
// Access to the server is the recovery path, as with reset-password.
func resetTwoFactor(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: emremote reset-2fa <username>")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	st := store.New(pool)
	user, err := st.GetUserByUsername(ctx, args[0])
	if err != nil {
		return fmt.Errorf("user %q: %w", args[0], err)
	}
	if !user.TwoFactor {
		fmt.Printf("Two-factor authentication is not turned on for %s.\n", user.Username)
		return nil
	}
	if err := st.DisableTOTP(ctx, user.ID); err != nil {
		return err
	}
	revoked, err := st.DeleteUserSessions(ctx, user.ID, "")
	if err != nil {
		return err
	}
	details, _ := json.Marshal(map[string]any{"method": "cli", "revoked_sessions": len(revoked)})
	_ = st.InsertAudit(ctx, store.AuditEvent{
		Action: "user.2fa_reset", TargetType: "user", TargetID: user.ID, TargetName: user.Username,
		ActorName: "cli", Success: true, Details: details,
	})
	fmt.Printf("Two-factor authentication was turned off for %s and their sessions were signed out.\nThey can sign in with the password alone and set it up again under Settings.\n", user.Username)
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
	slog.Info("starting emremote", "version", version)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	box, err := secrets.New(cfg.EncryptionKey)
	if err != nil {
		return err
	}
	policy := netpolicy.New(cfg.AllowedTargetNetworks, cfg.DeniedTargetNetworks)
	if err := policy.DenyLocalInterfaces(); err != nil {
		return fmt.Errorf("enumerate local networks: %w", err)
	}
	slog.Info("target network policy", "allowed", cfg.AllowedTargetNetworks, "denied", policy.Denied())

	st := store.New(pool)
	checker := status.New(st, policy, cfg.StatusCheckInterval)
	srv := api.New(api.Options{Config: cfg, Store: st, Box: box, Policy: policy, Checker: checker, Version: version})
	srv.LoadSettings(ctx)
	if err := srv.PrepareSetup(ctx); err != nil {
		return err
	}

	go checker.Run(ctx)
	go srv.Background(ctx)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	errc := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", cfg.ListenAddr)
		errc <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	srv.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}
