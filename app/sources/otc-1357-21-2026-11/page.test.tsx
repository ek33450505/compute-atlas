import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import { OTC_1357_PROVENANCE } from "@/lib/sources/otc-1357-21-2026-11";

import Page, { metadata } from "./page";

describe("OTC 1357(21) source page", () => {
  it("sets the canonical", () => {
    expect(metadata.alternates?.canonical).toBe("/sources/otc-1357-21-2026-11");
  });

  it("renders a captioned table per list with the right row counts", () => {
    render(<Page />);
    const t50 = screen.getByRole("table", { name: /Active Computer Services \(50%\) Exemptions/ });
    const t80 = screen.getByRole("table", { name: /Active Computer Services \(80%\) Exemptions/ });
    expect(within(t50).getAllByRole("rowheader")).toHaveLength(2);
    expect(within(t80).getAllByRole("rowheader")).toHaveLength(22);
    expect(within(t80).getAllByRole("columnheader")).toHaveLength(4);
  });

  it("gives each row the load-bearing anchor id", () => {
    const { container } = render(<Page />);
    for (const id of ["50-row-1", "50-row-2", "80-row-1", "80-row-2", "80-row-6", "80-row-8", "80-row-22"]) {
      expect(container.querySelector(`tr[id="${id}"]`), id).not.toBeNull();
    }
  });

  it("exposes each table in a focusable scroll region", () => {
    render(<Page />);
    for (const name of ["50% report table", "80% report table"]) {
      const region = screen.getByRole("region", { name });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(region).toHaveAccessibleDescription(/scrolls horizontally/);
    }
  });

  it("links both files and shows their SHA-256", () => {
    render(<Page />);
    for (const f of OTC_1357_PROVENANCE.files) {
      const link = screen.getByRole("link", { name: new RegExp(`Download the ${f.list}% report`) });
      expect(link).toHaveAttribute("href", f.filePath);
      expect(screen.getByText(f.sha256)).toBeInTheDocument();
    }
  });

  it("renders a blank entity name as a dash named by the DBA, DBA column untouched", () => {
    const { container } = render(<Page />);
    const row = container.querySelector('tr[id="80-row-1"]')!;
    const header = row.querySelector("th")!;
    expect(header).toHaveTextContent("SANDY BEACHES SOFTWARE (entity name blank on report)");
    expect(within(header).getByRole("link")).toHaveAccessibleName(
      "SANDY BEACHES SOFTWARE (entity name blank on report)",
    );
    expect(header.querySelector('[aria-hidden="true"]')).toHaveTextContent("\u2014");
    expect(within(row as HTMLElement).getByText("SANDY BEACHES SOFTWARE")).toBeInTheDocument();
  });

  it("links an entity name to its own row anchor", () => {
    render(<Page />);
    const link = screen.getByRole("link", { name: "CEREBRAS SYSTEMS INC." });
    expect(link).toHaveAttribute("href", "#80-row-6");
  });

  it("joins the wrapped name in 80% row 20 and notes the wrap", () => {
    render(<Page />);
    expect(screen.getByRole("link", { name: "THE CONSTANT COMPANY HS 3" })).toHaveAttribute(
      "href",
      "#80-row-20",
    );
    expect(screen.getByText(/wraps as/)).toBeInTheDocument();
  });

  it("links the Quality Jobs page externally", () => {
    render(<Page />);
    const link = screen.getByRole("link", {
      name: "oktap.tax.ok.gov/OkTAP/Web?link=QLTYJOBSREBATE (opens in a new tab)",
    });
    expect(link).toHaveAttribute("href", "https://oktap.tax.ok.gov/OkTAP/Web?link=QLTYJOBSREBATE");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("has a single h1", () => {
    render(<Page />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("marks both PDF links as downloads", () => {
    render(<Page />);
    for (const f of OTC_1357_PROVENANCE.files) {
      const link = screen.getByRole("link", { name: new RegExp(`Download the ${f.list}% report`) });
      expect(link).toHaveAttribute("download");
    }
  });

  it("keeps the spaces after interpolations in the server-rendered markup", () => {
    // Raw SSR markup, not a client render. renderToString emits the <!-- -->
    // text separators between adjacent text and interpolations;
    // renderToStaticMarkup omits them, so it could not test the regex below.
    const html = renderToString(<Page />);
    const text = html.replace(/<!-- -->/g, "");
    expect(text).toContain("Request submitted 2026-11-06 to the Oklahoma Tax Commission");
    expect(text).toContain("2026-11-06 from the Oklahoma Tax Commission");
    expect(text).toContain("68 O.S. § 1357(21), as named in the request");
    expect(html).not.toMatch(/\d<!-- -->[A-Za-z]/);
  });
});
