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
 * Cited explainer for "data-center-water-use". Every claim traces to a
 * source in `sources` below; quoted figures come from the source document,
 * not from the tracked dataset. Do not reword, add figures, or otherwise
 * "improve" this prose — each sentence is scoped to exactly what its cited
 * source supports.
 */
const WATER_USE_EXPLAINER: GlossaryExplainer = {
  lede:
    "There is no single number. A data center's water use is reported two different ways, and the two answers differ by an order of magnitude — before accounting for the water used somewhere else entirely, at the power plants that supply it. What follows is what the cited sources establish, and where the record runs out.",
  sections: [
    {
      heading: "Withdrawn is not consumed",
      evidence: "substantiated",
      sourceIds: ["usgs-terms", "usgs-thermo"],
      exemplarIds: ["google-pryor-ok"],
      body: [
        "The distinction that governs every water figure is a standard one. The US Geological Survey defines a withdrawal as \"water removed from the ground or diverted from a surface-water source for use,\" and consumptive use as \"the part of water withdrawn that is evaporated, transpired, incorporated into products or crops, consumed by humans or livestock, or otherwise not available for immediate use.\" Water withdrawn and returned to its source is not water consumed.",
        "The gap between the two is not small. In the power sector, where USGS has measured it directly, total estimated withdrawal for 2015 was \"about 103 billion gallons per day\" against consumption of \"about 2.7 Bgal/d.\" A facility that reports withdrawal and one that reports consumption are not describing the same quantity, and a figure quoted without saying which it is cannot be compared to anything.",
      ],
    },
    {
      heading: "Cooling is the choice that sets the number",
      evidence: "substantiated",
      sourceIds: ["jlarc", "small-bottle"],
      exemplarIds: ["xai-colossus-memphis-tn", "amazon-project-rainier-new-carlisle-in"],
      body: [
        "Virginia's Joint Legislative Audit and Review Commission, in the most detailed state review of the industry so far, describes the split plainly: some cooling systems \"use water evaporation, and these systems typically require regular water refills to operate,\" while others \"recirculate all or most of their water, similar to a radiator, and use relatively little water.\"",
        "The choice is a trade, not an efficiency. A recent academic analysis of data center water use states that \"there is a fundamental tradeoff between power and water use for facility-level cooling\" — evaporative cooling \"uses substantially more on-site water than waterless dry cooling,\" while industry disclosures compiled in the same paper indicate that \"water-cooled data centers can use 25 to 35% less electricity than air-cooled data centers.\" A site that reports very little water is often a site that decided to spend electricity instead. Which trade makes sense depends on the local climate and on which resource is scarce there.",
      ],
    },
    {
      heading: "Most of the water is somewhere else",
      evidence: "substantiated",
      sourceIds: ["lbnl"],
      exemplarIds: [],
      body: [
        "Generating electricity consumes water, so a data center has a water footprint at the power plant as well as at the building. Lawrence Berkeley National Laboratory's 2024 assessment puts US data center direct water consumption at a \"66-billion-liter total\" for 2023. The same report puts the indirect figure an order of magnitude higher: \"the total indirect water footprint of U.S. data centers is nearly 800 billion liters, attributed to water consumed indirectly through electricity use.\"",
        "That gap is a consequence of scale, not of unusually thirsty power. LBNL puts data center electricity at \"a national average of 4.52 L/kWh of indirect water consumption,\" against an average for US electricity generally of \"4.35 L/kWh.\" The water follows the electricity, and there is a great deal of electricity.",
      ],
    },
    {
      heading: "What \"a bottle of water per query\" actually measures",
      evidence: "substantiated",
      sourceIds: ["thirsty"],
      exemplarIds: [],
      body: [
        "The most widely repeated figure about AI and water comes from a 2023 paper by Li, Yang, Islam and Ren, which estimated that \"GPT-3 needs to 'drink' (i.e., consume) a 500ml bottle of water for roughly 10 – 50 medium-length responses, depending on when and where it is deployed.\" Four things about that sentence are usually lost when it is quoted.",
        "Its subject is GPT-3, not any current model; the authors note that \"some subsequent models like GPT-4 could consume substantially more energy and water than GPT-3 for processing the same request.\" Its range is deployment-dependent, which is what \"when and where\" is doing in the original. It is a total, combining on-site cooling water with off-site water at the power plant — so it is not the undercount it is sometimes assumed to be. And the authors describe their own estimate as \"on the conservative side, and the actual water consumption could be several times higher.\"",
        "The companion training figure is more often misquoted still. The paper's number for training GPT-3 in Microsoft's US data centers is \"a total of 5.4 million liters of water, including 700,000 liters of scope-1 on-site water consumption.\" The 700,000-litre figure that circulates on its own is the on-site portion of the larger total, not the total. Even that had to be modelled: \"the specific location for training GPT-3 is not public.\"",
      ],
    },
    {
      heading: "Why per-site figures are scarce",
      evidence: "substantiated",
      sourceIds: ["current-ga", "lbnl"],
      exemplarIds: ["google-pryor-ok"],
      body: [
        "Reporting is voluntary, and operators do it at different granularities. An analysis of company sustainability reporting published in August 2025 found that \"Amazon releases annual sustainability reports, but those documents do not disclose how much water the company uses. Microsoft provides data on its water demands for its overall operations, but does not break down water use for its data centers. Meta does that breakdown, but only in a companywide aggregate figure. Google provides individual figures for each data center.\" Because the reports are voluntary, the same analysis notes, \"different companies report different statistics in ways that make them hard to combine or compare.\"",
        "Where a site-level number does exist, it has often come from a utility record or an open-records request rather than from the operator. That is the provenance of most of the per-facility water figures recorded here.",
      ],
    },
    {
      heading: "What this page does not show",
      evidence: "raised",
      sourceIds: ["jlarc", "lbnl"],
      exemplarIds: [],
      body: [
        "Compute Atlas records a water figure only where a public source states one, and most tracked facilities have none. An absent figure means no source reported one — not that a facility uses no water. Where a figure is present, it is the figure the source published, on that source's own definition of withdrawal or consumption, which is not always stated.",
        "Scale claims also need their denominator. JLARC found Virginia's data center industry used an estimated 2.1 billion gallons of water in 2023, with one building alone accounting for 243 million gallons — and put that same total at \"less than 0.5 percent of total state withdrawals,\" sustainable today by the commission's own assessment, and growing. Both halves are the finding. Locally the denominator is different again: objections in the record are usually about a specific aquifer, well field or municipal supply rather than a statewide share.",
        "One further limit is the sources' own. LBNL notes that its indirect water and emissions methodology \"does not incorporate any power purchase agreements between individual data center facilities and their electricity providers or on-site\" behind-the-meter generation — arrangements that are becoming more common, and that the national averages above therefore do not capture.",
      ],
    },
  ],
  sources: [
    {
      id: "usgs-terms",
      label: "Water Use Terminology",
      publisher: "U.S. Geological Survey",
      url: "https://www.usgs.gov/mission-areas/water-resources/science/water-use-terminology",
      verifiedAt: "2026-08-25",
      note: "General water-use vocabulary; not a study of data centers.",
    },
    {
      id: "usgs-thermo",
      label: "Withdrawal and Consumption of Water by Thermoelectric Power Plants in the United States, 2015 (SIR 2019-5103)",
      publisher: "U.S. Geological Survey — 2019",
      url: "https://pubs.usgs.gov/sir/2019/5103/sir20195103.pdf",
      verifiedAt: "2026-08-25",
      note: "Power-sector totals, not data center figures.",
    },
    {
      id: "jlarc",
      label: "Data Centers in Virginia (Report 598)",
      publisher: "Joint Legislative Audit and Review Commission, Commonwealth of Virginia — December 2024",
      url: "https://jlarc.virginia.gov/pdfs/reports/Rpt598-2.pdf",
      verifiedAt: "2026-08-25",
      note: "The copy posted at the Commission's report archive carries a 'Commission draft' header.",
    },
    {
      id: "small-bottle",
      label: "Small Bottle, Big Pipe: Quantifying and Addressing the Impact of Data Centers on Public Water Systems",
      publisher: "Han, Li, Wierman and Ren — arXiv preprint 2603.02705, March 2026",
      url: "https://arxiv.org/abs/2603.02705",
      verifiedAt: "2026-08-25",
      note: "A preprint; not peer reviewed. Its 25-35% figure compiles companies' own disclosures.",
    },
    {
      id: "lbnl",
      label: "2024 United States Data Center Energy Usage Report",
      publisher: "Lawrence Berkeley National Laboratory — December 2024",
      url: "https://eta-publications.lbl.gov/sites/default/files/2024-12/lbnl-2024-united-states-data-center-energy-usage-report_1.pdf",
      verifiedAt: "2026-08-25",
      note: "Water and emissions figures are modelled, not metered.",
    },
    {
      id: "thirsty",
      label: "Making AI Less \"Thirsty\": Uncovering and Addressing the Secret Water Footprint of AI Models",
      publisher: "Li, Yang, Islam and Ren — arXiv preprint 2304.03271, 2023",
      url: "https://arxiv.org/abs/2304.03271",
      verifiedAt: "2026-08-25",
      note: "A preprint; not peer reviewed. Figures are for GPT-3.",
    },
    {
      id: "current-ga",
      label: "Data centers consume massive amounts of water — companies rarely tell the public exactly how much",
      publisher: "McCauley and Scanlan, University of Wisconsin-Milwaukee, in The Current GA — August 2025",
      url: "https://thecurrentga.org/2025/08/26/data-centers-consume-massive-amounts-of-water-companies-rarely-tell-the-public-exactly-how-much/",
      verifiedAt: "2026-08-25",
      note: "Disclosure practice as of August 2025; operators' reporting changes.",
    },
  ],
};

/**
 * Cited explainer for "data-center-power-draw". Every claim traces to a
 * source in `sources` below; quoted figures come from the source document,
 * not from the tracked dataset. Do not reword, add figures, or otherwise
 * "improve" this prose — each sentence is scoped to exactly what its cited
 * source supports.
 */
const POWER_DRAW_EXPLAINER: GlossaryExplainer = {
  lede:
    "Most disagreements about how much power a data center uses are disagreements about units. A megawatt figure and a megawatt-hour figure answer different questions; the power delivered to the servers is not the power drawn by the building; and an announced capacity is a plan, not a measurement. Sorting those apart accounts for most of the apparent contradiction between published numbers.",
  sections: [
    {
      heading: "A megawatt is not a megawatt-hour",
      evidence: "substantiated",
      sourceIds: ["eia-faq"],
      exemplarIds: [],
      body: [
        "A megawatt measures a rate — how fast electricity is being drawn at an instant. A megawatt-hour measures a quantity — how much was drawn over time. The Energy Information Administration puts the relationship concretely: \"a generator with 1 megawatt (MW) capacity that operates at that capacity consistently for one hour will produce 1 megawatthour (MWh) of electricity. If the generator operates at only half that capacity for one hour, it will produce 0.5 MWh.\"",
        "The same distinction separates a facility's size from its consumption. Capacity is \"the maximum electric output an electricity generator can produce under specific conditions\"; nameplate capacity \"is determined by the generator's manufacturer and indicates the maximum output a generator can produce without exceeding design thermal limits.\" As EIA notes, \"many generators do not operate at full capacity all the time.\" A site described in megawatts has been described by its ceiling.",
      ],
    },
    {
      heading: "The building draws more than the computers",
      evidence: "substantiated",
      sourceIds: ["green-grid", "uptime"],
      exemplarIds: [],
      body: [
        "Capacity figures for data centers are quoted on at least two different boundaries. The Green Grid's reference paper on the subject defines IT equipment energy as \"the energy consumed by equipment that is used to manage, process, store, or route data within the compute space,\" while total facility energy adds \"everything that supports the IT equipment using energy\" — power conversion and distribution losses, uninterruptible power supplies, chillers, cooling towers, pumps and air handling.",
        "The ratio between them is Power Usage Effectiveness, \"the ratio of total facilities energy to IT equipment energy.\" It is not a small correction. The Uptime Institute's 2025 survey of operators reports that \"in 2025, respondents' annual PUE had a weighted average of 1.54,\" a figure that has now been effectively flat for six consecutive years. A facility quoted at a given IT load is drawing meaningfully more than that from the grid, and a facility quoted at its grid draw contains meaningfully less computing than the number suggests.",
      ],
    },
    {
      heading: "PUE does not rank facilities against each other",
      evidence: "substantiated",
      sourceIds: ["energy-star"],
      exemplarIds: [],
      body: [
        "PUE is widely published and widely misread as a league table. The joint task force whose recommendations standardized its reporting — convened with the Department of Energy and the Environmental Protection Agency — is explicit that \"caution must be exercised when an organization wishes to use PUE to compare different data centers, as it is necessary to first conduct appropriate data analyses to ensure that other factors such as levels of reliability and climate are not impacting the PUE.\"",
        "The metric also says nothing about the efficiency of the computing itself. The same document states in its scope that \"this document does not address IT efficiency.\" A facility running obsolete hardware very efficiently cooled will report a better PUE than a facility running modern hardware in a hot climate, while doing less work for the same electricity.",
      ],
    },
    {
      heading: "An announced capacity is not a measurement",
      evidence: "substantiated",
      sourceIds: ["e3"],
      exemplarIds: ["amazon-project-rainier-new-carlisle-in", "xai-colossus-memphis-tn"],
      body: [
        "Campuses are built and energized in phases, and utilization climbs for years after the first building opens. A December 2025 assessment of data center load forecasting notes that \"actual data center load also diverges from nameplate capacity, as facilities typically ramp up gradually after interconnection, taking several years to reach full operation.\"",
        "The gap is measurable where utilities have telemetry rather than forecasts. The same assessment reports that \"many planning assumptions for data center load factors use values upwards of 90% of the expected interconnection request,\" while \"PG&E has published analysis of their data center load indicating that, on average, data center peak loads are only about 67% of their 'nameplate load.'\" This is why operational and planned capacity are recorded here as separate figures rather than summed: they are not the same kind of claim, and adding them produces a number that describes no moment in time.",
      ],
    },
    {
      heading: "The queue counts some projects more than once",
      evidence: "substantiated",
      sourceIds: ["e3", "pjm"],
      exemplarIds: [],
      body: [
        "Interconnection queue totals are often reported as demand. They overstate it, because a single project may appear several times. The same December 2025 assessment records that \"some developers engage in 'queue shopping,' submitting multiple interconnection requests to shorten connection timelines,\" and that \"these practices inflate apparent demand.\"",
        "Grid operators have begun correcting for it directly. In a January 2026 letter, PJM's Board of Managers set out a rule requiring transmission owners to report whether load interconnection requests \"are duplicative with other such requests made to interconnect large load either within or outside of the PJM region such that only a subset of such requests are expected to achieve actual commercial operation\" — and providing that where a submitter does not supply that accounting, \"all such requests will be removed from the forecast.\" Pipelines shrink accordingly when speculative requests exit: the December assessment cites one utility's expected large load additions falling by 6 GW in a single quarter, and another's interconnection request volume falling from 30 GW to 13 GW after a tariff required data centers to pay for capacity they had requested.",
      ],
    },
    {
      heading: "What a single facility actually draws",
      evidence: "substantiated",
      sourceIds: ["e3", "crs"],
      exemplarIds: [],
      body: [
        "The range is very wide, and the categories are informal rather than regulatory. The December 2025 assessment describes \"edge facilities (less than 5 MW)\" as \"small, geographically distributed, and exhibit high variability tied to user activity\"; standard facilities at \"5–100 MW\" serving \"a wide range of cloud and enterprise functions\"; and \"hyperscale facilities (over 100 MW)\" operating \"as large, stable point loads with dedicated substations and minimal variation.\"",
        "At the top end, a Congressional Research Service report notes that \"new hyperscale data centers have been built with capacities from 100 MW to 1,000 MW each,\" and offers a comparison for scale: \"roughly 100 MW of electric power is sufficient to support the electricity needs of 80,000 U.S. households.\" The largest announced campuses are larger still, but those are announcements, which Section 4 is about.",
      ],
    },
    {
      heading: "What this page does not show",
      evidence: "raised",
      sourceIds: [],
      exemplarIds: [],
      body: [
        "Compute Atlas records a capacity figure only where a public source states one, and many tracked facilities have none. Where a figure exists, it is the figure the source published — usually without saying whether it describes IT load, total facility draw, or a utility interconnection request. Those are the three quantities Sections 1 and 2 distinguish, and the distinction is rarely made in the announcement that a figure comes from.",
        "Nothing here is metered. These are announced, permitted and reported capacities, not measured consumption. No public dataset of per-facility electricity consumption exists in the United States, which is why a tracker can record what a site is designed to draw and not what it drew.",
      ],
    },
  ],
  sources: [
    {
      id: "eia-faq",
      label: "What is the difference between electricity generation capacity and electricity generation?",
      publisher: "U.S. Energy Information Administration",
      url: "https://www.eia.gov/tools/faqs/faq.php?id=101&t=3",
      verifiedAt: "2026-08-25",
    },
    {
      id: "green-grid",
      label: "PUE: A Comprehensive Examination of the Metric (White Paper #49)",
      publisher: "The Green Grid",
      url: "https://datacenters.lbl.gov/sites/default/files/WP49-PUE%20A%20Comprehensive%20Examination%20of%20the%20Metric_v6.pdf",
      verifiedAt: "2026-08-25",
      note: "Copy hosted by Lawrence Berkeley National Laboratory. ISO/IEC 30134-2, which also standardizes PUE, is paywalled.",
    },
    {
      id: "energy-star",
      label: "Recommendations for Measuring and Reporting Overall Data Center Efficiency (Version 2)",
      publisher: "Data Center Metrics Task Force, via ENERGY STAR (U.S. EPA / U.S. Department of Energy)",
      url: "https://www.energystar.gov/sites/default/files/Data_Center_Metrics_Task_Force_Recommendations_V2.pdf",
      verifiedAt: "2026-08-25",
    },
    {
      id: "uptime",
      label: "Global Data Center Survey 2025",
      publisher: "Uptime Institute — July 2025",
      url: "https://datacenter.uptimeinstitute.com/rs/711-RIA-145/images/2025.Annual.Survey.Report.pdf",
      verifiedAt: "2026-08-25",
      note: "A survey of self-reporting operators, not an audited census.",
    },
    {
      id: "e3",
      label: "Data Center Load Forecasting",
      publisher: "Energy and Environmental Economics (E3) — December 2025",
      url: "https://www.ethree.com/wp-content/uploads/2025/12/E3Whitepaper_DataCenterForecasting.pdf",
      verifiedAt: "2026-08-25",
      note: "A consultancy whitepaper; the PG&E telemetry figure is attributed to PG&E's own published analysis.",
    },
    {
      id: "pjm",
      label: "Board of Managers letter on the CIFP process — large load additions",
      publisher: "PJM Interconnection — 16 January 2026",
      url: "https://www.pjm.com/-/media/DotCom/about-pjm/who-we-are/public-disclosures/2026/20260116-pjm-board-letter-re-results-of-the-cifp-process-large-load-additions.pdf",
      verifiedAt: "2026-08-25",
    },
    {
      id: "crs",
      label: "Data Centers and Electricity Demand (R48646)",
      publisher: "Congressional Research Service — August 2025",
      url: "https://www.congress.gov/crs_external_products/R/PDF/R48646/R48646.3.pdf",
      verifiedAt: "2026-08-25",
      note: "The 100-1,000 MW range is CRS quoting an industry report, not a CRS measurement.",
    },
  ],
};

/**
 * Cited explainer for "what-is-an-ai-data-center". Every claim traces to a
 * source in `sources` below; quoted figures come from the source document,
 * not from the tracked dataset. Do not reword, add figures, or otherwise
 * "improve" this prose — each sentence is scoped to exactly what its cited
 * source supports.
 */
const AI_DATA_CENTER_EXPLAINER: GlossaryExplainer = {
  lede:
    "There is no technical standard that makes a building an \"AI data center.\" What separates these facilities from conventional ones is not the software running in them but a physical consequence of it: the racks draw far more power, and everything downstream of that — cooling, power delivery, where a site can be built at all — follows from the density.",
  sections: [
    {
      heading: "Density is the dividing line",
      evidence: "substantiated",
      sourceIds: ["uptime-2024", "nvidia"],
      exemplarIds: [],
      body: [
        "Conventional data center racks are modest consumers. The Uptime Institute's 2024 global survey of operators found that \"4 kW to 6 kW racks remain the most commonly deployed, consistent with previous years,\" and put the average across respondents at 7.1 kW once a handful of very high-density outliers were excluded. The same survey noted the emerging tail, with a few respondents \"reaching up to 100 kW or more.\"",
        "Purpose-built AI hardware sits in that tail by design. NVIDIA's own user guide for its DGX GB200 NVL72 system states that \"the rack power consumption is approximately 120kW\" — an order of magnitude above the survey's typical rack, in the same floor space. That figure describes one vendor's system and should not be read as what AI racks in general draw, but it establishes the scale the rest of the building has to be engineered around.",
      ],
    },
    {
      heading: "Density is why the cooling changes",
      evidence: "substantiated",
      sourceIds: ["uptime-cooling", "ashrae"],
      exemplarIds: [],
      body: [
        "Moving that much heat with air becomes progressively harder, and there are two different answers to where it stops being worth doing. Uptime Institute's 2025 cooling survey asked practitioners at what rack density \"air cooling becomes too costly or inefficient, making the use of direct liquid cooling necessary.\" Most put that threshold above 20 kW per rack. That is a measure of what operators believe about cost, not a physical limit.",
        "The physical limit sits higher, and is arithmetic rather than opinion. ASHRAE's technical committee for data center equipment notes that \"air flows of a 40 to 50 kW rack could be up to 5000 cfm,\" against a raised-floor delivery capacity where \"floor tile best-in-class is 1900 cfm.\" Past that point the air simply cannot be moved through the floor fast enough, whatever anyone is willing to spend. Conventional racks sit below both numbers; GPU-dense racks sit above both.",
      ],
    },
    {
      heading: "The term had a federal definition for about six months",
      evidence: "substantiated",
      sourceIds: ["eo-14141", "eo-14318"],
      exemplarIds: [],
      body: [
        "\"AI data center\" is usually described as marketing shorthand with no legal meaning. That is close to true now, but it was not always. Executive Order 14141, signed in January 2025, defined the term directly: \"the term 'AI data center' means a data center used primarily with respect to developing or operating AI.\"",
        "That order was revoked in July 2025 by Executive Order 14318, which states plainly: \"Executive Order 14141 of January 14, 2025 (Advancing United States Leadership in Artificial Intelligence Infrastructure), is hereby revoked.\" Its replacement does not use the phrase at all. It defines a differently-named category instead — a \"Data Center Project\" means \"a facility that requires greater than 100 megawatts (MW) of new load dedicated to AI inference, training, simulation, or synthetic data generation\" — trading a purpose-based definition for a threshold of scale attached to AI workloads.",
        "Both are directives to federal agencies about permitting, not zoning or tax classifications, so neither ever governed what a county calls a building. The practical position is that no stable federal definition of the phrase is currently in force, which is why any tracker has to publish the criteria it uses instead of pointing at one.",
      ],
    },
    {
      heading: "What this page does not show",
      evidence: "raised",
      sourceIds: [],
      exemplarIds: [],
      body: [
        "Because no standing definition exists, the AI classification recorded here is an editorial judgment made against public sources, not a certification. It is deliberately graded rather than binary: confirmed where a source establishes AI workloads directly, likely where the evidence is strong but indirect, and mixed use where a site runs AI alongside conventional workloads. A facility with no classification is one where the public record does not settle the question — not one that has been found to run no AI.",
        "Rack density, cooling method and installed hardware are rarely disclosed per site, so the physical markers described above are usually not verifiable for any individual facility from public sources. Where a cooling type is recorded here, it is because a source stated it.",
      ],
    },
  ],
  sources: [
    {
      id: "uptime-2024",
      label: "Global Data Center Survey 2024",
      publisher: "Uptime Institute — 2024",
      url: "https://datacenter.uptimeinstitute.com/rs/711-RIA-145/images/2024.GlobalDataCenterSurvey.Report.pdf",
      verifiedAt: "2026-08-25",
      note: "A survey of self-reporting operators, not a census.",
    },
    {
      id: "nvidia",
      label: "NVIDIA DGX GB200 Rack Scale Systems User Guide",
      publisher: "NVIDIA",
      url: "https://docs.nvidia.com/dgx/dgxgb200-user-guide/dgxgb200-user-guide.pdf",
      verifiedAt: "2026-08-25",
      note: "Vendor documentation, authoritative for this system only.",
    },
    {
      id: "uptime-cooling",
      label: "Data Center Cooling Systems Survey 2025",
      publisher: "Uptime Institute — July 2025",
      url: "https://intelligence.uptimeinstitute.com/sites/default/files/2025-07/UI%20Field%20181_Data%20center%20cooling.pdf",
      verifiedAt: "2026-08-25",
      note: "Reports what practitioners believe, not a measured engineering limit.",
    },
    {
      id: "ashrae",
      label: "Emergence and Expansion of Liquid Cooling in Mainstream Data Centers",
      publisher: "ASHRAE Technical Committee 9.9 — 2021",
      url: "https://tpc.ashrae.org/FileDownload?idx=fd72ec65-8595-4be6-9f1c-0aeed01ef424",
      verifiedAt: "2026-08-25",
    },
    {
      id: "eo-14141",
      label: "Executive Order 14141, Advancing United States Leadership in Artificial Intelligence Infrastructure",
      publisher: "Federal Register — January 2025 (revoked July 2025)",
      url: "https://www.federalregister.gov/documents/full_text/text/2025/01/17/2025-01395.txt",
      verifiedAt: "2026-08-25",
    },
    {
      id: "eo-14318",
      label: "Executive Order 14318, Accelerating Federal Permitting of Data Center Infrastructure",
      publisher: "Federal Register — July 2025",
      url: "https://www.federalregister.gov/documents/full_text/text/2025/07/28/2025-14212.txt",
      verifiedAt: "2026-08-25",
    },
  ],
};

/**
 * Cited explainer for "behind-the-meter-power". Every claim traces to a
 * source in `sources` below; quoted figures come from the source document,
 * not from the tracked dataset. Do not reword, add figures, or otherwise
 * "improve" this prose — each sentence is scoped to exactly what its cited
 * source supports.
 */
const BEHIND_THE_METER_EXPLAINER: GlossaryExplainer = {
  lede:
    "Behind-the-meter power is a wiring arrangement before it is anything else: generation on the customer's side of the utility's revenue meter, serving a load directly instead of through the transmission system. What makes it contentious is not the wiring but what follows from it — which charges a very large customer still owes, and what it may still rely on the grid to provide.",
  sections: [
    {
      heading: "What it means, and why the meaning is contested",
      evidence: "substantiated",
      sourceIds: ["ferc-er24-2172"],
      exemplarIds: [],
      body: [
        "The plain definition is narrow. In the proceeding over the largest such arrangement yet proposed in the United States, the generator's position was that \"behind-the-meter simply means not on the network\" — the load is not a transmission customer, so it does not pay for transmission service.",
        "What follows from that is the whole argument. The same filing held that the co-located load, \"being behind-the-meter, is not a Network Customer and has no right to be served by the grid,\" and that its retail service is outside federal jurisdiction. Objecting utilities read the same arrangement the opposite way. The term is settled; its consequences are not.",
      ],
    },
    {
      heading: "The appeal is speed",
      evidence: "substantiated",
      sourceIds: ["queued-up"],
      exemplarIds: [],
      body: [
        "Connecting new supply to the grid is slow and getting slower. Lawrence Berkeley National Laboratory's annual review of interconnection queues reports that \"the median project built in 2025 took 61 months from the interconnection request to commercial operations,\" against \"36 months in 2015 and 22 months in 2008.\" Most requests never arrive at all: \"about 19% of projects (13% of capacity) requesting interconnection from 2000-2020 reached commercial operations by the end of 2025.\"",
        "Those figures describe generators seeking to connect supply, not data centers seeking to connect load — the report states that \"there are separate queues for large loads and those are not included in this report.\" They are cited here for what they do show: the timeline for bringing new grid-connected generation online, which is the alternative that building on-site is measured against.",
      ],
    },
    {
      heading: "Behind the meter is not off the grid",
      evidence: "substantiated",
      sourceIds: ["ferc-er24-2172"],
      exemplarIds: ["talen-susquehanna-aws-pa"],
      body: [
        "A genuinely islanded site has no grid connection at all. Most arrangements described as behind-the-meter are not islanded: they keep an interconnection for backup or supplemental supply, and that retained connection is what makes the cost question arguable.",
        "The flagship case is explicit about it. PJM's filing \"contains a new section addressing use of a back-up unit at the Customer Facility to transfer power to the transmission facilities of the Co-Located Load,\" with coordination and \"advanced authorization from PJM\" required before any such transfer. Objecting utilities pressed the point from the other direction, noting that \"the nuclear power plants cannot operate without electricity and cannot be islanded from the system.\" A site can be behind the meter and still be entangled with the grid in both directions.",
      ],
    },
    {
      heading: "What the regulator actually decided",
      evidence: "substantiated",
      sourceIds: ["ferc-er24-2172"],
      exemplarIds: ["talen-susquehanna-aws-pa"],
      body: [
        "In November 2024 the Federal Energy Regulatory Commission rejected an amended interconnection agreement that would have increased co-located load at the Susquehanna nuclear station \"from 300 megawatts (MW) to 480 MW.\" The order is short about the outcome — \"in this order, we reject the Amended ISA\" — and its stated ground is that \"PJM has not met its burden\" of justifying a non-conforming agreement.",
        "That is a procedural finding, and it is worth being precise about what it does not say. The Commission did not rule that co-location shifts costs to other ratepayers. That claim was made by protesting utilities: \"Exelon and AEP contend that the cost shift arising from this arrangement could be as much as $140 million per year,\" calculated from the cost of serving 480 MW at a 98% load factor under a retail tariff rate. It was contested on the record — \"Susquehanna asserts that Exelon and AEP's claim of $140 million in consumer harm is not accurate.\" The decision was 2-1. The substantive question of how co-located load should be charged was left open.",
      ],
    },
    {
      heading: "Behind the meter is not the same as clean",
      evidence: "substantiated",
      sourceIds: [],
      exemplarIds: ["xai-colossus-memphis-tn", "meta-middleton-township-oh", "fermi-matador-amarillo-tx"],
      body: [
        "The term describes where the meter sits, not what the fuel is. On-site generation for data centers includes nuclear power purchase agreements at one end and gas turbines and reciprocating engines at the other, and in the tracked record the fossil-fuelled cases are the ones that generate local objection.",
        "The facilities below illustrate the range of what \"behind the meter\" has meant in practice — an on-site gas plant approved without public hearings, a turbine fleet permitted well below the number installed, and a proposed installation whose air permit drew hundreds of comments. Moving generation behind the meter also moves it out of some of the review that grid-connected supply attracts, which is a recurring objection in the record independent of the fuel.",
      ],
    },
    {
      heading: "What this page does not show",
      evidence: "raised",
      sourceIds: [],
      exemplarIds: [],
      body: [
        "Compute Atlas records a dedicated generation project where a public source establishes one, together with its offtaker where that is disclosed. Many arrangements are commercial contracts rather than construction projects and leave no permit trail, so the tracked set understates how much generation is contracted to serve data centers.",
        "Whether a given site is truly islanded or retains a grid connection is rarely stated in public sources, and the distinction is the one Section 3 turns on. Where it is not recorded here, it is not known — not assumed either way.",
      ],
    },
  ],
  sources: [
    {
      id: "ferc-er24-2172",
      label: "Order rejecting amended interconnection service agreement, Docket No. ER24-2172",
      publisher: "Federal Energy Regulatory Commission — 1 November 2024",
      url: "https://www.ferc.gov/sites/default/files/2024-11/20241101-3061_ER24-2172-000.pdf",
      verifiedAt: "2026-08-25",
      note: "Rejected on procedural grounds; the order does not decide the cost-allocation question. Decided 2-1.",
    },
    {
      id: "queued-up",
      label: "Queued Up: 2026 Edition — Characteristics of Power Plants Seeking Transmission Interconnection",
      publisher: "Lawrence Berkeley National Laboratory, via the DOE Office of Scientific and Technical Information — 2026",
      url: "https://www.osti.gov/servlets/purl/3376147",
      verifiedAt: "2026-08-25",
      note: "Covers generator interconnection only; large-load queues are explicitly excluded.",
    },
  ],
};

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

/**
 * Cited explainer for "why-connect-to-the-grid". Every claim traces to a
 * source in `sources` below; quoted figures come from the source document,
 * not from the tracked dataset. Do not reword, add figures, or otherwise
 * "improve" this prose — each sentence is scoped to exactly what its cited
 * source supports.
 */
const WHY_CONNECT_TO_THE_GRID_EXPLAINER: GlossaryExplainer = {
  lede:
    "A site that builds its own power plant and a site that connects to the grid are usually described as if they were alternatives. In the record, they are not — most large on-site generation arrangements do both, and the two decisions interact: what a site builds affects how fast it can connect, and how it connects decides who pays for the wires. What follows is what the cited sources establish about that arrangement, and where the record runs out.",
  sections: [
    {
      heading: "A worked example: Project Evest in Louisiana",
      evidence: "substantiated",
      sourceIds: ["lpsc-evest"],
      exemplarIds: ["entergy-pointe-coupee-cccts-la"],
      body: [
        "The clearest documented case of a large AI customer arranging for new dedicated-looking generation is Entergy Louisiana's Project Evest filing, submitted to the Louisiana Public Service Commission in March 2026. Entergy proposed seven new combustion turbine generators plus battery storage tied to a new large customer — but the filing does not describe that generation as dedicated to the customer. Asked directly whether the new plants' output would be devoted to the customer, Entergy testified: \"Each of the seven new CCCTs is expected to have a nameplate capacity of 754 MW. As to whether the output from the new CCCTs will be devoted to the Customer, the new CCCTs are being built to serve ELL's total system load in the future, which will include the load of this new customer. These new CCCTs will be a part of ELL's overall generation-resource portfolio, and ELL is seeking approval of the CCCTs as system resources.\" Entergy made the same claim for the co-located battery storage.",
        "Entergy also testified that it needs the added capacity independent of this one customer, citing its own separate dockets for other generation: \"projected load (plus a planning reserve margin) exceeds the capacity of ELL's existing and LPSC-approved resources, which indicates a need for additional long-term capacity, and this need exists independent of the anticipated load associated with Project Evest.\" In this filing, building new generation and staying connected to the grid are not two competing options — the new plants join the utility's dispatchable fleet, and the grid connection is how their output (and everyone else's) actually gets delivered.",
      ],
    },
    {
      heading: "Owning generation can mean a shorter path onto the grid",
      evidence: "substantiated",
      sourceIds: ["orrick", "lpsc-evest"],
      body: [
        "One reason developers pursue on-site generation at all is speed. A law firm's guide to data-center power describes the trade-off developers weigh: \"Connecting hyperscale data center load to the interstate transmission grid is an increasingly complex, costly, and time-consuming process. Developers must carefully weigh the trade-offs between direct interconnection as a 'network load' and pairing with behind-the-meter generation.\" The same guide states that \"co-located generation provides enhanced reliability and may accelerate energization by enabling the data center to interconnect using the generator's existing or pending interconnection agreement.\"",
        "One specific mechanism it describes is reusing an existing generator's interconnection rights rather than applying for new ones: \"where an aging coal plant operates at only 20% capacity, a developer may co-locate a new solar plant to supply the remaining interconnection capacity. By attaching to an existing interconnection agreement, the solar plant skips the interconnection queue.\" That queue is the generator interconnection queue — the process a power plant goes through to connect its own output to the grid — not a separate queue for data centers; the data center benefits indirectly, by co-locating with a generator that already holds a place in line.",
        "Louisiana's Project Evest filing documents a related shortcut for genuinely new generation: some of Entergy's proposed plants were routed through an expedited study track rather than the standard queue. Entergy testified that \"all four of those CCCT generators were submitted to MISO pursuant to its Expedited Resource Addition Study ('ERAS') process, which is a temporary process used by MISO for expediting the study and approval of interconnection projects needed for resource adequacy and/or reliability needs.\" This, too, is a faster route through a generator queue, not a bypass of the grid connection itself.",
      ],
    },
    {
      heading: "Why connect to the grid at all, if you already have your own power",
      evidence: "substantiated",
      sourceIds: ["unison", "utility-dive"],
      body: [
        "Building on-site generation is not the same as leaving the grid. A microgrid vendor's account of how these arrangements work in practice states plainly that on-site generation and a utility connection are usually meant to run together, not as alternatives: \"data center developers could use microgrids concurrently with utility power as mechanical power load, back-up power supply during outages, and excess power exports.\" On that account, a site with its own plant still connects to the grid to draw supplemental power alongside its own generation, to fall back on during an outage, and in some cases to sell surplus power back.",
        "Federal regulators have described wanting similar flexibility built into how the grid itself is planned. Utility Dive, reporting on FERC's approach to data-center interconnection, quoted Commissioner Judy Chang describing plans that \"contemplate running the system 'tighter' than we have done in the past, potentially with more loads on the system served by co-located or behind-the-meter generation, and potentially more use of batteries, load control systems, and backup resources to manage demand during system peaks or other stressed conditions.\" That description comes from Utility Dive's reporting of the Commissioner's remarks, not from the text of a FERC order.",
      ],
    },
    {
      heading: "Who pays for the wires depends on how a site connects",
      evidence: "substantiated",
      sourceIds: ["ferc-pjm-order", "lpsc-evest"],
      body: [
        "How a large load connects to the grid also decides who is on the hook for new transmission investment, and federal regulators have started to write that decision down explicitly — for one region. In December 2025, FERC ordered PJM, the grid operator for the mid-Atlantic and part of the Midwest, to require that a co-located load's customer of record take one of three defined services: \"we direct PJM to modify its Tariff to require that the Eligible Customer taking transmission service on behalf of the Co-Located Load takes one of three transmission services: (1) Network Integration Transmission Service (NITS), (2) a new Firm Contract Demand transmission service, or (3) a new Non-Firm Contract Demand transmission service.\" The order adds that \"we establish a paper hearing to determine the just and reasonable rates, terms, and conditions for these new transmission services\" — the specific rates were still an open question when the order issued, not a settled figure.",
        "The Commission's stated reason was cost allocation. It found that PJM's existing behind-the-meter generation rules \"are no longer just and reasonable because loads with BTMG are not fully accounted for in resource adequacy planning and shift costs onto other transmission customers contrary to the Commission's cost causation principles\" — the principle that, as the order states, rates must \"reflect to some degree the costs actually caused by the customer who must pay for them.\" FERC has ordered PJM specifically to fix this. The order does not extend to other grid operators, and Project Evest's utility sits in a different one: Entergy Louisiana is in MISO, not PJM.",
        "Louisiana applies its own version of the same cost-causation principle at the state level, separately from PJM's order. Entergy's Project Evest filing states that guidelines there \"require that ELL identify all required transmission upgrades that need to be constructed or have their planned construction accelerated due to the new load,\" and that ELL must demonstrate \"(1) network and interconnection costs caused by the load are fully assigned to the load, (2) no material transmission costs are shifted to existing customers that they otherwise might not bear or for which they do not receive commensurate benefits, and (3) upgrade timelines are consistent with the load ramp.\" It is the same underlying question FERC's order addresses for PJM — who pays for the wires — answered by a separate state rule, not by FERC's PJM order applied elsewhere.",
      ],
    },
    {
      heading: "What this page does not show",
      evidence: "raised",
      sourceIds: [],
      body: [
        "The FERC order above governs PJM only, and as of the order's issue date the specific rates for the three new transmission services were set for a future hearing, not yet decided. Nothing here establishes what those rates turned out to be, or whether another grid operator has adopted a comparable rule.",
        "Project Evest is one utility's filing in one state. It documents how Entergy Louisiana chose to build and justify new generation for one customer; it is not evidence of how other utilities structure comparable arrangements elsewhere. A national figure for how much time an existing interconnection right typically saves, or how many projects use one, was not available from any source consulted for this page.",
      ],
    },
  ],
  sources: [
    {
      id: "lpsc-evest",
      label: "Direct Testimony of Laura K. Beauchamp, Application for Certification of Generation and Transmission Resources (Project Evest), Public Redacted Version",
      publisher: "Entergy Louisiana, LLC, filed with the Louisiana Public Service Commission — March 2026",
      url: "https://lpscpubvalence.lpsc.louisiana.gov/portal/PSC/ViewFile?fileId=kt5JixLAYFY%3D",
      verifiedAt: "2026-09-01",
    },
    {
      id: "orrick",
      label: "Powering Data Centers | Megawatts to Megabytes: Orrick's Guide to Developing, Financing & Powering Data Centers",
      publisher: "Orrick, Herrington & Sutcliffe LLP — November 2025",
      url: "https://www.orrick.com/en/Insights/2025/11/Powering-Data-Centers",
      verifiedAt: "2026-09-01",
      note: "A law firm's client-development content — informed, but marketing-adjacent.",
    },
    {
      id: "unison",
      label: "How Data Centers Use Microgrids After Utility Interconnection",
      publisher: "Unison Energy",
      url: "https://unisonenergy.com/resources/blog/onsite-generation-part-of-the-power-stack/",
      verifiedAt: "2026-09-01",
      note: "A microgrid vendor's blog — a commercial interest in the arrangement it describes.",
    },
    {
      id: "utility-dive",
      label: "6 takeaways from FERC's data center interconnection decision",
      publisher: "Utility Dive",
      url: "https://www.utilitydive.com/news/ferc-doe-data-center-interconnection/823360/",
      verifiedAt: "2026-09-01",
      note: "The Commissioner Chang quote is this article's reporting; it was not located verbatim in a primary FERC order document.",
    },
    {
      id: "ferc-pjm-order",
      label: "PJM Interconnection, L.L.C., 193 FERC ¶ 61,217, Docket No. EL25-49-000 (Co-Location Order), Dec. 18, 2025",
      publisher: "Federal Energy Regulatory Commission",
      url: "https://www.gravel2gavel.com/files/2025/12/E-1-EL25-49-000.pdf",
      verifiedAt: "2026-09-01",
      note: "The copy cited is a third-party law-firm mirror; ferc.gov and elibrary.ferc.gov both returned errors when fetched directly.",
    },
  ],
};

export const GLOSSARY_TOPICS: GlossaryTopic[] = [
  {
    slug: "data-center-water-use",
    title: "How much water does a data center use?",
    dek: "Cooling a large data center can consume millions of gallons of water a year — here's how facility-level water use is tracked and reported.",
    explainer: WATER_USE_EXPLAINER,
  },
  {
    slug: "data-center-power-draw",
    title: "How much power does a data center draw?",
    dek: "From megawatts of critical IT load to gigawatt-scale campuses — a breakdown of how data center power draw is measured and reported.",
    explainer: POWER_DRAW_EXPLAINER,
  },
  {
    slug: "what-is-an-ai-data-center",
    title: "What is an AI data center?",
    dek: "AI data centers are purpose-built for GPU-dense training and inference workloads — how they differ from traditional cloud and colocation facilities.",
    explainer: AI_DATA_CENTER_EXPLAINER,
  },
  {
    slug: "behind-the-meter-power",
    title: "What is behind-the-meter power?",
    dek: "Some data centers generate their own power on-site rather than drawing entirely from the grid — what \"behind-the-meter\" means and why it's growing.",
    explainer: BEHIND_THE_METER_EXPLAINER,
  },
  {
    slug: "why-do-communities-oppose-data-centers",
    title: "Why do communities oppose data centers?",
    dek: "Noise, water use, land, and grid strain — the recurring reasons local communities push back on proposed data center projects.",
    explainer: WHY_COMMUNITIES_OPPOSE_EXPLAINER,
  },
  {
    slug: "why-connect-to-the-grid",
    title: "If a data center builds its own power plant, why does it still connect to the grid?",
    dek: "On-site generation and a grid connection are usually not alternatives — the record shows both together, and how a site connects decides who pays for the wires.",
    explainer: WHY_CONNECT_TO_THE_GRID_EXPLAINER,
  },
];

export function getGlossaryTopicBySlug(slug: string): GlossaryTopic | undefined {
  return GLOSSARY_TOPICS.find((t) => t.slug === slug);
}
