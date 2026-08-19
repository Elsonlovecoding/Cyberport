/* Converts a raw Overpass API response (osm-raw.json) into the compact
   building set the viewer's keyless "Open 3D" source renders.
   Run by .github/workflows/fetch-osm-data.yml — not needed at runtime. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BBOX = { south: 22.248, west: 114.115, north: 22.274, east: 114.145 };
const raw = JSON.parse(readFileSync(process.argv[2] || "osm-raw.json", "utf8"));

const round = (x) => Math.round(x * 1e6) / 1e6;

function parseMeters(v) {
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?)?$/i);
  return m ? Number(m[1]) : undefined;
}

// Height preference: explicit height tag -> levels * 3.1m + roof allowance ->
// footprint-size heuristic. Real where tagged, conservative where not.
function heightOf(tags, areaM2) {
  const h = parseMeters(tags.height) ?? parseMeters(tags["building:height"]);
  if (h !== undefined && h > 1 && h < 500) return h;
  const levels = Number(tags["building:levels"]);
  if (Number.isFinite(levels) && levels > 0 && levels < 120) {
    return levels * 3.1 + 2;
  }
  return areaM2 > 1500 ? 16 : 8;
}

// Rough planar area (m^2) from lon/lat ring — only used for the heuristic.
function ringArea(pts) {
  const R = 6378137;
  const rad = Math.PI / 180;
  const latRef = pts[0][1] * rad;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area +=
      (x1 * rad * Math.cos(latRef) * R) * (y2 * rad * R) -
      (x2 * rad * Math.cos(latRef) * R) * (y1 * rad * R);
  }
  return Math.abs(area / 2);
}

function ringFromGeometry(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 4) return null;
  const pts = geometry.map((g) => [round(g.lon), round(g.lat)]);
  const [fx, fy] = pts[0];
  const [lx, ly] = pts[pts.length - 1];
  if (fx === lx && fy === ly) pts.pop(); // drop duplicate closing vertex
  if (pts.length < 3) return null;
  for (const [lon, lat] of pts) {
    if (lat < BBOX.south - 0.01 || lat > BBOX.north + 0.01) return null;
    if (lon < BBOX.west - 0.01 || lon > BBOX.east + 0.01) return null;
  }
  return pts;
}

const buildings = [];
let skipped = 0;

for (const el of raw.elements || []) {
  const tags = el.tags || {};
  if (!tags.building || tags.building === "no") continue;

  const rings = [];
  if (el.type === "way") {
    const ring = ringFromGeometry(el.geometry);
    if (ring) rings.push(ring);
  } else if (el.type === "relation" && Array.isArray(el.members)) {
    for (const member of el.members) {
      if (member.role !== "outer") continue;
      const ring = ringFromGeometry(member.geometry);
      if (ring) rings.push(ring);
    }
  }
  if (rings.length === 0) {
    skipped++;
    continue;
  }
  for (const ring of rings) {
    const area = ringArea(ring);
    if (area < 4) continue; // sliver
    buildings.push({
      h: Math.round(heightOf(tags, area) * 10) / 10,
      n: tags.name || tags["name:en"] || undefined,
      p: ring,
    });
  }
}

buildings.sort((a, b) => b.h - a.h);

const out = {
  attribution: "Building data © OpenStreetMap contributors (ODbL)",
  source: "Overpass API extract; see .github/workflows/fetch-osm-data.yml",
  generated: new Date().toISOString(),
  bbox: BBOX,
  count: buildings.length,
  buildings,
};

mkdirSync("data", { recursive: true });
writeFileSync("data/cyberport-buildings.json", JSON.stringify(out));

const named = buildings.filter((b) => b.n).length;
const tallest = buildings[0];
console.log(
  `buildings=${buildings.length} named=${named} skippedNoGeom=${skipped} ` +
    `tallest=${tallest ? `${tallest.h}m ${tallest.n || "(unnamed)"}` : "n/a"} ` +
    `bytes=${JSON.stringify(out).length}`
);
if (buildings.length < 50) {
  console.error("Too few buildings — refusing to publish a broken extract.");
  process.exit(1);
}
