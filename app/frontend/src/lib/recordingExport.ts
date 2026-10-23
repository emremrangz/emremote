import { loadGuacamole } from "@/lib/guac";

/** The browser cannot make video here (no WebCodecs), so the raw recording is the only download. */
export const canExportVideo = () => typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

const MAX_WIDTH = 1920;
// H.264 first (plays everywhere), VP9 inside the same MP4 when the browser cannot encode H.264.
const CODECS = [
  { codec: "avc1.640028", mux: "avc" },
  { codec: "avc1.4d0028", mux: "avc" },
  { codec: "vp09.00.40.08", mux: "vp9" },
] as const;

export interface ExportProgress {
  /** 0 to 1. */
  done: number;
  phase: "loading" | "encoding" | "finishing";
}

/**
 * Turns a recording into an MP4 in the browser: the recording is replayed with the same display code as the player,
 * each moment is drawn onto a canvas and encoded with the browser's video encoder. Nothing is sent to a server.
 */
export async function exportRecordingMp4(
  id: string,
  protocol: string,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; codec: string }> {
  const [G, { Muxer, ArrayBufferTarget }] = await Promise.all([loadGuacamole(), import("mp4-muxer")]);
  const rec = new G.SessionRecording(new G.StaticHTTPTunnel(`/api/recordings/${id}/file?download=1`), 100);
  const stop = () => {
    try {
      rec.pause();
      rec.disconnect();
      rec.abort();
    } catch {
      /* already closed */
    }
  };
  try {
    onProgress({ done: 0, phase: "loading" });
    await new Promise<void>((resolve, reject) => {
      rec.onload = () => resolve();
      rec.onerror = () => reject(new Error("The recording could not be loaded."));
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      rec.connect();
    });
    const display = rec.getDisplay();
    const duration: number = rec.getDuration();
    // The picture only exists once part of the recording has been replayed; the last moment has its final size.
    await new Promise<void>((res) => rec.seek(duration, () => res()));
    const srcW: number = display.getWidth();
    const srcH: number = display.getHeight();
    if (!srcW || !srcH) throw new Error("The recording has no picture.");
    const scale = Math.min(1, MAX_WIDTH / srcW);
    // Video sizes must be even numbers.
    const w = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const h = Math.max(2, Math.round((srcH * scale) / 2) * 2);
    const fps = protocol === "ssh" || protocol === "telnet" ? 5 : 10;

    let chosen: (typeof CODECS)[number] | null = null;
    for (const c of CODECS) {
      try {
        if ((await VideoEncoder.isConfigSupported({ codec: c.codec, width: w, height: h, bitrate: 2_000_000, framerate: fps })).supported) {
          chosen = c;
          break;
        }
      } catch {
        /* try the next one */
      }
    }
    if (!chosen) throw new Error("This browser cannot encode video. Download the raw recording instead.");

    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: chosen.mux, width: w, height: h, frameRate: fps }, fastStart: "in-memory" });
    let failure: unknown = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        failure = e;
      },
    });
    encoder.configure({ codec: chosen.codec, width: w, height: h, bitrate: 2_000_000, framerate: fps });

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const step = 1000 / fps;
    const frames = Math.max(1, Math.ceil(duration / step) + 1);
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (failure) throw failure;
      const t = Math.min(duration, i * step);
      await new Promise<void>((res) => rec.seek(t, () => res()));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(display.flatten(), 0, 0, w, h);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * step * 1000), duration: Math.round(step * 1000) });
      encoder.encode(frame, { keyFrame: i % (fps * 5) === 0 });
      frame.close();
      // Do not let the encoder queue grow without limit on long recordings.
      while (encoder.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 5));
      if (i % 10 === 0) onProgress({ done: i / frames, phase: "encoding" });
    }
    onProgress({ done: 1, phase: "finishing" });
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), codec: chosen.mux === "avc" ? "H.264" : "VP9" };
  } finally {
    stop();
  }
}
