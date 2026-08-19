/* Downloads real aerial photography of the Cyberport area from the HK
   Government's open, keyless Imagery Map API (geodata.gov.hk) and stores a
   small web-mercator tile pyramid in data/imagery/ for the viewer's keyless
   "Open 3D" source. PNG tiles are recompressed to JPEG to keep the repo lean.
   Run by .github/workflows/fetch-osm-data.yml — not needed at runtime. */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BBOX = { west: 114.115, south: 22.248, east: 114.145, north: 22.274 };
const MIN_Z = 12;
const MAX_Z = 17;
const CANDIDATE_TEMPLATES = [
  "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/imagery/wgs84/{z}/{x}/{y}.png",
  "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/imagery/WGS84/{z}/{x}/{y}.png",
];
const ATTRIBUTION =
  "Aerial imagery © The Government of the HKSAR (Lands Department, geodata.gov.hk)";

const rad = (d) => (d * Math.PI) / 180;
function tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function tileY(lat, z) {
  return Math.floor(
    ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * 2 ** z
  );
}
function urlFor(template, z, x, y) {
  return template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

async function fetchTile(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (resp.ok) {
        const type = resp.headers.get("content-type") || "";
        if (type.startsWith("image/")) return Buffer.from(await resp.arrayBuffer());
      }
      if (resp.status === 404) return null; // outside service coverage
    } catch (_) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  return null;
}

// Pick the first candidate template that serves a real tile at Cyberport.
let template = null;
const probeZ = 16;
const probe = [tileX(114.13, probeZ), tileY(22.261, probeZ)];
for (const candidate of CANDIDATE_TEMPLATES) {
  const buf = await fetchTile(urlFor(candidate, probeZ, probe[0], probe[1]));
  if (buf && buf.length > 500) {
    template = candidate;
    console.log(`Using ${candidate} (probe tile ${buf.length} bytes)`);
    break;
  }
}
if (!template) {
  console.error("No imagery endpoint responded — skipping aerial imagery.");
  process.exit(1);
}

let fetched = 0;
let missing = 0;
let bytes = 0;
const jobs = [];
for (let z = MIN_Z; z <= MAX_Z; z++) {
  const x0 = tileX(BBOX.west, z);
  const x1 = tileX(BBOX.east, z);
  const y0 = tileY(BBOX.north, z); // y grows southward
  const y1 = tileY(BBOX.south, z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([z, x, y]);
}
console.log(`Fetching ${jobs.length} tiles (z${MIN_Z}-${MAX_Z})…`);
if (jobs.length > 1200) {
  console.error("Tile count unexpectedly large — refusing.");
  process.exit(1);
}

const CONCURRENCY = 6;
let index = 0;
async function worker() {
  while (index < jobs.length) {
    const [z, x, y] = jobs[index++];
    const buf = await fetchTile(urlFor(template, z, x, y));
    if (!buf) {
      missing++;
      continue;
    }
    const dir = `data/imagery/${z}/${x}`;
    mkdirSync(dir, { recursive: true });
    const pngPath = `${dir}/${y}.tmp.png`;
    const jpgPath = `${dir}/${y}.jpg`;
    writeFileSync(pngPath, buf);
    execFileSync("convert", [pngPath, "-quality", "82", jpgPath]);
    execFileSync("rm", [pngPath]);
    bytes += statSync(jpgPath).size;
    fetched++;
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(
  `fetched=${fetched} missing=${missing} totalMB=${(bytes / 1048576).toFixed(1)}`
);
if (fetched < 50) {
  console.error("Too few tiles — refusing to publish a broken pyramid.");
  process.exit(1);
}

writeFileSync(
  "data/imagery/manifest.json",
  JSON.stringify({
    attribution: ATTRIBUTION,
    template: "data/imagery/{z}/{x}/{y}.jpg",
    west: BBOX.west,
    south: BBOX.south,
    east: BBOX.east,
    north: BBOX.north,
    minZoom: MIN_Z,
    maxZoom: MAX_Z,
    generated: new Date().toISOString(),
  })
);
console.log("manifest written");
