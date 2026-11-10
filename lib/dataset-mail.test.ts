// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/email-gate", () => ({
  sendGrantGated: vi.fn(),
  sendDatasetAdminNoticeGated: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendDatasetVerifyEmail: vi.fn(),
  sendDatasetAlreadyActiveEmail: vi.fn(),
  sendDatasetAdminNewRequestEmail: vi.fn(),
  sendDatasetApprovedEmail: vi.fn(),
  sendDatasetRejectedEmail: vi.fn(),
  sendDatasetCommercialRedirectEmail: vi.fn(),
  sendDatasetLinkReissuedEmail: vi.fn(),
}));

import { getDb } from "@/lib/db/client";
import { sendDatasetAdminNoticeGated, sendGrantGated } from "@/lib/email-gate";
import {
  sendDatasetAdminNewRequestEmail,
  sendDatasetAlreadyActiveEmail,
  sendDatasetApprovedEmail,
  sendDatasetCommercialRedirectEmail,
  sendDatasetLinkReissuedEmail,
  sendDatasetRejectedEmail,
  sendDatasetVerifyEmail,
} from "@/lib/email";
import {
  deliverDatasetAdminNotice,
  deliverDatasetRequestMail,
  deliverDatasetReviewMail,
} from "@/lib/dataset-mail";

const DB = { db: true };
const SENT = { sent: true, disposition: "sent" } as const;
const echo = {
  name: "Pat",
  organization: "The Gazette",
  role: null,
  category: "journalist" as const,
  intendedUse: "A story.",
  links: ["https://example.com/a"],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDb).mockReturnValue(DB as never);
  vi.mocked(sendGrantGated).mockResolvedValue(SENT);
  vi.mocked(sendDatasetAdminNoticeGated).mockResolvedValue(SENT);
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.CONTACT_TO_EMAIL;
});

describe("deliverDatasetRequestMail", () => {
  it("routes dataset_verify through sendGrantGated and sends with the echo intact", async () => {
    const intent = { kind: "dataset_verify" as const, grantId: "g1", email: "a@b.co", verifyToken: "tok", echo };
    expect(await deliverDatasetRequestMail(intent)).toEqual(SENT);

    const [db, opts, send] = vi.mocked(sendGrantGated).mock.calls[0];
    expect(db).toBe(DB);
    expect(opts).toEqual({ kind: "dataset_verify", grantId: "g1", email: "a@b.co" });
    expect(sendDatasetVerifyEmail).not.toHaveBeenCalled();
    await send();
    expect(sendDatasetVerifyEmail).toHaveBeenCalledWith({ email: "a@b.co", verifyToken: "tok", echo });
  });

  it("routes dataset_already_active through sendGrantGated", async () => {
    const intent = { kind: "dataset_already_active" as const, grantId: "g2", email: "c@d.co" };
    await deliverDatasetRequestMail(intent);

    const [, opts, send] = vi.mocked(sendGrantGated).mock.calls[0];
    expect(opts).toEqual({ kind: "dataset_already_active", grantId: "g2", email: "c@d.co" });
    await send();
    expect(sendDatasetAlreadyActiveEmail).toHaveBeenCalledWith({ email: "c@d.co" });
    expect(sendDatasetVerifyEmail).not.toHaveBeenCalled();
  });

  it("returns gate_error without sending or throwing when getDb throws", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });
    const intent = { kind: "dataset_verify" as const, grantId: "g1", email: "a@b.co", verifyToken: "tok", echo };
    await expect(deliverDatasetRequestMail(intent)).resolves.toEqual({ sent: false, disposition: "gate_error" });
    expect(sendGrantGated).not.toHaveBeenCalled();
    expect(sendDatasetVerifyEmail).not.toHaveBeenCalled();
  });
});

describe("deliverDatasetAdminNotice", () => {
  const intent = { kind: "dataset_admin_new_request" as const, grantId: "g3", name: "Pat", organization: null };

  it("uses CONTACT_TO_EMAIL as the recipient and sends name + organization only", async () => {
    process.env.CONTACT_TO_EMAIL = "ed@example.com";
    expect(await deliverDatasetAdminNotice(intent)).toEqual(SENT);

    const [db, opts, send] = vi.mocked(sendDatasetAdminNoticeGated).mock.calls[0];
    expect(db).toBe(DB);
    expect(opts).toEqual({ grantId: "g3", recipient: "ed@example.com" });
    await send();
    expect(sendDatasetAdminNewRequestEmail).toHaveBeenCalledWith({ name: "Pat", organization: null });
  });

  it("passes an empty recipient when CONTACT_TO_EMAIL is unset", async () => {
    await deliverDatasetAdminNotice(intent);
    expect(vi.mocked(sendDatasetAdminNoticeGated).mock.calls[0][1]).toEqual({ grantId: "g3", recipient: "" });
  });

  it("returns gate_error without sending or throwing when getDb throws", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });
    await expect(deliverDatasetAdminNotice(intent)).resolves.toEqual({ sent: false, disposition: "gate_error" });
    expect(sendDatasetAdminNoticeGated).not.toHaveBeenCalled();
    expect(sendDatasetAdminNewRequestEmail).not.toHaveBeenCalled();
  });
});

describe("deliverDatasetReviewMail", () => {
  const reviewSenders = [
    sendDatasetApprovedEmail,
    sendDatasetRejectedEmail,
    sendDatasetLinkReissuedEmail,
  ];

  it("routes dataset_approved through sendGrantGated and sends the access token", async () => {
    const intent = { kind: "dataset_approved" as const, grantId: "g4", email: "a@b.co", accessToken: "acc" };
    expect(await deliverDatasetReviewMail(intent)).toEqual(SENT);

    const [db, opts, send] = vi.mocked(sendGrantGated).mock.calls[0];
    expect(db).toBe(DB);
    expect(opts).toEqual({ kind: "dataset_approved", grantId: "g4", email: "a@b.co" });
    expect(sendDatasetApprovedEmail).not.toHaveBeenCalled();
    await send();
    expect(sendDatasetApprovedEmail).toHaveBeenCalledWith({ email: "a@b.co", accessToken: "acc" });
    expect(sendDatasetRejectedEmail).not.toHaveBeenCalled();
    expect(sendDatasetLinkReissuedEmail).not.toHaveBeenCalled();
  });

  it("routes dataset_rejected through sendGrantGated and sends the rejection note", async () => {
    const intent = {
      kind: "dataset_rejected" as const,
      grantId: "g5",
      email: "c@d.co",
      rejectionNote: "Out of scope.",
    };
    await deliverDatasetReviewMail(intent);

    const [db, opts, send] = vi.mocked(sendGrantGated).mock.calls[0];
    expect(db).toBe(DB);
    expect(opts).toEqual({ kind: "dataset_rejected", grantId: "g5", email: "c@d.co" });
    expect(sendDatasetRejectedEmail).not.toHaveBeenCalled();
    await send();
    expect(sendDatasetRejectedEmail).toHaveBeenCalledWith({ email: "c@d.co", rejectionNote: "Out of scope." });
    expect(sendDatasetApprovedEmail).not.toHaveBeenCalled();
    expect(sendDatasetLinkReissuedEmail).not.toHaveBeenCalled();
  });

  it("routes dataset_commercial_redirect through sendGrantGated and sends only to the address", async () => {
    await deliverDatasetReviewMail({ kind: "dataset_commercial_redirect", grantId: "g7", email: "x@y.co" });

    const [db, opts, send] = vi.mocked(sendGrantGated).mock.calls[0];
    expect(db).toBe(DB);
    expect(opts).toEqual({ kind: "dataset_commercial_redirect", grantId: "g7", email: "x@y.co" });
    expect(sendDatasetCommercialRedirectEmail).not.toHaveBeenCalled();
    await send();
    expect(sendDatasetCommercialRedirectEmail).toHaveBeenCalledWith({ email: "x@y.co" });
    expect(sendDatasetRejectedEmail).not.toHaveBeenCalled();
  });

  it("passes a null rejection note through", async () => {
    await deliverDatasetReviewMail({ kind: "dataset_rejected", grantId: "g5", email: "c@d.co", rejectionNote: null });
    await vi.mocked(sendGrantGated).mock.calls[0][2]();
    expect(sendDatasetRejectedEmail).toHaveBeenCalledWith({ email: "c@d.co", rejectionNote: null });
  });

  it("routes dataset_link_reissued through sendGrantGated and sends the new token", async () => {
    const intent = { kind: "dataset_link_reissued" as const, grantId: "g6", email: "e@f.co", accessToken: "new" };
    await deliverDatasetReviewMail(intent);

    const [db, opts, send] = vi.mocked(sendGrantGated).mock.calls[0];
    expect(db).toBe(DB);
    expect(opts).toEqual({ kind: "dataset_link_reissued", grantId: "g6", email: "e@f.co" });
    expect(sendDatasetLinkReissuedEmail).not.toHaveBeenCalled();
    await send();
    expect(sendDatasetLinkReissuedEmail).toHaveBeenCalledWith({ email: "e@f.co", accessToken: "new" });
    expect(sendDatasetApprovedEmail).not.toHaveBeenCalled();
    expect(sendDatasetRejectedEmail).not.toHaveBeenCalled();
  });

  it("returns gate_error without sending or throwing when getDb throws", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });
    const intent = { kind: "dataset_approved" as const, grantId: "g4", email: "a@b.co", accessToken: "acc" };
    await expect(deliverDatasetReviewMail(intent)).resolves.toEqual({ sent: false, disposition: "gate_error" });
    expect(sendGrantGated).not.toHaveBeenCalled();
    for (const sender of reviewSenders) expect(sender).not.toHaveBeenCalled();
  });
});
