// The world map is drawn on an equirectangular grid where one unit is one degree (see worldMapData.ts):
// x = longitude + 180, y = 84 - latitude. Everything on the map (markers, clicks, clusters) uses these two lines.
export const MAP_W = 360;
export const MAP_H = 142; // latitudes 84 .. -58
const MAX_LAT = 84;

export const project = (lat: number, lon: number): [number, number] => [lon + 180, MAX_LAT - lat];
export const unproject = (x: number, y: number): [number, number] => [MAX_LAT - y, x - 180]; // [lat, lon]

export interface MapPoint<T> {
  lat: number;
  lon: number;
  item: T;
}

interface Cluster<T> {
  /** Position on the map grid (the centre of its members). */
  x: number;
  y: number;
  items: T[];
}

/**
 * Groups points that lie within radius map units of each other (about 12 degrees reads well on a small map),
 * so servers in the same city or region become one marker with a count. The same input always gives the same
 * clusters: points are taken in order of position, not of arrival.
 */
export function clusterPoints<T>(points: MapPoint<T>[], radius = 12): Cluster<T>[] {
  const sorted = points
    .map((p) => ({ p, xy: project(p.lat, p.lon) }))
    .sort((a, b) => a.xy[0] - b.xy[0] || a.xy[1] - b.xy[1]);
  const out: Cluster<T>[] = [];
  for (const { p, xy } of sorted) {
    let best: Cluster<T> | null = null;
    let bestD = radius;
    for (const c of out) {
      const d = Math.hypot(c.x - xy[0], c.y - xy[1]);
      if (d <= bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best) {
      const n = best.items.length;
      best.x = (best.x * n + xy[0]) / (n + 1);
      best.y = (best.y * n + xy[1]) / (n + 1);
      best.items.push(p.item);
    } else {
      out.push({ x: xy[0], y: xy[1], items: [p.item] });
    }
  }
  return out;
}

export const isLat = (n: number) => Number.isFinite(n) && n >= -90 && n <= 90;
export const isLon = (n: number) => Number.isFinite(n) && n >= -180 && n <= 180;
