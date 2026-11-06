import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TablePagination, pageWindow } from "./table-pagination";

describe("pageWindow", () => {
  it("shows first, last and neighbours with gaps", () => {
    expect(pageWindow(10, 25)).toEqual([1, null, 9, 10, 11, null, 25]);
  });
  it("has no gap when pages are adjacent", () => {
    expect(pageWindow(2, 4)).toEqual([1, 2, 3, 4]);
  });
});

describe("TablePagination", () => {
  it("renders nothing for a single page", () => {
    const { container } = render(<TablePagination page={1} pageCount={1} query="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a labelled nav of real links that keep the other params", () => {
    render(<TablePagination page={3} pageCount={9} query="status=operational&sort=name&page=3" />);
    const nav = screen.getByRole("navigation", { name: "Table pagination" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "/table?status=operational&sort=name&page=4"
    );
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/table?status=operational&sort=name&page=2"
    );
  });

  it("links page 1 without a page param", () => {
    render(<TablePagination page={2} pageCount={5} query="page=2" />);
    expect(screen.getByRole("link", { name: "Page 1" })).toHaveAttribute("href", "/table");
  });

  it("marks the current page with aria-current", () => {
    render(<TablePagination page={3} pageCount={9} query="" />);
    expect(screen.getByRole("link", { name: "Page 3" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Page 4" })).not.toHaveAttribute("aria-current");
  });

  it("keeps disabled ends as aria-disabled links that do not navigate", () => {
    const { rerender } = render(<TablePagination page={1} pageCount={4} query="" />);
    const prev = screen.getByRole("link", { name: "Previous" });
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(fireEvent.click(prev)).toBe(false); // default prevented
    expect(screen.getByRole("link", { name: "Next" })).not.toHaveAttribute("aria-disabled");
    rerender(<TablePagination page={4} pageCount={4} query="" />);
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps focus on Next when it becomes the disabled last-page control", () => {
    const { rerender } = render(<TablePagination page={3} pageCount={4} query="" />);
    const next = screen.getByRole("link", { name: "Next" });
    next.focus();
    rerender(<TablePagination page={4} pageCount={4} query="" />);
    expect(screen.getByRole("link", { name: "Next" })).toBe(next);
    expect(next).toHaveFocus();
  });
});
