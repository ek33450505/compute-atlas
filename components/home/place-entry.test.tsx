import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { PlaceEntry } from "./place-entry";
import { STATUS_META, STATUS_ORDER } from "@/lib/status";

describe("PlaceEntry", () => {
  it("is a labelled section headed 'Start from a place'", () => {
    render(<PlaceEntry stateCodes={["TX", "VA"]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Start from a place" })).toBeInTheDocument();
  });

  it("posts the state picker as a plain GET to the redirect route", () => {
    const { container } = render(<PlaceEntry stateCodes={["TX", "VA"]} />);
    const form = container.querySelector("form");
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/states/go");
    const select = screen.getByLabelText("State");
    expect(select).toHaveAttribute("name", "state");
    expect(within(form as HTMLElement).getByRole("button", { name: "Show state" })).toHaveAttribute(
      "type",
      "submit"
    );
  });

  it("lists each tracked jurisdiction by name, sorted, with its code as the value", () => {
    render(<PlaceEntry stateCodes={["VA", "TX", "DC"]} />);
    const options = within(screen.getByLabelText("State")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a state",
      "District of Columbia",
      "Texas",
      "Virginia",
    ]);
    expect(options[2]).toHaveValue("TX");
  });

  it("offers exactly the codes it is given, one option each", () => {
    const codes = ["CA", "TX", "VA", "DC"];
    render(<PlaceEntry stateCodes={codes} />);
    const values = within(screen.getByLabelText("State"))
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"))
      .filter(Boolean);
    expect(values.sort()).toEqual([...codes].sort());
  });

  it("drops codes that are not known jurisdictions", () => {
    render(<PlaceEntry stateCodes={["TX", "ZZ"]} />);
    expect(screen.queryByRole("option", { name: "ZZ" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("State")).getAllByRole("option")).toHaveLength(2);
  });

  it("links to the county and metro indexes", () => {
    render(<PlaceEntry stateCodes={["TX"]} />);
    expect(screen.getByRole("link", { name: "Browse counties" })).toHaveAttribute("href", "/counties");
    expect(screen.getByRole("link", { name: "Browse metro areas" })).toHaveAttribute("href", "/metros");
  });

  it("links every status chip to its status hub", () => {
    render(<PlaceEntry stateCodes={["TX"]} />);
    const nav = screen.getByRole("navigation", { name: "Browse by status" });
    for (const s of STATUS_ORDER) {
      expect(within(nav).getByRole("link", { name: STATUS_META[s].label })).toHaveAttribute(
        "href",
        `/status/${s}`
      );
    }
  });
});
