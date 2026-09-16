import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HeroPlate } from "./hero-plate";
import { HERO_PLATE } from "./hero-plate-paths";
import { STATUS_ORDER, STATUS_META } from "@/lib/status";
import { isTerritoryCode, stateNameFromCode } from "@/lib/us-states";

// Every expectation below is COMPOSED from HERO_PLATE rather than pinned to a
// literal, so a data wave that changes the snapshot updates the test with the
// component. The one thing the test asserts independently is the arithmetic —
// `total - omitted` — which is the claim the caption actually makes.
const nf = new Intl.NumberFormat("en-US");
const expectedCovered = nf.format(HERO_PLATE.total - HERO_PLATE.omitted);
const expectedTotal = nf.format(HERO_PLATE.total);
const markCount = nf.format(HERO_PLATE.plotted);

function renderPlate() {
  const { container } = render(<HeroPlate />);
  const svg = container.querySelector("svg");
  expect(svg).not.toBeNull();
  return { container, svg: svg as SVGSVGElement };
}

describe("HeroPlate", () => {
  describe("mark rendering contract", () => {
    // The marks are zero-length subpaths (`M<x> <y>h.01`), drawn ONLY by the
    // stroke's round cap. Without linecap + a non-zero stroke-width, or with a
    // fill instead of a stroke, the plate renders completely blank — and no
    // other test in the suite would notice, because the <path> elements are
    // all still there.
    it("renders one path per status, each drawable: fill none, round linecap, non-zero stroke width", () => {
      const { container } = renderPlate();
      const paths = Array.from(container.querySelectorAll("path"));

      expect(paths).toHaveLength(STATUS_ORDER.length);

      for (const path of paths) {
        expect(path.getAttribute("fill")).toBe("none");
        expect(path.getAttribute("stroke-linecap")).toBe("round");
        const width = Number(path.getAttribute("stroke-width"));
        expect(Number.isFinite(width)).toBe(true);
        expect(width).toBeGreaterThan(0);
      }
    });

    it("draws each status path with that status's own data and theme colour token", () => {
      const { container } = renderPlate();
      const paths = Array.from(container.querySelectorAll("path"));

      STATUS_ORDER.forEach((status, i) => {
        expect(paths[i].getAttribute("d")).toBe(HERO_PLATE.paths[status]);
        // CSS custom property, not a raw hex: hero-globe.tsx has to duplicate
        // hex because MapLibre paint expressions can't read CSS vars. The
        // plate has no such constraint and must not inherit that sync hazard.
        expect(paths[i].getAttribute("stroke")).toBe(
          `var(${STATUS_META[status].colorVar})`
        );
        expect(paths[i].getAttribute("stroke")).not.toMatch(/#[0-9a-f]{3,6}/i);
      });
    });

    it("carries a path for every status the artifact knows about", () => {
      renderPlate();
      expect(Object.keys(HERO_PLATE.paths).sort()).toEqual(
        [...STATUS_ORDER].sort()
      );
    });
  });

  describe("projection framing", () => {
    // `slice` (cover) crops to fill. What lives at the edges of this viewBox
    // is the Alaska inset (~x 254-257, y 701-800) and the Hawaii inset
    // (~x 567-634, y 833-876), so cropping silently drops real facilities
    // while the accessible name still counts them.
    it("letterboxes with meet rather than cropping with slice, so the AK and HI insets survive", () => {
      const { svg } = renderPlate();
      const par = svg.getAttribute("preserveAspectRatio") ?? "";
      expect(par).toContain("meet");
      expect(par).not.toContain("slice");
    });

    it("uses the artifact's own viewBox", () => {
      const { svg } = renderPlate();
      expect(svg.getAttribute("viewBox")).toBe(HERO_PLATE.viewBox);
    });

    it("keeps the AK and HI inset marks inside the rendered viewBox", () => {
      // Guards the framing claim above against the artifact drifting: if the
      // insets ever moved outside the viewBox, `meet` would not save them.
      const [, , w, h] = HERO_PLATE.viewBox.split(/\s+/).map(Number);
      const allMarks = STATUS_ORDER.map((s) => HERO_PLATE.paths[s]).join("");
      const coords = Array.from(allMarks.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g));
      expect(coords.length).toBeGreaterThan(0);
      for (const [, x, y] of coords) {
        expect(Number(x)).toBeGreaterThanOrEqual(0);
        expect(Number(x)).toBeLessThanOrEqual(w);
        expect(Number(y)).toBeGreaterThanOrEqual(0);
        expect(Number(y)).toBeLessThanOrEqual(h);
      }
    });
  });

  describe("accessible name", () => {
    it("exposes the plate as an image with a name", () => {
      renderPlate();
      expect(screen.getByRole("img")).toBeInTheDocument();
    });

    // Asserts the PHRASE, never the bare numeral. `toContain("1,920")` would
    // be satisfied by any longer figure that happens to start with it, and a
    // bare `toContain(String(omitted))` — "9" — was satisfied by the "1,929"
    // elsewhere in the old name, so deleting the whole clause left it green.
    it("denominates in facilities it actually draws, never the mark count", () => {
      renderPlate();
      const name = screen.getByRole("img").getAttribute("aria-label") ?? "";

      expect(name).toContain(`${expectedCovered} tracked sites`);

      // `plotted` is a count of drawn MARKS — same-status co-located
      // facilities collapse onto one — so captioning it as facilities
      // under-reports the dataset. The artifact's own doc comment forbids it.
      expect(name).not.toContain(markCount);
      expect(HERO_PLATE.plotted).toBeLessThan(
        HERO_PLATE.total - HERO_PLATE.omitted
      );
    });

    it("claims only what it draws — not the full dataset total", () => {
      // Precondition: with nothing omitted the two figures coincide and this
      // assertion could not fail, so state it rather than assume it.
      expect(HERO_PLATE.omitted).toBeGreaterThan(0);

      renderPlate();
      const name = screen.getByRole("img").getAttribute("aria-label") ?? "";

      expect(name).not.toContain(expectedTotal);
    });

    // An image's accessible name is announced in FULL, and this one sits
    // immediately ahead of the page's H1 — the name it replaced ran 36 words
    // of projection caveat before a screen-reader user reached the heading.
    it("stays short enough to precede the H1", () => {
      renderPlate();
      const name = screen.getByRole("img").getAttribute("aria-label") ?? "";

      expect(name.trim().split(/\s+/)).not.toHaveLength(0);
      expect(name.trim().split(/\s+/).length).toBeLessThanOrEqual(12);
    });
  });

  describe("omitted jurisdictions", () => {
    // The plate no longer names these (see the ⚠️ on ACCESSIBLE_NAME): the
    // disclosure moved to the always-present provenance rule, which renders
    // the literal phrase "in U.S. territories". Nothing else checks that the
    // claim is TRUE of the data, so this does — a wave that omitted a
    // non-territory jurisdiction would make that visible text false.
    it("omits only real US territories, the claim hero-provenance.tsx renders", () => {
      expect(HERO_PLATE.omitted).toBeGreaterThan(0);
      expect(HERO_PLATE.omittedJurisdictions.length).toBeGreaterThan(0);

      for (const code of HERO_PLATE.omittedJurisdictions) {
        expect(isTerritoryCode(code)).toBe(true);
        expect(stateNameFromCode(code)).toBeDefined();
      }
    });
  });

  describe("styling hooks", () => {
    it("merges a caller className with its own base classes", () => {
      const { container } = render(<HeroPlate className="absolute inset-0" />);
      const svg = container.querySelector("svg") as SVGSVGElement;
      expect(svg).toHaveClass("absolute", "inset-0", "h-full", "w-full");
    });

    // Framing, legend and caption belong to the next unit — the plate is a
    // full-bleed hero backdrop here.
    it("does not draw its own neatline frame", () => {
      const { container } = renderPlate();
      expect(container.querySelector(".neatline")).toBeNull();
    });
  });
});
