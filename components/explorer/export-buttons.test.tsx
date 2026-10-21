import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportButtons } from "./export-buttons";
import type { Facility } from "@/lib/schema";
import { toTableRow } from "@/lib/facility-slim";

function makeSource() {
  return {
    url: "https://example.com",
    label: "Example Source",
    retrievedAt: "2024-01-01",
    kind: "press" as const,
  };
}

const fullFacility: Facility = {
  id: "alpha-facility",
  name: "Alpha Center",
  operator: "AlphaCorp",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
  capacityMw: { operational: 150 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-01-01",
};

const facility = toTableRow(fullFacility);
const SNAPSHOT = { asOf: "2026-10-20T12:00:00Z" };
const SNAPSHOT_URL = "/data/facilities.json?v=2026-10-20T12%3A00%3A00Z";

describe("ExportButtons", () => {
  // jsdom implements neither; install mocks and put back whatever was there.
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let blobs: Blob[];

  beforeEach(() => {
    blobs = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return "blob:mock-url";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("renders both download buttons with accessible labels", () => {
    render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
    expect(screen.getByRole("button", { name: "Download 1 facility as CSV" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download 1 facility as JSON (snapshot as of October 20, 2026)" })
    ).toBeInTheDocument();
  });

  it("pluralizes the labels", () => {
    render(<ExportButtons facilities={[facility, facility]} snapshot={SNAPSHOT} />);
    expect(screen.getByRole("button", { name: "Download 2 facilities as CSV" })).toBeInTheDocument();
  });

  it("wraps the buttons in a labeled group", () => {
    render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
    expect(screen.getByRole("group", { name: "Export facilities" })).toBeInTheDocument();
  });

  it("marks both buttons aria-disabled and inert when facilities is empty, keeping focus", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportButtons facilities={[]} snapshot={SNAPSHOT} />);
    const csv = screen.getByRole("button", { name: /as CSV/ });
    const json = screen.getByRole("button", { name: /as JSON/ });
    expect(csv).toHaveAttribute("aria-disabled", "true");
    expect(json).toHaveAttribute("aria-disabled", "true");
    json.focus();
    await user.click(csv);
    await user.click(json);
    expect(json).toHaveFocus();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves both buttons enabled when facilities is non-empty", () => {
    render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
    expect(screen.getByRole("button", { name: /as CSV/ })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: /as JSON/ })).not.toHaveAttribute("aria-disabled");
  });

  it("triggers a blob download when the CSV button is clicked and revokes the URL later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
    await user.click(screen.getByRole("button", { name: /as CSV/ }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    // Not synchronously: Safari aborts a download whose URL is revoked right after click().
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  describe("JSON export (static snapshot)", () => {
    const second: Facility = { ...fullFacility, id: "beta-facility", name: "Beta Center", notes: "full-only" };
    const third: Facility = { ...fullFacility, id: "gamma-facility", name: "Gamma Center" };

    function mockFetch(impl: () => Promise<Partial<Response>>) {
      const fn = vi.fn(impl);
      vi.stubGlobal("fetch", fn);
      return fn;
    }

    it("has its live region in the DOM before any click, then fills it", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [fullFacility] }));
      const { container } = render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      const region = container.querySelector('[aria-live="polite"]');
      expect(region).not.toBeNull();
      expect(region).toBeEmptyDOMElement();
      // Reserves one line and is never hidden, so filling it shifts nothing above.
      expect(region).toHaveClass("min-h-4");
      expect(region).not.toHaveClass("sr-only");
      expect(region).not.toHaveClass("hidden");
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      await waitFor(() => expect(region).toHaveTextContent(/^Downloaded 1 facility as JSON/));
      expect(region).not.toHaveClass("sr-only");
    });

    it("fetches the versioned snapshot and exports full records in the table's order", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch(async () => ({
        ok: true,
        json: async () => [fullFacility, second, third],
      }));
      // Table order differs from snapshot order.
      render(<ExportButtons facilities={[toTableRow(third), toTableRow(fullFacility)]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith(SNAPSHOT_URL, expect.objectContaining({ signal: expect.anything() }));
      const exported = JSON.parse(await blobs[0].text());
      expect(exported.map((f: Facility) => f.id)).toEqual(["gamma-facility", "alpha-facility"]);
      expect(exported[1]).toEqual(fullFacility);
      expect(
        screen.getByText(
          "Downloaded 2 facilities as JSON from the snapshot as of October 20, 2026. Values edited since then may differ from the table."
        )
      ).toBeInTheDocument();
    });

    it("says 'the deployed snapshot' and omits the cache key when asOf is unknown", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch(async () => ({ ok: true, json: async () => [fullFacility] }));
      render(<ExportButtons facilities={[facility]} snapshot={{ asOf: "unknown" }} />);
      expect(
        screen.getByRole("button", { name: "Download 1 facility as JSON (deployed snapshot)" })
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText(/^Downloaded 1 facility as JSON from the deployed snapshot\. Values edited since/)
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/data/facilities.json", expect.anything());
    });

    it("downloads nothing and says so when the fetch fails, leaving the button usable", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: false, status: 503 }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      const button = screen.getByRole("button", { name: /as JSON/ });
      await user.click(button);
      expect(await screen.findByText(/Could not download the JSON snapshot/)).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(button).not.toHaveAttribute("aria-disabled");
      expect(button).toBeEnabled();
    });

    it("downloads nothing on a network error", async () => {
      const user = userEvent.setup();
      mockFetch(async () => {
        throw new TypeError("network down");
      });
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(await screen.findByText(/Could not download the JSON snapshot/)).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("treats a non-array body as a failure", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => ({ error: "x" }) }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(await screen.findByText(/Could not download the JSON snapshot/)).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("ignores malformed snapshot elements and exports only the valid record", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({
        ok: true,
        json: async () => [null, 5, { name: "no id" }, { id: 7 }, fullFacility],
      }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
      const exported = JSON.parse(await blobs[0].text());
      expect(exported.map((f: Facility) => f.id)).toEqual(["alpha-facility"]);
    });

    it("exports what it can and announces rows newer than the snapshot", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [fullFacility] }));
      render(<ExportButtons facilities={[facility, toTableRow(second)]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText(/1 of 2 facilities isn't in the downloadable snapshot \(it may have been added since the last deploy\) and was left out/)
      ).toBeInTheDocument();
      const exported = JSON.parse(await blobs[0].text());
      expect(exported.map((f: Facility) => f.id)).toEqual(["alpha-facility"]);
    });

    it("downloads nothing when every row is newer than the snapshot", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [second] }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText("That facility isn't in the downloadable snapshot yet, so nothing was downloaded.")
      ).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("uses plural wording when several rows are all newer than the snapshot", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [] }));
      render(<ExportButtons facilities={[facility, toTableRow(second)]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText("None of the 2 facilities are in the downloadable snapshot yet, so nothing was downloaded.")
      ).toBeInTheDocument();
    });

    it("uses plural wording when several rows are newer than the snapshot", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [fullFacility] }));
      render(
        <ExportButtons facilities={[facility, toTableRow(second), toTableRow(third)]} snapshot={SNAPSHOT} />
      );
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText(/2 of 3 facilities aren't in the downloadable snapshot \(they may have been added since the last deploy\) and were left out/)
      ).toBeInTheDocument();
    });

    it("says so neutrally when unreadable snapshot entries are among the missing", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [null, fullFacility] }));
      render(<ExportButtons facilities={[facility, toTableRow(second)]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      const message = await screen.findByText(/no readable entry in the downloadable snapshot/);
      expect(message).toHaveTextContent(
        "1 of 2 facilities has no readable entry in the downloadable snapshot, which also had 1 unreadable entry, and was left out."
      );
      expect(message).not.toHaveTextContent("newer");
    });

    it("uses plural wording when several rows have no readable entry", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [null, undefined, fullFacility] }));
      render(
        <ExportButtons facilities={[facility, toTableRow(second), toTableRow(third)]} snapshot={SNAPSHOT} />
      );
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText(
          /2 of 3 facilities have no readable entry in the downloadable snapshot, which also had 2 unreadable entries, and were left out\./
        )
      ).toBeInTheDocument();
    });

    it("explains a no-download caused by unreadable entries", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [null, 3] }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(
        await screen.findByText(
          "Nothing was downloaded: the downloadable snapshot had 2 unreadable entries and has no readable entry for that facility."
        )
      ).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("clears the message when the rows change, but not when they are re-rendered unchanged", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [fullFacility, second] }));
      const rows = [facility, toTableRow(second)];
      const { rerender } = render(<ExportButtons facilities={rows} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      expect(await screen.findByText(/^Downloaded 2 facilities/)).toBeInTheDocument();
      rerender(<ExportButtons facilities={[...rows]} snapshot={SNAPSHOT} />);
      expect(screen.getByText(/^Downloaded 2 facilities/)).toBeInTheDocument();
      rerender(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      expect(screen.queryByText(/^Downloaded/)).not.toBeInTheDocument();
    });

    it("abandons an in-flight export when the rows change", async () => {
      const user = userEvent.setup();
      let resolve!: (r: Partial<Response>) => void;
      mockFetch(() => new Promise((r) => (resolve = r)));
      const { rerender } = render(<ExportButtons facilities={[facility, toTableRow(second)]} snapshot={SNAPSHOT} />);
      const button = screen.getByRole("button", { name: /as JSON/ });
      await user.click(button);
      rerender(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await act(async () => {
        resolve({ ok: true, json: async () => [fullFacility, second] });
      });
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(screen.queryByText(/^Downloaded|Preparing/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /as JSON/ })).not.toHaveAttribute("aria-disabled");
    });

    it("keeps JSON pending until the latest export settles when exports overlap", async () => {
      const user = userEvent.setup();
      const resolvers: Array<(r: Partial<Response>) => void> = [];
      const fetchMock = vi.fn(() => new Promise<Partial<Response>>((r) => resolvers.push(r)));
      vi.stubGlobal("fetch", fetchMock);
      const { rerender } = render(
        <ExportButtons facilities={[facility, toTableRow(second)]} snapshot={SNAPSHOT} />
      );
      await user.click(screen.getByRole("button", { name: /as JSON/ })); // export A
      rerender(<ExportButtons facilities={[toTableRow(second)]} snapshot={SNAPSHOT} />);
      const button = screen.getByRole("button", { name: /as JSON/ });
      await user.click(button); // export B
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(button).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        resolvers[0]({ ok: true, json: async () => [fullFacility, second] }); // A settles late
      });
      // A must neither download, clear the flag, nor announce.
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(button).toHaveAttribute("aria-disabled", "true");
      await user.click(button);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Preparing JSON export…")).toBeInTheDocument();

      await act(async () => {
        resolvers[1]({ ok: true, json: async () => [fullFacility, second] });
      });
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
      expect(JSON.parse(await blobs[0].text()).map((f: Facility) => f.id)).toEqual(["beta-facility"]);
      await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    });

    it("succeeds on a second click after a failed fetch", async () => {
      const user = userEvent.setup();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, json: async () => [fullFacility] });
      vi.stubGlobal("fetch", fetchMock);
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      const button = screen.getByRole("button", { name: /as JSON/ });
      await user.click(button);
      expect(await screen.findByText(/Could not download/)).toBeInTheDocument();
      await user.click(button);
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps focus on the JSON button from pending through done", async () => {
      const user = userEvent.setup();
      mockFetch(async () => ({ ok: true, json: async () => [fullFacility] }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      const button = screen.getByRole("button", { name: /as JSON/ });
      await user.click(button);
      await screen.findByText(/^Downloaded 1 facility/);
      await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
      expect(button).toHaveFocus();
    });

    it("announces Preparing and ignores clicks, Enter and Space while pending, without losing focus", async () => {
      const user = userEvent.setup();
      let resolve!: (r: Partial<Response>) => void;
      const fetchMock = mockFetch(() => new Promise((r) => (resolve = r)));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      const button = screen.getByRole("button", { name: /as JSON/ });
      await user.click(button);
      expect(screen.getByText("Preparing JSON export…")).toBeInTheDocument();
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveFocus();
      await user.click(button);
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      resolve({ ok: true, json: async () => [fullFacility] });
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    });

    it("starts an export on Enter and on Space when idle", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch(async () => ({ ok: true, json: async () => [fullFacility] }));
      render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      screen.getByRole("button", { name: /as JSON/ }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
      await user.keyboard(" ");
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it("downloads nothing if unmounted while the fetch is pending", async () => {
      const user = userEvent.setup();
      let resolve!: (r: Partial<Response>) => void;
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return new Promise((r) => (resolve = r));
        })
      );
      const { unmount } = render(<ExportButtons facilities={[facility]} snapshot={SNAPSHOT} />);
      await user.click(screen.getByRole("button", { name: /as JSON/ }));
      unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        resolve({ ok: true, json: async () => [fullFacility] });
      });
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
  });
});
