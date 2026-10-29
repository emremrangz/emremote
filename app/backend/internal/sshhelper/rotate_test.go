package sshhelper

import "testing"

func TestNextPrompt(t *testing.T) {
	// Debian / shadow-utils
	debian := "Changing password for svc.\nCurrent password: \n"
	if k, n := nextPrompt(debian, 0); k != promptCurrent || n != 1 {
		t.Fatalf("debian current: %v %d", k, n)
	}
	if k, _ := nextPrompt(debian, 1); k != promptNone {
		t.Fatalf("answered prompt seen again: %v", k)
	}
	debian += "New password: \n"
	if k, n := nextPrompt(debian, 1); k != promptNew || n != 2 {
		t.Fatalf("debian new: %v %d", k, n)
	}
	debian += "Retype new password: \n"
	if k, n := nextPrompt(debian, 2); k != promptNew || n != 3 {
		t.Fatalf("debian retype: %v %d", k, n)
	}
	// BusyBox
	bb := "Changing password for svc\nOld password:\nNew password:\nRetype password:\n"
	want := []promptKind{promptCurrent, promptNew, promptNew}
	for i, w := range want {
		if k, _ := nextPrompt(bb, i); k != w {
			t.Fatalf("busybox prompt %d: %v", i, k)
		}
	}
	// RHEL: "(current) UNIX password:"
	if k, _ := nextPrompt("(current) UNIX password: ", 0); k != promptCurrent {
		t.Fatal("rhel current")
	}
	// Text that merely mentions passwords is not a prompt.
	if k, _ := nextPrompt("passwd: password updated successfully\n", 0); k != promptNone {
		t.Fatal("success line taken for a prompt")
	}
}

func TestPasswdReason(t *testing.T) {
	out := "Current password: \nNew password: \nBAD PASSWORD: The password is shorter than 8 characters\npasswd: Authentication token manipulation error\n"
	if got := passwdReason(out); got != "BAD PASSWORD: The password is shorter than 8 characters" {
		t.Fatalf("got %q", got)
	}
}
