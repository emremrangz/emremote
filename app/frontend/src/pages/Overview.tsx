import { Link, useNavigate } from "react-router-dom";
import { Plus, Activity, Radio, PlugZap, Zap, Monitor, Cable, ShieldCheck, AlertTriangle, Eye } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { useDashboard, useDevices } from "@/hooks/queries";
import { PageHeader, EmptyState, ErrorState } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { OsIcon, distroOf } from "@/components/OsIcon";
import { Donut, DayBars, Ring, Sparkline } from "@/components/Charts";
import { DeviceStatus } from "@/components/Status";
import { ProtocolBadge } from "@/components/Status";
import { DeviceRow, Panel } from "@/components/DashboardParts";
import { ActivityItem } from "@/components/ActivityItem";
import { DeviceFormDialog } from "@/components/DeviceForm";
import { QuickConnectDialog } from "@/components/QuickConnect";
import type { Protocol, OS } from "@/lib/types";
import { OS_LABELS } from "@/lib/constants";
import { relativeTime, duration } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { useAccess, useAuth } from "@/lib/auth";

export default function OverviewPage() {
  const { data, isLoading, error, refetch } = useDashboard();
  const devices = useDevices();
  const auth = useAuth();
  const [adding, setAdding] = useState(false);
  const { can } = useAccess();
  const canAdd = can("inventory.manage");
  const canQuick = can("quick.connect");
  const [quick, setQuick] = useState(false);
  const navigate = useNavigate();
  const now = useNow(1000);
  if (isLoading) return <PageLoader />;
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;
  const s = data.stats;

  if (s.device_count === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <div className="card">
          <EmptyState
            icon={<PlugZap className="h-5 w-5" />}
            title={canAdd ? "Add your first device" : "Nothing here yet"}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {canQuick && (
                  <Button icon={<Zap className="h-4 w-4" />} onClick={() => setQuick(true)}>
                    Quick connect
                  </Button>
                )}
                {canAdd && (
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                    Add device
                  </Button>
                )}
              </div>
            }
          >
            {canAdd
              ? "emremote connects to computers using services they already have: Remote Desktop (Windows), Screen Sharing/VNC (macOS, Linux) or SSH. Nothing is installed on the target computers. See the README for how to enable those services."
              : "No devices have been shared with you yet. Ask an administrator to give you access."}
          </EmptyState>
        </div>
        <DeviceFormDialog open={adding} onOpenChange={setAdding} onSaved={(d) => navigate(`/devices/${d.id}`)} />
        <QuickConnectDialog open={quick} onOpenChange={setQuick} />
      </>
    );
  }

  const methods = s.connection_count;
  const reachable = s.reachability.reachable ?? 0;
  const unreachable = s.reachability.unreachable ?? 0;
  const unknown = s.reachability.unknown ?? 0;
  const checked = reachable + unreachable;
  const healthPct = checked ? (reachable / checked) * 100 : 100;
  const days = s.sessions_by_day ?? [];
  const sessions14 = days.reduce((n, d) => n + d.count, 0);
  const busiest = days.reduce((m, d) => (d.count > m.count ? d : m), { date: "", count: 0 });
  const live = data.active_sessions.length;
  const hour = new Date(now).getHours();
  const greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : hour >= 18 && hour < 23 ? "Good evening" : "Working late";
  const username = auth.state.status === "authenticated" ? auth.state.user.username : "";

  // Which systems are in use, using the distribution the device reports when known.
  const systems = new Map<string, { count: number; os: OS; distro?: string }>();
  for (const d of devices.data ?? []) {
    const name = distroOf(d.facts?.os)?.name ?? OS_LABELS[d.os];
    const cur = systems.get(name);
    if (cur) cur.count++;
    else systems.set(name, { count: 1, os: d.os, distro: d.facts?.os });
  }
  const systemList = [...systems.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 7);
  const systemMax = Math.max(1, ...systemList.map(([, v]) => v.count));
  const topMax = Math.max(1, ...(s.top_devices ?? []).map((t) => t.sessions));

  const kpi = "card relative overflow-hidden p-5 transition-colors hover:border-border-strong";
  const iconBox = "flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-muted";

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] text-muted">{new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em]">
            {greeting}
            {username ? `, ${username}` : ""}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            {unreachable === 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-success" /> Everything that was checked is reachable
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-warning">
                <AlertTriangle className="h-3.5 w-3.5" /> {unreachable} connection method{unreachable === 1 ? "" : "s"} unreachable
              </span>
            )}
            <span className="text-subtle">·</span>
            <span>
              {live === 0 ? "No live sessions" : `${live} live session${live === 1 ? "" : "s"}`}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canQuick && (
            <Button icon={<Zap className="h-4 w-4" />} onClick={() => setQuick(true)}>
              Quick connect
            </Button>
          )}
          {canAdd && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add device
            </Button>
          )}
        </div>
      </div>

      {/* Key numbers */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Link to="/devices" className={kpi}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className={iconBox}>
                <Monitor className="h-4 w-4" />
              </span>
              <p className="mt-4 text-[13px] text-muted">Devices</p>
              <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-[-0.03em]">{s.device_count}</p>
            </div>
            <Ring value={healthPct} className={unreachable ? "text-warning" : "text-success"} label={`${Math.round(healthPct)}% of checked methods reachable`} />
          </div>
          <p className="mt-3 text-xs text-subtle">
            {reachable} of {methods} methods reachable{unknown ? ` · ${unknown} not checked yet` : ""}
          </p>
        </Link>

        <Link to="/settings#active-sessions" className={kpi}>
          <span className={iconBox}>
            <Radio className="h-4 w-4" />
          </span>
          <p className="mt-4 flex items-center gap-2 text-[13px] text-muted">
            Live sessions
            {live > 0 && (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
            )}
          </p>
          <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-[-0.03em]">{live}</p>
          <p className="mt-3 truncate text-xs text-subtle">
            {live ? data.active_sessions.map((a) => a.device_name).slice(0, 3).join(", ") : "Nobody is connected right now"}
          </p>
        </Link>

        <Link to="/statistics" className={kpi}>
          <span className={iconBox}>
            <Activity className="h-4 w-4" />
          </span>
          <p className="mt-4 text-[13px] text-muted">Sessions, last 14 days</p>
          <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-[-0.03em]">{sessions14}</p>
          <div className="mt-2">
            <Sparkline values={days.map((d) => d.count)} />
          </div>
        </Link>

        <Link to="/connections" className={kpi}>
          <span className={iconBox}>
            <Cable className="h-4 w-4" />
          </span>
          <p className="mt-4 text-[13px] text-muted">Connection methods</p>
          <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-[-0.03em]">{methods}</p>
          <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
            {(Object.entries(s.protocols) as [Protocol, number][]).map(([k, n]) => (
              <div key={k} className={clsx("h-full", k === "ssh" ? "bg-success/70" : k === "rdp" ? "bg-accent/80" : k === "vnc" ? "bg-[#a78bfa]" : "bg-warning/80")} style={{ width: `${(n / methods) * 100}%` }} />
            ))}
          </div>
          <p className="mt-2 text-xs text-subtle">
            {Object.entries(s.protocols).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(" · ") || "None yet"} · {s.credential_count} saved credential{s.credential_count === 1 ? "" : "s"}
          </p>
        </Link>
      </div>

      {live > 0 && (
        <section className="card mt-4 overflow-hidden border-success/30">
          <header className="flex items-center gap-2 border-b border-border bg-success/[0.04] px-4 py-3">
            <Radio className="h-4 w-4 text-success" />
            <h2 className="text-sm font-semibold">Live now</h2>
          </header>
          <ul className="divide-y divide-border px-4">
            {data.active_sessions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <ProtocolBadge protocol={a.protocol} />
                <Link to={`/devices/${a.device_id}`} className="font-medium hover:text-accent">
                  {a.device_name}
                </Link>
                <span className="text-muted">{a.connection_name}</span>
                {a.viewers > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                    <Eye className="h-3 w-3" /> {a.viewers} watching
                  </span>
                )}
                <span className="ml-auto text-xs text-subtle">
                  {a.username} from {a.client_ip} · {duration(Math.max(0, Math.floor((now - new Date(a.started_at).getTime()) / 1000)))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2 [&>*:last-child]:flex-1">
          <Panel
            title="Session activity"
            action={<span className="text-xs text-subtle">{busiest.count ? `Busiest: ${new Date(busiest.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} (${busiest.count})` : "Last 14 days"}</span>}
          >
            <div className="py-5">
              {sessions14 === 0 ? (
                <p className="flex h-36 items-center justify-center text-center text-sm text-subtle">No sessions in the last 14 days. They will show up here as you connect.</p>
              ) : (
                <DayBars days={days} />
              )}
            </div>
          </Panel>

          <Panel title="Recently accessed" action={<Link to="/devices" className="text-xs font-medium text-accent hover:underline">All devices</Link>}>
            {s.recently_accessed.length ? (
              <ul className="divide-y divide-border">
                {s.recently_accessed.map((d) => (
                  <DeviceRow key={d.id} d={d} meta={relativeTime(d.last_accessed_at)} />
                ))}
              </ul>
            ) : (
              <p className="py-8 text-center text-sm text-subtle">No sessions launched yet. Connect to a device to see it here.</p>
            )}
          </Panel>

          {s.favorites.length > 0 && (
            <Panel title="Favorites" action={<Link to="/favorites" className="text-xs font-medium text-accent hover:underline">View all</Link>}>
              <div className="grid gap-2 py-3 sm:grid-cols-2">
                {s.favorites.slice(0, 6).map((d) => (
                  <Link key={d.id} to={`/devices/${d.id}`} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-surface-2/60">
                    <OsIcon os={d.os} distro={d.facts?.os} boxed />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{d.name}</span>
                      <span className="block truncate font-mono text-xs text-subtle">{d.address}</span>
                    </span>
                    <DeviceStatus device={d} compact />
                  </Link>
                ))}
              </div>
            </Panel>
          )}
        </div>

        <div className="flex flex-col gap-4 [&>*:last-child]:flex-1">
          <Panel title="Fleet health">
            <div className="flex items-center gap-5 py-5">
              <Donut
                segments={[
                  { label: "Reachable", value: reachable, className: "text-success" },
                  { label: "Unreachable", value: unreachable, className: "text-danger" },
                  { label: "Not checked", value: unknown, className: "text-subtle" },
                ]}
                center={
                  <>
                    <span className="text-2xl font-semibold tabular-nums tracking-[-0.03em]">{methods}</span>
                    <span className="text-[11px] text-subtle">methods</span>
                  </>
                }
              />
              <ul className="min-w-0 flex-1 space-y-2 text-[13px]">
                {[
                  ["Reachable", reachable, "bg-success"],
                  ["Unreachable", unreachable, "bg-danger"],
                  ["Not checked", unknown, "bg-subtle"],
                ].map(([label, n, dot]) => (
                  <li key={label as string} className="flex items-center gap-2">
                    <span className={clsx("h-2 w-2 rounded-full", dot as string)} />
                    <span className="flex-1 text-muted">{label}</span>
                    <span className="tabular-nums font-medium">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-border py-3">
              {s.attention.length === 0 ? (
                <p className="flex items-center gap-2 text-[13px] text-muted">
                  <ShieldCheck className="h-4 w-4 text-success" /> Nothing needs attention.
                </p>
              ) : (
                <>
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" /> Needs attention
                  </p>
                  <ul className="space-y-1.5">
                    {s.attention.map((a, i) => (
                      <li key={a.device_id + a.protocol + a.port + i}>
                        <Link to={`/devices/${a.device_id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2">
                          <ProtocolBadge protocol={a.protocol} />
                          <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                          <span className="shrink-0 text-xs text-subtle">{a.checked_at ? relativeTime(a.checked_at) : ""}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Panel>

          <Panel title="Most used, last 30 days">
            {(s.top_devices ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-subtle">No sessions yet.</p>
            ) : (
              <ul className="space-y-3.5 py-4">
                {s.top_devices.map((t, i) => (
                  <li key={t.device_id}>
                    <Link to={`/devices/${t.device_id}`} className="group block">
                      <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="w-4 text-xs tabular-nums text-subtle">{i + 1}</span>
                          <span className="truncate font-medium group-hover:text-accent">{t.name}</span>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted">{t.sessions}</span>
                      </div>
                      <div className="ml-6 h-1.5 overflow-hidden rounded-full bg-surface-3">
                        <div className="h-full rounded-full bg-accent/70" style={{ width: `${(t.sessions / topMax) * 100}%` }} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Systems">
            <ul className="space-y-3 py-4">
              {systemList.map(([name, v]) => (
                <li key={name}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <OsIcon os={v.os} distro={v.distro} className="h-4 w-4" />
                      <span className="truncate">{name}</span>
                    </span>
                    <span className="text-xs tabular-nums text-muted">{v.count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-accent/60" style={{ width: `${(v.count / systemMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <Panel
          title="Recent activity"
          className="xl:col-span-3"
          action={<Link to="/activity" className="text-xs font-medium text-accent hover:underline"><Activity className="mr-1 inline h-3 w-3" />Activity log</Link>}
        >
          <ul className="divide-y divide-border">
            {s.recent_activity.map((e) => (
              <ActivityItem key={e.id} e={e} />
            ))}
          </ul>
        </Panel>
      </div>
      <DeviceFormDialog open={adding} onOpenChange={setAdding} onSaved={(d) => navigate(`/devices/${d.id}`)} />
      <QuickConnectDialog open={quick} onOpenChange={setQuick} />
    </>
  );
}
