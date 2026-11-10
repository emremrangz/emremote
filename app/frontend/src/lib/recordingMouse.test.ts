import { describe, expect, it } from "vitest";
import { activity, readMouseTrack, upperBound } from "./recordingMouse";

// A few instructions in the gateway's own format, as written to a recording.
const sample =
  "4.size,1.0,4.1280,3.720;" +
  "4.sync,9.211787615,1.0;" +
  "5.mouse,3.684,3.163,1.0,9.211787647;" +
  "5.mouse,3.690,3.170,1.1,9.211787700;" + // left button down
  "5.mouse,3.690,3.170,1.1,9.211787750;" + // still down: not a second click
  "5.mouse,3.690,3.170,1.0,9.211787800;" + // released
  "4.sync,9.211788615,1.0;" +
  "5.mouse,3.700,3.180,1.4,9.211788700;" + // right button down
  "9.clipboard,1.0,10.5.mouse,x;"; // text that only looks like an instruction

describe("readMouseTrack", () => {
  it("reads positions and clicks relative to the first sync", async () => {
    const t = await readMouseTrack(new Blob([sample]));
    expect(t.t).toEqual([32, 85, 135, 185, 1085]);
    expect(t.x).toEqual([684, 690, 690, 690, 700]);
    expect(t.clicks).toEqual([
      { t: 85, x: 690, y: 170, button: "left" },
      { t: 1085, x: 700, y: 180, button: "right" },
    ]);
    expect(t.truncated).toBe(false);
  });

  it("copes with a recording without pointer events", async () => {
    const t = await readMouseTrack(new Blob(["4.sync,9.211787615,1.0;3.img,1.1,1.0;"]));
    expect(t.t).toEqual([]);
    expect(t.clicks).toEqual([]);
  });

  it("finds instructions that are cut between two pieces", async () => {
    const big = sample.repeat(2000);
    const t = await readMouseTrack(new Blob([big]));
    expect(t.t.length).toBe(5 * 2000);
    expect(t.clicks.length).toBe(2 * 2000);
  });
});

describe("pointer helpers", () => {
  it("finds the last sample at or before a time", () => {
    expect(upperBound([10, 20, 30], 5)).toBe(0);
    expect(upperBound([10, 20, 30], 20)).toBe(2);
    expect(upperBound([10, 20, 30], 99)).toBe(3);
  });

  it("scales activity so the busiest slice is 1", () => {
    const a = activity({ t: [0, 1, 2, 60], x: [], y: [], clicks: [], truncated: false }, 100, 2);
    expect(a).toEqual([1, 1 / 3]);
  });
});
