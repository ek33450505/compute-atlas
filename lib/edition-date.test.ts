import { describe, expect, it } from "vitest";

import { formatEditionDate } from "./edition-date";

describe("formatEditionDate", () => {
  it("formats edition dates and passes junk through", () => {
    expect(formatEditionDate("2026-11-10")).toBe("10 November 2026");
    expect(formatEditionDate("2026-01-05")).toBe("5 January 2026");
    expect(formatEditionDate("soon")).toBe("soon");
  });
});
