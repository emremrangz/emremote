import {
  siAlmalinux,
  siDocker,
  siQemu,
  siVirtualbox,
  siVmware,
  siAmazonec2,
  siGooglecloud,
  siPodman,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siNixos,
  siOpensuse,
  siOracle,
  siProxmox,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siTruenas,
  siUbuntu,
  siPfsense,
  siOpnsense,
  siOpenbsd,
  siPopos,
  siCisco,
  siJunipernetworks,
  siMikrotik,
  siHuawei,
  siHp,
  siUbiquiti,
  siFortinet,
  siTplink,
  siNetgear,
  siDell,
} from "simple-icons";
import { Boxes, HardDrive, HelpCircle, Network } from "lucide-react";
import clsx from "clsx";
import { useLayoutEffect, useRef, useState } from "react";
import type { OS } from "@/lib/types";
import { OS_LABELS } from "@/lib/constants";

function Brand({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

// A logo cropped to its drawn area, so wide marks (VMware) fill the space instead of
// sitting small inside a square canvas.
function FitBrand({ path }: { path: string }) {
  const p = useRef<SVGPathElement>(null);
  const [box, setBox] = useState("0 0 24 24");
  useLayoutEffect(() => {
    try {
      const b = p.current?.getBBox();
      if (b && b.width > 0 && b.height > 0) setBox(`${b.x} ${b.y} ${b.width} ${b.height}`);
    } catch {
      /* not measurable: keep the square canvas */
    }
  }, [path]);
  return (
    <svg viewBox={box} className="h-5 w-8" preserveAspectRatio="xMidYMid meet" fill="currentColor" aria-hidden="true">
      <path ref={p} d={path} />
    </svg>
  );
}

// Windows logo drawn as four panes (Microsoft marks are not distributed by simple-icons).
function WindowsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M2 4.6 10 3.5v7.8H2zM11 3.4 22 2v9.3H11zM2 12.4h8v7.9l-8-1.1zM11 12.4h11V22l-11-1.5z" />
    </svg>
  );
}

// Distribution logos, picked from the name the device reports (for example "Rocky Linux 9.4").
const DISTROS: { match: RegExp; icon: { path: string }; color: string; name: string }[] = [
  { match: /ubuntu/, icon: siUbuntu, color: "#e95420", name: "Ubuntu" },
  { match: /rocky/, icon: siRockylinux, color: "#10b981", name: "Rocky Linux" },
  { match: /alma/, icon: siAlmalinux, color: "#3b82f6", name: "AlmaLinux" },
  { match: /centos/, icon: siCentos, color: "#9ccd2a", name: "CentOS" },
  { match: /red ?hat|rhel/, icon: siRedhat, color: "#ee0000", name: "Red Hat" },
  { match: /oracle/, icon: siOracle, color: "#f80000", name: "Oracle Linux" },
  { match: /fedora/, icon: siFedora, color: "#51a2da", name: "Fedora" },
  { match: /kali/, icon: siKalilinux, color: "#557c94", name: "Kali Linux" },
  { match: /raspbian|raspberry/, icon: siRaspberrypi, color: "#c51a4a", name: "Raspberry Pi OS" },
  { match: /mint/, icon: siLinuxmint, color: "#87cf3e", name: "Linux Mint" },
  { match: /pop!?_?os/, icon: siPopos, color: "#48b9c7", name: "Pop!_OS" },
  { match: /proxmox|pve/, icon: siProxmox, color: "#e57000", name: "Proxmox" },
  { match: /truenas/, icon: siTruenas, color: "#0095d5", name: "TrueNAS" },
  { match: /opnsense/, icon: siOpnsense, color: "#d94f00", name: "OPNsense" },
  { match: /pfsense/, icon: siPfsense, color: "#212121", name: "pfSense" },
  { match: /alpine/, icon: siAlpinelinux, color: "#0d597f", name: "Alpine Linux" },
  { match: /\barch/, icon: siArchlinux, color: "#1793d1", name: "Arch Linux" },
  { match: /manjaro/, icon: siManjaro, color: "#35bf5c", name: "Manjaro" },
  { match: /gentoo/, icon: siGentoo, color: "#9d8fd6", name: "Gentoo" },
  { match: /nixos/, icon: siNixos, color: "#5277c3", name: "NixOS" },
  { match: /opensuse|suse/, icon: siOpensuse, color: "#73ba25", name: "openSUSE" },
  { match: /freebsd/, icon: siFreebsd, color: "#ab2b28", name: "FreeBSD" },
  { match: /openbsd/, icon: siOpenbsd, color: "#f2ca30", name: "OpenBSD" },
  { match: /debian/, icon: siDebian, color: "#d70a53", name: "Debian" },
  // Network equipment, picked from the firmware name (for example "Cisco IOS XE 17.6.4").
  { match: /cisco/, icon: siCisco, color: "#049fd9", name: "Cisco" },
  { match: /junos|juniper/, icon: siJunipernetworks, color: "#84b135", name: "Juniper" },
  { match: /mikrotik|routeros/, icon: siMikrotik, color: "#293239", name: "MikroTik" },
  { match: /huawei|vrp/, icon: siHuawei, color: "#cf0a2c", name: "Huawei" },
  { match: /aruba|procurve|hpe/, icon: siHp, color: "#01a982", name: "HPE Aruba" },
  { match: /ubiquiti|edgeos|unifi/, icon: siUbiquiti, color: "#0559c9", name: "Ubiquiti" },
  { match: /fortinet|fortigate|fortios/, icon: siFortinet, color: "#ee3124", name: "Fortinet" },
  { match: /tp-?link/, icon: siTplink, color: "#4acbd6", name: "TP-Link" },
  { match: /netgear/, icon: siNetgear, color: "#9e68d0", name: "Netgear" },
  { match: /dell/, icon: siDell, color: "#0076ce", name: "Dell" },
];

/** Logo and name for what a device runs on (hypervisor or container runtime). */
export function VirtIcon({ platform, kind }: { platform: string; kind: string }) {
  const size = "h-4 w-4";
  const p = platform.toLowerCase();
  const brand = p.includes("vmware")
    ? siVmware
    : p.includes("virtualbox")
      ? siVirtualbox
      : p.includes("kvm") || p.includes("qemu")
        ? siQemu
        : p.includes("docker")
          ? siDocker
          : p.includes("podman")
            ? siPodman
            : p.includes("ec2")
              ? siAmazonec2
              : p.includes("google")
                ? siGooglecloud
                : null;
  if (brand) return <FitBrand path={brand.path} />;
  if (p.includes("hyper-v")) return <WindowsLogo className={size} />;
  return kind === "physical" ? <HardDrive className={size} /> : <Boxes className={size} />;
}

/** The distribution named by an OS description, if it is one we have a logo for. */
export function distroOf(description?: string) {
  const s = (description ?? "").toLowerCase();
  return s ? DISTROS.find((d) => d.match.test(s)) : undefined;
}

const tint: Record<OS, string> = {
  windows: "text-[#3b9cff]",
  macos: "text-fg",
  linux: "text-fg",
  network: "text-accent",
  other: "text-muted",
};

export function OsIcon({ os, className, boxed, distro }: { os: OS; className?: string; boxed?: boolean; /** What the device reports as its system, e.g. "Ubuntu 22.04"; picks the distribution logo. */ distro?: string }) {
  const size = clsx(className ?? "h-4 w-4", "scale-[1.15]");
  const dist = os === "linux" || os === "other" || os === "network" ? distroOf(distro) : undefined;
  const icon = dist ? (
    <Brand path={dist.icon.path} className={size} />
  ) : os === "windows" ? (
    <WindowsLogo className={size} />
  ) : os === "macos" ? (
    <Brand path={siApple.path} className={size} />
  ) : os === "linux" ? (
    <Brand path={siLinux.path} className={size} />
  ) : os === "network" ? (
    <Network className={size} />
  ) : (
    <HelpCircle className={size} />
  );
  const label = dist?.name ?? OS_LABELS[os];
  const style = dist ? { color: dist.color } : undefined;
  if (!boxed)
    return (
      <span className={dist ? undefined : tint[os]} style={style} title={label} role="img" aria-label={label}>
        {icon}
      </span>
    );
  return (
    <span
      className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", !dist && tint[os])}
      style={style}
      title={label}
      role="img"
      aria-label={label}
    >
      {icon}
    </span>
  );
}
