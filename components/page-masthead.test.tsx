import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageMasthead } from "./page-masthead";

describe("PageMasthead", () => {
  it("renders the eyebrow, heading, and dek in that document order", () => {
    const { container } = render(
      <PageMasthead eyebrow="Eyebrow text" title="Heading text" dek="Dek text" />
    );

    const header = container.firstElementChild;
    expect(header?.tagName).toBe("HEADER");

    const [eyebrowEl, headingEl, dekEl, ruleEl] = Array.from(header?.children ?? []);
    expect(eyebrowEl.textContent).toBe("Eyebrow text");
    expect(headingEl.tagName).toBe("H1");
    expect(headingEl.textContent).toBe("Heading text");
    expect(dekEl.tagName).toBe("P");
    expect(dekEl.textContent).toBe("Dek text");
    expect(ruleEl.tagName).toBe("DIV");
  });

  it("exposes the title as the page's h1", () => {
    render(<PageMasthead eyebrow="Eyebrow" title="Page Title" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Page Title" })
    ).toBeInTheDocument();
  });

  it("renders no dek paragraph when dek is omitted (not an empty one)", () => {
    const { container } = render(<PageMasthead eyebrow="Eyebrow" title="Title" />);
    const header = container.firstElementChild!;

    // eyebrow <p>, <h1>, rule <div> — no dek <p> in between.
    expect(header.children).toHaveLength(3);
    const paragraphs = header.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent).toBe("Eyebrow");
  });

  it("renders children after the dek and before the closing rule", () => {
    const { container } = render(
      <PageMasthead eyebrow="Eyebrow" title="Title" dek="Dek">
        <button type="button">Extra action</button>
      </PageMasthead>
    );

    const header = container.firstElementChild!;
    const children = Array.from(header.children);
    expect(children).toHaveLength(5);

    const [, , dekEl, childEl, ruleEl] = children;
    expect(dekEl.tagName).toBe("P");
    expect(childEl.tagName).toBe("BUTTON");
    expect(ruleEl.tagName).toBe("DIV");
    expect(screen.getByRole("button", { name: "Extra action" })).toBeInTheDocument();
  });

  it("renders the closing rule as the header's last element", () => {
    const { container } = render(<PageMasthead eyebrow="Eyebrow" title="Title" />);
    const header = container.firstElementChild!;
    const rule = header.lastElementChild;
    expect(rule?.tagName).toBe("DIV");
    expect(rule?.className).toContain("border-t");
  });

  it("accepts non-string ReactNode for eyebrow, title, and dek", () => {
    render(
      <PageMasthead
        eyebrow={<span>Rich eyebrow</span>}
        title={
          <>
            Rich <em>title</em>
          </>
        }
        dek={
          <>
            Rich dek with <strong>emphasis</strong>
          </>
        }
      />
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Rich title");
    expect(screen.getByText("Rich eyebrow")).toBeInTheDocument();
    expect(screen.getByText(/Rich dek with/)).toBeInTheDocument();
  });
});
