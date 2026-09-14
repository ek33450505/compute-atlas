import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import {
  StatFootnotes,
  StatLabel,
  assignFootnoteMarkers,
} from "./stat-footnote";

describe("assignFootnoteMarkers", () => {
  it("returns no markers and no footnotes when nothing carries a note", () => {
    const { markerAt, footnotes } = assignFootnoteMarkers([
      { note: undefined },
      {},
    ]);

    expect(footnotes).toEqual([]);
    expect(markerAt(0)).toBeUndefined();
    expect(markerAt(1)).toBeUndefined();
  });

  it("marks only the noted stat, leaving its neighbors unmarked", () => {
    const { markerAt, footnotes } = assignFootnoteMarkers([
      {},
      { note: "Plus the District of Columbia" },
      {},
    ]);

    expect(markerAt(0)).toBeUndefined();
    expect(markerAt(1)).toBe("*");
    expect(markerAt(2)).toBeUndefined();
    expect(footnotes).toEqual([
      { marker: "*", note: "Plus the District of Columbia" },
    ]);
  });

  it("gives each noted stat a distinct marker, in render order", () => {
    const { markerAt, footnotes } = assignFootnoteMarkers([
      { note: "first" },
      {},
      { note: "second" },
      { note: "third" },
    ]);

    expect([markerAt(0), markerAt(2), markerAt(3)]).toEqual(["*", "†", "‡"]);
    expect(footnotes.map((f) => f.note)).toEqual(["first", "second", "third"]);
  });

  it("pairs every footnote with the marker its own caption carries", () => {
    // The defect this rules out is a caption showing "†" while the footnote
    // explaining it prints "*" — which is what happens when the two are
    // derived by separate passes over the stats.
    const stats = [{ note: "a" }, {}, { note: "b" }];
    const { markerAt, footnotes } = assignFootnoteMarkers(stats);

    const capturedMarkers = stats
      .map((_, i) => markerAt(i))
      .filter((m): m is string => Boolean(m));
    expect(capturedMarkers).toEqual(footnotes.map((f) => f.marker));
  });

  it("reuses the last marker past the third rather than dropping one", () => {
    // A repeated glyph is a degraded footnote; a missing one is a caption
    // that silently under-reports, which is what this mechanism exists to
    // prevent. Four noted tiles in one row is a layout problem, not this
    // function's problem.
    const { markerAt, footnotes } = assignFootnoteMarkers([
      { note: "a" },
      { note: "b" },
      { note: "c" },
      { note: "d" },
    ]);

    expect(markerAt(3)).toBe("‡");
    expect(footnotes).toHaveLength(4);
  });

  it('treats an empty-string note as no note, not as a note with no text', () => {
    const { markerAt, footnotes } = assignFootnoteMarkers([{ note: "" }]);

    expect(markerAt(0)).toBeUndefined();
    expect(footnotes).toEqual([]);
  });
});

describe("StatLabel", () => {
  it("renders the label as a bare text node when there is no marker", () => {
    // Not cosmetic: Testing Library matches on an element's DIRECT text
    // nodes, so wrapping the label would break every getByText(label) that
    // locates a stat tile by its caption.
    const { container } = render(
      <span>
        <StatLabel label="States" />
      </span>
    );

    expect(container.firstElementChild?.innerHTML).toBe("States");
    expect(screen.getByText("States")).toBeInTheDocument();
  });

  it("keeps the label findable by its own text once a marker is appended", () => {
    render(
      <span>
        <StatLabel label="States" marker="*" />
      </span>
    );

    expect(screen.getByText("States")).toBeInTheDocument();
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("hides the marker from assistive tech but not the caption", () => {
    render(
      <span data-testid="caption">
        <StatLabel label="States" marker="*" />
      </span>
    );

    const marker = screen.getByText("*");
    expect(marker.tagName).toBe("SUP");
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(
      within(screen.getByTestId("caption")).getByText("States")
    ).not.toHaveAttribute("aria-hidden");
  });
});

describe("StatFootnotes", () => {
  it("renders nothing at all when there are no footnotes", () => {
    const { container } = render(<StatFootnotes footnotes={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("prints each note behind its marker, in order", () => {
    render(
      <StatFootnotes
        footnotes={[
          { marker: "*", note: "Plus the District of Columbia" },
          { marker: "†", note: "Disclosed capacity only" },
        ]}
      />
    );

    expect(
      screen.getByText("Plus the District of Columbia")
    ).toBeInTheDocument();
    expect(screen.getByText("Disclosed capacity only")).toBeInTheDocument();
    expect(screen.getByText("*")).toBeInTheDocument();
    expect(screen.getByText("†")).toBeInTheDocument();
  });

  it("leaves the note text readable while hiding the marker glyph", () => {
    // The marker is typographic glue pointing back at the caption; the note
    // is the content, and a screen reader must get it.
    render(
      <StatFootnotes
        footnotes={[{ marker: "*", note: "Plus the District of Columbia" }]}
      />
    );

    expect(screen.getByText("*")).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByText("Plus the District of Columbia")
    ).not.toHaveAttribute("aria-hidden");
  });

  it("appends the caller's className without dropping its own layout classes", () => {
    const { container } = render(
      <StatFootnotes
        footnotes={[{ marker: "*", note: "note" }]}
        className="-mt-4"
      />
    );

    const line = container.firstElementChild;
    expect(line?.className).toContain("-mt-4");
    // w-full is what makes it wrap onto its own line inside the flex row it
    // is rendered into; losing it silently turns the footnote into a tile.
    expect(line?.className).toContain("w-full");
  });
});
