import { ImageResponse } from "next/og";

// Atlas palette — CSS vars are not available in ImageResponse; hardcoded from app/globals.css :root
const PARCHMENT = "#F5F1E6";
const PRIMARY_GREEN = "#3F5B43";
const HAIRLINE = "#CDBFA0";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: PARCHMENT,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Inset neatline border — atlas parchment feel */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            inset: 10,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: HAIRLINE,
          }}
        />

        {/* Centered plate-stack mark — inline SVG; ~55% of 180px canvas = ~99px */}
        <svg width="99" height="99" viewBox="0 0 24 24" style={{ display: "flex" }}>
          <rect x="7" y="2.4" width="14.6" height="14.6" rx="0.4" fill="none" stroke={PRIMARY_GREEN} strokeWidth="1.2" opacity={0.45} />
          <line x1="9.7" y1="7" x2="9.7" y2="21.6" stroke={PRIMARY_GREEN} strokeWidth="0.9" opacity={0.28} />
          <line x1="2.4" y1="14.3" x2="17" y2="14.3" stroke={PRIMARY_GREEN} strokeWidth="0.9" opacity={0.28} />
          <rect x="2.4" y="7" width="14.6" height="14.6" rx="0.4" fill="none" stroke={PRIMARY_GREEN} strokeWidth="1.85" />
          <rect x="7.9" y="12.5" width="3.6" height="3.6" fill={PRIMARY_GREEN} />
        </svg>
      </div>
    ),
    {
      ...size,
    }
  );
}
