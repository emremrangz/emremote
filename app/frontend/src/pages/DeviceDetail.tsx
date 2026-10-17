import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AppWindow,
  ChevronRight,
  Pencil,
  Trash2,
  Plus,
  Play,
  RefreshCw,
  Route,
  Star,
  MoreHorizontal,
  ShieldCheck,
  ShieldAlert,
  Settings2,
  KeyRound,
  MessageSquareLock,
  UserRound,
  ChevronDown,
  Power,
} from "lucide-react";
import clsx from "clsx";
import { useCheckDevice, useConnections, useDevice, useDeviceConnections, useInvalidateInventory, useToggleFavorite } from "@/hooks/queries";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Badge, CopyButton, ErrorState } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { OsIcon, VirtIcon } from "@/components/OsIcon";
import { DeviceStatus, ProtocolBadge } from "@/components/Status";
import { DeviceFormDialog } from "@/components/DeviceForm";
import { ConnectionFormDialog, identityState, type ConnectionTab } from "@/components/ConnectionForm";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { del, errorMessage, get, post } from "@/lib/api";
import type { Connection, DeviceFacts, Protocol } from "@/lib/types";
import { DEVICE_TYPE_LABELS, OS_LABELS, PROTOCOL_HINT, PROTOCOL_LABELS, SUGGESTED_PROTOCOLS } from "@/lib/constants";
import { bytes, dateTime, relativeTime } from "@/lib/format";
import { launchConnection } from "@/lib/launch";
import { openQuickView } from "@/lib/quickview";
import { useAccess } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { DeviceActivity, DeviceSSHWorkspace } from "@/components/DeviceWorkspace";
import { useQueryClient } from "@tanstack/react-query";

function AuthSummary({ c }: { c: Connection }) {
  if (c.credential_id)
    return (
      <span className="inline-flex items-center gap-1.5">
        <KeyRound className="h-3.5 w-3.5" /> {c.credential_name}
        {c.username && <span className="text-subtle">as {c.username}</span>}
      </span>
    );
  if (c.secret_fields.length)
    return (
      <span className="inline-flex items-center gap-1.5">
        <UserRound className="h-3.5 w-3.5" /> {c.domain ? `${c.domain}\\` : ""}
        {c.username || "no username"} · {c.secret_fields.includes("private_key") ? "key saved" : "password saved"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      <MessageSquareLock className="h-3.5 w-3.5" /> Asks for credentials{c.username && ` · ${c.username}`}
    </span>
  );
}

function Identity({ c, onVerify }: { c: Connection; onVerify: () => void }) {
  if (c.protocol === "telnet")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-warning" title="Telnet sends everything, including the password, unencrypted. Use SSH if the device supports it.">
        <ShieldAlert className="h-3.5 w-3.5" /> Unencrypted
      </span>
    );
  const st = identityState(c);
  if (st === null) return null;
  if (st === "verified")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success" title={c.protocol === "rdp" ? "Certificate recorded; a changed certificate is refused" : "Host key recorded; a changed key is refused"}>
        <ShieldCheck className="h-3.5 w-3.5" /> Verified
      </span>
    );
  if (st === "unverified")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-subtle" title="The server identity is recorded on the first connection and checked on every connection after that.">
        <ShieldCheck className="h-3.5 w-3.5" /> Trusted on first connect
      </span>
    );
  return (
    <button onClick={onVerify} className="inline-flex items-center gap-1 rounded text-xs font-medium text-warning hover:underline">
      <ShieldAlert className="h-3.5 w-3.5" /> Any certificate accepted. Fix
    </button>
  );
}

export default function DeviceDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAccess();
  const allConnections = useConnections();
  const jumpName = (c: Connection) => {
    const id = (c.settings as { jump_connection_id?: string }).jump_connection_id;
    return id ? (allConnections.data ?? []).find((x) => x.id === id)?.device_name ?? "a jump host" : "";
  };
  const canConnect = can("sessions.connect");
  const canFiles = can("files.use");
  const device = useDevice(id);
  const connections = useDeviceConnections(id);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = useInvalidateInventory();
  const check = useCheckDevice();
  const fav = useToggleFavorite();
  const [editing, setEditing] = useState(false);
  const [waking, setWaking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [connForm, setConnForm] = useState<{ open: boolean; connection?: Connection; protocol?: Protocol; tab?: ConnectionTab }>({ open: false });
  const [deletingConn, setDeletingConn] = useState<Connection | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "overview" | "system" | "files" | "activity") || "overview";

  // Learn the operating system (and, over SSH, the hardware) when unknown or a day old.
  const tried = useRef(new Set<string>());
  const dev = device.data;
  // Only for a reachable device with a saved sign-in: an offline one cannot answer, and otherwise the server would have to ask for a password.
  const sshConn = (connections.data ?? []).find((c) => c.protocol === "ssh" && c.status_reachable === true && (c.credential_id || (c.username && c.secret_fields.length > 0)));
  const hasRdp = (connections.data ?? []).some((c) => c.protocol === "rdp");
  useEffect(() => {
    if (!dev || !dev.can_manage || tried.current.has(dev.id)) return;
    const f = dev.facts as { collected_at?: string; source?: string };
    const fresh = !!f.collected_at && Date.now() - new Date(f.collected_at).getTime() < 24 * 3600 * 1000;
    if (sshConn) {
      if (fresh && "virtualization" in dev.facts) return;
      tried.current.add(dev.id);
      (async () => {
        let access: { id: string } | null = null;
        try {
          access = await post<{ id: string }>(`/api/connections/${sshConn.id}/ssh-access`, {});
          await get(`/api/ssh-access/${access.id}/system`);
          invalidate();
        } catch {
          /* the device is off or refused the sign-in: nothing to learn right now */
        } finally {
          if (access) del(`/api/ssh-access/${access.id}`).catch(() => {});
        }
      })();
    } else if (hasRdp && !fresh) {
      // No SSH: a Windows RDP server still names itself and its version when a sign-in starts.
      tried.current.add(dev.id);
      post(`/api/devices/${dev.id}/probe-rdp`).then(() => invalidate()).catch(() => {});
    }
  }, [dev?.id, sshConn?.id, hasRdp]); // eslint-disable-line react-hooks/exhaustive-deps

  if (device.isLoading) return <PageLoader />;
  if (device.error || !device.data) return <ErrorState error={device.error} onRetry={device.refetch} />;
  const d = device.data;
  const facts: DeviceFacts = d.facts ?? {};
  const conns = connections.data ?? [];
  const suggested = SUGGESTED_PROTOCOLS[d.os].find((p) => !conns.some((c) => c.protocol === p)) ?? "ssh";
  const openSettings = (c: Connection, tab: ConnectionTab = "general") => setConnForm({ open: true, connection: c, tab });

  return (
    <>
      <nav className="mb-4 flex items-center gap-1 text-[13px] text-subtle" aria-label="Breadcrumb">
        <Link to="/devices" className="hover:text-fg">
          Devices
        </Link>
        {d.group_name && (
          <>
            <ChevronRight className="h-3.5 w-3.5" />
            <Link to={`/devices?group=${d.group_id}`} className="hover:text-fg">
              {d.group_name}
            </Link>
          </>
        )}
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-muted">{d.name}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-start gap-4">
        <OsIcon os={d.os} distro={d.facts?.os} boxed className="h-5 w-5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="truncate text-xl font-semibold tracking-[-0.01em]">{d.name}</h1>
            {d.favorite && <Star className="h-4 w-4 text-warning" fill="currentColor" aria-label="Favorite" />}
            <DeviceStatus device={d} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span className="inline-flex items-center gap-0.5 font-mono">
              {d.address} <CopyButton value={d.address} label="Copy address" />
            </span>
            <span>{OS_LABELS[d.os]} · {DEVICE_TYPE_LABELS[d.device_type]}</span>
            {d.description && <span>{d.description}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Wake-on-LAN is for physical computers: a container or a virtual machine has no network card to wake. */}
          {canConnect && d.mac && !(facts.virtualization && facts.virtualization.kind !== "physical") && (
            <Button
              icon={<Power className="h-3.5 w-3.5" />}
              loading={waking}
              title={`Send a Wake-on-LAN packet to ${d.mac}`}
              onClick={async () => {
                setWaking(true);
                try {
                  await post(`/api/devices/${d.id}/wake`);
                  toast.success("Wake-up packet sent. The device can take a minute to start.");
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setWaking(false);
                }
              }}
            >
              Wake
            </Button>
          )}
          {canConnect && conns.length === 1 && (
            <>
              <Button icon={<AppWindow className="h-3.5 w-3.5" />} onClick={() => openQuickView(conns[0].id)} title="View here, without leaving this page">
                Quick view
              </Button>
              <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => launchConnection(conns[0].id)} title="Open in the workspace window">
                Connect
              </Button>
            </>
          )}
          {canConnect && conns.length > 1 && (
            <Menu>
              <MenuTrigger asChild>
                <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />}>
                  Connect <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Open session with</MenuLabel>
                {conns.map((c) => (
                  <MenuItem key={c.id} onSelect={() => launchConnection(c.id)} shortcut={`:${c.port}`}>
                    <span className="flex items-center gap-2">
                      <ProtocolBadge protocol={c.protocol} /> {c.name}
                    </span>
                  </MenuItem>
                ))}
                <MenuLabel>View here, on this page</MenuLabel>
                {conns.map((c) => (
                  <MenuItem key={`qv-${c.id}`} onSelect={() => openQuickView(c.id)} shortcut={`:${c.port}`}>
                    <span className="flex items-center gap-2">
                      <ProtocolBadge protocol={c.protocol} /> {c.name}
                    </span>
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
          {d.can_manage && (
            <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>
              Edit device
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Star className="h-4 w-4" />} onSelect={() => fav.mutate({ id: d.id, favorite: !d.favorite })}>
                {d.favorite ? "Remove from favorites" : "Add to favorites"}
              </MenuItem>
              <MenuItem icon={<RefreshCw className="h-4 w-4" />} disabled={!conns.length} onSelect={() => check.mutate(d.id)}>
                Check reachability now
              </MenuItem>
              {d.can_manage && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={() => setDeleting(true)}>
                    Delete device
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        </div>
      </header>

      <div className="mb-5 flex gap-1 border-b border-border" role="tablist" aria-label="Device sections">
        {(
          [
            ["overview", "Overview"],
            ["system", "System"],
            ["files", "Files"],
            ["activity", "Activity"],
          ] as const
        )
          .filter(([key]) => (canFiles || (key !== "system" && key !== "files")) && !(d.os === "network" && key === "files"))
          .map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setParams(key === "overview" ? {} : { tab: key }, { replace: true })}
            className={clsx(
              "-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
              tab === key ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {canFiles && (tab === "system" || (tab === "files" && d.os !== "network")) && (
        <DeviceSSHWorkspace
          key={conns.filter((c) => c.protocol === "ssh").length}
          view={tab}
          device={d}
          connections={conns}
          onVerifyHostKey={(c) => openSettings(c, "security")}
          onAddSSH={() => setConnForm({ open: true, protocol: "ssh" })}
        />
      )}
      {tab === "activity" && <DeviceActivity deviceId={d.id} />}

      {tab === "overview" && (
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <section className="card overflow-hidden">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold">Connection methods</h2>
              <p className="text-xs text-subtle">How emremote reaches this computer. Open Settings to change sign-in, quality or security.</p>
            </div>
            {check.isPending && <RefreshCw className="h-4 w-4 animate-spin text-subtle" />}
          </header>
          <ul className="divide-y divide-border">
            {conns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
                <ProtocolBadge protocol={c.protocol} className="w-11 justify-center" />
                <div className="min-w-[200px] flex-1">
                  <p className="text-sm font-medium">
                    {c.name}
                    <span className="ml-2 font-mono text-xs font-normal text-subtle">
                      {d.address}:{c.port}
                    </span>
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                    <AuthSummary c={c} />
                    {jumpName(c) && (
                      <span className="inline-flex items-center gap-1" title="Reached through a jump host; reachability is not probed">
                        <Route className="h-3 w-3" /> via {jumpName(c)}
                      </span>
                    )}
                    <Identity c={c} onVerify={() => openSettings(c, "security")} />
                  </div>
                </div>
                <div className="w-28 text-xs" title={c.status_detail}>
                  <p className={clsx(c.status_reachable === null ? "text-subtle" : c.status_reachable ? "text-success" : "text-danger")}>
                    {c.status_reachable === null ? "Not checked" : c.status_reachable ? "Port open" : "Not reachable"}
                  </p>
                  <p className="text-subtle">{c.status_checked_at ? relativeTime(c.status_checked_at) : "-"}</p>
                </div>
                <div className="flex items-center gap-2">
                  {d.can_manage && (
                    <Button size="sm" icon={<Settings2 className="h-3.5 w-3.5" />} onClick={() => openSettings(c)}>
                      Settings
                    </Button>
                  )}
                  {d.can_manage && (
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${c.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem icon={<Settings2 className="h-4 w-4" />} onSelect={() => openSettings(c, "signin")}>
                        Change sign-in
                      </MenuItem>
                      {c.protocol !== "vnc" && (
                        <MenuItem icon={<ShieldCheck className="h-4 w-4" />} onSelect={() => openSettings(c, "security")}>
                          {c.protocol === "rdp" ? "Certificate & security" : "Host key"}
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={() => setDeletingConn(c)}>
                        Remove method
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                  )}
                </div>
              </li>
            ))}
            {d.can_manage && (
            <li>
              <button
                onClick={() => setConnForm({ open: true, protocol: suggested })}
                className="flex w-full items-center gap-3 px-5 py-4 text-left text-sm text-muted transition-colors hover:bg-surface-2/60 hover:text-fg"
              >
                <span className="flex h-7 w-11 items-center justify-center rounded border border-dashed border-border-strong">
                  <Plus className="h-4 w-4" />
                </span>
                <span>
                  <span className="block font-medium">Add connection method</span>
                  <span className="block text-xs text-subtle">
                    {conns.length === 0 ? PROTOCOL_HINT[suggested] : "RDP, VNC or SSH, e.g. a second port or another user"}
                  </span>
                </span>
              </button>
            </li>
            )}
          </ul>
        </section>

        <aside className="space-y-5">
          <section className="card">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Details</h2>
              {d.can_manage && (
                <button onClick={() => setEditing(true)} className="text-xs font-medium text-muted hover:text-fg">
                  Edit
                </button>
              )}
            </header>
            <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2.5 px-4 py-4 text-[13px]">
              <dt className="text-subtle">Hostname</dt>
              <dd className="flex items-center gap-1 font-mono text-xs">
                {d.hostname || <span className="text-subtle">-</span>}
                {d.hostname && <CopyButton value={d.hostname} label="Copy hostname" />}
              </dd>
              {d.os === "network" && facts.model && (
                <>
                  <dt className="text-subtle">Model</dt>
                  <dd className="break-words font-mono text-xs">{facts.model}</dd>
                </>
              )}
              {d.os === "network" && facts.serial && (
                <>
                  <dt className="text-subtle">Serial</dt>
                  <dd className="break-words font-mono text-xs">{facts.serial}</dd>
                </>
              )}
              {facts.os && (
                <>
                  <dt className="text-subtle">{d.os === "network" ? "Firmware" : "System"}</dt>
                  <dd className="flex items-center gap-1.5">
                    <OsIcon os={d.os} distro={facts.os} /> <span className="min-w-0 break-words">{facts.os}</span>
                  </dd>
                </>
              )}
              {!facts.virtualization && facts.source === "rdp" && (
                <>
                  <dt className="text-subtle">Runs on</dt>
                  <dd className="text-xs text-subtle">Needs an SSH connection to read (RDP does not reveal it)</dd>
                </>
              )}
              {facts.virtualization && (
                <>
                  <dt className="text-subtle">Runs on</dt>
                  <dd className="flex items-start gap-1.5" title={facts.virtualization.hardware || undefined}>
                    <span className="mt-px flex h-5 shrink-0 items-center text-muted">
                      <VirtIcon platform={facts.virtualization.platform} kind={facts.virtualization.kind} />
                    </span>
                    <span className="min-w-0">
                      {facts.virtualization.platform}
                      {facts.virtualization.kind === "vm" && <span className="text-subtle"> (virtual machine)</span>}
                      {facts.virtualization.note && <span className="block text-xs text-subtle">{facts.virtualization.note}</span>}
                      {facts.virtualization.kind === "physical" && facts.virtualization.hardware && (
                        <span className="block text-xs text-subtle">{facts.virtualization.hardware}</span>
                      )}
                    </span>
                  </dd>
                </>
              )}
              {facts.kernel && (
                <>
                  <dt className="text-subtle">Kernel</dt>
                  <dd className="break-words font-mono text-xs">{facts.kernel}</dd>
                </>
              )}
              {facts.arch && (
                <>
                  <dt className="text-subtle">Architecture</dt>
                  <dd className="font-mono text-xs">{facts.arch}</dd>
                </>
              )}
              {facts.cpu_model && d.os !== "network" && (
                <>
                  <dt className="text-subtle">CPU</dt>
                  <dd className="break-words text-xs">
                    {facts.cpu_model}
                    {facts.cpu_cores ? ` (${facts.cpu_cores} cores)` : ""}
                  </dd>
                </>
              )}
              {!!facts.memory_bytes && (
                <>
                  <dt className="text-subtle">Memory</dt>
                  <dd>{bytes(facts.memory_bytes)}</dd>
                </>
              )}
              {d.mac && (
                <>
                  <dt className="text-subtle">MAC address</dt>
                  <dd className="flex items-center gap-1 font-mono text-xs">
                    {d.mac} <CopyButton value={d.mac} label="Copy MAC address" />
                  </dd>
                </>
              )}
              <dt className="text-subtle">Group</dt>
              <dd>{d.group_name ?? <span className="text-subtle">None</span>}</dd>
              <dt className="text-subtle">Tags</dt>
              <dd className="flex flex-wrap gap-1">{d.tags.length ? d.tags.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-subtle">-</span>}</dd>
              <dt className="text-subtle">Last access</dt>
              <dd title={dateTime(d.last_accessed_at)}>{relativeTime(d.last_accessed_at)}</dd>
              <dt className="text-subtle">Added</dt>
              <dd>{dateTime(d.created_at)}</dd>
            </dl>
          </section>
          {d.notes && (
            <section className="card px-4 py-4">
              <h2 className="mb-2 text-sm font-semibold">Notes</h2>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted">{d.notes}</p>
            </section>
          )}
          <p className="px-1 text-xs leading-relaxed text-subtle">
            Status shows whether each port accepted a TCP connection from the emremote server. Without an agent, emremote cannot tell
            whether someone is signed in.
          </p>
        </aside>
      </div>
      )}

      <DeviceFormDialog open={editing} onOpenChange={setEditing} device={d} />
      <ConnectionFormDialog
        open={connForm.open}
        onOpenChange={(o) => setConnForm((s) => ({ ...s, open: o }))}
        deviceId={d.id}
        connection={connForm.connection}
        initialProtocol={connForm.protocol}
        initialTab={connForm.tab}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${d.name}?`}
        confirmLabel="Delete device"
        requireText={d.name}
        onConfirm={async () => {
          await del(`/api/devices/${d.id}`);
          await invalidate();
          toast.success(`Deleted ${d.name}`);
          navigate("/devices");
        }}
      >
        <p>This removes the device, its {conns.length} connection method(s) and any saved passwords. Active sessions are closed.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deletingConn}
        onOpenChange={(o) => !o && setDeletingConn(null)}
        title={`Remove ${deletingConn ? PROTOCOL_LABELS[deletingConn.protocol] : ""} method “${deletingConn?.name ?? ""}”?`}
        confirmLabel="Remove"
        onConfirm={async () => {
          await del(`/api/connections/${deletingConn!.id}`);
          await invalidate();
          await qc.invalidateQueries({ queryKey: ["devices", d.id] });
        }}
      >
        <p>Any password saved with this method is deleted. Shared credentials it uses are kept.</p>
      </ConfirmDialog>
    </>
  );
}
