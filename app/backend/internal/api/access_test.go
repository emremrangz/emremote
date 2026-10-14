package api

import (
	"testing"

	"github.com/emremrangz/emremote/internal/store"
)

func TestPermissionsAndOwnership(t *testing.T) {
	admin := &store.User{ID: "a", Role: "admin"}
	member := &store.User{ID: "m", Role: "member", Permissions: []string{store.PermConnect}, TeamPermissions: []string{store.PermFiles}}
	other := "someone-else"
	mine := "m"

	if !admin.Can(store.PermQuick) || admin.OwnerScope() != nil {
		t.Fatal("administrators can do everything and manage the shared inventory")
	}
	if !member.Can(store.PermConnect) || !member.Can(store.PermFiles) || member.Can(store.PermInventory) {
		t.Fatal("effective permissions are the user's own plus the team's")
	}
	if got := member.EffectivePermissions(); len(got) != 2 {
		t.Fatalf("effective permissions: %v", got)
	}
	if o := member.OwnerScope(); o == nil || *o != "m" {
		t.Fatal("members own what they create")
	}

	// Shared items (nil owner): only administrators change them.
	if !canManageOwner(admin, nil, store.PermInventory) || canManageOwner(member, nil, store.PermInventory) {
		t.Fatal("shared items belong to administrators")
	}
	// Own items need the permission; other people's items are never manageable.
	if canManageOwner(member, &mine, store.PermInventory) {
		t.Fatal("managing own items still needs the permission")
	}
	member.Permissions = append(member.Permissions, store.PermInventory)
	if !canManageOwner(member, &mine, store.PermInventory) || canManageOwner(member, &other, store.PermInventory) {
		t.Fatal("members manage exactly their own items")
	}
	if !sameOwner(nil, nil) || sameOwner(nil, &mine) || !sameOwner(&mine, &mine) {
		t.Fatal("owner comparison")
	}
}
