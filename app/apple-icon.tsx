import { ImageResponse } from "next/og";
import { AtlasMark, HAIRLINE, PARCHMENT } from "@/lib/og-theme";

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

        {/* Centered plate-stack mark — ~55% of 180px canvas = ~99px */}
        <AtlasMark dim={99} />
      </div>
    ),
    {
      ...size,
    }
  );
}
