import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Monitor, Moon, Sun, Laptop, ShieldCheck, Server, Radio, TerminalSquare, Minus, Plus, RotateCcw, Check, Route } from "lucide-react";
import clsx from "clsx";
import { PageHeader, Badge, ErrorState } from "@/components/ui/misc";
import { Button } from "@/components/ui/Button";
import { Field, Switch } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { TERMINAL_FONTS, TERMINAL_THEMES, DEFAULT_SSH } from "@/lib/constants";
import { loadTerminalPrefs, saveTerminalPrefs, type TerminalPrefs } from "@/lib/terminalPrefs";
import { PageLoader } from "@/components/ui/Spinner";
import { TwoFactorCard } from "@/components/TwoFactorCard";
import { useActiveSessions, useLoginSessions, useSystem, keys } from "@/hooks/queries";
import { ApiError, del, errorMessage, get, post, put } from "@/lib/api";
import { useAuth, useAccess } from "@/lib/auth";
import { useTheme, type ThemePref } from "@/lib/theme";
import { useDonateHidden } from "@/lib/donate";
import { dateTime, duration, relativeTime } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { ProtocolBadge } from "@/components/Status";

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
              <span style={{ color: green }}>tester@lab-ws</span>:<span style={{ color: blue }}>~</span>$ ls -l{"\n"}
              <span style={dim}>total 12</span>
              {"\n"}drwxr-xr-x 2 tester tester 4096 Oct 14 09:12 <span style={{ color: blue }}>projects</span>
              {"\n"}-rwxr-xr-x 1 tester tester  812 Oct 13 18:40 <span style={{ color: green }}>backup.sh</span>
              {"\n"}-rw-r--r-- 1 tester tester 1.2K Oct 14 08:03 notes.txt{"\n"}
              <span style={{ color: green }}>tester@lab-ws</span>:<span style={{ color: blue }}>~</span>$ systemctl status sshd{"\n"}
              <span style={{ color: green }}>●</span> sshd.service - OpenBSD Secure Shell server{"\n"}
              {"   "}Active: <span style={{ color: green }}>active (running)</span> since Tue 2026-10-14{"\n"}
              <span style={{ color: green }}>tester@lab-ws</span>:<span style={{ color: blue }}>~</span>$ tail error.log{"\n"}
              <span style={{ color: yellow }}>WARN</span>  disk usage at 87%{"\n"}
              <span style={{ color: red }}>ERROR</span> backup job failed (exit 1){"\n"}
              <span style={{ color: green }}>tester@lab-ws</span>:<span style={{ color: blue }}>~</span>$ <span className="inline-block h-[1.1em] w-[0.6em] translate-y-[0.2em] animate-pulse" style={{ background: theme.fg }} />
            </pre>
          </div>
        </div>
      </div>
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

export default function SettingsPage() {
  const { state } = useAuth();
  const [theme, setTheme] = useTheme();
  const system = useSystem();
  const [donateHidden, setDonateHidden] = useDonateHidden();
  const user = state.status === "authenticated" ? state.user : null;
  const { isAdmin } = useAccess();
  return (
    <>
      <PageHeader title="Settings" description={user ? `Signed in as ${user.username} (${user.role})` : undefined} />
      <div className="grid gap-4">
        <Card title="Appearance" icon={<Sun className="h-4 w-4" />}>
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
                  {system.data?.donate !== false && (
            <div className="mt-4 max-w-sm border-t border-border pt-4">
              <Switch checked={!donateHidden} onChange={(v) => setDonateHidden(!v)} label="Show the Donate button" description="In the top bar, in this browser." />
            </div>
          )}
        </Card>
        <TerminalCard />
        {isAdmin && <JumpHostCard />}
        <PasswordCard />
        <Card title="Two-factor authentication" description="Protects your account even if your password leaks." icon={<ShieldCheck className="h-4 w-4" />}>
          <TwoFactorCard />
        </Card>
        <SessionsCard />
        <ActiveSessionsCard />
        <SystemCard />
      </div>
    </>
  );
}
