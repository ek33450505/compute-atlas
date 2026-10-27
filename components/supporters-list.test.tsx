import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Supporter } from "@/lib/supporters";
import { SupportersList } from "./supporters-list";

const FIXTURES: readonly Supporter[] = [
  { name: "Ada Person", kind: "individual" },
  { name: "Example University", url: "https://example.edu", kind: "institution" },
];

describe("SupportersList", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<SupportersList supporters={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists institutions before individuals under their own headings", () => {
    render(<SupportersList supporters={FIXTURES} />);
    expect(screen.getByRole("heading", { level: 2, name: "Supporters" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Institutions", "Individuals"]);
  });

  it("omits a subgroup that is empty", () => {
    render(<SupportersList supporters={[FIXTURES[0]]} />);
    expect(screen.queryByRole("heading", { name: "Institutions" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Individuals" })).toBeInTheDocument();
  });

  it("renders an external link with an accessible name when a url is given", () => {
    render(<SupportersList supporters={FIXTURES} />);
    const link = screen.getByRole("link", { name: "Example University (opens in new tab)" });
    expect(link).toHaveAttribute("href", "https://example.edu");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders plain text with no link when there is no url", () => {
    render(<SupportersList supporters={FIXTURES} />);
    expect(screen.getByText("Ada Person")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ada Person/ })).not.toBeInTheDocument();
  });

  it("renders a non-https url as plain text, never a link", () => {
    render(
      <SupportersList
        supporters={[{ name: "Sneaky", url: "javascript:alert(1)", kind: "individual" }]}
      />
    );
    expect(screen.getByText("Sneaky")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
