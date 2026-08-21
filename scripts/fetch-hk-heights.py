#!/usr/bin/env python3
"""Measure real building heights from Hong Kong's 2020 LiDAR survey.

The Lands Department publishes a Digital Surface Model (DSM — includes
buildings) and a Digital Terrain Model (DTM — bare ground) as open data,
both as cached ArcGIS LERC elevation tiles that need no key. DSM minus DTM
over a building's footprint IS its measured height.

Writes:
  hk-heights.json  {"<building index>": height_m}
  data/terrain.json  5 m elevation grid from the DTM (better than the 30 m
                     global fallback, and consistent with the heights above)

Best effort by design: prints what it finds and exits 0 if anything is
unavailable, leaving existing data untouched.
"""
import base64
import json
import math
import struct
import sys
import urllib.parse
import urllib.request

BBOX = {"west": 114.115, "south": 22.248, "east": 114.145, "north": 22.274}
GRID_N = 384
TIMEOUT = 60
UA = {"User-Agent": "cyberport-3d-viewer/1.0 (open data height sampling)"}
R = 6378137.0


def get(url, data=None, raw=False):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        body = r.read()
    return body if raw else json.loads(body.decode("utf-8", "replace"))


def discover():
    queries = [
        '(title:"Digital Surface Model" OR title:DSM) AND "Hong Kong" AND type:"Image Service"',
        '(title:"Digital Terrain Model" OR title:DTM) AND "Hong Kong" AND type:"Image Service"',
    ]
    found = {}
    for q in queries:
        url = "https://www.arcgis.com/sharing/rest/search?f=json&num=50&q=" + urllib.parse.quote(q)
        try:
            res = get(url)
        except Exception as exc:  # noqa: BLE001
            print(f"  search failed ({exc})")
            continue
        for item in res.get("results", []):
            if item.get("url"):
                found[item["url"]] = item.get("title", "")
    print(f"discovered {len(found)} candidate services:")
    for u, t in found.items():
        print(f"  {t}  ->  {u}")
    return found


def pick(found, positive, negative):
    # Prefer the 2020 survey at 5 m when several vintages are published.
    ranked = []
    for url, title in found.items():
        t = title.lower()
        if any(p in t for p in positive) and not any(n in t for n in negative):
            ranked.append((0 if "2020" in t else 1, url))
    ranked.sort()
    return ranked[0][1] if ranked else None


_LERC_FORM = None


def decode_lerc(blob):
    """Decode an Esri LERC blob to a 2-D array.

    The `lerc` package's binding has changed shape across versions, so try
    the known call forms once, remember which worked, and report clearly.
    """
    global _LERC_FORM
    import lerc  # imported lazily so discovery works without it
    import numpy as np

    forms = [
        ("bytes", lambda b: lerc.decode(bytes(b))),
        ("bytearray", lambda b: lerc.decode(bytearray(b))),
        ("np_uint8", lambda b: lerc.decode(np.frombuffer(b, dtype=np.uint8))),
    ]
    if _LERC_FORM is not None:
        forms = [f for f in forms if f[0] == _LERC_FORM]

    errors = []
    for name, fn in forms:
        try:
            out = fn(blob)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            continue
        data = None
        for part in out if isinstance(out, tuple) else (out,):
            if hasattr(part, "shape") and getattr(part, "size", 0) > 1:
                data = part
                break
        if data is None:
            errors.append(f"{name}: no array in {type(out)}")
            continue
        while data.ndim > 2:  # (bands, rows, cols) -> (rows, cols)
            data = data[0]
        if _LERC_FORM != name:
            _LERC_FORM = name
            print(f"    lerc decode form: {name}, shape={data.shape}, dtype={data.dtype}")
        return data
    raise RuntimeError("; ".join(errors))


def lonlat_to_merc(lon, lat):
    x = math.radians(lon) * R
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R
    return x, y


class Elevation:
    """Reads a cached ArcGIS LERC elevation service over a bbox."""

    def __init__(self, service, name):
        self.name = name
        self.service = service.rstrip("/")
        info = get(self.service + "?f=json")
        ti = info.get("tileInfo") or {}
        self.size = ti.get("rows") or 256
        self.origin = (ti["origin"]["x"], ti["origin"]["y"])
        lods = ti.get("lods") or []
        if not lods:
            raise RuntimeError("no tileInfo.lods")
        self.fmt = ti.get("format", "?")
        # The service advertises LODs far deeper than the 5 m survey actually
        # caches (level 23 = 0.019 m/px), and those tiles 404. Try the level
        # nearest the real grid first, then progressively coarser.
        near = sorted(lods, key=lambda l: abs(l["resolution"] - 5.0))[0]
        self.candidates = [near] + sorted(
            [l for l in lods if l["level"] < near["level"]],
            key=lambda l: -l["level"],
        )
        self.lod = self.candidates[0]
        self.res = self.lod["resolution"]
        print(
            f"  {name}: format={self.fmt} lods={len(lods)} "
            f"startLevel={self.lod['level']} res={self.res:.3f} m/px tile={self.size}"
        )
        self.tiles = {}

    def calibrate(self, lon, lat):
        """Pick the deepest level that actually serves a decodable tile."""
        for lod in self.candidates[:8]:
            self.lod = lod
            self.res = lod["resolution"]
            self.tiles.clear()
            v = self.at(lon, lat)
            if v is not None:
                print(f"  {self.name}: using level {lod['level']} ({self.res:.3f} m/px), probe={v:.1f} m")
                return True
            print(f"  {self.name}: level {lod['level']} unusable")
        return False

    def _tile(self, col, row):
        key = (col, row)
        if key in self.tiles:
            return self.tiles[key]
        url = f"{self.service}/tile/{self.lod['level']}/{row}/{col}"
        arr = None
        try:
            blob = get(url, raw=True)
            if blob[:1] == b"{":  # error JSON, not a tile
                arr = None
            else:
                arr = decode_lerc(blob)
        except Exception as exc:  # noqa: BLE001
            print(f"    tile {self.lod['level']}/{row}/{col} failed: {exc}")
            arr = None
        self.tiles[key] = arr
        return arr

    def at(self, lon, lat):
        mx, my = lonlat_to_merc(lon, lat)
        wx = (mx - self.origin[0]) / self.res
        wy = (self.origin[1] - my) / self.res
        col = int(wx // self.size)
        row = int(wy // self.size)
        arr = self._tile(col, row)
        if arr is None:
            return None
        px = int(wx) % self.size
        py = int(wy) % self.size
        try:
            v = float(arr[py][px]) if arr.ndim == 2 else float(arr[0][py][px])
        except Exception:  # noqa: BLE001
            return None
        if not math.isfinite(v) or v < -100 or v > 1200:
            return None
        return v


def centroid(ring):
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    if abs(a) < 1e-14:
        return (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n)
    a *= 0.5
    return (cx / (6 * a), cy / (6 * a))


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def main():
    buildings = json.load(open("data/cyberport-buildings.json"))["buildings"]
    try:
        import lerc

        print(f"lerc module: {getattr(lerc, '__file__', '?')}")
        print(f"lerc exports: {[n for n in dir(lerc) if not n.startswith('_')][:12]}")
    except Exception as exc:  # noqa: BLE001
        print(f"lerc unavailable ({exc}) — cannot measure heights")
        return 0
    found = discover()
    dsm_url = pick(found, ["surface", "dsm"], ["terrain", "dtm"])
    dtm_url = pick(found, ["terrain", "dtm"], ["surface", "dsm"])
    print(f"chosen DSM: {dsm_url}")
    print(f"chosen DTM: {dtm_url}")
    if not dsm_url or not dtm_url:
        print("Could not identify both models — leaving data as it is.")
        return 0

    try:
        dsm = Elevation(dsm_url, "DSM")
        dtm = Elevation(dtm_url, "DTM")
    except Exception as exc:  # noqa: BLE001
        print(f"service metadata unavailable: {exc}")
        return 0

    # Probe before doing real work, so failures are obvious and cheap.
    probe = (114.130, 22.261)
    if not dsm.calibrate(*probe) or not dtm.calibrate(*probe):
        print("No usable tile level on one of the services — leaving data as it is.")
        return 0

    heights = {}
    for i, b in enumerate(buildings):
        ring = b["p"]
        cx, cy = centroid(ring)
        pts = [(cx, cy)]
        step = max(1, len(ring) // 4)
        for k in range(0, len(ring), step):
            x, y = ring[k]
            pts.append((cx + (x - cx) * 0.55, cy + (y - cy) * 0.55))
        vals = []
        for lon, lat in pts[:5]:
            s = dsm.at(lon, lat)
            t = dtm.at(lon, lat)
            if s is not None and t is not None:
                vals.append(s - t)
        if not vals:
            continue
        h = median(vals)
        if 2.5 <= h <= 500:
            heights[str(i)] = round(h, 1)
    print(f"measured heights for {len(heights)} / {len(buildings)} buildings")
    if heights:
        json.dump(heights, open("hk-heights.json", "w"))

    # Rebuild the terrain grid from the 5 m DTM: sharper than the 30 m global
    # fallback, and consistent with the heights measured above.
    grid = []
    holes = 0
    lo, hi = 1e9, -1e9
    for j in range(GRID_N):
        lat = BBOX["north"] - (BBOX["north"] - BBOX["south"]) * j / (GRID_N - 1)
        for i in range(GRID_N):
            lon = BBOX["west"] + (BBOX["east"] - BBOX["west"]) * i / (GRID_N - 1)
            v = dtm.at(lon, lat)
            if v is None:
                v = 0.0
                holes += 1
            v = max(0, min(1000, v))
            grid.append(int(round(v)))
            lo, hi = min(lo, v), max(hi, v)
    if holes < GRID_N * GRID_N * 0.25 and hi > 20:
        buf = struct.pack(f"<{len(grid)}h", *grid)
        json.dump(
            {
                "attribution": "Elevation: Lands Department, HKSAR Government (2020 LiDAR DTM, 5m)",
                "west": BBOX["west"],
                "south": BBOX["south"],
                "east": BBOX["east"],
                "north": BBOX["north"],
                "size": GRID_N,
                "min": int(lo),
                "max": int(hi),
                "data": base64.b64encode(buf).decode(),
            },
            open("data/terrain.json", "w"),
        )
        print(f"terrain grid from HK DTM: {GRID_N}x{GRID_N} min={lo:.0f} max={hi:.0f} holes={holes}")
    else:
        print(f"DTM grid rejected (holes={holes} max={hi}) — keeping existing terrain")
    return 0


if __name__ == "__main__":
    sys.exit(main())
