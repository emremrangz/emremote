import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Select } from "@/components/ui/Select";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, ArrowLeftRight, CheckCircle2, AlertCircle, X, Ban, Server } from "lucide-react";
import { useDevices } from "@/hooks/queries";
import { useSSHAccess } from "@/hooks/useSSHAccess";
import { PageHeader, EmptyState } from "@/components/ui/misc";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { FileBrowser } from "@/components/FileBrowser";
import { SSHAccessGate } from "@/components/SSHAccessGate";
import { OsIcon } from "@/components/OsIcon";
import { del, errorMessage, get, post } from "@/lib/api";
import { bytes } from "@/lib/format";
import type { Device } from "@/lib/types";

type EndpointRef = { kind: "ssh"; access_id: string } | { kind: "drive"; device_id: string };

interface CopyJob {
  id: string;
  status: "scanning" | "copying" | "done" | "failed" | "cancelled";
  source: string;
  destination: string;
  target_dir: string;
  total_files: number;
  total_bytes: number;
  done_files: number;
  done_bytes: number;
  skipped: number;
  current: string;
  error?: string;
  started_at: string;
  finished_at?: string;
}

interface PaneState {
  ref: EndpointRef | null;
  path: string;
  selection: string[];
}

interface Option {
  value: string; // "ssh:<connection id>" or "drive:<device id>"
  label: string;
  device: Device;
}

const running = (j: CopyJob) => j.status === "scanning" || j.status === "copying";

function endpointOptions(devices: Device[]): Option[] {
  const out: Option[] = [];
  for (const d of [...devices].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const c of d.connections) {
      if (c.protocol === "ssh") out.push({ value: `ssh:${c.id}`, label: c.name === "SSH" ? `${d.name} (SFTP)` : `${d.name} / ${c.name} (SFTP)`, device: d });
    }
    if (d.connections.some((c) => c.protocol === "rdp")) out.push({ value: `drive:${d.id}`, label: `${d.name} (RDP transfer drive)`, device: d });
  }
  return out;
}

function loadChoice(side: string) {
  try {
    return localStorage.getItem(`emremote.transfer.${side}`) ?? "";
  } catch {
    return "";
  }
}

function saveChoice(side: string, v: string) {
  try {
    localStorage.setItem(`emremote.transfer.${side}`, v);
  } catch {
    /* ignore */
  }
}

/** One side of the transfer page: a server picker and its file browser. */
function Pane({
  side,
  title,
  options,
  onChange,
  refreshKey,
}: {
  side: "source" | "destination";
  title: string;
  options: Option[];
  onChange: (s: PaneState) => void;
  refreshKey: number;
}) {
  const [choice, setChoice] = useState(() => {
    const saved = loadChoice(side);
    return options.some((o) => o.value === saved) ? saved : "";
  });
  const opt = options.find((o) => o.value === choice);
  const pick = (v: string) => {
    setChoice(v);
    saveChoice(side, v);
    onChange({ ref: null, path: "", selection: [] });
  };

  return (
    <section className="card flex min-h-[460px] min-w-0 flex-col overflow-hidden" aria-label={title}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-subtle">{title}</span>
        <div className="relative min-w-0 flex-1">
          <Select className="input h-8 py-0 text-sm" value={choice} onChange={(e) => pick(e.target.value)} aria-label={`${title} server`}>
            <option value="">Choose a server…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {opt && <OsIcon os={opt.device.os} distro={opt.device.facts?.os} />}
      </div>
      <div className="min-h-0 flex-1">
        {!opt ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center text-sm text-muted">
            <Server className="mb-3 h-6 w-6 text-subtle" />
            Choose the {side} server above.
          </div>
        ) : opt.value.startsWith("ssh:") ? (
          <SSHPane key={opt.value} connectionId={opt.value.slice(4)} onChange={onChange} refreshKey={refreshKey} />
        ) : (
          <BrowserPane key={opt.value} endpoint={{ kind: "drive", device_id: opt.device.id }} base={`/api/devices/${opt.device.id}/transfer`} onChange={onChange} refreshKey={refreshKey} />
        )}
      </div>
    </section>
  );
}

function SSHPane({ connectionId, onChange, refreshKey }: { connectionId: string; onChange: (s: PaneState) => void; refreshKey: number }) {
  const { state, open, expired } = useSSHAccess(connectionId);
  return (
    <SSHAccessGate compact state={state} onSubmitCredentials={open} onRetry={() => open()}>
      {(id) => (
        <BrowserPane
          key={id}
          endpoint={{ kind: "ssh", access_id: id }}
          base={`/api/ssh-access/${id}/files`}
          onExpired={expired}
          onChange={onChange}
          refreshKey={refreshKey}
        />
      )}
    </SSHAccessGate>
  );
}

function BrowserPane({
  endpoint,
  base,
  onExpired,
  onChange,
  refreshKey,
}: {
  endpoint: EndpointRef;
  base: string;
  onExpired?: () => void;
  onChange: (s: PaneState) => void;
  refreshKey: number;
}) {
  const state = useRef<PaneState>({ ref: endpoint, path: "", selection: [] });
  const emit = useCallback((p: Partial<PaneState>) => {
    state.current = { ...state.current, ...p };
    onChange(state.current);
  }, [onChange]);
  const onPath = useCallback((path: string) => emit({ path }), [emit]);
  const onSelection = useCallback((selection: string[]) => emit({ selection }), [emit]);
  useEffect(() => () => onChange({ ref: null, path: "", selection: [] }), [onChange]);
  return <FileBrowser compact base={base} onExpired={onExpired} onPathChange={onPath} onSelectionChange={onSelection} refreshKey={refreshKey} />;
}

function JobRow({ job, onCancel }: { job: CopyJob; onCancel: () => void }) {
  const pct = job.total_bytes > 0 ? Math.min(100, Math.round((job.done_bytes / job.total_bytes) * 100)) : job.status === "done" ? 100 : 0;
  const icon =
    job.status === "done" ? (
      <CheckCircle2 className="h-4 w-4 text-success" />
    ) : job.status === "failed" ? (
      <AlertCircle className="h-4 w-4 text-danger" />
    ) : job.status === "cancelled" ? (
      <Ban className="h-4 w-4 text-subtle" />
    ) : (
      <Spinner className="h-4 w-4 text-muted" />
    );
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{job.source}</span>
          <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-subtle" />
          <span className="font-medium">{job.destination}</span>
          <span className="ml-2 font-mono text-2xs text-subtle">{job.target_dir}</span>
        </p>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div
            className={clsx("h-full rounded-full transition-[width]", job.status === "failed" ? "bg-danger" : job.status === "done" ? "bg-success" : "bg-primary")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1 truncate text-xs text-subtle">
          {job.status === "scanning"
            ? "Scanning…"
            : `${job.done_files} of ${job.total_files} files · ${bytes(job.done_bytes)} of ${bytes(job.total_bytes)}`}
          {job.skipped > 0 && ` · ${job.skipped} skipped (already there)`}
          {running(job) && job.current && <span className="ml-1 font-mono">· {job.current}</span>}
          {job.status === "cancelled" && " · Cancelled"}
        </p>
        {job.error && job.status === "failed" && <p className="mt-1 break-words text-xs text-danger">{job.error}</p>}
      </div>
      {running(job) && (
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onCancel}>
          Cancel
        </Button>
      )}
    </li>
  );
}

export default function TransferPage() {
  const devices = useDevices();
  const toast = useToast();
  const qc = useQueryClient();
  const options = useMemo(() => endpointOptions(devices.data ?? []), [devices.data]);
  const [src, setSrc] = useState<PaneState>({ ref: null, path: "", selection: [] });
  const [dst, setDst] = useState<PaneState>({ ref: null, path: "", selection: [] });
  const [conflict, setConflict] = useState<"skip" | "overwrite">("skip");
  const [refresh, setRefresh] = useState({ source: 0, destination: 0 });
  const [busy, setBusy] = useState(false);
  const seenDone = useRef<Set<string>>(new Set());

  const jobs = useQuery({
    queryKey: ["copy-jobs"],
    queryFn: () => get<CopyJob[]>("/api/copy-jobs"),
    refetchInterval: (q) => ((q.state.data ?? []).some(running) ? 1000 : 10_000),
  });

  // Refresh both panes when a copy finishes.
  useEffect(() => {
    let changed = false;
    for (const j of jobs.data ?? []) {
      if (!running(j) && !seenDone.current.has(j.id)) {
        seenDone.current.add(j.id);
        changed = true;
      }
    }
    if (changed) setRefresh((r) => ({ source: r.source + 1, destination: r.destination + 1 }));
  }, [jobs.data]);

  const onSrc = useCallback((s: PaneState) => setSrc(s), []);
  const onDst = useCallback((s: PaneState) => setDst(s), []);

  const copy = async (from: PaneState, to: PaneState) => {
    if (!from.ref || !to.ref || from.selection.length === 0 || !to.path) return;
    setBusy(true);
    try {
      const j = await post<CopyJob>("/api/copy-jobs", {
        source: from.ref,
        destination: to.ref,
        paths: from.selection,
        dir: to.path,
        on_conflict: conflict,
      });
      seenDone.current.delete(j.id);
      await qc.invalidateQueries({ queryKey: ["copy-jobs"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await del(`/api/copy-jobs/${id}`);
      await qc.invalidateQueries({ queryKey: ["copy-jobs"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const canRight = !!src.ref && !!dst.ref && src.selection.length > 0 && !!dst.path;
  const canLeft = !!src.ref && !!dst.ref && dst.selection.length > 0 && !!src.path;

  if (!devices.isLoading && options.length === 0) {
    return (
      <>
        <PageHeader title="SFTP transfer" />
        <div className="card">
          <EmptyState icon={<ArrowLeftRight className="h-5 w-5" />} title="No servers with file access yet">
            Add a device with an SSH method (for SFTP) or an RDP method (for its transfer drive), then come back to copy files between servers.
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="SFTP transfer"
        description="Copy files and folders directly from one server to another. Data streams through emremote; nothing is stored on it or sent through your browser."
      />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Pane side="source" title="Source" options={options} onChange={onSrc} refreshKey={refresh.source} />
        <div className="flex flex-row items-center justify-center gap-2 lg:flex-col">
          <Button
            variant="primary"
            icon={<ArrowRight className="h-4 w-4" />}
            disabled={!canRight || busy}
            onClick={() => copy(src, dst)}
            title={canRight ? `Copy ${src.selection.length} item(s) to ${dst.path}` : "Select items on the source side"}
          >
            Copy
          </Button>
          <Button
            icon={<ArrowLeft className="h-4 w-4" />}
            disabled={!canLeft || busy}
            onClick={() => copy(dst, src)}
            title={canLeft ? `Copy ${dst.selection.length} item(s) to ${src.path}` : "Select items on the destination side"}
          >
            Copy back
          </Button>
          <label className="flex flex-col gap-1 text-2xs text-subtle lg:mt-3">
            If a file exists
            <Select className="input h-8 py-0 text-xs" value={conflict} onChange={(e) => setConflict(e.target.value as "skip" | "overwrite")}>
              <option value="skip">Skip it</option>
              <option value="overwrite">Overwrite</option>
            </Select>
          </label>
        </div>
        <Pane side="destination" title="Destination" options={options} onChange={onDst} refreshKey={refresh.destination} />
      </div>
      <p className="mt-2 text-xs text-subtle">
        Tick files or folders on one side, open the target folder on the other, then press Copy. Folders are copied with everything inside; symbolic links are skipped.
      </p>

      {(jobs.data ?? []).length > 0 && (
        <section className="card mt-6 overflow-hidden">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Transfers</h2>
          <ul className="divide-y divide-border">
            {jobs.data!.map((j) => (
              <JobRow key={j.id} job={j} onCancel={() => cancel(j.id)} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
