import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { OpenRecord } from "./open-record";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/activity/activity-list.test.tsx; OpenRecord
// uses next/link directly).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

describe("OpenRecord", () => {
  it("renders the formatted sources-cited count", () => {
    render(<OpenRecord sources={2570} />);
    expect(screen.getByText("2,570")).toBeInTheDocument();
  });

  it("renders all four provenance fact labels and values", () => {
    render(<OpenRecord sources={100} />);
    expect(screen.getByText("Sources cited")).toBeInTheDocument();
    expect(screen.getByText("Moderation")).toBeInTheDocument();
    expect(screen.getByText("Human-gated")).toBeInTheDocument();
    expect(screen.getByText("License")).toBeInTheDocument();
    expect(screen.getByText("CC BY 4.0")).toBeInTheDocument();
    expect(screen.getByText("Citation")).toBeInTheDocument();
    expect(screen.getByText("Cite any record")).toBeInTheDocument();
  });

  it("links the contribute CTA to /contribute", () => {
    render(<OpenRecord sources={100} />);
    expect(
      screen.getByRole("link", { name: /Add a facility/i })
    ).toHaveAttribute("href", "/contribute");
  });

  it("names the contribute CTA exactly, with the arrow hidden from assistive tech", () => {
    render(<OpenRecord sources={100} />);

    // Exact name, not /Add a facility/i: the label this replaced was
    // "Add a facility · Correct a figure →" — 35 uppercase wide-tracked
    // characters, which overflowed the CTA on a 390px phone. The loose regex
    // above passes either way, so only an exact-name assertion makes a future
    // re-lengthening visible here rather than on a device.
    expect(
      screen.getByRole("link", { name: "Add a facility" })
    ).toBeInTheDocument();
    // The glyph is still on screen; it is just not in the accessible name —
    // otherwise the link announces as "Add a facility right arrow", the same
    // reason app/page.tsx's hero CTAs aria-hide their ArrowRight.
    expect(screen.getByText("→")).toHaveAttribute("aria-hidden", "true");
  });

  it("lets the contribute CTA grow instead of overflowing, keeping the 44px target", () => {
    render(<OpenRecord sources={100} />);

    const cta = screen.getByRole("link", { name: "Add a facility" });
    // jsdom computes no layout, so the class is the only observable here — the
    // same reason app/page.test.tsx pins the hero sourcing link's classes.
    // `h-11` is a fixed height: a label too wide for the box overflows it
    // rather than wrapping, which is what Ed saw on an iPhone. `min-h-11`
    // keeps the 44px floor while letting the box grow at 200% zoom, at a
    // larger user font size, or in a longer translation.
    expect(cta).toHaveClass("min-h-11");
    expect(cta).not.toHaveClass("h-11");
  });

  it("links the Cite and RSS feed access facts", () => {
    render(<OpenRecord sources={100} />);
    expect(screen.getByRole("link", { name: "Cite" })).toHaveAttribute(
      "href",
      "/data"
    );
    expect(screen.queryByRole("link", { name: "API" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "RSS feed" })).toHaveAttribute(
      "href",
      "/activity/feed.xml"
    );
  });

  it("does not repeat the recent-activity stream; renders facts and CTA", () => {
    render(<OpenRecord sources={100} />);
    expect(
      screen.queryByRole("heading", { name: "Recently updated" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /View all/i })).not.toBeInTheDocument();
    expect(screen.getByText("Sources cited")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add a facility/i })
    ).toBeInTheDocument();
  });

  // Same guard as lens-gateway.test.tsx and survey-ledger.test.tsx. A <section>
  // is only exposed as an accessible "region" when it HAS a name, so querying
  // by role+name proves the section's aria-labelledby actually resolves to the
  // h2's id — not merely that both strings exist somewhere. SectionHeading
  // deliberately leaves that pairing to the caller (see its `id` doc comment),
  // which is exactly the contract that can break silently: move the id onto the
  // wrapper div and every other assertion in this file stays green while the
  // landmark goes unnamed.
  it("renders as a labeled region and passes through className", () => {
    render(
      <OpenRecord sources={100} className="mt-12 pt-10" />
    );

    const section = screen.getByRole("region", { name: "A living record" });
    expect(section).toHaveClass("mt-12", "pt-10");
    expect(
      screen.getByRole("heading", { level: 2, name: "A living record" })
    ).toBeInTheDocument();
  });

  it("omits the dataset-access link by default", () => {
    render(<OpenRecord sources={100} />);
    expect(screen.getByText("Free to reuse with attribution. Code under MIT.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Request dataset access" })).toBeNull();
  });

  it("adds the dataset-access link when sharing is on", () => {
    render(<OpenRecord sources={100} datasetAccess />);
    expect(screen.getByRole("link", { name: "Request dataset access" })).toHaveAttribute(
      "href",
      "/dataset"
    );
    expect(screen.getByText(/Free to reuse with attribution\. Code under MIT\./)).toBeInTheDocument();
  });
});
