package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/emremrangz/emremote/internal/store"
)

// ---- Authorization ----
//
// Every authenticated route is wrapped by one of the guards below, so a handler
// only runs once the caller is known to be allowed to touch the thing named in
// the URL. Items a user may not see answer 404 (their existence is not
// revealed); items they can see but not change answer 403.

type need int

const (
	needUse    need = iota // the user can see the item
	needManage             // the user may change it
)

const msgForbidden = "Your account is not allowed to do this."

func forbidden(w http.ResponseWriter, msg string) {
	if msg == "" {
		msg = msgForbidden
	}
	writeError(w, http.StatusForbidden, "forbidden", msg)
}

func (s *Server) adminOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !userFrom(r.Context()).IsAdmin() {
			forbidden(w, "Administrator access is required.")
			return
		}
		h(w, r)
	}
}

func (s *Server) withPerm(perm string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !userFrom(r.Context()).Can(perm) {
			forbidden(w, "")
			return
		}
		h(w, r)
	}
}

// canManageOwner reports whether u may change items belonging to owner
// (nil = shared inventory, managed by administrators; otherwise the owner).
func canManageOwner(u *store.User, owner *string, perm string) bool {
	if owner == nil {
		return u.IsAdmin()
	}
	return *owner == u.ID && u.Can(perm)
}

// sameOwner compares two owner values.
func sameOwner(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// authorizeDevice checks access to a device; it writes the response and returns
// false if the request must stop.
func (s *Server) authorizeDevice(w http.ResponseWriter, r *http.Request, id string, n need, perm string) bool {
	u := userFrom(r.Context())
	visible, owner, err := s.store.DeviceAccess(r.Context(), u.ID, id)
	if err != nil {
		writeStoreError(w, r, err, "Device")
		return false
	}
	if !visible {
		writeError(w, http.StatusNotFound, "not_found", "Device not found")
		return false
	}
	if perm != "" && !u.Can(perm) {
		forbidden(w, "")
		return false
	}
	if n == needManage && !canManageOwner(u, owner, store.PermInventory) {
		if owner == nil {
			forbidden(w, "This device is shared. Only administrators can change it.")
		} else {
			forbidden(w, "")
		}
		return false
	}
	return true
}

// dev guards routes whose {id} is a device.
func (s *Server) dev(n need, perm string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.authorizeDevice(w, r, r.PathValue("id"), n, perm) {
			h(w, r)
		}
	}
}

// conn guards routes whose {id} is a connection (access follows its device).
func (s *Server) conn(n need, perm string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dev, err := s.store.ConnectionDevice(r.Context(), r.PathValue("id"))
		if err != nil {
			writeStoreError(w, r, err, "Connection")
			return
		}
		if s.authorizeDevice(w, r, dev, n, perm) {
			h(w, r)
		}
	}
}

// group guards routes whose {id} is a device group (only owners may change them).
func (s *Server) group(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		owner, err := s.store.GroupOwner(r.Context(), r.PathValue("id"))
		if err != nil {
			writeStoreError(w, r, err, "Group")
			return
		}
		if owner != nil && *owner != u.ID {
			writeError(w, http.StatusNotFound, "not_found", "Group not found")
			return
		}
		if !canManageOwner(u, owner, store.PermInventory) {
			if owner == nil {
				forbidden(w, "This group is shared. Only administrators can change it.")
			} else {
				forbidden(w, "")
			}
			return
		}
		h(w, r)
	}
}

// credential guards routes whose {id} is a saved credential. Credentials are
// private to their owner; shared ones belong to the administrators.
func (s *Server) credential(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		c, err := s.store.GetCredential(r.Context(), r.PathValue("id"))
		if err != nil {
			writeStoreError(w, r, err, "Credential")
			return
		}
		if !sameOwner(c.OwnerID, u.OwnerScope()) {
			writeError(w, http.StatusNotFound, "not_found", "Credential not found")
			return
		}
		if !u.Can(store.PermCredentials) {
			forbidden(w, "")
			return
		}
		h(w, r)
	}
}

// getDevice reads a device for the signed-in user (favorite and last-opened are theirs).
func (s *Server) getDevice(ctx context.Context, id string) (*store.Device, error) {
	return s.store.GetDevice(ctx, userFrom(ctx).ID, id)
}

// groupUsable reports whether a group may hold devices of the given owner:
// shared devices go in shared groups, a member's devices in the member's groups.
func (s *Server) groupUsable(ctx context.Context, groupID string, owner *string) bool {
	g, err := s.store.GroupOwner(ctx, groupID)
	if err != nil {
		return false
	}
	return sameOwner(g, owner)
}

var errNotAllowed = errors.New("not allowed")
