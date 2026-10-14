package api

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/emremrangz/emremote/internal/auth"
	"github.com/emremrangz/emremote/internal/store"
)

// ---- Users and teams (administrators only) ----
//
// A member sees their own inventory plus the part of the shared inventory
// they were given (everything, selected devices and groups, or nothing). What
// they may do comes from their own permissions plus those of their team.

var inventoryModes = []string{"none", "selected", "all"}

// accessRequest is the part of a user or team that decides what they can reach.
type accessRequest struct {
	Permissions   []string `json:"permissions"`
	InventoryMode string   `json:"inventory_mode"`
	DeviceIDs     []string `json:"device_ids"`
	GroupIDs      []string `json:"group_ids"`
}

// validate checks permissions, mode and grants. Grants only apply in "selected" mode.
func (s *Server) validateAccess(ctx context.Context, v *validator, a accessRequest) (perms []string, mode string, grants store.Grants) {
	perms = []string{}
	for _, p := range a.Permissions {
		if !store.ValidPermission(p) {
			v.fail("permissions", "Unknown permission: "+truncate(p, 40))
			continue
		}
		if !slices.Contains(perms, p) {
			perms = append(perms, p)
		}
	}
	mode = v.oneOf("inventory_mode", a.InventoryMode, inventoryModes...)
	grants = store.Grants{DeviceIDs: []string{}, GroupIDs: []string{}}
	if mode != "selected" {
		return
	}
	uniq := func(field string, in []string, max int) []string {
		out := []string{}
		for _, id := range in {
			id = strings.ToLower(strings.TrimSpace(id))
			if !validUUID(id) {
				v.fail(field, "Invalid identifier")
				continue
			}
			if !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
		if len(out) > max {
			v.fail(field, "Too many items selected")
		}
		return out
	}
	grants.DeviceIDs = uniq("device_ids", a.DeviceIDs, 2000)
	grants.GroupIDs = uniq("group_ids", a.GroupIDs, 500)
	if v.ok() {
		if ok, err := s.store.AllShared(ctx, grants); err != nil || !ok {
			v.fail("device_ids", "Only existing shared devices and groups can be granted")
		}
	}
	return
}

// revokeRemoteAccess ends a user's live remote sessions, file sessions and
// transfers (they stay signed in), so that an access change applies at once.
func (s *Server) revokeRemoteAccess(ctx context.Context, userID string) {
	list, err := s.store.ListUserSessions(ctx, userID)
	if err != nil {
		slog.Error("list sessions to revoke remote access", "error", err)
		return
	}
	for _, sess := range list {
		s.endBrowserSession(sess.ID)
	}
}

// signOutEverywhere deletes all of a user's browser sessions and what they opened.
func (s *Server) signOutEverywhere(ctx context.Context, userID string) int {
	ids, err := s.store.DeleteUserSessions(ctx, userID, "")
	if err != nil {
		slog.Error("sign user out", "error", err)
		return 0
	}
	for _, id := range ids {
		s.endBrowserSession(id)
	}
	return len(ids)
}

func (s *Server) userRow(ctx context.Context, id string) (*store.UserRow, error) {
	rows, err := s.store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		if rows[i].ID == id {
			return &rows[i], nil
		}
	}
	return nil, store.ErrNotFound
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.ListUsers(r.Context())
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

type userRequest struct {
	accessRequest
	Role   string  `json:"role"`
	TeamID *string `json:"team_id"`
}

type createUserRequest struct {
	userRequest
	Username string `json:"username"`
	Password string `json:"password"`
}

type updateUserRequest struct {
	userRequest
	Disabled bool `json:"disabled"`
}

// userInput validates the shared part of create and update.
func (s *Server) userInput(ctx context.Context, v *validator, req userRequest) store.UserInput {
	role := v.oneOf("role", req.Role, "admin", "member")
	perms, mode, grants := s.validateAccess(ctx, v, req.accessRequest)
	team := v.optionalUUID("team_id", req.TeamID)
	if team != nil {
		if _, err := s.store.GetTeam(ctx, *team); err != nil {
			v.fail("team_id", "Team does not exist")
		}
	}
	if role == "admin" {
		// Administrators can do everything; their access settings do not apply.
		return store.UserInput{Role: role, Permissions: []string{}, InventoryMode: "all", Grants: store.Grants{DeviceIDs: []string{}, GroupIDs: []string{}}}
	}
	return store.UserInput{Role: role, TeamID: team, Permissions: perms, InventoryMode: mode, Grants: grants}
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	username := v.username("username", req.Username)
	v.password("password", req.Password)
	in := s.userInput(r.Context(), v, req.userRequest)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	if _, ok := s.box.DEK(); !ok {
		writeError(w, http.StatusServiceUnavailable, "vault_locked", "Saved passwords are locked. Sign in again.")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	user, err := s.store.CreateUser(r.Context(), username, hash, in)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	// Give the new user their own wrapped copy of the data key, protected by their password.
	if err := s.rewrapVault(r.Context(), user.ID, req.Password); err != nil {
		slog.Error("wrap vault for new user", "error", err)
		_ = s.store.DeleteUser(r.Context(), user.ID, false)
		writeStoreError(w, r, err, "Vault")
		return
	}
	s.audit(r, "user.create", "user", user.ID, user.Username, true, map[string]any{
		"role": user.Role, "inventory_mode": user.InventoryMode, "permissions": user.Permissions, "team_id": user.TeamID,
		"granted_devices": len(in.Grants.DeviceIDs), "granted_groups": len(in.Grants.GroupIDs),
	})
	row, err := s.userRow(r.Context(), user.ID)
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

// guardAdminChange refuses changes that would lock everyone out of administration.
func (s *Server) guardAdminChange(w http.ResponseWriter, r *http.Request, target *store.User, stillActiveAdmin bool) bool {
	if target.IsAdmin() && !target.Disabled && !stillActiveAdmin {
		n, err := s.store.CountActiveAdmins(r.Context(), target.ID)
		if err != nil {
			writeStoreError(w, r, err, "user")
			return false
		}
		if n == 0 {
			writeError(w, http.StatusConflict, "last_admin", "At least one active administrator is required.")
			return false
		}
	}
	return true
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	me := userFrom(r.Context())
	before, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	var req updateUserRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	in := s.userInput(r.Context(), v, req.userRequest)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	if id == me.ID && (in.Role != before.Role || req.Disabled) {
		writeError(w, http.StatusConflict, "self_change", "You cannot change your own role or disable your own account.")
		return
	}
	if !s.guardAdminChange(w, r, before, in.Role == "admin" && !req.Disabled) {
		return
	}
	updated, err := s.store.UpdateUser(r.Context(), id, in)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	if req.Disabled != before.Disabled {
		if err := s.store.SetUserDisabled(r.Context(), id, req.Disabled); err != nil {
			writeStoreError(w, r, err, "User")
			return
		}
	}
	changed := []string{}
	if before.Role != updated.Role {
		changed = append(changed, "role")
	}
	if !slices.Equal(before.Permissions, updated.Permissions) {
		changed = append(changed, "permissions")
	}
	if before.InventoryMode != updated.InventoryMode {
		changed = append(changed, "inventory_mode")
	}
	if (before.TeamID == nil) != (updated.TeamID == nil) || (before.TeamID != nil && *before.TeamID != *updated.TeamID) {
		changed = append(changed, "team")
	}
	if req.Disabled != before.Disabled {
		changed = append(changed, "disabled")
	}
	changed = append(changed, "access")
	s.audit(r, "user.update", "user", updated.ID, updated.Username, true, map[string]any{
		"changed": changed, "role": updated.Role, "inventory_mode": updated.InventoryMode, "disabled": req.Disabled,
		"granted_devices": len(in.Grants.DeviceIDs), "granted_groups": len(in.Grants.GroupIDs),
	})
	// Access changes take effect immediately: running sessions are closed.
	if req.Disabled {
		s.signOutEverywhere(r.Context(), id)
	} else {
		s.revokeRemoteAccess(r.Context(), id)
	}
	row, err := s.userRow(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == userFrom(r.Context()).ID {
		writeError(w, http.StatusConflict, "self_change", "You cannot delete your own account.")
		return
	}
	target, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	if !s.guardAdminChange(w, r, target, false) {
		return
	}
	keep := r.URL.Query().Get("keep_inventory") == "true"
	rows, _ := s.userRow(r.Context(), id)
	s.signOutEverywhere(r.Context(), id)
	if err := s.store.DeleteUser(r.Context(), id, keep); err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	details := map[string]any{"role": target.Role, "inventory_kept": keep}
	if rows != nil {
		details["owned_devices"] = rows.OwnedDevices
	}
	s.audit(r, "user.delete", "user", target.ID, target.Username, true, details)
	w.WriteHeader(http.StatusNoContent)
}

// handleResetUserPassword sets a new password for another user (their saved-password
// key is re-protected with it) and signs them out.
func (s *Server) handleResetUserPassword(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == userFrom(r.Context()).ID {
		writeError(w, http.StatusConflict, "self_change", "Change your own password under Settings.")
		return
	}
	target, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	var req struct {
		NewPassword string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	v.password("new_password", req.NewPassword)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	if err := s.rewrapVault(r.Context(), id, req.NewPassword); err != nil {
		writeStoreError(w, r, err, "Vault")
		return
	}
	if err := s.store.UpdatePassword(r.Context(), id, hash); err != nil {
		writeStoreError(w, r, err, "user")
		return
	}
	n := s.signOutEverywhere(r.Context(), id)
	s.audit(r, "user.password_reset", "user", target.ID, target.Username, true, map[string]any{"revoked_sessions": n})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSignOutUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	target, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "User")
		return
	}
	if id == userFrom(r.Context()).ID {
		writeError(w, http.StatusConflict, "self_change", "Use Settings to sign out your other sessions.")
		return
	}
	n := s.signOutEverywhere(r.Context(), id)
	s.audit(r, "user.sign_out", "user", target.ID, target.Username, true, map[string]any{"revoked_sessions": n})
	writeJSON(w, http.StatusOK, map[string]int{"revoked": n})
}

// ---- Teams ----

type teamRequest struct {
	accessRequest
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) teamInput(ctx context.Context, v *validator, req teamRequest) store.TeamInput {
	name := v.text("name", req.Name, true, 64, false)
	desc := v.text("description", req.Description, false, 500, false)
	perms, mode, grants := s.validateAccess(ctx, v, req.accessRequest)
	return store.TeamInput{Name: name, Description: desc, Permissions: perms, InventoryMode: mode, Grants: grants}
}

func (s *Server) handleListTeams(w http.ResponseWriter, r *http.Request) {
	teams, err := s.store.ListTeams(r.Context())
	if err != nil {
		writeStoreError(w, r, err, "team")
		return
	}
	writeJSON(w, http.StatusOK, teams)
}

func (s *Server) handleCreateTeam(w http.ResponseWriter, r *http.Request) {
	var req teamRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	in := s.teamInput(r.Context(), v, req)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	t, err := s.store.CreateTeam(r.Context(), in)
	if err != nil {
		writeStoreError(w, r, err, "Team")
		return
	}
	s.audit(r, "team.create", "team", t.ID, t.Name, true, map[string]any{"permissions": t.Permissions, "inventory_mode": t.InventoryMode})
	writeJSON(w, http.StatusCreated, t)
}

// revokeTeam closes the live remote access of every member of a team.
func (s *Server) revokeTeam(ctx context.Context, teamID string) {
	ids, err := s.store.UserIDsOfTeam(ctx, teamID)
	if err != nil {
		return
	}
	for _, id := range ids {
		s.revokeRemoteAccess(ctx, id)
	}
}

func (s *Server) handleUpdateTeam(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.store.GetTeam(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Team")
		return
	}
	var req teamRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v := newValidator()
	in := s.teamInput(r.Context(), v, req)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	t, err := s.store.UpdateTeam(r.Context(), id, in)
	if err != nil {
		writeStoreError(w, r, err, "Team")
		return
	}
	s.audit(r, "team.update", "team", t.ID, t.Name, true, map[string]any{"permissions": t.Permissions, "inventory_mode": t.InventoryMode, "members": t.MemberCount})
	s.revokeTeam(r.Context(), id)
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleDeleteTeam(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	t, err := s.store.GetTeam(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Team")
		return
	}
	members, _ := s.store.UserIDsOfTeam(r.Context(), id)
	if err := s.store.DeleteTeam(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Team")
		return
	}
	for _, uid := range members {
		s.revokeRemoteAccess(r.Context(), uid)
	}
	s.audit(r, "team.delete", "team", t.ID, t.Name, true, map[string]any{"members": t.MemberCount})
	w.WriteHeader(http.StatusNoContent)
}
