package api

import (
	"encoding/json"
	"net/http"
)

// cloneRequest is a new device (the same fields as creating one) plus what to take over from the original.
type cloneRequest struct {
	deviceRequest
	// CopyConnections takes over the connection methods (default true); CopySecrets also the saved sign-ins (default true).
	CopyConnections *bool `json:"copy_connections"`
	CopySecrets     *bool `json:"copy_secrets"`
}

// cleanClonedSettings removes what belongs to the original machine: its pinned SSH host key and RDP certificate
// (the clone learns its own on first connect), and the jump host when the clone does not share the original's owner.
func cleanClonedSettings(raw json.RawMessage, keepJump bool) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return raw
	}
	delete(m, "host_key")
	delete(m, "cert_fingerprints")
	if !keepJump {
		delete(m, "jump_connection_id")
	}
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

// handleCloneDevice creates a new device from an existing one. The new device belongs to the person cloning
// (the shared inventory for administrators, their own otherwise), exactly as if they had added it by hand.
//
// Saved passwords and keys are only taken over when the original and the clone have the same owner. Otherwise a
// member could clone a shared device, point the copy at a server of their own and receive the shared password there.
func (s *Server) handleCloneDevice(w http.ResponseWriter, r *http.Request) {
	srcID := r.PathValue("id")
	src, err := s.getDevice(r.Context(), srcID)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	var req cloneRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, in := req.deviceRequest.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	u := userFrom(r.Context())
	if !s.groupsUsable(r.Context(), in.GroupIDs, u.OwnerScope()) {
		v.fail("group_ids", "A group does not exist")
		writeValidation(w, v)
		return
	}
	// A clone is a different machine: nothing that identifies the original carries over.
	in.MAC, in.WOLBroadcast = nil, nil
	d, err := s.store.CreateDevice(r.Context(), u.ID, u.OwnerScope(), in)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return
	}
	d.CanManage = true

	copyConns := req.CopyConnections == nil || *req.CopyConnections
	copySecrets := req.CopySecrets == nil || *req.CopySecrets
	scopeMatches := sameOwner(src.OwnerID, d.OwnerID)
	copied, withSecrets := 0, 0
	skipped := []string{}
	if copyConns {
		conns, err := s.store.ListConnections(r.Context(), u.ID, srcID)
		if err != nil {
			writeStoreError(w, r, err, "Connection")
			return
		}
		for _, c := range conns {
			cr := connectionRequest{
				Name: c.Name, Protocol: c.Protocol, Port: c.Port, Username: c.Username, Domain: c.Domain,
				Settings: cleanClonedSettings(c.Settings, scopeMatches),
			}
			secretCopied := false
			if scopeMatches {
				cr.CredentialID = c.CredentialID
				if copySecrets && len(c.SecretEnc) > 0 {
					if m, err := s.box.OpenMaterial("connection", c.ID, c.SecretEnc); err == nil && !m.Empty() {
						cr.Secret = &secretInput{Mode: "set", Password: m.Password, PrivateKey: m.PrivateKey, Passphrase: m.Passphrase}
						secretCopied = true
					}
				}
			}
			cv, cin, change, m := s.validateConnection(r.Context(), d.OwnerID, "", d.Address, cr)
			if !cv.ok() {
				skipped = append(skipped, c.Name)
				continue
			}
			var seal func(string) ([]byte, []string, error)
			if change && !m.Empty() {
				seal = func(id string) ([]byte, []string, error) {
					ct, err := s.box.SealMaterial("connection", id, m)
					return ct, m.Fields(), err
				}
			}
			if _, err := s.store.CreateConnection(r.Context(), d.ID, cin, seal); err != nil {
				skipped = append(skipped, c.Name)
				continue
			}
			copied++
			if secretCopied && change && !m.Empty() {
				withSecrets++
			}
		}
	}
	s.audit(r, "device.clone", "device", d.ID, d.Name, true, map[string]any{
		"from_device_id": srcID, "from_name": src.Name, "address": d.Address, "connections": copied, "with_saved_secrets": withSecrets, "skipped": len(skipped),
	})
	full, err := s.store.GetDevice(r.Context(), u.ID, d.ID)
	if err == nil {
		full.CanManage = true
		d = full
	}
	go s.checkDeviceAsync(d.ID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"device": d, "connections_copied": copied, "secrets_copied": withSecrets, "skipped": skipped,
		"secrets_not_copied": copySecrets && !scopeMatches,
	})
}
