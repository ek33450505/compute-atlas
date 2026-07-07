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

        {/* Centered ⌖ crosshair — inline SVG; ~55% of 180px canvas = ~99px */}
        <svg
          width="99"
          height="99"
          viewBox="0 0 32 32"
          style={{ display: "flex" }}
        >
          <circle
            cx="16"
            cy="16"
            r="7.5"
            fill="none"
            stroke={PRIMARY_GREEN}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <line
            x1="16"
            y1="3"
            x2="16"
            y2="29"
            stroke={PRIMARY_GREEN}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <line
            x1="3"
            y1="16"
            x2="29"
            y2="16"
            stroke={PRIMARY_GREEN}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </svg>
      </div>
    ),
    {
      ...size,
    }
  );
}
