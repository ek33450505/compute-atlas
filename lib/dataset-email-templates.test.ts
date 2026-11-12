// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildDatasetAdminNewRequestEmail,
  buildDatasetAlreadyActiveEmail,
  buildDatasetApprovedEmail,
  buildDatasetEditionNoticeEmail,
  buildDatasetLinkReissuedEmail,
  buildDatasetRejectedEmail,
  buildDatasetCommercialRedirectEmail,
  buildDatasetSubscriptionActiveEmail,
  buildDatasetCommercialAlertEmail,
  buildDatasetRenewalReminderEmail,
  buildDatasetVerifyEmail,
  type DatasetEmail,
} from "@/lib/dataset-email-templates";
import type { DatasetRequestEcho } from "@/lib/dataset-grants";
import { buildReadme } from "@/lib/dataset-readme";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

const SITE = "https://example.test";
// Characters that encodeURIComponent changes, so "raw token appears only in its link" is a real check.
const TOKEN = "tok+en/with=chars&x";
const ENCODED = encodeURIComponent(TOKEN);
const XSS = ['<img src=x onerror=alert(1)>', '"><script>alert(2)</script>'];

const echo: DatasetRequestEcho = {
  name: "Pat Reporter",
  organization: "The Gazette",
  role: "Data editor",
  category: "journalist",
  intendedUse: "Line one.\nLine two <b>bold</b>.",
  links: ["https://example.com/story"],
};

const HEADING =
  "Submitted with this request. This text was typed by whoever submitted it; Compute Atlas has not checked it and does not endorse any link in it:";

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The raw token is nowhere; the encoded one is in exactly one place per body, and never in the subject. */
function expectTokenOnlyInLink(mail: DatasetEmail, link: string) {
  expect(mail.subject).not.toContain(TOKEN);
  expect(mail.subject).not.toContain(ENCODED);
  for (const body of [mail.text, mail.html]) {
    expect(body).not.toContain(TOKEN);
    expect(count(body, ENCODED)).toBe(1);
    expect(count(body, link)).toBe(1);
  }
}

describe("buildDatasetVerifyEmail", () => {
  const link = `${SITE}/access/confirm?token=${ENCODED}`;
  const mail = buildDatasetVerifyEmail({ siteUrl: SITE, verifyToken: TOKEN, echo });

  it("carries the token only in its encoded link, with a fixed subject", () => {
    expectTokenOnlyInLink(mail, link);
    expect(mail.subject).toBe("Confirm your Compute Atlas dataset access request");
  });

  it("tells the owner to check the echo before confirming, ahead of the confirm link", () => {
    const check = "Check the details at the end of this email first. If they are not what you submitted, do not confirm: submit the request again.";
    expect(mail.text).toContain(check);
    expect(mail.html).toContain(check);
    expect(mail.text.indexOf(check)).toBeLessThan(mail.text.indexOf(link));
    expect(mail.html.indexOf(check)).toBeLessThan(mail.html.indexOf(link));
  });

  it("states the 7-day validity and that ignoring it does nothing", () => {
    expect(mail.text).toContain("valid for 7 days");
    expect(mail.text).toContain("If you did not make this request, ignore this email. Every request is reviewed by hand before any access is given.");
    expect(mail.html).toContain("Every request is reviewed by hand before any access is given.");
    expect(mail.text).not.toContain("nothing happens unless");
    expect(mail.html).toContain("valid for 7 days");
  });

  it("echoes every field under the as-entered heading, newlines as <br> after escaping", () => {
    for (const body of [mail.text, mail.html]) expect(body).toContain(HEADING);
    for (const v of ["Pat Reporter", "The Gazette", "Data editor", "Journalist", "example[.]com"]) {
      expect(mail.text).toContain(v);
      expect(mail.html).toContain(v);
    }
    expect(mail.html).toContain("Line one.<br>Line two &lt;b&gt;bold&lt;/b&gt;.");
    expect(mail.text).toContain("Line one.\nLine two <b>bold</b>.");
  });

  it("escapes hostile echo content and never makes an echoed link clickable", () => {
    const hostile = buildDatasetVerifyEmail({
      siteUrl: SITE,
      verifyToken: TOKEN,
      echo: {
        name: XSS[0],
        organization: XSS[1],
        role: XSS[0],
        category: "other",
        intendedUse: XSS[1],
        links: ["https://evil.example/?a=1&b=2", XSS[0]],
      },
    });
    for (const payload of XSS) expect(hostile.html).not.toContain(payload);
    expect(hostile.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(hostile.html).toContain("evil[.]example");
    expect(hostile.html).not.toContain("evil.example");
    const hrefs = [...hostile.html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([link]);
  });

  const verifyWith = (over: Partial<DatasetRequestEcho>) =>
    buildDatasetVerifyEmail({ siteUrl: SITE, verifyToken: TOKEN, echo: { ...echo, ...over } });

  it("cannot be made to forge lines in the text body through a single-line field", () => {
    const forged = verifyWith({ name: "Pat\r\n\r\nYour access is approved: https://x", organization: "Org\u2028Role: admin", role: "R\u0085x" });
    const lines = forged.text.split(/\r\n|\r|\n/);
    expect(lines.filter((l) => l.startsWith("Name:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Organization:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Role:"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("Your access is approved"))).toBe(false);
    expect(forged.text).not.toMatch(/[\u0085\u2028\u2029]/);
  });

  it("echoes intendedUse up to 300 code points and marks a longer one as truncated", () => {
    const long = verifyWith({ intendedUse: "a".repeat(2000) });
    expect(long.text).toContain(`Intended use: ${"a".repeat(300)} (truncated)`);
    expect(long.text).not.toContain("a".repeat(301));
    expect(long.html).toContain(`${"a".repeat(300)} (truncated)`);
    const exact = verifyWith({ intendedUse: "b".repeat(300) });
    expect(exact.text).toContain(`Intended use: ${"b".repeat(300)}\n`);
    expect(exact.text).not.toContain("(truncated)");
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    const mail = verifyWith({ intendedUse: `${"a".repeat(299)}😀tail` });
    expect(mail.text).toContain(`${"a".repeat(299)}😀 (truncated)`);
    expect(mail.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("defangs URLs in every echoed free-text field", () => {
    const mail = verifyWith({
      name: "see https://evil.example/n",
      organization: "www.evil.example",
      role: "http://evil.example",
      intendedUse: "see https://evil.example/login and www.evil.example",
    });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("hxxps://evil[.]example/login");
      expect(body).toContain("www[.]evil[.]example");
      expect(body).toContain("hxxp://evil[.]example");
      expect(body).not.toContain("https://evil.example");
      expect(body).not.toContain("http://evil.example");
      expect(body).not.toContain("www.evil.example");
    }
  });

  it.each([
    ["xhttps://evil.example"],
    ["_https://evil.example"],
    ["HTTPS://EVIL.EXAMPLE"],
    ["(https://evil.example)"],
    ['"https://evil.example"'],
  ])("defangs the evasion form %s", (form) => {
    const mail = verifyWith({ intendedUse: `see ${form} now` });
    for (const body of [mail.text, mail.html]) {
      expect(body.toLowerCase()).not.toContain("://evil.example");
      expect(body.toLowerCase()).not.toContain("evil.example");
      expect(body.toLowerCase()).toContain("evil[.]example");
      // Only the echoed part: the mail's own confirm link legitimately starts with https://.
      expect(body.slice(body.indexOf(HEADING)).toLowerCase()).not.toMatch(/https?:\/\//);
    }
  });

  it("defangs bare domains and addresses, and leaves ordinary prose alone", () => {
    const mail = verifyWith({ intendedUse: "evil.example/login or a@b.example" });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("evil[.]example/login");
      expect(body).toContain("a@b[.]example");
    }
    const prose = "e.g. 1.5 GW in the U.S. today.";
    const plain = verifyWith({ intendedUse: prose });
    expect(plain.text).toContain(`Intended use: ${prose}\n`);
    expect(plain.html).toContain(prose);
  });

  it("shows a link with no host as invalid", () => {
    const mail = verifyWith({ links: ["mailto:a@b.example"] });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("(invalid link)");
      expect(body).not.toContain("b.example");
    }
  });

  it("shows links host-only and defanged, and marks an unparseable one", () => {
    const mail = verifyWith({ links: ["https://example.com/story?x=1", "not a url"] });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("example[.]com");
      expect(body).toContain("(invalid link)");
      expect(body).not.toContain("/story");
      expect(body).not.toContain("https://example.com");
    }
  });

  it("keeps the subject fixed whatever the name holds", () => {
    const injected = buildDatasetVerifyEmail({
      siteUrl: SITE,
      verifyToken: TOKEN,
      echo: { ...echo, name: "Eve\r\nBcc: x@y" },
    });
    expect(injected.subject).toBe(mail.subject);
  });

  it("marks absent optional fields instead of printing null", () => {
    const sparse = buildDatasetVerifyEmail({
      siteUrl: SITE,
      verifyToken: TOKEN,
      echo: { ...echo, organization: null, role: null, links: [] },
    });
    expect(sparse.text).not.toContain("null");
    expect(sparse.html).not.toContain("null");
    expect(sparse.text).toContain("Organization: (none given)");
  });
});

describe("buildDatasetAlreadyActiveEmail", () => {
  const mail = buildDatasetAlreadyActiveEmail({ siteUrl: SITE });

  it("has no token or access link, points at /contact, and does not claim the link works", () => {
    expect(mail.subject).toBe("Your Compute Atlas dataset access");
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/token=|\?t=|\/access\/dataset/);
      expect(body).toContain(`${SITE}/contact`);
      expect(body).toContain("or it no longer works (access may be paused while a renewal is reviewed)");
      expect(body).toContain("only the most recent link works");
      expect(body).not.toContain("approval email you received");
      expect(body).toContain("already holds access");
    }
  });
});

describe("buildDatasetAdminNewRequestEmail", () => {
  it("names the requester and organization as unverified, links /admin/access, and holds nothing else", () => {
    const mail = buildDatasetAdminNewRequestEmail({ siteUrl: SITE, name: "Pat Reporter", organization: "The Gazette" });
    expect(mail.subject).toBe("New dataset access request");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Pat Reporter");
      expect(body).toContain("The Gazette");
      expect(body).toContain("As submitted, unverified (only the email address is verified)");
      expect(body).toContain(`${SITE}/admin/access`);
      expect(body).not.toContain("@");
    }
  });

  it("escapes hostile name and organization, with a fixed subject", () => {
    const mail = buildDatasetAdminNewRequestEmail({
      siteUrl: SITE,
      name: `${XSS[0]}\r\nBcc: x@y`,
      organization: XSS[1],
    });
    for (const payload of XSS) expect(mail.html).not.toContain(payload);
    expect(mail.subject).toBe("New dataset access request");
  });

  it("collapses line breaks and defangs URLs in name and organization", () => {
    const mail = buildDatasetAdminNewRequestEmail({
      siteUrl: SITE,
      name: "Pat\r\nFake: line",
      organization: "see https://evil.example",
    });
    expect(mail.text.split(/\r\n|\r|\n/).filter((l) => l.startsWith("Name:"))).toEqual(["Name: Pat Fake: line"]);
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("hxxps://evil[.]example");
      expect(body).not.toContain("https://evil.example");
    }
  });

  it("handles a missing organization", () => {
    const mail = buildDatasetAdminNewRequestEmail({ siteUrl: SITE, name: "Pat", organization: null });
    expect(mail.text).toContain("Organization: (none given)");
  });
});

describe.each([
  ["approved", buildDatasetApprovedEmail, "Your Compute Atlas dataset access is approved"],
  ["link reissued", buildDatasetLinkReissuedEmail, "Your new Compute Atlas dataset link"],
] as const)("buildDataset %s email", (_label, build, subject) => {
  const mail = build({ siteUrl: SITE, accessToken: TOKEN });

  it("carries the token only in its /access/dataset link, personal and fixed subject", () => {
    expectTokenOnlyInLink(mail, `${SITE}/access/dataset?t=${ENCODED}`);
    expect(mail.subject).toBe(subject);
    expect(mail.text).toContain("do not share it");
  });
});

describe("buildDatasetApprovedEmail / buildDatasetLinkReissuedEmail specifics", () => {
  it("approved: 365 days and the CC BY 4.0 attribution reminder pointing at /data", () => {
    const mail = buildDatasetApprovedEmail({ siteUrl: SITE, accessToken: TOKEN });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("365 days");
      expect(body).not.toContain("12 months");
      expect(body).toContain("CC BY 4.0");
      expect(body).toContain(`${SITE}/data`);
    }
  });

  it("reissued: says the previous link no longer works", () => {
    const mail = buildDatasetLinkReissuedEmail({ siteUrl: SITE, accessToken: TOKEN });
    expect(mail.text).toContain("previous link no longer works");
    expect(mail.html).toContain("previous link no longer works");
  });
});

describe("buildDatasetRejectedEmail", () => {
  it("has no note section when the note is null, and only the /contact link", () => {
    const mail = buildDatasetRejectedEmail({ siteUrl: SITE, rejectionNote: null });
    expect(mail.subject).toBe("Your Compute Atlas dataset access request");
    expect(mail.text).not.toContain("Note from the maintainer");
    expect(mail.html).not.toContain("Note from the maintainer");
    expect([...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([`${SITE}/contact`]);
  });

  it("shows the note escaped, newlines as <br>", () => {
    const mail = buildDatasetRejectedEmail({ siteUrl: SITE, rejectionNote: `${XSS[0]}\nSecond line` });
    expect(mail.text).toContain("Note from the maintainer:");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;<br>Second line");
    expect(mail.html).not.toContain(XSS[0]);
  });
});

describe("buildDatasetCommercialRedirectEmail", () => {
  const mail = buildDatasetCommercialRedirectEmail({ siteUrl: SITE });

  it("links the paid page and quotes both prices", () => {
    expect([...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([`${SITE}/access/commercial`, `${SITE}/access`]);
    expect(mail.text).toContain(`${SITE}/access/commercial`);
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("$150/month");
      expect(body).toContain("Everyone else can subscribe: $150/month or $1,500/year.");
      expect(body).not.toContain("months free");
      expect(body).toContain("free for students and educators");
      expect(body).toContain("If you are a student or educator, send a new request at");
    }
  });

  it("points students and educators to a new request at /access from a school address", () => {
    expect(mail.html).toContain(`send a new request at <a href="${SITE}/access">${SITE}/access</a> from your school email address`);
    expect(mail.text).toContain(`send a new request at ${SITE}/access from your school email address and choose "Student or educator".`);
  });

  it("never says donation", () => {
    expect(`${mail.subject} ${mail.text} ${mail.html}`.toLowerCase()).not.toContain("donat");
  });

  it("escapes the site URL in the html part", () => {
    const evil = buildDatasetCommercialRedirectEmail({ siteUrl: `https://x.test/"><script>` });
    expect(evil.html).not.toContain("<script>");
  });
});

describe("buildDatasetSubscriptionActiveEmail", () => {
  const mail = buildDatasetSubscriptionActiveEmail({ siteUrl: SITE, accessToken: TOKEN });

  it("carries the token only in its link, with a fixed subject", () => {
    expectTokenOnlyInLink(mail, `${SITE}/access/dataset?t=${ENCODED}`);
    expect(mail.subject).toBe("Your Compute Atlas commercial access is active");
  });

  it("states the single-person scope, weekly refresh, billing, cancellation and the CC BY credit", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("one named person weekly access through a personal link");
      expect(body).toContain("refreshes weekly");
      expect(body).toContain("Your subscription");
      expect(body).toContain("access continues to the end of the period you have paid for");
      expect(body).toContain("CC BY 4.0");
      expect(body).toContain("Questions can go through the contact page");
      expect(body.toLowerCase()).not.toContain("reply to");
    }
    expect(`${mail.subject} ${mail.text} ${mail.html}`.toLowerCase()).not.toContain("donat");
  });

  it("tells a non-purchaser how to reach us", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("If you did not make this purchase, contact us at");
      expect(body).toContain(`${SITE}/contact`);
    }
  });

  it("escapes the site URL in html", () => {
    const evil = buildDatasetSubscriptionActiveEmail({ siteUrl: `https://x.test/"><script>`, accessToken: TOKEN });
    expect(evil.html).not.toContain("<script>");
  });
});

describe("buildDatasetCommercialAlertEmail", () => {
  it("names reason, action and PayPal ids, escaped, with no token", () => {
    const mail = buildDatasetCommercialAlertEmail({
      reason: "duplicate_subscription",
      action: "no_grant_created",
      subscriptionId: "sub_<b>x",
      checkoutId: "cs_1",
      saleId: null,
    });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("duplicate_subscription");
      expect(body).toContain("cs_1");
    }
    expect(mail.text).toContain("already has access");
    expect(mail.text).toContain("Cancel and refund the new subscription by hand in PayPal");
    expect(mail.text).toContain("Sale: (none)");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("sub_&lt;b&gt;x");
  });

  it("names the new reasons and their actions, with the grant id escaped", () => {
    const reversed = buildDatasetCommercialAlertEmail({
      reason: "payment_reversed",
      action: "no_action_person_decides",
      subscriptionId: "sub_1",
      checkoutId: "cs_1",
      saleId: null,
      grantId: "g<i>1",
    });
    expect(reversed.text).toContain("payment_reversed");
    expect(reversed.text).toContain("Nothing was cancelled, refunded or changed automatically");
    expect(reversed.html).toContain("g&lt;i&gt;1");
    expect(reversed.html).not.toContain("<i>");

    const suppressed = buildDatasetCommercialAlertEmail({
      reason: "welcome_mail_undeliverable",
      action: "link_not_mailed_suppressed",
      subscriptionId: null,
      checkoutId: null,
      saleId: null,
      grantId: "g1",
    });
    expect(suppressed.text).toContain("welcome_mail_undeliverable");
    expect(suppressed.text).toContain("opted out of our email");
    expect(suppressed.text).toContain("blocked by the same opt-out");

    const unconfirmed = buildDatasetCommercialAlertEmail({
      reason: "welcome_mail_undeliverable",
      action: "link_not_mailed_unconfirmed",
      subscriptionId: null,
      checkoutId: null,
      saleId: null,
      grantId: "g1",
    });
    expect(unconfirmed.text).toContain("grant was not live when the link was mailed");
    expect(unconfirmed.text).not.toContain("opted out");
  });
});

describe("buildDatasetRenewalReminderEmail", () => {
  const mail = buildDatasetRenewalReminderEmail({
    siteUrl: SITE,
    renewToken: TOKEN,
    expiresAt: new Date("2027-03-01T23:30:00Z"),
  });

  it("carries the renew token only in its link", () => {
    expectTokenOnlyInLink(mail, `${SITE}/access/renew?token=${ENCODED}`);
    expect(mail.subject).toBe("Your Compute Atlas dataset access is expiring");
  });

  it("tells the reader to use the link before the date and that downloads pause if review outlasts it", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("before then");
      expect(body).toContain("downloads pause");
      expect(body).not.toContain("is reviewed before access continues");
    }
  });

  it("shows the expiry as a UTC date", () => {
    expect(mail.text).toContain("March 1, 2027 (UTC)");
    expect(mail.html).toContain("March 1, 2027 (UTC)");
  });
});

describe("buildDatasetEditionNoticeEmail", () => {
  const mail = buildDatasetEditionNoticeEmail({
    siteUrl: SITE,
    editionDate: "2026-12-01",
    unsubscribeToken: TOKEN,
    recordCount: 2300,
  });

  it("carries only the unsubscribe token, in its link, and no access link", () => {
    const url = `${SITE}/api/dataset/unsubscribe?token=${ENCODED}`;
    expect(mail.unsubscribeUrl).toBe(url);
    expectTokenOnlyInLink(mail, url);
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toContain("/access/dataset");
      expect(body).not.toContain("?t=");
      expect(body).toContain("now serves the edition of 2026-12-01");
      expect(body).toContain("most recent");
    }
    expect(mail.subject).toBe("A new edition of the Compute Atlas dataset");
  });

  it("states the record count, the attribution reminder and a contact link for a lost link", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("2,300 records");
      expect(body).toContain("CC BY 4.0");
      expect(body).toContain(`${SITE}/contact`);
      expect(body).toContain("Lost your link?");
    }
    // The attribution wording is the README's: same line, so the two cannot drift.
    const attribution = `Data from Compute Atlas by Edward Kubiak (${siteConfig.url}), licensed under CC BY 4.0 (${DATASET_LICENSE_URL}).`;
    expect(buildDatasetEditionNoticeEmail({ siteUrl: siteConfig.url, editionDate: "2026-12-01", unsubscribeToken: TOKEN, recordCount: 1 }).text).toContain(attribution);
    expect(buildReadme({ editionDate: "2026-12-01", editionId: "e", recordCount: 1, initial: true })).toContain(attribution);
  });

  it("omits the counts line and the list when there is no summary (initial edition)", () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/added/);
      expect(body).not.toContain("<ul>");
    }
  });

  it("renders the counts line and up to 10 headlines when a summary is present", () => {
    const headlines = Array.from({ length: 12 }, (_, i) => `Headline ${i + 1}`);
    const withSummary = buildDatasetEditionNoticeEmail({
      siteUrl: SITE,
      editionDate: "2026-12-08",
      unsubscribeToken: TOKEN,
      recordCount: 3,
      summary: { added: 2, updated: 5, removed: 1, headlines },
    });
    for (const body of [withSummary.text, withSummary.html]) {
      expect(body).toContain("+2 added, 5 updated, 1 removed");
      expect(body).toContain("Headline 10");
      expect(body).not.toContain("Headline 11");
    }
    expect(withSummary.html).toContain("<ul>");
    expect(withSummary.text).toContain("- Headline 1\n");
  });

  it("escapes a hostile headline in html, keeps it on one line in text, and never carries the token elsewhere", () => {
    const hostile = buildDatasetEditionNoticeEmail({
      siteUrl: SITE,
      editionDate: "2026-12-08",
      unsubscribeToken: TOKEN,
      recordCount: 3,
      summary: { added: 1, updated: 0, removed: 0, headlines: [XSS[0], `${XSS[1]}\nforged line`] },
    });
    expect(hostile.html).not.toContain("<img");
    expect(hostile.html).not.toContain("<script");
    expect(hostile.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(hostile.text).toContain(XSS[0]);
    expect(hostile.text).toContain(`${XSS[1]} forged line`);
    expectTokenOnlyInLink(hostile, `${SITE}/api/dataset/unsubscribe?token=${ENCODED}`);
  });

  it("refuses an edition date that is not YYYY-MM-DD", () => {
    for (const editionDate of ["2026-12-1", "2026-12-01<b>", "", "December 1"]) {
      expect(() =>
        buildDatasetEditionNoticeEmail({ siteUrl: SITE, editionDate, unsubscribeToken: TOKEN, recordCount: 1 })
      ).toThrow(/edition date/);
    }
  });
});
