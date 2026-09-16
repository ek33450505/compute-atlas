import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Facility, Source, StatusEvent } from "@/lib/schema";
import { RecordSpecimen } from "./record-specimen";

// ---------------------------------------------------------------------------
// Fixtures
//
// No shared facility factory exists in the repo yet — each test file defines a
// minimal makeFacility() (see contested-strip.test.tsx, related-facilities.
// test.tsx). This one carries the fields RecordSpecimen reads; `as Facility` is
// a partial mock cast, acceptable for a presentational component test.
// ---------------------------------------------------------------------------

const SOURCES: Source[] = [
  {
    url: "https://www.datacenterdynamics.com/en/news/delta-gigasite/",
    label: "Zeo Energy to supply 280MW for the Delta Gigasite",
    publisher: "Data Center Dynamics",
    retrievedAt: "2026-07-06",
    kind: "press",
  },
  {
    url: "https://business.utah.gov/tax-credits/creekstone-energy-llc/",
    label: "Creekstone Energy commits $17B to Millard County",
    publisher: "Utah Governor's Office of Economic Development",
    retrievedAt: "2026-07-06",
    kind: "subsidy",
  },
  {
    url: "https://www.businesswire.com/news/home/20260310800142/en/",
    label: "Creekstone secures 13,000-acre SITLA solar lease",
    publisher: "BusinessWire",
    retrievedAt: "2026-08-25",
    kind: "press",
  },
  {
    url: "https://www.arcgis.com/home/item.html?id=597555ce",
    label: "HIFLD Electric Retail Service Territories",
    publisher: "Oak Ridge National Laboratory",
    retrievedAt: "2026-07-23",
    kind: "other",
  },
  {
    url: "https://www.solarpowerworldonline.com/2026/03/1-gw-solar-project/",
    label: "1-GW solar project planned for Utah hyperscale data center",
    publisher: "Solar Power World",
    retrievedAt: "2026-08-25",
    kind: "press",
  },
];

const HISTORY: StatusEvent[] = [
  {
    status: "proposed",
    date: "2025-06",
    note: "Creekstone announced the Delta Gigasite.",
  },
  {
    status: "under_construction",
    date: "2025-12",
    note: "Broke ground December 2025 on the Delta site.",
    sourceIndex: 0,
  },
];

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "creekstone-delta-ut",
    name: "Creekstone Energy Delta Gigasite",
    operator: "Creekstone Energy",
    status: "under_construction",
    confidence: "reported",
    facilityType: "data_center",
    location: {
      lat: 39.3527,
      lon: -112.5777,
      city: "Delta",
      county: "Millard",
      state: "UT",
      precision: "exact",
    },
    capacityMw: { planned: 10000 },
    statusHistory: HISTORY,
    sources: SOURCES,
    lastUpdated: "2026-08-25",
    ...overrides,
  } as Facility;
}

describe("RecordSpecimen", () => {
  it("renders the record's name as a link to its facility page", () => {
    render(<RecordSpecimen facility={makeFacility()} count={1929} />);

    const link = screen.getByRole("link", {
      name: "Creekstone Energy Delta Gigasite",
    });
    expect(link).toHaveAttribute("href", "/facilities/creekstone-delta-ut");
  });

  it("renders operator, status, coordinates and capacity", () => {
    render(<RecordSpecimen facility={makeFacility()} count={1929} />);

    expect(screen.getByText("Creekstone Energy")).toBeInTheDocument();
    // "Under construction" also appears inside the timeline's own badge, so
    // assert on presence rather than uniqueness.
    expect(screen.getAllByText("Under construction").length).toBeGreaterThan(0);
    expect(screen.getByText("Delta, UT")).toBeInTheDocument();
    expect(screen.getByText("10,000 MW planned")).toBeInTheDocument();

    const coords = screen.getByLabelText(/^Coordinates:/);
    expect(coords).toHaveTextContent("39.353°N");
    expect(coords).toHaveTextContent("112.578°W");
  });

  it("renders the first three sources as real outbound links", () => {
    render(<RecordSpecimen facility={makeFacility()} count={1929} />);

    const list = screen.getByRole("list", { name: "Cited sources" });
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(3);

    expect(links[0]).toHaveAttribute(
      "href",
      "https://www.datacenterdynamics.com/en/news/delta-gigasite/"
    );
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noreferrer noopener");
    expect(links[0]).toHaveAccessibleName(
      "Zeo Energy to supply 280MW for the Delta Gigasite (opens in new tab)"
    );

    // The 4th and 5th sources are NOT shown — the specimen is a demonstration,
    // not the facility page's full provenance panel.
    expect(
      within(list).queryByText(/HIFLD Electric Retail Service Territories/)
    ).not.toBeInTheDocument();
  });

  it("names the publisher for each shown source", () => {
    render(<RecordSpecimen facility={makeFacility()} count={1929} />);

    const list = screen.getByRole("list", { name: "Cited sources" });
    expect(within(list).getByText("Data Center Dynamics")).toBeInTheDocument();
    expect(within(list).getByText("BusinessWire")).toBeInTheDocument();
  });

  // --- Honesty constraint: retrievedAt is a FETCH date, not a byline --------
  it("labels every source date as a retrieval date, never as a publication date", () => {
    // Deliberately adversarial fixture: a real outlet whose NAME contains
    // "Publishing". The date assertions below are scoped to the element that
    // carries the label rather than the whole container for exactly this
    // reason — a container-wide /publish/i would fail on this correct markup,
    // making the test a property of the fixture's publisher names instead of
    // the component's labelling.
    const realPublisher = makeFacility({
      sources: [{ ...SOURCES[0], publisher: "Delta Valley Publishing" }, ...SOURCES.slice(1)],
    });
    render(<RecordSpecimen facility={realPublisher} count={1929} />);

    const list = screen.getByRole("list", { name: "Cited sources" });
    expect(within(list).getByText("Delta Valley Publishing")).toBeInTheDocument();

    const times = within(list).getAllByText("2026-07-06");
    expect(times.length).toBeGreaterThan(0);

    // Each date sits inside a <time> whose enclosing text says "Retrieved:" —
    // and that element, the one that labels the date, claims nothing else.
    for (const time of times) {
      expect(time.tagName).toBe("TIME");
      expect(time).toHaveAttribute("datetime", "2026-07-06");
      expect(time.parentElement).toHaveTextContent(/Retrieved:/);
      expect(time.parentElement?.textContent).not.toMatch(/publish/i);
    }

    // Kept broad, but in the one form a publisher's name cannot take: no date
    // anywhere in the sources block wears a "Published:"/"Publication:" label.
    expect(list.textContent).not.toMatch(/publi(shed|cation)\s*:/i);
  });

  it("renders the status timeline from statusHistory", () => {
    render(<RecordSpecimen facility={makeFacility()} count={1929} />);

    const timeline = screen.getByRole("list", { name: "Status history" });
    expect(within(timeline).getByText("2025-06")).toBeInTheDocument();
    expect(within(timeline).getByText("2025-12")).toBeInTheDocument();
    expect(within(timeline).getByText("Proposed")).toBeInTheDocument();
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(2);
  });

  it("uses the live count passed in for the caption", () => {
    render(<RecordSpecimen facility={makeFacility()} count={2048} />);

    expect(
      screen.getByText("One of 2,048. Every field traces to a citation.")
    ).toBeInTheDocument();
    // The snapshot figure the copy was written against must not be baked in.
    expect(screen.queryByText(/One of 1,929/)).not.toBeInTheDocument();
  });

  // --- Adversarial ---------------------------------------------------------

  it("renders a facility carrying exactly the minimum: 3 sources, 2 history events", () => {
    const minimal = makeFacility({
      id: "minimal-site",
      name: "Minimal Site",
      sources: SOURCES.slice(0, 3),
      statusHistory: HISTORY,
    });
    render(<RecordSpecimen facility={minimal} count={1929} />);

    expect(
      screen.getByRole("link", { name: "Minimal Site" })
    ).toHaveAttribute("href", "/facilities/minimal-site");
    const list = screen.getByRole("list", { name: "Cited sources" });
    expect(within(list).getAllByRole("link")).toHaveLength(3);
    expect(
      within(screen.getByRole("list", { name: "Status history" })).getAllByRole(
        "listitem"
      )
    ).toHaveLength(2);
  });

  it("renders nothing when there is no specimen, rather than an empty frame", () => {
    const { container } = render(<RecordSpecimen facility={null} count={1929} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("list", { name: "Cited sources" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Every field traces to a citation/)).not.toBeInTheDocument();
  });

  it("renders a source with no publisher without inventing an outlet name", () => {
    const noPublisher = makeFacility({
      sources: [
        {
          url: "https://permits.example.gov/filing/12345",
          label: "Air quality permit 12345",
          retrievedAt: "2026-05-04",
          kind: "permit",
        },
        ...SOURCES.slice(1, 3),
      ],
    });
    render(<RecordSpecimen facility={noPublisher} count={1929} />);

    const list = screen.getByRole("list", { name: "Cited sources" });
    const first = within(list).getAllByRole("listitem")[0];

    expect(
      within(first).getByRole("link", {
        name: "Air quality permit 12345 (opens in new tab)",
      })
    ).toHaveAttribute("href", "https://permits.example.gov/filing/12345");
    // No fabricated outlet from the hostname, and no "undefined" leaking out.
    expect(first).not.toHaveTextContent(/undefined/);
    expect(first).not.toHaveTextContent(/permits\.example\.gov/);
    expect(first).toHaveTextContent(/Retrieved:\s*2026-05-04/);
  });
});
