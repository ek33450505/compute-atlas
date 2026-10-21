import { describe, it, expect } from "vitest";

import { httpUrlSchema, hasUnstorableChars, storableText } from "@/lib/intake-fields";
import { contributeInputSchema } from "@/lib/contribute";
import { leadInputSchema } from "@/lib/leads";
import { contactInputSchema } from "@/lib/contact";
import { subscribeInputSchema } from "@/lib/subscribe";
import { z } from "zod";

const PUBLIC_MESSAGE =
  "Use a link to a public web page, without a username, IP address or local host name.";

describe("httpUrlSchema", () => {
  it.each([
    "https://example.com/article",
    "http://example.com/a/b?x=1&y=two#frag",
    "https://example.com/caf%C3%A9%20menu?q=a%20b",
    "https://www.example.co.uk:8443/path",
    "https://gis.example.gov:6443/arcgis/rest/services",
    "https://example.com./trailing-dot",
    "https://example.com/caf\u00e9/\ud83d\ude00?q=\ud83d\ude00",
  ])("accepts %s", (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    ["NUL byte", "https://x.org/\u0000"],
    ["tab", "https://x.org/a\tb"],
    ["DEL", "https://x.org/\u007f"],
    ["userinfo", "https://a.com@evil.com/"],
    ["userinfo with password", "https://user:pw@example.com/"],
    ["IPv4 literal", "http://169.254.169.254/latest/meta-data/"],
    ["loopback IP with port", "http://127.0.0.1:8080/"],
    ["decimal IPv4", "http://2130706433/"],
    ["hex IPv4", "http://0x7f.1/"],
    ["IPv6 literal", "http://[::1]/"],
    ["localhost", "http://localhost/"],
    ["subdomain of localhost", "http://app.localhost/"],
    ["single label", "http://intranet/"],
    [".local", "http://printer.local/"],
    [".internal", "http://svc.internal/"],
    [".home.arpa", "http://nas.home.arpa/"],
    [".lan", "http://box.lan/"],
    [".lan trailing dots", "http://box.lan../"],
    [".corp", "http://box.corp/"],
    [".corp trailing dots", "http://box.corp../"],
    [".intranet", "http://box.intranet/"],
    [".intranet trailing dots", "http://box.intranet../"],
    [".private", "http://box.private/"],
    [".private trailing dots", "http://box.private../"],
    [".home", "http://box.home/"],
    [".home trailing dots", "http://box.home../"],
    ["lone high surrogate in path", "https://a.com/\ud800x"],
    ["lone low surrogate in path", "https://a.com/\udc00x"],
    ["lone high surrogate in query", "https://a.com/p?q=\ud800"],
    ["lone low surrogate in query", "https://a.com/p?q=\udc00x"],
    [".localdomain", "http://box.localdomain/"],
    [".localdomain trailing dots", "http://box.localdomain../"],
    [".arpa", "http://1.0.0.10.in-addr.arpa/"],
    [".home.arpa trailing dots", "http://nas.home.arpa../"],
    ["punycode host", "https://xn--80ak6aa92e.com/"],
    ["non-ASCII host (Cyrillic a)", "https://ex\u0430mple.com/"],
    ["trailing dots on localhost", "http://localhost../"],
    ["trailing dots on IPv4", "http://127.0.0.1../"],
    ["trailing dots on .internal", "http://svc.internal../"],
    ["trailing dots on single label", "http://intranet../"],
    ["empty label", "https://a..b.com/"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["unspecified address", "http://0.0.0.0/"],
    ["percent-encoded localhost", "http://%6c%6fcalhost/"],
    ["uppercase LOCALHOST", "http://LOCALHOST/"],
    ["backslash userinfo", "https://a.com\\@b.com/"],
    ["punycode subdomain label", "https://xn--e1afmkfd.example.com/"],
  ])("rejects %s", (_name, url) => {
    const result = httpUrlSchema.safeParse(url);
    expect(result.success).toBe(false);
  });

  it.each(["  https://example.com/a  ", "https://example.com/a\n", "\thttps://example.com/a"])(
    "trims surrounding whitespace: %j",
    (url) => {
      const result = httpUrlSchema.safeParse(url);
      expect(result.success).toBe(true);
      expect(result.data).toBe("https://example.com/a");
    }
  );

  it("rejects an interior newline", () => {
    expect(httpUrlSchema.safeParse("https://example.com/a\nb").success).toBe(false);
  });

  it("reports the public-facing message for a host-class rejection", () => {
    const result = httpUrlSchema.safeParse("http://127.0.0.1/");
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(PUBLIC_MESSAGE);
  });

  it.each([
    ["javascript: URL", "javascript:alert(1)", "url must use the http or https protocol"],
    ["ftp URL", "ftp://example.com/", "url must use the http or https protocol"],
    ["NUL URL", "https://x.org/\u0000", PUBLIC_MESSAGE],
    ["interior newline", "https://x.org/a\nb", PUBLIC_MESSAGE],
    ["backslash", "https://a.com\\@b.com/", PUBLIC_MESSAGE],
    ["IP literal", "http://127.0.0.1/", PUBLIC_MESSAGE],
    ["lone surrogate", "https://a.com/\ud800x", PUBLIC_MESSAGE],
    ["userinfo", "https://a@b.com/", PUBLIC_MESSAGE],
  ])("yields exactly one issue for %s", (_name, url, message) => {
    const result = httpUrlSchema.safeParse(url);
    expect(result.error?.issues.map((i) => i.message)).toEqual([message]);
  });

  it.each(["not a url", "http://"])("yields exactly one Invalid URL issue for %j", (url) => {
    const result = httpUrlSchema.safeParse(url);
    expect(result.error?.issues.map((i) => i.message)).toEqual(["Invalid URL"]);
  });

  it("keeps the exact protocol message", () => {
    const result = httpUrlSchema.safeParse("ftp://example.com/");
    expect(result.error?.issues.map((i) => i.message)).toContain(
      "url must use the http or https protocol"
    );
  });
});

describe("hasUnstorableChars / storableText", () => {
  it("flags a lone low surrogate at the start and after a lone low one", () => {
    expect(hasUnstorableChars("\udc00abc")).toBe(true);
    expect(hasUnstorableChars("\udc00\udc00")).toBe(true);
    expect(hasUnstorableChars("\ud83d\ude00\ude00")).toBe(true);
  });

  it("flags NUL and unpaired surrogates", () => {
    expect(hasUnstorableChars("a\u0000b")).toBe(true);
    expect(hasUnstorableChars("a\ud800b")).toBe(true);
    expect(hasUnstorableChars("a\udc00b")).toBe(true);
    expect(hasUnstorableChars("trailing\ud83d")).toBe(true);
  });

  it("allows ordinary text including paired surrogates", () => {
    expect(hasUnstorableChars("Café 日本 😀 line\nbreak")).toBe(false);
    expect(storableText(z.string()).safeParse("fine").success).toBe(true);
  });
});

const createBody = {
  kind: "create" as const,
  name: "New Facility",
  operator: "Acme",
  state: "TX",
  lat: 30,
  lon: -97,
  sourceUrl: "https://example.com/a",
};
const correctionBody = {
  kind: "correction" as const,
  targetFacilityId: "some-facility-tx",
  field: "name" as const,
  value: "Renamed",
  sourceUrl: "https://example.com/a",
};
const BAD = ["x\u0000y", "x\ud800y"];

describe("public intake schemas reject unstorable text", () => {
  describe.each(BAD)("value %j", (bad) => {
    it.each(["name", "operator", "city", "sourceLabel", "note", "attribution"])(
      "create.%s",
      (field) => {
        const r = contributeInputSchema.safeParse({ ...createBody, [field]: bad });
        expect(r.success).toBe(false);
        expect(r.error?.issues[0]?.path).toEqual([field]);
        expect(r.error?.issues[0]?.message).toBe("Remove unsupported characters.");
      }
    );

    it.each(["targetFacilityId", "value", "note", "attribution"])("correction.%s", (field) => {
      const r = contributeInputSchema.safeParse({ ...correctionBody, [field]: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual([field]);
    });

    it.each(["note", "attribution"])("lead.%s", (field) => {
      const r = leadInputSchema.safeParse({ url: "https://example.com/t", [field]: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual([field]);
    });
  });

  it("still accepts clean input", () => {
    expect(contributeInputSchema.safeParse(createBody).success).toBe(true);
    expect(contributeInputSchema.safeParse(correctionBody).success).toBe(true);
  });
});

describe("contact and subscribe schemas reject unstorable text", () => {
  const contact = {
    name: "Ed",
    email: "ed@example.com",
    topic: "other" as const,
    message: "A long enough message body here.",
  };

  it("accepts clean contact input", () => {
    expect(contactInputSchema.safeParse(contact).success).toBe(true);
  });

  describe.each(BAD)("value %j", (bad) => {
    it.each(["name", "message"])("contact.%s", (field) => {
      const r = contactInputSchema.safeParse({ ...contact, [field]: field === "message" ? contact.message + bad : bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual([field]);
      expect(r.error?.issues[0]?.message).toBe("Remove unsupported characters.");
    });

    it("contact.email", () => {
      const r = contactInputSchema.safeParse({ ...contact, email: `a${bad}@example.com` });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["email"]);
    });

    it("subscribe.targetId", () => {
      const r = subscribeInputSchema.safeParse({ email: "a@example.com", targetType: "state", targetId: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["targetId"]);
      expect(r.error?.issues[0]?.message).toBe("Remove unsupported characters.");
    });
  });

  it("accepts a clean subscribe input", () => {
    expect(
      subscribeInputSchema.safeParse({ email: "a@example.com", targetType: "state", targetId: "TX" }).success
    ).toBe(true);
  });
});
