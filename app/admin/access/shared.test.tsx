import { describe, it, expect } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import { DateText, ResultRegion, useResultReporter } from "./shared";

function Harness() {
  const { state, report, headingRef } = useResultReporter();
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        List
      </h2>
      <div data-testid="row">
        <button onClick={() => report({ tone: "success", text: "Same text." }, rowEl())}>report</button>
      </div>
      <textarea aria-label="other note" />
      <ResultRegion result={state.result} seq={state.seq} />
    </>
  );
}

const rowEl = () => document.querySelector('[data-testid="row"]');

describe("ResultRegion", () => {
  it("keeps a polite status region and an assertive alert region mounted, both empty, with no result", () => {
    render(<ResultRegion result={null} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("puts a success in the status region only", () => {
    render(<ResultRegion result={{ tone: "success", text: "Approved." }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Done. Approved.");
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("puts a neutral info in the status region with no prefix", () => {
    render(<ResultRegion result={{ tone: "info", text: "Already running." }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Already running.");
    expect(status).not.toHaveTextContent(/Done\.|Not delivered\.|Error\./);
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("puts undelivered mail in the alert region with a text marker", () => {
    render(<ResultRegion result={{ tone: "warning", text: "No link sent." }} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Not delivered.")).toBeInTheDocument();
    expect(alert).toHaveTextContent("No link sent.");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("puts an error in the alert region with a text marker", () => {
    render(<ResultRegion result={{ tone: "error", text: "Boom." }} />);
    expect(within(screen.getByRole("alert")).getByText("Error.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("moves the message between regions without remounting them", () => {
    const { rerender } = render(<ResultRegion result={{ tone: "success", text: "Ok." }} />);
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    rerender(<ResultRegion result={{ tone: "error", text: "Bad." }} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(status).toBeEmptyDOMElement();
    expect(alert).toHaveTextContent("Bad.");
  });
});

describe("ResultRegion: focus target and re-announcement", () => {
  it("is not a focus target or a named group: the live regions carry the announcement", () => {
    render(<ResultRegion result={null} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Action results")).not.toBeInTheDocument();
    expect(screen.getByRole("status").parentElement).not.toHaveAttribute("tabindex");
  });

  it("replaces the message node when an identical result arrives with a new sequence number", () => {
    const result = { tone: "success", text: "Approved." } as const;
    const { rerender } = render(<ResultRegion result={result} seq={1} />);
    const first = screen.getByText("Approved.", { exact: false }).closest("p");
    rerender(<ResultRegion result={{ ...result }} seq={2} />);
    const second = screen.getByText("Approved.", { exact: false }).closest("p");
    expect(second).not.toBe(first);
    expect(first).not.toBeInTheDocument();
  });

  it("keeps the same message node when the sequence number is unchanged", () => {
    const result = { tone: "success", text: "Approved." } as const;
    const { rerender } = render(<ResultRegion result={result} seq={1} />);
    const first = screen.getByText("Approved.", { exact: false }).closest("p");
    rerender(<ResultRegion result={result} seq={1} />);
    expect(screen.getByText("Approved.", { exact: false }).closest("p")).toBe(first);
  });
});

describe("useResultReporter", () => {
  it("shows the result and moves focus to the heading when focus is inside the acting row", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "report" });
    button.focus();
    act(() => button.click());
    expect(screen.getByRole("status")).toHaveTextContent("Same text.");
    expect(screen.getByRole("heading", { name: "List" })).toHaveFocus();
  });

  it("moves focus to the heading when focus is lost to <body>", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "report" });
    act(() => button.click());
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.body).toHaveFocus();
    act(() => button.click());
    expect(screen.getByRole("heading", { name: "List" })).toHaveFocus();
  });

  it("leaves focus alone when the admin is elsewhere", () => {
    render(<Harness />);
    const other = screen.getByRole("textbox", { name: "other note" });
    other.focus();
    act(() => screen.getByRole("button", { name: "report" }).click());
    expect(screen.getByRole("status")).toHaveTextContent("Same text.");
    expect(other).toHaveFocus();
  });

  it("re-announces an identical result by replacing the message node", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "report" });
    act(() => button.click());
    const first = screen.getByText("Same text.", { exact: false }).closest("p");
    act(() => button.click());
    expect(screen.getByText("Same text.", { exact: false }).closest("p")).not.toBe(first);
  });
});

describe("DateText", () => {
  it("renders the UTC calendar date regardless of the local zone", () => {
    render(<DateText value={new Date("2026-11-01T23:30:00Z")} />);
    expect(screen.getByText("Nov 1, 2026")).toHaveAttribute("datetime", "2026-11-01T23:30:00.000Z");
  });
});
