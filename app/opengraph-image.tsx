import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";

// Wong palette hex values — CSS vars are not available in ImageResponse.
const WONG_COLORS = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#6B7280"];

export const alt = `${siteConfig.name} — ${siteConfig.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: "#09090b",
          padding: "64px 72px",
          justifyContent: "space-between",
        }}
      >
        {/* Status color accent row */}
        <div style={{ display: "flex", gap: 0 }}>
          {WONG_COLORS.map((color) => (
            <div
              key={color}
              style={{
                flex: 1,
                height: 6,
                backgroundColor: color,
                borderRadius: 3,
                margin: "0 2px",
              }}
            />
          ))}
        </div>

        {/* Wordmark and tagline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              color: "#fafafa",
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            {siteConfig.name}
          </div>
          <div
            style={{
              fontSize: 28,
              color: "#a1a1aa",
              fontWeight: 400,
              lineHeight: 1.4,
              maxWidth: 780,
            }}
          >
            {siteConfig.tagline}
          </div>
        </div>

        {/* Bottom label */}
        <div
          style={{
            fontSize: 18,
            color: "#71717a",
            fontWeight: 400,
          }}
        >
          computeatlas.org
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
