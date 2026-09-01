import { vi, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetDatasetEdition } = vi.hoisted(() => ({
  mockGetDatasetEdition: vi.fn(),
}));

vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: mockGetDatasetEdition,
}));

import ApiPage from "./page";

describe("ApiPage — How to cite", () => {
  it("renders the snapshot citation in APA-7 dataset form: version in parens before [Data set], no retrieval date", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "1.30.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 1309,
      schemaVersion: 1,
    });

    render(<ApiPage />);

    const snapshotHeading = screen.getByText("Citing a reproducible snapshot");
    const snapshotBlock = snapshotHeading.nextElementSibling;
    expect(snapshotBlock).not.toBeNull();
    const snapshotText = snapshotBlock!.textContent ?? "";

    expect(snapshotText).toBe(
      "Kubiak, E. (2026). Compute Atlas (Version 1.30.0) [Data set]. " +
        "https://raw.githubusercontent.com/ek33450505/compute-atlas/v1.30.0/data/facilities.json"
    );

    // The pinned bulk URL carries the version tag, never "main" — the whole
    // point of the snapshot citation is that it can't silently drift.
    expect(snapshotText).not.toContain(
      "raw.githubusercontent.com/ek33450505/compute-atlas/main/"
    );
  });

  // Regression: an earlier draft of this citation carried "Retrieved <date>,
  // from <url>" on the snapshot the same way the live citation does. That
  // blurs the exact distinction the section exists to teach — a tag-pinned
  // snapshot is immutable and so takes no retrieval date. This must fail if
  // that phrasing creeps back in.
  it("never carries a retrieval date on the immutable snapshot citation", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "1.30.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 1309,
      schemaVersion: 1,
    });

    render(<ApiPage />);

    const snapshotHeading = screen.getByText("Citing a reproducible snapshot");
    const snapshotText = snapshotHeading.nextElementSibling?.textContent ?? "";
    expect(snapshotText).not.toMatch(/Retrieved/i);
  });

  it("shows the asOf date as prose near the snapshot block, not inside the citation string", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "1.30.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 1309,
      schemaVersion: 1,
    });

    render(<ApiPage />);

    const snapshotHeading = screen.getByText("Citing a reproducible snapshot");
    const citationBlock = snapshotHeading.nextElementSibling;
    const asOfProse = citationBlock?.nextElementSibling;
    expect(asOfProse).not.toBeNull();
    expect(asOfProse!.textContent).toContain("Version 1.30.0 was cut on September 1, 2026");
    // The date lives in the prose sibling, not the citation string itself.
    expect(citationBlock!.textContent).not.toContain("September 1, 2026");
  });

  it("renders the live-site citation with an access-date placeholder, not a fixed date", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "1.30.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 1309,
      schemaVersion: 1,
    });

    render(<ApiPage />);

    const liveHeading = screen.getByText("Citing the live site or API");
    const liveBlock = liveHeading.nextElementSibling;
    expect(liveBlock).not.toBeNull();
    const liveText = liveBlock!.textContent ?? "";

    expect(liveText).toContain("[access date]");
    expect(liveText).toContain("https://www.compute-atlas.com");
    // Never carries the edition's asOf date — that would misrepresent the
    // live site as having a fixed publication date.
    expect(liveText).not.toContain("September 1, 2026");
  });

  it("points the Bulk access section's main-branch link at main, distinct from the pinned citation URL", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "1.30.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 1309,
      schemaVersion: 1,
    });

    render(<ApiPage />);

    const bulkLink = screen.getByRole("link", {
      name: /full facilities dataset as json on github/i,
    });
    expect(bulkLink).toHaveAttribute(
      "href",
      "https://raw.githubusercontent.com/ek33450505/compute-atlas/main/data/facilities.json"
    );
  });

  it("degrades to a readable fallback instead of throwing when the edition is unavailable", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "unknown",
      asOf: "unknown",
      recordCount: 0,
      schemaVersion: 0,
    });

    render(<ApiPage />);

    const snapshotHeading = screen.getByText("Citing a reproducible snapshot");
    const citationBlock = snapshotHeading.nextElementSibling;
    expect(citationBlock?.textContent).toContain("(n.d.)");

    const asOfProse = citationBlock?.nextElementSibling;
    expect(asOfProse?.textContent).toContain("date unavailable");
  });

  it("surfaces the real edition version in the masthead eyebrow, not a hardcoded year", () => {
    mockGetDatasetEdition.mockReturnValue({
      version: "1.30.0",
      asOf: "2026-09-01T16:58:23.496Z",
      recordCount: 1309,
      schemaVersion: 1,
    });

    render(<ApiPage />);

    expect(screen.getByText("API reference · Edition v1.30.0")).toBeInTheDocument();
  });
});
