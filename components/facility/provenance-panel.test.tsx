import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProvenancePanel } from "./provenance-panel";
import type { Facility } from "@/lib/schema";

const FACILITY: Facility = {
  id: "test-facility",
  name: "Test Facility",
  operator: "Test Operator",
  status: "operational",
  aiClassification: "confirmed",
  confidence: "reported",
  location: {
    lat: 35.0,
    lon: -90.0,
    city: "Memphis",
    state: "TN",
  },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/article-1",
      label: "Test Article One",
      publisher: "Example Publisher",
      retrievedAt: "2026-01-15",
      kind: "press",
    },
    {
      url: "https://example.com/permit-2",
      label: "Permit Filing Two",
      retrievedAt: "2026-02-20",
      kind: "permit",
    },
  ],
  lastUpdated: "2026-07-01",
};

describe("ProvenancePanel", () => {
  it("renders the section heading", () => {
    render(<ProvenancePanel facility={FACILITY} />);
    expect(
      screen.getByRole("heading", { name: /Sources & data provenance/i })
    ).toBeInTheDocument();
  });

  it("renders the confidence description", () => {
    render(<ProvenancePanel facility={FACILITY} />);
    expect(
      screen.getByText(/Reported: data based on credible news/i)
    ).toBeInTheDocument();
  });

  it("renders the last-updated date", () => {
    render(<ProvenancePanel facility={FACILITY} />);
    expect(screen.getByText(/Last updated:/i)).toBeInTheDocument();
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
  });

  it("renders all sources as external links with new-tab accessible name", () => {
    render(<ProvenancePanel facility={FACILITY} />);
    const link1 = screen.getByRole("link", {
      name: /Test Article One \(opens in new tab\)/i,
    });
    expect(link1).toHaveAttribute("href", "https://example.com/article-1");
    expect(link1).toHaveAttribute("target", "_blank");
    expect(link1).toHaveAttribute("rel", "noreferrer noopener");

    const link2 = screen.getByRole("link", {
      name: /Permit Filing Two \(opens in new tab\)/i,
    });
    expect(link2).toHaveAttribute("href", "https://example.com/permit-2");
    expect(link2).toHaveAttribute("target", "_blank");
    expect(link2).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders the publisher when present", () => {
    render(<ProvenancePanel facility={FACILITY} />);
    expect(screen.getByText("Example Publisher")).toBeInTheDocument();
  });

  it("renders the retrievedAt date for each source", () => {
    render(<ProvenancePanel facility={FACILITY} />);
    expect(screen.getByText("2026-01-15")).toBeInTheDocument();
    expect(screen.getByText("2026-02-20")).toBeInTheDocument();
  });

  it("renders the confidence description for rumored", () => {
    const rumoredFacility: Facility = { ...FACILITY, confidence: "rumored" };
    render(<ProvenancePanel facility={rumoredFacility} />);
    expect(
      screen.getByText(/Rumored: data is unconfirmed/i)
    ).toBeInTheDocument();
  });

  it("renders the confidence description for confirmed", () => {
    const confirmedFacility: Facility = {
      ...FACILITY,
      confidence: "confirmed",
    };
    render(<ProvenancePanel facility={confirmedFacility} />);
    expect(
      screen.getByText(/Confirmed: data verified against official/i)
    ).toBeInTheDocument();
  });
});
