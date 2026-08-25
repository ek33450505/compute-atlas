import { describe, it, expect } from "vitest";
import { GLOSSARY_TOPICS, getGlossaryTopicBySlug } from "@/lib/glossary";

describe("GLOSSARY_TOPICS", () => {
  it("has exactly 5 curated topics", () => {
    expect(GLOSSARY_TOPICS).toHaveLength(5);
  });

  it("has unique slugs", () => {
    const slugs = GLOSSARY_TOPICS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("includes exactly the 5 expected slugs", () => {
    const slugs = GLOSSARY_TOPICS.map((t) => t.slug).sort();
    expect(slugs).toEqual(
      [
        "behind-the-meter-power",
        "data-center-power-draw",
        "data-center-water-use",
        "what-is-an-ai-data-center",
        "why-do-communities-oppose-data-centers",
      ].sort()
    );
  });

  it("every topic has a non-empty title and dek", () => {
    for (const topic of GLOSSARY_TOPICS) {
      expect(topic.title.length).toBeGreaterThan(0);
      expect(topic.dek.length).toBeGreaterThan(0);
    }
  });
});

describe("getGlossaryTopicBySlug", () => {
  it("returns the topic for a known slug", () => {
    const topic = getGlossaryTopicBySlug("data-center-water-use");
    expect(topic).toBeDefined();
    expect(topic?.title).toBe("How much water does a data center use?");
  });

  it("returns undefined for an unknown slug", () => {
    expect(getGlossaryTopicBySlug("not-a-real-topic")).toBeUndefined();
  });
});
