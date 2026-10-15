import { useCallback, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { RefreshCw, Cpu, MemoryStick, HardDrive, Clock, Info } from "lucide-react";
import { errorMessage, get } from "@/lib/api";
import { isExpired } from "@/hooks/useSSHAccess";
import type { SystemInfo } from "@/lib/types";
import { bytes, relativeTime, uptime } from "@/lib/format";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";
import { Switch } from "./ui/Field";
import { useNow } from "@/hooks/useNow";

function pct(used: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
}

function Bar({ value, className }: { value: number; className?: string }) {
  const tone = value >= 90 ? "bg-danger" : value >= 75 ? "bg-warning" : "bg-fg/70";
  return (
    <div className={clsx("h-1.5 overflow-hidden rounded-full bg-surface-3", className)} role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${value}%` }} />
    </div>
  );
}

function Metric({ icon, label, value, sub, bar }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; bar?: number }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 text-xl font-semibold tabular-nums tracking-[-0.01em]">{value}</p>
      {bar !== undefined && <Bar value={bar} className="mt-2" />}
      {sub && <p className="mt-1.5 truncate text-xs text-subtle">{sub}</p>}
    </div>
  );
}

const levelTone = (l?: string) =>
  !l ? "text-muted" : /emerg|alert|crit|err|fail/.test(l) ? "text-danger" : /warn/.test(l) ? "text-warning" : "text-muted";

export function SystemPanel({ accessId, username, onExpired }: { accessId: string; username: string; onExpired: () => void }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  useNow(5000); // keep "x seconds ago" fresh

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await get<{ info: SystemInfo }>(`/api/ssh-access/${accessId}/system`);
      setInfo(r.info);
    } catch (e) {
      if (isExpired(e)) onExpired();
      else setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [accessId, onExpired]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [auto, load]);

  if (!info)
    return error ? (
      <div className="card px-6 py-12 text-center text-[13px]">
        <p className="text-danger">{error}</p>
        <Button size="sm" className="mt-4" onClick={load}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="card flex items-center justify-center gap-3 py-16 text-[13px] text-muted">
        <Spinner /> Reading system information…
      </div>
    );

  const mem = pct(info.memory.used_bytes, info.memory.total_bytes);
  const root = info.disks.find((d) => d.mount === "/" || d.mount === "/System/Volumes/Data" || d.mount === "C:") ?? info.disks[0];
  const windows = info.platform === "windows";
  const network = info.platform === "network";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-subtle">
        <span>
          {network ? [info.hostname, info.vendor, info.model, info.os, info.serial && `S/N ${info.serial}`].filter(Boolean).join(" · ") : `${info.hostname} · ${info.os} · ${info.kernel} · ${info.arch}`}
          {info.virtualization && ` · ${info.virtualization.platform}`}
        </span>
        <span className="ml-auto">
          Collected over SSH as <span className="text-muted">{username}</span> · {relativeTime(info.collected_at)} ({(info.duration_ms / 1000).toFixed(1)}s)
        </span>
        <div className="w-36">
          <Switch checked={auto} onChange={setAuto} label="Every 30 s" />
        </div>
        <Button size="sm" icon={<RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />} onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<Cpu className="h-4 w-4" />}
          label="CPU"
          value={info.cpu.usage_percent !== null ? `${info.cpu.usage_percent.toFixed(0)}%` : "-"}
          bar={info.cpu.usage_percent ?? undefined}
          sub={network ? (info.cpu.usage_percent === null ? "Not reported by this device" : "Last minute") : `${info.cpu.cores} cores${info.cpu.load?.length ? ` · load ${info.cpu.load.map((l) => l.toFixed(2)).join(" ")}` : ""}${info.cpu.model ? ` · ${info.cpu.model}` : ""}`}
        />
        <Metric
          icon={<MemoryStick className="h-4 w-4" />}
          label="Memory"
          value={
            <>
              {bytes(info.memory.used_bytes)} <span className="text-sm font-normal text-subtle">/ {bytes(info.memory.total_bytes)}</span>
            </>
          }
          bar={mem}
          sub={network ? undefined : info.memory.swap_total_bytes ? `${windows ? "Page file" : "Swap"} ${bytes(info.memory.swap_used_bytes)} / ${bytes(info.memory.swap_total_bytes)}` : "No swap"}
        />
        {network ? (
          <Metric icon={<HardDrive className="h-4 w-4" />} label="Firmware" value={<span className="text-base">{info.os || "-"}</span>} sub={info.model || undefined} />
        ) : (
        <Metric
          icon={<HardDrive className="h-4 w-4" />}
          label={root ? `Storage ${root.mount}` : "Storage"}
          value={
            root ? (
              <>
                {bytes(root.used_bytes)} <span className="text-sm font-normal text-subtle">/ {bytes(root.total_bytes)}</span>
              </>
            ) : (
              "-"
            )
          }
          bar={root ? pct(root.used_bytes, root.total_bytes) : undefined}
          sub={root ? `${bytes(root.total_bytes - root.used_bytes)} free · ${info.disks.length} volume(s)` : undefined}
        />
        )}
        <Metric icon={<Clock className="h-4 w-4" />} label="Uptime" value={uptime(info.uptime_seconds)} sub={info.uptime_seconds ? `since ${new Date(Date.now() - info.uptime_seconds * 1000).toLocaleString("en-US")}` : undefined} />
      </div>

      {!network && (
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card overflow-hidden">
          <header className="border-b border-border px-4 py-2.5 text-sm font-semibold">Storage</header>
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-border">
              {info.disks.map((d) => {
                const p = pct(d.used_bytes, d.total_bytes);
                return (
                  <tr key={d.mount}>
                    <td className="max-w-0 truncate px-4 py-2 font-mono text-xs" title={`${d.mount} (${d.filesystem})`}>
                      {d.mount}
                    </td>
                    <td className="w-40 py-2 pr-3">
                      <Bar value={p} />
                    </td>
                    <td className="w-40 whitespace-nowrap py-2 pr-4 text-right text-xs tabular-nums text-muted">
                      {bytes(d.used_bytes)} / {bytes(d.total_bytes)} <span className="text-subtle">({p.toFixed(0)}%)</span>
                    </td>
                  </tr>
                );
              })}
              {info.disks.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-subtle">No volumes reported</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card overflow-hidden">
          <header className="border-b border-border px-4 py-2.5 text-sm font-semibold">Top processes</header>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs text-subtle">
                <th className="px-4 py-2 font-medium">Process</th>
                <th className="w-20 py-2 pr-3 text-right font-medium">PID</th>
                <th className="w-24 py-2 pr-3 text-right font-medium">{windows ? "CPU time" : "CPU"}</th>
                <th className="w-24 py-2 pr-4 text-right font-medium">Memory</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {info.processes.map((p) => (
                <tr key={p.pid}>
                  <td className="max-w-0 truncate px-4 py-1.5 font-mono text-xs">{p.name}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-subtle">{p.pid}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{p.cpu_percent !== undefined ? `${p.cpu_percent.toFixed(1)}%` : p.cpu_seconds !== undefined ? `${p.cpu_seconds.toFixed(0)}s` : "-"}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-muted">{p.mem_percent !== undefined ? `${p.mem_percent.toFixed(1)}%` : p.mem_bytes !== undefined ? bytes(p.mem_bytes) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      )}

      {!network && (
      <section className="card overflow-hidden">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold">Recent system log</h3>
          <span className="text-xs text-subtle">{info.log_source || "No readable log source"}</span>
        </header>
        {info.logs.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-6 text-[13px] text-subtle">
            <Info className="h-4 w-4" />
            {info.log_source
              ? "No recent warnings or errors."
              : "This account cannot read the system log. On Linux, add it to the systemd-journal or adm group."}
          </p>
        ) : (
          <div className="max-h-80 overflow-auto bg-surface-2/40 px-4 py-2 font-mono text-[11.5px] leading-relaxed">
            {info.logs.map((l, i) => (
              <div key={i} className="flex gap-3 whitespace-pre-wrap break-all border-b border-border/40 py-1 last:border-0">
                {l.time && <span className="shrink-0 text-subtle">{new Date(l.time).toLocaleString("en-US")}</span>}
                {l.level && <span className={clsx("w-14 shrink-0 uppercase", levelTone(l.level))}>{l.level.slice(0, 5)}</span>}
                {l.source && <span className="shrink-0 text-muted">{l.source}</span>}
                <span className="text-fg/90">{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      )}
      <p className="text-xs text-subtle">
        Read with a fixed set of read-only commands over SSH. Nothing is installed on the device and no other commands are run.
      </p>
    </div>
  );
}
