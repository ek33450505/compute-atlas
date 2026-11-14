import { describe, expect, it } from "vitest";

import { looksLikeAddress, normalizeName } from "./tceq-names";

describe("normalizeName", () => {
  it("applies NFKC and collapses whitespace", () => {
    expect(normalizeName("  ＡＢＣ   １２３ \n DATA  CENTER ")).toBe("ABC 123 DATA CENTER");
  });
});

describe("looksLikeAddress", () => {
  it.each([
    "１２３ EXAMPLE DATA CENTER",
    "5911 EXAMPLE CIRCLE DATA CENTER",
    "SOUTH 1234 BITCOIN",
    "BUILDING 100 DATA CENTER",
    "FM 1234 DATA CENTER",
    "F.M. 12 DATA CENTER",
    "FARM TO MARKET 12 DATA CENTER",
    "HWY 79 DATA CENTER",
    "IH-35 DATA CENTER",
    "LOOP 289 DATA CENTER",
    "INTERSTATE 20 CRYPTO",
    "EXAMPLE PKWY DATA CENTER",
    "DATA CENTER SUITE B",
    "DATA CENTER STE 4",
    "EXAMPLE COVE DATA CENTER",
    "EXAMPLE TERRACE DATA CENTER",
    "EXAMPLE PLACE DATA CENTER",
    "DATA CENTER MILE 4",
    "PO BOX DATA CENTER",
    "POBOX DATA CENTER",
    "EXAMPLE HOME DATA CENTER",
    "EXAMPLE LN DATA CENTER",
  ])("withholds %s", (name) => {
    expect(looksLikeAddress(name)).toBe(true);
  });

  it.each(["PHASE 2 DATA CENTER", "DFW10 DATA CENTER", "MILAM DATA CENTER BUILDING 1", "ABILENE DATA CENTER BUILDINGS 9 & 10"])(
    "shows %s",
    (name) => {
      expect(looksLikeAddress(name)).toBe(false);
    },
  );
});
