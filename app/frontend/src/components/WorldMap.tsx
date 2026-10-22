import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { WORLD_BORDERS, WORLD_LAND, WORLD_VIEWBOX } from "@/lib/worldMapData";
import { MAP_H, MAP_W, clusterPoints, project, unproject, type MapPoint } from "@/lib/worldMap";

export type MapTone = "ok" | "warn" | "bad" | "idle";

interface MapDevice {
  id: string;
  name: string;
  address: string;
  tone: MapTone;
  place: string;
}

const FILL: Record<MapTone, string> = { ok: "fill-success", warn: "fill-warning", bad: "fill-danger", idle: "fill-subtle" };

/** Green when everything in a group answers, red when nothing does, amber when it is mixed. */
function groupTone(items: MapDevice[]): MapTone {
  if (items.every((i) => i.tone === "idle")) return "idle";
  if (items.some((i) => i.tone === "bad") && items.some((i) => i.tone === "ok")) return "warn";
  if (items.some((i) => i.tone === "bad")) return "bad";
  if (items.some((i) => i.tone === "warn")) return "warn";
  return "ok";
}

/** The world as outlines, with the land and the borders drawn in the theme's colours. */
function Land() {
  return (
    <>
      <path d={WORLD_LAND} className="fill-border stroke-border-strong" strokeWidth="0.25" strokeLinejoin="round" />
      <path d={WORLD_BORDERS} className="fill-none stroke-border-strong" strokeWidth="0.15" />
    </>
  );
}

/**
 * Devices on a world map. Devices that are close together become one marker with a count; selecting a
 * marker lists what is in it. Nothing is loaded from the internet: the outlines ship with the application.
 */
export function WorldMap({ devices, className }: { devices: (MapDevice & { lat: number; lon: number })[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const clusters = useMemo(() => clusterPoints<MapDevice>(devices.map((d): MapPoint<MapDevice> => ({ lat: d.lat, lon: d.lon, item: d }))), [devices]);
  const sel = open !== null ? clusters[open] : null;
  return (
    <div className={clsx("relative", className)}>
      <svg viewBox={WORLD_VIEWBOX} className="block h-auto w-full" role="img" aria-label={`Map with ${devices.length} located device${devices.length === 1 ? "" : "s"}`} onClick={() => setOpen(null)}>
        <Land />
        {clusters.map((c, i) => {
          const tone = groupTone(c.items);
          const r = c.items.length === 1 ? 2.2 : 3 + Math.min(Math.log2(c.items.length) * 0.9, 3.5);
          return (
            <g
              key={i}
              role="button"
              tabIndex={0}
              aria-label={`${c.items.length} device${c.items.length === 1 ? "" : "s"}: ${c.items.map((d) => d.name).slice(0, 4).join(", ")}`}
              className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-fg"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(open === i ? null : i);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen(open === i ? null : i);
                }
              }}
            >
              <circle cx={c.x} cy={c.y} r={r + 1.6} className={clsx(FILL[tone], "opacity-25")} />
              <circle cx={c.x} cy={c.y} r={r} className={clsx(FILL[tone], "stroke-bg")} strokeWidth="0.5" />
              {c.items.length > 1 && (
                <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central" className="fill-white font-semibold" style={{ fontSize: r > 4 ? 3.6 : 3.2 }}>
                  {c.items.length}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {sel && (
        <div
          className="absolute z-10 w-56 -translate-x-1/2 rounded-lg border border-border bg-surface p-2 text-xs shadow-pop"
          style={{ left: `${Math.min(Math.max((sel.x / MAP_W) * 100, 18), 82)}%`, top: `${((sel.y / MAP_H) * 100).toFixed(1)}%`, marginTop: "1rem" }}
          role="dialog"
          aria-label="Devices here"
        >
          <p className="mb-1 px-1.5 font-medium text-muted">{placeOf(sel.items)}</p>
          <ul className="max-h-40 space-y-0.5 overflow-auto">
            {sel.items.map((d) => (
              <li key={d.id}>
                <Link to={`/devices/${d.id}`} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2">
                  <span className={clsx("h-2 w-2 shrink-0 rounded-full", FILL[d.tone].replace("fill-", "bg-"))} />
                  <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-subtle">{d.address}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function placeOf(items: MapDevice[]): ReactNode {
  const places = Array.from(new Set(items.map((i) => i.place).filter(Boolean)));
  return places.length ? places.slice(0, 2).join(" · ") + (places.length > 2 ? ` +${places.length - 2}` : "") : `${items.length} devices`;
}

/** A small map for choosing a point: click anywhere to put the marker there. */
export function PickMap({ lat, lon, onPick }: { lat?: number; lon?: number; onPick: (lat: number, lon: number) => void }) {
  const pos = lat !== undefined && lon !== undefined ? project(lat, lon) : null;
  return (
    <svg
      viewBox={WORLD_VIEWBOX}
      className="block h-auto w-full cursor-crosshair rounded-lg border border-border bg-surface-2/60"
      role="application"
      aria-label="Click the map to choose a location"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * MAP_W;
        const y = ((e.clientY - r.top) / r.height) * MAP_H;
        const [la, lo] = unproject(x, y);
        onPick(Math.round(la * 100) / 100, Math.round(lo * 100) / 100);
      }}
    >
      <Land />
      {pos && (
        <>
          <circle cx={pos[0]} cy={pos[1]} r="4.2" className="fill-accent opacity-25" />
          <circle cx={pos[0]} cy={pos[1]} r="2.2" className="fill-accent stroke-bg" strokeWidth="0.6" />
        </>
      )}
    </svg>
  );
}
