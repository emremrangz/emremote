import { useMemo, useState } from "react";
import { MapPin, Search, X } from "lucide-react";
import { PickMap } from "./WorldMap";
import { cityLabel, searchCities } from "@/lib/cities";
import { isLat, isLon } from "@/lib/worldMap";

export interface LocationDraft {
  label: string;
  lat: string;
  lon: string;
}

export const emptyLocation: LocationDraft = { label: "", lat: "", lon: "" };

/** The draft as numbers, or null when it is empty or not valid yet. */
export function parseLocation(d: LocationDraft): { label: string; latitude: number; longitude: number } | null {
  const lat = Number(d.lat.trim().replace(",", "."));
  const lon = Number(d.lon.trim().replace(",", "."));
  if (d.lat.trim() === "" || d.lon.trim() === "" || !isLat(lat) || !isLon(lon)) return null;
  return { label: d.label.trim(), latitude: lat, longitude: lon };
}

/** Choosing where a device is: search a city, click the map, or type coordinates. Nothing is sent to a map service. */
export function LocationPicker({ value, onChange, error }: { value: LocationDraft; onChange: (v: LocationDraft) => void; error?: string }) {
  const [q, setQ] = useState("");
  const [showMap, setShowMap] = useState(false);
  const results = useMemo(() => searchCities(q), [q]);
  const parsed = parseLocation(value);
  const invalid = (value.lat.trim() !== "" || value.lon.trim() !== "") && !parsed;
  const set = (patch: Partial<LocationDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-2">
      {parsed ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-[13px]">
          <MapPin className="h-4 w-4 shrink-0 text-accent" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle"
            value={value.label}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="Name of the place (optional)"
            maxLength={100}
            aria-label="Location name"
          />
          <span className="shrink-0 font-mono text-[11px] text-subtle">
            {parsed.latitude.toFixed(2)}, {parsed.longitude.toFixed(2)}
          </span>
          <button type="button" className="shrink-0 rounded p-1 text-muted hover:bg-surface-3 hover:text-fg" onClick={() => { onChange(emptyLocation); setQ(""); }} aria-label="Clear the location" title="Clear the location">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input
            className="input pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a city, for example Istanbul or Frankfurt"
            aria-label="Search a city"
            autoComplete="off"
            spellCheck={false}
          />
          {results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-surface p-1 text-[13px] shadow-pop" role="listbox" aria-label="Cities">
              {results.map((c) => (
                <li key={cityLabel(c)} role="option" aria-selected="false">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => {
                      onChange({ label: cityLabel(c), lat: String(c[2]), lon: String(c[3]) });
                      setQ("");
                    }}
                  >
                    <span>{c[0]}</span>
                    <span className="text-xs text-subtle">{c[1]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <button type="button" className="underline-offset-2 hover:text-fg hover:underline" onClick={() => setShowMap((s) => !s)} aria-expanded={showMap}>
          {showMap ? "Hide the map" : "Choose on the map"}
        </button>
        <span className="text-subtle">or type</span>
        <label className="flex items-center gap-1.5">
          <span className="text-subtle">latitude</span>
          <input className="input h-7 w-24 font-mono text-xs" value={value.lat} onChange={(e) => set({ lat: e.target.value })} placeholder="41.01" inputMode="decimal" aria-label="Latitude" />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-subtle">longitude</span>
          <input className="input h-7 w-24 font-mono text-xs" value={value.lon} onChange={(e) => set({ lon: e.target.value })} placeholder="28.98" inputMode="decimal" aria-label="Longitude" />
        </label>
      </div>
      {showMap && (
        <PickMap
          lat={parsed?.latitude}
          lon={parsed?.longitude}
          onPick={(lat, lon) => onChange({ label: parsed ? value.label : "", lat: String(lat), lon: String(lon) })}
        />
      )}
      {(error || invalid) && <p className="text-xs text-danger">{error ?? "Latitude is between -90 and 90 and longitude between -180 and 180."}</p>}
    </div>
  );
}
