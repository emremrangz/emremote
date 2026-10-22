import { useMemo, useState } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";
import { useDevices, useGroups } from "@/hooks/queries";
import type { InventoryMode, Permission } from "@/lib/types";

export const PERMISSIONS: { value: Permission; label: string; hint: string }[] = [
  { value: "sessions.connect", label: "Open remote sessions", hint: "Connect with RDP, VNC, SSH and Telnet to the devices they can see." },
  { value: "files.use", label: "Files and system info", hint: "File manager, transfer drive, copying between servers and the system overview." },
  { value: "quick.connect", label: "Quick connect", hint: "Connect to a host that is not in any inventory." },
  { value: "inventory.manage", label: "Manage own devices", hint: "Add, edit and delete their own devices, groups and connection methods." },
  { value: "credentials.manage", label: "Save credentials", hint: "Keep their own saved logins. Nobody else can see or use them." },
];

export const MODE_OPTIONS: { value: InventoryMode; label: string; hint: string }[] = [
  { value: "none", label: "Own inventory only", hint: "Starts with an empty inventory. They add their own devices and see nothing of the shared inventory." },
  { value: "all", label: "Everything shared", hint: "All devices and groups in the shared inventory, current and future, in addition to their own." },
  { value: "selected", label: "Selected devices and groups", hint: "Only the shared devices and groups ticked below, in addition to their own." },
];

export interface AccessValue {
  mode: InventoryMode;
  deviceIds: string[];
  groupIds: string[];
  permissions: Permission[];
}

function Check({ checked, onChange, disabled, label, hint, badge }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; hint?: string; badge?: string }) {
  return (
    <label className={clsx("flex items-start gap-2.5 rounded-md px-2 py-1.5", disabled ? "opacity-70" : "cursor-pointer hover:bg-surface-2")}>
      <input type="checkbox" className="mt-1 h-3.5 w-3.5 accent-[rgb(var(--fg))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">
          {label}
          {badge && <span className="ml-2 rounded border border-border px-1 text-2xs text-subtle">{badge}</span>}
        </span>
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </span>
    </label>
  );
}

function toggle<T>(list: T[], v: T, on: boolean): T[] {
  return on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v);
}

/**
 * Chooses what a user or team can do and which part of the shared inventory
 * they can use. `inherited` lists permissions that already come from a team.
 */
export function AccessEditor({
  value,
  onChange,
  inherited = [],
  inheritedFrom,
  errors = {},
}: {
  value: AccessValue;
  onChange: (v: AccessValue) => void;
  inherited?: Permission[];
  inheritedFrom?: string;
  errors?: Record<string, string>;
}) {
  const devices = useDevices();
  const groups = useGroups();
  const [q, setQ] = useState("");
  // The admin's own lists contain the shared inventory (administrators own nothing privately).
  const shared = useMemo(() => (devices.data ?? []).filter((d) => d.owner_id === null), [devices.data]);
  const sharedGroups = useMemo(() => (groups.data ?? []).filter((g) => g.owner_id === null), [groups.data]);
  const visible = useMemo(() => {
    const n = q.trim().toLowerCase();
    return shared.filter((d) => !n || [d.name, d.address, ...d.groups.map((g) => g.name)].some((x) => x.toLowerCase().includes(n)));
  }, [shared, q]);

  return (
    <div className="space-y-5">
      <div>
        <span className="label">Shared inventory</span>
        <div className="space-y-1.5" role="radiogroup" aria-label="Shared inventory access">
          {MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={value.mode === o.value}
              onClick={() => onChange({ ...value, mode: o.value })}
              className={clsx(
                "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                value.mode === o.value ? "border-fg/60 bg-surface-2" : "border-border hover:bg-surface-2/60",
              )}
            >
              <span className={clsx("mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border", value.mode === o.value ? "border-fg" : "border-border-strong")}>
                {value.mode === o.value && <span className="h-1.5 w-1.5 rounded-full bg-fg" />}
              </span>
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-subtle">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
        {errors.inventory_mode && <p className="mt-1.5 text-xs text-danger">{errors.inventory_mode}</p>}
      </div>

      {value.mode === "selected" && (
        <div className="rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 text-subtle" />
            <input className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" placeholder="Filter shared devices…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter shared devices" />
            <span className="text-xs text-subtle">
              {value.groupIds.length} groups · {value.deviceIds.length} devices
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {shared.length === 0 && sharedGroups.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-subtle">The shared inventory is empty. Add devices first, then grant them here.</p>
            ) : (
              <>
                {sharedGroups.length > 0 && (
                  <>
                    <p className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Groups (includes every device in them)</p>
                    {sharedGroups.map((g) => (
                      <Check
                        key={g.id}
                        checked={value.groupIds.includes(g.id)}
                        onChange={(on) => onChange({ ...value, groupIds: toggle(value.groupIds, g.id, on) })}
                        label={g.name}
                        badge={`${g.device_count} devices`}
                      />
                    ))}
                  </>
                )}
                <p className="px-2 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Devices</p>
                {visible.map((d) => {
                  const viaGroup = d.groups.some((g) => value.groupIds.includes(g.id));
                  return (
                    <Check
                      key={d.id}
                      checked={viaGroup || value.deviceIds.includes(d.id)}
                      disabled={viaGroup}
                      onChange={(on) => onChange({ ...value, deviceIds: toggle(value.deviceIds, d.id, on) })}
                      label={d.name}
                      hint={d.address}
                      badge={viaGroup ? "via group" : d.groups.map((g) => g.name).join(", ") || undefined}
                    />
                  );
                })}
                {visible.length === 0 && <p className="px-2 py-3 text-center text-sm text-subtle">No devices match.</p>}
              </>
            )}
          </div>
        </div>
      )}
      {errors.device_ids && <p className="-mt-3 text-xs text-danger">{errors.device_ids}</p>}

      <div>
        <span className="label">Permissions</span>
        <div className="rounded-lg border border-border p-1">
          {PERMISSIONS.map((p) => {
            const fromTeam = inherited.includes(p.value);
            return (
              <Check
                key={p.value}
                checked={fromTeam || value.permissions.includes(p.value)}
                disabled={fromTeam}
                onChange={(on) => onChange({ ...value, permissions: toggle(value.permissions, p.value, on) })}
                label={p.label}
                hint={p.hint}
                badge={fromTeam ? `from ${inheritedFrom ?? "team"}` : undefined}
              />
            );
          })}
        </div>
        {errors.permissions && <p className="mt-1.5 text-xs text-danger">{errors.permissions}</p>}
      </div>
    </div>
  );
}
