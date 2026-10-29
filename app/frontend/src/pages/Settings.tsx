import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { Monitor, Moon, Sun, Laptop, ShieldCheck, Server, Radio, TerminalSquare, Minus, Plus, RotateCcw, Check, Route, Timer, Globe, Video, X, KeyRound } from "lucide-react";
import clsx from "clsx";
import { PageHeader, Badge, ErrorState } from "@/components/ui/misc";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { TERMINAL_FONTS, TERMINAL_THEMES, DEFAULT_SSH } from "@/lib/constants";
import { loadTerminalPrefs, saveTerminalPrefs, type TerminalPrefs } from "@/lib/terminalPrefs";
import { PageLoader } from "@/components/ui/Spinner";
import { TwoFactorCard } from "@/components/TwoFactorCard";
import { useActiveSessions, useDevices, useLoginSessions, useSystem, keys } from "@/hooks/queries";
import { ApiError, del, errorMessage, get, post, put } from "@/lib/api";
import { useAuth, useAccess } from "@/lib/auth";
import { useTheme, type ThemePref } from "@/lib/theme";
import { bytes, dateTime, duration, relativeTime } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProtocolBadge } from "@/components/Status";
import { Switch } from "@/components/ui/Field";
import type { RecordingConfig, RecordingStorage, VaultPolicy } from "@/lib/types";
import { generatePassword } from "@/lib/vault";

function Card({ title, description, children, icon, id }: { title: string; description?: ReactNode; children: ReactNode; icon?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        {icon && <span className="mt-0.5 text-muted">{icon}</span>}
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** A titled group inside a card, separated from the one above by a line. */
function SubSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-subtle">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const FONT_STACKS: Record<string, string> = {
  "DejaVu Sans Mono": '"DejaVu Sans Mono", "Bitstream Vera Sans Mono", Menlo, Consolas, monospace',
  "Liberation Mono": '"Liberation Mono", "Courier New", Courier, monospace',
  Terminus: 'Terminus, "Terminus (TTF)", "DejaVu Sans Mono", monospace',
};

/** Terminal look for every SSH and Telnet session opened from this browser, with a live preview. */
function TerminalCard() {
  const [prefs, setPrefs] = useState<TerminalPrefs>(loadTerminalPrefs);
  const update = (p: Partial<TerminalPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveTerminalPrefs(next);
  };
  const theme = TERMINAL_THEMES.find((t) => t.value === (prefs.color_scheme ?? DEFAULT_SSH.color_scheme)) ?? TERMINAL_THEMES[0];
  const font = prefs.font_name ?? (TERMINAL_FONTS.includes(DEFAULT_SSH.font_name) ? DEFAULT_SSH.font_name : TERMINAL_FONTS[0]);
  const size = prefs.font_size ?? DEFAULT_SSH.font_size;
  const [red, green, yellow, blue] = theme.accents;
  const customized = !!(prefs.color_scheme || prefs.font_name || prefs.font_size);
  const dim = { opacity: 0.7 };
  return (
    <Card
      title="Terminal"
      description="Color theme, font and size for every SSH and Telnet session you open in this browser. Sessions already open pick it up when they reconnect."
      icon={<TerminalSquare className="h-4 w-4" />}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <div>
            <p className="label">Color theme</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Color theme">
              {TERMINAL_THEMES.map((t) => {
                const on = theme.value === t.value && !!prefs.color_scheme;
                return (
                  <button
                    key={t.value}
                    role="radio"
                    aria-checked={on}
                    onClick={() => update({ color_scheme: t.value })}
                    className={clsx("overflow-hidden rounded-md border text-left text-xs", on ? "border-accent ring-2 ring-accent/30" : "border-border hover:border-border-strong")}
                  >
                    <span className="flex h-9 items-center gap-1 px-2 font-mono text-[11px]" style={{ background: t.bg, color: t.fg }}>
                      Aa
                      {t.accents.map((c) => (
                        <span key={c} className="h-2.5 w-2 rounded-sm" style={{ background: c }} />
                      ))}
                      {on && <Check className="ml-auto h-3.5 w-3.5" />}
                    </span>
                    <span className="block truncate px-2 py-1.5">{t.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Font">
              <Select className="input" value={font} onChange={(e) => update({ font_name: e.target.value })}>
                {TERMINAL_FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
            <Field label={`Text size: ${size} pt`}>
              <div className="flex gap-2">
                <Button icon={<Minus className="h-4 w-4" />} aria-label="Smaller text" onClick={() => update({ font_size: Math.max(6, size - 1) })} />
                <Button icon={<Plus className="h-4 w-4" />} aria-label="Larger text" onClick={() => update({ font_size: Math.min(48, size + 1) })} />
              </div>
            </Field>
          </div>
          {customized ? (
            <Button icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { setPrefs({}); saveTerminalPrefs({}); }}>
              Use each connection's own look
            </Button>
          ) : (
            <p className="text-xs text-subtle">Nothing chosen yet: each connection uses its own look (set in its Terminal tab).</p>
          )}
        </div>
        <div>
          <p className="label">Preview</p>
          <div
            className="overflow-hidden rounded-lg border border-border shadow-sm"
            style={{ background: theme.bg, color: theme.fg, fontFamily: FONT_STACKS[font] ?? "monospace", fontSize: `${(size * 96) / 72}px`, lineHeight: 1.25 }}
            role="img"
            aria-label={`Terminal preview, ${theme.label}`}
          >
            <pre className="m-0 min-h-[260px] overflow-hidden whitespace-pre-wrap break-words p-3" style={{ font: "inherit" }}>
              tester@lab-ws:~$ ls -l{"\n"}
              <span style={dim}>total 12</span>
              {"\n"}drwxr-xr-x 2 tester tester 4096 Oct 14 09:12 <span style={{ color: blue }}>projects</span>
              {"\n"}-rwxr-xr-x 1 tester tester  812 Oct 13 18:40 <span style={{ color: green }}>backup.sh</span>
              {"\n"}-rw-r--r-- 1 tester tester 1.2K Oct 14 08:03 notes.txt{"\n"}
              tester@lab-ws:~$ grep -i -E "warn|error" app.log{"\n"}
              <span style={{ color: yellow }}>WARN</span>  disk usage at 87%{"\n"}
              <span style={{ color: red }}>ERROR</span> backup job failed (exit 1){"\n"}
              tester@lab-ws:~$ <span className="inline-block h-[1.1em] w-[0.6em] translate-y-[0.2em] animate-pulse" style={{ background: theme.fg }} />
            </pre>
            <div className="flex" aria-label="The 16 terminal colors">
              {theme.ansi.map((c, i) => (
                <span key={i} className="h-3 flex-1" style={{ background: c }} />
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-subtle">
            The prompt and the commands you type use the theme's text color. The other colors, shown in the strip, appear where programs on the remote computer ask for them (ls --color, grep, git, htop).
          </p>
        </div>
      </div>
    </Card>
  );
}

const RECORDING_PROTOCOLS = ["ssh", "rdp", "vnc", "telnet"];
const STORAGE_LABEL = { volume: "Docker volume (or a local disk)", nfs: "NFS share", smb: "SMB share" } as const;

/** Screen recording of remote sessions (administrators): what is recorded, for how long, and where it is kept. */
function RecordingCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const devices = useDevices();
  const [cfg, setCfg] = useState<RecordingConfig | null>(null);
  const [storage, setStorage] = useState<RecordingStorage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pick, setPick] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    get<{ config: RecordingConfig; storage: RecordingStorage }>("/api/settings/recording")
      .then((r) => {
        setCfg(r.config);
        setStorage(r.storage);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    setError("");
    try {
      // Exceptions of devices that no longer exist are dropped.
      const known = new Set((devices.data ?? []).map((d) => d.id));
      const kept = devices.data ? Object.fromEntries(Object.entries(cfg.devices).filter(([id]) => known.has(id))) : cfg.devices;
      const r = await put<{ config: RecordingConfig; storage: RecordingStorage }>("/api/settings/recording", { ...cfg, devices: kept });
      setCfg(r.config);
      setStorage(r.storage);
      setTestResult(null);
      qc.invalidateQueries({ queryKey: keys.system });
      toast.success("Recording settings saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const setTarget = (patch: Partial<RecordingConfig["storage"]>) => {
    if (!cfg) return;
    setTestResult(null);
    setCfg({ ...cfg, storage: { ...cfg.storage, ...patch } });
  };
  const testShare = async () => {
    if (!cfg) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await post<{ ok: boolean; message: string }>("/api/settings/recording/test", cfg));
    } catch (e) {
      setTestResult({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  const nameOf = (id: string) => devices.data?.find((d) => d.id === id)?.name ?? "Removed device";
  const exceptions = cfg ? Object.entries(cfg.devices) : [];
  const toggleProtocol = (p: string, on: boolean) => cfg && setCfg({ ...cfg, protocols: on ? [...cfg.protocols, p] : cfg.protocols.filter((x) => x !== p) });
  return (
    <Card
      title="Session recording"
      description="Record the screen of remote sessions and play them back under Recordings. The keyboard is never recorded."
      icon={<Video className="h-4 w-4" />}
    >
      {!cfg ? (
        <p className="text-sm text-muted">{error || "Loading…"}</p>
      ) : (
        <div className="space-y-5">
          <Switch
            checked={cfg.enabled}
            onChange={(v) => setCfg({ ...cfg, enabled: v })}
            label="Record remote sessions"
            description="Sessions started after you save are recorded, and show a REC mark in the toolbar. What the screen shows is recorded, including anything the remote computer displays."
          />
          <fieldset disabled={!cfg.enabled} className={clsx("space-y-5", !cfg.enabled && "opacity-60")}>
            <SubSection title="What to record" description="Every connection, or only the devices you pick. Exceptions apply to single devices either way.">
            <div role="radiogroup" aria-label="What to record" className="grid gap-2 sm:grid-cols-2">
              {[
                [true, "Every connection", "All devices are recorded; pick exceptions below."],
                [false, "Only chosen devices", "Nothing is recorded unless you add the device below."],
              ].map(([v, t, d]) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={cfg.record_all === v}
                  onClick={() => setCfg({ ...cfg, record_all: v as boolean })}
                  className={clsx("rounded-lg border px-3 py-2.5 text-left text-sm", cfg.record_all === v ? "border-fg/70 bg-surface-2 ring-1 ring-fg/40" : "border-border text-muted hover:border-border-strong")}
                >
                  <span className="block font-medium text-fg">{t as string}</span>
                  <span className="block text-xs text-subtle">{d as string}</span>
                </button>
              ))}
            </div>
            <div>
              <p className="label">Protocols recorded by default</p>
              <div className="flex flex-wrap gap-4">
                {RECORDING_PROTOCOLS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={cfg.protocols.includes(p)} onChange={(e) => toggleProtocol(p, e.target.checked)} />
                    {p.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="label">Exceptions per device</p>
              {exceptions.length > 0 && (
                <ul className="mb-2 divide-y divide-border rounded-lg border border-border">
                  {exceptions.map(([id, mode]) => (
                    <li key={id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{nameOf(id)}</span>
                      <Select className="input h-8 w-40" value={mode} aria-label={`Recording for ${nameOf(id)}`} onChange={(e) => setCfg({ ...cfg, devices: { ...cfg.devices, [id]: e.target.value as "on" | "off" } })}>
                        <option value="on">Always record</option>
                        <option value="off">Never record</option>
                      </Select>
                      <button type="button" className="rounded p-1 text-muted hover:bg-surface-3 hover:text-fg" aria-label={`Remove the exception for ${nameOf(id)}`} onClick={() => { const { [id]: _drop, ...rest } = cfg.devices; void _drop; setCfg({ ...cfg, devices: rest }); }}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Select
                className="input"
                value={pick}
                aria-label="Add a device exception"
                onChange={(e) => {
                  setPick("");
                  if (e.target.value) setCfg({ ...cfg, devices: { ...cfg.devices, [e.target.value]: cfg.record_all ? "off" : "on" } });
                }}
              >
                <option value="">Add a device…</option>
                {(devices.data ?? []).filter((d) => !(d.id in cfg.devices)).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </div>
            </SubSection>
            <SubSection title="How long to keep recordings">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Keep recordings for" hint="Older recordings are deleted automatically.">
                <Select className="input" value={String(cfg.retention_days)} onChange={(e) => setCfg({ ...cfg, retention_days: Number(e.target.value) })}>
                  {[[7, "7 days"], [14, "14 days"], [30, "30 days"], [90, "90 days"], [180, "180 days"], [365, "1 year"], [0, "Forever"]].concat(
                    [7, 14, 30, 90, 180, 365, 0].includes(cfg.retention_days) ? [] : [[cfg.retention_days, `${cfg.retention_days} days`]],
                  ).map(([n, l]) => (
                    <option key={n} value={n}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Size limit (GB)" hint="0 means no limit. When exceeded, the oldest recordings go first.">
                <input className="input" type="number" min={0} max={100000} value={cfg.max_gb} onChange={(e) => setCfg({ ...cfg, max_gb: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              </Field>
            </div>
            </SubSection>
          </fieldset>
          <SubSection title="Where recordings are kept" description="The gateway writes to this server first. A share is optional; finished recordings are then copied to it.">
            <div role="radiogroup" aria-label="Where recordings are kept" className="grid gap-2 sm:grid-cols-3">
              {([
                ["local", "This server", "A Docker volume next to emremote."],
                ["smb", "SMB share", "Windows share, Synology, TrueNAS, Samba."],
                ["nfs", "NFS share", "NFS version 3 export."],
              ] as const).map(([k, t, d]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={cfg.storage.kind === k}
                  onClick={() => setTarget({ kind: k })}
                  className={clsx("rounded-lg border px-3 py-2.5 text-left text-sm", cfg.storage.kind === k ? "border-fg/70 bg-surface-2 ring-1 ring-fg/40" : "border-border text-muted hover:border-border-strong")}
                >
                  <span className="block font-medium text-fg">{t}</span>
                  <span className="block text-xs text-subtle">{d}</span>
                </button>
              ))}
            </div>
            {cfg.storage.kind !== "local" && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="File server" hint="Address or name. It must be inside the allowed target networks.">
                    <input className="input font-mono" value={cfg.storage.host} onChange={(e) => setTarget({ host: e.target.value })} placeholder="192.168.1.10" spellCheck={false} autoCapitalize="off" />
                  </Field>
                  <Field label={cfg.storage.kind === "smb" ? "Share name" : "Export path"} hint={cfg.storage.kind === "smb" ? "The share as the server lists it." : "For example /export/emremote."}>
                    <input className="input font-mono" value={cfg.storage.share} onChange={(e) => setTarget({ share: e.target.value })} placeholder={cfg.storage.kind === "smb" ? "recordings" : "/export/emremote"} spellCheck={false} autoCapitalize="off" />
                  </Field>
                  <Field label="Folder" optional hint="Created inside the share for the recording files.">
                    <input className="input font-mono" value={cfg.storage.dir} onChange={(e) => setTarget({ dir: e.target.value })} placeholder="emremote-recordings" spellCheck={false} autoCapitalize="off" />
                  </Field>
                  {cfg.storage.kind === "smb" ? (
                    <>
                      <Field label="User name" optional hint="Empty means guest access.">
                        <input className="input" value={cfg.storage.username} onChange={(e) => setTarget({ username: e.target.value })} autoComplete="off" spellCheck={false} />
                      </Field>
                      <Field label="Password" optional hint={cfg.storage.has_password ? "Saved. Leave empty to keep it." : undefined}>
                        <input className="input" type="password" value={cfg.storage.password ?? ""} onChange={(e) => setTarget({ password: e.target.value })} autoComplete="new-password" placeholder={cfg.storage.has_password ? "unchanged" : ""} />
                      </Field>
                      <Field label="Domain" optional>
                        <input className="input" value={cfg.storage.domain} onChange={(e) => setTarget({ domain: e.target.value })} autoComplete="off" spellCheck={false} />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field label="User id" hint="The user id the server sees (needs write access to the export).">
                        <input className="input" type="number" min={0} max={65535} value={cfg.storage.uid} onChange={(e) => setTarget({ uid: Number(e.target.value) || 0 })} />
                      </Field>
                      <Field label="Group id">
                        <input className="input" type="number" min={0} max={65535} value={cfg.storage.gid} onChange={(e) => setTarget({ gid: Number(e.target.value) || 0 })} />
                      </Field>
                    </>
                  )}
                </div>
                <Switch
                  checked={cfg.storage.keep_local}
                  onChange={(v) => setTarget({ keep_local: v })}
                  label="Keep a copy on this server"
                  description="Otherwise the copy on this server is deleted once the recording is safely on the share."
                />
                {cfg.storage.kind === "nfs" && (
                  <p className="text-xs text-subtle">NFS version 3 only. The export must allow connections from non-privileged ports ("insecure" in /etc/exports) and this machine.</p>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={testShare} loading={testing}>
                    Test connection
                  </Button>
                  {testResult && <span className={clsx("text-xs", testResult.ok ? "text-success" : "text-danger")}>{testResult.message}</span>}
                </div>
              </div>
            )}
          </SubSection>
          {storage && (
            <div className="rounded-lg border border-border bg-surface-2/40 px-4 py-3 text-[13px]">
              <p className="font-medium">Storage: {STORAGE_LABEL[storage.kind]}</p>
              <p className="mt-1 text-muted">
                {storage.writable ? "Writable" : <span className="text-danger">Not writable. Recording cannot start until this is fixed.</span>}
                {storage.total_bytes > 0 && `. ${bytes(storage.free_bytes)} free of ${bytes(storage.total_bytes)}`}. {storage.count} recording{storage.count === 1 ? "" : "s"}, {bytes(storage.used_bytes)}.
              </p>
              <p className="mt-1 text-xs text-subtle">
                The gateway writes recordings to {storage.path} on this server first.
                {cfg.storage.kind !== "local" && " Finished recordings are then copied to the share."}
              </p>
              {storage.share && (
                <p className="mt-1 text-xs">
                  {storage.share.reachable ? (
                    <span className="text-success">The share answers.</span>
                  ) : (
                    <span className="text-danger">The share does not answer: {storage.share.error}. Recordings stay on this server until it does.</span>
                  )}{" "}
                  {storage.share.pending > 0 && <span className="text-muted">{storage.share.pending} recording{storage.share.pending === 1 ? "" : "s"} waiting to be copied.</span>}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button variant="primary" onClick={save} loading={busy}>
              Save recording settings
            </Button>
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Networks that only a jump host can reach (administrators). */
function JumpHostCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [fromEnv, setFromEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    get<{ networks: string[]; saved: boolean }>("/api/settings/jump")
      .then((r) => {
        setText(r.networks.join("\n"));
        setFromEnv(!r.saved && r.networks.length > 0);
        setLoaded(true);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const nets = text.split(/[\s,;]+/).filter(Boolean);
      const r = await put<{ networks: string[] }>("/api/settings/jump", { networks: nets });
      setText(r.networks.join("\n"));
      setFromEnv(false);
      qc.invalidateQueries({ queryKey: keys.system });
      toast.success(r.networks.length ? "Jump host networks saved." : "Jump hosts are turned off.");
    } catch (e) {
      setError(e instanceof ApiError && e.fields?.networks ? e.fields.networks : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Jump hosts"
      description="Reach devices that only another machine can see. List the networks behind your jump hosts; leave it empty to turn the feature off."
      icon={<Route className="h-4 w-4" />}
    >
      <div className="space-y-3">
        <Field label="Networks behind jump hosts" hint="One per line, like 192.168.50.0/24. Devices in these networks are added by IP address and then use a jump host in their connection's Advanced tab." error={error || undefined}>
          <textarea
            className="input min-h-[96px] font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="192.168.50.0/24"
            spellCheck={false}
            disabled={!loaded}
            aria-label="Networks behind jump hosts"
          />
        </Field>
        {fromEnv && <p className="text-xs text-subtle">These come from EMREMOTE_JUMP_TARGET_NETWORKS. Saving here replaces them.</p>}
        <p className="text-xs text-subtle">
          The jump host itself is an ordinary SSH connection with a saved sign-in, in your normal allowed networks, and its SSH server must allow TCP
          forwarding. Loopback and link-local ranges are never accepted.
        </p>
        <Button variant="primary" onClick={save} loading={busy} disabled={!loaded}>
          Save
        </Button>
      </div>
    </Card>
  );
}

interface TargetNetworks {
  networks: string[];
  saved: boolean;
  env: string[];
  everywhere: boolean;
}

/** Whether a line means "every address": 0.0.0.0, ::, or any network with a /0 length. */
const meansEverywhere = (line: string) => /^(0\.0\.0\.0|::)(\/0)?$/.test(line.trim());

function TargetNetworksCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const apply = (r: TargetNetworks) => {
    setText(r.networks.join("\n"));
    setSaved(r.saved);
    setEverywhere(r.everywhere);
    qc.invalidateQueries({ queryKey: keys.system });
  };
  useEffect(() => {
    get<TargetNetworks>("/api/settings/targets")
      .then((r) => {
        apply(r);
        setLoaded(true);
      })
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lines = () => text.split(/[\s,;]+/).filter(Boolean);
  const wantsEverywhere = lines().some(meansEverywhere);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      apply(await put<TargetNetworks>("/api/settings/targets", { networks: lines() }));
      toast.success("Allowed networks saved. They apply at once.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    setError("");
    try {
      apply(await del<TargetNetworks>("/api/settings/targets"));
      toast.success("Back to the default from the environment.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Allowed target networks"
      description="Which addresses emremote may connect to. Your own network is allowed by default; add a public server, or a whole range, here."
      icon={<Globe className="h-4 w-4" />}
    >
      <div className="space-y-3">
        <Field label="Networks" hint="One per line. A single address (137.23.43.108) or a network (192.168.50.0/24). 0.0.0.0 allows every IPv4 address and :: every IPv6 address." error={error || undefined}>
          <textarea
            className="input min-h-[120px] font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="10.0.0.0/8&#10;137.23.43.108"
            spellCheck={false}
            disabled={!loaded}
            aria-label="Allowed target networks"
          />
        </Field>
        {everywhere && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            Every address is allowed right now: emremote can be pointed at any server that the machine it runs on can reach.
          </p>
        )}
        {!saved && loaded && <p className="text-xs text-subtle">These come from EMREMOTE_ALLOWED_TARGET_NETWORKS (or the built-in default). Saving here replaces them without a restart.</p>}
        <p className="text-xs text-subtle">
          Always refused, whatever is listed: this machine itself (loopback), link-local addresses (this includes the cloud metadata service at 169.254.169.254),
          multicast, and emremote's own container networks. Every connection is checked against this list again when it is made.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => (wantsEverywhere ? setConfirming(true) : save())} loading={busy} disabled={!loaded}>
            Save
          </Button>
          {saved && (
            <Button onClick={reset} disabled={busy}>
              Use the default
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Allow every address?"
        confirmLabel="Allow every address"
        onConfirm={async () => {
          await save();
        }}
      >
        <p>
          With 0.0.0.0 or ::, emremote may connect to any address on the internet that this server can reach, not only your own network. Anyone who can
          add devices (administrators and members with that permission) can then aim it anywhere. Prefer listing the few servers you really need.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

interface SessionLimits {
  idle_minutes: number;
  ttl_minutes: number;
  saved: boolean;
  env: { idle_minutes: number; ttl_minutes: number };
}

const IDLE_CHOICES: [number, string][] = [
  [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [480, "8 hours"], [1440, "1 day"], [4320, "3 days"], [10080, "7 days"],
];
const LIFETIME_CHOICES: [number, string][] = [
  [60, "1 hour"], [240, "4 hours"], [480, "8 hours"], [720, "12 hours"], [1440, "1 day"], [4320, "3 days"], [10080, "7 days"], [43200, "30 days"],
];

function minutesLabel(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  return `${m} minutes`;
}

/** The listed choices plus the current value when it is none of them (for example set by an environment variable). */
function withCurrent(choices: [number, string][], current: number, label: (n: number) => string): [number, string][] {
  return choices.some(([v]) => v === current) ? choices : [...choices, [current, label(current)] as [number, string]].sort((a, b) => a[0] - b[0]);
}

function SessionLimitsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [loaded, setLoaded] = useState(false);
  const [v, setV] = useState({ idle_minutes: 120, ttl_minutes: 720 });
  const [fromEnv, setFromEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    get<SessionLimits>("/api/settings/sessions")
      .then((r) => {
        setV({ idle_minutes: r.idle_minutes, ttl_minutes: r.ttl_minutes });
        setFromEnv(!r.saved);
        setLoaded(true);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await put("/api/settings/sessions", v);
      setFromEnv(false);
      qc.invalidateQueries({ queryKey: keys.system });
      toast.success("Sign-in limits saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Sign-in sessions"
      description="How long people stay signed in. Open remote sessions count as activity, so someone working in one is not signed out."
      icon={<Timer className="h-4 w-4" />}
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sign out when unused for" hint="Takes effect at once.">
            <Select className="input" value={String(v.idle_minutes)} onChange={(e) => setV({ ...v, idle_minutes: Number(e.target.value) })} disabled={!loaded}>
              {withCurrent(IDLE_CHOICES, v.idle_minutes, minutesLabel).map(([n, l]) => (
                <option key={n} value={n}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Longest sign-in" hint="Applies to new sign-ins.">
            <Select className="input" value={String(v.ttl_minutes)} onChange={(e) => setV({ ...v, ttl_minutes: Number(e.target.value) })} disabled={!loaded}>
              {withCurrent(LIFETIME_CHOICES, v.ttl_minutes, minutesLabel).map(([n, l]) => (
                <option key={n} value={n}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        {fromEnv && <p className="text-xs text-subtle">These are the defaults from the environment (EMREMOTE_SESSION_IDLE_TIMEOUT, EMREMOTE_SESSION_TTL). Saving here replaces them.</p>}
        <p className="text-xs text-subtle">Everyone is also signed out whenever emremote restarts, because saved passwords are locked until someone signs in.</p>
        <Button variant="primary" onClick={save} loading={busy} disabled={!loaded}>
          Save
        </Button>
      </div>
    </Card>
  );
}

function VaultPolicyCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState<VaultPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sample, setSample] = useState("");
  useEffect(() => {
    get<VaultPolicy>("/api/vault/policy")
      .then((p) => {
        setV(p);
        setSample(generatePassword(p));
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const change = (patch: Partial<VaultPolicy>) => {
    const next = { ...v!, ...patch };
    setV(next);
    if (next.lower || next.upper || next.digits || next.symbols) setSample(generatePassword(next));
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await put("/api/settings/vault", v);
      qc.invalidateQueries({ queryKey: ["vault-policy"] });
      toast.success("Vault policy saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Vault passwords"
      description="Passwords the vault generates in forms and when it changes passwords on servers."
      icon={<KeyRound className="h-4 w-4" />}
    >
      {!v ? (
        error ? <p className="text-xs text-danger">{error}</p> : null
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Length">
              <Select className="input" value={String(v.length)} onChange={(e) => change({ length: Number(e.target.value) })}>
                {[...new Set([12, 16, 20, 24, 32, 40, 64, v.length])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n} characters
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Approvals wait for" hint="An approved request has to be used within this time.">
              <Select className="input" value={String(v.request_valid_hours)} onChange={(e) => change({ request_valid_hours: Number(e.target.value) })}>
                {[...new Set([1, 4, 8, 24, 72, 168, v.request_valid_hours])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n === 168 ? "7 days" : n >= 24 ? `${n / 24} day${n > 24 ? "s" : ""}` : `${n} hour${n > 1 ? "s" : ""}`}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="grid gap-x-6 sm:grid-cols-2">
            <Switch checked={v.lower} onChange={(x) => change({ lower: x })} label="Lowercase letters" />
            <Switch checked={v.upper} onChange={(x) => change({ upper: x })} label="Uppercase letters" />
            <Switch checked={v.digits} onChange={(x) => change({ digits: x })} label="Digits" />
            <Switch checked={v.symbols} onChange={(x) => change({ symbols: x })} label="Symbols" description="No quotes, spaces, colons or backslashes." />
            <Switch checked={v.no_ambiguous} onChange={(x) => change({ no_ambiguous: x })} label="Leave out look-alikes" description="0 O o 1 l I |" />
          </div>
          {sample && (
            <p className="break-all text-xs text-subtle">
              Example: <code className="font-mono text-fg">{sample}</code>
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <Button variant="primary" onClick={save} loading={busy}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (!cur) {
      setErrors({ current_password: "Required" });
      return;
    }
    if (next.length < 8) {
      setErrors({ new_password: "Use at least 8 characters" });
      return;
    }
    if (next !== confirm) {
      setErrors({ confirm: "Passwords do not match" });
      return;
    }
    setBusy(true);
    try {
      await post("/api/auth/password", { current_password: cur, new_password: next });
      setCur("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Other sessions were signed out.");
      qc.invalidateQueries({ queryKey: keys.loginSessions });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Password" description="Changing your password signs out every other browser and closes their remote sessions." icon={<ShieldCheck className="h-4 w-4" />}>
      <form noValidate onSubmit={submit} className="grid max-w-xl gap-4">
        <Field label="Current password" error={errors.current_password}>
          <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" hint="At least 8 characters" error={errors.new_password}>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={8} />
          </Field>
          <Field label="Confirm new password" error={errors.confirm}>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const sessions = useLoginSessions();
  const qc = useQueryClient();
  const toast = useToast();
  const others = (sessions.data ?? []).filter((s) => !s.current).length;
  return (
    <Card title="Signed-in browsers" description="Browser sessions for your account." icon={<Monitor className="h-4 w-4" />}>
      {sessions.isLoading ? (
        <PageLoader />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {(sessions.data ?? []).map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-muted" title={s.user_agent}>
                  {s.user_agent || "Unknown browser"}
                </span>
                {s.current && <Badge tone="accent">This browser</Badge>}
                <span className="font-mono text-xs text-subtle">{s.ip}</span>
                <span className="text-xs text-subtle" title={`Signed in ${dateTime(s.created_at)}`}>
                  active {relativeTime(s.last_seen_at)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button
              size="sm"
              disabled={others === 0}
              onClick={async () => {
                try {
                  const r = await del<{ revoked: number }>("/api/auth/sessions");
                  toast.success(`Signed out ${r.revoked} other session(s)`);
                  qc.invalidateQueries({ queryKey: keys.loginSessions });
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Sign out other browsers
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function ActiveSessionsCard() {
  const active = useActiveSessions();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <Card id="active-sessions" title="Active remote sessions" description="Live RDP, VNC and SSH sessions relayed by this server." icon={<Radio className="h-4 w-4" />}>
      {(active.data ?? []).length === 0 ? (
        <p className="text-sm text-subtle">No remote sessions are active.</p>
      ) : (
        <ul className="divide-y divide-border">
          {active.data!.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              <ProtocolBadge protocol={a.protocol} />
              <span className="font-medium">{a.device_name}</span>
              <span className="text-xs text-subtle">
                {a.username} · {a.client_ip} · {duration(Math.floor((Date.now() - new Date(a.started_at).getTime()) / 1000))}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={async () => {
                  try {
                    await del(`/api/active-sessions/${a.id}`);
                    toast.success("Session terminated");
                    qc.invalidateQueries({ queryKey: keys.activeSessions });
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Terminate
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SystemCard() {
  const { data, error, refetch } = useSystem();
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return null;
  const row = (k: string, v: ReactNode) => (
    <>
      <dt className="text-subtle">{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </>
  );
  return (
    <Card title="System" description="Read-only; configured through environment variables (see .env.example)." icon={<Server className="h-4 w-4" />}>
      <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-2.5 text-sm">
        {row("Version", <span className="font-mono text-xs">{data.version}</span>)}
        {row(
          "Remote access gateway",
          <Badge tone={data.gateway === "reachable" ? "success" : "danger"}>guacd {data.gateway}</Badge>,
        )}
        {row(
          "Allowed target networks",
          <span className="font-mono text-xs">{data.allowed_target_networks.join(", ") || "none"}</span>,
        )}
        {row("Always denied", <span className="font-mono text-xs text-muted">loopback, link-local, multicast, {data.denied_target_networks.join(", ")}</span>)}
        {row(
          "Reachability checks",
          data.status_check_interval_s ? `every ${duration(data.status_check_interval_s)} (TCP connect to each configured port)` : "disabled",
        )}
        {row(
          "Audit log kept",
          `${data.audit_retention_days ? `${data.audit_retention_days} days` : "no age limit"}${data.audit_max_entries ? `, at most ${data.audit_max_entries.toLocaleString("en-US")} entries` : ""}`,
        )}
        {row("Session lifetime", `${duration(data.session_ttl_s)} max, ${duration(data.session_idle_timeout_s)} idle`)}
        {row("Secure cookies", data.secure_cookies ? <Badge tone="success">on (HTTPS)</Badge> : <Badge tone="warning">off: use HTTPS outside localhost</Badge>)}
      </dl>
    </Card>
  );
}

type SettingsTab = "appearance" | "account" | "access" | "recording" | "system";

export default function SettingsPage() {
  const { state } = useAuth();
  const [theme, setTheme] = useTheme();
  const user = state.status === "authenticated" ? state.user : null;
  const { isAdmin } = useAccess();
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const tabs: { id: SettingsTab; label: string; icon: typeof Sun }[] = [
    { id: "appearance", label: "Appearance", icon: Sun },
    { id: "account", label: "Account", icon: ShieldCheck },
    ...(isAdmin
      ? [
          { id: "access" as const, label: "Access", icon: Globe },
          { id: "recording" as const, label: "Recording", icon: Video },
        ]
      : []),
    { id: "system", label: "System", icon: Server },
  ];
  // Links such as /settings#active-sessions open the tab that holds that card.
  const asked = (hash === "#active-sessions" ? "system" : params.get("tab")) as SettingsTab | null;
  const tab = tabs.some((t) => t.id === asked) ? (asked as SettingsTab) : "appearance";
  useEffect(() => {
    if (hash === "#active-sessions" && tab === "system") document.getElementById("active-sessions")?.scrollIntoView({ block: "start" });
  }, [hash, tab]);
  return (
    <>
      <PageHeader title="Settings" description={user ? `Signed in as ${user.username} (${user.role})` : undefined} />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Settings sections">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="settings-panel"
            onClick={() => setParams(id === "appearance" ? {} : { tab: id }, { replace: true })}
            className={clsx(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
              tab === id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
      <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="grid max-w-4xl gap-4">
        {tab === "appearance" && (
          <>
            <Card title="Appearance" description="Light or dark interface." icon={<Sun className="h-4 w-4" />}>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["dark", "Dark", Moon],
                    ["light", "Light", Sun],
                    ["system", "System", Laptop],
                  ] as [ThemePref, string, typeof Moon][]
                ).map(([v, l, Icon]) => (
                  <button
                    key={v}
                    onClick={() => setTheme(v)}
                    className={clsx(
                      "flex items-center gap-2 rounded-md border px-4 py-2 text-sm",
                      theme === v ? "border-accent bg-accent/10" : "border-border text-muted hover:border-border-strong",
                    )}
                    aria-pressed={theme === v}
                  >
                    <Icon className="h-4 w-4" /> {l}
                  </button>
                ))}
              </div>
            </Card>
            <TerminalCard />
          </>
        )}
        {tab === "account" && (
          <>
            <PasswordCard />
            <Card title="Two-factor authentication" description="Protects your account even if your password leaks." icon={<ShieldCheck className="h-4 w-4" />}>
              <TwoFactorCard />
            </Card>
            <SessionsCard />
          </>
        )}
        {tab === "access" && isAdmin && (
          <>
            <TargetNetworksCard />
            <JumpHostCard />
            <SessionLimitsCard />
            <VaultPolicyCard />
          </>
        )}
        {tab === "recording" && isAdmin && <RecordingCard />}
        {tab === "system" && (
          <>
            <ActiveSessionsCard />
            <SystemCard />
          </>
        )}
      </div>
    </>
  );
}
