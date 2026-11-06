/**
 * Rows of the two Oklahoma Tax Commission reports released under the
 * Oklahoma Open Records Act, in PDF order. otc-1357-21-2026-11.test.ts
 * extracts the text of the hosted PDFs (public/sources/otc-1357-21-2026-11-*.pdf)
 * with node:zlib and checks every cell of every row, column by column and
 * token for token in reading order, against it.
 * Empty strings are cells the reports leave blank (the Business Account ID
 * column is blank throughout and is not carried here). Wrapped cells are
 * joined with single spaces.
 */

export interface OtcRow {
  readonly list: "50" | "80";
  readonly anchor: string;
  readonly entityName: string;
  readonly dbaName: string;
  readonly mailingAddress: string;
  readonly locationAddress: string;
}

export const OTC_1357_PROVENANCE = {
  requested: "2026-11-06",
  received: "2026-11-06",
  requestStatute: "51 O.S. \u00a7 24A.1 et seq.",
  statute: "68 O.S. \u00a7 1357(21)",
  files: [
    {
      list: "50",
      filePath: "/sources/otc-1357-21-2026-11-50.pdf",
      sha256: "382149162f5b966d044671d844bf97546f4af7414b5dacb6cafea619b79d6c66",
      byteSize: 84911,
      title: "Active Computer Services (50%) Exemptions",
      generated: "November 6, 2026 2:08 PM",
      totalActiveAccounts: 2,
      receivedFileName: "1357 21 50 percent_Redacted.pdf",
    },
    {
      list: "80",
      filePath: "/sources/otc-1357-21-2026-11-80.pdf",
      sha256: "300675b29f4c0347069d3ccc9db3886e853f7e71ff29cd22bc401ff398070f43",
      byteSize: 88632,
      title: "Active Computer Services (80%) Exemptions",
      generated: "November 6, 2026 2:09 PM",
      totalActiveAccounts: 22,
      receivedFileName: "1357 21 80 percent_Redacted.pdf",
    },
  ],
} as const;

export const OTC_1357_ROWS: readonly OtcRow[] = [
  {
    "list": "50",
    "anchor": "50-row-1",
    "entityName": "",
    "dbaName": "VERITRIS",
    "mailingAddress": "3030 NW EXPRESSWAY # 126 STE 200 OKLAHOMA CITY OK 73112-5466",
    "locationAddress": "2828 NW 57TH ST STE 207 OKLAHOMA CITY OK 73112-7091"
  },
  {
    "list": "50",
    "anchor": "50-row-2",
    "entityName": "",
    "dbaName": "PAYCOM PAYROLL",
    "mailingAddress": "7501 W MEMORIAL RD BLDG A-ACCOUNTING OKLAHOMA CITY OK 731421404",
    "locationAddress": "7501 W MEMORIAL RD OKLAHOMA CITY OK 73142-1404"
  },
  {
    "list": "80",
    "anchor": "80-row-1",
    "entityName": "",
    "dbaName": "SANDY BEACHES SOFTWARE",
    "mailingAddress": "6300 NW EXPRESSWAY STE 130 OKLAHOMA CITY OK 731325128",
    "locationAddress": "5909 NW EXPRESSWAY STE 300 OKLAHOMA CITY OK 73132-5103"
  },
  {
    "list": "80",
    "anchor": "80-row-2",
    "entityName": "",
    "dbaName": "DXC TECHNOLOGY SERVICES",
    "mailingAddress": "3400 N CENTRAL EXPY STE 210 RICHARDSON TX 750801302",
    "locationAddress": "7400 N LAKEWOOD AVE TULSA OK 74117-1308"
  },
  {
    "list": "80",
    "anchor": "80-row-3",
    "entityName": "",
    "dbaName": "DXC TECHNOLOGY SERVICES",
    "mailingAddress": "3400 N CENTRAL EXPY STE 210 RICHARDSON TX 750801302",
    "locationAddress": "4000 N MINGO RD TULSA OK 74116-5020"
  },
  {
    "list": "80",
    "anchor": "80-row-4",
    "entityName": "6000 N SHARTEL AVE, LLC",
    "dbaName": "6000 N SHARTEL AVE, LLC",
    "mailingAddress": "6000 N SHARTEL AVE OKLAHOMA CITY OK 73118-5809",
    "locationAddress": "6000 N SHARTEL AVE OKLAHOMA CITY OK 73118-5809"
  },
  {
    "list": "80",
    "anchor": "80-row-5",
    "entityName": "ATMOSS LLC",
    "dbaName": "ATMOSS LLC",
    "mailingAddress": "103 FOULK RD WILMINGTON DE 19803-3742",
    "locationAddress": "103 FOULK RD WILMINGTON DE 19803-3742"
  },
  {
    "list": "80",
    "anchor": "80-row-6",
    "entityName": "CEREBRAS SYSTEMS INC.",
    "dbaName": "CEREBRAS SYSTEMS INC.",
    "mailingAddress": "512 NW 62ND ST OKLAHOMA CITY OK 73118",
    "locationAddress": "512 NW 62ND ST OKLAHOMA CITY OK 73118"
  },
  {
    "list": "80",
    "anchor": "80-row-7",
    "entityName": "CORE SCIENTIFIC, INC.",
    "dbaName": "CORE SCIENTIFIC, INC.",
    "mailingAddress": "4901 HAROLD SCOGGINS DR MUSKOGEE OK 74403-9231",
    "locationAddress": "4901 HAROLD SCOGGINS DR MUSKOGEE OK 74403-9231"
  },
  {
    "list": "80",
    "anchor": "80-row-8",
    "entityName": "COREWEAVE COMPUTE ACQUISITION CO III LLC",
    "dbaName": "COREWEAVE COMPUTE ACQUISITION CO III LLC",
    "mailingAddress": "1525 W 43RD ST S MUSKOGEE OK 74402",
    "locationAddress": "1525 W 43RD ST S MUSKOGEE OK 74402"
  },
  {
    "list": "80",
    "anchor": "80-row-9",
    "entityName": "COREWEAVE FINANCING DDTL V, LLC",
    "dbaName": "COREWEAVE FINANCING DDTL V, LLC",
    "mailingAddress": "1525 W 43RD ST S MUSKOGEE OK 74402",
    "locationAddress": "1525 W 43RD ST S MUSKOGEE OK 74402"
  },
  {
    "list": "80",
    "anchor": "80-row-10",
    "entityName": "COREWEAVE INC",
    "dbaName": "COREWEAVE INC",
    "mailingAddress": "T14N R18E S 15 E990 NW LESS N50 E167.85 NW MUSKOGEE OK 74402",
    "locationAddress": "T14N R18E S 15 E990 NW LESS N50 E167.85 NW MUSKOGEE OK 74402"
  },
  {
    "list": "80",
    "anchor": "80-row-11",
    "entityName": "DCA SERVICES, INC.",
    "dbaName": "DCA SERVICES, INC.",
    "mailingAddress": "300 N MERIDIAN AVE STE 100N OKLAHOMA CITY OK 731076538",
    "locationAddress": "3334 W MAIN ST STE 412 NORMAN OK 73072-4805"
  },
  {
    "list": "80",
    "anchor": "80-row-12",
    "entityName": "JS DATA CENTER, LLC",
    "dbaName": "JS DATA CENTER, LLC",
    "mailingAddress": "35°37‘03.0\"N 95°59'40.0\"W, OKMULGEE OK 74447",
    "locationAddress": "35°37‘03.0\"N 95°59'40.0\"W, OKMULGEE OK 74447"
  },
  {
    "list": "80",
    "anchor": "80-row-13",
    "entityName": "MARS DATA TECH",
    "dbaName": "MARS DATA TECH",
    "mailingAddress": "2300 S COUNCIL RD OKLAHOMA CITY OK 73128",
    "locationAddress": "2300 S COUNCIL RD OKLAHOMA CITY OK 73128"
  },
  {
    "list": "80",
    "anchor": "80-row-14",
    "entityName": "NEBIUS, INC",
    "dbaName": "NEBIUS, INC",
    "mailingAddress": "10 STATE ST NEWBURYPORT MA 01950-6604",
    "locationAddress": "10 STATE ST NEWBURYPORT MA 01950-6604"
  },
  {
    "list": "80",
    "anchor": "80-row-15",
    "entityName": "OPENAI OPCO",
    "dbaName": "OPENAI OPCO",
    "mailingAddress": "600 NW 62ND ST OKLAHOMA CITY OK 73118-5822",
    "locationAddress": "600 NW 62ND ST OKLAHOMA CITY OK 73118-5822"
  },
  {
    "list": "80",
    "anchor": "80-row-16",
    "entityName": "POWER COSTS INC",
    "dbaName": "POWER COSTS INC",
    "mailingAddress": "301 DAVID L BOREN BLVD STE 2000 NORMAN OK 730727340",
    "locationAddress": "301 DAVID L BOREN BLVD STE 2000 NORMAN OK 73072-7340"
  },
  {
    "list": "80",
    "anchor": "80-row-17",
    "entityName": "SABRE GLBL INC",
    "dbaName": "SABRE GLBL INC",
    "mailingAddress": "3150 SABRE DR # 8502 SOUTHLAKE TX 76092-2103",
    "locationAddress": "3150 SABRE DR # 8502 SOUTHLAKE TX 76092-2103"
  },
  {
    "list": "80",
    "anchor": "80-row-18",
    "entityName": "SCALE DATACENTERS",
    "dbaName": "SCALE DATACENTERS",
    "mailingAddress": "3131 NW 177TH ST EDMOND OK 73012-9116",
    "locationAddress": "3131 NW 177TH ST EDMOND OK 73012-9116"
  },
  {
    "list": "80",
    "anchor": "80-row-19",
    "entityName": "TENSORWAVE OK1",
    "dbaName": "TENSORWAVE OK1",
    "mailingAddress": "6611 LAS VEGAS BLVD S STE 200 LAS VEGAS NV 89119-3242",
    "locationAddress": "6611 LAS VEGAS BLVD S STE 200 LAS VEGAS NV 89119-3242"
  },
  {
    "list": "80",
    "anchor": "80-row-20",
    "entityName": "THE CONSTANT COMPANY HS 3",
    "dbaName": "THE CONSTANT COMPANY HS 3",
    "mailingAddress": "5555 S 129TH EAST AVE TULSA OK 74134-6714",
    "locationAddress": "5555 S 129TH EAST AVE TULSA OK 74134-6714"
  },
  {
    "list": "80",
    "anchor": "80-row-21",
    "entityName": "THE CONSTANT COMPANY HS4 LLC",
    "dbaName": "THE CONSTANT COMPANY HS4 LLC",
    "mailingAddress": "130 OLD BAKER RD MCALESTER OK 74501-6970",
    "locationAddress": "130 OLD BAKER RD MCALESTER OK 74501-6970"
  },
  {
    "list": "80",
    "anchor": "80-row-22",
    "entityName": "THE CONSTANT COMPANY HS6 LLC",
    "dbaName": "THE CONSTANT COMPANY HS6 LLC",
    "mailingAddress": "3612 S 437 RD PRYOR OK 74361",
    "locationAddress": "3612 S 437 RD PRYOR OK 74361"
  }
];
