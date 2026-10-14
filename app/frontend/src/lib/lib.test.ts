import { sessionProfile, PROFILE_KEYS } from "./sessionProfile";
import { textToKeysyms } from "./clipboard";
import { describe, expect, it } from "vitest";
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
