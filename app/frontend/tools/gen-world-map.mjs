// Regenerates src/lib/worldMapData.ts from Natural Earth (public domain). Run it in an empty folder:
//   npm i world-atlas@2 topojson-client@3 && node gen-world-map.mjs   (then copy worldMapData.ts to src/lib)
import { readFileSync, writeFileSync } from "node:fs";
import * as topojson from "topojson-client";
const world = JSON.parse(readFileSync("node_modules/world-atlas/countries-110m.json", "utf8"));
// Equirectangular: x = longitude + 180, y = 84 - latitude, so one unit is one degree and a marker is placed with the same two lines.
const r1 = (n) => Math.round(n * 10) / 10;
// Rings and lines that cross the antimeridian (Chukotka, Fiji) jump from +180 to -180 between two points, which a flat map
// draws as a line across the whole world. Unwrap the longitudes so the shape is continuous, and draw it again shifted by 360
// degrees so the part that left the map on one side shows up on the other (the viewBox cuts off what is outside).
const unwrap = (r) => {
  const out = [];
  let off = 0, prev = null;
  for (const [lon, lat] of r) {
    if (prev !== null) { const d = lon - prev; if (d > 180) off -= 360; else if (d < -180) off += 360; }
    prev = lon;
    out.push([lon + off, lat]);
  }
  return out;
};
const toPath = (pts, close, shift) => {
  let out = "", last = "";
  pts.forEach(([lon, lat], i) => {
    const x = r1(lon + 180 + shift), y = r1(84 - lat);
    const k = x + " " + y;
    if (k === last) return;
    last = k;
    out += (out === "" ? "M" : "L") + x + " " + y;
  });
  return out + (close ? "Z" : "");
};
const shiftsFor = (pts) => {
  const lons = pts.map((p) => p[0]);
  const lo = Math.min(...lons), hi = Math.max(...lons);
  const shifts = [0];
  if (hi > 180) shifts.push(-360);
  if (lo < -180) shifts.push(360);
  return shifts;
};
const land = topojson.feature(world, world.objects.land);
const g = land.geometry ?? land.features[0].geometry;
const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
let landPath = "";
for (const poly of polys) {
  if (Math.max(...poly[0].map((p) => p[1])) < -56) continue; // Antarctica is outside the map
  const rings = poly.map(unwrap);
  for (const shift of shiftsFor(rings[0])) for (const r of rings) landPath += toPath(r, true, shift);
}
const mesh = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
let borders = "";
for (const line of mesh.coordinates) {
  if (Math.max(...line.map((p) => p[1])) < -56) continue;
  const u = unwrap(line);
  for (const shift of shiftsFor(u)) borders += toPath(u, false, shift);
}
const ts = `// Generated from Natural Earth 110m (public domain) through the world-atlas package. One unit is one degree:
// x = longitude + 180, y = 84 - latitude, so the map covers latitudes 84 to -58.
export const WORLD_VIEWBOX = "0 0 360 142";
export const WORLD_LAND = "${landPath}";
export const WORLD_BORDERS = "${borders}";
`;
writeFileSync("worldMapData.ts", ts);
console.log("land", landPath.length, "borders", borders.length, "total", ts.length);
