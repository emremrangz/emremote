import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import clsx from "clsx";
import { Button } from "@/components/ui/Button";
import { OsIcon } from "@/components/OsIcon";
import { DeviceStatus } from "@/components/Status";
import type { Device } from "@/lib/types";
import { PROTOCOL_LABELS } from "@/lib/constants";
import { launchConnection } from "@/lib/launch";

// Building blocks shared by the Overview and Statistics pages.

export function Stat({ label, value, to, hint }: { label: string; value: number; to: string; hint?: string }) {
  return (
    <Link to={to} className="group px-5 py-4 transition-colors hover:bg-surface-2/60">
      <p className="text-[13px] text-muted group-hover:text-fg">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </Link>
  );
}

export function Panel({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("card flex flex-col", className)}>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </header>
      <div className="flex-1 px-4">{children}</div>
    </section>
  );
}

export function DeviceRow({ d, meta }: { d: Device; meta: string }) {
  const primary = d.connections[0];
  return (
    <li className="flex items-center gap-3 py-2.5">
      <OsIcon os={d.os} distro={d.facts?.os} boxed />
      <Link to={`/devices/${d.id}`} className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium hover:text-accent">{d.name}</p>
        <p className="truncate font-mono text-xs text-subtle">{d.address}</p>
      </Link>
      <span className="hidden text-xs text-subtle sm:block">{meta}</span>
      <DeviceStatus device={d} compact />
      {primary && (
        <Button size="sm" onClick={() => launchConnection(primary.id)} title={`Connect with ${PROTOCOL_LABELS[primary.protocol]}`}>
          Connect
        </Button>
      )}
    </li>
  );
}

export function Bars<K extends string>({ data, labels, icon }: { data: Partial<Record<K, number>>; labels: Record<K, string>; icon?: (k: K) => ReactNode }) {
  const entries = (Object.entries(data) as [K, number][]).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return <p className="py-6 text-center text-sm text-subtle">No data yet</p>;
  return (
    <ul className="space-y-3 py-4">
      {entries.map(([k, n]) => (
        <li key={k}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="flex items-center gap-2">
              {icon?.(k)}
              {labels[k] ?? k}
            </span>
            <span className="tabular-nums text-muted">{n}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${(n / total) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

