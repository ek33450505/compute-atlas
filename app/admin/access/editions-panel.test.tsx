import { vi, describe, it, expect, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AdminDatasetEdition } from "@/lib/dataset-admin";

const { mockRefresh, mockBuild } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockBuild: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/app/admin/access/actions", () => ({
  buildEditionNowAction: mockBuild,
}));

import { EditionsPanel, formatBytes } from "./editions-panel";

function makeEdition(overrides: Partial<AdminDatasetEdition> = {}): AdminDatasetEdition {
  return {
    id: "e1",
    editionDate: "2026-11-09",
    builtAt: new Date("2026-11-09T13:05:00Z"),
    status: "published",
    recordCount: 3012,
    files: [
      { name: "facilities.csv", bytes: 1_048_576 },
      { name: "README.md", bytes: 1024 },
    ],
    changes: { added: 5, updated: 2, removed: 1 },
    ...overrides,
  };
}

/** A promise the test resolves by hand, to hold the action in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1_048_576, "1.0 MB"],
    [1_572_864, "1.5 MB"],
    [5 * 1024 ** 3, "5.0 GB"],
    [2048 * 1024 ** 3, "2048.0 GB"],
  ])("%d -> %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("EditionsPanel: listing", () => {
  it("renders a labelled table with the rows in the order given, newest first", () => {
    render(
      <EditionsPanel
        editions={[
          makeEdition({ id: "b", editionDate: "2026-11-09" }),
          makeEdition({ id: "a", editionDate: "2026-11-02", recordCount: 2990 }),
        ]}
      />
    );

    expect(screen.getByRole("heading", { level: 2, name: "Editions" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /Most recent editions, newest first/ });
    for (const name of ["Edition date", "Status", "Built at", "Records", "Files", "Changes"]) {
      expect(within(table).getByRole("columnheader", { name })).toHaveAttribute("scope", "col");
    }
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("2026-11-09");
    expect(rows[1]).toHaveTextContent("2026-11-02");
  });

  it("shows status as text, record count, file count with total size, and change counts", () => {
    render(<EditionsPanel editions={[makeEdition()]} />);

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("published")).toBeInTheDocument();
    expect(within(row).getByText("3012")).toBeInTheDocument();
    expect(within(row).getByText("2 files, 1.0 MB")).toBeInTheDocument();
    expect(within(row).getByText("5 added, 2 updated, 1 removed")).toBeInTheDocument();
    const time = within(row).getByText("2026-11-09 13:05 UTC");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", "2026-11-09T13:05:00.000Z");
  });

  it("copes with a failed edition that has no records, files or changelog", () => {
    render(
      <EditionsPanel
        editions={[makeEdition({ status: "failed", recordCount: null, files: [], changes: null })]}
      />
    );

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("failed")).toBeInTheDocument();
    expect(within(row).getByText("None")).toBeInTheDocument();
    expect(within(row).getAllByText("—")).toHaveLength(2);
  });

  it("uses the singular for a single file", () => {
    render(<EditionsPanel editions={[makeEdition({ files: [{ name: "a.csv", bytes: 500 }] })]} />);

    expect(screen.getByText("1 file, 500 B")).toBeInTheDocument();
  });

  it("says so when there are no editions, and still offers Build now", () => {
    render(<EditionsPanel editions={[]} />);

    expect(screen.getByText("No editions yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Build now" })).toBeInTheDocument();
  });

  it("never renders a storage path, hash or edition id, even if a row carried one", () => {
    const leaky = {
      ...makeEdition({ id: "edition-uuid-1234" }),
      files: [{ name: "facilities.csv", bytes: 10, pathname: "private/secret-path", sha256: "f".repeat(64) }],
    };
    const { container } = render(<EditionsPanel editions={[leaky]} />);

    expect(container.textContent).not.toContain("private/secret-path");
    expect(container.textContent).not.toContain("f".repeat(64));
    expect(container.textContent).not.toContain("edition-uuid-1234");
  });
});

describe("EditionsPanel: Build now", () => {
  it("builds once, refreshes, and ignores a second activation while pending", async () => {
    const user = userEvent.setup();
    const build = deferred<unknown>();
    mockBuild.mockReturnValue(build.promise);
    render(<EditionsPanel editions={[]} />);
    const button = screen.getByRole("button", { name: "Build now" });
    const panel = screen.getByRole("region", { name: "Editions" });
    const controls = button.parentElement as HTMLElement;

    await user.click(button);

    expect(mockBuild).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toBeDisabled();
    expect(controls).toHaveAttribute("aria-busy", "true");
    expect(panel).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Building… this can take a few minutes.")).toBeInTheDocument();

    await user.click(button);
    await user.keyboard("{Enter}");
    expect(mockBuild).toHaveBeenCalledTimes(1);

    await act(async () => {
      build.resolve({ ok: true, outcome: "published", editionDate: "2026-11-09", recordCount: 3012 });
    });

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(controls).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText(/this can take a few minutes/)).toBeNull();
  });

  it("announces the build start at once, keeps focus on the button, then replaces it with the outcome", async () => {
    const user = userEvent.setup();
    const build = deferred<unknown>();
    mockBuild.mockReturnValue(build.promise);
    render(<EditionsPanel editions={[]} />);
    const button = screen.getByRole("button", { name: "Build now" });

    await user.click(button);

    const status = screen.getByRole("status");
    expect(within(status).getByText("Build started. This can take a few minutes.")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).queryByText(/./)).toBeNull();
    expect(button).toHaveFocus();

    await act(async () => {
      build.resolve({ ok: true, outcome: "published", editionDate: "2026-11-09", recordCount: 3012 });
    });

    await waitFor(() => expect(within(status).getByText(/Published edition 2026-11-09/)).toBeInTheDocument());
    expect(within(status).queryByText(/Build started/)).toBeNull();
    expect(button).toHaveFocus();
  });

  it("does not repeat the start announcement for an ignored second activation", async () => {
    const user = userEvent.setup();
    const build = deferred<unknown>();
    mockBuild.mockReturnValue(build.promise);
    render(<EditionsPanel editions={[]} />);
    const button = screen.getByRole("button", { name: "Build now" });
    await user.click(button);
    const first = within(screen.getByRole("status")).getByText(/Build started/);

    await user.click(button);

    expect(within(screen.getByRole("status")).getByText(/Build started/)).toBe(first);

    // Settle the build: a transition left pending would stay entangled with the next test's.
    await act(async () => {
      build.resolve({ ok: true, outcome: "alreadyPublished", editionDate: "2026-11-09" });
    });
  });

  it("right-aligns the numeric columns", () => {
    render(<EditionsPanel editions={[makeEdition()]} />);

    const table = screen.getByRole("table");
    for (const name of ["Records", "Files", "Changes"]) {
      expect(within(table).getByRole("columnheader", { name })).toHaveClass("text-right", "tabular-nums");
    }
    const row = screen.getAllByRole("row")[1];
    for (const text of ["3012", "2 files, 1.0 MB", "5 added, 2 updated, 1 removed"]) {
      expect(within(row).getByText(text)).toHaveClass("text-right", "tabular-nums");
    }
  });

  it("announces a published build in the status region", async () => {
    const user = userEvent.setup();
    mockBuild.mockResolvedValue({ ok: true, outcome: "published", editionDate: "2026-11-09", recordCount: 3012 });
    render(<EditionsPanel editions={[]} />);

    await user.click(screen.getByRole("button", { name: "Build now" }));

    const status = await screen.findByRole("status");
    expect(within(status).getByText(/Published edition 2026-11-09: 3012 records\./)).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).queryByText(/./)).toBeNull();
  });

  it("announces an already-published day in the status region", async () => {
    const user = userEvent.setup();
    mockBuild.mockResolvedValue({ ok: true, outcome: "alreadyPublished", editionDate: "2026-11-09" });
    render(<EditionsPanel editions={[]} />);

    await user.click(screen.getByRole("button", { name: "Build now" }));

    const status = await screen.findByRole("status");
    expect(within(status).getByText(/Today's edition \(2026-11-09\) is already published\./)).toBeInTheDocument();
    expect(status).not.toHaveTextContent(/Done\.|Not delivered\.|Error\./);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("announces a build already running in the status region", async () => {
    const user = userEvent.setup();
    mockBuild.mockResolvedValue({ ok: true, outcome: "inProgress", editionDate: "2026-11-09" });
    render(<EditionsPanel editions={[]} />);

    await user.click(screen.getByRole("button", { name: "Build now" }));

    const status = await screen.findByRole("status");
    expect(
      within(status).getByText(/A build for 2026-11-09 is running or was just retried\. Try again in a few minutes\./),
    ).toBeInTheDocument();
    expect(status).not.toHaveTextContent(/Done\.|Not delivered\.|Error\./);
    expect(within(screen.getByRole("alert")).queryByText(/./)).toBeNull();
  });

  it("announces a failed build with its code in the alert region", async () => {
    const user = userEvent.setup();
    mockBuild.mockResolvedValue({ ok: false, error: "The edition build failed.", code: "below_floor" });
    render(<EditionsPanel editions={[]} />);

    await user.click(screen.getByRole("button", { name: "Build now" }));

    const alert = await screen.findByText(/Build failed \(below_floor\)\./);
    expect(screen.getByRole("alert")).toContainElement(alert);
    expect(within(screen.getByRole("status")).queryByText(/./)).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("never reads an ok result carrying the failed outcome as a success", async () => {
    const user = userEvent.setup();
    mockBuild.mockResolvedValue({ ok: true, outcome: "failed", editionDate: "2026-11-09" });
    render(<EditionsPanel editions={[]} />);

    await user.click(screen.getByRole("button", { name: "Build now" }));

    const alert = await screen.findByText(/Build failed \(unknown\)\./);
    expect(screen.getByRole("alert")).toContainElement(alert);
  });

  it("reports a rejected action as an error, refreshes, and unlocks the button", async () => {
    const user = userEvent.setup();
    mockBuild.mockRejectedValue(new Error("Unauthorized"));
    render(<EditionsPanel editions={[]} />);
    const button = screen.getByRole("button", { name: "Build now" });

    await user.click(button);

    const alert = await screen.findByText(/The request failed\. Reload before retrying\./);
    expect(screen.getByRole("alert")).toContainElement(alert);
    expect(screen.queryByText(/Unauthorized/)).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("leaves focus on the Build now button after a result: it is still there", async () => {
    const user = userEvent.setup();
    mockBuild.mockResolvedValue({ ok: true, outcome: "alreadyPublished", editionDate: "2026-11-09" });
    render(<EditionsPanel editions={[]} />);
    const button = screen.getByRole("button", { name: "Build now" });

    await user.click(button);
    await screen.findByRole("status");

    expect(button).toHaveFocus();
  });

  it("moves focus to the Editions heading when focus was lost while the build ran", async () => {
    const user = userEvent.setup();
    const build = deferred<unknown>();
    mockBuild.mockReturnValue(build.promise);
    render(<EditionsPanel editions={[]} />);
    await user.click(screen.getByRole("button", { name: "Build now" }));
    act(() => (document.activeElement as HTMLElement).blur());

    await act(async () => {
      build.resolve({ ok: true, outcome: "alreadyPublished", editionDate: "2026-11-09" });
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: "Editions" })).toHaveFocus());
  });
});
