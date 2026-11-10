import { describe, expect, it } from "vitest";
import { findInCast, parseCast, playbackTimes, stripEscapes, transcript } from "./cast";
import { keysToSequence, xtermFont, xtermTheme } from "./xterm";
import { K } from "./sessionProfile";

const sample = [
  JSON.stringify({ version: 2, width: 100, height: 30, timestamp: 1, env: { TERM: "xterm-256color" } }),
  JSON.stringify([0.5, "o", "\x1b[32muser@box\x1b[0m:~$ "]),
  JSON.stringify([1.2, "o", "sudo systemctl rest"]),
  JSON.stringify([1.3, "o", "art nginx\r\n"]),
  JSON.stringify([1.4, "r", "120x40"]),
  JSON.stringify([60, "o", "progress 10%\rprogress 100%\r\nab\bc\tx\r\n"]),
  '[61.0, "o", "cut off', // the last line of a recording interrupted by a restart
].join("\n");

describe("terminal recordings", () => {
  it("reads the header and the events, skipping a broken last line", () => {
    const c = parseCast(sample);
    expect(c.width).toBe(100);
    expect(c.height).toBe(30);
    expect(c.events.map((e) => e.kind)).toEqual(["o", "o", "o", "r", "o"]);
    expect(c.events[1].t).toBe(1200);
  });

  it("refuses a file that is not a terminal recording", () => {
    expect(() => parseCast("5.mouse,1.0;")).toThrow();
  });

  it("shortens long pauses only when asked", () => {
    const { events } = parseCast(sample);
    expect(playbackTimes(events, 0)).toEqual([500, 1200, 1300, 1400, 60000]);
    expect(playbackTimes(events, 2000)).toEqual([500, 1200, 1300, 1400, 3400]);
  });

  it("removes colors and other control sequences", () => {
    expect(stripEscapes("\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok \x1b(B\x1b=x")).toBe("red ok x");
  });

  it("turns the output into plain lines like a terminal would show them", () => {
    expect(transcript(parseCast(sample).events)).toBe("user@box:~$ sudo systemctl restart nginx\nprogress 100%\nac      x");
  });

  it("finds a command even when it arrived in two pieces", () => {
    const { events } = parseCast(sample);
    const hits = findInCast(events, "RESTART nginx");
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(2);
    expect(hits[0].context).toContain("sudo systemctl restart nginx");
    // The line is completed from the events that follow.
    expect(findInCast(events, "sudo")[0].context).toBe("user@box:~$ sudo systemctl restart nginx");
    expect(findInCast(events, "")).toEqual([]);
    expect(findInCast(events, "not there")).toEqual([]);
  });
});

describe("built-in terminal helpers", () => {
  it("turns toolbar keys into terminal input", () => {
    expect(keysToSequence([K.Ctrl, "c".charCodeAt(0)])).toBe("\x03");
    expect(keysToSequence([K.Ctrl, "l".charCodeAt(0)])).toBe("\x0c");
    expect(keysToSequence([K.Alt, "b".charCodeAt(0)])).toBe("\x1bb");
    expect(keysToSequence([K.Shift, K.Tab])).toBe("\x1b[Z");
    expect(keysToSequence([K.Escape])).toBe("\x1b");
    expect(keysToSequence([K.Up])).toBe("\x1b[A");
    expect(keysToSequence([K.Shift, "a".charCodeAt(0)])).toBe("A");
    expect(keysToSequence([K.Super])).toBeNull();
  });

  it("builds themes and font lists", () => {
    const t = xtermTheme("dracula");
    expect(t.background).toBe("#282a36");
    expect(t.brightWhite).toBe("#ffffff");
    expect(xtermTheme("no-such-theme").background).toBe("#000000");
    expect(xtermFont("Terminus")).toMatch(/^"Terminus", "JetBrains Mono Variable"/);
    expect(xtermFont("monospace")).toMatch(/^"JetBrains Mono Variable"/);
  });
});
