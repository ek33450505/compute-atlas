import { describe, it, expect } from "vitest";

import {
  bucketFor,
  buildReport,
  isDead,
  knownHostFor,
  joinLiveness,
  normalizeHost,
  parseArgs,
  renderMarkdown,
  singleSourceDependency,
} from "./citation-readability-report";
import type { FacilityLike, LivenessResult } from "./citation-readability-report";

/** Fixture-only: never reads data/facilities.json. */
function fac(id: string, ...urls: string[]): FacilityLike {
  return { id, name: id, sources: urls.map((url) => ({ url, kind: "news" })) };
}

function live(url: string, classification: string, errorCode?: string): LivenessResult {
  return { url, classification, errorCode };
}

describe("normalizeHost", () => {
  it("lowercases and strips a leading www.", () => {
    expect(normalizeHost("https://WWW.Example.COM/a")).toBe("example.com");
  });
  it("keeps other subdomains (hosts, not registrable domains)", () => {
    expect(normalizeHost("https://news.example.com/")).toBe("news.example.com");
  });
  it("returns null for garbage", () => {
    expect(normalizeHost("not a url")).toBeNull();
  });
});

describe("bucketFor precedence", () => {
  it("non_document wins over everything", () => {
    expect(bucketFor({ url: "https://www.openstreetmap.org/way/1", kind: "osm" })).toBe("non_document");
  });
  it("archive outranks the curated list", () => {
    expect(bucketFor({ url: "https://web.archive.org/web/2024/https://www.hanfordsentinel.com/a" })).toBe("archive");
  });
  it("pdf outranks the curated list", () => {
    expect(bucketFor({ url: "https://www.arkansasonline.com/files/x.PDF" })).toBe("pdf");
  });
  it("curated excluded and readable hosts", () => {
    expect(bucketFor({ url: "https://www.hanfordsentinel.com/news/a" })).toBe("known_excluded");
    expect(bucketFor({ url: "https://www.arkansasonline.com/news/a" })).toBe("known_excluded");
    expect(bucketFor({ url: "https://cleanview.co/x" })).toBe("known_excluded");
    expect(bucketFor({ url: "https://baxtel.com/data-center/x" })).toBe("unclassified");
    expect(bucketFor({ url: "https://measuredai.substack.com/p/x" })).toBe("known_marker_false_positive");
  });
  it("does not match a lookalike host", () => {
    expect(bucketFor({ url: "https://evilhanfordsentinel.com/x" })).toBe("unclassified");
  });
  it("everything else is unclassified", () => {
    expect(bucketFor({ url: "https://example.org/story" })).toBe("unclassified");
  });
});

describe("knownHostFor", () => {
  it("matches a subdomain of a curated host", () => {
    expect(knownHostFor("news.pinalpost.com")?.host).toBe("pinalpost.com");
  });
  it("does not match a lookalike suffix", () => {
    expect(knownHostFor("notpinalpost.com")).toBeUndefined();
  });
});

describe("liveness", () => {
  it("keeps the most severe result per URL", () => {
    const m = joinLiveness([live("https://a.com", "ok"), live("https://a.com", "gone"), live("https://a.com", "redirected")]);
    expect(m.get("https://a.com")?.classification).toBe("gone");
  });
  it("dead means gone or ENOTFOUND, not bot_blocked or timeout", () => {
    expect(isDead(live("u", "gone"))).toBe(true);
    expect(isDead(live("u", "error", "ENOTFOUND"))).toBe(true);
    expect(isDead(live("u", "error", "EREFUSED"))).toBe(false);
    expect(isDead(live("u", "bot_blocked"))).toBe(false);
    expect(isDead(live("u", "timeout"))).toBe(false);
    expect(isDead(undefined)).toBe(false);
  });
});

describe("singleSourceDependency", () => {
  const dead = "https://dead.example.com/a";
  const lv = joinLiveness([live(dead, "gone")]);
  const ids = (r: { dependent: { id: string }[] }) => r.dependent.map((f) => f.id);

  it("flags a facility whose only document source is known_excluded", () => {
    const out = singleSourceDependency([fac("f1", "https://www.hanfordsentinel.com/a")], null);
    expect(ids(out)).toEqual(["f1"]);
    expect(out.dependent[0].reasons[0].why).toBe("known_excluded");
  });
  it("does not flag when one document source is not excluded", () => {
    expect(singleSourceDependency([fac("f1", "https://www.hanfordsentinel.com/a", "https://example.org/b")], null).dependent).toEqual([]);
  });
  it("ignores non_document sources when deciding", () => {
    const f: FacilityLike = {
      id: "f1",
      sources: [
        { url: "https://www.hanfordsentinel.com/a", kind: "news" },
        { url: "https://www.openstreetmap.org/way/1", kind: "osm" },
      ],
    };
    expect(ids(singleSourceDependency([f], null))).toEqual(["f1"]);
  });
  it("flags a dead URL only when liveness is joined", () => {
    expect(ids(singleSourceDependency([fac("f1", dead)], lv))).toEqual(["f1"]);
    expect(singleSourceDependency([fac("f1", dead)], null).dependent).toEqual([]);
  });
  it("treats a URL liveness did not check as not dead", () => {
    expect(singleSourceDependency([fac("f1", "https://other.example.com/x")], lv).dependent).toEqual([]);
  });
  it("flags a dead URL whose archive copy is itself marked gone by liveness", () => {
    const snap = `https://web.archive.org/web/20240101/${dead}`;
    const both = joinLiveness([live(dead, "gone"), live(snap, "gone")]);
    expect(ids(singleSourceDependency([fac("f1", dead, snap)], both))).toEqual(["f1"]);
  });
  it("an archive snapshot beside a dead URL clears the facility", () => {
    const f = fac("f1", dead, `https://web.archive.org/web/20240101/${dead}`);
    expect(singleSourceDependency([f], lv).dependent).toEqual([]);
  });
  it("lists a facility with only non_document sources under noDocumentSource", () => {
    const f: FacilityLike = { id: "f1", name: "F One", sources: [{ url: "https://www.openstreetmap.org/way/1", kind: "osm" }] };
    const out = singleSourceDependency([f], lv);
    expect(out.dependent).toEqual([]);
    expect(out.noDocumentSource).toEqual([{ id: "f1", name: "F One" }]);
    const r = buildReport([f], lv);
    expect(r.noDocumentSource).toHaveLength(1);
    expect(renderMarkdown(r)).toContain("No document source (1 facilities)");
  });
});

describe("buildReport / renderMarkdown", () => {
  const facilities = [
    fac("f1", "https://www.example.org/a", "https://example.org/a", "https://baxtel.com/x"),
    fac("f2", "https://example.org/b", "https://www.hanfordsentinel.com/z"),
  ];

  it("counts totals, distinct URLs, hosts and facilities", () => {
    const r = buildReport(facilities, null);
    expect(r.totals).toMatchObject({ urls: 5, distinctUrls: 5, hosts: 3, facilities: 2 });
    const org = r.hosts.find((h) => h.host === "example.org");
    expect(org).toMatchObject({ urls: 3, facilities: 2, bucket: "unclassified" });
    expect(r.hosts[0].host).toBe("example.org");
  });
  it("counts an unparseable URL as unparseable without crashing", () => {
    const r = buildReport([fac("f1", "not a url", "https://example.org/a")], null);
    expect(r.totals).toMatchObject({ urls: 2, unparseableUrls: 1, hosts: 1 });
  });
  it("says liveness is not joined when no report is given", () => {
    expect(renderMarkdown(buildReport(facilities, null))).toContain("liveness: not joined");
  });
  it("joins liveness per host, marking unchecked URLs", () => {
    const lv = joinLiveness([live("https://example.org/b", "bot_blocked")]);
    const r = buildReport(facilities, lv, "x.json");
    const org = r.hosts.find((h) => h.host === "example.org");
    expect(org?.liveness).toEqual({ bot_blocked: 1, not_checked: 2 });
    expect(r.livenessCoverage).toEqual({ distinctUrlsWithResult: 1, distinctUrls: 5 });
  });
  it("ranks unclassified hosts by facility count and excludes curated hosts", () => {
    const r = buildReport(facilities, null);
    expect(r.topUnclassifiedHostsByFacilities.map((h) => h.host)).toEqual(["example.org", "baxtel.com"]);
  });
});

describe("parseArgs", () => {
  it("defaults to data/facilities.json and discovery-logs", () => {
    const a = parseArgs([], "/w");
    expect(a.facilities).toBe("/w/data/facilities.json");
    expect(a.outDir).toBe("/w/discovery-logs");
    expect(a.liveness).toBeNull();
  });
  it("reads flags and rejects unknown or valueless ones", () => {
    expect(parseArgs(["--liveness", "l.json", "--out-dir", "o"], "/w")).toMatchObject({ liveness: "/w/l.json", outDir: "/w/o" });
    expect(() => parseArgs(["--bogus"], "/w")).toThrow();
    expect(() => parseArgs(["--facilities"], "/w")).toThrow();
  });
});
