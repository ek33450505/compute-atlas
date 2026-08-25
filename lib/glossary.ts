/**
 * Curated glossary topics for the SEO Tier 2 "Learn" hub.
 *
 * This is a static content registry — NOT a data-query helper. Every stat
 * these glossary entries reference already exists as an exported query in
 * `lib/data.ts` (getWaterUsage, getCoolingTypeCounts, getStats,
 * getEnergySourceCounts, getAiClassificationCounts, getGenerationStats,
 * getCommunityReceptionCounts). Pages built on these topics call those
 * existing helpers directly; this registry only owns the topic identity
 * (slug/title/dek) and lookup, mirroring `lib/metros.ts`'s
 * METROS / getMetroBySlug pattern.
 *
 * A topic may also carry an `explainer`: cited, editor-approved prose that
 * answers the topic's headline question directly, instead of only the
 * dataset stat block. It lives here for the same reason the stats do — it's
 * static and registry-owned, not derived per-request.
 */

/** A single citable source backing an explainer's claims. */
export interface GlossarySource {
  id: string;
  label: string;
  publisher: string;
  url: string;
  /** ISO date the quote was located in the served document. */
  verifiedAt: string;
  note?: string;
}

/**
 * How strongly the cited sources back a section's claim:
 * - "substantiated": a cited source measures or documents the effect.
 * - "raised": residents raise the concern; no cited source measures it either way.
 * - "raised-not-substantiated": residents raise it, and the cited source looked
 *   for the effect and did not find it.
 */
export type GlossaryEvidence = "raised" | "substantiated" | "raised-not-substantiated";

export interface GlossaryExplainerSection {
  heading: string;
  /** Paragraphs of plain prose — no markup, no interpolation. */
  body: string[];
  sourceIds: string[];
  /** Facility ids, resolved live at render; unresolved ids are dropped. */
  exemplarIds?: string[];
  evidence?: GlossaryEvidence;
}

export interface GlossaryExplainer {
  lede: string;
  sections: GlossaryExplainerSection[];
  sources: GlossarySource[];
}

export interface GlossaryTopic {
  slug: string;
  title: string;
  dek: string;
  /** Cited prose explainer. Only populated for topics that have one. */
  explainer?: GlossaryExplainer;
}

/**
 * Cited explainer for "why-do-communities-oppose-data-centers". Every claim
 * traces to a source in `sources` below; quoted figures come from the source
 * document, not from the tracked dataset. See CITATIONS-ADJUDICATED.md for
 * the editorial adjudication behind each sentence. Do not reword, add
 * figures, or otherwise "improve" this prose — each sentence is scoped to
 * exactly what its cited source supports.
 */
const WHY_COMMUNITIES_OPPOSE_EXPLAINER: GlossaryExplainer = {
  lede:
    "Opposition to a data center is rarely about data centers in the abstract. In the records Compute Atlas tracks, it is about a specific local consequence — a well, a noise floor, a rezoning hearing that neighbors heard about late. A review of the sourced friction notes on record in August 2026 found water raised most often, ahead of noise, complaints about the approval process itself, and air quality and emissions. Electricity — the concern the national debate centers on — appears less often in local records than any of those.",
  sections: [
    {
      heading: "Water",
      evidence: "substantiated",
      sourceIds: ["jlarc"],
      exemplarIds: [
        "arizona-land-consulting-hassayampa-ranch-tonopah-az",
        "hickory-grove-generating-station-ia",
      ],
      body: [
        "Water is the concern raised most often in the records on file. Cooling is the reason. Virginia's Joint Legislative Audit and Review Commission, in the most detailed state review of the industry so far, describes the split plainly: some cooling systems \"use water evaporation, and these systems typically require regular water refills to operate,\" while others \"recirculate all or most of their water, similar to a radiator, and use relatively little water.\"",
        "Scale follows from that choice. JLARC found Virginia's data center industry used an estimated 2.1 billion gallons of water in 2023, with one building alone accounting for 243 million gallons. The same review put that total at \"less than 0.5 percent of total state withdrawals\" — sustainable today by the commission's own assessment, and growing. Locally the ratio matters less than the source: objections in the record are usually about a specific aquifer, well field, or municipal supply rather than a statewide total.",
      ],
    },
    {
      heading: "Noise",
      evidence: "substantiated",
      sourceIds: ["jlarc", "ycpc"],
      exemplarIds: [
        "primeblock-murphy-cherokee-county-nc",
        "mara-granbury-hood-tx",
      ],
      body: [
        "The complaint about data center noise is usually not that it is loud. It is that it never stops. JLARC found that noise prompting resident complaints in Virginia \"ranges from an estimated 40 to 59 decibels\" — below the 55 or 60 decibel limits Loudoun, Prince William and Fairfax counties set for residential areas. The sound is described in the report as \"a constant 'drone' or 'hum,' similar to house air conditioning systems but magnified to an industrial scale.\"",
        "That gap between a measurement inside the limit and a complaint that persists is why the argument usually moves to the ordinance itself. A model data center ordinance published by the York County Planning Commission in Pennsylvania recommends capping sound at 60 dBA at the boundary of any property containing a \"sensitive receptor\" — a home, school, daycare, hospital or place of worship — and requires pre- and post-construction sound studies by a certified acoustical engineer. It is a template for municipalities to adapt rather than binding law, and it is a fair picture of what communities are now asking developers to meet.",
      ],
    },
    {
      heading: "How the decision was made",
      evidence: "raised",
      sourceIds: ["jlarc"],
      exemplarIds: [],
      body: [
        "A recurring objection in the record is not about any physical impact at all. It is that residents learned about a project late, that negotiations happened under a non-disclosure agreement, or that a vote was taken before the public could respond. This class of complaint appears more often in the notes on file than either grid capacity or electricity bills.",
        "Zoning is what gives it force. JLARC describes three routes to approval: a \"by right\" use allowed \"without any special approval by the locality\"; a \"special permit,\" where approval can be made \"conditional on additional restrictions to mitigate negative impacts, such as bigger property line setbacks or lower building heights\"; and rezoning, which \"require[s] a public hearing and approval from elected officials.\" A by-right approval can be lawful and complete before a neighbor has any formal opportunity to object — which is frequently the substance of the grievance.",
      ],
    },
    {
      heading: "Air quality and emissions",
      evidence: "raised",
      sourceIds: [],
      exemplarIds: ["xai-colossus-memphis-tn", "fermi-matador-amarillo-tx"],
      body: [
        "Where a site generates its own power, the objection shifts from electricity to air. On-site gas turbines carry a permitting process of their own, and that process is where opposition tends to concentrate — comment periods, air permits, and in some cases litigation brought by national environmental organizations alongside local residents. This is the concern that most often attaches to a specific pollutant and a specific permit number rather than to the facility as a whole.",
      ],
    },
    {
      heading: "Electricity: the grid and the bill",
      evidence: "substantiated",
      sourceIds: ["lbnl", "pjm-imm", "arxiv-rates"],
      exemplarIds: [],
      body: [
        "Data center electricity demand is real and measured. Lawrence Berkeley National Laboratory found US data centers reached \"176 TWh by 2023, representing 4.4% of total U.S. electricity consumption,\" and projected 6.7% to 12.0% by 2028 — a forecast range, not a measurement.",
        "Whether that raises household bills is the contested part, and the honest answer is that it depends where and when. PJM's independent market monitor told federal regulators in November 2025 that \"data center load growth is the primary reason for recent and expected capacity market conditions, including total forecast load growth, the tight supply and demand balance, and high prices,\" attributing a combined increase of roughly $16.6 billion in capacity market revenue across two auctions. The same filing warns that PJM \"will be in the position of allocating blackouts rather than ensuring reliability\" if large loads are connected faster than they can be served.",
        "Set against that, a 2026 working paper studying US retail rates from 2015 to 2024 estimated that data centers \"caused average retail electricity rates to fall modestly,\" attributing the effect to economies of scale across existing fixed costs. Its authors add their own caveat — \"future supply constraints could reverse the effect.\" The two findings describe different periods and different mechanisms, and read together they suggest a cost effect that is arriving now in specific markets rather than one that has been a nationwide pattern.",
      ],
    },
    {
      heading: "Property values",
      evidence: "raised-not-substantiated",
      sourceIds: ["jlarc"],
      exemplarIds: [],
      body: [
        "Homeowners near proposed sites frequently expect their property values to fall. Virginia's legislative review looked for that effect and did not find it. \"While it is certainly possible that nearby data centers have affected the resale value of homes, there is not yet evidence of this relationship,\" JLARC reported, after interviewing opposed neighborhood groups, county assessors and a local real estate association — almost none of whom observed a decline in value or in how quickly homes sold. One explanation the commission recorded was that \"the tight housing market in Northern Virginia decreases buyers' selectiveness.\"",
        "That is a qualitative interview sweep rather than a statistical price study, so it is evidence of absence only so far as it goes. It is included here because it is a concern residents genuinely raise and the most thorough public review of it so far could not substantiate.",
      ],
    },
    {
      heading: "How opposition happens",
      evidence: "raised",
      sourceIds: ["dcw"],
      exemplarIds: ["revolve-labs-windom-mn"],
      body: [
        "Opposition in the record moves through ordinary civic machinery rather than protest. Litigation appears most often, followed by turnout at public hearings, temporary moratoriums on new permits, and petitions. Further down are zoning denials, new data-center-specific ordinances, ballot measures, annexation challenges, outright bans, and — in a handful of places — recall petitions against the officials who approved a project.",
        "Much of it is durable. A large share of the notes on file name a purpose-formed local group, and those groups often outlast the specific project that created them.",
        "Data Center Watch, which tracks local opposition, counted \"at least 75 data center projects worth approximately $130 billion\" blocked or delayed in the first quarter of 2026, and reports the number of active opposition groups more than doubling since late 2025. That figure is the organization's own count rather than an independently audited one.",
      ],
    },
    {
      heading: "What this page does not show",
      evidence: "raised",
      sourceIds: [],
      exemplarIds: [],
      body: [
        "These are the reasons that appear in the sources behind the tracked records — not a survey, and not a measured ranking of what communities care about. Just over a third of the friction records on file document that a project is contested without stating why, so the ordering above reflects what reporting captured, not what was felt. A record with no stated reason is not a record of no reason.",
        "Community reception is also recorded only where a public source establishes it. Facilities with no reception status are not evidence of consent.",
      ],
    },
  ],
  sources: [
    {
      id: "jlarc",
      label: "Data Centers in Virginia (Report 598)",
      publisher: "Joint Legislative Audit and Review Commission, Commonwealth of Virginia — December 2024",
      url: "https://jlarc.virginia.gov/pdfs/reports/Rpt598-2.pdf",
      verifiedAt: "2026-08-25",
      note: "The copy posted at the Commission's report archive carries a 'Commission draft' header.",
    },
    {
      id: "ycpc",
      label: "Data Center Model Ordinance",
      publisher: "York County Planning Commission, Pennsylvania — August 2025, revised April 2026",
      url: "https://www.ycpc.org/DocumentCenter/View/5537/Data-Centers-Model-Ordinance---2026-Update-PDF",
      verifiedAt: "2026-08-25",
      note: "A model for municipalities to adapt, not binding law.",
    },
    {
      id: "lbnl",
      label: "2024 United States Data Center Energy Usage Report",
      publisher: "Lawrence Berkeley National Laboratory — December 2024",
      url: "https://eta-publications.lbl.gov/sites/default/files/2024-12/lbnl-2024-united-states-data-center-energy-usage-report_1.pdf",
      verifiedAt: "2026-08-25",
    },
    {
      id: "pjm-imm",
      label: "Complaint of the Independent Market Monitor for PJM (Docket RM26-4)",
      publisher: "Monitoring Analytics LLC, filed at the Federal Energy Regulatory Commission — November 2025",
      url: "https://www.monitoringanalytics.com/filings/2025/IMM_Comment_Docket_No_RM26-4_20251125.pdf",
      verifiedAt: "2026-08-25",
    },
    {
      id: "arxiv-rates",
      label: "Have Data Centers Raised Your Electric Bill? Causal Evidence from the United States",
      publisher: "arXiv preprint 2606.19777 — June 2026",
      url: "https://arxiv.org/abs/2606.19777",
      verifiedAt: "2026-08-25",
      note: "A preprint; not peer reviewed.",
    },
    {
      id: "dcw",
      label: "Q1 2026 report",
      publisher: "Data Center Watch",
      url: "https://www.datacenterwatch.org/q1-2026",
      verifiedAt: "2026-08-25",
      note: "The organization's own count of blocked and delayed projects.",
    },
  ],
};

export const GLOSSARY_TOPICS: GlossaryTopic[] = [
  {
    slug: "data-center-water-use",
    title: "How much water does a data center use?",
    dek: "Cooling a large data center can consume millions of gallons of water a year — here's how facility-level water use is tracked and reported.",
  },
  {
    slug: "data-center-power-draw",
    title: "How much power does a data center draw?",
    dek: "From megawatts of critical IT load to gigawatt-scale campuses — a breakdown of how data center power draw is measured and reported.",
  },
  {
    slug: "what-is-an-ai-data-center",
    title: "What is an AI data center?",
    dek: "AI data centers are purpose-built for GPU-dense training and inference workloads — how they differ from traditional cloud and colocation facilities.",
  },
  {
    slug: "behind-the-meter-power",
    title: "What is behind-the-meter power?",
    dek: "Some data centers generate their own power on-site rather than drawing entirely from the grid — what \"behind-the-meter\" means and why it's growing.",
  },
  {
    slug: "why-do-communities-oppose-data-centers",
    title: "Why do communities oppose data centers?",
    dek: "Noise, water use, land, and grid strain — the recurring reasons local communities push back on proposed data center projects.",
    explainer: WHY_COMMUNITIES_OPPOSE_EXPLAINER,
  },
];

export function getGlossaryTopicBySlug(slug: string): GlossaryTopic | undefined {
  return GLOSSARY_TOPICS.find((t) => t.slug === slug);
}
