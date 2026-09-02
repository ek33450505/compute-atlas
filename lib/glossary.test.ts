import { describe, it, expect } from "vitest";
import { GLOSSARY_TOPICS, getGlossaryTopicBySlug } from "@/lib/glossary";

describe("GLOSSARY_TOPICS", () => {
  it("has exactly 6 curated topics", () => {
    expect(GLOSSARY_TOPICS).toHaveLength(6);
  });

  it("has unique slugs", () => {
    const slugs = GLOSSARY_TOPICS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("includes exactly the 6 expected slugs", () => {
    const slugs = GLOSSARY_TOPICS.map((t) => t.slug).sort();
    expect(slugs).toEqual(
      [
        "behind-the-meter-power",
        "data-center-power-draw",
        "data-center-water-use",
        "what-is-an-ai-data-center",
        "why-connect-to-the-grid",
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

describe("GlossaryExplainer content", () => {
  it("every topic has an explainer", () => {
    for (const topic of GLOSSARY_TOPICS) {
      expect(topic.explainer).toBeDefined();
    }
  });

  it("every explainer has a non-empty lede", () => {
    for (const topic of GLOSSARY_TOPICS) {
      expect(topic.explainer?.lede.length).toBeGreaterThan(0);
    }
  });

  it("every explainer has at least one section", () => {
    for (const topic of GLOSSARY_TOPICS) {
      expect(topic.explainer?.sections.length).toBeGreaterThan(0);
    }
  });

  it("every section has a non-empty heading and at least one body paragraph", () => {
    for (const topic of GLOSSARY_TOPICS) {
      for (const section of topic.explainer?.sections ?? []) {
        expect(section.heading.length).toBeGreaterThan(0);
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) {
          expect(paragraph.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every section's sourceIds resolve to a source id in that explainer's own sources array", () => {
    for (const topic of GLOSSARY_TOPICS) {
      const explainer = topic.explainer;
      if (!explainer) continue;
      const sourceIds = new Set(explainer.sources.map((source) => source.id));
      for (const section of explainer.sections) {
        for (const id of section.sourceIds) {
          expect(sourceIds.has(id)).toBe(true);
        }
      }
    }
  });

  it("every source id within an explainer is unique", () => {
    for (const topic of GLOSSARY_TOPICS) {
      const ids = topic.explainer?.sources.map((source) => source.id) ?? [];
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every source has a non-empty label, publisher, url and verifiedAt", () => {
    for (const topic of GLOSSARY_TOPICS) {
      for (const source of topic.explainer?.sources ?? []) {
        expect(source.label.length).toBeGreaterThan(0);
        expect(source.publisher.length).toBeGreaterThan(0);
        expect(source.url.length).toBeGreaterThan(0);
        expect(source.verifiedAt.length).toBeGreaterThan(0);
      }
    }
  });

  // Shape pin. The assertions above are all "at least one" / "non-empty", which
  // means a section silently deleted from an explainer passes every one of them
  // — the page renders one fewer section and the loops simply iterate one fewer
  // time. Pinning the counts is what makes that deletion fail a test. These
  // numbers are editorial decisions: changing one should be a deliberate edit
  // here, not a side effect somewhere else.
  it("each explainer has exactly the published number of sections and sources", () => {
    const EXPECTED: Record<string, { sections: number; sources: number }> = {
      "data-center-water-use": { sections: 6, sources: 7 },
      "data-center-power-draw": { sections: 7, sources: 7 },
      "what-is-an-ai-data-center": { sections: 4, sources: 6 },
      "behind-the-meter-power": { sections: 6, sources: 2 },
      "why-do-communities-oppose-data-centers": { sections: 8, sources: 6 },
      "why-connect-to-the-grid": { sections: 5, sources: 5 },
    };

    // Every topic must appear in the table, so a newly added topic cannot slip
    // through unpinned.
    expect(Object.keys(EXPECTED).sort()).toEqual(
      GLOSSARY_TOPICS.map((t) => t.slug).sort()
    );

    for (const topic of GLOSSARY_TOPICS) {
      const expected = EXPECTED[topic.slug];
      expect({
        slug: topic.slug,
        sections: topic.explainer?.sections.length,
        sources: topic.explainer?.sources.length,
      }).toEqual({ slug: topic.slug, ...expected });
    }
  });

  it("every declared source is cited by at least one section", () => {
    for (const topic of GLOSSARY_TOPICS) {
      const explainer = topic.explainer;
      if (!explainer) continue;
      const cited = new Set(explainer.sections.flatMap((s) => s.sourceIds));
      for (const source of explainer.sources) {
        expect({ slug: topic.slug, id: source.id, cited: cited.has(source.id) }).toEqual({
          slug: topic.slug,
          id: source.id,
          cited: true,
        });
      }
    }
  });
});
