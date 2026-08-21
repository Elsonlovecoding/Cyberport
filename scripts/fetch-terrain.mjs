/* Bakes a real elevation grid for the Cyberport area from AWS Terrain Tiles
   (Mapzen/AWS Open Data "terrarium" PNGs — open, keyless), so the viewer can
   render the actual Pok Fu Lam topography instead of a flat plane, and so
   every building sits on its true ground level.

   Output: data/terrain.json — a GRID_N x GRID_N grid of int16 metres over the
   bbox, base64-encoded little-endian.

   Run by .github/workflows/fetch-osm-data.yml — not needed at runtime. */
import { writeFileSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";

const BBOX = { west: 114.115, south: 22.248, east: 114.145, north: 22.274 };
const SRC_Z = 14; // ~9.5 m/px at this latitude
const GRID_N = 384; // ~8 m grid spacing across the bbox
const TEMPLATE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const ATTRIBUTION =
  "Elevation: AWS Terrain Tiles (SRTM/NED and partners, public domain / CC-BY)";

const rad = (d) => (d * Math.PI) / 180;
const lonToPx = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
const latToPx = (lat, z) =>
  ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * 2 ** z * 256;

async function fetchTile(z, x, y) {
  const url = TEMPLATE.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (resp.ok) return PNG.sync.read(Buffer.from(await resp.arrayBuffer()));
      if (resp.status === 404) return null;
    } catch (_) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  return null;
}

// Pad by a tile so bilinear sampling at the edges has neighbours.
const x0 = Math.floor(lonToPx(BBOX.west, SRC_Z) / 256) - 1;
const x1 = Math.floor(lonToPx(BBOX.east, SRC_Z) / 256) + 1;
const y0 = Math.floor(latToPx(BBOX.north, SRC_Z) / 256) - 1;
const y1 = Math.floor(latToPx(BBOX.south, SRC_Z) / 256) + 1;

const tiles = new Map();
let fetched = 0;
for (let x = x0; x <= x1; x++) {
  for (let y = y0; y <= y1; y++) {
    const png = await fetchTile(SRC_Z, x, y);
    if (png) {
      tiles.set(`${x}/${y}`, png);
      fetched++;
    }
  }
}
console.log(`terrain tiles fetched: ${fetched}`);
if (fetched === 0) {
  console.error("No elevation tiles — skipping terrain bake.");
  process.exit(1);
}

// terrarium encoding: elevation_m = (R * 256 + G + B / 256) - 32768
function elevationAt(lon, lat) {
  const wx = lonToPx(lon, SRC_Z);
  const wy = latToPx(lat, SRC_Z);
  const tile = tiles.get(`${Math.floor(wx / 256)}/${Math.floor(wy / 256)}`);
  if (!tile) return null;
  const px = Math.min(255, Math.max(0, Math.floor(wx) % 256));
  const py = Math.min(255, Math.max(0, Math.floor(wy) % 256));
  const i = (tile.width * py + px) << 2;
  return tile.data[i] * 256 + tile.data[i + 1] + tile.data[i + 2] / 256 - 32768;
}

const grid = new Int16Array(GRID_N * GRID_N);
let min = Infinity;
let max = -Infinity;
let holes = 0;
for (let j = 0; j < GRID_N; j++) {
  // Row 0 = north edge, matching the app's sampler.
  const lat = BBOX.north - ((BBOX.north - BBOX.south) * j) / (GRID_N - 1);
  for (let i = 0; i < GRID_N; i++) {
    const lon = BBOX.west + ((BBOX.east - BBOX.west) * i) / (GRID_N - 1);
    let e = elevationAt(lon, lat);
    if (e === null || !Number.isFinite(e)) {
      e = 0;
      holes++;
    }
    // Sea floor reads negative; clamp to sea level so water renders flat.
    const v = Math.round(Math.max(0, Math.min(1000, e)));
    grid[j * GRID_N + i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
}

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/terrain.json",
  JSON.stringify({
    attribution: ATTRIBUTION,
    west: BBOX.west,
    south: BBOX.south,
    east: BBOX.east,
    north: BBOX.north,
    size: GRID_N,
    min,
    max,
    // int16 little-endian, row-major, row 0 = north edge
    data: Buffer.from(grid.buffer).toString("base64"),
    generated: new Date().toISOString(),
  })
);
console.log(`terrain grid ${GRID_N}x${GRID_N} min=${min}m max=${max}m holes=${holes}`);
if (max < 20) {
  console.error("Terrain looks flat — refusing to publish.");
  process.exit(1);
}
