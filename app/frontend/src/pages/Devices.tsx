import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Select } from "@/components/ui/Select";
import clsx from "clsx";
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  Star,
  MoreHorizontal,
  Pencil,
  Trash2,
  Play,
  FolderTree,
  Monitor,
  RefreshCw,
  X,
  ChevronDown,
} from "lucide-react";
import { useDevices, useGroups, useToggleFavorite, useInvalidateInventory, useCheckDevice } from "@/hooks/queries";
import { Button } from "@/components/ui/Button";
import { PageHeader, EmptyState, ErrorState, CopyButton, Badge } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Segmented } from "@/components/ui/Field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { OsIcon } from "@/components/OsIcon";
import { DeviceStatus, ProtocolBadge, deviceReachability, ConnectionStatusDot } from "@/components/Status";
import { DeviceFormDialog } from "@/components/DeviceForm";
import { ImportExportMenu } from "@/components/ImportExport";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { del } from "@/lib/api";
import type { Device, OS, Protocol } from "@/lib/types";
import { DEVICE_TYPE_LABELS, OS_LABELS, PROTOCOL_LABELS } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { launchConnection } from "@/lib/launch";
import { useAccess } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";

type View = "table" | "grid";

function useStoredView(): [View, (v: View) => void] {
  const [v, setV] = useState<View>(() => {
    try {
      return (localStorage.getItem("emremote-device-view") as View) || "table";
    } catch {
      return "table";
    }
  });
  return [
    v,
    (n) => {
      setV(n);
      try {
        localStorage.setItem("emremote-device-view", n);
      } catch {
        /* ignore */
      }
    },
  ];
}

export function ConnectButton({ device, size = "sm" }: { device: Device; size?: "sm" | "md" }) {
  const { can } = useAccess();
  const cs = device.connections;
  if (!can("sessions.connect")) return null;
  if (cs.length === 0)
    return device.can_manage ? (
      <Link to={`/devices/${device.id}`} className="text-xs text-subtle hover:text-accent">
        Add connection
      </Link>
    ) : null;
  if (cs.length === 1)
    return (
      <Button size={size} icon={<Play className="h-3 w-3" />} onClick={() => launchConnection(cs[0].id)} title={`Open ${PROTOCOL_LABELS[cs[0].protocol]} session in a new tab`}>
        {PROTOCOL_LABELS[cs[0].protocol]}
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size={size} icon={<Play className="h-3 w-3" />}>
          Connect <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Open session</MenuLabel>
        {cs.map((c) => (
          <MenuItem key={c.id} onSelect={() => launchConnection(c.id)} icon={<ConnectionStatusDot c={c} />} shortcut={`:${c.port}`}>
            <span className="flex items-center gap-2">
              <ProtocolBadge protocol={c.protocol} /> {c.name}
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function FavoriteButton({ device }: { device: Device }) {
  const toggle = useToggleFavorite();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggle.mutate({ id: device.id, favorite: !device.favorite });
      }}
      className={clsx("rounded p-1 transition-colors", device.favorite ? "text-warning" : "text-subtle hover:text-muted")}
      aria-label={device.favorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={device.favorite}
      title={device.favorite ? "Remove from favorites" : "Add to favorites"}
    >
      <Star className="h-4 w-4" fill={device.favorite ? "currentColor" : "none"} />
    </button>
  );
}

function RowMenu({ device, onEdit, onDelete }: { device: Device; onEdit: () => void; onDelete: () => void }) {
  const check = useCheckDevice();
  const toast = useToast();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${device.name}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </MenuTrigger>
      <MenuContent>
        {device.can_manage && (
          <MenuItem icon={<Pencil className="h-4 w-4" />} onSelect={onEdit}>
            Edit device
          </MenuItem>
        )}
        <MenuItem
          icon={<RefreshCw className="h-4 w-4" />}
          disabled={device.connections.length === 0}
          onSelect={() =>
            check.mutate(device.id, {
              onSuccess: (d) => toast.info(`${d.name}: ${deviceReachability(d) === "reachable" ? "reachable" : "checked"}`),
            })
          }
        >
          Check reachability
        </MenuItem>
        {device.can_manage && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onSelect={onDelete}>
              Delete device
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function Tags({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, max).map((t) => (
        <Badge key={t}>{t}</Badge>
      ))}
      {tags.length > max && <Badge title={tags.slice(max).join(", ")}>+{tags.length - max}</Badge>}
    </div>
  );
}

export default function DevicesPage({ favoritesOnly }: { favoritesOnly?: boolean }) {
  const devices = useDevices();
  const groups = useGroups();
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const toast = useToast();
  const [storedView, setView] = useStoredView();
  // Tables do not fit phones; use cards there regardless of the saved preference.
  const narrow = useMediaQuery("(max-width: 767px)");
  const view: View = narrow ? "grid" : storedView;
  const [q, setQ] = useState("");
  const [os, setOs] = useState<OS | "">("");
  const [params, setParams] = useSearchParams();
  const group = params.get("group") ?? "";
  const setGroup = (g: string) => setParams(g ? { group: g } : {});
  const [protocol, setProtocol] = useState<Protocol | "">("");
  const [tag, setTag] = useState("");
  const [adding, setAdding] = useState(false);
  const { can } = useAccess();
  const canAdd = can("inventory.manage");
  const [editing, setEditing] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);

  const allTags = useMemo(
    () => Array.from(new Set((devices.data ?? []).flatMap((d) => d.tags))).sort((a, b) => a.localeCompare(b)),
    [devices.data],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (devices.data ?? []).filter((d) => {
      if (favoritesOnly && !d.favorite) return false;
      if (os && d.os !== os) return false;
      if (group === "none" ? d.group_id !== null : group && d.group_id !== group) return false;
      if (protocol && !d.connections.some((c) => c.protocol === protocol)) return false;
      if (tag && !d.tags.includes(tag)) return false;
      if (!needle) return true;
      return [d.name, d.hostname, d.address, d.description, d.group_name ?? "", ...d.tags].some((v) =>
        v.toLowerCase().includes(needle),
      );
    });
  }, [devices.data, q, os, group, protocol, tag, favoritesOnly]);

  const filtersActive = !!(q || os || group || protocol || tag);
  const clear = () => {
    setQ("");
    setOs("");
    setGroup("");
    setProtocol("");
    setTag("");
  };

  const grouped = useMemo(() => {
    if (group) return null;
    const m = new Map<string, Device[]>();
    for (const d of filtered) {
      const k = d.group_name ?? "";
      m.set(k, [...(m.get(k) ?? []), d]);
    }
    if (m.size <= 1) return null;
    return Array.from(m.entries()).sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [filtered, group]);

  const groupName =
    group === "none" ? "Ungrouped devices" : group ? groups.data?.find((g) => g.id === group)?.name : undefined;

  if (devices.isLoading) return <PageLoader />;
  if (devices.error) return <ErrorState error={devices.error} onRetry={devices.refetch} />;
  const total = favoritesOnly ? devices.data!.filter((d) => d.favorite).length : devices.data!.length;

  const renderTable = (sections: [string | null, Device[]][]) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium text-subtle">
            <th className="w-8 py-2.5 pl-4" />
            <th className="py-2.5 pr-4 font-medium">Device</th>
            <th className="py-2.5 pr-4 font-medium">Address</th>
            <th className="py-2.5 pr-4 font-medium">Methods</th>
            <th className="py-2.5 pr-4 font-medium">Tags</th>
            <th className="py-2.5 pr-4 font-medium">Status</th>
            <th className="py-2.5 pr-4 font-medium">Last access</th>
            <th className="py-2.5 pr-4" />
          </tr>
        </thead>
        {sections.map(([section, list]) => (
        <tbody key={section ?? "_all"} className="divide-y divide-border border-b border-border last:border-b-0">
          {section !== null && (
            <tr className="bg-surface-2/50">
              <td colSpan={8} className="px-4 py-2 text-xs font-semibold text-muted">
                {section || "Ungrouped"} <span className="ml-1 font-normal text-subtle">{list.length}</span>
              </td>
            </tr>
          )}
          {list.map((d) => (
            <tr key={d.id} className="group cursor-pointer hover:bg-surface-2/60" onClick={() => navigate(`/devices/${d.id}`)}>
              <td className="py-2.5 pl-3">
                <FavoriteButton device={d} />
              </td>
              <td className="py-2.5 pr-4">
                <div className="flex items-center gap-3">
                  <OsIcon os={d.os} distro={d.facts?.os} boxed />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{d.name}</p>
                    <p className="truncate text-xs text-subtle">
                      {DEVICE_TYPE_LABELS[d.device_type]}
                      {d.hostname && ` · ${d.hostname}`}
                    </p>
                  </div>
                </div>
              </td>
              <td className="py-2.5 pr-4">
                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted">
                  {d.address}
                  <CopyButton value={d.address} className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
                </span>
              </td>
              <td className="py-2.5 pr-4">
                <div className="flex flex-wrap gap-1">
                  {d.connections.map((c) => (
                    <ProtocolBadge key={c.id} protocol={c.protocol} />
                  ))}
                  {d.connections.length === 0 && <span className="text-xs text-subtle">-</span>}
                </div>
              </td>
              <td className="py-2.5 pr-4">
                <Tags tags={d.tags} />
              </td>
              <td className="py-2.5 pr-4">
                <DeviceStatus device={d} />
              </td>
              <td className="py-2.5 pr-4 text-xs text-subtle">{relativeTime(d.last_accessed_at)}</td>
              <td className="py-2.5 pr-3" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-end gap-1">
                  <ConnectButton device={d} />
                  <RowMenu device={d} onEdit={() => setEditing(d)} onDelete={() => setDeleting(d)} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        ))}
      </table>
    </div>
  );

  const renderGrid = (list: Device[]) => (
    <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {list.map((d) => (
        <div
          key={d.id}
          className="group flex cursor-pointer flex-col rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong"
          onClick={() => navigate(`/devices/${d.id}`)}
        >
          <div className="flex items-start gap-3">
            <OsIcon os={d.os} distro={d.facts?.os} boxed />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{d.name}</p>
              <p className="flex items-center gap-1 truncate font-mono text-xs text-subtle">
                {d.address}
                <CopyButton value={d.address} className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
              </p>
            </div>
            <div onClick={(e) => e.stopPropagation()} className="-mr-1 -mt-1 flex items-center">
              <FavoriteButton device={d} />
              <RowMenu device={d} onEdit={() => setEditing(d)} onDelete={() => setDeleting(d)} />
            </div>
          </div>
          {d.description && <p className="mt-3 line-clamp-2 text-xs text-muted">{d.description}</p>}
          <div className="mb-4 mt-3">
            <Tags tags={d.tags} max={4} />
          </div>
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3" style={{ marginTop: "auto" }}>
            <DeviceStatus device={d} />
            <div onClick={(e) => e.stopPropagation()}>
              <ConnectButton device={d} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const render = (list: Device[]) => (view === "table" ? renderTable([[null, list]]) : renderGrid(list));

  return (
    <>
      <PageHeader
        title={favoritesOnly ? "Favorites" : groupName ?? "All devices"}
        description={
          favoritesOnly
            ? "Devices you starred for quick access."
            : `${total} registered ${total === 1 ? "device" : "devices"} · status reflects TCP reachability of configured ports`
        }
        actions={
          <>
            <ImportExportMenu />
            {canAdd && (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                Add device
              </Button>
            )}
          </>
        }
      />

      {total === 0 ? (
        <div className="card">
          {favoritesOnly ? (
            <EmptyState icon={<Star className="h-5 w-5" />} title="No favorites yet">
              Use the star on any device to pin it here.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<Monitor className="h-5 w-5" />}
              title="No devices yet"
              action={
                canAdd && (
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                    Add device
                  </Button>
                )
              }
            >
              {canAdd
                ? "Add computers by IP address or hostname, then choose how to reach them (RDP, VNC or SSH)."
                : "No devices have been shared with you yet. Ask an administrator to give you access."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <input
                className="input pl-8"
                placeholder="Search name, address, tag…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search devices"
              />
            </div>
            <Select className="input w-auto" value={os} onChange={(e) => setOs(e.target.value as OS | "")} aria-label="Filter by OS">
              <option value="">All systems</option>
              {Object.entries(OS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Select className="input w-auto" value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol | "")} aria-label="Filter by protocol">
              <option value="">All methods</option>
              {Object.entries(PROTOCOL_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            {(groups.data?.length ?? 0) > 0 && (
              <Select className="input w-auto" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Filter by group">
                <option value="">All groups</option>
                {groups.data!.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value="none">Ungrouped</option>
              </Select>
            )}
            {allTags.length > 0 && (
              <Select className="input w-auto" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
                <option value="">All tags</option>
                {allTags.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            )}
            {filtersActive && (
              <Button variant="ghost" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={clear}>
                Clear
              </Button>
            )}
            <div className="ml-auto hidden md:block">
              <Segmented<View>
                ariaLabel="View"
                value={view}
                onChange={setView}
                options={[
                  { value: "table", label: <List className="h-3.5 w-3.5" />, title: "Table view" },
                  { value: "grid", label: <LayoutGrid className="h-3.5 w-3.5" />, title: "Card view" },
                ]}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={<Search className="h-5 w-5" />} title="No matching devices" action={<Button size="sm" onClick={clear}>Clear filters</Button>}>
              Try a different search or filter.
            </EmptyState>
          ) : grouped && view === "table" ? (
            renderTable(grouped)
          ) : grouped ? (
            grouped.map(([name, list]) => (
              <div key={name || "_none"}>
                <div className="flex items-center gap-2 border-b border-border bg-surface-2/50 px-4 py-2 text-xs font-semibold text-muted">
                  <FolderTree className="h-3.5 w-3.5" />
                  {name || "Ungrouped"}
                  <span className="font-normal text-subtle">{list.length}</span>
                </div>
                {render(list)}
              </div>
            ))
          ) : (
            render(filtered)
          )}
        </div>
      )}

      <DeviceFormDialog open={adding} onOpenChange={setAdding} defaultGroupId={group} onSaved={(d) => navigate(`/devices/${d.id}`)} />
      <DeviceFormDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} device={editing ?? undefined} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "device"}?`}
        confirmLabel="Delete device"
        onConfirm={async () => {
          await del(`/api/devices/${deleting!.id}`);
          await invalidate();
          toast.success(`Deleted ${deleting!.name}`);
        }}
      >
        <p>
          This removes the device and its {deleting?.connections.length ?? 0} connection method(s), including any secrets
          stored with them. Active sessions to it are closed. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
