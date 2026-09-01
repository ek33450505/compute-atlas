#!/usr/bin/env python3
"""Generate the README banner from the real facility coordinates.

The banner is not decoration with a map motif on it — it *is* the dataset:
every point is a tracked facility, positioned by its own lat/lon and coloured
by its own status, using the same status palette as the live site
(`app/globals.css`). Regenerate it after a data wave and the picture updates
itself.

    python3 scripts/make-banner.py            # writes docs/media/banner.svg
    node scripts/render-banner.mjs            # rasterises it to banner.png

Reads `public/data/hero-points.json`, which `npm run build:mapdata` produces.
Stdlib only — no pip installs.
"""

import base64
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
POINTS = ROOT / "public" / "data" / "hero-points.json"
FONT = ROOT / "public" / "fonts" / "Fraunces-72pt-SemiBold.ttf"
OUT = ROOT / "docs" / "media" / "banner.svg"

# Must stay in sync with the --status-* custom properties in app/globals.css.
STATUS_COLOR = {
    "operational": "#005E90",
    "under_construction": "#8F4108",
    "permitted": "#036A4A",
    "proposed": "#8A2661",
    "cancelled": "#39414A",
}
INK, PARCHMENT, MUTED, RULE, PRIMARY = "#2B2721", "#F5F1E6", "#5C5344", "#CDBFA0", "#3F5B43"

W, H = 1200, 340
MAPW, MAPH, OX, OY = 640, 232, 520, 50
# Painted last = drawn on top. Operational sits above the speculative statuses
# so the built-out corridors stay legible where records overlap.
PAINT_ORDER = ["cancelled", "proposed", "permitted", "under_construction", "operational"]


def albers(lon, lat, lat0, lon0, p1, p2):
    """Albers equal-area conic. Returns SVG-oriented coordinates.

    The y component is negated because Albers' y grows north while SVG's grows
    down; without that the map renders upside down.
    """
    lon, lat, lat0, lon0, p1, p2 = map(math.radians, (lon, lat, lat0, lon0, p1, p2))
    n = 0.5 * (math.sin(p1) + math.sin(p2))
    c = math.cos(p1) ** 2 + 2 * n * math.sin(p1)
    rho0 = math.sqrt(c - 2 * n * math.sin(lat0)) / n
    rho = math.sqrt(c - 2 * n * math.sin(lat)) / n
    theta = n * (lon - lon0)
    return rho * math.sin(theta), -(rho0 - rho * math.cos(theta))


def main() -> None:
    points = json.loads(POINTS.read_text())

    # Alaska and Hawaii are deliberately dropped rather than inset. At this
    # size each is a single isolated dot that reads as dirt on the page, not as
    # geography, and an inset for one point costs more legibility than it buys.
    # The count printed at the end says exactly how many were left out.
    lower48, offmap = [], 0
    for p in points:
        lon, lat = p["lon"], p["lat"]
        if (lat > 50 and lon < -128) or (-161 < lon < -154 and 18 < lat < 23):
            offmap += 1
            continue
        lower48.append((albers(lon, lat, 37.5, -96, 29.5, 45.5), p["status"]))

    if not lower48:
        raise SystemExit("no lower-48 points found — is hero-points.json populated?")

    xs = [p[0][0] for p in lower48]
    ys = [p[0][1] for p in lower48]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    # One scale for both axes: scaling x and y independently would stretch the
    # projection and the country would stop looking like itself.
    scale = min(MAPW / (maxx - minx), MAPH / (maxy - miny))
    cx = OX + MAPW / 2 - scale * (minx + maxx) / 2
    cy = OY + MAPH / 2 - scale * (miny + maxy) / 2

    circles = "".join(
        f'<circle cx="{cx + scale * x:.1f}" cy="{cy + scale * y:.1f}" r="2.2" '
        f'fill="{STATUS_COLOR.get(status, STATUS_COLOR["cancelled"])}" opacity="0.85"/>'
        for status in PAINT_ORDER
        for (x, y), s in lower48
        if s == status
    )

    legend, lx = "", 62
    for status, label in [
        ("operational", "Operational"),
        ("under_construction", "Building"),
        ("permitted", "Permitted"),
        ("proposed", "Proposed"),
    ]:
        legend += (
            f'<circle cx="{lx}" cy="257" r="3.2" fill="{STATUS_COLOR[status]}"/>'
            f'<text x="{lx + 10}" y="260.5" class="lg">{label}</text>'
        )
        lx += len(label) * 5.9 + 32

    # Embedded so the SVG renders identically anywhere, with no network fetch.
    font_b64 = base64.b64encode(FONT.read_bytes()).decode()

    OUT.write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs><style>
@font-face {{ font-family:"Fraunces"; src:url(data:font/ttf;base64,{font_b64}) format("truetype"); }}
.wm {{ font-family:"Fraunces",Georgia,serif; fill:{INK}; }}
.tag {{ font-family:ui-sans-serif,-apple-system,"Helvetica Neue",sans-serif; fill:{MUTED}; }}
.lg {{ font-family:ui-sans-serif,-apple-system,"Helvetica Neue",sans-serif; fill:{MUTED}; font-size:11px; }}
</style></defs>
<rect width="{W}" height="{H}" fill="{PARCHMENT}"/>
<rect x="0" y="0" width="{W}" height="3" fill="{PRIMARY}"/>
{circles}
<text x="62" y="130" class="wm" font-size="60" letter-spacing="1">Compute Atlas</text>
<text x="64" y="170" class="tag" font-size="16.5">Every data center, crypto mine, and power plant built to feed</text>
<text x="64" y="193" class="tag" font-size="16.5">them — mapped, sourced, and open.</text>
<line x1="64" y1="223" x2="410" y2="223" stroke="{RULE}" stroke-width="1"/>
{legend}
</svg>''')

    print(f"wrote {OUT.relative_to(ROOT)} — {len(lower48)} points plotted, {offmap} off-map (AK/HI)")


if __name__ == "__main__":
    main()
