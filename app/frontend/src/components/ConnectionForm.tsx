import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, ShieldCheck, Download, KeyRound } from "lucide-react";
import { Select } from "@/components/ui/Select";
import clsx from "clsx";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field, Segmented, Switch } from "./ui/Field";
import { OptionCard } from "./DeviceForm";
import { KeyFileInput } from "./KeyFileInput";
import { ApiError, errorMessage, post, put } from "@/lib/api";
import type {
  Connection,
  Protocol,
  RDPCertificate,
  RDPSettings,
  SecretInput,
  SSHHostKey,
  SSHSettings,
  Settings,
  TelnetSettings,
  VNCSettings,
} from "@/lib/types";
import {
  DEFAULT_PORTS,
  DEFAULT_SETTINGS,
  KEYBOARD_LAYOUTS,
  PROTOCOL_HINT,
  TERMINAL_FONTS,
  TERMINAL_THEMES,
  PROTOCOL_LABELS,
  RDP_PRESETS,
  VNC_PRESETS,
  type QualityPreset,
} from "@/lib/constants";
import { useConnections, useCredentials, useDevices, useInvalidateInventory, useSystem } from "@/hooks/queries";
import { dateTime } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";

type AuthMode = "prompt" | "stored" | "credential";
export type ConnectionTab = "general" | "signin" | "display" | "security" | "terminal" | "advanced";

const TAB_LABELS: Record<ConnectionTab, string> = {
  general: "General",
  signin: "Sign-in",
  display: "Display",
  security: "Security",
  terminal: "Terminal",
  advanced: "Advanced",
};

function tabsFor(p: Protocol): ConnectionTab[] {
  if (p === "rdp") return ["general", "signin", "display", "security", "advanced"];
  if (p === "vnc") return ["general", "signin", "display", "advanced"];
  if (p === "telnet") return ["general", "signin", "terminal", "advanced"];
  return ["general", "signin", "security", "terminal", "advanced"];
}

/** Which tab a server-side validation error belongs to. */
function tabForField(field: string): ConnectionTab {
  if (field.startsWith("secret") || ["username", "domain", "credential_id"].includes(field)) return "signin";
  if (/cert_|ignore_cert|security|host_key/.test(field)) return "security";
  if (/font|color_scheme|scrollback|terminal|server_alive/.test(field)) return "terminal";
  if (/color_depth|resize|quality|compress|lossless/.test(field)) return "display";
  if (field.startsWith("settings.")) return "advanced";
  return "general";
}

function presetOf(protocol: Protocol, s: Settings): QualityPreset | "custom" {
  const table = protocol === "rdp" ? RDP_PRESETS : protocol === "vnc" ? VNC_PRESETS : null;
  if (!table) return "custom";
  for (const [name, p] of Object.entries(table) as [QualityPreset, Record<string, unknown>][]) {
    if (Object.entries(p).every(([k, v]) => (s as unknown as Record<string, unknown>)[k] === v)) return name;
  }
  return "custom";
}

function Pane({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border">
      {title && <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-[0.05em] text-subtle">{title}</div>}
      <div className="divide-y divide-border px-4 [&>*]:py-2">{children}</div>
    </div>
  );
}

/** Whether the server identity of a connection is verified (for badges and tab hints). */
export function identityState(c: Pick<Connection, "protocol" | "settings">): "verified" | "insecure" | "unverified" | null {
  if (c.protocol === "rdp") {
    const s = c.settings as RDPSettings;
    if (s.cert_fingerprints) return "verified";
    if (s.ignore_cert) return "insecure";
    return "unverified";
  }
  if (c.protocol === "ssh") return (c.settings as SSHSettings).host_key ? "verified" : "unverified";
  return null;
}

export function ConnectionFormDialog({
  open,
  onOpenChange,
  deviceId,
  connection,
  initialProtocol = "rdp",
  initialTab = "general",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  deviceId: string;
  connection?: Connection;
  initialProtocol?: Protocol;
  initialTab?: ConnectionTab;
}) {
  const [tab, setTab] = useState<ConnectionTab>(initialTab);
  const [protocol, setProtocol] = useState<Protocol>(initialProtocol);
  const [name, setName] = useState("");
  const [port, setPort] = useState<number>(DEFAULT_PORTS[initialProtocol]);
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("prompt");
  const [credentialId, setCredentialId] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [replaceSecret, setReplaceSecret] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS.rdp);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const credentials = useCredentials();
  const invalidate = useInvalidateInventory();
  const qc = useQueryClient();

  const hasStored = !!connection && connection.secret_fields.length > 0;

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError("");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setReplaceSecret(false);
    setTab(initialTab);
    if (connection) {
      setProtocol(connection.protocol);
      setName(connection.name);
      setPort(connection.port);
      setUsername(connection.username);
      setDomain(connection.domain);
      setCredentialId(connection.credential_id ?? "");
      setAuthMode(connection.credential_id ? "credential" : connection.secret_fields.length ? "stored" : "prompt");
      setSettings({ ...DEFAULT_SETTINGS[connection.protocol], ...connection.settings } as Settings);
    } else {
      setProtocol(initialProtocol);
      setName(PROTOCOL_LABELS[initialProtocol]);
      setPort(DEFAULT_PORTS[initialProtocol]);
      setUsername("");
      setDomain("");
      setCredentialId("");
      setAuthMode("prompt");
      setSettings(DEFAULT_SETTINGS[initialProtocol]);
    }
  }, [open, connection, initialProtocol, initialTab]);

  const system = useSystem();
  const allConnections = useConnections();
  const allDevices = useDevices();
  const jumpEnabled = !!system.data?.jump_enabled || !!(settings as { jump_connection_id?: string }).jump_connection_id;
  const jumpId = (settings as { jump_connection_id?: string }).jump_connection_id ?? "";
  const ownerOfDevice = connection ? connection.device_owner_id : (allDevices.data ?? []).find((d) => d.id === deviceId)?.owner_id ?? null;
  const jumpOptions = (allConnections.data ?? []).filter(
    (c) => c.protocol === "ssh" && c.id !== connection?.id && c.device_owner_id === ownerOfDevice && !(c.settings as { jump_connection_id?: string }).jump_connection_id,
  );
  const tabs = tabsFor(protocol);
  const activeTab = tabs.includes(tab) ? tab : "general";

  const changeProtocol = (p: Protocol) => {
    setProtocol(p);
    setPort(DEFAULT_PORTS[p]);
    if (!name || Object.values(PROTOCOL_LABELS).includes(name)) setName(PROTOCOL_LABELS[p]);
    setSettings(DEFAULT_SETTINGS[p]);
    if (p !== "rdp") setDomain("");
  };

  const upd = <S extends Settings>(patch: Partial<S>) => setSettings((s) => ({ ...s, ...patch }) as Settings);
  const rdp = settings as RDPSettings;
  const vnc = settings as VNCSettings;
  const ssh = settings as SSHSettings;
  const telnet = settings as TelnetSettings;

  const errorTabs = useMemo(() => new Set(Object.keys(errors).map(tabForField)), [errors]);
  const identity = identityState({ protocol, settings });

  const buildSecret = (): SecretInput => {
    if (authMode !== "stored") return hasStored ? { mode: "clear" } : { mode: "keep" };
    if (hasStored && !replaceSecret) return { mode: "keep" };
    return { mode: "set", password, private_key: protocol === "ssh" ? privateKey : "", passphrase: protocol === "ssh" ? passphrase : "" };
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError("");
    const body = {
      name,
      protocol,
      port: Number(port),
      username,
      domain: protocol === "rdp" ? domain : "",
      credential_id: authMode === "credential" ? credentialId || null : null,
      settings,
      secret: buildSecret(),
    };
    try {
      if (connection) await put(`/api/connections/${connection.id}`, body);
      else await post(`/api/devices/${deviceId}/connections`, body);
      await invalidate();
      await qc.invalidateQueries({ queryKey: ["devices", deviceId] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields ?? {});
        const first = Object.keys(err.fields ?? {})[0];
        if (first) setTab(tabForField(first));
      }
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const preset = presetOf(protocol, settings);

  const panes: Record<ConnectionTab, ReactNode> = {
    general: (
      <Pane title="General" description={PROTOCOL_HINT[protocol]}>
        {protocol === "telnet" && (
          <p className="flex gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-3 text-xs text-muted">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              Telnet is <b className="font-medium text-fg">not encrypted</b>: everything you type, including the password, crosses the
              network in plain text. Use it only on trusted networks for devices that have no SSH.
            </span>
          </p>
        )}
        {!connection && (
          <div>
            <span className="label">Protocol</span>
            <Segmented
              ariaLabel="Protocol"
              value={protocol}
              onChange={changeProtocol}
              options={(["rdp", "vnc", "ssh", "telnet"] as Protocol[]).map((p) => ({ value: p, label: PROTOCOL_LABELS[p] }))}
            />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_130px]">
          <Field label="Name" hint="Shown on the device page, e.g. “RDP” or “Admin console”." error={errors.name}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
          </Field>
          <Field label="Port" error={errors.port}>
            <input className="input font-mono" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </Field>
        </div>
        {protocol === "rdp" && (
          <Field label="Keyboard layout" hint="Automatic uses this computer's layout (e.g. Turkish Q). Choose a fixed layout only if the remote computer uses a different one." error={errors["settings.server_layout"]}>
            <Select className="input" value={rdp.server_layout} onChange={(e) => upd<RDPSettings>({ server_layout: e.target.value })}>
              {KEYBOARD_LAYOUTS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Pane>
    ),

    signin: (
      <Pane title="Sign-in" description="Secrets are encrypted on the server and never sent to the browser.">
        <div className="space-y-2" role="radiogroup" aria-label="Authentication mode">
          <OptionCard selected={authMode === "prompt"} onClick={() => setAuthMode("prompt")} title="Ask when connecting" description="Nothing is stored. If the server needs credentials, the session window asks for them." />
          <OptionCard selected={authMode === "stored"} onClick={() => setAuthMode("stored")} title="Save for this connection" description="Store a username and password (or SSH key) for this connection only." />
          <OptionCard selected={authMode === "credential"} onClick={() => setAuthMode("credential")} title="Use a saved credential" description="Share one login across several devices. Manage them under Credentials." />
        </div>

        {authMode === "credential" && (
          <Field label="Credential" error={errors.credential_id} hint={credentials.data?.length === 0 ? "No saved credentials yet. Create one on the Credentials page." : undefined}>
            <Select className="input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
              <option value="">Select a credential…</option>
              {(credentials.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.username ? ` (${c.domain ? c.domain + "\\" : ""}${c.username})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Username"
            optional
            error={errors.username}
            hint={authMode === "credential" ? "Leave empty to use the credential's username." : protocol === "vnc" ? "Only some VNC servers (e.g. macOS) use a username." : undefined}
          >
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" />
          </Field>
          {protocol === "rdp" && (
            <Field label="Domain" optional error={errors.domain}>
              <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          )}
        </div>

        {authMode === "stored" &&
          (hasStored && !replaceSecret ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm">
              <span className="flex items-center gap-2 text-muted">
                <KeyRound className="h-4 w-4 text-success" />
                Saved: {connection!.secret_fields.join(", ").replace("_", " ")}
              </span>
              <Button size="sm" onClick={() => setReplaceSecret(true)}>
                Change
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="Password" error={errors["secret.password"]} optional={protocol === "ssh"}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
              {protocol === "ssh" && (
                <>
                  <Field label="Private key" optional hint="A key file in OpenSSH or PEM format (RSA, ECDSA, Ed25519). Used instead of, or together with, the password. It is stored encrypted, like passwords.">
                    <KeyFileInput value={privateKey} onChange={setPrivateKey} error={errors["secret.private_key"]} />
                  </Field>
                  <Field label="Key passphrase" optional error={errors["secret.passphrase"]}>
                    <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
                  </Field>
                </>
              )}
            </div>
          ))}
        {authMode !== "stored" && hasStored && <p className="text-xs text-warning">The password saved for this connection will be deleted when you save.</p>}
      </Pane>
    ),

    display: (
      <Pane
        title="Display"
        description={
          protocol === "rdp"
            ? "The resolution follows your browser window automatically. Choose how to balance image quality and bandwidth."
            : "The resolution is set by the VNC server and scaled to your window. JPEG quality only applies if the server supports it."
        }
      >
        <div className="space-y-2" role="radiogroup" aria-label="Quality">
          <OptionCard selected={preset === "best"} onClick={() => upd(protocol === "rdp" ? RDP_PRESETS.best : VNC_PRESETS.best)} title="Best quality" description="Lossless image encoding, full color and desktop effects. Best on a fast local network." />
          <OptionCard selected={preset === "balanced"} onClick={() => upd(protocol === "rdp" ? RDP_PRESETS.balanced : VNC_PRESETS.balanced)} title="Balanced (recommended)" description="Full color with adaptive compression. Sharp text, light on bandwidth." />
          <OptionCard selected={preset === "bandwidth"} onClick={() => upd(protocol === "rdp" ? RDP_PRESETS.bandwidth : VNC_PRESETS.bandwidth)} title="Low bandwidth" description="Reduced color depth and no visual effects, for slow links." />
          {preset === "custom" && <p className="text-xs text-subtle">Custom settings are active (see below).</p>}
        </div>

        {protocol === "rdp" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Color depth">
              <Select className="input" value={rdp.color_depth} onChange={(e) => upd<RDPSettings>({ color_depth: Number(e.target.value) })}>
                <option value={32}>32-bit (true color)</option>
                <option value={24}>24-bit</option>
                <option value={16}>16-bit (high color)</option>
                <option value={8}>8-bit (256 colors)</option>
              </Select>
            </Field>
            <Field label="When the window is resized">
              <Select className="input" value={rdp.resize_method} onChange={(e) => upd<RDPSettings>({ resize_method: e.target.value as RDPSettings["resize_method"] })}>
                <option value="display-update">Resize live (Windows 8.1 and later)</option>
                <option value="reconnect">Reconnect at new size (older Windows)</option>
                <option value="none">Keep size and scale</option>
              </Select>
            </Field>
          </div>
        )}
        {protocol === "rdp" && (
          <Group title="Image and effects">
            <Switch checked={rdp.force_lossless} onChange={(v) => upd<RDPSettings>({ force_lossless: v })} label="Lossless image encoding" description="Sharpest text; uses more bandwidth." />
            <Switch checked={rdp.enable_font_smoothing} onChange={(v) => upd<RDPSettings>({ enable_font_smoothing: v })} label="Font smoothing (ClearType)" />
            <Switch checked={!rdp.disable_gfx} onChange={(v) => upd<RDPSettings>({ disable_gfx: !v })} label="Graphics pipeline (RDPGFX)" description="Faster screen updates on modern Windows." />
            <Switch checked={rdp.enable_wallpaper} onChange={(v) => upd<RDPSettings>({ enable_wallpaper: v })} label="Show wallpaper" />
            <Switch checked={rdp.enable_theming} onChange={(v) => upd<RDPSettings>({ enable_theming: v })} label="Visual themes" />
            <Switch checked={rdp.enable_desktop_composition} onChange={(v) => upd<RDPSettings>({ enable_desktop_composition: v })} label="Desktop composition (transparency)" />
            <Switch checked={rdp.enable_full_window_drag} onChange={(v) => upd<RDPSettings>({ enable_full_window_drag: v })} label="Show window contents while dragging" />
            <Switch checked={rdp.enable_menu_animations} onChange={(v) => upd<RDPSettings>({ enable_menu_animations: v })} label="Menu animations" />
          </Group>
        )}

        {protocol === "vnc" && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Color depth">
                <Select className="input" value={vnc.color_depth} onChange={(e) => upd<VNCSettings>({ color_depth: Number(e.target.value) })}>
                  <option value={32}>32-bit</option>
                  <option value={24}>24-bit</option>
                  <option value={16}>16-bit</option>
                  <option value={8}>8-bit</option>
                </Select>
              </Field>
              <Field label="JPEG quality" hint="0 (low) to 9 (high)">
                <Select className="input" value={vnc.quality_level} onChange={(e) => upd<VNCSettings>({ quality_level: Number(e.target.value) })}>
                  <option value={-1}>Server default</option>
                  {Array.from({ length: 10 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Compression" hint="0 (fast) to 9 (small)">
                <Select className="input" value={vnc.compress_level} onChange={(e) => upd<VNCSettings>({ compress_level: Number(e.target.value) })}>
                  <option value={-1}>Server default</option>
                  {Array.from({ length: 10 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Group>
              <Switch checked={vnc.force_lossless} onChange={(v) => upd<VNCSettings>({ force_lossless: v })} label="Lossless image encoding" />
              <Switch checked={vnc.cursor === "remote"} onChange={(v) => upd<VNCSettings>({ cursor: v ? "remote" : "local" })} label="Draw cursor on the server" description="Use if the mouse pointer is invisible or misplaced." />
              <Switch checked={vnc.swap_red_blue} onChange={(v) => upd<VNCSettings>({ swap_red_blue: v })} label="Swap red and blue" description="Fixes wrong colors on some servers." />
            </Group>
          </>
        )}
      </Pane>
    ),

    security: (
      <Pane
        title={protocol === "rdp" ? "Security" : "Host key"}
        description={protocol === "rdp" ? "Verify that you are connecting to the real computer, not an impostor on the network." : "Pin the server's host key so a different machine cannot impersonate it."}
      >
        {protocol === "rdp" ? (
          <>
            <Field label="Security mode" error={errors["settings.security"]}>
              <Select className="input" value={rdp.security} onChange={(e) => upd<RDPSettings>({ security: e.target.value as RDPSettings["security"] })}>
                <option value="any">Negotiate</option>
                <option value="nla">NLA (Network Level Authentication)</option>
                <option value="nla-ext">NLA extended</option>
                <option value="tls">TLS</option>
                <option value="rdp">Legacy RDP encryption</option>
                <option value="vmconnect">Hyper-V VMConnect</option>
              </Select>
            </Field>
            <RdpCertificatePanel connection={connection} settings={rdp} onChange={(p) => upd<RDPSettings>(p)} error={errors["settings.cert_fingerprints"]} />
          </>
        ) : (
          <SshHostKeyPanel connection={connection} settings={ssh} onChange={(p) => upd<SSHSettings>(p)} error={errors["settings.host_key"]} />
        )}
      </Pane>
    ),

    terminal: (
      <Pane title="Terminal" description="How the terminal is rendered in your browser.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Font size" error={errors["settings.font_size"]}>
            <input className="input" type="number" min={6} max={48} value={ssh.font_size} onChange={(e) => upd<SSHSettings>({ font_size: Number(e.target.value) })} />
          </Field>
          <Field label="Color theme" error={errors["settings.color_scheme"]} hint="Anyone can override this for themselves from the session toolbar.">
            <div className="space-y-2">
              <Select className="input" value={ssh.color_scheme} onChange={(e) => upd<SSHSettings>({ color_scheme: e.target.value })}>
                {TERMINAL_THEMES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              {(() => {
                const t = TERMINAL_THEMES.find((x) => x.value === ssh.color_scheme) ?? TERMINAL_THEMES[0];
                return (
                  <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-xs" style={{ background: t.bg, color: t.fg }} aria-label="Theme preview">
                    <span>user@host:~$ ls</span>
                    {t.accents.map((c) => (
                      <span key={c} style={{ color: c }}>
                        ■
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
          </Field>
          <Field label="Font" error={errors["settings.font_name"]}>
            <Select className="input" value={ssh.font_name} onChange={(e) => upd<SSHSettings>({ font_name: e.target.value })}>
              {!TERMINAL_FONTS.includes(ssh.font_name) && <option value={ssh.font_name}>Default ({ssh.font_name})</option>}
              {TERMINAL_FONTS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </Field>
          <Field label="Scrollback lines" error={errors["settings.scrollback"]}>
            <input className="input" type="number" min={0} max={20000} value={ssh.scrollback} onChange={(e) => upd<SSHSettings>({ scrollback: Number(e.target.value) })} />
          </Field>
          <Field label="Terminal type">
            <Select className="input" value={ssh.terminal_type} onChange={(e) => upd<SSHSettings>({ terminal_type: e.target.value })}>
              {["xterm-256color", "xterm", "vt220", "vt100", "linux"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          {protocol === "ssh" && (
            <>
              <Field label="Backspace key sends" hint="Change if Backspace prints ^H or ^? on the server." error={errors["settings.backspace"]}>
                <Select className="input" value={ssh.backspace} onChange={(e) => upd<SSHSettings>({ backspace: Number(e.target.value) })}>
                  <option value={127}>DEL (127), most servers</option>
                  <option value={8}>BS (8, Ctrl+H)</option>
                </Select>
              </Field>
              <Field label="Locale" optional hint="For example en_US.UTF-8. Empty keeps the server's own setting." error={errors["settings.locale"]}>
                <input className="input" value={ssh.locale} onChange={(e) => upd<SSHSettings>({ locale: e.target.value })} placeholder="en_US.UTF-8" spellCheck={false} />
              </Field>
            </>
          )}
          {protocol === "ssh" ? (
            <Field label="Keep-alive interval (seconds)" hint="0 disables keep-alive." error={errors["settings.server_alive_interval"]}>
              <input className="input" type="number" min={0} max={3600} value={ssh.server_alive_interval} onChange={(e) => upd<SSHSettings>({ server_alive_interval: Number(e.target.value) })} />
            </Field>
          ) : (
            <Field label="Backspace key sends" hint="Change if Backspace prints ^H or ^? on the device." error={errors["settings.backspace"]}>
              <Select className="input" value={telnet.backspace} onChange={(e) => upd<TelnetSettings>({ backspace: Number(e.target.value) })}>
                <option value={127}>DEL (127), most devices</option>
                <option value={8}>BS (8, Ctrl+H)</option>
              </Select>
            </Field>
          )}
        </div>
      </Pane>
    ),

    advanced: (
      <Pane title="Advanced" description="Clipboard, input and session options.">
        {jumpEnabled && (
          <Group title="Connect through a jump host">
            <Field
              label="Jump host"
              optional
              error={errors["settings.jump_connection_id"]}
              hint="emremote signs in to this SSH connection and reaches the device from there. Use it for devices on a network only the jump host can see."
            >
              <Select className="input" value={jumpId} onChange={(e) => upd({ jump_connection_id: e.target.value })}>
                <option value="">None, connect directly</option>
                {jumpOptions.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.device_name} ({j.device_address}:{j.port})
                  </option>
                ))}
                {jumpId && !jumpOptions.some((j) => j.id === jumpId) && <option value={jumpId}>(unavailable jump host)</option>}
              </Select>
            </Field>
            {jumpId && <p className="text-xs text-subtle">The device's address must be an IP address inside the jump target networks set by the administrator. Reachability is not probed for these connections.</p>}
          </Group>
        )}
        <Group title="Clipboard and input">
          <Switch checked={(settings as RDPSettings).disable_copy} onChange={(v) => upd({ disable_copy: v })} label="Block copying from the remote computer" />
          <Switch checked={(settings as RDPSettings).disable_paste} onChange={(v) => upd({ disable_paste: v })} label="Block pasting to the remote computer" />
          <Switch checked={(settings as RDPSettings).read_only} onChange={(v) => upd({ read_only: v })} label="View only" description="Keyboard and mouse input are not sent." />
        </Group>
        {protocol === "rdp" && (
          <>
          <Group title="Session">
            <Switch checked={!rdp.disable_audio} onChange={(v) => upd<RDPSettings>({ disable_audio: !v })} label="Play remote audio in the browser" />
            <Switch checked={rdp.console} onChange={(v) => upd<RDPSettings>({ console: v })} label="Connect to the console session" description="Windows Server administrative console." />
            <Switch checked={rdp.enable_drive} onChange={(v) => upd<RDPSettings>({ enable_drive: v })} label="Transfer drive" description='Shows a drive named "emremote" inside the session for exchanging files with this browser.' />
            <Switch checked={rdp.enable_printing} onChange={(v) => upd<RDPSettings>({ enable_printing: v })} label="Printing" description='Adds a printer named "emremote" in Windows. What you print arrives in this browser as a PDF file.' />
            <Switch checked={rdp.enable_audio_input} onChange={(v) => upd<RDPSettings>({ enable_audio_input: v })} label="Microphone" description="Sends your microphone to the remote computer (the browser asks for permission)." />
          </Group>
          <Group title="Single application (RemoteApp)">
            <p className="text-xs text-subtle">
              Opens one program in its own window instead of the whole desktop. The server must allow it (Windows Server RemoteApp, or a
              program alias such as <span className="font-mono">||notepad</span>). Leave empty for the normal desktop.
            </p>
            <Field label="Program" optional error={errors["settings.remote_app"]}>
              <input className="input font-mono text-xs" value={rdp.remote_app} onChange={(e) => upd<RDPSettings>({ remote_app: e.target.value })} placeholder="||notepad" spellCheck={false} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Working folder" optional error={errors["settings.remote_app_dir"]}>
                <input className="input font-mono text-xs" value={rdp.remote_app_dir} onChange={(e) => upd<RDPSettings>({ remote_app_dir: e.target.value })} spellCheck={false} />
              </Field>
              <Field label="Arguments" optional error={errors["settings.remote_app_args"]}>
                <input className="input font-mono text-xs" value={rdp.remote_app_args} onChange={(e) => upd<RDPSettings>({ remote_app_args: e.target.value })} spellCheck={false} />
              </Field>
            </div>
          </Group>
          <Group title="Hyper-V virtual machine">
            <p className="text-xs text-subtle">
              Connects to the console of a VM on a Hyper-V host (port 2179, security "Hyper-V VMConnect"), even before Windows has started.
              Enter the VM's name or id. The host's Hyper-V Virtual Machine Management service must allow your account.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="VM name or id" optional error={errors["settings.preconnection_blob"]}>
                <input className="input" value={rdp.preconnection_blob} onChange={(e) => upd<RDPSettings>({ preconnection_blob: e.target.value })} spellCheck={false} />
              </Field>
              <Field label="Preconnection ID" optional hint="Only if your host uses one." error={errors["settings.preconnection_id"]}>
                <input className="input" type="number" min={0} value={rdp.preconnection_id || ""} onChange={(e) => upd<RDPSettings>({ preconnection_id: Number(e.target.value) || 0 })} />
              </Field>
            </div>
          </Group>
          </>
        )}
        {protocol === "telnet" && (
          <Group title="Automatic sign-in">
            <p className="text-xs text-subtle">
              With a saved username and password, emremote types them when the device shows a matching prompt. Leave empty for the usual
              "login:" and "password:" prompts.
            </p>
            {(
              [
                ["username_regex", "Username prompt", "e.g. [Uu]ser ?[Nn]ame:"],
                ["password_regex", "Password prompt", "e.g. [Pp]assword:"],
                ["login_success_regex", "Signed-in pattern", "e.g. [#>]\\s*$"],
                ["login_failure_regex", "Sign-in failed pattern", "e.g. [Ii]ncorrect"],
              ] as [keyof TelnetSettings, string, string][]
            ).map(([k, label, ph]) => (
              <Field key={k} label={label} optional error={errors[`settings.${k}`]}>
                <input
                  className="input font-mono text-xs"
                  value={telnet[k] as string}
                  onChange={(e) => upd<TelnetSettings>({ [k]: e.target.value } as Partial<TelnetSettings>)}
                  placeholder={ph}
                  spellCheck={false}
                />
              </Field>
            ))}
          </Group>
        )}
        {protocol === "vnc" && (
          <Field label="Clipboard encoding">
            <Select className="input" value={vnc.clipboard_encoding} onChange={(e) => upd<VNCSettings>({ clipboard_encoding: e.target.value })}>
              {["UTF-8", "ISO8859-1", "UTF-16", "CP1252"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
          </Field>
        )}
      </Pane>
    ),
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={connection ? `${connection.name} settings` : "Add connection method"}
      description={connection ? `${connection.device_name} · ${connection.device_address}:${connection.port}` : undefined}
      size="xl"
      bodyClassName="p-0"
      footer={
        <>
          {formError && <p className="mr-auto max-w-[60%] text-sm text-danger">{formError}</p>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="connection-form" loading={busy}>
            {connection ? "Save changes" : "Add connection"}
          </Button>
        </>
      }
    >
      <form noValidate id="connection-form" onSubmit={submit} className="flex min-h-[460px] flex-col sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:p-3" aria-label="Settings sections">
          {tabs.map((t) => {
            const warn = t === "security" && identity === "insecure";
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-current={activeTab === t ? "page" : undefined}
                className={clsx(
                  "flex h-8 shrink-0 items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px]",
                  activeTab === t ? "bg-surface-3/70 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {t === "security" && protocol === "ssh" ? "Host key" : TAB_LABELS[t]}
                {errorTabs.has(t) ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" title="Has errors" />
                ) : warn ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Server identity not verified" />
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1 p-5 sm:p-6">{panes[activeTab]}</div>
      </form>
    </Dialog>
  );
}

function RdpCertificatePanel({
  connection,
  settings,
  onChange,
  error,
}: {
  connection?: Connection;
  settings: RDPSettings;
  onChange: (p: Partial<RDPSettings>) => void;
  error?: string;
}) {
  const [cert, setCert] = useState<RDPCertificate | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fetchCert = async () => {
    if (!connection) return;
    setBusy(true);
    setErr("");
    try {
      setCert(await post<RDPCertificate>(`/api/connections/${connection.id}/rdp-certificate`));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pinned = settings.cert_fingerprints.split(",").filter(Boolean);
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {pinned.length ? (
            <>
              <ShieldCheck className="h-4 w-4 text-success" /> Certificate pinned
            </>
          ) : settings.ignore_cert ? (
            <>
              <AlertTriangle className="h-4 w-4 text-warning" /> Certificate verification disabled
            </>
          ) : (
            <>
              <ShieldCheck className="h-4 w-4 text-muted" /> Recorded automatically on first connection
            </>
          )}
        </div>
        <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={fetchCert} loading={busy} disabled={!connection}>
          Fetch certificate
        </Button>
      </div>

      {pinned.length > 0 && (settings.security === "any" || settings.security === "rdp") && (
        <p className="text-xs text-warning">Choose TLS or NLA security above: a pinned certificate cannot protect legacy RDP encryption.</p>
      )}
      <p className="text-xs text-subtle">
        emremote remembers the server's certificate the first time you connect and stops the connection if it ever changes. If you
        replaced the certificate on purpose, fetch the new one here and trust it.
      </p>
      {err && <p className="text-xs text-danger">{err}</p>}
      {cert && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-3 text-xs">
          <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1">
            <dt className="text-subtle">Subject</dt>
            <dd className="break-all font-mono">{cert.subject}</dd>
            <dt className="text-subtle">Issuer</dt>
            <dd className="break-all font-mono">{cert.issuer}{cert.self_signed && <span className="ml-2 text-warning">(self-signed)</span>}</dd>
            <dt className="text-subtle">Valid</dt>
            <dd>{dateTime(cert.not_before)} → {dateTime(cert.not_after)}</dd>
            <dt className="text-subtle">SHA-256</dt>
            <dd className="break-all font-mono text-fg">{cert.sha256}</dd>
            <dt className="text-subtle">Negotiated</dt>
            <dd className="uppercase">{cert.protocol}</dd>
          </dl>
          <div className="flex items-center justify-end gap-3">
            <span className="text-2xs text-subtle">Remember to save the connection afterwards.</span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                // Lock the security mode to what the server negotiated so the
                // connection cannot be downgraded to legacy RDP (no certificate).
                const mode = (["tls", "nla", "nla-ext"].includes(cert.protocol) ? cert.protocol : "tls") as RDPSettings["security"];
                onChange({ cert_fingerprints: cert.fingerprint, ignore_cert: false, security: mode });
                setCert(null);
              }}
            >
              Trust this certificate
            </Button>
          </div>
        </div>
      )}
      <Field label="Pinned fingerprints" optional error={error} hint="Comma-separated, e.g. sha256:ab:cd:…">
        <input className="input font-mono text-xs" value={settings.cert_fingerprints} onChange={(e) => onChange({ cert_fingerprints: e.target.value })} spellCheck={false} />
      </Field>
      <div className={clsx("rounded-md", settings.ignore_cert && "border border-warning/30 bg-warning/5 px-3")}>
        <Switch
          checked={settings.ignore_cert}
          onChange={(v) => onChange({ ignore_cert: v })}
          label="Accept any certificate (not recommended)"
          description="Disables server identity verification. Anyone able to intercept traffic on your network could impersonate this computer and capture the credentials you type."
        />
      </div>
    </div>
  );
}

function SshHostKeyPanel({
  connection,
  settings,
  onChange,
  error,
}: {
  connection?: Connection;
  settings: SSHSettings;
  onChange: (p: Partial<SSHSettings>) => void;
  error?: string;
}) {
  const [key, setKey] = useState<SSHHostKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fetchKey = async () => {
    if (!connection) return;
    setBusy(true);
    setErr("");
    try {
      setKey(await post<SSHHostKey>(`/api/connections/${connection.id}/ssh-host-key`));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {settings.host_key ? (
            <>
              <ShieldCheck className="h-4 w-4 text-success" /> Host key pinned
            </>
          ) : (
            <>
              <ShieldCheck className="h-4 w-4 text-muted" /> Recorded automatically on first connection
            </>
          )}
        </div>
        <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={fetchKey} loading={busy} disabled={!connection}>
          Fetch host key
        </Button>
      </div>
      <p className="text-xs text-subtle">
        Like a normal SSH client, emremote remembers the host key on the first connection and refuses to connect if it later changes.
        After reinstalling the server, fetch the new key here and trust it.
      </p>
      {err && <p className="text-xs text-danger">{err}</p>}
      {key && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-3 text-xs">
          <p>
            <span className="text-subtle">Fingerprint ({key.type}):</span>{" "}
            <span className="break-all font-mono text-fg">{key.fingerprint}</span>
          </p>
          <p className="text-subtle">
            Compare with <span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</span> on the server.
          </p>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onChange({ host_key: key.key });
                setKey(null);
              }}
            >
              Trust this key
            </Button>
          </div>
        </div>
      )}
      <Field label="Pinned host key" optional error={error} hint='Format: "ssh-ed25519 AAAA…"'>
        <textarea className="input min-h-[60px] font-mono text-2xs" value={settings.host_key} onChange={(e) => onChange({ host_key: e.target.value })} spellCheck={false} />
      </Field>
    </div>
  );
}
