#!/usr/bin/env python3
"""
compute-marker-offsets.py

Computes deterministic pixel offsets for map markers to prevent WCAG 2.5.8
target-size violations caused by geographically clustered markers overlapping
at the initial map view (zoom 3.4).

Algorithm: greedy closest-pair separation (full correction each step, capped
at MAX_DRIFT_PX from the natural geographic position).

Run this script whenever facilities are added or their coordinates change, then
update the MARKER_OFFSETS table in lib/map.ts with the output.

Usage:
    python3 scripts/compute-marker-offsets.py
"""

import json
import math
import os

# --- Configuration --------------------------------------------------------

ZOOM = 3.4       # Must match INITIAL_VIEW_STATE.zoom in lib/map.ts
MIN_DIST = 29.0  # Minimum center-to-center distance (px); buttons are 28px
MAX_DRIFT = 22.0 # Maximum pixel drift from geographic position
MAX_ITER = 20000 # Upper bound on iterations

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "facilities.json")

# --- Mercator helpers -----------------------------------------------------

def lon_to_x(lon: float, zoom: float) -> float:
    return (lon + 180.0) / 360.0 * 256.0 * (2.0 ** zoom)


def lat_to_y(lat: float, zoom: float) -> float:
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0
    return y * 256.0 * (2.0 ** zoom)


# --- Main -----------------------------------------------------------------

def main() -> None:
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)

    facilities = sorted(
        data if isinstance(data, list) else data.get("facilities", []),
        key=lambda fac: fac["id"],
    )

    natural: dict[str, list[float]] = {
        f["id"]: [lon_to_x(f["location"]["lon"], ZOOM), lat_to_y(f["location"]["lat"], ZOOM)]
        for f in facilities
    }
    pos: dict[str, list[float]] = {k: list(v) for k, v in natural.items()}
    ids = [f["id"] for f in facilities]

    for iteration in range(MAX_ITER):
        # Find the closest pair
        min_d = float("inf")
        best: tuple[str, str] | None = None
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                dx = pos[ids[j]][0] - pos[ids[i]][0]
                dy = pos[ids[j]][1] - pos[ids[i]][1]
                d = math.sqrt(dx * dx + dy * dy) or 0.001
                if d < min_d:
                    min_d = d
                    best = (ids[i], ids[j])
        if min_d >= MIN_DIST:
            print(f"Converged in {iteration} iterations (min_d = {min_d:.3f}px)")
            break
        assert best is not None
        id1, id2 = best
        dx = pos[id2][0] - pos[id1][0]
        dy = pos[id2][1] - pos[id1][1]
        d = math.sqrt(dx * dx + dy * dy) or 0.001
        needed = (MIN_DIST - d) * 0.5  # half-correction per step
        nx, ny = dx / d, dy / d
        for fid, sign in [(id1, -1.0), (id2, 1.0)]:
            pos[fid][0] += sign * nx * needed
            pos[fid][1] += sign * ny * needed
            ox = pos[fid][0] - natural[fid][0]
            oy = pos[fid][1] - natural[fid][1]
            drift = math.sqrt(ox * ox + oy * oy)
            if drift > MAX_DRIFT:
                pos[fid][0] = natural[fid][0] + ox / drift * MAX_DRIFT
                pos[fid][1] = natural[fid][1] + oy / drift * MAX_DRIFT
    else:
        print(f"Warning: did not fully converge within {MAX_ITER} iterations (min_d = {min_d:.3f}px)")

    # Verify
    violations = 0
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            dx = pos[ids[j]][0] - pos[ids[i]][0]
            dy = pos[ids[j]][1] - pos[ids[i]][1]
            d = math.sqrt(dx * dx + dy * dy)
            if d < 28:
                print(f"  CLOSE pair: {ids[i]} -- {ids[j]}: {d:.1f}px")
                violations += 1
    if not violations:
        print("All pairs >= 28px apart.")

    print()
    print("Copy into lib/map.ts → MARKER_OFFSETS:")
    print()
    print("const MARKER_OFFSETS: Record<string, [number, number]> = {")
    for fid in ids:
        ox = round(pos[fid][0] - natural[fid][0])
        oy = round(pos[fid][1] - natural[fid][1])
        if ox != 0 or oy != 0:
            print(f'  "{fid}": [{ox}, {oy}],')
    print("};")


if __name__ == "__main__":
    main()
