import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { DCTE_PROVENANCE } from "@/lib/sources/odod-dcte-2026-11";

import Page, { metadata } from "./page";

describe("ODOD DCTE source page", () => {
  it("sets the canonical", () => {
    expect(metadata.alternates?.canonical).toBe("/sources/odod-dcte-2026-11");
  });

  it("renders a captioned table with a header row and 21 data rows", () => {
    render(<Page />);
    const table = screen.getByRole("table", { name: /approved data center sales and use tax exemptions/i });
    expect(within(table).getAllByRole("row")).toHaveLength(22);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(21);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(13);
  });

  it("gives each row a stable anchor id", () => {
    const { container } = render(<Page />);
    expect(container.querySelector("tr#row-1")).not.toBeNull();
    expect(container.querySelector("tr#row-21")).not.toBeNull();
  });

  it("exposes the table in a focusable scroll region", () => {
    render(<Page />);
    const region = screen.getByRole("region", { name: "Approved data center tax exemptions table" });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("links the file and shows its SHA-256", () => {
    render(<Page />);
    const link = screen.getByRole("link", { name: "Download the spreadsheet (.xlsx, 21 KB)" });
    expect(link).toHaveAttribute("href", "/sources/odod-dcte-2026-11.xlsx");
    expect(screen.getByText(DCTE_PROVENANCE.sha256)).toBeInTheDocument();
  });

  it("labels the award as the sheet's estimate", () => {
    render(<Page />);
    expect(
      screen.getByText(/the sheet labels it an estimate/),
    ).toBeInTheDocument();
  });

  it("only mentions 'Do Not Distribute' inside the footer explanation", () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";
    expect(text.match(/Do Not Distribute/g)).toHaveLength(1);
    expect(text).toMatch(
      /Do Not Distribute.{0,12}and a salesforce\.com copyright notice\. The department released the file in response to a public records request\./,
    );
  });

  it("formats money without cents and the rate as a percent", () => {
    render(<Page />);
    const row = screen.getByRole("rowheader", { name: /Ohio River Partners/ }).closest("tr")!;
    expect(within(row).getByText("$6,525,000")).toBeInTheDocument();
    expect(within(row).getByText("75%")).toBeInTheDocument();
  });

  it("links each beneficiary to its own row anchor", () => {
    render(<Page />);
    const first = screen.getByRole("link", { name: "Ohio River Partners Shareholder LLC" });
    expect(first).toHaveAttribute("href", "#row-1");
  });

  it("renders approval dates as <time> elements", () => {
    const { container } = render(<Page />);
    const row = container.querySelector("tr#row-1")!;
    const time = row.querySelector("time")!;
    expect(time).toHaveAttribute("datetime", "2021-08-23");
    expect(time).toHaveTextContent("August 23, 2021");
  });

  it("describes the scroll region with visible hint text", () => {
    render(<Page />);
    const region = screen.getByRole("region", { name: "Approved data center tax exemptions table" });
    expect(region).toHaveAccessibleDescription(/scrolls horizontally/);
  });

  it("states the request scope and submission date", () => {
    render(<Page />);
    expect(screen.getByText(/Request submitted 2026-10-15/)).toBeInTheDocument();
    expect(screen.getByText(/Tax Credit Authority meeting minutes for 2024–2026/)).toBeInTheDocument();
  });

  it("cites the June 24, 2024 minutes with a plain-named link", () => {
    render(<Page />);
    const link = screen.getByRole("link", { name: "June 24, 2024 minutes" });
    expect(link).toHaveAttribute(
      "href",
      "https://dam.assets.ohio.gov/image/upload/development.ohio.gov/about/taxcreditminutes/June_24_2024.pdf",
    );
  });
});
