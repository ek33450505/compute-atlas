import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette, SEARCH_DEBOUNCE_MS } from "./command-palette";
import { buildNavSearchIndex } from "@/lib/search-index";
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

/**
 * The index prop these tests pass is the NAV index — operators and states,
 * no facilities — because that is exactly what `SiteHeader` passes in
 * production (`buildNavSearchIndex`, see components/site-header.tsx). An
 * earlier version of this file built the FULL index instead, so every
 * facility-result assertion passed against a prop shape production no longer
 * produces, and the shipping configuration had zero component-level coverage:
 * nothing here mocked `/api/search` at all. Facilities now reach the palette
 * only through the debounced fetch, so they are asserted through that path.
 */
let navIndex: SearchEntry[];

/** An operator entry from the real nav index whose label is unambiguous. */
let knownOperator: SearchEntry;
/** A state entry from the real nav index whose label is unambiguous. */
let knownState: SearchEntry;

/**
 * The facility fixture is synthetic, not drawn from the dataset: facilities
 * arrive only via the mocked `/api/search` response, so the test controls it
 * outright. That also retires the old data-derived fixture picker — a facility
 * chosen out of `getAllFacilities()` changed underneath these tests whenever a
 * data wave landed (2026-08-15: a wave moved "1623 Farnam", whose name equals
 * its operator, into position 0 and `findByRole` threw "found multiple
 * elements"). "Zzyzx" is chosen to fuzzy-match nothing in the real operator/
 * state index, so any option bearing it can only have come from the fetch.
 */
const DB_FACILITY: Facility = {
  id: "zzyzx-data-campus",
  name: "Zzyzx Data Campus",
  operator: "Zzyzx Holdings",
  status: "operational",
  confidence: "confirmed",
  facilityType: "data_center",
  location: { lat: 39.0, lon: -77.0, state: "VA", city: "Ashburn" },
} as Facility;

beforeAll(async () => {
  navIndex = await buildNavSearchIndex();

  // Pick entries whose label is not a substring of any other entry's label:
  // the assertions below look options up by a regex built from the label, and
  // an unanchored regex would match a longer option too ("Virginia" is a
  // substring of "West Virginia"). Fail loudly rather than falling back to
  // `[0]` — a silent fallback reintroduces exactly that ambiguity, and the
  // failure would then point at an assertion instead of at the fixture.
  const labelIsUnique = (entry: SearchEntry) =>
    navIndex.filter((other) =>
      other.label.toLowerCase().includes(entry.label.toLowerCase())
    ).length === 1;

  const operator = navIndex.find((e) => e.type === "operator" && labelIsUnique(e));
  const state = navIndex.find((e) => e.type === "state" && labelIsUnique(e));
  if (!operator || !state) {
    throw new Error(
      "command-palette.test: no operator and/or state entry has a label unique across the nav index — the fixture assumptions no longer hold"
    );
  }
  knownOperator = operator;
  knownState = state;
});

/**
 * Labels are DATA, not patterns — operator names in this dataset contain regex
 * metacharacters (parentheses, dots, slashes). Interpolating one straight into
 * `new RegExp()` silently changes what is matched: "Foo (Bar)" would build
 * /Foo (Bar)/i, which matches "Foo Bar" and NOT the literal label.
 */
const nameMatcher = (name: string) =>
  new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/**
 * `role="option"` sits on the `<li>`, but the click handler that navigates is
 * on the `<button>` inside it — clicking the `li` bubbles upward and never
 * reaches that handler. The previous version of this file clicked the `li` and
 * still passed, because `pushMock` was module-scoped and never cleared, so it
 * was asserting the PRIOR test's Enter navigation. Clearing the mock per test
 * (see `beforeEach`) exposed that; this resolves the real click target.
 */
const clickTarget = (option: HTMLElement) => within(option).getByRole("button");

// ---------------------------------------------------------------------------
// /api/search harness
// ---------------------------------------------------------------------------

/** Minimal stand-in for the bits of `Response` the palette actually reads. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pushMock.mockClear();
  // Default: /api/search answers with no facilities. Every test that cares
  // overrides this. Without a default, an unmocked `fetch` would attempt a
  // real request to a relative URL under jsdom — noise, and a different code
  // path from the one under test.
  fetchMock = vi.fn(async () => jsonResponse({ facilities: [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * These tests drive the 200 ms debounce (command-palette.tsx) with REAL timers
 * and let `findBy*` poll it out. Fake timers are deliberately avoided:
 * `user-event` schedules its own real `setTimeout` per keystroke, and fighting
 * that is what got misdiagnosed here once before as an "ordering flake". The
 * default `findBy*` timeout (1000 ms) comfortably clears a 200 ms debounce, so
 * no test needs a raised timeout — if one starts to, that is a real regression
 * in the debounce, not a knob to turn.
 */
function renderPalette() {
  return render(<CommandPalette index={navIndex} navLinks={NAV_LINKS} />);
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /search/i }));
  return screen.findByRole("combobox");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommandPalette — trigger", () => {
  it("renders a trigger button with an accessible search name", () => {
    renderPalette();
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });
});

describe("CommandPalette — open", () => {
  it("clicking the trigger opens the dialog and shows the search combobox", async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });
});

describe("CommandPalette — facilities via /api/search", () => {
  it("typing a facility name fetches it and Enter navigates to its facility page", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ facilities: [DB_FACILITY] }));

    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, "Zzyzx");

    // The nav index contains no facilities, so this option can only have come
    // from the debounced /api/search fetch.
    expect(
      await screen.findByRole("option", { name: nameMatcher(DB_FACILITY.name) })
    ).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/search?q=Zzyzx"),
      expect.anything()
    );

    await user.keyboard("{Enter}");

    expect(pushMock).toHaveBeenCalledWith(`/facilities/${DB_FACILITY.id}`);
  });

  it("clicking a fetched facility option navigates to its href", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ facilities: [DB_FACILITY] }));

    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, "Zzyzx");
    const option = await screen.findByRole("option", {
      name: nameMatcher(DB_FACILITY.name),
    });

    await user.click(clickTarget(option));

    expect(pushMock).toHaveBeenCalledWith(`/facilities/${DB_FACILITY.id}`);
  });

  it("sends the debounced query to /api/search encoded", async () => {
    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, "zzyzx campus");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/search?q=zzyzx%20campus",
      expect.anything()
    );
  });
});

describe("CommandPalette — /api/search failure degrades", () => {
  it("keeps operator/state results when /api/search responds non-ok", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, { ok: false, status: 500 }));

    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, knownOperator.label);

    expect(
      await screen.findByRole("option", { name: nameMatcher(knownOperator.label) })
    ).toBeInTheDocument();
    // No error UI, and no "no matches" claim while local results are showing.
    expect(screen.queryByText(/no matches for/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps operator/state results when the /api/search fetch rejects", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network error");
    });

    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, knownState.label);

    expect(
      await screen.findByRole("option", { name: nameMatcher(knownState.label) })
    ).toBeInTheDocument();
    expect(screen.queryByText(/no matches for/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The rejection must not escape as an unhandled error — the palette still
    // responds to input afterwards.
    await user.keyboard("{Enter}");
    expect(pushMock).toHaveBeenCalled();
  });
});

describe("CommandPalette — local nav index", () => {
  // fetch is stubbed to a promise that NEVER settles in these two tests: if an
  // option still renders, it cannot have come from the network, which is a
  // stronger and less timing-dependent claim than asserting fetch was not yet
  // called (the debounce could always fire on a slow machine).
  beforeEach(() => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
  });

  it("resolves an operator from the index with no /api/search response", async () => {
    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, knownOperator.label);

    const option = await screen.findByRole("option", {
      name: nameMatcher(knownOperator.label),
    });
    expect(option).toBeInTheDocument();

    await user.click(clickTarget(option));
    expect(pushMock).toHaveBeenCalledWith(knownOperator.href);
  });

  it("resolves a state from the index with no /api/search response", async () => {
    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, knownState.label);

    const option = await screen.findByRole("option", {
      name: nameMatcher(knownState.label),
    });
    expect(option).toBeInTheDocument();

    await user.click(clickTarget(option));
    expect(pushMock).toHaveBeenCalledWith(knownState.href);
  });
});

describe("CommandPalette — global shortcut", () => {
  it("Ctrl+K opens the palette", async () => {
    renderPalette();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("Cmd+K (metaKey) opens the palette", async () => {
    renderPalette();

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
    renderPalette();

    fireEvent(window, new CustomEvent("compute-atlas:open-search"));

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("opens with a cleared query rather than resuming an abandoned search", async () => {
    const user = userEvent.setup();
    renderPalette();

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
    renderPalette();

    await openPalette(user);

    expect(screen.getByText("Pages")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /map/i })).toBeInTheDocument();
    expect(screen.queryByText("Facilities")).not.toBeInTheDocument();
    expect(screen.queryByText("Operators")).not.toBeInTheDocument();
    expect(screen.queryByText("States")).not.toBeInTheDocument();

    // An empty query must not hit /api/search at all. The palette debounces
    // 200 ms before fetching (command-palette.tsx), so asserting immediately
    // would pass even if an empty query DID schedule a fetch — wait past the
    // debounce (plus margin) so a scheduled call has actually fired by the
    // time this asserts.
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 150));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("CommandPalette — keyboard navigation", () => {
  it("ArrowDown advances aria-activedescendant, Enter navigates to the active option", async () => {
    // A fetched facility plus the local operator entry guarantees at least two
    // options, so there is a next one to advance to.
    fetchMock.mockImplementation(async () => jsonResponse({ facilities: [DB_FACILITY] }));

    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, knownOperator.label);
    // Wait for the fetched facility before moving, so the option list is
    // settled and ArrowDown lands deterministically.
    await screen.findByRole("option", { name: nameMatcher(DB_FACILITY.name) });

    const firstActiveId = combobox.getAttribute("aria-activedescendant");
    expect(firstActiveId).toBeTruthy();

    await user.keyboard("{ArrowDown}");

    const secondActiveId = combobox.getAttribute("aria-activedescendant");
    expect(secondActiveId).toBeTruthy();
    expect(secondActiveId).not.toBe(firstActiveId);

    // `GROUP_ORDER` (lib/search.ts) puts facilities first, so option 0 is the
    // fetched facility and option 1 — the one ArrowDown just moved to — is the
    // operator entry. Assert that identity explicitly: a pattern loose enough
    // to admit both options would pass even if Enter ignored
    // aria-activedescendant and always took option 0, which is the exact
    // regression this test is named for.
    const activeOptionLabel = document.getElementById(secondActiveId!)?.textContent?.trim();
    expect(activeOptionLabel).toContain(knownOperator.label);

    await user.keyboard("{Enter}");

    expect(pushMock).toHaveBeenLastCalledWith(knownOperator.href);
    expect(pushMock).not.toHaveBeenCalledWith(`/facilities/${DB_FACILITY.id}`);
  });
});

describe("CommandPalette — no results", () => {
  it("shows the no-matches message for a nonsense query", async () => {
    const user = userEvent.setup();
    renderPalette();
    const combobox = await openPalette(user);

    await user.type(combobox, "zzzzznonexistentquery9999");

    expect(await screen.findByText(/no matches for/i)).toBeInTheDocument();
  });
});

describe("CommandPalette — Escape closes", () => {
  it("pressing Escape closes the dialog", async () => {
    const user = userEvent.setup();
    renderPalette();

    await openPalette(user);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
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
    renderPalette();

    await openPalette(user);

    const popup = screen.getByRole("dialog");
    const backdrop = document.body.querySelector(".fixed.inset-0.z-50");
    expect(popup).toHaveClass("motion-reduce:transition-none");
    expect(backdrop).toHaveClass("motion-reduce:transition-none");
  });
});
