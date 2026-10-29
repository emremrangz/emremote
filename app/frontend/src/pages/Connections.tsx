import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cable, Pencil, Play, Search } from "lucide-react";
import { useConnections } from "@/hooks/queries";
import { PageHeader, EmptyState, ErrorState, Badge } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { OsIcon } from "@/components/OsIcon";
import { ConnectionStatusDot, ProtocolBadge } from "@/components/Status";
import { ConnectionFormDialog } from "@/components/ConnectionForm";
import type { Connection, RDPSettings, SSHSettings } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { launchConnection } from "@/lib/launch";
import { useAccess } from "@/lib/auth";

function authLabel(c: Connection) {
  if (c.credential_id) return <Badge tone="accent">{c.credential_name}</Badge>;
  if (c.secret_fields.length) return <Badge>stored</Badge>;
  return <span className="text-xs text-subtle">ask</span>;
}

function verifyLabel(c: Connection) {
  if (c.protocol === "rdp") {
    const s = c.settings as RDPSettings;
    if (s.cert_fingerprints) return <Badge tone="success">pinned</Badge>;
    if (s.ignore_cert) return <Badge tone="warning">any cert</Badge>;
    return <Badge>on first connect</Badge>;
  }
  if (c.protocol === "telnet") return <Badge tone="warning">unencrypted</Badge>;
  if (c.protocol === "ssh") return (c.settings as SSHSettings).host_key ? <Badge tone="success">pinned</Badge> : <Badge>on first connect</Badge>;
  return <span className="text-xs text-subtle">n/a</span>;
}

function ConnectionsTab() {
  const { can } = useAccess();
  const { data, isLoading, error, refetch } = useConnections();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Connection | null>(null);
  const list = useMemo(() => {
    const n = q.toLowerCase();
    return (data ?? []).filter((c) => !n || [c.device_name, c.name, c.device_address, c.protocol, c.username].some((v) => v.toLowerCase().includes(n)));
  }, [data, q]);
  if (isLoading) return <PageLoader />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data!.length)
    return (
      <div className="card">
        <EmptyState icon={<Cable className="h-5 w-5" />} title="No connection methods yet" action={<Link to="/devices"><Button variant="primary">Go to devices</Button></Link>}>
          Connection methods are added per device. Open a device and add RDP, VNC or SSH.
        </EmptyState>
      </div>
    );
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-border p-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input className="input pl-8" placeholder="Filter connections…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter connections" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-subtle">
              <th className="py-2.5 pl-4 pr-4 font-medium">Device</th>
              <th className="py-2.5 pr-4 font-medium">Method</th>
              <th className="py-2.5 pr-4 font-medium">Target</th>
              <th className="py-2.5 pr-4 font-medium">User</th>
              <th className="py-2.5 pr-4 font-medium">Auth</th>
              <th className="py-2.5 pr-4 font-medium">Identity</th>
              <th className="py-2.5 pr-4 font-medium">Last used</th>
              <th className="py-2.5 pr-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((c) => (
              <tr key={c.id} className="hover:bg-surface-2/60">
                <td className="py-2.5 pl-4 pr-4">
                  <Link to={`/devices/${c.device_id}`} className="flex items-center gap-2 font-medium hover:text-accent">
                    <OsIcon os={c.device_os} />
                    {c.device_name}
                  </Link>
                </td>
                <td className="py-2.5 pr-4">
                  <span className="flex items-center gap-2">
                    <ProtocolBadge protocol={c.protocol} /> {c.name}
                  </span>
                </td>
                <td className="py-2.5 pr-4">
                  <span className="flex items-center gap-2 font-mono text-xs text-muted">
                    <ConnectionStatusDot c={c} />
                    {c.device_address}:{c.port}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-xs text-muted">{c.username ? `${c.domain ? c.domain + "\\" : ""}${c.username}` : "-"}</td>
                <td className="py-2.5 pr-4">{authLabel(c)}</td>
                <td className="py-2.5 pr-4">{verifyLabel(c)}</td>
                <td className="py-2.5 pr-4 text-xs text-subtle">{relativeTime(c.last_used_at)}</td>
                <td className="py-2.5 pr-3">
                  <div className="flex justify-end gap-1">
                    {can("sessions.connect") && (
                      <Button size="sm" icon={<Play className="h-3 w-3" />} onClick={() => launchConnection(c.id)}>
                        Connect
                      </Button>
                    )}
                    {c.can_manage && (
                      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConnectionFormDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} deviceId={editing?.device_id ?? ""} connection={editing ?? undefined} />
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <>
      <PageHeader
        title="Connection methods"
        description="Every configured RDP, VNC and SSH endpoint across your devices. Add new methods from a device's page."
      />
      <ConnectionsTab />
    </>
  );
}
