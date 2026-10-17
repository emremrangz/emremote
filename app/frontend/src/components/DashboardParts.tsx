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
