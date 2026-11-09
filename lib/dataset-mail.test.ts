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
}));

import { getDb } from "@/lib/db/client";
import { sendDatasetAdminNoticeGated, sendGrantGated } from "@/lib/email-gate";
import {
  sendDatasetAdminNewRequestEmail,
  sendDatasetAlreadyActiveEmail,
  sendDatasetVerifyEmail,
} from "@/lib/email";
import { deliverDatasetAdminNotice, deliverDatasetRequestMail } from "@/lib/dataset-mail";

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
