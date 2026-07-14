import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteConfig } from "@/lib/site";
import { getStats } from "@/lib/data";

// Atlas palette — CSS vars are not available in ImageResponse; hardcoded from app/globals.css :root
const PARCHMENT = "#F5F1E6";
const INK = "#2B2721";
const MUTED_INK = "#5C5344";
const PRIMARY_GREEN = "#3F5B43";
const HAIRLINE = "#CDBFA0";

// Parchment-tuned atlas status colors (replaces old Wong palette)
// These are the parchment-calibrated values, not the original colorblind-safe Wong hexes
const STATUS_COLORS = [
  "#005E90", // operational
  "#8F4108", // under-construction
  "#036A4A", // permitted
  "#8A2661", // proposed
  "#565C64", // cancelled
];

export const alt = `${siteConfig.name} — ${siteConfig.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Fraunces-72pt-SemiBold.ttf is vendored in public/fonts/ — loaded via readFileSync below.

export default async function OGImage() {
  const fraunces = readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf"));
  const { count, states, operationalMw } = await getStats();
  const statLine = `${count} SITES · ${states} STATES · ${(operationalMw / 1000).toFixed(1)} GW OPERATIONAL`;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: PARCHMENT,
          padding: 28,
        }}
      >
        {/* Neatline frame — 1px hairline border inset ~28px; all content sits inside */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: HAIRLINE,
            padding: "40px 52px",
            justifyContent: "space-between",
          }}
        >
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
              <svg
                width="64"
                height="64"
                viewBox="0 0 24 24"
                style={{ display: "flex", flexShrink: 0 }}
              >
                <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke={PRIMARY_GREEN} strokeWidth="1.6" />
                <line x1="12" y1="4" x2="12" y2="20" stroke={PRIMARY_GREEN} strokeWidth="1.6" />
                <line x1="4" y1="12" x2="20" y2="12" stroke={PRIMARY_GREEN} strokeWidth="1.6" />
                <circle cx="12" cy="12" r="2.4" fill={PRIMARY_GREEN} />
              </svg>
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
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Fraunces", data: fraunces, weight: 600, style: "normal" }],
    }
  );
}
