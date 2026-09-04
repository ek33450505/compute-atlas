import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";
import { getFacilityByIdCached } from "@/lib/data";
import { getStatusMeta, type Status } from "@/lib/status";
import { FACILITY_TYPE_META } from "@/lib/facility-type";
import { stateNameFromCode } from "@/lib/us-states";
import {
  AtlasMark,
  HAIRLINE,
  INK,
  MUTED_INK,
  OgFrame,
  PARCHMENT,
  loadFrauncesFont,
  renderOgFallbackCard,
} from "@/lib/og-theme";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/facilities/[slug]/page.tsx) prerenders all 1000+
// facility slugs at build time; doing the same for this image route would add
// a render per facility to every production build. Deliberately on-demand.
export const revalidate = 86400;

// Parchment-tuned atlas status colors, keyed by status for a single
// facility's lookup (app/opengraph-image.tsx uses the same five hexes as an
// ordered array since it draws the full spectrum rather than one status).
const STATUS_COLOR: Record<Status, string> = {
  operational: "#005E90",
  under_construction: "#8F4108",
  permitted: "#036A4A",
  proposed: "#8A2661",
  cancelled: "#39414A",
};

export const alt = `${siteConfig.name} — facility profile`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const facility = await getFacilityByIdCached(slug);
  const fraunces = loadFrauncesFont();

  // Bad or stale slug: never throw from an image route — a 500 here breaks
  // link unfurling for crawlers. Fall back to a generic site card instead.
  if (!facility) {
    return renderOgFallbackCard(fraunces, siteConfig, size);
  }

  const typeLabel = (
    FACILITY_TYPE_META[facility.facilityType]?.label ?? facility.facilityType
  ).toUpperCase();
  const stateName = (
    stateNameFromCode(facility.location.state) ?? facility.location.state
  ).toUpperCase();
  const statusMeta = getStatusMeta(facility.status);
  const statusColor = STATUS_COLOR[facility.status];

  // Mirrors the capacity formatting on the homepage's notable-sites cards
  // (app/page.tsx ~L189, L217-223): operational capacity wins over planned,
  // MW below 1000 else GW to one decimal.
  const cap = facility.capacityMw?.operational ?? facility.capacityMw?.planned ?? null;
  const capacityLabel =
    cap === null ? null : cap >= 1000 ? `${(cap / 1000).toFixed(1)} GW` : `${cap} MW`;

  // Operator names in this dataset are not all short handles — some are full
  // descriptive strings (e.g. "Multi-tenant carrier hotel (Digital Realty,
  // CoreSite, and other carrier/telecom tenants)"). Rendered raw, one of
  // those wraps to several lines and squeezes the status chip beside it until
  // the chip's own label is clipped mid-word. Satori's `text-overflow` support
  // is partial, so bound the string here rather than relying on CSS.
  const OPERATOR_MAX = 52;
  const operatorLabel =
    facility.operator.length > OPERATOR_MAX
      ? `${facility.operator.slice(0, OPERATOR_MAX - 1).trimEnd()}…`
      : facility.operator;

  return new ImageResponse(
    (
      <OgFrame justifyContent="space-between">
        {/* Overline: facility type + state */}
        <div
          style={{
            fontFamily: "monospace",
            fontSize: 20,
            color: MUTED_INK,
            letterSpacing: "3.6px",
          }}
        >
          {/* Single interpolated string, NOT `{typeLabel} · {stateName}`:
              Satori throws "Expected <div> to have explicit display: flex
              ... if it has more than one child node" when JSX splits this
              into several text children. Keeping it one child avoids both
              that crash and the word-spacing changes display:flex would
              introduce. */}
          {`${typeLabel} · ${stateName}`}
        </div>

        {/* Headline + status chip + operator/capacity */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <span
            style={{
              fontSize: 50,
              fontWeight: 600,
              color: INK,
              letterSpacing: "-1px",
              lineHeight: 1.15,
              fontFamily: "Fraunces",
              maxWidth: 1040,
            }}
          >
            {facility.name}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                display: "flex",
                fontFamily: "monospace",
                fontSize: 18,
                color: PARCHMENT,
                backgroundColor: statusColor,
                letterSpacing: "1.6px",
                padding: "8px 16px",
                borderRadius: 6,
                /* Never let a long operator name squeeze the chip until its
                   own label clips mid-word — the chip is fixed-size, the
                   operator is the flexible element. */
                flexShrink: 0,
              }}
            >
              {statusMeta.label.toUpperCase()}
            </div>
            <span style={{ fontSize: 26, color: MUTED_INK }}>{operatorLabel}</span>
            {capacityLabel && (
              <>
                <span style={{ fontSize: 26, color: HAIRLINE }}>·</span>
                <span style={{ fontSize: 26, color: MUTED_INK, fontFamily: "monospace" }}>
                  {capacityLabel}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Coordinate line + wordmark */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 20,
              color: MUTED_INK,
              letterSpacing: "2.4px",
            }}
          >
            {/* Single child, same Satori constraint as the overline above. */}
            {`${facility.location.lat.toFixed(3)}°N ${Math.abs(facility.location.lon).toFixed(3)}°W`}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <AtlasMark dim={36} />
            <span
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: INK,
                letterSpacing: "-0.5px",
                fontFamily: "Fraunces",
              }}
            >
              {siteConfig.name}
            </span>
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
