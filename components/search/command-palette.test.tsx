import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./command-palette";
import { getAllFacilities } from "@/lib/data";
import { buildSearchIndex } from "@/lib/search";
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
  knownFacility = (await getAllFacilities())[0];
  searchIndex = await buildSearchIndex();
});

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
      name: new RegExp(knownFacility.name, "i"),
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
      name: new RegExp(knownFacility.name, "i"),
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
        name: new RegExp(knownFacility.name, "i"),
      })
    ).toBeInTheDocument();
    expect(screen.queryByText(/no matches for/i)).not.toBeInTheDocument();
  });
});
