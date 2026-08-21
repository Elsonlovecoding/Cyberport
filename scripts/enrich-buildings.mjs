/* Enriches data/cyberport-buildings.json with REAL per-building appearance:

   1. Roof colour is MEASURED from the Lands Department orthophoto already in
      data/imagery/ — the aerial photo literally contains each roof's pixels,
      so every building ends up its true colour rather than a guess.
   2. Facade colour comes from OSM building:colour / Overture facade_color
      when mapped; otherwise it is derived from the measured roof colour and
      the building's type/height (documented as inferred, not measured).
   3. Heights are replaced by Overture Maps values when available (real
      per-building heights merged from OSM + ML sources), keeping the OSM
      height whenever it was explicitly mapped.

   Run by .github/workflows/fetch-osm-data.yml after the fetch steps. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";

const BUILDINGS = "data/cyberport-buildings.json";
const IMAGERY_DIR = "data/imagery";
const OVERTURE = process.argv[2] || "overture-buildings.json";

const data = JSON.parse(readFileSync(BUILDINGS, "utf8"));
const buildings = data.buildings || [];

/* ---------- tile pixel lookup (web mercator) ---------- */

const manifest = existsSync(`${IMAGERY_DIR}/manifest.json`)
  ? JSON.parse(readFileSync(`${IMAGERY_DIR}/manifest.json`, "utf8"))
  : null;
const SAMPLE_Z = manifest ? manifest.maxZoom : 17;
const tileCache = new Map();

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const file = `${IMAGERY_DIR}/${z}/${x}/${y}.png`;
  let tile = null;
  if (existsSync(file)) {
    try {
      tile = PNG.sync.read(readFileSync(file));
    } catch (_) {
      tile = null;
    }
  }
  tileCache.set(key, tile);
  return tile;
}

// Pixel at a geographic point, or null outside coverage.
function samplePixel(lon, lat) {
  const n = 2 ** SAMPLE_Z;
  const rad = (lat * Math.PI) / 180;
  const wx = ((lon + 180) / 360) * n * 256;
  const wy =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * 256;
  const tile = loadTile(SAMPLE_Z, Math.floor(wx / 256), Math.floor(wy / 256));
  if (!tile) return null;
  const px = Math.floor(wx) % 256;
  const py = Math.floor(wy) % 256;
  const idx = (tile.width * py + px) << 2;
  const a = tile.data[idx + 3];
  if (a !== undefined && a < 200) return null; // transparent / no data
  return [tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]];
}

/* ---------- polygon helpers ---------- */

function centroidOf(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-14) {
    // Degenerate ring — fall back to the vertex average.
    return [
      ring.reduce((s, p) => s + p[0], 0) / ring.length,
      ring.reduce((s, p) => s + p[1], 0) / ring.length,
    ];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* ---------- colour utilities ---------- */

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const toHex = (c) =>
  "#" + c.map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");

function parseHex(str) {
  if (typeof str !== "string") return null;
  const named = {
    white: [235, 235, 232], grey: [150, 150, 150], gray: [150, 150, 150],
    black: [60, 60, 62], red: [150, 70, 60], brown: [130, 100, 80],
    beige: [214, 200, 172], cream: [226, 214, 186], yellow: [214, 194, 130],
    green: [110, 130, 105], blue: [110, 130, 160], silver: [178, 180, 182],
    tan: [200, 180, 150], pink: [214, 180, 176], orange: [200, 140, 90],
  };
  const key = str.trim().toLowerCase();
  if (named[key]) return named[key];
  const m = key.match(/^#?([0-9a-f]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Robust roof colour: sample a grid inside the footprint (shrunk toward the
   centroid so edge pixels — ground, gutters, shadow cast onto neighbours —
   don't pollute the reading), then average the interquartile band by
   luminance. That rejects both deep shadow and blown-out highlights. */
function measureRoofColour(ring) {
  const [cx, cy] = centroidOf(ring);
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  // Shrink 22% toward the centroid: keeps the sample on the roof proper.
  const inner = ring.map(([x, y]) => [cx + (x - cx) * 0.78, cy + (y - cy) * 0.78]);

  const STEPS = 14;
  const samples = [];
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const lon = minLon + ((maxLon - minLon) * i) / STEPS;
      const lat = minLat + ((maxLat - minLat) * j) / STEPS;
      if (!pointInRing(lon, lat, inner)) continue;
      const px = samplePixel(lon, lat);
      if (px) samples.push(px);
    }
  }
  if (samples.length === 0) {
    const px = samplePixel(cx, cy);
    if (px) samples.push(px);
  }
  if (samples.length === 0) return null;

  samples.sort((a, b) => lum(a) - lum(b));
  const lo = Math.floor(samples.length * 0.25);
  const hi = Math.max(lo + 1, Math.ceil(samples.length * 0.75));
  const band = samples.slice(lo, hi);
  const avg = [0, 1, 2].map((k) => band.reduce((s, c) => s + c[k], 0) / band.length);
  return { colour: avg, samples: samples.length };
}

/* Facades: measured roofs tell us the building's palette, but a roof is not a
   wall. Where the wall colour is actually mapped we use it; otherwise we move
   the measured roof colour to a realistic facade tone.

   The shift is ADDITIVE in luminance and DAMPED in chroma. Scaling RGB
   multiplicatively (the obvious approach) amplifies saturation — a dark
   slate-blue roof becomes neon cyan — whereas keeping the colour's distance
   from grey roughly fixed while raising its lightness is what real paint,
   render and curtain wall actually look like. */
const FACADE_CHROMA = 0.45; // how much of the roof's colour cast the wall keeps
const FACADE_CHROMA_CAP = 26; // max distance from neutral, per channel

function deriveFacade(roof, b) {
  const tagged = parseHex(b.bc) || parseHex(b.facadeColor);
  if (tagged) return tagged;
  if (!roof) return b.h > 90 ? [156, 162, 170] : [208, 200, 188];

  const glassy = b.h > 90 || b.m === "glass" || b.t === "office";
  // Deterministic per-building nudge so neighbours never look cloned.
  const seed = Math.abs(Math.sin(b.p[0][0] * 4321.7 + b.p[0][1] * 1234.3));
  const target = (glassy ? 158 : 198) + (seed - 0.5) * 26;

  const g = lum(roof);
  let c = roof.map((v) => {
    const chroma = Math.max(-FACADE_CHROMA_CAP, Math.min(FACADE_CHROMA_CAP, (v - g) * FACADE_CHROMA));
    return target + chroma;
  });
  // Material tint: curtain wall cools, painted render warms.
  c = glassy ? [c[0] - 6, c[1] - 1, c[2] + 8] : [c[0] + 7, c[1] + 1, c[2] - 7];
  return c;
}

/* ---------- ground elevation (so buildings sit on the real hillside) ---------- */

let terrain = null;
if (existsSync("data/terrain.json")) {
  try {
    const t = JSON.parse(readFileSync("data/terrain.json", "utf8"));
    const buf = Buffer.from(t.data, "base64");
    terrain = {
      ...t,
      grid: new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2),
    };
  } catch (_) {
    terrain = null;
  }
}

function groundAt(lon, lat) {
  if (!terrain) return 0;
  const n = terrain.size;
  const fx = ((lon - terrain.west) / (terrain.east - terrain.west)) * (n - 1);
  const fy = ((terrain.north - lat) / (terrain.north - terrain.south)) * (n - 1);
  const x = Math.max(0, Math.min(n - 1, fx));
  const y = Math.max(0, Math.min(n - 1, fy));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const g = terrain.grid;
  const top = g[y0 * n + x0] * (1 - tx) + g[y0 * n + x1] * tx;
  const bot = g[y1 * n + x0] * (1 - tx) + g[y1 * n + x1] * tx;
  return top * (1 - ty) + bot * ty;
}

/* ---------- Overture heights (best effort) ---------- */

// Accepts either GeoJSON (what the overturemaps CLI writes) or one JSON
// object per line, so the source can change without touching this script.
function coordCentre(geom) {
  const xs = [];
  const ys = [];
  const walk = (a) => {
    if (typeof a[0] === "number") {
      xs.push(a[0]);
      ys.push(a[1]);
    } else for (const sub of a) walk(sub);
  };
  if (!geom || !Array.isArray(geom.coordinates)) return null;
  walk(geom.coordinates);
  if (!xs.length) return null;
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

let overture = [];
if (existsSync(OVERTURE)) {
  try {
    const rawText = readFileSync(OVERTURE, "utf8").trim();
    if (rawText) {
      const records = [];
      if (rawText.startsWith("{") && rawText.includes('"FeatureCollection"')) {
        const fc = JSON.parse(rawText);
        for (const f of fc.features || []) {
          const c = coordCentre(f.geometry);
          if (c) records.push({ lon: c[0], lat: c[1], ...(f.properties || {}) });
        }
      } else {
        for (const line of rawText.split("\n")) {
          try {
            const o = JSON.parse(line);
            if (o && o.type === "Feature") {
              const c = coordCentre(o.geometry);
              if (c) records.push({ lon: c[0], lat: c[1], ...(o.properties || {}) });
            } else if (o) {
              records.push(o);
            }
          } catch (_) {
            /* skip malformed line */
          }
        }
      }
      overture = records.filter((o) => Number.isFinite(o.lon) && Number.isFinite(o.lat));
    }
  } catch (_) {
    overture = [];
  }
}
console.log(`overture records: ${overture.length}`);

// Metres per degree at Cyberport, for centroid matching.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((22.26 * Math.PI) / 180);

function nearestOverture(cx, cy) {
  let best = null;
  let bestD = Infinity;
  for (const o of overture) {
    const dx = (o.lon - cx) * M_PER_DEG_LON;
    const dy = (o.lat - cy) * M_PER_DEG_LAT;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= 20 * 20 ? best : null; // within 20 m
}

/* ---------- enrich ---------- */

let measured = 0;
let noPixels = 0;
let heightsFromOverture = 0;
let taggedColours = 0;

/* Pass 1 — merge Overture attributes and measure raw roof colour. */
const raw = new Map();
let onTerrain = 0;
for (const b of buildings) {
  const [cx, cy] = centroidOf(b.p);

  if (terrain) {
    // Lowest corner of the footprint: a building cut into a slope meets the
    // ground at its downhill side, so anchoring there avoids it floating.
    let g = Infinity;
    for (const [lon, lat] of b.p) g = Math.min(g, groundAt(lon, lat));
    if (Number.isFinite(g)) {
      b.g = Math.round(g * 10) / 10;
      onTerrain++;
    }
  }

  const o = overture.length ? nearestOverture(cx, cy) : null;
  if (o) {
    if (o.facade_color) b.facadeColor = o.facade_color;
    if (o.roof_color) b.rcTag = b.rcTag || o.roof_color;
    const oh = Number(o.height) || (Number(o.num_floors) ? Number(o.num_floors) * 3.1 + 2 : 0);
    // Overture wins over our estimate; a mapped OSM height wins over Overture.
    if (oh > 2 && oh < 500 && b.hs !== "tag") {
      b.h = Math.round(oh * 10) / 10;
      b.hs = "overture";
      heightsFromOverture++;
    }
  }

  if (parseHex(b.rcTag)) continue; // mapped colour needs no measurement
  const m = measureRoofColour(b.p);
  if (m) {
    raw.set(b, m.colour);
    measured++;
  } else {
    noPixels++;
  }
}

/* Aerial photography carries a strong colour cast (atmospheric haze over the
   harbour pushes everything blue-green) and reads dark. Across a thousand
   rooftops the true average is close to neutral grey, so the deviation of the
   measured average IS the cast — correct it out, grey-world style, then set
   exposure from the median. Gains are clamped so a genuinely tinted district
   can't be over-corrected into a different palette. */
const all = [...raw.values()];
const gains = [1, 1, 1];
let exposure = 1;
if (all.length > 20) {
  const means = [0, 1, 2].map((k) => all.reduce((s, c) => s + c[k], 0) / all.length);
  const grey = (means[0] + means[1] + means[2]) / 3;
  for (let k = 0; k < 3; k++) {
    gains[k] = Math.max(0.82, Math.min(1.25, grey / Math.max(means[k], 1)));
  }
  const lums = all
    .map((c) => lum([c[0] * gains[0], c[1] * gains[1], c[2] * gains[2]]))
    .sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)];
  exposure = Math.max(0.9, Math.min(1.75, 128 / Math.max(median, 1)));
}
const correct = (c) => [
  c[0] * gains[0] * exposure,
  c[1] * gains[1] * exposure,
  c[2] * gains[2] * exposure,
];
console.log(
  `white balance gains=${gains.map((g) => g.toFixed(3)).join("/")} exposure=${exposure.toFixed(3)}`
);

// Neutral stand-in for the handful of roofs with no usable pixels: the
// corrected average of everything that was measured.
const fallbackRoof =
  all.length > 20
    ? correct([0, 1, 2].map((k) => all.reduce((s, c) => s + c[k], 0) / all.length))
    : [168, 166, 160];

/* ---------- heights for buildings nobody has measured ----------

   241-odd buildings here carry a real mapped height. Rather than stamping
   every remaining building with a flat guess, fit the local building stock:
   group the KNOWN heights by type and footprint size, then give each unknown
   building the median of its matching group. The result is grounded in this
   district's actual buildings and produces real variety instead of a sea of
   identical 16 m slabs. Still an estimate — flagged as such in `hs`. */

function areaOf(ring) {
  const R = 6378137;
  const rad = Math.PI / 180;
  const latRef = ring[0][1] * rad;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * rad * Math.cos(latRef) * R * (y2 * rad * R) - x2 * rad * Math.cos(latRef) * R * (y1 * rad * R);
  }
  return Math.abs(a / 2);
}

const sizeBucket = (area) => Math.max(0, Math.min(5, Math.floor(Math.log2(Math.max(area, 25) / 50))));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Directly measured heights (HK 2020 LiDAR, DSM minus DTM) outrank every
// other source — they are observations of the actual buildings.
let lidarApplied = 0;
if (existsSync("hk-heights.json")) {
  try {
    const lidar = JSON.parse(readFileSync("hk-heights.json", "utf8"));
    buildings.forEach((b, i) => {
      const h = Number(lidar[String(i)]);
      if (Number.isFinite(h) && h >= 2.5 && h <= 500) {
        b.h = Math.round(h * 10) / 10;
        b.hs = "lidar";
        lidarApplied++;
      }
    });
  } catch (_) {
    /* leave heights alone */
  }
}
console.log(`lidar heights applied: ${lidarApplied}`);

{
  const groups = new Map();
  const bySize = new Map();
  const knownHeights = [];
  for (const b of buildings) {
    b._area = areaOf(b.p);
    if (b.hs !== "tag" && b.hs !== "overture" && b.hs !== "lidar") continue;
    const bucket = sizeBucket(b._area);
    const key = `${b.t || "yes"}|${bucket}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b.h);
    if (!bySize.has(bucket)) bySize.set(bucket, []);
    bySize.get(bucket).push(b.h);
    knownHeights.push(b.h);
  }
  const globalMedian = knownHeights.length ? median(knownHeights) : 12;

  const predict = (b) => {
    const bucket = sizeBucket(b._area);
    const g = groups.get(`${b.t || "yes"}|${bucket}`);
    if (g && g.length >= 4) return median(g);
    const s = bySize.get(bucket);
    if (s && s.length >= 4) return median(s);
    return globalMedian;
  };

  // Honest accuracy check: how well does the model reproduce the heights we
  // actually know? Reported so the estimate's quality is never a mystery.
  const errs = [];
  for (const b of buildings) {
    if (b.hs === "tag" || b.hs === "overture" || b.hs === "lidar") {
      errs.push(Math.abs(predict(b) - b.h));
    }
  }
  console.log(
    `height model: ${knownHeights.length} known, ${groups.size} groups, ` +
      `median abs error on known buildings = ${errs.length ? median(errs).toFixed(1) : "n/a"} m`
  );

  let estimated = 0;
  for (const b of buildings) {
    if (b.hs === "tag" || b.hs === "overture" || b.hs === "lidar") continue;
    b.h = Math.round(predict(b) * 10) / 10;
    b.hs = "modelled";
    estimated++;
  }
  console.log(`heights modelled from local building stock: ${estimated}`);
  for (const b of buildings) delete b._area;
}

/* Pass 2 — apply the correction and derive facades. */
for (const b of buildings) {
  const tagRoof = parseHex(b.rcTag);
  let roof = null;
  if (tagRoof) {
    roof = tagRoof;
    taggedColours++;
  } else if (raw.has(b)) {
    roof = correct(raw.get(b));
  }

  const facade = deriveFacade(roof, b);
  b.rc = toHex(roof || fallbackRoof);
  b.fc = toHex(facade);
  b.cs = tagRoof ? "tag" : roof ? "photo" : "default"; // colour source

  // Tag-only fields have served their purpose.
  delete b.bc;
  delete b.rcTag;
  delete b.m;
  delete b.facadeColor;
}

/* ---------- trees: elevations for mapped trees, scatter in green areas ----------

   Mapped `natural=tree` nodes are real, individually surveyed positions.
   Green polygons (parks/woods) get a deterministic scatter so the canopy
   the aerial photo shows as flat texture gains 3D presence — those points
   are synthesized inside REAL green areas and marked as such (src=0). */

function pipRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const hash2 = (x, y) => {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

{
  const mapped = Array.isArray(data.trees) ? data.trees : [];
  const rings = Array.isArray(data.green) ? data.green : [];
  const out = [];
  for (const t of mapped) {
    out.push([t[0], t[1], Math.round(groundAt(t[0], t[1]) * 10) / 10, 1]);
  }

  // Scatter: walk a ~11 m grid over each green polygon, keep a jittered,
  // hashed subset. Wood/large polygons get sparser coverage than lawns.
  const DEG = 0.0001; // ~10.4 m east-west here
  let scattered = 0;
  const CAP = 2300;
  for (const ring of rings) {
    if (out.length >= CAP + mapped.length) break;
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const cells = ((maxLon - minLon) / DEG) * ((maxLat - minLat) / DEG);
    const keep = cells > 4000 ? 0.10 : 0.30; // big woods sparser than lawns
    for (let lat = minLat; lat <= maxLat; lat += DEG) {
      for (let lon = minLon; lon <= maxLon; lon += DEG) {
        const r = hash2(lon * 9631.7, lat * 8117.3);
        if (r > keep) continue;
        const jl = lon + (hash2(lon * 51.3, lat * 77.9) - 0.5) * DEG;
        const jt = lat + (hash2(lon * 33.1, lat * 91.7) - 0.5) * DEG;
        if (!pipRing(jl, jt, ring)) continue;
        out.push([
          Math.round(jl * 1e6) / 1e6,
          Math.round(jt * 1e6) / 1e6,
          Math.round(groundAt(jl, jt) * 10) / 10,
          0,
        ]);
        scattered++;
        if (out.length >= CAP + mapped.length) break;
      }
      if (out.length >= CAP + mapped.length) break;
    }
  }
  data.trees = out;
  delete data.green; // rings served their purpose; keep the file lean
  console.log(`trees: mapped=${mapped.length} scattered=${scattered}`);
}

data.buildings = buildings;
data.appearance = {
  roofColours: "measured from Lands Department orthophoto (data/imagery)",
  facadeColours: "OSM/Overture where mapped, otherwise derived from measured roof colour",
  heights: "OSM mapped height/levels, else Overture Maps, else estimated",
};
data.generatedAppearance = new Date().toISOString();
writeFileSync(BUILDINGS, JSON.stringify(data));

const byHeight = {};
for (const b of buildings) byHeight[b.hs] = (byHeight[b.hs] || 0) + 1;
console.log(
  `buildings=${buildings.length} roofColourMeasured=${measured} ` +
    `taggedColour=${taggedColours} noPixels=${noPixels} ` +
    `overtureHeights=${heightsFromOverture} onTerrain=${onTerrain} ` +
    `heightSources=${JSON.stringify(byHeight)}`
);
if (measured + taggedColours < buildings.length * 0.5) {
  console.error("Fewer than half the buildings got a real colour — check imagery.");
  process.exit(1);
}
