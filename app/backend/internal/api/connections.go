package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/emremrangz/emremote/internal/netpolicy"
	"github.com/emremrangz/emremote/internal/rdpcert"
	"github.com/emremrangz/emremote/internal/secrets"
	"github.com/emremrangz/emremote/internal/sshkey"
	"github.com/emremrangz/emremote/internal/store"
	"github.com/emremrangz/emremote/internal/vault"
)

// secretInput is write-only secret material in requests.
//
//	mode "keep"  (default) leaves stored secrets unchanged
//	mode "set"   replaces stored secrets with the supplied fields
//	mode "merge" (vault entries) replaces only the supplied, non-empty fields
//	mode "clear" removes stored secrets
type secretInput struct {
	Mode       string `json:"mode"`
	Password   string `json:"password"`
	PrivateKey string `json:"private_key"`
	Passphrase string `json:"passphrase"`
	// Vault entries only.
	Token string `json:"token"`
	Note  string `json:"note"`
	TOTP  string `json:"totp"`
}

func (in *secretInput) validate(v *validator, allowKey bool) (change bool, m secrets.Material) {
	return in.validateWith(v, allowKey, false)
}

func (in *secretInput) validateWith(v *validator, allowKey, allowVault bool) (change bool, m secrets.Material) {
	if in == nil || in.Mode == "" || in.Mode == "keep" {
		return false, m
	}
	switch in.Mode {
	case "clear":
		return true, m
	case "set":
	case "merge":
		if !allowVault {
			v.fail("secret.mode", "Must be keep, set or clear")
			return false, m
		}
	default:
		v.fail("secret.mode", "Must be keep, set or clear")
		return false, m
	}
	if !allowVault && (in.Token != "" || in.Note != "" || in.TOTP != "") {
		v.fail("secret", "Tokens, notes and one-time codes belong to vault entries")
		return false, m
	}
	if len(in.Token) > 8192 || strings.ContainsRune(in.Token, 0) {
		v.fail("secret.token", "Token is too long (8 KB at most) or contains invalid characters")
	}
	if len(in.Note) > 16384 || strings.ContainsRune(in.Note, 0) {
		v.fail("secret.note", "Note is too long (16 KB at most)")
	}
	totp := ""
	if strings.TrimSpace(in.TOTP) != "" {
		var err error
		if totp, err = vault.ParseTOTP(in.TOTP); err != nil {
			v.fail("secret.totp", "One-time code secret "+err.Error())
		}
	}
	if len(in.Password) > 1024 || strings.ContainsRune(in.Password, 0) {
		v.fail("secret.password", "Password is too long or contains invalid characters")
	}
	if len(in.Passphrase) > 1024 || strings.ContainsRune(in.Passphrase, 0) {
		v.fail("secret.passphrase", "Passphrase is too long or contains invalid characters")
	}
	key := strings.TrimSpace(in.PrivateKey)
	if key != "" {
		if !allowKey {
			v.fail("secret.private_key", "Private keys are only supported for SSH")
		} else if normal, err := checkPrivateKey(in.PrivateKey, in.Passphrase); err != nil {
			v.fail("secret.private_key", err.Error())
		} else {
			key = normal
		}
	}
	return true, secrets.Material{Password: in.Password, PrivateKey: key, Passphrase: in.Passphrase, Token: in.Token, Note: in.Note, TOTP: totp}
}

type connectionRequest struct {
	Name         string          `json:"name"`
	Protocol     string          `json:"protocol"`
	Port         int             `json:"port"`
	Username     string          `json:"username"`
	Domain       string          `json:"domain"`
	CredentialID *string         `json:"credential_id"`
	Settings     json.RawMessage `json:"settings"`
	Secret       *secretInput    `json:"secret"`
}

// validateConnection checks a connection request. owner is the owner of the
// device (or, for quick connections, of the user): a saved credential can only
// be linked when it has the same owner, so nobody can aim a shared password at
// a host of their choosing.
func (s *Server) validateConnection(ctx context.Context, owner *string, selfID, deviceAddr string, req connectionRequest) (*validator, store.ConnectionInput, bool, secrets.Material) {
	v := newValidator()
	in := store.ConnectionInput{
		Protocol: v.oneOf("protocol", req.Protocol, "rdp", "vnc", "ssh", "telnet"),
		Port:     req.Port,
		Username: v.text("username", req.Username, false, 256, false),
		Domain:   v.text("domain", req.Domain, false, 256, false),
	}
	in.Name = v.text("name", req.Name, false, 128, false)
	if in.Name == "" {
		in.Name = strings.ToUpper(req.Protocol)
	}
	if in.Port == 0 {
		in.Port = DefaultPort(req.Protocol)
	}
	if in.Port < 1 || in.Port > 65535 {
		v.fail("port", "Must be between 1 and 65535")
	}
	if in.Protocol != "rdp" && in.Domain != "" {
		v.fail("domain", "Domain only applies to RDP")
	}
	in.CredentialID = v.optionalUUID("credential_id", req.CredentialID)
	if in.CredentialID != nil {
		if cred, err := s.store.GetCredential(ctx, *in.CredentialID); err != nil || !sameOwner(cred.OwnerID, owner) {
			v.fail("credential_id", "Credential does not exist")
		}
	}
	if v.ok() {
		in.Settings = normalizeSettings(v, in.Protocol, req.Settings)
	}
	if v.ok() {
		s.validateJump(ctx, v, in.Settings, owner, selfID, deviceAddr)
	}
	change, m := req.Secret.validate(v, in.Protocol == "ssh")
	return v, in, change, m
}

func (s *Server) handleListConnections(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	list, err := s.store.ListConnections(r.Context(), u.ID, "")
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	markConnections(u, list)
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleListDeviceConnections(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	u := userFrom(r.Context())
	if _, err := s.getDevice(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	list, err := s.store.ListConnections(r.Context(), u.ID, id)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	markConnections(u, list)
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleGetConnection(w http.ResponseWriter, r *http.Request) {
	c, err := s.store.GetConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	markConnections(userFrom(r.Context()), []*store.Connection{c})
	writeJSON(w, http.StatusOK, c)
}

func markConnections(u *store.User, list []*store.Connection) {
	for _, c := range list {
		c.CanManage = canManageOwner(u, c.DeviceOwnerID, store.PermInventory)
	}
}

func (s *Server) handleCreateConnection(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	device, err := s.getDevice(r.Context(), deviceID)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	var req connectionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, in, change, m := s.validateConnection(r.Context(), device.OwnerID, "", device.Address, req)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	var seal func(string) ([]byte, []string, error)
	if change && !m.Empty() {
		seal = func(id string) ([]byte, []string, error) {
			ct, err := s.box.SealMaterial("connection", id, m)
			return ct, m.Fields(), err
		}
	}
	c, err := s.store.CreateConnection(r.Context(), deviceID, in, seal)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	s.audit(r, "connection.create", "connection", c.ID, device.Name+" / "+c.Name, true, map[string]any{
		"device_id": device.ID, "protocol": c.Protocol, "port": c.Port, "stored_secrets": c.SecretFields,
	})
	markConnections(userFrom(r.Context()), []*store.Connection{c})
	writeJSON(w, http.StatusCreated, c)
	go s.checkDeviceAsync(deviceID)
}

func (s *Server) handleUpdateConnection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	before, err := s.store.GetConnection(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	var req connectionRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, in, change, m := s.validateConnection(r.Context(), before.DeviceOwnerID, id, before.DeviceAddress, req)
	if in.Protocol != before.Protocol && v.ok() {
		v.fail("protocol", "Protocol cannot be changed; create a new connection instead")
	}
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	c, err := s.store.UpdateConnection(r.Context(), id, in)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	if change {
		ct, err := s.box.SealMaterial("connection", id, m)
		if err == nil {
			err = s.store.SetConnectionSecret(r.Context(), id, ct, m.Fields())
		}
		if err != nil {
			writeStoreError(w, r, err, "Connection")
			return
		}
		c, err = s.store.GetConnection(r.Context(), id)
		if err != nil {
			writeStoreError(w, r, err, "Connection")
			return
		}
	}
	if change || before.Port != c.Port || !jsonEqual(string(before.Settings), string(c.Settings)) {
		s.access.closeConnection(c.ID)
	}
	details := map[string]any{"changed": changedConnectionFields(before, c, change)}
	s.audit(r, "connection.update", "connection", c.ID, c.DeviceName+" / "+c.Name, true, details)
	markConnections(userFrom(r.Context()), []*store.Connection{c})
	writeJSON(w, http.StatusOK, c)
	if before.Port != c.Port {
		go s.checkDeviceAsync(c.DeviceID)
	}
}

func changedConnectionFields(a, b *store.Connection, secretChanged bool) []string {
	out := []string{}
	if a.Name != b.Name {
		out = append(out, "name")
	}
	if a.Port != b.Port {
		out = append(out, "port")
	}
	if a.Username != b.Username {
		out = append(out, "username")
	}
	if a.Domain != b.Domain {
		out = append(out, "domain")
	}
	if (a.CredentialID == nil) != (b.CredentialID == nil) || (a.CredentialID != nil && *a.CredentialID != *b.CredentialID) {
		out = append(out, "credential")
	}
	var x, y map[string]any
	_ = json.Unmarshal(a.Settings, &x)
	_ = json.Unmarshal(b.Settings, &y)
	for k, vb := range y {
		if va, ok := x[k]; !ok || !jsonEqual(va, vb) {
			out = append(out, "settings."+k)
		}
	}
	if secretChanged {
		out = append(out, "secret")
	}
	return out
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func (s *Server) handleDeleteConnection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c, err := s.store.GetConnection(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	if n := s.jumpUsers(r.Context(), id); n > 0 {
		writeError(w, http.StatusConflict, "jump_in_use", fmt.Sprintf("This connection is the jump host of %d other connection(s). Change or remove those first.", n))
		return
	}
	s.tunnels.terminateConnection(id)
	s.access.closeConnection(id)
	if err := s.store.DeleteConnection(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	s.audit(r, "connection.delete", "connection", c.ID, c.DeviceName+" / "+c.Name, true, map[string]any{"protocol": c.Protocol})
	w.WriteHeader(http.StatusNoContent)
}

// resolveTarget applies the network policy to a connection's device address.
func (s *Server) resolveTarget(w http.ResponseWriter, r *http.Request, c *store.Connection) (ok bool, addr netip.Addr) {
	a, err := s.policy.Resolve(r.Context(), c.DeviceAddress)
	if err != nil {
		code := "target_unresolvable"
		if errors.Is(err, netpolicy.ErrNotAllowed) {
			code = "target_not_allowed"
		}
		writeError(w, http.StatusUnprocessableEntity, code, err.Error())
		return false, addr
	}
	return true, a
}

func (s *Server) handleFetchRDPCertificate(w http.ResponseWriter, r *http.Request) {
	c, err := s.store.GetConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	if c.Protocol != "rdp" {
		writeError(w, http.StatusBadRequest, "bad_request", "Certificate retrieval is only available for RDP connections")
		return
	}
	ok, addr := s.resolveTarget(w, r, c)
	if !ok {
		return
	}
	cert, err := rdpcert.Fetch(r.Context(), addr, c.Port)
	if err != nil {
		writeError(w, http.StatusBadGateway, "certificate_unavailable", "Could not retrieve certificate: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cert)
}

func (s *Server) handleFetchSSHHostKey(w http.ResponseWriter, r *http.Request) {
	c, err := s.store.GetConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	if c.Protocol != "ssh" {
		writeError(w, http.StatusBadRequest, "bad_request", "Host key retrieval is only available for SSH connections")
		return
	}
	ok, addr := s.resolveTarget(w, r, c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var hs SSHSettings
	_ = decodeSettings(c.Settings, &hs)
	key, err := sshkey.Fetch(ctx, addr, c.Port, hs.AllowLegacyAlgorithms)
	if err != nil {
		writeError(w, http.StatusBadGateway, "host_key_unavailable", "Could not retrieve host key: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, key)
}

// ---- Credentials ----

type credentialRequest struct {
	Name     string       `json:"name"`
	Username string       `json:"username"`
	Domain   string       `json:"domain"`
	Secret   *secretInput `json:"secret"`
	// Vault settings; a field left out keeps its current value (or the default).
	Kind                 *string   `json:"kind"`
	Folder               *string   `json:"folder"`
	Tags                 *[]string `json:"tags"`
	URL                  *string   `json:"url"`
	Description          *string   `json:"description"`
	RevealPolicy         *string   `json:"reveal_policy"`
	AccessPolicy         *string   `json:"access_policy"`
	MaxCheckoutMinutes   *int      `json:"max_checkout_minutes"`
	BreakGlass           *bool     `json:"break_glass"`
	RotationConnectionID *string   `json:"rotation_connection_id"`
	RotateAfterCheckin   *bool     `json:"rotate_after_checkin"`
	RotationIntervalDays *int      `json:"rotation_interval_days"`
}

func (s *Server) handleListCredentials(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	list, err := s.store.ListCredentials(r.Context(), u.OwnerScope())
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	for _, c := range list {
		c.CanManage = u.Can(store.PermCredentials)
	}
	writeJSON(w, http.StatusOK, list)
}

// newVaultFields are the settings of a new entry before the request applies its own.
func newVaultFields() store.VaultFields {
	return store.VaultFields{Kind: "login", Tags: []string{}, RevealPolicy: "allowed", AccessPolicy: "open", MaxCheckoutMinutes: 60, BreakGlass: true}
}

// validate checks the request against the entry's owner; cur holds the current
// settings (or the defaults for a new entry) and is updated in place.
func (s *Server) validateCredential(ctx context.Context, req *credentialRequest, owner *string, cur *store.VaultFields) (*validator, bool, secrets.Material) {
	v := newValidator()
	req.Name = v.text("name", req.Name, true, 128, false)
	req.Username = v.text("username", req.Username, false, 256, false)
	req.Domain = v.text("domain", req.Domain, false, 256, false)
	change, m := req.Secret.validateWith(v, true, true)
	if req.Kind != nil {
		cur.Kind = v.oneOf("kind", *req.Kind, "login", "ssh_key", "api_token", "note")
	}
	if req.Folder != nil {
		cur.Folder = strings.Trim(v.text("folder", *req.Folder, false, 128, false), "/ ")
	}
	if req.Tags != nil {
		cur.Tags = v.tags("tags", *req.Tags)
	}
	if req.URL != nil {
		cur.URL = v.text("url", *req.URL, false, 512, false)
		if low := strings.ToLower(cur.URL); cur.URL != "" && !strings.HasPrefix(low, "https://") && !strings.HasPrefix(low, "http://") {
			v.fail("url", "Must start with https:// or http://")
		}
	}
	if req.Description != nil {
		cur.Description = v.text("description", *req.Description, false, 1000, true)
	}
	if req.RevealPolicy != nil {
		cur.RevealPolicy = v.oneOf("reveal_policy", *req.RevealPolicy, "allowed", "never")
	}
	if req.AccessPolicy != nil {
		cur.AccessPolicy = v.oneOf("access_policy", *req.AccessPolicy, "open", "exclusive", "approval")
	}
	if owner != nil && cur.AccessPolicy != "open" {
		v.fail("access_policy", "Check-outs and approvals are for shared entries; your own entries are always open to you")
	}
	if req.MaxCheckoutMinutes != nil {
		cur.MaxCheckoutMinutes = *req.MaxCheckoutMinutes
		if cur.MaxCheckoutMinutes < 5 || cur.MaxCheckoutMinutes > 1440 {
			v.fail("max_checkout_minutes", "Must be between 5 minutes and 24 hours")
		}
	}
	if req.BreakGlass != nil {
		cur.BreakGlass = *req.BreakGlass
	}
	if req.RotateAfterCheckin != nil {
		cur.RotateAfterCheckin = *req.RotateAfterCheckin
	}
	if req.RotationIntervalDays != nil {
		cur.RotationIntervalDays = *req.RotationIntervalDays
		if cur.RotationIntervalDays < 0 || cur.RotationIntervalDays > 3650 {
			v.fail("rotation_interval_days", "Must be between 0 (never) and 3650 days")
		}
	}
	if req.RotationConnectionID != nil {
		if *req.RotationConnectionID == "" {
			cur.RotationConnectionID = nil
		} else {
			cur.RotationConnectionID = v.optionalUUID("rotation_connection_id", req.RotationConnectionID)
		}
	}
	if cur.RotationConnectionID != nil {
		if msg := s.rotationTargetProblem(ctx, *cur.RotationConnectionID, owner); msg != "" {
			v.fail("rotation_connection_id", msg)
		}
		if cur.Kind != "login" {
			v.fail("rotation_connection_id", "Only sign-in entries (username and password) can be rotated")
		}
		if !vault.ValidAccount(req.Username) {
			v.fail("username", "Rotation needs a Unix account name (letters, digits, . _ -)")
		}
	} else if cur.RotateAfterCheckin {
		v.fail("rotate_after_checkin", "Choose the SSH connection used to change the password first")
	}
	return v, change, m
}

func (s *Server) handleCreateCredential(w http.ResponseWriter, r *http.Request) {
	var req credentialRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	u := userFrom(r.Context())
	owner := u.OwnerScope()
	vf := newVaultFields()
	v, _, m := s.validateCredential(r.Context(), &req, owner, &vf)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	vf.PasswordStrength = strengthOf(m)
	var versionCT []byte
	versionID := newUUID()
	c, err := s.store.CreateCredential(r.Context(), owner, req.Name, req.Username, req.Domain, vf, func(id string) ([]byte, []string, error) {
		ct, err := s.box.SealMaterial("credential", id, m)
		if err == nil && !m.Empty() {
			versionCT, err = s.box.SealMaterial("credential_version", versionID, m)
		}
		return ct, m.Fields(), err
	})
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	if versionCT != nil {
		s.addVersion(r.Context(), c.ID, versionID, versionCT, m.Fields(), "saved", u.Username)
	}
	c.CanManage = true
	s.audit(r, "credential.create", "credential", c.ID, c.Name, true, map[string]any{"stored_secrets": c.SecretFields,
		"kind": c.Kind, "access_policy": c.AccessPolicy, "reveal_policy": c.RevealPolicy})
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleUpdateCredential(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	old, err := s.store.GetCredential(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	var req credentialRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	vf := old.VaultFields
	v, change, m := s.validateCredential(r.Context(), &req, old.OwnerID, &vf)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	if change && req.Secret.Mode == "merge" {
		cur, err := s.box.OpenMaterial("credential", id, old.SecretEnc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "secret_unavailable", "The stored secret could not be decrypted, so it cannot be merged. Replace it instead.")
			return
		}
		m = mergeMaterial(cur, m)
	}
	c, err := s.store.UpdateCredential(r.Context(), id, req.Name, req.Username, req.Domain, vf)
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	if change {
		if err := s.replaceCredentialSecret(r.Context(), c, m, "saved", userFrom(r.Context()).Username); err != nil {
			writeStoreError(w, r, err, "Credential")
			return
		}
		if c, err = s.store.GetCredential(r.Context(), id); err != nil {
			writeStoreError(w, r, err, "Credential")
			return
		}
	}
	c.CanManage = true
	s.audit(r, "credential.update", "credential", c.ID, c.Name, true, map[string]any{"secret_changed": change,
		"changed": credentialChanges(old, c)})
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteCredential(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c, err := s.store.GetCredential(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	if k, _ := s.store.OpenCheckout(r.Context(), id); k != nil {
		writeError(w, http.StatusConflict, "checked_out", "This entry is checked out by "+k.Username+". Check it in first.")
		return
	}
	if err := s.store.DeleteCredential(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	s.audit(r, "credential.delete", "credential", c.ID, c.Name, true, map[string]any{"connections_affected": c.UsageCount})
	w.WriteHeader(http.StatusNoContent)
}

// credentialChanges names the vault settings that differ (for the audit log).
func credentialChanges(a, b *store.Credential) []string {
	out := []string{}
	add := func(name string, changed bool) {
		if changed {
			out = append(out, name)
		}
	}
	add("name", a.Name != b.Name)
	add("username", a.Username != b.Username)
	add("domain", a.Domain != b.Domain)
	add("kind", a.Kind != b.Kind)
	add("folder", a.Folder != b.Folder)
	add("tags", strings.Join(a.Tags, ",") != strings.Join(b.Tags, ","))
	add("url", a.URL != b.URL)
	add("description", a.Description != b.Description)
	add("reveal_policy", a.RevealPolicy != b.RevealPolicy)
	add("access_policy", a.AccessPolicy != b.AccessPolicy)
	add("max_checkout_minutes", a.MaxCheckoutMinutes != b.MaxCheckoutMinutes)
	add("break_glass", a.BreakGlass != b.BreakGlass)
	add("rotation_connection", !sameOwner(a.RotationConnectionID, b.RotationConnectionID))
	add("rotate_after_checkin", a.RotateAfterCheckin != b.RotateAfterCheckin)
	add("rotation_interval_days", a.RotationIntervalDays != b.RotationIntervalDays)
	return out
}

// handleSetKeyboardLayout lets anyone who can open a connection pick the keyboard
// layout used for it (the toolbar offers this). Nothing else about the
// connection changes, so it is safe on shared connections.
func (s *Server) handleSetKeyboardLayout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ServerLayout string `json:"server_layout"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	c, err := s.store.GetConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	if c.Protocol != "rdp" {
		writeError(w, http.StatusBadRequest, "bad_request", "Only RDP connections have a keyboard layout")
		return
	}
	v := newValidator()
	v.oneOf("server_layout", req.ServerLayout, append([]string{"auto"}, keyboardLayouts...)...)
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	var settings map[string]any
	_ = json.Unmarshal(c.Settings, &settings)
	if settings == nil {
		settings = map[string]any{}
	}
	settings["server_layout"] = req.ServerLayout
	raw, _ := json.Marshal(settings)
	if err := s.store.UpdateConnectionSettings(r.Context(), c.ID, raw); err != nil {
		writeStoreError(w, r, err, "Connection")
		return
	}
	s.audit(r, "connection.update", "connection", c.ID, c.DeviceName+" / "+c.Name, true, map[string]any{"changed": []string{"settings.server_layout"}})
	c.Settings = raw
	markConnections(userFrom(r.Context()), []*store.Connection{c})
	writeJSON(w, http.StatusOK, c)
}
