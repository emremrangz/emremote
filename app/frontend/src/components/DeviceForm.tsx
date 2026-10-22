import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Select } from "@/components/ui/Select";
import { Check, Info, X } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { TagInput } from "./TagInput";
import { LocationPicker, emptyLocation, parseLocation, type LocationDraft } from "./LocationPicker";
import { ProtocolBadge } from "./Status";
import { useToast } from "./ui/Toast";
import { OsIcon } from "./OsIcon";
import { ApiError, errorMessage, post, put } from "@/lib/api";
import type { Device, DeviceType, Group, OS, Protocol } from "@/lib/types";
import { DEFAULT_PORTS, DEVICE_TYPE_LABELS, OS_LABELS, PROTOCOL_HINT, PROTOCOL_LABELS, SUGGESTED_PROTOCOLS, UNENCRYPTED } from "@/lib/constants";
import { useCredentials, useDevices, useGroups, useInvalidateInventory } from "@/hooks/queries";

interface FormState {
  name: string;
  hostname: string;
  address: string;
  os: OS;
  device_type: DeviceType;
  description: string;
  notes: string;
  tags: string[];
  /** The groups the device is in; the first is its main group. */
  group_ids: string[];
  favorite: boolean;
  mac: string;
  wol_broadcast: string;
}

const empty: FormState = {
  name: "",
  hostname: "",
  address: "",
  os: "windows",
  device_type: "desktop",
  description: "",
  notes: "",
  tags: [],
  group_ids: [],
  favorite: false,
  mac: "",
  wol_broadcast: "",
};

const NEW_GROUP = "__new__";

function Steps({ step }: { step: number }) {
  const items = ["Device", "Access"];
  return (
    <ol className="flex items-center gap-2 text-[13px]">
      {items.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-6 bg-border-strong" />}
          <span
            className={clsx(
              "flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold",
              i < step ? "border-primary bg-primary text-primary-fg" : i === step ? "border-fg text-fg" : "border-border-strong text-subtle",
            )}
          >
            {i < step ? <Check className="h-3 w-3" /> : i + 1}
          </span>
          <span className={i === step ? "font-medium" : "text-subtle"}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function OptionCard({
  selected,
  onClick,
  title,
  description,
  icon,
}: {
  selected: boolean;
  onClick: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={clsx(
        "flex w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors",
        selected ? "border-fg/70 bg-surface-2 ring-1 ring-fg/40" : "border-border hover:border-border-strong",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <span
        className={clsx(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-fg" : "border-border-strong",
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-fg" />}
      </span>
    </button>
  );
}

export { OptionCard };

/**
 * Add device (two steps: device details, then how to reach it) or edit device
 * details (single step).
 */
export function DeviceFormDialog({
  open,
  onOpenChange,
  device,
  cloneFrom,
  onSaved,
  defaultGroupId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  device?: Device;
  /** Make a new device from this one: the same kind, group, tags, place and connection methods, with its own name and address. */
  cloneFrom?: Device;
  onSaved?: (d: Device) => void;
  defaultGroupId?: string;
}) {
  const toast = useToast();
  const [loc, setLoc] = useState<LocationDraft>(emptyLocation);
  const [copySecrets, setCopySecrets] = useState(true);
  const [step, setStep] = useState(0);
  const [f, setF] = useState<FormState>(empty);
  // Groups to create when the device is saved, and the name being typed for one.
  const [pendingGroups, setPendingGroups] = useState<string[]>([]);
  const [newGroup, setNewGroup] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [methods, setMethods] = useState<Partial<Record<Protocol, number>>>({ rdp: 3389 });
  const [signIn, setSignIn] = useState<"prompt" | "store" | "credential">("prompt");
  const [credentialId, setCredentialId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = useGroups();
  const credentials = useCredentials();
  const devices = useDevices();
  const invalidate = useInvalidateInventory();
  const editing = !!device;
  const cloning = !!cloneFrom && !device;

  const tagSuggestions = useMemo(
    () => Array.from(new Set((devices.data ?? []).flatMap((d) => d.tags))).sort(),
    [devices.data],
  );

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError("");
    setStep(0);
    setNewGroup("");
    setPendingGroups([]);
    setAddingGroup(false);
    setUsername("");
    setPassword("");
    setDomain("");
    setSignIn("prompt");
    setCredentialId("");
    setCopySecrets(true);
    const src = device ?? cloneFrom;
    setLoc(src?.location ? { label: src.location.label, lat: String(src.location.latitude), lon: String(src.location.longitude) } : emptyLocation);
    if (cloneFrom && !device) {
      // A clone is another machine: it keeps the kind of device, group, tags and place, not the name, address or MAC.
      setF({
        name: `${cloneFrom.name} (copy)`,
        hostname: "",
        address: "",
        os: cloneFrom.os,
        device_type: cloneFrom.device_type,
        description: cloneFrom.description,
        notes: cloneFrom.notes,
        tags: cloneFrom.tags,
        group_ids: cloneFrom.groups.map((g) => g.id),
        favorite: false,
        mac: "",
        wol_broadcast: "",
      });
    } else if (device) {
      setF({
        name: device.name,
        hostname: device.hostname,
        address: device.address,
        os: device.os,
        device_type: device.device_type,
        description: device.description,
        notes: device.notes,
        tags: device.tags,
        group_ids: device.groups.map((g) => g.id),
        favorite: device.favorite,
        mac: device.mac ?? "",
        wol_broadcast: device.wol_broadcast ?? "",
      });
    } else {
      setF({ ...empty, group_ids: defaultGroupId && defaultGroupId !== "none" ? [defaultGroupId] : [] });
      setMethods({ rdp: 3389 });
    }
  }, [open, device, cloneFrom, defaultGroupId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const setOS = (os: OS) => {
    set("os", os);
    if (os === "network") set("device_type", "network");
    else if (f.os === "network" && f.device_type === "network") set("device_type", "server");
    if (!editing) {
      const first = SUGGESTED_PROTOCOLS[os][0];
      setMethods({ [first]: DEFAULT_PORTS[first] });
    }
  };

  const validateStep0 = () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = "Give the device a name";
    if (!f.address.trim()) e.address = "Enter the IP address or hostname";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // The chosen groups, with the new ones created now (a name typed but not added yet counts as added).
  const resolveGroups = async (): Promise<string[]> => {
    const ids = [...f.group_ids];
    const names = [...pendingGroups, ...(addingGroup && newGroup.trim() ? [newGroup.trim()] : [])];
    for (const name of names) {
      const g = await post<Group>("/api/groups", { name, description: "" });
      ids.push(g.id);
    }
    return ids;
  };

  const save = async () => {
    if (!editing && !cloning && signIn === "credential" && !credentialId) {
      setErrors({ credential_id: "Choose a saved credential" });
      setFormError("Choose a saved credential, or pick another sign-in option.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const group_ids = await resolveGroups();
      const place = parseLocation(loc);
      if ((loc.lat.trim() !== "" || loc.lon.trim() !== "") && !place) {
        setErrors({ location: "Latitude is between -90 and 90 and longitude between -180 and 180." });
        setFormError("The location is not valid.");
        setBusy(false);
        return;
      }
      // Editing always sends the location (an empty one clears it); a new device only when one was chosen.
      const location = place ? { label: place.label, latitude: place.latitude, longitude: place.longitude } : editing ? { label: "", latitude: null, longitude: null } : undefined;
      const body = { ...f, group_ids, ...(location ? { location } : {}) };
      let saved: Device;
      if (device) {
        saved = await put<Device>(`/api/devices/${device.id}`, body);
      } else if (cloneFrom) {
        const r = await post<{ device: Device; connections_copied: number; secrets_copied: number; skipped: string[]; secrets_not_copied: boolean }>(`/api/devices/${cloneFrom.id}/clone`, {
          ...body,
          copy_connections: true,
          copy_secrets: copySecrets,
        });
        saved = r.device;
        toast.success(
          `Cloned from ${cloneFrom.name}: ${r.connections_copied} connection method${r.connections_copied === 1 ? "" : "s"}` +
            (r.secrets_copied ? `, ${r.secrets_copied} with the saved sign-in` : "") +
            (r.secrets_not_copied ? ". Saved sign-ins were not copied because the original belongs to someone else." : "."),
        );
        if (r.skipped.length) toast.error(`Not copied: ${r.skipped.join(", ")}`);
      } else {
        saved = await post<Device>("/api/devices", body);
        const store = signIn === "store" && (username || password);
        const cred = signIn === "credential" ? credentialId : null;
        for (const [protocol, port] of Object.entries(methods) as [Protocol, number][]) {
          await post(`/api/devices/${saved.id}/connections`, {
            protocol,
            port,
            name: PROTOCOL_LABELS[protocol],
            username: protocol === "vnc" || cred ? "" : username.trim(),
            domain: protocol === "rdp" && !cred ? domain.trim() : "",
            credential_id: cred,
            settings: {},
            secret: store && password ? { mode: "set", password } : { mode: "keep" },
          });
        }
      }
      await invalidate();
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setErrors(err.fields);
        if (["name", "address", "hostname", "os", "device_type", "group_ids", "tags", "location", "location.label", "location.latitude", "location.longitude"].some((k) => k in err.fields)) setStep(0);
      }
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 0) {
      if (!validateStep0()) return;
      if (editing || cloning) save();
      else setStep(1);
      return;
    }
    save();
  };

  const chosen = Object.keys(methods) as Protocol[];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit device" : cloning ? "Clone device" : "Add device"}
      description={editing ? device!.name : cloning ? `From ${cloneFrom!.name}` : <Steps step={step} />}
      size="xl"
      footer={
        <>
          {formError && <p className="mr-auto max-w-[55%] text-sm text-danger">{formError}</p>}
          {step === 1 ? (
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          <Button variant="primary" type="submit" form="device-form" loading={busy} disabled={step === 1 && chosen.length === 0}>
            {editing ? "Save changes" : cloning ? "Create clone" : step === 0 ? "Continue" : "Add device"}
          </Button>
        </>
      }
    >
      <form id="device-form" onSubmit={submit} className="space-y-5" noValidate>
        {step === 0 && (
          <>
            <div>
              <span className="label">Operating system</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Operating system">
                {(Object.keys(OS_LABELS) as OS[]).map((os) => (
                  <button
                    key={os}
                    type="button"
                    role="radio"
                    aria-checked={f.os === os}
                    onClick={() => setOS(os)}
                    className={clsx(
                      "flex h-10 items-center gap-2.5 rounded-lg border px-3 text-sm transition-colors",
                      f.os === os ? "border-fg/70 bg-surface-2 font-medium ring-1 ring-fg/40" : "border-border text-muted hover:border-border-strong hover:text-fg",
                    )}
                  >
                    <OsIcon os={os} distro={f.os === os && editing ? device?.facts?.os : undefined} />
                    {OS_LABELS[os]}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
              <Field label="Name" error={errors.name}>
                <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Office PC" autoFocus maxLength={128} />
              </Field>
              <Field label="IP address or hostname" hint={editing ? undefined : "The address emremote connects to."} error={errors.address}>
                <input className="input font-mono" value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="192.168.1.20" spellCheck={false} autoCapitalize="off" />
              </Field>
              <Field label="Groups" optional error={errors.group_ids} hint="A device can be in several groups. The first one is its main group.">
                <div className="space-y-2">
                  {(f.group_ids.length > 0 || pendingGroups.length > 0) && (
                    <ul className="flex flex-wrap gap-1.5" aria-label="Groups of this device">
                      {f.group_ids.map((id) => (
                        <li key={id} className="flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
                          {groups.data?.find((g) => g.id === id)?.name ?? "Group"}
                          <button type="button" className="rounded-full p-0.5 text-subtle hover:bg-surface-3 hover:text-fg" aria-label={`Remove from ${groups.data?.find((g) => g.id === id)?.name ?? "the group"}`} onClick={() => set("group_ids", f.group_ids.filter((x) => x !== id))}>
                            <X className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                      {pendingGroups.map((name) => (
                        <li key={name} className="flex items-center gap-1 rounded-full border border-dashed border-border-strong bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs italic">
                          {name} <span className="not-italic text-subtle">(new)</span>
                          <button type="button" className="rounded-full p-0.5 text-subtle hover:bg-surface-3 hover:text-fg" aria-label={`Do not create ${name}`} onClick={() => setPendingGroups(pendingGroups.filter((x) => x !== name))}>
                            <X className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {addingGroup ? (
                    <div className="flex gap-2">
                      <input
                        className="input"
                        value={newGroup}
                        onChange={(e) => setNewGroup(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const n = newGroup.trim();
                            if (n && !pendingGroups.includes(n)) setPendingGroups([...pendingGroups, n]);
                            setNewGroup("");
                            setAddingGroup(false);
                          }
                        }}
                        placeholder="New group name, then Enter"
                        maxLength={64}
                        autoFocus
                        aria-label="New group name"
                      />
                      <Button type="button" onClick={() => { setNewGroup(""); setAddingGroup(false); }}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Select
                      className="input"
                      value=""
                      onChange={(e) => {
                        if (e.target.value === NEW_GROUP) setAddingGroup(true);
                        else if (e.target.value) set("group_ids", [...f.group_ids, e.target.value]);
                      }}
                      aria-label="Add to a group"
                    >
                      <option value="">{f.group_ids.length || pendingGroups.length ? "Add to another group…" : "No group"}</option>
                      {(groups.data ?? []).filter((g) => !f.group_ids.includes(g.id)).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                      <option value={NEW_GROUP}>+ Create new group…</option>
                    </Select>
                  )}
                </div>
              </Field>
              <Field label="Type">
                <Select className="input" value={f.device_type} onChange={(e) => set("device_type", e.target.value as DeviceType)}>
                  {Object.entries(DEVICE_TYPE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Location" optional hint="Shown on the map on the Overview page.">
                <LocationPicker value={loc} onChange={setLoc} error={errors.location} />
              </Field>
            </div>

            {cloning && cloneFrom && (
              <div className="rounded-xl border border-border bg-surface-2/40 px-4 py-3 text-[13px]">
                <p className="font-medium">Copied from {cloneFrom.name}</p>
                {cloneFrom.connections.length ? (
                  <>
                    <p className="mt-1.5 flex flex-wrap items-center gap-2 text-muted">
                      Connection methods:
                      {cloneFrom.connections.map((c) => (
                        <span key={c.id} className="inline-flex items-center gap-1.5">
                          <ProtocolBadge protocol={c.protocol} />
                          <span className="font-mono text-xs text-subtle">:{c.port}</span>
                        </span>
                      ))}
                    </p>
                    <label className="mt-2 flex cursor-pointer items-start gap-2 text-muted">
                      <input type="checkbox" className="mt-0.5" checked={copySecrets} onChange={(e) => setCopySecrets(e.target.checked)} />
                      <span>
                        Copy the saved passwords and keys too
                        <span className="block text-xs text-subtle">Only when the original is yours (or shared and you are an administrator). The new machine's SSH host key and RDP certificate are recorded on its first connection.</span>
                      </span>
                    </label>
                  </>
                ) : (
                  <p className="mt-1 text-muted">The original has no connection methods; add them on the new device.</p>
                )}
              </div>
            )}

            {(() => {
              const details = (
                <div className="space-y-4">
                  <div className="grid gap-x-4 gap-y-4 sm:grid-cols-3">
                    <Field label="Hostname" optional hint="The computer's own name." error={errors.hostname}>
                      <input className="input font-mono" value={f.hostname} onChange={(e) => set("hostname", e.target.value)} placeholder="PC-01" spellCheck={false} autoCapitalize="off" />
                    </Field>
                    <Field label="MAC address" optional hint="For Wake-on-LAN; learned over SSH." error={errors.mac}>
                      <input className="input font-mono" value={f.mac} onChange={(e) => set("mac", e.target.value)} placeholder="aa:bb:cc:dd:ee:ff" spellCheck={false} autoCapitalize="off" />
                    </Field>
                    <Field label="Wake broadcast" optional hint="Default: x.x.x.255 of its /24." error={errors.wol_broadcast}>
                      <input className="input font-mono" value={f.wol_broadcast} onChange={(e) => set("wol_broadcast", e.target.value)} placeholder="192.168.1.255" spellCheck={false} />
                    </Field>
                  </div>
                  <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
                    <Field label="Tags" optional error={errors.tags}>
                      <TagInput id="device-tags" value={f.tags} onChange={(v) => set("tags", v)} suggestions={tagSuggestions} />
                    </Field>
                    <Field label="Description" optional error={errors.description}>
                      <input className="input" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Short description" maxLength={500} />
                    </Field>
                  </div>
                  <Field label="Notes" optional error={errors.notes}>
                    <textarea className="input min-h-[60px] text-[13px]" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Anything worth remembering. Do not store passwords here." maxLength={10000} />
                  </Field>
                </div>
              );
              return editing ? (
                <section aria-label="Details">
                  <h3 className="mb-3 border-t border-border pt-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">Details</h3>
                  {details}
                </section>
              ) : (
                <details className="group rounded-xl border border-border">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
                    More details
                    <span className="text-xs font-normal text-subtle group-open:hidden">Hostname, MAC, tags, notes</span>
                  </summary>
                  <div className="border-t border-border px-4 py-4">{details}</div>
                </details>
              );
            })()}
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <span className="label">How do you connect to {f.name || "this device"}?</span>
              <p className="mb-3 text-xs text-muted">Select the services enabled on the computer. Nothing is installed on it.</p>
              <div className="space-y-2">
                {(SUGGESTED_PROTOCOLS[f.os] as Protocol[]).map((p) => {
                  const on = methods[p] !== undefined;
                  return (
                    <div
                      key={p}
                      className={clsx(
                        "flex items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors",
                        on ? "border-fg/70 bg-surface-2 ring-1 ring-fg/40" : "border-border",
                      )}
                    >
                      <input
                        type="checkbox"
                        id={`m-${p}`}
                        checked={on}
                        onChange={(e) =>
                          setMethods((m) => {
                            const n = { ...m };
                            if (e.target.checked) n[p] = DEFAULT_PORTS[p];
                            else delete n[p];
                            return n;
                          })
                        }
                        className="h-4 w-4 accent-[rgb(var(--fg))]"
                      />
                      <label htmlFor={`m-${p}`} className="min-w-0 flex-1 cursor-pointer">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {PROTOCOL_LABELS[p]}
                          {UNENCRYPTED[p] && (
                            <span className="rounded border border-warning/30 bg-warning/10 px-1.5 text-[10px] font-medium text-warning">Unencrypted</span>
                          )}
                        </span>
                        <span className="block text-xs text-muted">{PROTOCOL_HINT[p]}</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted">
                        Port
                        <input
                          type="number"
                          aria-label={`${PROTOCOL_LABELS[p]} port`}
                          className="input h-8 w-20 px-2 font-mono text-xs"
                          value={methods[p] ?? DEFAULT_PORTS[p]}
                          disabled={!on}
                          min={1}
                          max={65535}
                          onChange={(e) => setMethods((m) => ({ ...m, [p]: Number(e.target.value) }))}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="label">Sign-in</span>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Sign-in">
                <OptionCard selected={signIn === "prompt"} onClick={() => setSignIn("prompt")} title="Ask when connecting" description="Nothing is stored. You type the password in the session window." />
                <OptionCard selected={signIn === "store"} onClick={() => setSignIn("store")} title="Save username and password" description="Encrypted in the vault, never shown again." />
                <OptionCard
                  selected={signIn === "credential"}
                  onClick={() => setSignIn("credential")}
                  title="Use a saved credential"
                  description={`${credentials.data?.length ?? 0} saved. Shared by several devices.`}
                />
              </div>
              {signIn === "credential" && (
                <div className="mt-3 rounded-lg border border-border bg-surface-2/40 p-4">
                  {(credentials.data ?? []).length === 0 ? (
                    <p className="text-xs text-muted">
                      No saved credentials yet. Create one on the <b className="font-medium text-fg">Credentials</b> page (sidebar), or save the
                      username and password here instead.
                    </p>
                  ) : (
                    <Field label="Credential" error={errors.credential_id}>
                      <Select className="input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)} autoFocus>
                        <option value="">Select a credential…</option>
                        {credentials.data!.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.username ? ` (${c.domain ? c.domain + "\\" : ""}${c.username})` : ""}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
              )}
              {signIn === "store" && (
                <div className="mt-3 grid gap-4 rounded-lg border border-border bg-surface-2/40 p-4 sm:grid-cols-2">
                  <Field label="Username" error={errors.username}>
                    <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
                  </Field>
                  <Field label="Password" error={errors["secret.password"]}>
                    <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  </Field>
                  {methods.rdp !== undefined && (
                    <Field label="Domain" optional hint="Windows domain, if any." error={errors.domain}>
                      <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" spellCheck={false} />
                    </Field>
                  )}
                </div>
              )}
            </div>

            <p className="flex gap-2 rounded-lg border border-border bg-surface-2/40 px-3.5 py-3 text-xs text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Ready to use right away. The server's certificate or SSH host key is recorded automatically on the first connection, and
                emremote warns you if it ever changes.
              </span>
            </p>
          </>
        )}
      </form>
    </Dialog>
  );
}
