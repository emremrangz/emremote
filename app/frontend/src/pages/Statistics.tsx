import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Clock, Cpu, KeyRound, MemoryStick, ShieldCheck, Timer, Users as UsersIcon } from "lucide-react";
import { useDevices, useStatistics } from "@/hooks/queries";
import { ErrorState } from "@/components/ui/misc";
import { PageLoader } from "@/components/ui/Spinner";
import { Panel } from "@/components/DashboardParts";
import { OsIcon, distroOf } from "@/components/OsIcon";
import { Donut, Heatmap, Ring, StackedBars } from "@/components/Charts";
import { bytes, duration } from "@/lib/format";
import { DEVICE_TYPE_LABELS, OS_LABELS } from "@/lib/constants";
import type { OS } from "@/lib/types";

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const PROTOCOL_COLORS = {
  ssh: { label: "SSH", bar: "bg-success/80", text: "text-success", dot: "bg-success/80" },
  rdp: { label: "RDP", bar: "bg-accent", text: "text-accent", dot: "bg-accent" },
  vnc: { label: "VNC", bar: "bg-[#a78bfa]", text: "text-[#a78bfa]", dot: "bg-[#a78bfa]" },
  telnet: { label: "Telnet", bar: "bg-warning/80", text: "text-warning", dot: "bg-warning/80" },
} as const;

const KIND_LABELS: Record<string, string> = { vm: "Virtual machines", container: "Containers", physical: "Physical machines", unknown: "Not detected yet" };

/** A key figure with an icon, a headline number and a line of context. */
function Kpi({ icon, label, value, sub, to }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; to?: string }) {
  const body = (
    <>
      <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-muted">{icon}</span>
      <p className="mt-4 text-[13px] text-muted">{label}</p>
      <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-[-0.03em]">{value}</p>
      {sub && <p className="mt-2 text-xs text-subtle">{sub}</p>}
    </>
  );
  const cls = "card p-5 transition-colors";
  return to ? (
    <Link to={to} className={clsx(cls, "hover:border-border-strong")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Meter({ value, max, className }: { value: number; max: number; className?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
      <div className={clsx("h-full rounded-full", className ?? "bg-accent/70")} style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

function Legend({ items }: { items: { label: string; className: string; value?: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={clsx("h-2 w-2 rounded-full", i.className)} />
          {i.label}
          {i.value !== undefined && <span className="tabular-nums text-subtle">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function StatisticsPage() {
  const [days, setDays] = useState(30);
  const { data: st, isLoading, error, refetch } = useStatistics(days);
  const devices = useDevices();
  if (isLoading && !st) return <PageLoader />;
  if (error || !st) return <ErrorState error={error} onRetry={refetch} />;

  const proto = { ssh: 0, rdp: 0, vnc: 0, telnet: 0 };
  for (const d of st.by_day) {
    proto.ssh += d.ssh;
    proto.rdp += d.rdp;
    proto.vnc += d.vnc;
    proto.telnet += d.telnet;
  }
  const total = st.totals.sessions;
  const avg = st.totals.ended ? Math.round(st.totals.total_seconds / st.totals.ended) : 0;
  const perDay = total / st.days;
  const f = st.fleet;
  const topMax = Math.max(1, ...st.top_devices.map((d) => d.sessions));
  const userMax = Math.max(1, ...st.users.map((u) => u.sessions));

  // Systems in use, by the distribution each device reports when known.
  const sys = new Map<string, { n: number; os: OS; distro?: string }>();
  for (const d of devices.data ?? []) {
    const name = distroOf(d.facts?.os)?.name ?? OS_LABELS[d.os];
    const cur = sys.get(name);
    if (cur) cur.n++;
    else sys.set(name, { n: 1, os: d.os, distro: d.facts?.os });
  }
  const sysList = [...sys.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  const sysMax = Math.max(1, ...sysList.map(([, v]) => v.n));
  const typeList = Object.entries(f.types).sort((a, b) => b[1] - a[1]);
  const groupMax = Math.max(1, ...f.groups.map((g) => g.count));
  const kinds = ["vm", "container", "physical", "unknown"].map((k) => ({ k, n: f.kinds[k] ?? 0 })).filter((x) => x.n > 0);
  const kindClass: Record<string, string> = { vm: "text-accent", container: "text-[#a78bfa]", physical: "text-success", unknown: "text-subtle" };
  const sshPct = st.security.ssh_total ? (st.security.ssh_pinned / st.security.ssh_total) * 100 : 100;
  const rdpPct = st.security.rdp_total ? (st.security.rdp_pinned / st.security.rdp_total) * 100 : 100;
  const twoFaPct = st.security.users ? (st.security.two_factor_users / st.security.users) * 100 : 0;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Statistics</h1>
          <p className="mt-1 text-[13px] text-muted">How the fleet is used and how it is doing. Based on the audit log and the device inventory.</p>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              aria-pressed={days === p.days}
              className={clsx("h-8 rounded-md px-3.5 text-[13px] font-medium transition-colors", days === p.days ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={<Activity className="h-4 w-4" />}
          label="Sessions"
          value={total}
          sub={
            <>
              {perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1)} per day
              {st.totals.failed > 0 && <span className="text-warning"> · {st.totals.failed} failed to start</span>}
            </>
          }
        />
        <Kpi icon={<Clock className="h-4 w-4" />} label="Time connected" value={st.totals.total_seconds ? duration(st.totals.total_seconds) : "0m"} sub={avg ? `${duration(avg)} on average per session` : "No finished sessions yet"} />
        <Kpi
          icon={<Timer className="h-4 w-4" />}
          label="Devices used"
          value={
            <>
              {st.totals.unique_devices}
              <span className="text-lg font-normal text-subtle"> / {f.devices}</span>
            </>
          }
          sub={f.devices ? `${Math.round((st.totals.unique_devices / f.devices) * 100)}% of the inventory was opened` : undefined}
          to="/devices"
        />
        <Kpi
          icon={<ArrowUpFromLine className="h-4 w-4" />}
          label="Files moved"
          value={st.transfers.uploads + st.transfers.downloads}
          sub={
            <span className="inline-flex flex-wrap items-center gap-x-3">
              <span className="inline-flex items-center gap-1">
                <ArrowUpFromLine className="h-3 w-3" /> {st.transfers.uploads} up · {bytes(st.transfers.upload_bytes)}
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowDownToLine className="h-3 w-3" /> {st.transfers.downloads} down · {bytes(st.transfers.download_bytes)}
              </span>
            </span>
          }
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel
          title="Sessions per day"
          className="xl:col-span-2"
          action={<Legend items={(Object.keys(PROTOCOL_COLORS) as (keyof typeof PROTOCOL_COLORS)[]).filter((k) => proto[k] > 0).map((k) => ({ label: PROTOCOL_COLORS[k].label, className: PROTOCOL_COLORS[k].dot, value: proto[k] }))} />}
        >
          <div className="py-5">
            {total === 0 ? (
              <p className="flex h-44 items-center justify-center text-sm text-subtle">No sessions in this period.</p>
            ) : (
              <StackedBars
                days={st.by_day.map((d) => ({
                  date: d.date,
                  values: [
                    { key: "ssh", value: d.ssh, className: PROTOCOL_COLORS.ssh.bar },
                    { key: "rdp", value: d.rdp, className: PROTOCOL_COLORS.rdp.bar },
                    { key: "vnc", value: d.vnc, className: PROTOCOL_COLORS.vnc.bar },
                    { key: "telnet", value: d.telnet, className: PROTOCOL_COLORS.telnet.bar },
                  ],
                }))}
              />
            )}
          </div>
        </Panel>
        <Panel title="Protocols used">
          <div className="flex h-full items-center gap-5 py-5">
            <Donut
              segments={(Object.keys(PROTOCOL_COLORS) as (keyof typeof PROTOCOL_COLORS)[]).map((k) => ({ label: PROTOCOL_COLORS[k].label, value: proto[k], className: PROTOCOL_COLORS[k].text }))}
              center={
                <>
                  <span className="text-2xl font-semibold tabular-nums tracking-[-0.03em]">{total}</span>
                  <span className="text-[11px] text-subtle">sessions</span>
                </>
              }
            />
            <ul className="min-w-0 flex-1 space-y-2 text-[13px]">
              {(Object.keys(PROTOCOL_COLORS) as (keyof typeof PROTOCOL_COLORS)[]).map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <span className={clsx("h-2 w-2 rounded-full", PROTOCOL_COLORS[k].dot)} />
                  <span className="flex-1 text-muted">{PROTOCOL_COLORS[k].label}</span>
                  <span className="tabular-nums font-medium">{proto[k]}</span>
                  <span className="w-9 text-right text-xs tabular-nums text-subtle">{total ? Math.round((proto[k] / total) * 100) : 0}%</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="When sessions start" className="xl:col-span-2" action={<span className="text-xs text-subtle">Your local time</span>}>
          <div className="py-5">{total === 0 ? <p className="flex h-40 items-center justify-center text-sm text-subtle">No sessions in this period.</p> : <Heatmap grid={st.heatmap} />}</div>
        </Panel>
        <Panel title="Most used devices">
          {st.top_devices.length === 0 ? (
            <p className="py-8 text-center text-sm text-subtle">No sessions in this period.</p>
          ) : (
            <ul className="space-y-3.5 py-4">
              {st.top_devices.map((d, i) => (
                <li key={d.device_id}>
                  <Link to={`/devices/${d.device_id}`} className="group block">
                    <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="w-4 text-xs tabular-nums text-subtle">{i + 1}</span>
                        <span className="truncate font-medium group-hover:text-accent">{d.name}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {d.sessions} · {d.seconds ? duration(d.seconds) : "-"}
                      </span>
                    </div>
                    <div className="ml-6">
                      <Meter value={d.sessions} max={topMax} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {st.security.admin_view && st.users.length > 0 && (
        <Panel title="Activity by user" className="mt-4" action={<UsersIcon className="h-4 w-4 text-subtle" />}>
          <ul className="grid gap-x-8 gap-y-3.5 py-4 md:grid-cols-2">
            {st.users.map((u) => (
              <li key={u.username}>
                <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold uppercase">{u.username.slice(0, 1)}</span>
                    <span className="truncate font-medium">{u.username}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {u.sessions} sessions · {u.seconds ? duration(u.seconds) : "-"}
                  </span>
                </div>
                <Meter value={u.sessions} max={userMax} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <h2 className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">The fleet</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Cpu className="h-4 w-4" />} label="CPU cores" value={f.cores || "-"} sub={f.with_facts ? `across ${f.with_facts} of ${f.devices} devices that report it` : "Read over SSH when a device page is opened"} />
        <Kpi icon={<MemoryStick className="h-4 w-4" />} label="Memory" value={f.memory_bytes ? bytes(f.memory_bytes, 0) : "-"} sub={f.with_facts ? `across ${f.with_facts} devices` : undefined} />
        <Kpi icon={<Clock className="h-4 w-4" />} label="Never opened" value={f.never_used} sub="Devices you have not connected to yet" to="/devices" />
        <Kpi icon={<Timer className="h-4 w-4" />} label="Idle for 30+ days" value={f.idle_30_days} sub="Last opened more than a month ago" to="/devices" />
      </div>

      <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Panel title="Systems">
          <ul className="space-y-3 py-4">
            {sysList.map(([name, v]) => (
              <li key={name}>
                <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <OsIcon os={v.os} distro={v.distro} className="h-4 w-4" />
                    <span className="truncate">{name}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted">{v.n}</span>
                </div>
                <Meter value={v.n} max={sysMax} className="bg-accent/60" />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Runs on">
          {kinds.length === 0 ? (
            <p className="py-8 text-center text-sm text-subtle">Nothing detected yet. Open devices that have an SSH sign-in saved.</p>
          ) : (
            <div className="flex items-center gap-5 py-5">
              <Donut
                size={116}
                stroke={14}
                segments={kinds.map((x) => ({ label: KIND_LABELS[x.k], value: x.n, className: kindClass[x.k] }))}
                center={
                  <>
                    <span className="text-xl font-semibold tabular-nums tracking-[-0.03em]">{f.devices}</span>
                    <span className="text-[11px] text-subtle">devices</span>
                  </>
                }
              />
              <ul className="min-w-0 flex-1 space-y-2 text-[13px]">
                {kinds.map((x) => (
                  <li key={x.k} className="flex items-center gap-2">
                    <span className={clsx("h-2 w-2 rounded-full bg-current", kindClass[x.k])} />
                    <span className="flex-1 truncate text-muted">{KIND_LABELS[x.k]}</span>
                    <span className="tabular-nums font-medium">{x.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {typeList.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-border py-3.5">
              {typeList.map(([t, n]) => (
                <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                  {DEVICE_TYPE_LABELS[t as keyof typeof DEVICE_TYPE_LABELS] ?? t} <span className="tabular-nums text-fg">{n}</span>
                </span>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Groups and tags">
          {f.groups.length === 0 && f.tags.length === 0 ? (
            <p className="py-8 text-center text-sm text-subtle">No groups or tags yet.</p>
          ) : (
            <>
              {f.groups.length > 0 && (
                <ul className="space-y-3 py-4">
                  {f.groups.map((g) => (
                    <li key={g.name}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
                        <span className="truncate">{g.name}</span>
                        <span className="text-xs tabular-nums text-muted">{g.count}</span>
                      </div>
                      <Meter value={g.count} max={groupMax} className="bg-success/60" />
                    </li>
                  ))}
                </ul>
              )}
              {f.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 border-t border-border py-3.5">
                  {f.tags.map((t) => (
                    <span key={t.name} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">
                      {t.name} <span className="tabular-nums text-fg">{t.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>
      </div>

      <h2 className="mb-3 mt-8 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">Security and hygiene</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card flex items-center gap-4 p-5">
          <Ring value={sshPct} className={sshPct === 100 ? "text-success" : "text-warning"} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">SSH host keys pinned</p>
            <p className="mt-0.5 text-xs text-subtle">
              {st.security.ssh_pinned} of {st.security.ssh_total} SSH connections
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-4 p-5">
          <Ring value={rdpPct} className={rdpPct === 100 ? "text-success" : "text-warning"} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">RDP certificates pinned</p>
            <p className="mt-0.5 text-xs text-subtle">
              {st.security.rdp_pinned} of {st.security.rdp_total} RDP connections
            </p>
          </div>
        </div>
        {st.security.admin_view ? (
          <>
            <div className="card flex items-center gap-4 p-5">
              <Ring value={twoFaPct} className={twoFaPct === 100 ? "text-success" : "text-accent"} />
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Two-factor sign-in</p>
                <p className="mt-0.5 text-xs text-subtle">
                  {st.security.two_factor_users} of {st.security.users} accounts
                </p>
              </div>
            </div>
            <Link to="/activity" className="card flex items-center gap-4 p-5 transition-colors hover:border-border-strong">
              <span className={clsx("flex h-14 w-14 shrink-0 items-center justify-center rounded-full border", st.security.failed_logins ? "border-warning/40 bg-warning/10 text-warning" : "border-success/30 bg-success/10 text-success")}>
                {st.security.failed_logins ? <AlertTriangle className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Failed sign-ins</p>
                <p className="mt-0.5 text-xs text-subtle">{st.security.failed_logins === 0 ? "None in this period" : `${st.security.failed_logins} in the last ${st.days} days`}</p>
              </div>
            </Link>
          </>
        ) : (
          <Link to="/credentials" className="card flex items-center gap-4 p-5 transition-colors hover:border-border-strong">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-muted">
              <KeyRound className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Saved credentials</p>
              <p className="mt-0.5 text-xs text-subtle">Manage them on the Credentials page</p>
            </div>
          </Link>
        )}
      </div>
    </>
  );
}
