package sshhelper

import "strings"

// Virtualization describes what a device runs on.
type Virtualization struct {
	// Kind is "vm", "container" or "physical".
	Kind string `json:"kind"`
	// Platform is the hypervisor or container runtime, such as "VMware" or "LXC container".
	Platform string `json:"platform"`
	// Note qualifies a guess that cannot be made certain from inside the guest.
	Note string `json:"note,omitempty"`
	// Hardware is what the device reports as manufacturer and model.
	Hardware string `json:"hardware,omitempty"`
}

var containerNames = map[string]string{
	"lxc": "LXC container", "lxc-libvirt": "LXC container", "docker": "Docker container", "podman": "Podman container",
	"openvz": "OpenVZ container", "systemd-nspawn": "systemd-nspawn container", "rkt": "rkt container", "wsl": "WSL",
	"proot": "proot", "pouch": "Pouch container",
}

// ClassifyVirtualization works out what a device runs on from what it reports:
// virt is systemd-detect-virt's answer (or "vmm"/"none" on macOS), the rest are
// the DMI or WMI manufacturer, model and BIOS vendor. A guest cannot see which
// management product sits on top of its hypervisor, so KVM/QEMU is reported as
// such, with a note when it looks like Proxmox VE.
func ClassifyVirtualization(virt, vendor, product, bios string) *Virtualization {
	virt = strings.ToLower(strings.TrimSpace(virt))
	vendor, product, bios = strings.TrimSpace(vendor), strings.TrimSpace(product), strings.TrimSpace(bios)
	hw := strings.TrimSpace(vendor + " " + product)
	v := &Virtualization{Hardware: hw}
	if name, ok := containerNames[virt]; ok {
		v.Kind, v.Platform = "container", name
		if virt == "lxc" {
			v.Note = "Typical of Proxmox VE containers"
		}
		return v
	}
	all := strings.ToLower(vendor + " " + product + " " + bios)
	platform := ""
	switch {
	case virt == "vmware" || strings.Contains(all, "vmware"):
		platform = "VMware"
	case virt == "microsoft" || (strings.Contains(all, "microsoft") && strings.Contains(all, "virtual machine")):
		platform = "Hyper-V"
	case virt == "oracle" || strings.Contains(all, "virtualbox") || strings.Contains(all, "innotek"):
		platform = "VirtualBox"
	case virt == "kvm" || virt == "qemu" || strings.Contains(all, "qemu") || strings.Contains(all, "kvm"):
		platform = "KVM / QEMU"
		if strings.Contains(strings.ToLower(product), "standard pc") && strings.Contains(strings.ToLower(vendor), "qemu") {
			v.Note = "Proxmox VE uses this setup, but a guest cannot tell it from plain KVM"
		}
	case virt == "xen" || strings.Contains(all, "xen"):
		platform = "Xen"
	case virt == "parallels" || strings.Contains(all, "parallels"):
		platform = "Parallels"
	case virt == "bhyve":
		platform = "bhyve"
	case virt == "apple" || strings.HasPrefix(strings.ToLower(product), "virtualmac"):
		platform = "Apple Virtualization"
	case strings.Contains(all, "amazon ec2") || strings.Contains(all, "amazon"):
		platform = "Amazon EC2"
	case strings.Contains(all, "google compute") || strings.Contains(all, "google"):
		platform = "Google Cloud"
	case strings.Contains(all, "openstack"):
		platform = "OpenStack"
	case virt == "vmm" || (virt != "" && virt != "none"):
		platform = "Virtual machine"
	}
	if platform != "" {
		v.Kind, v.Platform = "vm", platform
		return v
	}
	v.Kind, v.Platform = "physical", "Physical machine"
	return v
}
