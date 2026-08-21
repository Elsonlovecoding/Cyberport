/* Cyberport 3D — photorealistic 3D map viewer of Cyberport, Hong Kong.
   Static site, no build step. CesiumJS is loaded from the official CDN
   by index.html (pinned to 1.144). See README.md. */

/* ============================================================
   CONFIG — paste your keys between the quotes, nothing else.
   ============================================================ */
const CESIUM_ION_TOKEN = "PASTE_HERE"; // https://ion.cesium.com/tokens
const GOOGLE_MAPS_KEY = "PASTE_HERE";  // optional: Google Maps Platform key (Map Tiles API) —
                                       // ion-free alternative for the Google source
const HK_LANDSD_KEY = "PASTE_HERE";    // CSDI 3D Map API key — https://portal.csdi.gov.hk

const START = { lat: 22.2610, lon: 114.1300 }; // Cyberport, Pok Fu Lam (approximate)
const QUALITY_SSE = 16;    // maximumScreenSpaceError; quality buttons apply 8/16/32
const MIN_CAM_HEIGHT = 20; // soft floor, meters above the mesh
/* ============================================================ */

/* Bookmarks. Placeholder framing — fly somewhere nice, press B, and paste the
   copied line into this array (each entry is one line, trailing comma and all). */
const BOOKMARKS = [
  { "name": "Hero", "lon": 114.1300, "lat": 22.2556, "height": 600, "heading": 0, "pitch": -45 },
  { "name": "Waterfront", "lon": 114.1345, "lat": 22.2620, "height": 120, "heading": 285, "pitch": -12 },
  { "name": "Rooftops", "lon": 114.1288, "lat": 22.2596, "height": 220, "heading": 45, "pitch": -35 },
  { "name": "Harbour approach", "lon": 114.1120, "lat": 22.2635, "height": 350, "heading": 100, "pitch": -10 },
  { "name": "Overview", "lon": 114.1300, "lat": 22.2440, "height": 2600, "heading": 0, "pitch": -50 },
];

(function main() {
  "use strict";

  const HK_TILESET_URL =
    "https://data.map.gov.hk/api/3d-data/3dtiles/f2/tileset.json?key=" + HK_LANDSD_KEY;
  const FLY_IN_SECONDS = 7;
  const BOOKMARK_FLY_SECONDS = 3;
  const ORBIT_RATE = 0.06; // rad/s — slow, for screen recording

  const $ = (id) => document.getElementById(id);
  const els = {
    panel: $("panel"),
    menuToggle: $("menuToggle"),
    srcGoogle: $("srcGoogle"),
    srcHk: $("srcHk"),
    srcOsm: $("srcOsm"),
    qualitySeg: $("qualitySeg"),
    streetBtn: $("streetBtn"),
    status: $("status"),
    hint: $("hint"),
    fps: $("fps"),
    spinner: $("spinner"),
    toast: $("toast"),
    bookmarkBar: $("bookmarkBar"),
    fatal: $("fatal"),
  };

  function showFatal(message) {
    els.fatal.textContent = message;
    els.fatal.hidden = false;
  }

  if (typeof Cesium === "undefined") {
    showFatal(
      "CesiumJS failed to load from cesium.com. " +
        "Check your network connection (or content blocker) and reload."
    );
    return;
  }

  /* ---------- status line + toast ---------- */

  const notes = new Map();
  function setNote(key, message) {
    if (message == null) notes.delete(key);
    else notes.set(key, message);
    els.status.textContent = Array.from(notes.values()).join("  ·  ");
    els.status.hidden = notes.size === 0;
  }

  let toastTimer = null;
  function toast(message, ms) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, ms || 2400);
  }

  // Safety net: never let a stray exception leave the page looking broken
  // with no explanation. (Nominal flows are all caught individually.)
  window.addEventListener("error", (e) => {
    if (e.message) setNote("app", "Unexpected error — details in the console");
  });
  window.addEventListener("unhandledrejection", () => {
    setNote("app", "Unexpected error — details in the console");
  });

  /* ---------- tokens ---------- */

  const isPlaceholder = (v) =>
    typeof v !== "string" || v.trim() === "" || v.includes("PASTE_HERE");
  const hasIonToken = !isPlaceholder(CESIUM_ION_TOKEN);
  const hasGoogleKey = !isPlaceholder(GOOGLE_MAPS_KEY);
  const hasHkKey = !isPlaceholder(HK_LANDSD_KEY);
  if (hasIonToken) Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

  /* ---------- viewer ---------- */

  let viewer;
  try {
    viewer = new Cesium.Viewer("cesiumContainer", {
      // The tilesets are the terrain; widgets stay off. Imagery is added below
      // (only fetched while the globe is visible, i.e. in HK Gov mode).
      baseLayer: false,
      baseLayerPicker: false,
      timeline: false,
      animation: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      scene3DOnly: true,
    });
  } catch (err) {
    showFatal(
      "Could not start the 3D viewer — WebGL seems to be unavailable in this browser. " +
        (err && err.message ? err.message : "")
    );
    return;
  }

  const scene = viewer.scene;
  const camera = viewer.camera;
  const controller = scene.screenSpaceCameraController;

  scene.postProcessStages.fxaa.enabled = false; // no post-processing
  controller.enableCollisionDetection = true;
  controller.minimumZoomDistance = MIN_CAM_HEIGHT;

  // Friendlier mouse mapping (Google Earth-like): left-drag pans, wheel
  // zooms, RIGHT-drag rotates/tilts around what you grabbed (Cesium's
  // default right-drag-to-zoom surprises everyone). Ctrl+left-drag too.
  controller.tiltEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.MIDDLE_DRAG,
    Cesium.CameraEventType.PINCH,
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL },
  ];
  controller.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
  // Deep-sea slate wherever no imagery has loaded (keyless/offline ground).
  scene.globe.baseColor = Cesium.Color.fromCssColorString("#16222e");
  // Fixed mid-afternoon Hong Kong sun (14:30 HKT) for warm, consistent
  // lighting and readable shadows — the clock never animates in this app.
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601("2026-08-19T06:30:00Z");
  viewer.shadowMap.size = 2048;
  viewer.shadowMap.softShadows = true;
  // Aerial photos already contain baked-in shade; a fully dark shadow on top
  // of that reads as black holes, so keep shadows soft and translucent.
  viewer.shadowMap.darkness = 0.55;
  viewer.shadowMap.maximumDistance = 8000;
  scene.globe.shadows = Cesium.ShadowMode.RECEIVE_ONLY;
  // Aerial haze over distance, as in real photos of the harbour.
  scene.fog.enabled = true;
  scene.fog.density = 0.00012;

  // Keep the expanded "Data attribution" lightbox unobstructed: #ui (z-index 5)
  // would otherwise paint above the overlay, which is trapped at z-index 1
  // inside #cesiumContainer's stacking context. CreditDisplay toggles the
  // overlay's inline style.display between "block"/"none", so observe that.
  const lightboxOverlay = viewer.container.querySelector(".cesium-credit-lightbox-overlay");
  if (lightboxOverlay) {
    new MutationObserver(function () {
      document.body.classList.toggle(
        "attribution-open",
        lightboxOverlay.style.display === "block"
      );
    }).observe(lightboxOverlay, { attributes: true, attributeFilter: ["style"] });
  }

  /* ---------- base imagery (visible in HK Gov mode / when no source loads) ---------- */

  async function initImagery() {
    if (hasIonToken) {
      try {
        const provider = await Cesium.createWorldImageryAsync();
        viewer.imageryLayers.addImageryProvider(provider);
        return;
      } catch (err) {
        setNote("imagery", "ion imagery failed — falling back to OpenStreetMap");
      }
    }
    viewer.imageryLayers.addImageryProvider(
      new Cesium.OpenStreetMapImageryProvider({
        url: "https://tile.openstreetmap.org/",
      })
    );
  }

  // Real topography for the Cyberport area, baked from AWS Terrain Tiles into
  // data/terrain.json (see scripts/fetch-terrain.mjs). Without this the whole
  // district renders as a flat plane with the hillside merely painted on.
  async function initTerrain() {
    let t;
    try {
      const resp = await fetch("data/terrain.json");
      if (!resp.ok) return;
      t = await resp.json();
    } catch (_) {
      return; // no bundled terrain — the ellipsoid surface still works
    }
    let grid;
    try {
      const bin = atob(t.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      grid = new Int16Array(bytes.buffer);
    } catch (_) {
      return;
    }
    const n = t.size;
    if (!n || grid.length < n * n) return;

    // Bilinear sample of the baked grid; 0 (sea level) outside its footprint.
    const sample = function (lon, lat) {
      if (lon < t.west || lon > t.east || lat < t.south || lat > t.north) return 0;
      const fx = ((lon - t.west) / (t.east - t.west)) * (n - 1);
      const fy = ((t.north - lat) / (t.north - t.south)) * (n - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(n - 1, x0 + 1);
      const y1 = Math.min(n - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const top = grid[y0 * n + x0] * (1 - tx) + grid[y0 * n + x1] * tx;
      const bot = grid[y1 * n + x0] * (1 - tx) + grid[y1 * n + x1] * tx;
      return top * (1 - ty) + bot * ty;
    };

    const SIZE = 64; // heightmap samples per tile edge
    const tilingScheme = new Cesium.GeographicTilingScheme();
    const rectScratch = new Cesium.Rectangle();
    scene.terrainProvider = new Cesium.CustomHeightmapTerrainProvider({
      width: SIZE,
      height: SIZE,
      tilingScheme: tilingScheme,
      credit: new Cesium.Credit(t.attribution || "Elevation: AWS Terrain Tiles", false),
      callback: function (x, y, level) {
        const r = tilingScheme.tileXYToRectangle(x, y, level, rectScratch);
        const west = Cesium.Math.toDegrees(r.west);
        const east = Cesium.Math.toDegrees(r.east);
        const north = Cesium.Math.toDegrees(r.north);
        const south = Cesium.Math.toDegrees(r.south);
        const out = new Float32Array(SIZE * SIZE);
        // Heightmap order: west to east, north to south.
        for (let j = 0; j < SIZE; j++) {
          const lat = north - ((north - south) * j) / (SIZE - 1);
          for (let i = 0; i < SIZE; i++) {
            const lon = west + ((east - west) * i) / (SIZE - 1);
            out[j * SIZE + i] = sample(lon, lat);
          }
        }
        return out;
      },
    });
  }

  // Real aerial photography of the Cyberport area, bundled in the repo from
  // the HK Government's open Imagery Map API (see scripts/fetch-imagery.mjs).
  // Draped on top of the world base imagery; skipped silently if absent.
  async function initLocalAerial() {
    try {
      const resp = await fetch("data/imagery/manifest.json");
      if (!resp.ok) return;
      const m = await resp.json();
      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: m.template,
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          rectangle: Cesium.Rectangle.fromDegrees(m.west, m.south, m.east, m.north),
          minimumLevel: m.minZoom,
          maximumLevel: m.maxZoom,
          credit: new Cesium.Credit(m.attribution, true),
        })
      );
    } catch (_) {
      /* no bundled imagery — the base layer still shows */
    }
  }

  /* ---------- loading spinner ---------- */

  let busyCount = 0;
  let spinnerTimer = null;
  function refreshSpinner() {
    const streaming = activeKey ? sources[activeKey].streaming : 0;
    if (busyCount > 0 || streaming > 0) {
      clearTimeout(spinnerTimer);
      spinnerTimer = null;
      els.spinner.hidden = false;
    } else if (!spinnerTimer) {
      spinnerTimer = setTimeout(() => {
        spinnerTimer = null;
        els.spinner.hidden = true;
      }, 400);
    }
  }
  function beginBusy() {
    busyCount += 1;
    refreshSpinner();
  }
  function endBusy() {
    busyCount = Math.max(0, busyCount - 1);
    refreshSpinner();
  }

  /* ---------- data sources ---------- */

  let currentSSE = QUALITY_SSE;

  const sources = {
    google: {
      label: "Google",
      btn: els.srcGoogle,
      tileset: null,
      state: "idle", // idle | loading | ready | unavailable
      streaming: 0,
    },
    hk: {
      label: "HK",
      btn: els.srcHk,
      tileset: null,
      state: "idle",
      streaming: 0,
    },
    // Keyless source: real OpenStreetMap building geometry bundled in the
    // repo (data/cyberport-buildings.json), extruded client-side.
    osm: {
      label: "Open 3D",
      btn: els.srcOsm,
      primitive: null,
      state: "idle",
      streaming: 0,
    },
  };
  const FALLBACK_ORDER = ["google", "hk", "osm"];
  let activeKey = null;
  let activationSeq = 0;

  function tilesetOptions() {
    return {
      maximumScreenSpaceError: currentSSE,
      dynamicScreenSpaceError: true,
      // Native camera-vs-mesh collision (works with enableCollisionDetection).
      enableCollision: true,
    };
  }

  // Fallback only — used if the data predates the colour-measurement pass.
  function fallbackColor(b, roof) {
    const jitter = (Math.abs(Math.sin(b.p[0][0] * 4321.7 + b.p[0][1] * 1234.3)) - 0.5) * 0.09;
    if (b.h > 90) {
      const base = (roof ? 0.5 : 0.6) + jitter;
      return new Cesium.Color(base, base + 0.05, base + 0.11, 1);
    }
    const t = Math.min(b.h / 90, 1);
    const base = (roof ? 0.68 : 0.82) - t * 0.16 + jitter;
    return new Cesium.Color(base, base - 0.012, base - 0.035, 1);
  }

  const colorFrom = (hex, b, roof) =>
    hex ? Cesium.Color.fromCssColorString(hex) : fallbackColor(b, roof);

  async function createOsmBuildings() {
    const resp = await fetch("data/cyberport-buildings.json");
    if (!resp.ok) {
      throw new Error("building data missing (HTTP " + resp.status + ")");
    }
    const data = await resp.json();
    const instances = [];
    for (const b of data.buildings || []) {
      if (!Array.isArray(b.p) || b.p.length < 3) continue;
      const flat = [];
      for (const pt of b.p) flat.push(pt[0], pt[1]);
      // Ground level under the building (baked from the terrain grid), so a
      // building on the hillside starts at the hillside, not at sea level.
      const base = Number.isFinite(b.g) ? b.g : 0;
      // Sink the base slightly so walls meet the terrain mesh with no gap
      // where the baked grid and the rendered surface disagree.
      const bottom = base - 3;
      const top = base + b.h;
      try {
        // Roof: its real colour, measured from the aerial orthophoto.
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(flat)
              ),
              height: top,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorFrom(b.rc, b, true)),
            },
          })
        );
        // Walls: closed ring from ground to roof height.
        const wallFlat = flat.concat([b.p[0][0], b.p[0][1]]);
        const wallPositions = Cesium.Cartesian3.fromDegreesArray(wallFlat);
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.WallGeometry({
              positions: wallPositions,
              minimumHeights: wallPositions.map(() => bottom),
              maximumHeights: wallPositions.map(() => top),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorFrom(b.fc, b, false)),
            },
          })
        );
      } catch (_) {
        /* skip a degenerate footprint */
      }
    }
    if (instances.length === 0) throw new Error("building data empty");
    viewer.creditDisplay.addStaticCredit(
      // showOnScreen: ODbL attribution must be visible, not just in the lightbox
      new Cesium.Credit("© OpenStreetMap contributors", true)
    );
    return new Cesium.Primitive({
      geometryInstances: instances,
      // Lit (not flat) so walls catch the sun and roofs read as surfaces;
      // faceForward keeps wall normals toward the viewer.
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: false,
        faceForward: true,
        closed: false,
        translucent: false,
      }),
      shadows: Cesium.ShadowMode.ENABLED,
      asynchronous: true,
      allowPicking: false,
    });
  }

  function createTileset(key) {
    if (key === "google") {
      // We ship no geocoder at all, so the Google-geocoder pairing warning
      // does not apply; the flag just keeps the console clean.
      const apiOptions = { onlyUsingWithGoogleGeocoder: true };
      // With an ion token the tiles stream via Cesium ion; otherwise fall
      // back to streaming straight from Google's Map Tiles API.
      if (!hasIonToken && hasGoogleKey) apiOptions.key = GOOGLE_MAPS_KEY;
      return Cesium.createGooglePhotorealistic3DTileset(apiOptions, tilesetOptions());
    }
    return Cesium.Cesium3DTileset.fromUrl(HK_TILESET_URL, tilesetOptions());
  }

  function markUnavailable(key, reason) {
    const src = sources[key];
    src.state = "unavailable";
    src.btn.disabled = true;
    src.btn.classList.add("unavailable");
    src.btn.classList.remove("active");
    src.btn.title = src.label + " source unavailable: " + reason;
    setNote(key, src.label + " source: " + reason);
  }

  function describeLoadError(err) {
    if (err && typeof err.statusCode !== "undefined" && err.statusCode !== null) {
      if (err.statusCode === 401 || err.statusCode === 403) {
        return "load failed — HTTP " + err.statusCode + " (check the key)";
      }
      return "load failed — HTTP " + err.statusCode;
    }
    const msg = err && err.message ? String(err.message) : String(err || "");
    if (!msg || /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return "load failed — network error (possibly CORS)";
    }
    return "load failed — " + (msg.length > 90 ? msg.slice(0, 90) + "…" : msg);
  }

  function applyMode(key) {
    // Google's tileset includes its own terrain, so the globe is hidden there;
    // the HK and Open 3D data cover Hong Kong only, so the globe stays visible.
    const googleMode = key === "google";
    scene.globe.show = !googleMode;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = !googleMode;
    // Sun shadows only for the extruded Open 3D buildings — the photoreal
    // tilesets have real lighting baked into their textures.
    viewer.shadows = key === "osm";
  }

  function nextFallback(afterKey) {
    for (const k of FALLBACK_ORDER) {
      if (k !== afterKey && sources[k].state !== "unavailable") return k;
    }
    return null;
  }

  function updateSourceButtons() {
    for (const [key, src] of Object.entries(sources)) {
      if (src.state === "unavailable") continue;
      src.btn.classList.toggle("active", key === activeKey);
    }
  }

  async function activateSource(key, allowFallback) {
    const src = sources[key];
    if (!src || src.state === "unavailable") return false;
    // Every request (including re-clicks while another source is still
    // loading) bumps the sequence, so the user's LAST choice always wins.
    const seq = ++activationSeq;

    if (src.state === "idle") {
      src.state = "loading";
      beginBusy();
      src.loadPromise = (key === "osm" ? createOsmBuildings() : createTileset(key)).finally(
        endBusy
      );
    }
    if (src.state === "loading") {
      let content;
      try {
        content = await src.loadPromise;
      } catch (err) {
        if (src.state === "loading") markUnavailable(key, describeLoadError(err));
        if (allowFallback) {
          const nk = nextFallback(key);
          if (nk) return activateSource(nk, true); // each failure marks
          // its source unavailable, so the chain always terminates
        }
        return false;
      }
      if (src.state === "loading") {
        // First awaiter to resume wires the content up; concurrent awaiters
        // see state "ready" and skip this block.
        content.show = false;
        scene.primitives.add(content);
        if (key === "osm") {
          src.primitive = content;
        } else {
          const tileset = content;
          tileset.loadProgress.addEventListener(function (pending, processing) {
            src.streaming = pending + processing;
            refreshSpinner();
          });
          // Surface mid-stream failures (expired key, quota, per-tile 403s)
          // that happen after the root tileset.json loaded fine.
          tileset.tileFailed.addEventListener(function (err) {
            src.tileFailures = (src.tileFailures || 0) + 1;
            const msg = err && err.message ? String(err.message) : "tile request failed";
            setNote(
              key + "-tiles",
              src.label + " tiles failing (" + src.tileFailures + ") — " +
                (msg.length > 70 ? msg.slice(0, 70) + "…" : msg)
            );
          });
          tileset.tileLoad.addEventListener(function () {
            src.tileFailures = 0;
            setNote(key + "-tiles", null); // transient blip — clear on recovery
          });
          src.tileset = tileset;
        }
        src.state = "ready";
      }
    }

    // Superseded only if a newer activation actually took the scene; when
    // nothing is active, claim the slot so a successfully loaded source is
    // never left invisibly hidden.
    if (seq !== activationSeq && activeKey !== null) return false;

    activeKey = key;
    for (const [k, s] of Object.entries(sources)) {
      const display = s.tileset || s.primitive;
      if (display) display.show = k === key;
    }
    applyMode(key);
    updateSourceButtons();
    refreshSpinner();
    return true;
  }

  els.srcGoogle.addEventListener("click", function () {
    els.srcGoogle.blur();
    activateSource("google", false);
  });
  els.srcHk.addEventListener("click", function () {
    els.srcHk.blur();
    activateSource("hk", false);
  });
  els.srcOsm.addEventListener("click", function () {
    els.srcOsm.blur();
    activateSource("osm", false);
  });

  /* ---------- quality selector (live) ---------- */

  const qualityButtons = Array.from(els.qualitySeg.querySelectorAll("button"));
  function applyQuality(sse) {
    currentSSE = sse;
    for (const src of Object.values(sources)) {
      if (src.tileset) src.tileset.maximumScreenSpaceError = sse;
    }
    for (const b of qualityButtons) {
      b.classList.toggle("active", Number(b.dataset.sse) === sse);
    }
  }
  for (const b of qualityButtons) {
    b.addEventListener("click", function () {
      b.blur();
      applyQuality(Number(b.dataset.sse));
      toast("Quality: " + b.textContent + " (SSE " + b.dataset.sse + ")");
    });
  }
  applyQuality(QUALITY_SSE);

  /* ---------- camera helpers ---------- */

  const flightState = { flying: false };

  function flyTo(lon, lat, height, headingDeg, pitchDeg, seconds) {
    cancelOrbit(true);
    camera.cancelFlight();
    flightState.flying = true;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(headingDeg),
        pitch: Cesium.Math.toRadians(pitchDeg),
        roll: 0,
      },
      duration: seconds,
      complete: function () {
        flightState.flying = false;
      },
      cancel: function () {
        flightState.flying = false;
      },
    });
  }

  function pickCenter() {
    const c = new Cesium.Cartesian2(
      Math.round(viewer.canvas.clientWidth / 2),
      Math.round(viewer.canvas.clientHeight / 2)
    );
    try {
      if (scene.pickPositionSupported) {
        const p = scene.pickPosition(c);
        if (Cesium.defined(p)) return p;
      }
    } catch (_) {
      /* nothing pickable at center */
    }
    try {
      if (scene.globe.show) {
        const p = scene.globe.pick(camera.getPickRay(c), scene);
        if (Cesium.defined(p)) return p;
      }
    } catch (_) {}
    const p = camera.pickEllipsoid(c, Cesium.Ellipsoid.WGS84);
    if (Cesium.defined(p) && !scene.globe.show) {
      // Globe hidden (Google mode): the bare-WGS84 intersection can be
      // kilometers away and below the mesh — only trust it at short range,
      // otherwise auto-orbit would whip around a distant subterranean point.
      const agl = Math.abs(camera.positionCartographic.height - (groundHeight ?? 0));
      if (Cesium.Cartesian3.distance(camera.positionWC, p) > Math.max(300, agl * 5)) {
        return undefined;
      }
    }
    return p;
  }

  /* ---------- bookmarks ---------- */

  for (const b of BOOKMARKS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.name;
    btn.title = "Fly to " + b.name;
    btn.addEventListener("click", function () {
      btn.blur();
      flyTo(b.lon, b.lat, b.height, b.heading, b.pitch, BOOKMARK_FLY_SECONDS);
    });
    els.bookmarkBar.appendChild(btn);
  }

  /* B — copy the current camera as a bookmark line (authoring helper) */
  function copyBookmark() {
    const carto = camera.positionCartographic;
    const line =
      '  { "name": "New viewpoint"' +
      ', "lon": ' + Cesium.Math.toDegrees(carto.longitude).toFixed(6) +
      ', "lat": ' + Cesium.Math.toDegrees(carto.latitude).toFixed(6) +
      ', "height": ' + carto.height.toFixed(1) +
      ', "heading": ' + Cesium.Math.toDegrees(camera.heading).toFixed(1) +
      ', "pitch": ' + Cesium.Math.toDegrees(camera.pitch).toFixed(1) +
      " },";
    console.log("[bookmark] paste this line into BOOKMARKS in app.js:\n" + line);
    const done = () => toast("Bookmark copied — paste into BOOKMARKS in app.js");
    const fail = () => toast("Clipboard blocked — bookmark line is in the console");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(line).then(done, function () {
        legacyCopy(line) ? done() : fail();
      });
    } else {
      legacyCopy(line) ? done() : fail();
    }
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  /* ---------- street level ---------- */

  els.streetBtn.addEventListener("click", function () {
    els.streetBtn.blur();
    const target = pickCenter();
    const carto = Cesium.defined(target)
      ? Cesium.Cartographic.fromCartesian(target)
      : Cesium.Cartographic.fromDegrees(START.lon, START.lat);
    const lat = Cesium.Math.toDegrees(carto.latitude).toFixed(6);
    const lon = Cesium.Math.toDegrees(carto.longitude).toFixed(6);
    window.open(
      "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + lat + "," + lon,
      "_blank",
      "noopener"
    );
  });

  /* ---------- auto-orbit (O) ---------- */

  let orbitActive = false;

  function startOrbit() {
    const center = pickCenter();
    if (!Cesium.defined(center)) {
      toast("Nothing to orbit — aim the view at the scenery first");
      return;
    }
    camera.cancelFlight();
    flightState.flying = false;
    camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(center));
    orbitActive = true;
    toast("Auto-orbit on — any camera input (or O) stops it");
  }

  function cancelOrbit(silent) {
    if (!orbitActive) return;
    orbitActive = false;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (!silent) toast("Auto-orbit off");
  }

  function toggleOrbit() {
    if (orbitActive) cancelOrbit(false);
    else startOrbit();
  }

  for (const evt of ["pointerdown", "wheel", "touchstart"]) {
    viewer.canvas.addEventListener(evt, () => cancelOrbit(false), { passive: true });
  }

  /* ---------- on-screen navigation pad ---------- */

  // pan: [right, forward] (ground plane) · rot: [heading, tilt] rad/s · zoom: ± direction
  const NAV_ACTIONS = {
    fwd: { pan: [0, 1] },
    back: { pan: [0, -1] },
    left: { pan: [-1, 0] },
    right: { pan: [1, 0] },
    rotl: { rot: [-0.9, 0] },
    rotr: { rot: [0.9, 0] },
    tiltup: { rot: [0, -0.5] },   // toward the horizon
    tiltdown: { rot: [0, 0.5] },  // toward the ground
    zoomin: { zoom: 1 },
    zoomout: { zoom: -1 },
  };
  let activeNav = null;

  for (const btn of document.querySelectorAll("#navPad [data-nav]")) {
    const start = function (e) {
      e.preventDefault();
      camera.cancelFlight();
      flightState.flying = false;
      cancelOrbit(true);
      activeNav = btn.dataset.nav;
      btn.classList.add("held");
    };
    const stop = function () {
      if (activeNav === btn.dataset.nav) activeNav = null;
      btn.classList.remove("held");
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  window.addEventListener("pointerup", function () {
    activeNav = null;
    for (const b of document.querySelectorAll("#navPad .held")) b.classList.remove("held");
  });

  const navUp = new Cesium.Cartesian3();
  const navTmp = new Cesium.Cartesian3();
  const navFwd = new Cesium.Cartesian3();
  const navRight = new Cesium.Cartesian3();

  function updateNav(dt) {
    if (!activeNav) return;
    const spec = NAV_ACTIONS[activeNav];
    if (!spec) return;
    const agl = Math.max(Math.abs(camera.positionCartographic.height - (groundHeight ?? 0)), 15);

    if (spec.pan) {
      // Move parallel to the ground, in the direction the view faces,
      // at a speed that feels the same at rooftop and city scale.
      const speed = Math.min(Math.max(30, agl * 1.2), 6000);
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(camera.positionWC, navUp);
      let fwd = Cesium.Cartesian3.subtract(
        camera.direction,
        Cesium.Cartesian3.multiplyByScalar(navUp, Cesium.Cartesian3.dot(camera.direction, navUp), navTmp),
        navFwd
      );
      if (Cesium.Cartesian3.magnitudeSquared(fwd) < 1e-8) {
        // Looking straight down — use the camera's up vector instead.
        fwd = Cesium.Cartesian3.subtract(
          camera.up,
          Cesium.Cartesian3.multiplyByScalar(navUp, Cesium.Cartesian3.dot(camera.up, navUp), navTmp),
          navFwd
        );
      }
      Cesium.Cartesian3.normalize(fwd, fwd);
      const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(fwd, navUp, navRight), navRight);
      if (spec.pan[1]) camera.move(fwd, spec.pan[1] * speed * dt);
      if (spec.pan[0]) camera.move(right, spec.pan[0] * speed * dt);
    }

    if (spec.rot) {
      // Rotate/tilt around the point at screen center when there is one,
      // otherwise turn in place.
      const center = pickCenter();
      if (Cesium.defined(center)) {
        camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(center));
        if (spec.rot[0]) camera.rotateRight(spec.rot[0] * dt);
        if (spec.rot[1]) camera.rotateUp(spec.rot[1] * dt);
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      } else {
        camera.setView({
          orientation: {
            heading: camera.heading + spec.rot[0] * dt,
            pitch: Cesium.Math.clamp(camera.pitch - spec.rot[1] * dt, -1.55, 0.35),
            roll: 0,
          },
        });
      }
    }

    if (spec.zoom) {
      const amount = Math.min(Math.max(20, agl * 1.4), 8000) * dt;
      if (spec.zoom > 0) camera.zoomIn(amount);
      else camera.zoomOut(amount);
    }
  }

  /* compass: needle tracks the camera; click turns back to north */
  const compassBtn = $("compassBtn");
  const compassNeedle = $("compassNeedle");
  let lastNeedleDeg = 0;
  compassBtn.addEventListener("click", function () {
    compassBtn.blur();
    cancelOrbit(true);
    camera.cancelFlight();
    flightState.flying = true;
    camera.flyTo({
      destination: Cesium.Cartesian3.clone(camera.positionWC),
      orientation: { heading: 0, pitch: camera.pitch, roll: 0 },
      duration: 0.8,
      complete: function () {
        flightState.flying = false;
      },
      cancel: function () {
        flightState.flying = false;
      },
    });
  });

  /* double-click: dive halfway toward the point you clicked */
  viewer.screenSpaceEventHandler.setInputAction(function (movement) {
    let target;
    try {
      if (scene.pickPositionSupported) target = scene.pickPosition(movement.position);
    } catch (_) {}
    if (!Cesium.defined(target)) return;
    const dest = Cesium.Cartesian3.lerp(camera.positionWC, target, 0.5, new Cesium.Cartesian3());
    const carto = Cesium.Cartographic.fromCartesian(dest);
    const floor = (groundHeight ?? 0) + MIN_CAM_HEIGHT;
    if (carto.height < floor) carto.height = floor;
    cancelOrbit(true);
    flightState.flying = true;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
      duration: 0.7,
      complete: function () {
        flightState.flying = false;
      },
      cancel: function () {
        flightState.flying = false;
      },
    });
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  /* ---------- keyboard: WASD+QE free-fly, B/O/F ---------- */

  const MOVE_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"]);
  const pressed = new Set();
  const flightVel = { forward: 0, right: 0, up: 0 };

  window.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
      pressed.add(e.code);
      return;
    }
    if (MOVE_CODES.has(e.code)) {
      if (!pressed.has(e.code)) {
        pressed.add(e.code);
        camera.cancelFlight();
        flightState.flying = false;
        cancelOrbit(true);
      }
      return;
    }
    if (e.repeat) return;
    if (e.code === "KeyB") copyBookmark();
    else if (e.code === "KeyO") toggleOrbit();
    else if (e.code === "KeyF") els.fps.hidden = !els.fps.hidden;
  });
  window.addEventListener("keyup", (e) => pressed.delete(e.code));
  window.addEventListener("blur", function () {
    pressed.clear();
  });

  const upScratch = new Cesium.Cartesian3();
  function updateFlight(dt) {
    const tf = (pressed.has("KeyW") ? 1 : 0) - (pressed.has("KeyS") ? 1 : 0);
    const tr = (pressed.has("KeyD") ? 1 : 0) - (pressed.has("KeyA") ? 1 : 0);
    const tu = (pressed.has("KeyE") ? 1 : 0) - (pressed.has("KeyQ") ? 1 : 0);
    const idle =
      !tf && !tr && !tu &&
      Math.abs(flightVel.forward) < 0.02 &&
      Math.abs(flightVel.right) < 0.02 &&
      Math.abs(flightVel.up) < 0.02;
    if (idle) return;

    const boost = pressed.has("ShiftLeft") || pressed.has("ShiftRight") ? 4 : 1;
    // Speed scales with height above the mesh so flight feels right at
    // rooftop scale and at city scale alike.
    const agl = Math.abs(camera.positionCartographic.height - (groundHeight ?? 0));
    const speed = Math.min(Math.max(25, agl * 0.9), 4000) * boost;

    const k = 1 - Math.exp(-dt * 7); // damped approach, ~0.14 s time constant
    flightVel.forward += (tf * speed - flightVel.forward) * k;
    flightVel.right += (tr * speed - flightVel.right) * k;
    flightVel.up += (tu * speed - flightVel.up) * k;

    if (flightVel.forward) camera.moveForward(flightVel.forward * dt);
    if (flightVel.right) camera.moveRight(flightVel.right * dt);
    if (flightVel.up) {
      // Q/E move along local vertical (world up), not the tilted camera axis.
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(camera.positionWC, upScratch);
      camera.move(upScratch, flightVel.up * dt);
    }
  }

  /* ---------- soft floor: keep the camera above the mesh ---------- */

  let groundHeight; // sampled height of the mesh/terrain beneath the camera
  let groundSampleCarto = null; // where that sample was taken
  let lastSampleTime = 0;
  const sampleScratch = new Cesium.Cartographic();

  function sampleGround(now) {
    if (now - lastSampleTime < 120) return;
    lastSampleTime = now;
    const carto = Cesium.Cartographic.clone(camera.positionCartographic, sampleScratch);
    let h;
    try {
      const src = activeKey && sources[activeKey];
      if (src && src.state === "ready" && src.tileset) {
        // View-independent: samples loaded tiles even when the ground below
        // is outside the frustum (camera pitched up at the skyline).
        h = src.tileset.getHeight(carto, scene);
      }
      if (h === undefined && scene.sampleHeightSupported) {
        h = scene.sampleHeight(carto);
      }
    } catch (_) {
      /* height queries can throw before the first frame renders */
    }
    if (h === undefined && scene.globe.show) {
      try {
        h = scene.globe.getHeight(carto);
      } catch (_) {}
    }
    if (h !== undefined) {
      groundHeight = h;
      groundSampleCarto =
        groundSampleCarto || new Cesium.Cartographic();
      Cesium.Cartographic.clone(carto, groundSampleCarto);
    } else if (groundSampleCarto) {
      // Keep the last known ground height through transient sampling gaps
      // (tiles still streaming, ground out of view) so the soft floor and
      // flight speed stay stable — but drop it once the camera has moved
      // far enough horizontally that it is meaningless.
      const moved = Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0),
        Cesium.Cartesian3.fromRadians(
          groundSampleCarto.longitude,
          groundSampleCarto.latitude,
          0
        )
      );
      if (moved > 1000) {
        groundHeight = undefined;
        groundSampleCarto = null;
      }
    }
  }

  function enforceFloor(dt) {
    if (flightState.flying || orbitActive) return;
    const floor = (groundHeight ?? 0) + MIN_CAM_HEIGHT;
    const carto = camera.positionCartographic;
    if (carto.height >= floor) return;
    // Soft: ease the camera up instead of snapping.
    const eased = Cesium.Math.lerp(carto.height, floor, Math.min(1, dt * 8));
    camera.setView({
      destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, eased),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    });
  }

  /* ---------- per-frame update ---------- */

  let prevFrameTime;
  scene.preUpdate.addEventListener(function () {
    const now = performance.now();
    const dt = Math.min((now - (prevFrameTime ?? now)) / 1000, 0.1);
    prevFrameTime = now;
    sampleGround(now);
    updateFlight(dt);
    updateNav(dt);
    if (orbitActive) camera.rotateRight(ORBIT_RATE * dt);
    enforceFloor(dt);
  });

  /* ---------- fps counter (F) ---------- */

  let frameCount = 0;
  let fpsWindowStart = performance.now();
  scene.postRender.addEventListener(function () {
    const needleDeg = -Math.round(Cesium.Math.toDegrees(camera.heading) * 2) / 2;
    if (needleDeg !== lastNeedleDeg) {
      lastNeedleDeg = needleDeg;
      compassNeedle.style.transform = "rotate(" + needleDeg + "deg)";
    }
    frameCount += 1;
    const now = performance.now();
    if (now - fpsWindowStart >= 500) {
      if (!els.fps.hidden) {
        els.fps.textContent = Math.round((frameCount * 1000) / (now - fpsWindowStart)) + " fps";
      }
      frameCount = 0;
      fpsWindowStart = now;
    }
  });

  /* ---------- mobile menu ---------- */

  els.menuToggle.addEventListener("click", function () {
    const open = document.body.classList.toggle("panel-open");
    els.menuToggle.setAttribute("aria-expanded", String(open));
  });

  // Console/authoring handle (also used by the smoke test).
  window.__CYBERPORT__ = {
    viewer,
    sources,
    get activeKey() {
      return activeKey;
    },
    get orbitActive() {
      return orbitActive;
    },
  };

  /* ---------- boot: pick a source, then the cinematic fly-in ---------- */

  function flyIn() {
    // Start ~20 km up, south over the sea, looking north at Hong Kong Island…
    camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(START.lon, START.lat - 0.12, 20000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-56),
        roll: 0,
      },
    });
    // …then dive to the hero view of Cyberport.
    const hero = BOOKMARKS[0];
    flyTo(hero.lon, hero.lat, hero.height, hero.heading, hero.pitch, FLY_IN_SECONDS);
  }

  (async function boot() {
    if (!hasIonToken && !hasGoogleKey) {
      markUnavailable("google", "Cesium ion token missing");
    }
    if (!hasHkKey) markUnavailable("hk", "API key missing");
    updateSourceButtons();
    applyMode(null);
    initTerrain();
    initImagery().then(initLocalAerial); // aerial layer drapes above the base

    let flown = false;
    const startFlyIn = function () {
      if (flown) return;
      flown = true;
      flyIn();
    };
    // Don't hold the intro hostage to a slow tileset handshake.
    const flyTimer = setTimeout(startFlyIn, 2500);

    const preferred = nextFallback(null) || "osm";
    if (preferred === "osm") {
      setNote("app", "Keyless Open 3D mode — paste a key in app.js for photorealistic tiles");
    }
    await activateSource(preferred, true);
    clearTimeout(flyTimer);
    startFlyIn();
  })();
})();
