import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";
import { getStats } from "@/lib/data";
import { AtlasMark, INK, MUTED_INK, OgFrame, loadFrauncesFont } from "@/lib/og-theme";

export const revalidate = 3600;

// Parchment-tuned atlas status colors (replaces old Wong palette)
// These are the parchment-calibrated values, not the original colorblind-safe Wong hexes
const STATUS_COLORS = [
  "#005E90", // operational
  "#8F4108", // under-construction
  "#036A4A", // permitted
  "#8A2661", // proposed
  "#39414A", // cancelled
];

export const alt = `${siteConfig.name} — ${siteConfig.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
  const fraunces = loadFrauncesFont();
  const { count, states, operationalMw } = await getStats();
  const statLine = `${count} SITES · ${states} STATES · ${(operationalMw / 1000).toFixed(1)} GW OPERATIONAL`;

  return new ImageResponse(
    (
      <OgFrame justifyContent="space-between">
        {/* Top section: atlas plate overline + status spectrum rule */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 20,
              color: MUTED_INK,
              letterSpacing: "3.6px", // ~0.18em at 20px
            }}
          >
            UNITED STATES · EDITION 2026 · 39.5°N 98.5°W
          </div>
          {/* Thin status-accent spectrum row — mirrors the map status legend */}
          <div style={{ display: "flex", gap: 4 }}>
            {STATUS_COLORS.map((color) => (
              <div
                key={color}
                style={{
                  flex: 1,
                  height: 6,
                  backgroundColor: color,
                  borderRadius: 3,
                }}
              />
            ))}
          </div>
        </div>

        {/* Wordmark block — graticule mark + site name + tagline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <AtlasMark dim={64} />
            <span
              style={{
                fontSize: 76,
                fontWeight: 600,
                color: INK,
                letterSpacing: "-1.5px",
                lineHeight: 1,
                fontFamily: "Fraunces",
              }}
            >
              {siteConfig.name}
            </span>
          </div>
          <div
            style={{
              fontSize: 28,
              color: MUTED_INK,
              fontWeight: 400,
              lineHeight: 1.4,
              maxWidth: 800,
            }}
          >
            {siteConfig.tagline}
          </div>
        </div>

        {/* Bottom section: live stats + site label */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 20,
              color: MUTED_INK,
              letterSpacing: "2.4px", // ~0.12em at 20px
            }}
          >
            {statLine}
          </div>
          <div
            style={{
              fontSize: 18,
              color: MUTED_INK,
            }}
          >
            {siteConfig.url.replace(/^https?:\/\//, "")}
          </div>
        </div>
      </OgFrame>
    ),
    {
      ...size,
      fonts: [{ name: "Fraunces", data: fraunces, weight: 600, style: "normal" }],
    }
  );
}
