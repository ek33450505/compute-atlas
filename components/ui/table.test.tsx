import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./table";

describe("Table", () => {
  it("renders a table with header and body rows exposing columnheader/row/cell roles", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Acme DC</TableCell>
            <TableCell>Virginia</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Name" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "State" })
    ).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Acme DC" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Virginia" })).toBeInTheDocument();
    // header row + body row = 2 rows
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("renders a caption with the given text", () => {
    render(
      <Table>
        <TableCaption>A list of facilities</TableCaption>
        <TableBody>
          <TableRow>
            <TableCell>Acme DC</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );

    expect(screen.getByText("A list of facilities")).toBeInTheDocument();
  });

  it("applies data-slot attributes to every composed part", () => {
    const { container } = render(
      <Table>
        <TableCaption>Caption</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Acme DC</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    );

    expect(
      container.querySelector('[data-slot="table-container"]')
    ).toBeInTheDocument();
    expect(container.querySelector('[data-slot="table"]')).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-header"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-body"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-footer"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-row"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-head"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-cell"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="table-caption"]')
    ).toBeInTheDocument();
  });

  it("merges a passed className onto the table element without dropping base classes", () => {
    const { container } = render(<Table className="my-custom-table" />);
    const el = container.querySelector('[data-slot="table"]');
    expect(el).toHaveClass("my-custom-table");
    expect(el).toHaveClass("w-full", "caption-bottom", "text-sm");
  });

  it("merges a passed containerClassName onto the wrapping container", () => {
    const { container } = render(
      <Table containerClassName="my-custom-container" />
    );
    const el = container.querySelector('[data-slot="table-container"]');
    expect(el).toHaveClass("my-custom-container");
    expect(el).toHaveClass("relative", "w-full", "overflow-x-auto");
  });
});
