import { useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Select } from "@/components/ui/Select";
import { Zap } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Switch } from "@/components/ui/Field";
import { ApiError, errorMessage, post } from "@/lib/api";
import type { Connection, Device, OS, Protocol } from "@/lib/types";
import { DEFAULT_PORTS, PROTOCOL_HINT, PROTOCOL_LABELS, UNENCRYPTED } from "@/lib/constants";
import { useCredentials, useInvalidateInventory } from "@/hooks/queries";
import { addToWorkspace, closeIfBlank, openWorkspaceWindow } from "@/lib/launch";

const PROTOCOLS: Protocol[] = ["rdp", "ssh", "vnc", "telnet"];
const OS_FOR: Record<Protocol, OS> = { rdp: "windows", ssh: "linux", vnc: "other", telnet: "other" };

/**
 * Connect to a computer without adding it to the inventory. The password is
 * sent once to the server and kept in its memory for this browser session only.
 * Optionally the target is saved as a device instead.
 */
export function QuickConnectDialog({
  open,
  onOpenChange,
  onLaunch,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Where to open the session. Default: the workspace window. */
  onLaunch?: (connectionId: string) => void;
}) {
  const [protocol, setProtocol] = useState<Protocol>("rdp");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(DEFAULT_PORTS.rdp);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [save, setSave] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const credentials = useCredentials();
  const invalidate = useInvalidateInventory();

  useEffect(() => {
    if (open) {
      setPassword("");
      setErrors({});
      setFormError("");
    }
  }, [open]);

  const pickProtocol = (p: Protocol) => {
    if (port === DEFAULT_PORTS[protocol]) setPort(DEFAULT_PORTS[p]);
    setProtocol(p);
  };

  const usesUser = protocol !== "vnc";
  const cred = credentialId || null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!host.trim()) {
      setErrors({ host: "Required" });
      return;
    }
    // Open the window now: browsers block pop-ups opened after an await.
    const win = onLaunch ? null : openWorkspaceWindow();
    setBusy(true);
    setErrors({});
    setFormError("");
    const conn = {
      protocol,
      port,
      name: PROTOCOL_LABELS[protocol],
      username: usesUser && !cred ? username.trim() : "",
      domain: protocol === "rdp" && !cred ? domain.trim() : "",
      credential_id: cred,
      settings: {},
      secret: password && !cred ? { mode: "set", password } : { mode: "keep" },
    };
    try {
      let id: string;
      if (save) {
        const d = await post<Device>("/api/devices", {
          name: name.trim() || host.trim(),
          hostname: "",
          address: host.trim(),
          os: OS_FOR[protocol],
          device_type: protocol === "telnet" ? "network" : "other",
          description: "",
          notes: "",
          tags: [],
          group_id: null,
          favorite: false,
        });
        try {
          id = (await post<Connection>(`/api/devices/${d.id}/connections`, conn)).id;
        } finally {
          await invalidate();
        }
      } else {
        id = (await post<Connection>("/api/quick-connections", { ...conn, host: host.trim() })).id;
      }
      if (onLaunch) onLaunch(id);
      else addToWorkspace(win, id);
      setPassword("");
      onOpenChange(false);
    } catch (err) {
      closeIfBlank(win);
      if (err instanceof ApiError && err.fields) {
        const f = { ...err.fields };
        if (f.address) f.host = f.address;
        setErrors(f);
      }
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick connect"
      description="Connect to a computer without adding it first. Nothing is saved unless you choose to."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="quick-connect" loading={busy} icon={<Zap className="h-4 w-4" />}>
            {save ? "Save & connect" : "Connect"}
          </Button>
        </>
      }
    >
      <form noValidate id="quick-connect" onSubmit={submit} className="space-y-4" autoComplete="off">
        <div>
          <span className="label">Method</span>
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-surface-2 p-1" role="radiogroup" aria-label="Method">
            {PROTOCOLS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={protocol === p}
                onClick={() => pickProtocol(p)}
                className={clsx(
                  "rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
                  protocol === p ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {PROTOCOL_LABELS[p]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-subtle">
            {PROTOCOL_HINT[protocol]}
            {UNENCRYPTED[protocol] && <span className="ml-1 font-medium text-warning">Unencrypted. Use only on trusted networks.</span>}
          </p>
        </div>

        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label="Host" error={errors.host} hint={!errors.host ? "IP address or hostname" : undefined}>
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.20" autoFocus spellCheck={false} />
          </Field>
          <Field label="Port" error={errors.port}>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 0)}
            />
          </Field>
        </div>

        {(credentials.data ?? []).length > 0 && (
          <Field label="Sign in with" error={errors.credential_id}>
            <Select className="input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
              <option value="">Enter a user name and password</option>
              {credentials.data!.map((c) => (
                <option key={c.id} value={c.id}>
                  Saved: {c.name}
                  {c.username ? ` (${c.username})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {!cred && (
          <div className={clsx("grid gap-3", usesUser ? "grid-cols-2" : "grid-cols-1")}>
            {usesUser && (
              <Field label="User name" error={errors.username} optional>
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoComplete="off" />
              </Field>
            )}
            <Field label="Password" error={errors["secret.password"]} optional hint={!usesUser ? "VNC password, if the server uses one" : undefined}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
            {protocol === "rdp" && (
              <Field label="Domain" error={errors.domain} optional className="col-span-2">
                <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} spellCheck={false} />
              </Field>
            )}
          </div>
        )}
        {!cred && !password && (
          <p className="-mt-1 text-xs text-subtle">Leave the password empty to be asked when the session starts.</p>
        )}

        <div className="rounded-lg border border-border px-3 py-2">
          <Switch checked={save} onChange={setSave} label="Save as a device" description="Adds it to Devices so you can connect again later." />
          {save && (
            <Field label="Device name" optional className="pb-1 pt-2">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={host || "e.g. Office PC"} />
            </Field>
          )}
        </div>

        {formError && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</p>}
      </form>
    </Dialog>
  );
}
