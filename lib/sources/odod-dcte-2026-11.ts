/**
 * Rows of the Ohio Department of Development's list of approved data center
 * sales and use tax exemptions (ORC 122.175), as released under Ohio's Public
 * Records Act, in sheet order. odod-dcte-2026-11.test.ts parses the released
 * spreadsheet (public/sources/odod-dcte-2026-11.xlsx) and checks every field
 * of every row against this array.
 * Dollar amounts are whole USD; `rate` is the share of sales and use tax
 * exempted; `termYears` stays a string because the sheet has values like
 * "15 (up to 40)".
 */

export interface DcteRow {
  readonly anchor: string;
  readonly beneficiary: string;
  readonly city: string;
  readonly county: string;
  readonly address: string;
  readonly termYears: string;
  readonly rate: number;
  readonly jobsCreated: number;
  readonly jobsCreatedPayroll: number;
  readonly jobsRetained: number;
  readonly jobsRetainedPayroll: number;
  readonly committedInvestment: number;
  readonly estimatedAward: number;
  /** ISO YYYY-MM-DD, converted from the sheet's M/D/YYYY. */
  readonly approvalDate: string;
}

export const DCTE_PROVENANCE = {
  requested: "2026-10-15",
  received: "2026-11-06",
  statute: "ORC 122.175",
  requestStatute: "ORC 149.43",
  filePath: "/sources/odod-dcte-2026-11.xlsx",
  sha256: "609dbc9082c18d6a0c3a855f3f1d08c55a243e43da56616fb078d664a1d2e0d6",
  byteSize: 21175,
} as const;

export const DCTE_ROWS = [
  {
    "anchor": "row-1",
    "beneficiary": "Ohio River Partners Shareholder LLC",
    "city": "Hannibal",
    "county": "Monroe",
    "address": "43840 State Route 7",
    "termYears": "10",
    "rate": 0.75,
    "jobsCreated": 25,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 25,
    "jobsRetainedPayroll": 1683952,
    "committedInvestment": 120000000,
    "estimatedAward": 6525000,
    "approvalDate": "2021-08-23"
  },
  {
    "anchor": "row-2",
    "beneficiary": "Cologix, Inc",
    "city": "Columbus",
    "county": "Franklin",
    "address": "Worthington Woods Blvd",
    "termYears": "10",
    "rate": 0.75,
    "jobsCreated": 15,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 24,
    "jobsRetainedPayroll": 1892000,
    "committedInvestment": 152000000,
    "estimatedAward": 8550000,
    "approvalDate": "2022-08-29"
  },
  {
    "anchor": "row-3",
    "beneficiary": "Aligned Data Centers (NEO) Propco, LLC",
    "city": "Sandusky",
    "county": "Erie",
    "address": "2509 Hayes Ave",
    "termYears": "15",
    "rate": 0.75,
    "jobsCreated": 18,
    "jobsCreatedPayroll": 1650000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 202000000,
    "estimatedAward": 10226250,
    "approvalDate": "2023-09-25"
  },
  {
    "anchor": "row-4",
    "beneficiary": "Quality Technology Services, LLC",
    "city": "New Albany",
    "county": "Licking",
    "address": "1225, 1275, 785, 675 Beech Rd SW",
    "termYears": "15",
    "rate": 1,
    "jobsCreated": 10,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 1554000000,
    "estimatedAward": 72866125,
    "approvalDate": "2023-12-11"
  },
  {
    "anchor": "row-5",
    "beneficiary": "CyrusOne Management Services LLC",
    "city": "Lebanon",
    "county": "Warren",
    "address": "401 Kingsview Road",
    "termYears": "10",
    "rate": 0.75,
    "jobsCreated": 10,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 10,
    "jobsRetainedPayroll": 1974996,
    "committedInvestment": 135000000,
    "estimatedAward": 7087500,
    "approvalDate": "2023-12-11"
  },
  {
    "anchor": "row-6",
    "beneficiary": "CyrusOne Management Services LLC",
    "city": "Johnstown",
    "county": "Licking",
    "address": "12181 Jug Street Rd",
    "termYears": "10",
    "rate": 0.75,
    "jobsCreated": 10,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 150000000,
    "estimatedAward": 5437500,
    "approvalDate": "2024-04-01"
  },
  {
    "anchor": "row-7",
    "beneficiary": "Vantage Data Centers Management Company, LLC",
    "city": "New Albany",
    "county": "Licking",
    "address": "3475 Horizon Court",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 12,
    "jobsCreatedPayroll": 1683000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 185000000,
    "estimatedAward": 6937500,
    "approvalDate": "2024-06-24"
  },
  {
    "anchor": "row-8",
    "beneficiary": "H5 Rockwell Management LLC",
    "city": "Cleveland",
    "county": "Cuyahoga",
    "address": "1425-1647 Rockwell Avenue",
    "termYears": "15",
    "rate": 1,
    "jobsCreated": 20,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 100000000,
    "estimatedAward": 20029166,
    "approvalDate": "2014-01-27"
  },
  {
    "anchor": "row-9",
    "beneficiary": "Amazon Data Services, Inc.",
    "city": "Twenty five sites in Ohio",
    "county": "",
    "address": "Twenty five sites in Ohio",
    "termYears": "15 (up to 40)",
    "rate": 1,
    "jobsCreated": 120,
    "jobsCreatedPayroll": 9625000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 1110000000,
    "estimatedAward": 77000000,
    "approvalDate": "2014-08-25"
  },
  {
    "anchor": "row-10",
    "beneficiary": "Microsoft Corporation",
    "city": "Johnstown",
    "county": "Licking",
    "address": "3287 Beech Road Northwest",
    "termYears": "15 (up to 30)",
    "rate": 1,
    "jobsCreated": 20,
    "jobsCreatedPayroll": 2000000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 1000000000,
    "estimatedAward": 72500000,
    "approvalDate": "2024-10-28"
  },
  {
    "anchor": "row-11",
    "beneficiary": "Vantage Data Centers Management Company, LLC",
    "city": "Millersport",
    "county": "Fairfield",
    "address": "SR 204 Parcels #046-00452-31, #046-00452-11, #046-00449-00, #46-00447-00, #046-00439-00 and #046-00439-10",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 37,
    "jobsCreatedPayroll": 3700000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 4200000000,
    "estimatedAward": 76125000,
    "approvalDate": "2025-10-08"
  },
  {
    "anchor": "row-12",
    "beneficiary": "EdgeConneX MCN New Albany South Opco 1, LLC",
    "city": "New Albany",
    "county": "Licking",
    "address": "9850 Innovation Campus Way",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 32,
    "jobsCreatedPayroll": 4000000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 1000000000,
    "estimatedAward": 36250000,
    "approvalDate": "2025-10-27"
  },
  {
    "anchor": "row-13",
    "beneficiary": "The Constant Company, LLC",
    "city": "Springfield",
    "county": "Clark",
    "address": "601 Benjamin Dr",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 20,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 901311378,
    "estimatedAward": 32672537,
    "approvalDate": "2025-10-27"
  },
  {
    "anchor": "row-14",
    "beneficiary": "Crusoe Energy Systems LLC",
    "city": "Springfield",
    "county": "Clark",
    "address": "601 Benjamin Dr.",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 20,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 444500000,
    "estimatedAward": 16113125,
    "approvalDate": "2025-12-15"
  },
  {
    "anchor": "row-15",
    "beneficiary": "ark data centers, LLC",
    "city": "Akron",
    "county": "Cuyahoga",
    "address": "191 East Miller Avenue",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 10,
    "jobsCreatedPayroll": 1100000,
    "jobsRetained": 27,
    "jobsRetainedPayroll": 2003000,
    "committedInvestment": 136050000,
    "estimatedAward": 4538625,
    "approvalDate": "2026-03-02"
  },
  {
    "anchor": "row-16",
    "beneficiary": "Cologix, Inc",
    "city": "Lewis Center; Johnstown",
    "county": "Delaware",
    "address": "6787 Green Meadows Dr; 12017 Duncan Plains Rd",
    "termYears": "10",
    "rate": 0.5,
    "jobsCreated": 90,
    "jobsCreatedPayroll": 10000000,
    "jobsRetained": 56,
    "jobsRetainedPayroll": 5185126,
    "committedInvestment": 1167000000,
    "estimatedAward": 42303750,
    "approvalDate": "2026-06-01"
  },
  {
    "anchor": "row-17",
    "beneficiary": "Sidecat LLC",
    "city": "New Albany",
    "county": "Licking",
    "address": "SE Corner of Beach Rd. and 161",
    "termYears": "15 (up to 40)",
    "rate": 1,
    "jobsCreated": 50,
    "jobsCreatedPayroll": 4000000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 750000000,
    "estimatedAward": 36250000,
    "approvalDate": "2017-07-31"
  },
  {
    "anchor": "row-18",
    "beneficiary": "American Electric Power Service Corporation",
    "city": "Groveport",
    "county": "Franklin",
    "address": "Parcel Number 185001294 Near the intersection of South Hamilton Road and Firehouse Lane",
    "termYears": "15",
    "rate": 1,
    "jobsCreated": 17,
    "jobsCreatedPayroll": 2200000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 109498122,
    "estimatedAward": 8212359,
    "approvalDate": "2018-06-25"
  },
  {
    "anchor": "row-19",
    "beneficiary": "Progressive Casualty Insurance Company",
    "city": "Mayfield Village",
    "county": "Cuyahoga",
    "address": "300 N Commons Blvd",
    "termYears": "15",
    "rate": 1,
    "jobsCreated": 15,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 100000000,
    "estimatedAward": 8000000,
    "approvalDate": "2018-12-10"
  },
  {
    "anchor": "row-20",
    "beneficiary": "Montauk Innovations LLC",
    "city": "New Albany",
    "county": "Franklin",
    "address": "Parcels adjacent to Morse, Babbitt, and Beech Roads 220-000209, 220-001628, 220-002166, et al.",
    "termYears": "15 (up to 40)",
    "rate": 1,
    "jobsCreated": 30,
    "jobsCreatedPayroll": 2500000,
    "jobsRetained": 0,
    "jobsRetainedPayroll": 0,
    "committedInvestment": 600000000,
    "estimatedAward": 43500000,
    "approvalDate": "2018-12-10"
  },
  {
    "anchor": "row-21",
    "beneficiary": "The Kroger Co.",
    "city": "Blue Ash",
    "county": "Hamilton",
    "address": "9935 Carver Road and 11450 Grooms Rd",
    "termYears": "15",
    "rate": 0.75,
    "jobsCreated": 15,
    "jobsCreatedPayroll": 1500000,
    "jobsRetained": 571,
    "jobsRetainedPayroll": 58182000,
    "committedInvestment": 104847133,
    "estimatedAward": 4704000,
    "approvalDate": "2020-07-27"
  }
] as const satisfies readonly DcteRow[];
