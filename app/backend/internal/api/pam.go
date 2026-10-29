package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/sshhelper"
	"github.com/emremrangz/emremote/internal/store"
	"github.com/emremrangz/emremote/internal/vault"
)

// ---- Privileged access vault ----
//
// Saved credentials are vault entries. Who may do what:
//
//	manage  the owner of a private entry, administrators for shared ones: edit, share, rotate, history
//	reveal  show or copy the secret, with a reason, if the entry allows revealing
//	use     see the entry, check it out and connect with it without seeing the secret
//
// Shared entries can require a check-out (one person at a time, for a limited
// time) and, for members, an approved request first. Break-glass skips the
// approval with a reason and is audited as such. Connecting with an entry that
// needs a check-out is refused until the user holds it.

const (
	vaultPolicyKey = "vault_policy"
	// minReason is the shortest reason accepted for revealing or checking out a shared entry.
	minReason = 4
)

var levelRank = map[string]int{store.VaultUse: 1, store.VaultReveal: 2, store.VaultManage: 3}

func atLeast(level, need string) bool { return levelRank[level] >= levelRank[need] }

// vaultSettings is the saved vault policy.
type vaultSettings struct {
	vault.Policy
	// RequestValidHours: how long an approval may wait before it is used.
	RequestValidHours int `json:"request_valid_hours"`
}

func defaultVaultSettings() vaultSettings {
	return vaultSettings{Policy: vault.DefaultPolicy, RequestValidHours: 8}
}

func (s *Server) vaultSettings(ctx context.Context) vaultSettings {
	out := defaultVaultSettings()
	if raw, ok, err := s.store.GetSetting(ctx, vaultPolicyKey); err == nil && ok {
		_ = json.Unmarshal(raw, &out)
	}
	if out.Policy.Validate() != nil {
		out.Policy = vault.DefaultPolicy
	}
	if out.RequestValidHours < 1 || out.RequestValidHours > 168 {
		out.RequestValidHours = 8
	}
	return out
}

func (s *Server) handleGetVaultPolicy(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.vaultSettings(r.Context()))
}

func (s *Server) handleSetVaultPolicy(w http.ResponseWriter, r *http.Request) {
	var req vaultSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	if err := req.Policy.Validate(); err != nil {
		v.fail("length", err.Error())
	}
	if req.RequestValidHours < 1 || req.RequestValidHours > 168 {
		v.fail("request_valid_hours", "Must be between 1 hour and 7 days")
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	raw, _ := json.Marshal(req)
	if err := s.store.SetSetting(r.Context(), vaultPolicyKey, raw); err != nil {
		writeStoreError(w, r, err, "Setting")
		return
	}
	s.audit(r, "settings.vault", "settings", "", "Vault policy", true, map[string]any{"length": req.Length,
		"lower": req.Lower, "upper": req.Upper, "digits": req.Digits, "symbols": req.Symbols, "request_valid_hours": req.RequestValidHours})
	writeJSON(w, http.StatusOK, req)
}

// ---- Helpers ----

func strengthOf(m secrets.Material) *int {
	if m.Password == "" {
		return nil
	}
	n := vault.Strength(m.Password)
	return &n
}

// mergeMaterial overlays the non-empty fields of upd on cur.
func mergeMaterial(cur, upd secrets.Material) secrets.Material {
	set := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	set(&cur.Password, upd.Password)
	set(&cur.PrivateKey, upd.PrivateKey)
	set(&cur.Passphrase, upd.Passphrase)
	set(&cur.Token, upd.Token)
	set(&cur.Note, upd.Note)
	set(&cur.TOTP, upd.TOTP)
	return cur
}

func (s *Server) addVersion(ctx context.Context, credID, id string, ct []byte, fields []string, source, actor string) {
	if err := s.store.AddCredentialVersion(ctx, store.CredentialVersion{ID: id, CredentialID: credID, SecretEnc: ct,
		SecretFields: fields, Source: source, ActorName: actor}); err != nil {
		slog.Error("store secret version", "credential", credID, "error", err)
	}
}

// replaceCredentialSecret makes m the current secret and records it in the history.
func (s *Server) replaceCredentialSecret(ctx context.Context, c *store.Credential, m secrets.Material, source, actor string) error {
	ct, err := s.box.SealMaterial("credential", c.ID, m)
	if err != nil {
		return err
	}
	if err := s.store.SetCredentialSecret(ctx, c.ID, ct, m.Fields(), strengthOf(m)); err != nil {
		return err
	}
	if !m.Empty() {
		vid := newUUID()
		if vct, err := s.box.SealMaterial("credential_version", vid, m); err == nil {
			s.addVersion(ctx, c.ID, vid, vct, m.Fields(), source, actor)
		}
	}
	return nil
}

// vaultEntry loads the entry named in the URL as the signed-in user sees it and
// checks the access level. It writes the response and returns nil on failure.
func (s *Server) vaultEntry(w http.ResponseWriter, r *http.Request, need string) *store.VaultEntry {
	u := userFrom(r.Context())
	e, err := s.store.GetVaultEntry(r.Context(), u, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Vault entry")
		return nil
	}
	// Managing your own entries needs the credentials permission.
	if e.Access == store.VaultManage && e.OwnerID != nil && !u.Can(store.PermCredentials) {
		e.Access = store.VaultReveal
	}
	if !atLeast(e.Access, need) {
		forbidden(w, "Your access to this vault entry does not allow this.")
		return nil
	}
	return e
}

func shared(e *store.VaultEntry) bool { return e.OwnerID == nil }

// holds reports whether u holds the open check-out of e (and its time has not run out).
func holds(e *store.VaultEntry, u *store.User) bool {
	return holdsCheckout(e.Checkout, u)
}

func holdsCheckout(k *store.Checkout, u *store.User) bool {
	return k != nil && k.UserID != nil && *k.UserID == u.ID && time.Now().Before(k.ExpiresAt)
}

func checkoutConflict(w http.ResponseWriter, k *store.Checkout) {
	writeError(w, http.StatusConflict, "checked_out",
		fmt.Sprintf("Checked out by %s until %s UTC.", k.Username, k.ExpiresAt.UTC().Format("15:04")))
}

func cleanReason(s string) string { return strings.TrimSpace(truncate(s, 500)) }

// ---- Listing ----

func (s *Server) handleListVault(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	list, err := s.store.ListVault(r.Context(), u)
	if err != nil {
		writeStoreError(w, r, err, "Vault entry")
		return
	}
	for _, e := range list {
		if e.Access == store.VaultManage && e.OwnerID != nil && !u.Can(store.PermCredentials) {
			e.Access = store.VaultReveal
		}
		e.CanManage = e.Access == store.VaultManage
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleGetVaultEntry(w http.ResponseWriter, r *http.Request) {
	e := s.vaultEntry(w, r, store.VaultUse)
	if e == nil {
		return
	}
	e.CanManage = e.Access == store.VaultManage
	out := map[string]any{"entry": e}
	if e.CanManage {
		ctx := r.Context()
		if shared(e) {
			if g, err := s.store.ListVaultGrants(ctx, e.ID); err == nil {
				e.Grants = g
			}
		}
		if v, err := s.store.ListCredentialVersions(ctx, e.ID); err == nil {
			out["versions"] = v
		}
		if k, err := s.store.ListCheckouts(ctx, e.ID, 20); err == nil {
			out["checkouts"] = k
		}
		if e.RotationConnectionID != nil {
			if c, err := s.store.GetConnection(ctx, *e.RotationConnectionID); err == nil {
				out["rotation_connection"] = map[string]string{"id": c.ID, "name": c.DeviceName + " / " + c.Name}
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Reveal ----

type revealRequest struct {
	Reason string `json:"reason"`
	// Field limits the answer to one secret field ("" = all of them).
	Field string `json:"field"`
	// Purpose is "show" or "copy", for the audit log.
	Purpose   string `json:"purpose"`
	VersionID string `json:"version_id"`
}

func (s *Server) handleRevealVault(w http.ResponseWriter, r *http.Request) {
	var req revealRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	need := store.VaultReveal
	if req.VersionID != "" {
		need = store.VaultManage // old values are for the people who manage the entry
	}
	e := s.vaultEntry(w, r, need)
	if e == nil {
		return
	}
	u := userFrom(r.Context())
	req.Reason = cleanReason(req.Reason)
	v := newValidator()
	if shared(e) && len([]rune(req.Reason)) < minReason {
		v.fail("reason", "Say why you need it (at least 4 characters)")
	}
	v.oneOf("field", req.Field, "", "password", "private_key", "passphrase", "token", "note", "totp")
	if req.Purpose == "" {
		req.Purpose = "show"
	}
	v.oneOf("purpose", req.Purpose, "show", "copy")
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	target := e.Name
	if e.RevealPolicy == "never" {
		s.audit(r, "vault.reveal", "credential", e.ID, target, false, map[string]any{"reason": req.Reason, "refused": "connect only"})
		forbidden(w, "This entry is connect-only: its secret is never shown. An administrator can change that in the entry's settings.")
		return
	}
	if e.AccessPolicy != "open" && !holds(e, u) {
		s.audit(r, "vault.reveal", "credential", e.ID, target, false, map[string]any{"reason": req.Reason, "refused": "not checked out"})
		writeError(w, http.StatusConflict, "checkout_required", "Check this entry out first.")
		return
	}
	ct, kind, id := e.SecretEnc, "credential", e.ID
	if req.VersionID != "" {
		ver, err := s.store.GetCredentialVersion(r.Context(), e.ID, req.VersionID)
		if err != nil {
			writeStoreError(w, r, err, "Version")
			return
		}
		ct, kind, id = ver.SecretEnc, "credential_version", ver.ID
	}
	m, err := s.box.OpenMaterial(kind, id, ct)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "secret_unavailable", "The secret could not be decrypted: "+err.Error())
		return
	}
	fields := map[string]string{}
	add := func(name, val string) {
		if val != "" && (req.Field == "" || req.Field == name) {
			fields[name] = val
		}
	}
	add("password", m.Password)
	add("private_key", m.PrivateKey)
	add("passphrase", m.Passphrase)
	add("token", m.Token)
	add("note", m.Note)
	out := map[string]any{"fields": fields}
	// The one-time code seed itself is never returned, only the current code.
	if m.TOTP != "" && (req.Field == "" || req.Field == "totp") {
		if key, err := vault.TOTPKey(m.TOTP); err == nil {
			now := time.Now()
			out["totp_code"] = auth.TOTPCode(key, auth.TOTPStep(now))
			out["totp_seconds_left"] = auth.TOTPPeriod - int(now.Unix()%auth.TOTPPeriod)
		}
	}
	names := make([]string, 0, len(fields))
	for k := range fields {
		names = append(names, k)
	}
	if _, ok := out["totp_code"]; ok {
		names = append(names, "totp_code")
	}
	details := map[string]any{"reason": req.Reason, "fields": names, "purpose": req.Purpose}
	if req.VersionID != "" {
		details["version_id"] = req.VersionID
	}
	if e.Checkout != nil {
		details["checkout_id"] = e.Checkout.ID
	}
	s.audit(r, "vault.reveal", "credential", e.ID, target, true, details)
	writeJSON(w, http.StatusOK, out)
}

// ---- Check-out and check-in ----

type checkoutRequest struct {
	Reason     string `json:"reason"`
	Minutes    int    `json:"minutes"`
	BreakGlass bool   `json:"break_glass"`
}

func (s *Server) handleCheckoutVault(w http.ResponseWriter, r *http.Request) {
	var req checkoutRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	e := s.vaultEntry(w, r, store.VaultUse)
	if e == nil {
		return
	}
	u := userFrom(r.Context())
	if e.AccessPolicy == "open" {
		writeError(w, http.StatusBadRequest, "not_needed", "This entry does not need a check-out.")
		return
	}
	if e.Checkout != nil {
		if holds(e, u) {
			writeError(w, http.StatusConflict, "already_checked_out", "You already hold this entry. Check it in first to start again.")
		} else {
			checkoutConflict(w, e.Checkout)
		}
		return
	}
	req.Reason = cleanReason(req.Reason)
	k := store.Checkout{ID: newUUID(), CredentialID: e.ID, UserID: &u.ID, Username: u.Username, Reason: req.Reason}
	minutes := req.Minutes
	// Members need an approved request for "approval" entries, or break-glass.
	needsApproval := e.AccessPolicy == "approval" && e.Access != store.VaultManage
	switch {
	case needsApproval && req.BreakGlass:
		if !e.BreakGlass {
			forbidden(w, "Break-glass access is switched off for this entry.")
			return
		}
		k.BreakGlass = true
	case needsApproval:
		q := e.MyRequest
		if q == nil || q.Status != "approved" || q.ValidUntil == nil || time.Now().After(*q.ValidUntil) {
			writeError(w, http.StatusConflict, "approval_required", "This entry needs an approved request. Request access first.")
			return
		}
		k.RequestID = &q.ID
		minutes = q.Minutes
		if k.Reason == "" {
			k.Reason = q.Reason
		}
	case req.BreakGlass:
		writeError(w, http.StatusBadRequest, "not_needed", "Break-glass is only for entries that need approval.")
		return
	}
	v := newValidator()
	if len([]rune(k.Reason)) < minReason {
		v.fail("reason", "Say why you need it (at least 4 characters)")
	}
	if k.BreakGlass && len([]rune(k.Reason)) < 10 {
		v.fail("reason", "Break-glass needs a fuller reason (at least 10 characters)")
	}
	if minutes == 0 {
		minutes = e.MaxCheckoutMinutes
	}
	if minutes < 5 || minutes > e.MaxCheckoutMinutes {
		v.fail("minutes", fmt.Sprintf("Must be between 5 and %d minutes", e.MaxCheckoutMinutes))
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	k.ExpiresAt = time.Now().Add(time.Duration(minutes) * time.Minute)
	got, err := s.store.StartCheckout(r.Context(), k)
	if errors.Is(err, store.ErrCheckedOut) {
		if cur, _ := s.store.OpenCheckout(r.Context(), e.ID); cur != nil {
			checkoutConflict(w, cur)
			return
		}
	}
	if err != nil {
		writeStoreError(w, r, err, "Check-out")
		return
	}
	action := "vault.checkout"
	if k.BreakGlass {
		action = "vault.break_glass"
		slog.Warn("vault break-glass check-out", "entry", e.Name, "user", u.Username)
	}
	details := map[string]any{"reason": k.Reason, "minutes": minutes, "checkout_id": got.ID}
	if k.RequestID != nil {
		details["request_id"] = *k.RequestID
	}
	s.audit(r, action, "credential", e.ID, e.Name, true, details)
	writeJSON(w, http.StatusCreated, got)
}

func (s *Server) handleCheckinVault(w http.ResponseWriter, r *http.Request) {
	e := s.vaultEntry(w, r, store.VaultUse)
	if e == nil {
		return
	}
	u := userFrom(r.Context())
	if e.Checkout == nil {
		writeError(w, http.StatusConflict, "not_checked_out", "This entry is not checked out.")
		return
	}
	// The holder may give it back even in the minute after the time ran out.
	holder := e.Checkout.UserID != nil && *e.Checkout.UserID == u.ID
	if !holder && e.Access != store.VaultManage {
		forbidden(w, "Only the person who checked it out, or an administrator, can check it in.")
		return
	}
	if err := s.store.EndCheckout(r.Context(), e.Checkout.ID, u.Username); err != nil {
		writeStoreError(w, r, err, "Check-out")
		return
	}
	forced := !holder
	s.audit(r, "vault.checkin", "credential", e.ID, e.Name, true, map[string]any{"checkout_id": e.Checkout.ID,
		"holder": e.Checkout.Username, "forced": forced})
	s.afterCheckin(&e.Credential, e.Checkout, u.Username)
	w.WriteHeader(http.StatusNoContent)
}

// afterCheckin ends the holder's sessions that use the entry and, if the entry
// says so, changes its password so the value the holder saw stops working.
func (s *Server) afterCheckin(c *store.Credential, k *store.Checkout, by string) {
	if k.UserID != nil {
		s.closeVaultSessions(c.ID, *k.UserID)
	}
	if c.RotateAfterCheckin && c.RotationConnectionID != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if _, err := s.rotateCredential(ctx, c.ID, "check-in by "+by); err != nil {
				slog.Warn("rotation after check-in failed", "entry", c.Name, "error", err)
			}
		}()
	}
}

// closeVaultSessions ends a user's remote sessions and file sessions that use the entry.
func (s *Server) closeVaultSessions(credID, userID string) {
	ids, err := s.store.ConnectionsUsingCredential(context.Background(), credID)
	if err != nil || len(ids) == 0 {
		return
	}
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	n := s.tunnels.terminate(func(a *ActiveSession) bool { return set[a.ConnectionID] && a.UserID == userID })
	if n > 0 {
		slog.Info("ended remote sessions after vault check-in", "count", n)
	}
}

// ---- Requests ----

func (s *Server) handleCreateVaultRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reason  string `json:"reason"`
		Minutes int    `json:"minutes"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	e := s.vaultEntry(w, r, store.VaultUse)
	if e == nil {
		return
	}
	if e.AccessPolicy != "approval" || e.Access == store.VaultManage {
		writeError(w, http.StatusBadRequest, "not_needed", "This entry does not need a request; check it out directly.")
		return
	}
	req.Reason = cleanReason(req.Reason)
	v := newValidator()
	if len([]rune(req.Reason)) < minReason {
		v.fail("reason", "Say why you need it (at least 4 characters)")
	}
	if req.Minutes == 0 {
		req.Minutes = e.MaxCheckoutMinutes
	}
	if req.Minutes < 5 || req.Minutes > e.MaxCheckoutMinutes {
		v.fail("minutes", fmt.Sprintf("Must be between 5 and %d minutes", e.MaxCheckoutMinutes))
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	u := userFrom(r.Context())
	q, err := s.store.CreateVaultRequest(r.Context(), newUUID(), e.ID, u.ID, req.Reason, req.Minutes)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "request_open", "You already have an open request for this entry.")
		return
	}
	if err != nil {
		writeStoreError(w, r, err, "Request")
		return
	}
	s.audit(r, "vault.request", "credential", e.ID, e.Name, true, map[string]any{"request_id": q.ID, "reason": q.Reason, "minutes": q.Minutes})
	writeJSON(w, http.StatusCreated, q)
}

func (s *Server) handleListVaultRequests(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var who *string
	if !u.IsAdmin() {
		who = &u.ID
	}
	list, err := s.store.ListVaultRequests(r.Context(), who, 200)
	if err != nil {
		writeStoreError(w, r, err, "Request")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleDecideVaultRequest(approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Note string `json:"note"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		u := userFrom(r.Context())
		q, err := s.store.GetVaultRequest(r.Context(), r.PathValue("rid"))
		if err != nil {
			writeStoreError(w, r, err, "Request")
			return
		}
		if q.UserID == u.ID {
			forbidden(w, "You cannot decide your own request; another administrator has to.")
			return
		}
		if q.Status != "pending" {
			writeError(w, http.StatusConflict, "already_decided", "This request is already "+q.Status+".")
			return
		}
		status, action := "rejected", "vault.reject"
		var until *time.Time
		if approve {
			status, action = "approved", "vault.approve"
			t := time.Now().Add(time.Duration(s.vaultSettings(r.Context()).RequestValidHours) * time.Hour)
			until = &t
		}
		note := cleanReason(req.Note)
		if err := s.store.DecideVaultRequest(r.Context(), q.ID, status, u.ID, u.Username, note, until); err != nil {
			writeStoreError(w, r, err, "Request")
			return
		}
		s.audit(r, action, "credential", q.CredentialID, q.CredentialName, true, map[string]any{"request_id": q.ID,
			"requester": q.Username, "note": note})
		q, _ = s.store.GetVaultRequest(r.Context(), q.ID)
		writeJSON(w, http.StatusOK, q)
	}
}

func (s *Server) handleCancelVaultRequest(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	q, err := s.store.GetVaultRequest(r.Context(), r.PathValue("rid"))
	if err != nil {
		writeStoreError(w, r, err, "Request")
		return
	}
	if q.UserID != u.ID && !u.IsAdmin() {
		writeError(w, http.StatusNotFound, "not_found", "Request not found")
		return
	}
	if err := s.store.CancelVaultRequest(r.Context(), q.ID); err != nil {
		writeError(w, http.StatusConflict, "already_decided", "This request can no longer be cancelled.")
		return
	}
	s.audit(r, "vault.request_cancel", "credential", q.CredentialID, q.CredentialName, true, map[string]any{"request_id": q.ID})
	w.WriteHeader(http.StatusNoContent)
}

// ---- Sharing ----

func (s *Server) handleSetVaultGrants(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Grants []store.VaultGrant `json:"grants"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	e := s.vaultEntry(w, r, store.VaultManage)
	if e == nil {
		return
	}
	if !shared(e) {
		writeError(w, http.StatusBadRequest, "bad_request", "Only shared entries can be shared with others.")
		return
	}
	v := newValidator()
	if len(req.Grants) > 500 {
		v.fail("grants", "Too many entries")
	}
	seen := map[string]bool{}
	names := []string{}
	for i, g := range req.Grants {
		f := fmt.Sprintf("grants.%d", i)
		v.oneOf(f+".level", g.Level, store.VaultUse, store.VaultReveal)
		switch {
		case (g.UserID == nil) == (g.TeamID == nil):
			v.fail(f, "Choose a user or a team")
			continue
		case g.UserID != nil:
			usr, err := s.store.GetUser(r.Context(), *g.UserID)
			if err != nil {
				v.fail(f, "User does not exist")
				continue
			}
			names = append(names, usr.Username+":"+g.Level)
			if seen[*g.UserID] {
				v.fail(f, "Listed twice")
			}
			seen[*g.UserID] = true
		default:
			t, err := s.store.GetTeam(r.Context(), *g.TeamID)
			if err != nil {
				v.fail(f, "Team does not exist")
				continue
			}
			names = append(names, "team "+t.Name+":"+g.Level)
			if seen[*g.TeamID] {
				v.fail(f, "Listed twice")
			}
			seen[*g.TeamID] = true
		}
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	if err := s.store.SetVaultGrants(r.Context(), e.ID, req.Grants); err != nil {
		writeStoreError(w, r, err, "Vault entry")
		return
	}
	s.audit(r, "vault.share", "credential", e.ID, e.Name, true, map[string]any{"grants": names})
	g, _ := s.store.ListVaultGrants(r.Context(), e.ID)
	writeJSON(w, http.StatusOK, g)
}

// ---- History ----

func (s *Server) handleRestoreVersion(w http.ResponseWriter, r *http.Request) {
	e := s.vaultEntry(w, r, store.VaultManage)
	if e == nil {
		return
	}
	u := userFrom(r.Context())
	if e.Checkout != nil && !holds(e, u) {
		checkoutConflict(w, e.Checkout)
		return
	}
	ver, err := s.store.GetCredentialVersion(r.Context(), e.ID, r.PathValue("vid"))
	if err != nil {
		writeStoreError(w, r, err, "Version")
		return
	}
	m, err := s.box.OpenMaterial("credential_version", ver.ID, ver.SecretEnc)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "secret_unavailable", "The old value could not be decrypted: "+err.Error())
		return
	}
	if err := s.replaceCredentialSecret(r.Context(), &e.Credential, m, "restored", u.Username); err != nil {
		writeStoreError(w, r, err, "Vault entry")
		return
	}
	s.audit(r, "vault.restore", "credential", e.ID, e.Name, true, map[string]any{"version_id": ver.ID, "version_date": ver.CreatedAt})
	w.WriteHeader(http.StatusNoContent)
}

// ---- Rotation ----

// rotationTargetProblem explains why a connection cannot be used to rotate a
// password of an entry with the given owner ("" if it can).
func (s *Server) rotationTargetProblem(ctx context.Context, connID string, owner *string) string {
	c, err := s.store.GetConnection(ctx, connID)
	if err != nil {
		return "Connection does not exist"
	}
	if !sameOwner(c.DeviceOwnerID, owner) {
		return "The connection must belong to the same owner as the entry (shared with shared, yours with yours)"
	}
	if c.Protocol != "ssh" {
		return "Rotation works over SSH; choose an SSH connection"
	}
	if jumpIDOf(c.Settings) != "" {
		return "Rotation does not go through jump hosts yet; choose a directly reachable SSH connection"
	}
	return ""
}

var vaultMaint sync.Mutex

// rotating keeps two rotations of the same entry from running at once.
var rotating sync.Map

// rotateCredential generates a new password and sets it on the target over the
// entry's rotation connection. It returns the result status ("ok" or
// "unverified"); errors are also recorded on the entry and in the audit log.
func (s *Server) rotateCredential(ctx context.Context, credID, why string) (string, error) {
	if _, busy := rotating.LoadOrStore(credID, true); busy {
		return "", errors.New("a rotation of this entry is already running")
	}
	defer rotating.Delete(credID)
	c, err := s.store.GetCredential(ctx, credID)
	if err != nil {
		return "", err
	}
	status, rerr := s.doRotate(ctx, c, why)
	errText := ""
	if rerr != nil {
		status, errText = "failed", truncate(rerr.Error(), 300)
	}
	_ = s.store.SetRotationResult(ctx, c.ID, status, errText)
	details := map[string]any{"why": why, "status": status}
	if errText != "" {
		details["error"] = errText
	}
	s.systemAudit(ctx, "vault.rotate", "credential", c.ID, c.Name, rerr == nil, details)
	return status, rerr
}

func (s *Server) doRotate(ctx context.Context, c *store.Credential, why string) (string, error) {
	if !s.box.Unlocked() {
		return "", secrets.ErrLocked
	}
	if c.RotationConnectionID == nil {
		return "", errors.New("no rotation connection is set")
	}
	if msg := s.rotationTargetProblem(ctx, *c.RotationConnectionID, c.OwnerID); msg != "" {
		return "", errors.New(msg)
	}
	if !vault.ValidAccount(c.Username) {
		return "", errors.New("the entry's username is not a Unix account name")
	}
	conn, err := s.store.GetConnection(ctx, *c.RotationConnectionID)
	if err != nil {
		return "", err
	}
	var settings SSHSettings
	_ = decodeSettings(conn.Settings, &settings)
	if settings.HostKey == "" {
		return "", errors.New("the rotation connection's host key is not pinned yet; connect to it once first")
	}
	addr, err := s.policy.Resolve(ctx, conn.DeviceAddress)
	if err != nil {
		return "", err
	}
	cur, err := s.box.OpenMaterial("credential", c.ID, c.SecretEnc)
	if err != nil {
		return "", err
	}
	// The connection signs in with its own login; if that is this entry, the
	// account changes its own password, otherwise the login sets it with chpasswd.
	loginUser, loginSecret, err := s.connectionCredentials(ctx, conn)
	if err != nil {
		return "", err
	}
	self := loginUser == c.Username && (conn.CredentialID != nil && *conn.CredentialID == c.ID || loginSecret.Password == cur.Password)
	if self {
		loginSecret = cur
	}
	newPW := vault.Generate(s.vaultSettings(ctx).Policy)
	next := cur
	next.Password = newPW

	// Keep the new value before touching the target, so it is never lost.
	attemptID := newUUID()
	act, err := s.box.SealMaterial("credential_version", attemptID, next)
	if err != nil {
		return "", err
	}
	if err := s.store.AddCredentialVersion(ctx, store.CredentialVersion{ID: attemptID, CredentialID: c.ID, SecretEnc: act,
		SecretFields: next.Fields(), Source: "attempt", ActorName: "rotation"}); err != nil {
		return "", err
	}
	client, err := sshhelper.Dial(ctx, sshhelper.Target{Addr: addr, Port: conn.Port, Username: loginUser, Secret: loginSecret,
		HostKey: settings.HostKey, Legacy: settings.AllowLegacyAlgorithms})
	if err != nil {
		_ = s.store.DeleteCredentialVersion(ctx, attemptID)
		return "", fmt.Errorf("sign in to %s: %w", conn.DeviceName, err)
	}
	if self {
		err = sshhelper.ChangeOwnPassword(ctx, client, cur.Password, newPW)
	} else {
		err = sshhelper.SetPassword(ctx, client, c.Username, newPW, loginSecret.Password)
	}
	client.Close()
	if err != nil {
		if errors.Is(err, sshhelper.ErrRotationUncertain) {
			// Keep the attempt in the history: it may be the password now.
			return "", fmt.Errorf("%w (the new value is kept in the entry's history)", err)
		}
		_ = s.store.DeleteCredentialVersion(ctx, attemptID)
		return "", err
	}
	// Changed on the target: make it current.
	ct, err := s.box.SealMaterial("credential", c.ID, next)
	if err != nil {
		return "", err
	}
	if err := s.store.SetCredentialSecret(ctx, c.ID, ct, next.Fields(), strengthOf(next)); err != nil {
		return "", err
	}
	_ = s.store.SetVersionSource(ctx, attemptID, "rotated")
	// Confirm by signing in with the new password.
	check, err := sshhelper.Dial(ctx, sshhelper.Target{Addr: addr, Port: conn.Port, Username: c.Username,
		Secret: secrets.Material{Password: newPW}, HostKey: settings.HostKey, Legacy: settings.AllowLegacyAlgorithms})
	if err != nil {
		slog.Warn("rotated password could not be confirmed by signing in", "entry", c.Name, "error", err)
		return "unverified", nil
	}
	check.Close()
	return "ok", nil
}

func (s *Server) handleRotateVault(w http.ResponseWriter, r *http.Request) {
	e := s.vaultEntry(w, r, store.VaultManage)
	if e == nil {
		return
	}
	if e.Checkout != nil {
		checkoutConflict(w, e.Checkout)
		return
	}
	if e.RotationConnectionID == nil {
		writeError(w, http.StatusBadRequest, "not_configured", "Choose the SSH connection used to change this password first.")
		return
	}
	// A fresh context: the rotation acts for emremote, not as the signed-in user,
	// so it is not held up by the user's own check-out state.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	status, err := s.rotateCredential(ctx, e.ID, "manual by "+userFrom(r.Context()).Username)
	if err != nil {
		writeError(w, http.StatusBadGateway, "rotation_failed", "The password was not changed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

// systemAudit records an event that has no request (background work).
func (s *Server) systemAudit(ctx context.Context, action, targetType, targetID, targetName string, success bool, details map[string]any) {
	e := store.AuditEvent{Action: action, TargetType: targetType, TargetID: targetID, TargetName: truncate(targetName, 200),
		ActorName: "system", Success: success}
	if details != nil {
		e.Details, _ = json.Marshal(details)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.store.InsertAudit(ctx, e); err != nil {
		slog.Error("audit write failed", "action", action, "error", err)
	}
}

// vaultMaintenance runs every minute: expired check-outs are checked in,
// unused approvals expire, and scheduled rotations run.
func (s *Server) vaultMaintenance(ctx context.Context) {
	// Rotations can take a while; never run two passes at once.
	if !vaultMaint.TryLock() {
		return
	}
	defer vaultMaint.Unlock()
	if list, err := s.store.ExpiredCheckouts(ctx); err == nil {
		for _, k := range list {
			if err := s.store.EndCheckout(ctx, k.ID, "expired"); err != nil {
				continue
			}
			s.systemAudit(ctx, "vault.checkin", "credential", k.CredentialID, k.CredentialName, true,
				map[string]any{"checkout_id": k.ID, "holder": k.Username, "expired": true})
			if c, err := s.store.GetCredential(ctx, k.CredentialID); err == nil {
				s.afterCheckin(c, k, "expiry")
			}
		}
	}
	if _, err := s.store.ExpireVaultRequests(ctx); err != nil {
		slog.Warn("expire vault requests", "error", err)
	}
	if !s.box.Unlocked() {
		return
	}
	due, err := s.store.RotationDue(ctx)
	if err != nil {
		slog.Warn("list due rotations", "error", err)
		return
	}
	for _, c := range due {
		if _, err := s.rotateCredential(ctx, c.ID, "schedule"); err != nil {
			_ = s.store.TouchCredential(ctx, c.ID)
			slog.Warn("scheduled rotation failed", "entry", c.Name, "error", err)
		}
	}
}

// ---- Gate for connecting ----

// errVaultCheckout: the connection's saved credential needs a check-out the user does not hold.
type errVaultCheckout struct{ msg string }

func (e errVaultCheckout) Error() string { return e.msg }

// vaultGate decides whether the signed-in user may use a saved credential to
// connect. Background work (no user) is not gated.
func (s *Server) vaultGate(ctx context.Context, c *store.Credential) error {
	u := userFrom(ctx)
	if u == nil || c.AccessPolicy == "open" {
		return nil
	}
	k, err := s.store.OpenCheckout(ctx, c.ID)
	if err != nil {
		return err
	}
	if holdsCheckout(k, u) {
		return nil
	}
	if k != nil {
		return errVaultCheckout{fmt.Sprintf("The saved sign-in %q is checked out by %s until %s UTC.", c.Name, k.Username, k.ExpiresAt.UTC().Format("15:04"))}
	}
	return errVaultCheckout{fmt.Sprintf("The saved sign-in %q is protected by the vault. Check it out under Vault first.", c.Name)}
}

// writeVaultGateError answers a refused or failed credential lookup.
func writeVaultGateError(w http.ResponseWriter, err error) {
	var g errVaultCheckout
	if errors.As(err, &g) {
		writeError(w, http.StatusForbidden, "vault_checkout_required", g.msg)
		return
	}
	writeError(w, http.StatusInternalServerError, "secret_unavailable", err.Error())
}

// ---- Health report ----

type vaultHealth struct {
	Total          int        `json:"total"`
	Weak           []string   `json:"weak"`
	Reused         [][]string `json:"reused"`
	Overdue        []string   `json:"overdue"`
	Old            []string   `json:"old"`
	RotationFailed []string   `json:"rotation_failed"`
	NoSecret       []string   `json:"no_secret"`
	Score          int        `json:"score"`
}

// handleVaultHealth checks the entries the user manages: weak, reused, overdue
// and old passwords, failed rotations. Passwords are compared in memory only.
func (s *Server) handleVaultHealth(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	list, err := s.store.ListVault(r.Context(), u)
	if err != nil {
		writeStoreError(w, r, err, "Vault entry")
		return
	}
	h := vaultHealth{Weak: []string{}, Reused: [][]string{}, Overdue: []string{}, Old: []string{}, RotationFailed: []string{}, NoSecret: []string{}}
	byPassword := map[string][]string{}
	now := time.Now()
	issues := 0
	for _, e := range list {
		if e.Access != store.VaultManage {
			continue
		}
		h.Total++
		bad := false
		if len(e.SecretFields) == 0 {
			if e.Kind != "note" {
				h.NoSecret = append(h.NoSecret, e.ID)
			}
			continue
		}
		if e.PasswordStrength != nil && *e.PasswordStrength <= 1 {
			h.Weak = append(h.Weak, e.ID)
			bad = true
		}
		changed := e.CreatedAt
		if e.SecretChangedAt != nil {
			changed = *e.SecretChangedAt
		}
		age := now.Sub(changed)
		switch {
		case e.RotationIntervalDays > 0 && age > time.Duration(e.RotationIntervalDays)*24*time.Hour:
			h.Overdue = append(h.Overdue, e.ID)
			bad = true
		case e.RotationIntervalDays == 0 && age > 365*24*time.Hour:
			h.Old = append(h.Old, e.ID)
			bad = true
		}
		if e.RotationStatus == "failed" {
			h.RotationFailed = append(h.RotationFailed, e.ID)
			bad = true
		}
		if m, err := s.box.OpenMaterial("credential", e.ID, e.SecretEnc); err == nil && m.Password != "" {
			byPassword[m.Password] = append(byPassword[m.Password], e.ID)
		}
		if bad {
			issues++
		}
	}
	for _, ids := range byPassword {
		if len(ids) > 1 {
			h.Reused = append(h.Reused, ids)
			issues += len(ids)
		}
	}
	clear(byPassword)
	h.Score = 100
	if h.Total > 0 {
		h.Score = max(0, 100-issues*100/h.Total)
	}
	writeJSON(w, http.StatusOK, h)
}
