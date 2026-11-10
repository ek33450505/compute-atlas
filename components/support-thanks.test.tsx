import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const get = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get }),
}));

import { SupportThanks } from "./support-thanks";

describe("SupportThanks", () => {
  beforeEach(() => get.mockReset());

  it("shows a status note on ?thanks=1", () => {
    get.mockReturnValue("1");
    render(<SupportThanks />);
    expect(screen.getByRole("status")).toHaveTextContent(/Thank you/);
    expect(document.body.innerHTML).not.toMatch(/donat|tax-deductible|ko-?fi/i);
  });

  it.each([null, "0", "true", ""])("renders nothing for thanks=%j", (v) => {
    get.mockReturnValue(v);
    const { container } = render(<SupportThanks />);
    expect(container).toBeEmptyDOMElement();
  });
});
