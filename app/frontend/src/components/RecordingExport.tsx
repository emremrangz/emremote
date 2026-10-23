import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { exportRecordingMp4, type ExportProgress } from "@/lib/recordingExport";
import type { Recording } from "@/lib/types";

const fileName = (r: Recording) => `${r.device_name}-${r.started_at.slice(0, 19).replace(/[T:]/g, "-")}`.replace(/[^A-Za-z0-9._-]+/g, "_") + ".mp4";

/** Makes the MP4 of a recording and saves it. The work happens in this browser tab. */
export function RecordingExport({ recording, onClose }: { recording: Recording | null; onClose: () => void }) {
  return (
    <Dialog open={!!recording} onOpenChange={(o) => !o && onClose()} title="Download as video" description={recording ? `${recording.device_name} / ${recording.connection_name}` : undefined}>
      {recording && <Job key={recording.id} recording={recording} onClose={onClose} />}
    </Dialog>
  );
}

const PHASE = { loading: "Loading the recording…", encoding: "Making the video…", finishing: "Finishing…" } as const;

function Job({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const [progress, setProgress] = useState<ExportProgress>({ done: 0, phase: "loading" });
  const [error, setError] = useState("");
  const [codec, setCodec] = useState("");
  useEffect(() => {
    const ctl = new AbortController();
    exportRecordingMp4(recording.id, recording.protocol, setProgress, ctl.signal)
      .then(({ blob, codec }) => {
        if (ctl.signal.aborted) return;
        setCodec(codec);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName(recording);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "The video could not be made.");
      });
    return () => ctl.abort();
  }, [recording]);
  const done = !!codec;
  return (
    <div className="space-y-4">
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : done ? (
        <p className="text-sm">The video was saved to your downloads ({codec} in an MP4 file).</p>
      ) : (
        <>
          <p className="text-sm text-muted">{PHASE[progress.phase]} The video is made in this browser tab, so keep it open; a long recording takes a while.</p>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(progress.done * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress.done * 100)}%` }} />
          </div>
        </>
      )}
      <div className="flex justify-end">
        <Button onClick={onClose}>{done || error ? "Close" : "Cancel"}</Button>
      </div>
    </div>
  );
}
