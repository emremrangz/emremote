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
)

// secretInput is write-only secret material in requests.
//
//	mode "keep"  (default) leaves stored secrets unchanged
//	mode "set"   replaces stored secrets with the supplied fields
//	mode "clear" removes stored secrets
type secretInput struct {
	Mode       string `json:"mode"`
	Password   string `json:"password"`
	PrivateKey string `json:"private_key"`
	Passphrase string `json:"passphrase"`
}

func (in *secretInput) validate(v *validator, allowKey bool) (change bool, m secrets.Material) {
	if in == nil || in.Mode == "" || in.Mode == "keep" {
		return false, m
	}
	switch in.Mode {
	case "clear":
		return true, m
	case "set":
	default:
		v.fail("secret.mode", "Must be keep, set or clear")
		return false, m
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
	return true, secrets.Material{Password: in.Password, PrivateKey: key, Passphrase: in.Passphrase}
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

func (req credentialRequest) validate() (*validator, bool, secrets.Material, credentialRequest) {
	v := newValidator()
	req.Name = v.text("name", req.Name, true, 128, false)
	req.Username = v.text("username", req.Username, false, 256, false)
	req.Domain = v.text("domain", req.Domain, false, 256, false)
	change, m := req.Secret.validate(v, true)
	return v, change, m, req
}

func (s *Server) handleCreateCredential(w http.ResponseWriter, r *http.Request) {
	var req credentialRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, _, m, req := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	c, err := s.store.CreateCredential(r.Context(), userFrom(r.Context()).OwnerScope(), req.Name, req.Username, req.Domain, func(id string) ([]byte, []string, error) {
		ct, err := s.box.SealMaterial("credential", id, m)
		return ct, m.Fields(), err
	})
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	c.CanManage = true
	s.audit(r, "credential.create", "credential", c.ID, c.Name, true, map[string]any{"stored_secrets": c.SecretFields})
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleUpdateCredential(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.store.GetCredential(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	var req credentialRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, change, m, req := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	c, err := s.store.UpdateCredential(r.Context(), id, req.Name, req.Username, req.Domain)
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	if change {
		ct, err := s.box.SealMaterial("credential", id, m)
		if err == nil {
			err = s.store.SetCredentialSecret(r.Context(), id, ct, m.Fields())
		}
		if err == nil {
			c, err = s.store.GetCredential(r.Context(), id)
		}
		if err != nil {
			writeStoreError(w, r, err, "Credential")
			return
		}
	}
	c.CanManage = true
	s.audit(r, "credential.update", "credential", c.ID, c.Name, true, map[string]any{"secret_changed": change})
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteCredential(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c, err := s.store.GetCredential(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	if err := s.store.DeleteCredential(r.Context(), id); err != nil {
		writeStoreError(w, r, err, "Credential")
		return
	}
	s.audit(r, "credential.delete", "credential", c.ID, c.Name, true, map[string]any{"connections_affected": c.UsageCount})
	w.WriteHeader(http.StatusNoContent)
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
