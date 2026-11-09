// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import {
  sendDatasetAdminNewRequestEmail,
  sendDatasetAlreadyActiveEmail,
  sendDatasetApprovedEmail,
  sendDatasetEditionNoticeEmail,
  sendDatasetLinkReissuedEmail,
  sendDatasetRejectedEmail,
  sendDatasetRenewalReminderEmail,
  sendDatasetVerifyEmail,
} from "@/lib/email";

const TOKEN = "tok+en/with=chars";
const ENCODED = encodeURIComponent(TOKEN);
const SAVED = {
  key: process.env.RESEND_API_KEY,
  site: process.env.NEXT_PUBLIC_SITE_URL,
  to: process.env.CONTACT_TO_EMAIL,
};

const echo = {
  name: "Pat\r\nBcc: x@y",
  organization: "The Gazette",
  role: null,
  category: "journalist" as const,
  intendedUse: "Cross-checking.",
  links: [],
};

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "re_123" }, error: null });
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
  process.env.CONTACT_TO_EMAIL = "maintainer@example.test";
});

afterEach(() => {
  restore("RESEND_API_KEY", SAVED.key);
  restore("NEXT_PUBLIC_SITE_URL", SAVED.site);
  restore("CONTACT_TO_EMAIL", SAVED.to);
  vi.restoreAllMocks();
});

const payload = () => resendSendMock.mock.calls[0][0] as {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: unknown;
  headers?: Record<string, string>;
};

const senders: Array<[string, () => Promise<unknown>, string]> = [
  ["verify", () => sendDatasetVerifyEmail({ email: "a@b.test", verifyToken: TOKEN, echo }), "a@b.test"],
  ["already active", () => sendDatasetAlreadyActiveEmail({ email: "a@b.test" }), "a@b.test"],
  ["admin", () => sendDatasetAdminNewRequestEmail({ name: "Pat", organization: null }), "maintainer@example.test"],
  ["approved", () => sendDatasetApprovedEmail({ email: "a@b.test", accessToken: TOKEN }), "a@b.test"],
  ["rejected", () => sendDatasetRejectedEmail({ email: "a@b.test", rejectionNote: null }), "a@b.test"],
  ["reissued", () => sendDatasetLinkReissuedEmail({ email: "a@b.test", accessToken: TOKEN }), "a@b.test"],
  [
    "reminder",
    () => sendDatasetRenewalReminderEmail({ email: "a@b.test", renewToken: TOKEN, expiresAt: new Date("2027-01-02T00:00:00Z") }),
    "a@b.test",
  ],
  [
    "edition notice",
    () =>
      sendDatasetEditionNoticeEmail({ email: "a@b.test", editionDate: "2026-12-01", unsubscribeToken: TOKEN, recordCount: 10 }),
    "a@b.test",
  ],
];

describe.each(senders)("dataset sender: %s", (_label, send, recipient) => {
  it("sends to the right recipient and reports the Resend id", async () => {
    expect(await send()).toEqual({ sent: true, resendId: "re_123" });
    expect(payload().to).toBe(recipient);
  });

  it("reports a Resend error as an identifier code, not free text", async () => {
    resendSendMock.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad a@b.test" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await send()).toEqual({ sent: false, errorCode: "validation_error" });
  });

  it("skips with no_key when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await send()).toEqual({ sent: false, errorCode: "no_key", skipped: "no_key" });
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("dataset sender payloads", () => {
  it("verify: encoded token in its link, fixed subject despite a header-injecting name", async () => {
    await sendDatasetVerifyEmail({ email: "a@b.test", verifyToken: TOKEN, echo });
    const p = payload();
    expect(p.subject).toBe("Confirm your Compute Atlas dataset access request");
    expect(p.text).toContain(`https://example.test/access/confirm?token=${ENCODED}`);
    expect(p.html).not.toContain(TOKEN);
  });

  it("approved and reissued link to /access/dataset?t=<encoded>", async () => {
    await sendDatasetApprovedEmail({ email: "a@b.test", accessToken: TOKEN });
    expect(payload().text).toContain(`https://example.test/access/dataset?t=${ENCODED}`);
    resendSendMock.mockClear();
    await sendDatasetLinkReissuedEmail({ email: "a@b.test", accessToken: TOKEN });
    expect(payload().html).toContain(`https://example.test/access/dataset?t=${ENCODED}`);
  });

  it("admin: no replyTo, and CONTACT_TO_EMAIL unset returns { sent: false } without calling Resend", async () => {
    await sendDatasetAdminNewRequestEmail({ name: "Pat", organization: "Org" });
    expect(payload().replyTo).toBeUndefined();

    resendSendMock.mockClear();
    delete process.env.CONTACT_TO_EMAIL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendDatasetAdminNewRequestEmail({ name: "Pat", organization: "Org" })).toEqual({ sent: false });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("edition notice: both List-Unsubscribe headers and no access link", async () => {
    await sendDatasetEditionNoticeEmail({ email: "a@b.test", editionDate: "2026-12-01", unsubscribeToken: TOKEN, recordCount: 10 });
    const p = payload();
    const url = `https://example.test/api/dataset/unsubscribe?token=${ENCODED}`;
    expect(p.headers).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(p.text).toContain(url);
    expect(p.html).toContain(url); // header URL === body URL
    expect(p.text + p.html).not.toMatch(/\/access\/dataset|\?t=/);
  });

  it("edition notice: record count and summary reach the body, escaped in html", async () => {
    await sendDatasetEditionNoticeEmail({
      email: "a@b.test",
      editionDate: "2026-12-08",
      unsubscribeToken: TOKEN,
      recordCount: 2300,
      summary: { added: 1, updated: 2, removed: 3, headlines: ["<b>Zeta</b> now operational"] },
    });
    const p = payload();
    expect(p.text).toContain("+1 added, 2 updated, 3 removed");
    expect(p.text).toContain("2,300 records");
    expect(p.html).toContain("&lt;b&gt;Zeta&lt;/b&gt; now operational");
    expect(p.html).not.toContain("<b>Zeta");
  });
});
