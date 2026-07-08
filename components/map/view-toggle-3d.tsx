"use client";

interface ViewToggle3DProps {
  is3D: boolean;
  onToggle: () => void;
}

/**
 * Toggle button that switches the map between flat (2-D) and tilted (3-D) view.
 *
 * Design: parchment skin matching CompassRose — same size, border, shadow, and
 * focus ring. Activates with a subtle primary ring + primary text colour when the
 * pitch is above the 3-D threshold, mirroring how CompassRose activates on rotation.
 */
export function ViewToggle3D({ is3D, onToggle }: ViewToggle3DProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={is3D}
      aria-label="Toggle 3D tilted view"
      className={[
        // Size — ≥44 px touch target (WCAG 2.5.8 project rule)
        "flex h-11 w-11 items-center justify-center",
        // Parchment skin matching compass-rose
        "rounded-sm bg-popover border border-border",
        "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
        // Interaction
        "cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        // Activation: subtle primary ring when in 3-D mode
        is3D ? "ring-1 ring-primary/50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Visible "3D" label — aria-hidden because the button label covers it */}
      <span
        aria-hidden="true"
        className={[
          "font-mono text-xs font-semibold",
          is3D ? "text-primary" : "text-foreground",
        ].join(" ")}
      >
        3D
      </span>
    </button>
  );
}
