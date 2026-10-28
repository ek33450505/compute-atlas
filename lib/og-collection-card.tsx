import { ImageResponse } from "next/og";
import { AtlasMark, INK, MUTED_INK, OgFrame } from "@/lib/og-theme";

export interface OgStat {
  value: string;
  label: string;
}

/**
 * Share card for the collection-page routes (opposition, county, metro,
 * status): overline, headline, a row of stat blocks, wordmark and domain.
 * Same visual language as app/states/[state]/opengraph-image.tsx, which
 * predates it and still inlines this layout. Takes `site`/`size` as params
 * rather than importing `@/lib/site`, like `renderOgFallbackCard`, so the
 * layout stays free of app-specific data dependencies.
 */
export function renderOgCollectionCard({
  overline,
  headline,
  stats,
  fraunces,
  site,
  size,
}: {
  overline: string;
  headline: string;
  stats: OgStat[];
  fraunces: Buffer;
  site: { name: string; url: string };
  size: { width: number; height: number };
}) {
  return new ImageResponse(
    (
      <OgFrame justifyContent="space-between">
        {/* Overline */}
        <div
          style={{
            fontFamily: "monospace",
            fontSize: 20,
            color: MUTED_INK,
            letterSpacing: "3.6px",
          }}
        >
          {overline}
        </div>

        {/* Headline + stat blocks */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <span
            style={{
              fontSize: 64,
              fontWeight: 600,
              color: INK,
              letterSpacing: "-1.5px",
              lineHeight: 1.05,
              fontFamily: "Fraunces",
              maxWidth: 1040,
            }}
          >
            {headline}
          </span>
          <div style={{ display: "flex", gap: 48 }}>
            {stats.map((stat) => (
              <div
                key={stat.label}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                <span style={{ fontFamily: "monospace", fontSize: 40, color: INK }}>
                  {stat.value}
                </span>
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: 16,
                    color: MUTED_INK,
                    letterSpacing: "1.6px",
                  }}
                >
                  {stat.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Wordmark + domain */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <AtlasMark dim={40} />
            <span
              style={{
                fontSize: 30,
                fontWeight: 600,
                color: INK,
                letterSpacing: "-0.5px",
                fontFamily: "Fraunces",
              }}
            >
              {site.name}
            </span>
          </div>
          <div style={{ fontSize: 16, color: MUTED_INK }}>
            {site.url.replace(/^https?:\/\//, "")}
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
