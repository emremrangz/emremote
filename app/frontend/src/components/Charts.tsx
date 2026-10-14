import clsx from "clsx";

/** Small SVG charts for the Overview. They use currentColor, so the caller sets the colour with a text-* class. */

export function Ring({ value, size = 56, stroke = 6, className, label }: { value: number; size?: number; stroke?: number; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-surface-3" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          className={clsx("stroke-current transition-[stroke-dasharray] duration-700", className ?? "text-success")}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">{Math.round(v)}%</span>
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  className: string; // text-* colour
}

export function Donut({ segments, size = 132, stroke = 16, center }: { segments: Segment[]; size?: number; stroke?: number; center?: React.ReactNode }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-surface-3" />
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / total) * c;
              const gap = segments.filter((x) => x.value > 0).length > 1 ? 2 : 0;
              const el = (
                <circle
                  key={s.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  strokeWidth={stroke}
                  strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                  strokeDashoffset={-offset}
                  className={clsx("stroke-current", s.className)}
                />
              );
              offset += len;
              return el;
            })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>
    </div>
  );
}

export function Sparkline({ values, className, height = 36 }: { values: number[]; className?: string; height?: number }) {
  const w = 120;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${height} L0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={clsx("h-9 w-full", className ?? "text-accent")} aria-hidden="true">
      <path d={area} className="fill-current opacity-15" />
      <path d={line} fill="none" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" className="stroke-current" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function DayBars({ days }: { days: { date: string; count: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const today = days.length - 1;
  return (
    <div className="flex h-36 items-end gap-1.5" role="img" aria-label="Sessions per day over the last 14 days">
      {days.map((d, i) => {
        const dt = new Date(d.date + "T12:00:00");
        const pct = d.count ? Math.max(6, (d.count / max) * 100) : 0;
        return (
          <div key={d.date} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5" title={`${dt.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}: ${d.count} session${d.count === 1 ? "" : "s"}`}>
            <span className="text-[10px] tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100">{d.count || ""}</span>
            <div className="flex w-full flex-1 items-end">
              <div
                className={clsx(
                  "w-full rounded-t-md transition-all duration-500",
                  d.count === 0 ? "h-[3px] rounded-full bg-surface-3" : i === today ? "bg-accent" : "bg-accent/45 group-hover:bg-accent/70",
                )}
                style={d.count ? { height: `${pct}%` } : undefined}
              />
            </div>
            <span className={clsx("text-[10px]", i === today ? "font-semibold text-fg" : "text-subtle")}>{dt.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2)}</span>
          </div>
        );
      })}
    </div>
  );
}

export interface StackDay {
  date: string;
  values: { key: string; value: number; className: string }[];
}

/** Stacked daily bars; the legend is left to the caller. */
export function StackedBars({ days, height = 176 }: { days: StackDay[]; height?: number }) {
  const max = Math.max(1, ...days.map((d) => d.values.reduce((s, v) => s + v.value, 0)));
  const every = days.length > 45 ? 14 : days.length > 14 ? 5 : 1;
  return (
    <div role="img" aria-label="Sessions per day by protocol">
      <div className="flex items-end gap-[3px]" style={{ height }}>
        {days.map((d, i) => {
          const total = d.values.reduce((s, v) => s + v.value, 0);
          const dt = new Date(d.date + "T12:00:00");
          const tip = `${dt.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}: ${total} session${total === 1 ? "" : "s"}${
            total ? " (" + d.values.filter((v) => v.value).map((v) => `${v.value} ${v.key.toUpperCase()}`).join(", ") + ")" : ""
          }`;
          return (
            <div key={d.date} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={tip}>
              {total === 0 ? (
                <div className="h-[3px] w-full rounded-full bg-surface-3" />
              ) : (
                <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-[5px] transition-opacity group-hover:opacity-80" style={{ height: `${Math.max(4, (total / max) * 100)}%` }}>
                  {d.values
                    .filter((v) => v.value)
                    .map((v) => (
                      <div key={v.key} className={v.className} style={{ height: `${(v.value / total) * 100}%` }} />
                    ))}
                </div>
              )}
              {i === days.length - 1 && <span className="sr-only">today</span>}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-[3px]">
        {days.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 text-center text-[10px] text-subtle">
            {(days.length - 1 - i) % every === 0 ? new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }).replace(" ", " ") : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Weekday × hour grid; the darker the cell, the more sessions started then. */
export function Heatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(1, ...grid.flat());
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div role="img" aria-label="Sessions by weekday and hour">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "2rem repeat(24, minmax(0, 1fr))" }}>
        {order.map((dow) => (
          <div key={dow} className="contents">
            <span className="flex items-center text-[10px] text-subtle">{names[dow]}</span>
            {grid[dow].map((n, h) => (
              <div
                key={h}
                className="relative aspect-square overflow-hidden rounded-[3px] bg-surface-3"
                title={`${names[dow]} ${String(h).padStart(2, "0")}:00: ${n} session${n === 1 ? "" : "s"}`}
              >
                {n > 0 && <div className="absolute inset-0 bg-accent" style={{ opacity: 0.18 + (n / max) * 0.82 }} />}
              </div>
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[10px] text-subtle">
            {h % 6 === 0 ? h : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
