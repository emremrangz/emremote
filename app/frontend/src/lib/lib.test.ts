import { sessionProfile, PROFILE_KEYS } from "./sessionProfile";
import { textToKeysyms } from "./clipboard";
import { describe, expect, it } from "vitest";
import { clusterPoints, project, unproject } from "./worldMap";
import { searchCities } from "./cities";
import { distroOf } from "../components/OsIcon";
import { duration, relativeTime } from "./format";
import { statusMessage } from "./guac";
import { deviceReachability } from "../components/Status";
import type { ConnectionSummary } from "./types";

const conn = (reachable: boolean | null): ConnectionSummary => ({
  id: "c",
  device_id: "d",
  name: "RDP",
  protocol: "rdp",
  port: 3389,
  last_used_at: null,
  status_reachable: reachable,
  status_checked_at: reachable === null ? null : new Date().toISOString(),
  status_detail: "",
});

describe("format", () => {
  it("formats durations", () => {
    expect(duration(5)).toBe("5s");
    expect(duration(125)).toBe("2m 5s");
    expect(duration(3725)).toBe("1h 2m");
  });
  it("formats relative time", () => {
    expect(relativeTime(null)).toBe("Never");
    expect(relativeTime(new Date(Date.now() - 10_000).toISOString())).toBe("just now");
  });
});

describe("status", () => {
  it("never claims reachability without a successful probe", () => {
    expect(deviceReachability({ connections: [] })).toBe("none");
    expect(deviceReachability({ connections: [conn(null)] })).toBe("unknown");
    expect(deviceReachability({ connections: [conn(false)] })).toBe("unreachable");
    expect(deviceReachability({ connections: [conn(true), conn(false)] })).toBe("partial");
    expect(deviceReachability({ connections: [conn(true)] })).toBe("reachable");
  });
  it("maps guacamole status codes", () => {
    expect(statusMessage(0x0301).title).toMatch(/Authentication failed/);
    expect(statusMessage(0x0207, "rdp").hint).toMatch(/certificate/);
    expect(statusMessage(0x9999).title).toBe("The connection failed.");
  });
});

describe("session profiles", () => {
  it("picks the profile from protocol and OS", () => {
    expect(sessionProfile("ssh", "macos")).toBe("terminal");
    expect(sessionProfile("telnet", "other")).toBe("terminal");
    expect(sessionProfile("rdp", "windows")).toBe("windows");
    expect(sessionProfile("rdp", "other")).toBe("windows");
    expect(sessionProfile("vnc", "macos")).toBe("mac");
    expect(sessionProfile("rdp", "linux")).toBe("linux");
    expect(sessionProfile("vnc", "other")).toBe("linux");
  });
  it("offers only keys that exist on the remote side", () => {
    const all = (p: keyof typeof PROFILE_KEYS) => JSON.stringify(PROFILE_KEYS[p]);
    expect(all("terminal")).not.toMatch(/Win|Ctrl\+Alt\+Del|⌘/);
    expect(all("mac")).not.toMatch(/Win|Ctrl\+Alt\+Del/);
    expect(all("linux")).not.toMatch(/"Win/);
    expect(all("windows")).not.toMatch(/⌘/);
  });
});

describe("textToKeysyms", () => {
  it("maps ASCII, Latin-1, Unicode and newlines", () => {
    expect(textToKeysyms("a\nç€")).toEqual([0x61, 0xff0d, 0xe7, 0x010020ac]);
    expect(textToKeysyms("x\r\ny")).toEqual([0x78, 0xff0d, 0x79]);
  });
});

import { describeKey, keyFileProblem } from "../components/KeyFileInput";

describe("key files", () => {
  const body = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----";
  it("accepts private keys and names their kind", () => {
    expect(keyFileProblem(body)).toBeNull();
    expect(describeKey(body)).toEqual({ kind: "RSA key (PEM)", encrypted: false });
    expect(describeKey("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----").kind).toBe("OpenSSH key");
    expect(describeKey("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB\n\nxx\n-----END RSA PRIVATE KEY-----").encrypted).toBe(true);
  });
  it("explains why a file is not a usable private key", () => {
    expect(keyFileProblem("ssh-ed25519 AAAAC3Nz user@host")).toMatch(/public key/);
    expect(keyFileProblem("PuTTY-User-Key-File-3: ssh-rsa")).toMatch(/PuTTYgen/);
    expect(keyFileProblem("hello")).toMatch(/does not look like a private key/);
    expect(keyFileProblem("")).toMatch(/empty/);
    expect(keyFileProblem("A".repeat(40000))).toMatch(/too large/);
  });
});


describe("world map", () => {
  it("projects and back", () => {
    const [x, y] = project(41.01, 28.98);
    expect(x).toBeCloseTo(208.98);
    expect(y).toBeCloseTo(42.99);
    const [lat, lon] = unproject(x, y);
    expect(lat).toBeCloseTo(41.01);
    expect(lon).toBeCloseTo(28.98);
  });

  it("groups nearby servers and keeps far ones apart", () => {
    const pts = [
      { lat: 50.11, lon: 8.68, item: "frankfurt" },
      { lat: 52.37, lon: 4.9, item: "amsterdam" },
      { lat: 48.86, lon: 2.35, item: "paris" },
      { lat: 19.08, lon: 72.88, item: "mumbai" },
      { lat: 40.71, lon: -74.01, item: "new-york" },
    ];
    const c = clusterPoints(pts);
    expect(c.length).toBe(3);
    const europe = c.find((x) => x.items.includes("frankfurt"))!;
    expect(europe.items.sort()).toEqual(["amsterdam", "frankfurt", "paris"]);
    expect(c.find((x) => x.items.includes("mumbai"))!.items).toEqual(["mumbai"]);
  });

  it("gives the same clusters whatever the input order", () => {
    const pts = [
      { lat: 50, lon: 8, item: "a" },
      { lat: 52, lon: 5, item: "b" },
      { lat: -33, lon: 151, item: "c" },
    ];
    const one = clusterPoints(pts).map((c) => c.items.sort());
    const two = clusterPoints([...pts].reverse()).map((c) => c.items.sort());
    expect(two.sort()).toEqual(one.sort());
  });

  it("finds cities without caring about accents or case", () => {
    expect(searchCities("istan")[0][0]).toBe("Istanbul");
    expect(searchCities("IZMIR")[0][0]).toBe("Izmir");
    expect(searchCities("mumbai")[0][1]).toBe("India");
    expect(searchCities("zzzzz")).toEqual([]);
    expect(searchCities("")).toEqual([]);
  });
});

describe("operating system logos", () => {
  it("shows Proxmox, not Debian, for a Proxmox host", () => {
    expect(distroOf("Proxmox VE 9.0.3 (Debian GNU/Linux 13 (trixie))")?.name).toBe("Proxmox");
    expect(distroOf("Debian GNU/Linux 13 (trixie)")?.name).toBe("Debian");
    expect(distroOf("Ubuntu 24.04.5 LTS")?.name).toBe("Ubuntu");
  });
});
