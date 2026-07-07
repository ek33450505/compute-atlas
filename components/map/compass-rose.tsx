"use client";

interface CompassRoseProps {
  bearing: number;
  onResetNorth: () => void;
}

/** Degrees of bearing considered "essentially north" — no visual activation below this. */
const NORTH_EPSILON = 0.5;

/**
 * Functional atlas rose — a restrained ink N-arrow that resets bearing on click.
 *
 * Design decisions:
 * - 4-point star: N arm solid ink (turns primary green when rotated); S/E/W hairline border.
 * - SVG group rotates by -bearing so the N tip always points to true north on screen.
 * - Visually activates (N arm green + subtle ring) only when bearing != 0, signalling to
 *   the user that clicking will reset orientation.
 * - 44×44 px button (h-11 w-11) meets the ≥44 px project touch-target rule.
 *
 * Mount as an absolute overlay inside FacilityMap's container, below NavigationControl
 * (e.g. `absolute top-20 right-2 z-20`).
 */
export function CompassRose({ bearing, onResetNorth }: CompassRoseProps) {
  const isRotated = Math.abs(bearing) > NORTH_EPSILON;

  return (
    <button
      type="button"
      onClick={onResetNorth}
      aria-label="Reset map orientation to north"
      className={[
        // Size — ≥44 px touch target (WCAG 2.5.8 project rule)
        "flex h-11 w-11 items-center justify-center",
        // Shape + parchment skin matching zoom control
        "rounded-sm bg-popover border border-border",
        "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
        // Interaction
        "cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        // Activation: subtle primary ring when bearing is non-zero
        isRotated ? "ring-1 ring-primary/50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* 4-point compass star — rotates so N always aligns to true north */}
      <svg
        viewBox="0 0 40 40"
        width="26"
        height="26"
        aria-hidden="true"
      >
        {/*
         * Star geometry: 4 triangles sharing inner "waist" points at (24,16),
         * (24,24), (16,24), (16,16). Arms do not overlap — clean at intersection.
         *
         * Outer tips:  N(20,3)  E(37,20)  S(20,37)  W(3,20)
         * Inner waists: NE(24,16) SE(24,24) SW(16,24) NW(16,16)
         */}
        <g
          style={{
            transform: `rotate(${-bearing}deg)`,
            transformBox: "fill-box",
            transformOrigin: "center",
          }}
        >
          {/* North arm — solid ink; turns primary green when rotated */}
          <polygon
            points="20,3 24,16 16,16"
            fill={isRotated ? "var(--primary)" : "var(--foreground)"}
          />
          {/* South arm — hairline only */}
          <polygon
            points="20,37 24,24 16,24"
            fill="none"
            stroke="var(--border)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* East arm — hairline only */}
          <polygon
            points="37,20 24,16 24,24"
            fill="none"
            stroke="var(--border)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* West arm — hairline only */}
          <polygon
            points="3,20 16,16 16,24"
            fill="none"
            stroke="var(--border)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          {/* Center dot — covers join seam */}
          <circle cx="20" cy="20" r="1.5" fill="var(--background)" />
          {/* "N" label inside north arm — mono, parchment fill, readable on both ink+green */}
          <text
            x="20"
            y="12"
            textAnchor="middle"
            fontSize="6"
            fontFamily="var(--font-geist-mono), ui-monospace, monospace"
            fill="var(--background)"
            fontWeight="600"
          >
            N
          </text>
        </g>
      </svg>
    </button>
  );
}
