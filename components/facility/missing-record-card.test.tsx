import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MissingRecordCard } from "./missing-record-card";

const props = { facilityId: "f1", facilityName: "Test DC" };

describe("MissingRecordCard", () => {
  it("renders nothing when nothing is missing", () => {
    const { container } = render(<MissingRecordCard {...props} items={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders an h2, the intro line and one list item per missing thing", () => {
    render(
      <MissingRecordCard
        {...props}
        items={[{ field: "poweredBy", label: "who powers it" }, { label: "air permit" }]}
      />
    );

    expect(screen.getByRole("heading", { level: 2, name: "What this record is missing" })).toBeInTheDocument();
    expect(screen.getByText("No public source yet for:")).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "who powers it",
      "air permit",
    ]);
  });

  it("has exactly one 'Send a source' action, tall enough to tap, and is screen-only", () => {
    const { container } = render(<MissingRecordCard {...props} items={[{ label: "air permit" }, { label: "jobs" }]} />);

    const button = screen.getByRole("button", { name: /send a source/i });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(button).toHaveClass("min-h-11", "focus-visible:outline-2");
    expect(container.textContent).not.toContain("Send us a link");
    expect(container.firstElementChild).toHaveClass("print:hidden", "bg-card", "border-border");
  });

  it("opens the dialog pre-selected on the first correctable missing field", async () => {
    const user = userEvent.setup();
    render(
      <MissingRecordCard
        {...props}
        items={[{ label: "air permit" }, { field: "poweredBy", label: "who powers it" }]}
      />
    );

    await user.click(screen.getByRole("button", { name: /send a source/i }));

    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toHaveTextContent("Powered by");
  });

  it("falls back to 'Something else' with the first item as the topic when no field is correctable", async () => {
    const user = userEvent.setup();
    render(<MissingRecordCard {...props} items={[{ label: "air permit" }]} />);

    await user.click(screen.getByRole("button", { name: /send a source/i }));

    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toHaveTextContent("Something else");
    expect(screen.getByLabelText(/what should we know/i)).toHaveAttribute(
      "placeholder",
      "e.g. air permit, and where you saw it"
    );
  });
});
