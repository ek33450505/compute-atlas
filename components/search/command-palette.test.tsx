import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./command-palette";
import { getAllFacilities } from "@/lib/data";
import { buildSearchIndex } from "@/lib/search-index";
import type { SearchEntry } from "@/lib/search";
import type { Facility } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// jsdom does not implement scrollIntoView — the active-option-scroll effect
// calls it on every arrow-key move, so stub it locally (scoped to this file,
// same rationale as the global matchMedia stub in vitest.setup.ts).
Element.prototype.scrollIntoView = vi.fn();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
] as const;

let knownFacility: Facility;
let searchIndex: SearchEntry[];

beforeAll(async () => {
  const all = await getAllFacilities();
  // Deliberately NOT `all[0]`: that is an arbitrary pick that silently changes
  // whenever the dataset changes, and the tests below look up an option by a
  // regex built from this facility's name. The palette renders facility AND
  // operator groups from one query, so a facility whose name equals its
  // operator produces two matching options and `findByRole` throws "found
  // multiple elements" — which is exactly what happened on 2026-08-15 when a
  // data wave moved "1623 Farnam" (operator: "1623 Farnam") into position 0.
  // Pick a facility whose name is unambiguous: different from its operator,
  // and not a substring of any other facility's name.
  const nameIsUnique = (f: Facility) =>
    all.filter((g) => g.name.toLowerCase().includes(f.name.toLowerCase())).length === 1;
  const picked = all.find((f) => f.name !== f.operator && nameIsUnique(f));
  // Fail loudly rather than falling back to `all[0]`: a silent fallback would
  // reintroduce exactly the ambiguity this selection exists to avoid, and the
  // resulting failure would point at the assertion instead of the fixture.
  if (!picked) {
    throw new Error(
      "command-palette.test: no facility has a name that both differs from its operator and is unique across the dataset — the fixture assumptions no longer hold"
    );
  }
  knownFacility = picked;
  searchIndex = await buildSearchIndex();
});

/**
 * Facility names are DATA, not patterns — 268 of the ~1023 eligible names
 * contain regex metacharacters (parentheses, dots, slashes). Interpolating one
 * straight into `new RegExp()` silently changes what is matched: "Foo (Bar)"
 * would build /Foo (Bar)/i, which matches "Foo Bar" and NOT the literal name.
 * Escape before matching so the assertion means what it says regardless of
 * which facility the selection above lands on.
 */
const nameMatcher = (name: string) =>
  new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommandPalette — trigger", () => {
  it("renders a trigger button with an accessible search name", () => {
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);
    expect(
      screen.getByRole("button", { name: /search/i })
    ).toBeInTheDocument();
  });
});

describe("CommandPalette — open + search", () => {
  it("clicking the trigger opens the dialog and shows the search combobox", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("typing a known facility name surfaces an option linking to it, and Enter navigates", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    const combobox = await screen.findByRole("combobox");

    await user.type(combobox, knownFacility.name);

    const option = await screen.findByRole("option", {
      name: nameMatcher(knownFacility.name),
    });
    expect(option).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(pushMock).toHaveBeenCalledWith(`/facilities/${knownFacility.id}`);
  });

  it("clicking a result option navigates to its href", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    const combobox = await screen.findByRole("combobox");
    await user.type(combobox, knownFacility.name);

    const option = await screen.findByRole("option", {
      name: nameMatcher(knownFacility.name),
    });
    await user.click(option);

    expect(pushMock).toHaveBeenCalledWith(`/facilities/${knownFacility.id}`);
  });
});

describe("CommandPalette — global shortcut", () => {
  it("Ctrl+K opens the palette", async () => {
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("Cmd+K (metaKey) opens the palette", async () => {
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });
});

// The homepage hero's search affordance (components/home/hero-search.tsx)
// dispatches this event instead of sharing state — the hero and the palette
// live in different subtrees. hero-search.test.tsx covers the dispatch side;
// these cover the receiving side, so the contract is tested at both ends
// rather than only where it is emitted.
describe("CommandPalette — compute-atlas:open-search event", () => {
  it("opens the palette when the hero dispatches the open-search event", async () => {
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    fireEvent(window, new CustomEvent("compute-atlas:open-search"));

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("opens with a cleared query rather than resuming an abandoned search", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    // Open via ⌘K, type, then dismiss with Escape — which does NOT clear the
    // query on its own.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByRole("combobox");
    await user.type(input, "solar");
    expect(input).toHaveValue("solar");
    await user.keyboard("{Escape}");

    // Reopening from the hero must present a blank search, not "solar".
    fireEvent(window, new CustomEvent("compute-atlas:open-search"));

    expect(await screen.findByRole("combobox")).toHaveValue("");
  });
});

describe("CommandPalette — empty-query quick nav", () => {
  it("shows only the Pages group before typing, no data results", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("combobox");

    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /map/i })).toBeInTheDocument();
    expect(screen.queryByText("Facilities")).not.toBeInTheDocument();
    expect(screen.queryByText("Operators")).not.toBeInTheDocument();
    expect(screen.queryByText("States")).not.toBeInTheDocument();
  });
});

describe("CommandPalette — keyboard navigation", () => {
  it("ArrowDown advances aria-activedescendant, Enter navigates to the active option", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    const combobox = await screen.findByRole("combobox");

    // "Google" reliably surfaces multiple facility results plus the
    // Google operator entry, so there's a next option to advance to.
    await user.type(combobox, "Google");
    await screen.findAllByRole("option");

    const firstActiveId = combobox.getAttribute("aria-activedescendant");
    expect(firstActiveId).toBeTruthy();

    await user.keyboard("{ArrowDown}");

    const secondActiveId = combobox.getAttribute("aria-activedescendant");
    expect(secondActiveId).toBeTruthy();
    expect(secondActiveId).not.toBe(firstActiveId);

    const activeOptionLabel = document
      .getElementById(secondActiveId!)
      ?.textContent?.trim();
    expect(activeOptionLabel).toBeTruthy();

    await user.keyboard("{Enter}");

    // Assert the specific navigation call rather than a total call count —
    // pushMock is module-scoped and accumulates calls across tests in this
    // file (matches the existing assertion style above).
    expect(pushMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/(facilities|operators)\//)
    );
  });
});

describe("CommandPalette — no results", () => {
  it("shows the no-matches message for a nonsense query", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    const combobox = await screen.findByRole("combobox");

    await user.type(combobox, "zzzzznonexistentquery9999");

    expect(
      await screen.findByText(/no matches for/i)
    ).toBeInTheDocument();
  });
});

describe("CommandPalette — Escape closes", () => {
  it("pressing Escape closes the dialog", async () => {
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("combobox");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("CommandPalette — live DB search", () => {
  const DB_ONLY_FACILITY: Facility = {
    id: "notes-only-match",
    name: "Zzyzx Data Campus",
    operator: "Zzyzx Holdings",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 39.0, lon: -77.0, state: "VA", city: "Ashburn" },
  } as Facility;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges DB results in, matched only via mocked full-text search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ facilities: [DB_ONLY_FACILITY] }),
      }))
    );

    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    const combobox = await screen.findByRole("combobox");

    await user.type(combobox, "backup generator notes");

    expect(
      await screen.findByRole("option", { name: /zzyzx data campus/i })
    ).toBeInTheDocument();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/search?q=backup"),
      expect.anything()
    );
  });

  it("degrades to Fuse-only results when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      })
    );

    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    const combobox = await screen.findByRole("combobox");

    await user.type(combobox, knownFacility.name);

    expect(
      await screen.findByRole("option", {
        name: nameMatcher(knownFacility.name),
      })
    ).toBeInTheDocument();
    expect(screen.queryByText(/no matches for/i)).not.toBeInTheDocument();
  });
});

describe("CommandPalette — reduced motion", () => {
  it("gates the popup and backdrop transitions behind motion-reduce", async () => {
    // Class-contract proxy only: jsdom can't evaluate the
    // `prefers-reduced-motion` media query itself — the cascade/exit-timing
    // is browser-verified separately (the s60 lesson: a passing class
    // assertion can coexist with a defeated media query). The backdrop has
    // no data-slot to query by, so it's located via its `fixed inset-0 z-50`
    // utility classes, which are unique to it (the popup lacks `inset-0`).
    const user = userEvent.setup();
    render(<CommandPalette index={searchIndex} navLinks={NAV_LINKS} />);

    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByRole("combobox");

    const popup = screen.getByRole("dialog");
    const backdrop = document.body.querySelector(".fixed.inset-0.z-50");
    expect(popup).toHaveClass("motion-reduce:transition-none");
    expect(backdrop).toHaveClass("motion-reduce:transition-none");
  });
});
