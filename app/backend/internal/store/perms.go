package store

import "slices"

// Permissions a member can hold. Administrators implicitly have all of them,
// plus user management.
const (
	PermConnect     = "sessions.connect"   // open remote desktop and terminal sessions
	PermFiles       = "files.use"          // file manager, transfer drive, server-to-server copy, system overview
	PermQuick       = "quick.connect"      // connect to hosts that are not in the inventory
	PermInventory   = "inventory.manage"   // create and edit their own devices, groups and connections
	PermCredentials = "credentials.manage" // keep their own saved credentials
)

var AllPermissions = []string{PermConnect, PermFiles, PermQuick, PermInventory, PermCredentials}

func ValidPermission(p string) bool { return slices.Contains(AllPermissions, p) }

func (u *User) IsAdmin() bool { return u.Role == "admin" }

// Can reports whether the user holds a permission directly or through the team.
func (u *User) Can(perm string) bool {
	return u.IsAdmin() || slices.Contains(u.Permissions, perm) || slices.Contains(u.TeamPermissions, perm)
}

// EffectivePermissions lists everything the user may do.
func (u *User) EffectivePermissions() []string {
	if u.IsAdmin() {
		return slices.Clone(AllPermissions)
	}
	out := []string{}
	for _, p := range AllPermissions {
		if u.Can(p) {
			out = append(out, p)
		}
	}
	return out
}

// OwnerScope is the owner value for items the user creates: administrators
// manage the shared inventory (NULL); members own what they create.
func (u *User) OwnerScope() *string {
	if u.IsAdmin() {
		return nil
	}
	id := u.ID
	return &id
}
