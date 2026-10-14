import clsx from "clsx";
import type { ConnectionSummary, Device, Protocol } from "@/lib/types";
import { PROTOCOL_LABELS } from "@/lib/constants";
import { relativeTime } from "@/lib/format";

export type Reach = "reachable" | "partial" | "unreachable" | "unknown" | "none";

export function deviceReachability(d: Pick<Device, "connections">): Reach {
  const cs = d.connections;
  if (cs.length === 0) return "none";
  const checked = cs.filter((c) => c.status_reachable !== null);
  if (checked.length === 0) return "unknown";
  const up = checked.filter((c) => c.status_reachable).length;
  if (up === 0) return "unreachable";
  if (up < cs.length) return "partial";
  return "reachable";
}

const meta: Record<Reach, { label: string; dot: string; text: string }> = {
  reachable: { label: "Reachable", dot: "bg-success", text: "text-success" },
  partial: { label: "Partially reachable", dot: "bg-warning", text: "text-warning" },
  unreachable: { label: "Not reachable", dot: "bg-danger", text: "text-danger" },
  unknown: { label: "Not checked", dot: "bg-subtle", text: "text-muted" },
  none: { label: "No connections", dot: "bg-border-strong", text: "text-subtle" },
};

function tooltip(d: Pick<Device, "connections">) {
  if (d.connections.length === 0) return "No connection methods configured, nothing to check.";
  const lines = d.connections.map((c) => {
    const state = c.status_reachable === null ? "not checked yet" : c.status_reachable ? "port open" : c.status_detail || "no response";
    return `${PROTOCOL_LABELS[c.protocol]} :${c.port}: ${state}${c.status_checked_at ? ` (${relativeTime(c.status_checked_at)})` : ""}`;
  });
  return (
    lines.join("\n") +
    "\n\nReachability = the service port accepted a TCP connection from the emremote server. It does not prove anyone can log in."
  );
}

export function DeviceStatus({ device, compact }: { device: Pick<Device, "connections">; compact?: boolean }) {
  const r = deviceReachability(device);
  const m = meta[r];
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs", m.text)} title={tooltip(device)}>
      <span className={clsx("h-2 w-2 shrink-0 rounded-full", m.dot, r === "reachable" && "shadow-[0_0_0_3px_rgb(var(--success)/0.15)]")} />
      {!compact && m.label}
      {compact && <span className="sr-only">{m.label}</span>}
    </span>
  );
}

export function ConnectionStatusDot({ c }: { c: ConnectionSummary }) {
  const r: Reach = c.status_reachable === null ? "unknown" : c.status_reachable ? "reachable" : "unreachable";
  const title =
    c.status_reachable === null
      ? "Not checked yet"
      : `${c.status_reachable ? "Port open" : c.status_detail || "No response"} · checked ${relativeTime(c.status_checked_at)}`;
  return <span className={clsx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", meta[r].dot)} title={title} />;
}

const protoTone: Record<Protocol, string> = {
  rdp: "text-[#4ea1ff] bg-[#4ea1ff]/10 border-[#4ea1ff]/20",
  vnc: "text-[#b58cff] bg-[#b58cff]/10 border-[#b58cff]/20",
  ssh: "text-[#3fc28a] bg-[#3fc28a]/10 border-[#3fc28a]/20",
  telnet: "text-[#e0a24a] bg-[#e0a24a]/10 border-[#e0a24a]/25",
};

export function ProtocolBadge({ protocol, className }: { protocol: Protocol; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] font-semibold tracking-wide",
        protoTone[protocol],
        className,
      )}
    >
      {PROTOCOL_LABELS[protocol]}
    </span>
  );
}
