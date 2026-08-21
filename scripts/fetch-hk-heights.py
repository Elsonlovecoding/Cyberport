#!/usr/bin/env python3
"""Measure real building heights from Hong Kong's 2020 LiDAR survey.

The Lands Department publishes a Digital Surface Model (DSM — includes
buildings) and a Digital Terrain Model (DTM — bare ground) as open data.
DSM minus DTM at a building's footprint IS its measured height, so this
replaces estimates with real observations wherever the services answer.

Discovers the ArcGIS image services at runtime (item ids move between
releases), samples both models at points inside each footprint, and writes
hk-heights.json: {"<index>": height_metres}.

Best effort by design: prints what it finds and exits 0 if the services are
unavailable, leaving the caller's existing heights untouched.
"""
import json
import sys
import urllib.parse
import urllib.request

TIMEOUT = 60
UA = {"User-Agent": "cyberport-3d-viewer/1.0 (open data height sampling)"}


def get_json(url, data=None):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def discover():
    """Find candidate DSM/DTM ArcGIS image services."""
    queries = [
        '(title:"Digital Surface Model" OR title:DSM) AND "Hong Kong" AND type:"Image Service"',
        '(title:"Digital Terrain Model" OR title:DTM) AND "Hong Kong" AND type:"Image Service"',
        '"Hong Kong" LiDAR 2020 AND type:"Image Service"',
    ]
    found = {}
    for q in queries:
        url = (
            "https://www.arcgis.com/sharing/rest/search?f=json&num=50&q="
            + urllib.parse.quote(q)
        )
        try:
            res = get_json(url)
        except Exception as exc:  # noqa: BLE001
            print(f"  search failed ({exc}) for: {q}")
            continue
        for item in res.get("results", []):
            if item.get("url"):
                found[item["url"]] = item.get("title", "")
    print(f"discovered {len(found)} candidate image services:")
    for url, title in found.items():
        print(f"  {title}  ->  {url}")
    return found


def pick(found, positive, negative):
    for url, title in found.items():
        t = title.lower()
        if any(p in t for p in positive) and not any(n in t for n in negative):
            return url
    return None


def sample(service, points):
    """ArcGIS ImageServer getSamples, batched. Returns list of float|None."""
    out = []
    BATCH = 250
    for i in range(0, len(points), BATCH):
        chunk = points[i : i + BATCH]
        geom = {
            "points": [[p[0], p[1]] for p in chunk],
            "spatialReference": {"wkid": 4326},
        }
        body = urllib.parse.urlencode(
            {
                "geometry": json.dumps(geom),
                "geometryType": "esriGeometryMultipoint",
                "returnFirstValueOnly": "true",
                "interpolation": "RSP_BilinearInterpolation",
                "f": "json",
            }
        ).encode()
        try:
            res = get_json(service.rstrip("/") + "/getSamples", data=body)
        except Exception as exc:  # noqa: BLE001
            print(f"  getSamples failed: {exc}")
            return None
        if "error" in res:
            print(f"  getSamples error: {res['error']}")
            return None
        vals = [None] * len(chunk)
        for s in res.get("samples", []):
            try:
                idx = int(s.get("locationId", -1))
                v = float(s.get("value"))
                if 0 <= idx < len(chunk):
                    vals[idx] = v
            except (TypeError, ValueError):
                continue
        out.extend(vals)
    return out


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


def main():
    buildings = json.load(open("data/cyberport-buildings.json"))["buildings"]
    found = discover()
    if not found:
        print("No image services discovered — leaving heights as they are.")
        return 0

    dsm = pick(found, ["surface", "dsm"], ["terrain", "dtm"])
    dtm = pick(found, ["terrain", "dtm"], ["surface", "dsm"])
    print(f"chosen DSM: {dsm}")
    print(f"chosen DTM: {dtm}")
    if not dsm or not dtm:
        print("Could not identify both models — leaving heights as they are.")
        return 0

    # Several points per building — centroid plus vertices pulled well inside
    # — so a lift machine room or a light well can't set the whole height.
    pts = []
    owner = []
    for i, b in enumerate(buildings):
        ring = b["p"]
        cx, cy = centroid(ring)
        samples = [(cx, cy)]
        step = max(1, len(ring) // 4)
        for k in range(0, len(ring), step):
            x, y = ring[k]
            samples.append((cx + (x - cx) * 0.55, cy + (y - cy) * 0.55))
        for p in samples[:5]:
            pts.append(p)
            owner.append(i)

    print(f"sampling {len(pts)} points from DSM…")
    dsm_v = sample(dsm, pts)
    if dsm_v is None:
        return 0
    print(f"sampling {len(pts)} points from DTM…")
    dtm_v = sample(dtm, pts)
    if dtm_v is None:
        return 0

    per_building = {}
    for idx, a, g in zip(owner, dsm_v, dtm_v):
        if a is None or g is None:
            continue
        per_building.setdefault(idx, []).append(a - g)

    heights = {}
    for idx, vals in per_building.items():
        vals.sort()
        h = vals[len(vals) // 2] if len(vals) % 2 else (vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2
        if 2.5 <= h <= 500:
            heights[str(idx)] = round(h, 1)
    print(f"measured heights for {len(heights)} / {len(buildings)} buildings")
    if heights:
        json.dump(heights, open("hk-heights.json", "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
