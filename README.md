# Cyberport 3D

A photorealistic 3D map viewer of **Cyberport, Pok Fu Lam, Hong Kong** — like Google
Earth, focused on one place. Every building and road is real captured geometry
streamed as 3D Tiles, rendered with [CesiumJS](https://cesium.com/platform/cesiumjs/)
(pinned to 1.144, loaded from the official Cesium CDN).

Static site: `index.html` + `app.js` + `style.css`. No build step, no backend —
open it from any static server or host it on GitHub Pages as-is.

The viewer opens with a cinematic fly-in from ~20 km altitude down to Cyberport,
then lets you orbit, free-fly, and jump between curated viewpoints, switching
between three data sources: two photorealistic ones that need a (free) key, and
a key-free **Open 3D** mode built from real OpenStreetMap building geometry.

## Paste your two keys

Open `app.js` — the config block is at the very top:

```js
const CESIUM_ION_TOKEN = "PASTE_HERE"; // https://ion.cesium.com/tokens
const GOOGLE_MAPS_KEY = "PASTE_HERE";  // optional: Google Maps Platform key (Map Tiles API)
const HK_LANDSD_KEY = "PASTE_HERE";    // CSDI 3D Map API key — https://portal.csdi.gov.hk
```

- **`CESIUM_ION_TOKEN`** — a [Cesium ion](https://ion.cesium.com/tokens) access
  token. This drives the **Google** source (Google Photorealistic 3D Tiles,
  streamed through ion) and the aerial base imagery. If your ion account doesn't
  have *Google Photorealistic 3D Tiles* yet, add it to your assets from the ion
  **Asset Depot** first.
- **`GOOGLE_MAPS_KEY`** *(optional)* — a
  [Google Maps Platform](https://developers.google.com/maps/documentation/tile/get-api-key)
  API key with the **Map Tiles API** enabled. If no ion token is set, the
  Google source streams directly from Google using this key instead.
- **`HK_LANDSD_KEY`** — an API key for the Hong Kong
  [CSDI](https://portal.csdi.gov.hk/) **3D Map API** (Lands Department
  *3D Visualisation Map*, served from `data.map.gov.hk`). Apply for a key on the
  CSDI portal.

Either key alone is enough to run: if one is missing or its tileset fails to
load, that source's toggle is disabled with a short status note and the app
carries on with the working source. Without an ion token, the base imagery under
the HK data falls back from ion world imagery to OpenStreetMap.

**No keys at all?** The app still shows 3D buildings: it falls back to the
key-free **Open 3D** source described below. Note there is no key that makes an
LLM provider (e.g. an Anthropic API key) work here — 3D map tiles only stream
from map providers.

## The key-free "Open 3D" source

`data/cyberport-buildings.json` is a compact extract of **real OpenStreetMap
building footprints and heights** around Cyberport (heights come from OSM
`height`/`building:levels` tags where mapped, conservative defaults otherwise).
The viewer extrudes them client-side — real building massing, in the spirit of
Google Earth's classic gray-buildings view, though not the photorealistic
textured mesh of the two keyed sources.

To refresh the extract, run the **Fetch OSM building data** workflow from the
repository's Actions tab — it queries the Overpass API and commits the updated
file. The data is © OpenStreetMap contributors ([ODbL](https://www.openstreetmap.org/copyright));
the attribution rendered in the credit area must be kept.

## Run locally

Any static file server works (opening `index.html` via `file://` is not
supported by browsers for this kind of app):

```sh
# pick one
python3 -m http.server 8000
npx serve .
```

Then visit <http://localhost:8000>.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Repository **Settings → Pages → Build and deployment**: choose
   **Deploy from a branch**, select your branch and the **/ (root)** folder.
3. Wait for the Pages build, then open `https://<user>.github.io/<repo>/`.

No build step — the files are served exactly as committed. (Remember the keys
you paste into `app.js` become public on a public Pages site; use keys with
appropriate restrictions/quotas.)

## Controls

| Input | Action |
| --- | --- |
| Mouse / touch | Standard Cesium orbit, pan, zoom |
| `W A S D` + `Q E` | Free-fly (forward/left/back/right, down/up), smooth and damped |
| `Shift` | Fly faster |
| `B` | Copy the current camera as a bookmark line (see below) |
| `O` | Slow cinematic auto-orbit around the point at screen center — any camera input stops it |
| `F` | Toggle the FPS counter |
| **Street level** button | Opens Google Street View at the point you're looking at |
| Quality **Ultra / High / Fast** | Sets `maximumScreenSpaceError` to 8 / 16 / 32, live |

The camera never goes under the mesh: tileset collision is enabled and a soft
floor keeps the camera at least `MIN_CAM_HEIGHT` (20 m) above it.

## Authoring bookmarks with `B`

The bookmark bar is seeded with five placeholder viewpoints ("Hero",
"Waterfront", "Rooftops", "Harbour approach", "Overview"). To tune them:

1. Fly to a view you like (mouse or WASD).
2. Press **`B`** — the current camera is copied to your clipboard as a single
   line, formatted exactly like the entries in the `BOOKMARKS` array (it is
   also logged to the browser console):

   ```js
   { "name": "New viewpoint", "lon": 114.130042, "lat": 22.255873, "height": 612.4, "heading": 359.2, "pitch": -44.8 },
   ```

3. Paste the line into the `BOOKMARKS` array near the top of `app.js`, rename
   it, and reload. Replace the placeholders or add as many as you like.

## Attribution — required, do not remove

- Cesium's credit container (bottom-left) must stay fully visible. **Google's
  attribution renders there while Google tiles are on screen and must never be
  hidden or covered** — this is a condition of using Google Photorealistic 3D
  Tiles.
- The fixed credit line in the UI — *"3D data: Google / Lands Department,
  HKSAR Govt (CSDI) / © OpenStreetMap contributors"* — must also remain.

Data sources:

- **Google Photorealistic 3D Tiles**, streamed via
  [Cesium ion](https://cesium.com/platform/cesium-ion/content/) —
  [Google Maps Platform terms](https://developers.google.com/maps/terms), which
  require visible Google attribution.
- **3D Visualisation Map** (photorealistic 3D model of Hong Kong), Lands
  Department, HKSAR Government, via the
  [CSDI portal](https://portal.csdi.gov.hk/) 3D Map API
  (`data.map.gov.hk`) — follow the CSDI/LandsD terms of use, including
  acknowledging the Lands Department as the data source.
- **Building data © OpenStreetMap contributors**, licensed
  [ODbL](https://www.openstreetmap.org/copyright) — used by the Open 3D source
  (and the OSM raster imagery fallback).

## Performance notes

- Quality selector maps to `maximumScreenSpaceError` 8 (Ultra) / 16 (High) /
  32 (Fast); `dynamicScreenSpaceError` is on, post-processing is off. Default
  is High (16) — targets 30–60 fps on a mid-range laptop.
- A subtle spinner (top-right) shows while tiles stream after big jumps.
- Only one source is active at a time; the inactive tileset is hidden.
