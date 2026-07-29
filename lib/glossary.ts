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
 */

export interface GlossaryTopic {
  slug: string;
  title: string;
  dek: string;
}

export const GLOSSARY_TOPICS: GlossaryTopic[] = [
  {
    slug: "data-center-water-use",
    title: "How Much Water Does a Data Center Use?",
    dek: "Cooling a large data center can consume millions of gallons of water a year — here's how facility-level water use is tracked and reported.",
  },
  {
    slug: "data-center-power-draw",
    title: "How Much Power Does a Data Center Draw?",
    dek: "From megawatts of critical IT load to gigawatt-scale campuses — a breakdown of how data center power draw is measured and reported.",
  },
  {
    slug: "what-is-an-ai-data-center",
    title: "What Is an AI Data Center?",
    dek: "AI data centers are purpose-built for GPU-dense training and inference workloads — how they differ from traditional cloud and colocation facilities.",
  },
  {
    slug: "behind-the-meter-power",
    title: "What Is Behind-the-Meter Power?",
    dek: "Some data centers generate their own power on-site rather than drawing entirely from the grid — what \"behind-the-meter\" means and why it's growing.",
  },
  {
    slug: "why-do-communities-oppose-data-centers",
    title: "Why Do Communities Oppose Data Centers?",
    dek: "Noise, water use, land, and grid strain — the recurring reasons local communities push back on proposed data center projects.",
  },
];

export function getGlossaryTopicBySlug(slug: string): GlossaryTopic | undefined {
  return GLOSSARY_TOPICS.find((t) => t.slug === slug);
}
