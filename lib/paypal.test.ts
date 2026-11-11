import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PayPalApiError,
  PayPalConfigError,
  allowedCommercialPlanIds,
  cancelSubscription,
  createSubscription,
  getSubscription,
  planForPlanId,
  planIdFor,
  resetPayPalTokenCacheForTests,
  verifyWebhookSignature,
} from "@/lib/paypal";

const SECRET = "s3cr3t-client-secret-value";
const TOKEN = "A21-access-token-value";

const ENV: Record<string, string> = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "client-id-1",
  PAYPAL_CLIENT_SECRET: SECRET,
  PAYPAL_WEBHOOK_ID: "WH-123",
  PAYPAL_PLAN_COMMERCIAL_MONTHLY: "P-MONTHLY",
  PAYPAL_PLAN_COMMERCIAL_ANNUAL: "P-ANNUAL",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tokenResponse = (token = TOKEN, expiresIn = 3600) =>
  json({ access_token: token, expires_in: expiresIn });

let fetchMock: ReturnType<typeof vi.fn>;

function queue(...responses: Response[]) {
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
}

function callAt(i: number): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  resetPayPalTokenCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it.each(Object.keys(ENV))("throws PayPalConfigError naming %s when it is missing", async (name) => {
    vi.stubEnv(name, "");
    const needsApi = name !== "PAYPAL_PLAN_COMMERCIAL_MONTHLY" && name !== "PAYPAL_PLAN_COMMERCIAL_ANNUAL";
    const run = needsApi
      ? name === "PAYPAL_WEBHOOK_ID"
        ? verifyWebhookSignature(new Headers(), "{}")
        : getSubscription("I-ABCDEF123")
      : createSubscription({ plan: name.endsWith("ANNUAL") ? "annual" : "monthly", checkoutId: "chk_0001", returnUrl: "https://x/r", cancelUrl: "https://x/c" });
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(PayPalConfigError);
    expect((err as PayPalConfigError).variable).toBe(name);
    expect((err as Error).message).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats whitespace as missing and trims values", async () => {
    vi.stubEnv("PAYPAL_PLAN_COMMERCIAL_MONTHLY", "   ");
    expect(() => planIdFor("monthly")).toThrow(PayPalConfigError);
    vi.stubEnv("PAYPAL_PLAN_COMMERCIAL_MONTHLY", "  P-TRIMMED  ");
    expect(planIdFor("monthly")).toBe("P-TRIMMED");
  });

  it.each(["", "production", "Sandbox", "LIVE"])("rejects PAYPAL_ENV=%j", async (value) => {
    vi.stubEnv("PAYPAL_ENV", value);
    const err = await getSubscription("I-ABCDEF123").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalConfigError);
    expect(err.variable).toBe("PAYPAL_ENV");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the sandbox base URL for sandbox and the live one for live", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    expect(callAt(0).url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(callAt(1).url).toBe("https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-ABCDEF123");

    vi.stubEnv("PAYPAL_ENV", "live");
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    expect(callAt(2).url).toBe("https://api-m.paypal.com/v1/oauth2/token");
    expect(callAt(3).url).toBe("https://api-m.paypal.com/v1/billing/subscriptions/I-ABCDEF123");
  });
});

describe("plan ids", () => {
  it("maps plans both ways", () => {
    expect(planIdFor("annual")).toBe("P-ANNUAL");
    expect(planForPlanId("P-MONTHLY")).toBe("monthly");
    expect(planForPlanId("P-ANNUAL")).toBe("annual");
    expect(planForPlanId("P-OTHER")).toBeNull();
    expect(allowedCommercialPlanIds()).toEqual(new Set(["P-MONTHLY", "P-ANNUAL"]));
  });
});

describe("OAuth token handling", () => {
  it("sends Basic credentials and the client_credentials grant", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    const { init, headers } = callAt(0);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`client-id-1:${SECRET}`).toString("base64")}`);
    expect(callAt(1).headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("caches the token across calls", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    await getSubscription("I-ABCDEF123");
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("refreshes once fewer than 60 s remain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    queue(
      tokenResponse("tok-1", 3600),
      json({ id: "I-ABCDEF123", status: "ACTIVE" }),
      tokenResponse("tok-2", 3600),
      json({ id: "I-ABCDEF123", status: "ACTIVE" }),
    );
    await getSubscription("I-ABCDEF123");
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z").getTime() + (3600 - 59) * 1000);
    await getSubscription("I-ABCDEF123");
    expect(callAt(3).headers.Authorization).toBe("Bearer tok-2");
  });

  it("does not refresh with 61 s remaining", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    queue(tokenResponse("tok-1", 3600), json({ id: "I-ABCDEF123", status: "ACTIVE" }), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z").getTime() + (3600 - 61) * 1000);
    await getSubscription("I-ABCDEF123");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callAt(2).headers.Authorization).toBe("Bearer tok-1");
  });

  it("uses a separate cache entry when PAYPAL_CLIENT_ID changes", async () => {
    queue(tokenResponse("tok-a"), json({ id: "I-ABCDEF123", status: "ACTIVE" }), tokenResponse("tok-b"), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id-2");
    await getSubscription("I-ABCDEF123");
    expect(callAt(3).headers.Authorization).toBe("Bearer tok-b");
  });

  it("sends cache: no-store on token and API requests", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    expect(callAt(0).init.cache).toBe("no-store");
    expect(callAt(1).init.cache).toBe("no-store");
  });

  it("shares one token request between concurrent cold-cache calls", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await Promise.all([getSubscription("I-ABCDEF123"), getSubscription("I-ABCDEF123")]);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("clears the in-flight token request on failure", async () => {
    queue(json({ name: "INTERNAL_SERVER_ERROR" }, 500), tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await expect(getSubscription("I-ABCDEF123")).rejects.toBeInstanceOf(PayPalApiError);
    expect((await getSubscription("I-ABCDEF123")).status).toBe("ACTIVE");
  });

  it("sends redirect: error", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "ACTIVE" }));
    await getSubscription("I-ABCDEF123");
    expect(callAt(0).init.redirect).toBe("error");
    expect(callAt(1).init.redirect).toBe("error");
  });

  it("drops the cache and retries once on a 401", async () => {
    queue(
      tokenResponse("tok-old"),
      json({ name: "AUTHENTICATION_FAILURE", debug_id: "d1" }, 401),
      tokenResponse("tok-new"),
      json({ id: "I-ABCDEF123", status: "ACTIVE" }),
    );
    const sub = await getSubscription("I-ABCDEF123");
    expect(sub.status).toBe("ACTIVE");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callAt(1).headers.Authorization).toBe("Bearer tok-old");
    expect(callAt(3).headers.Authorization).toBe("Bearer tok-new");
  });

  it("gives up after a second 401", async () => {
    queue(
      tokenResponse(),
      json({ name: "AUTHENTICATION_FAILURE" }, 401),
      tokenResponse(),
      json({ name: "AUTHENTICATION_FAILURE" }, 401),
    );
    const err = await getSubscription("I-ABCDEF123").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("createSubscription", () => {
  const approve = (href: string) => ({
    id: "I-NEWSUB12345",
    links: [
      { rel: "self", href: "https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-NEWSUB12345" },
      { rel: "approve", href },
    ],
  });
  const args = { plan: "monthly" as const, checkoutId: "chk_0001", returnUrl: "https://x/r", cancelUrl: "https://x/c" };

  it("sends the documented request and extracts the approve URL", async () => {
    queue(tokenResponse(), json(approve("https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1"), 201));
    const result = await createSubscription(args);
    expect(result).toEqual({
      subscriptionId: "I-NEWSUB12345",
      approveUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1",
    });
    const { url, init, headers } = callAt(1);
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/billing/subscriptions");
    expect(init.method).toBe("POST");
    expect(headers["PayPal-Request-Id"]).toBe("ca-sub-chk_0001");
    expect(JSON.parse(init.body as string)).toEqual({
      plan_id: "P-MONTHLY",
      custom_id: "chk_0001",
      application_context: {
        brand_name: "Compute Atlas",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: "https://x/r",
        cancel_url: "https://x/c",
      },
    });
  });

  it("returns the parsed, normalized approve URL", async () => {
    queue(tokenResponse(), json(approve("https://WWW.sandbox.paypal.com:443/a b")));
    const { approveUrl } = await createSubscription(args);
    expect(approveUrl).toBe("https://www.sandbox.paypal.com/a%20b");
  });

  it.each(["", "short", "chk 0001!", "a".repeat(65), "chk_0001/../x"])("rejects checkout id %j without fetching", async (id) => {
    await expect(createSubscription({ ...args, checkoutId: id })).rejects.toThrow(/invalid checkout id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an approve URL on the wrong origin", async () => {
    queue(tokenResponse(), json(approve("https://evil.example/approve")));
    await expect(createSubscription(args)).rejects.toThrow(/unexpected origin/);
  });

  it("rejects the live origin while configured for sandbox", async () => {
    queue(tokenResponse(), json(approve("https://www.paypal.com/x")));
    await expect(createSubscription(args)).rejects.toThrow(/unexpected origin/);
  });

  it("accepts the live origin when configured for live", async () => {
    vi.stubEnv("PAYPAL_ENV", "live");
    queue(tokenResponse(), json(approve("https://www.paypal.com/x")));
    await expect(createSubscription(args)).resolves.toMatchObject({ approveUrl: "https://www.paypal.com/x" });
  });

  it("throws when there is no approve link", async () => {
    queue(tokenResponse(), json({ id: "I-NEWSUB12345", links: [] }));
    await expect(createSubscription(args)).rejects.toThrow(/approve link/);
  });
});

describe("getSubscription", () => {
  it("maps the PayPal payload to the typed subset", async () => {
    queue(
      tokenResponse(),
      json({
        id: "I-ABCDEF123",
        status: "ACTIVE",
        plan_id: "P-MONTHLY",
        custom_id: "chk_0001",
        start_time: "2026-11-01T00:00:00Z",
        subscriber: { payer_id: "PAYER1", email_address: "buyer@example.com", extra: "ignored" },
        billing_info: {
          next_billing_time: "2026-12-01T00:00:00Z",
          last_payment: { amount: { currency_code: "USD", value: "49.00" }, time: "2026-11-01T00:01:00Z" },
        },
      }),
    );
    expect(await getSubscription("I-ABCDEF123")).toEqual({
      id: "I-ABCDEF123",
      status: "ACTIVE",
      planId: "P-MONTHLY",
      customId: "chk_0001",
      payerId: "PAYER1",
      payerEmail: "buyer@example.com",
      startTime: "2026-11-01T00:00:00Z",
      nextBillingTime: "2026-12-01T00:00:00Z",
      lastPayment: { amount: "49.00", currency: "USD", time: "2026-11-01T00:01:00Z" },
    });
  });

  it("returns nulls when optional sections are absent", async () => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", status: "APPROVAL_PENDING" }));
    const sub = await getSubscription("I-ABCDEF123");
    expect(sub.lastPayment).toBeNull();
    expect(sub.payerId).toBeNull();
    expect(sub.nextBillingTime).toBeNull();
  });

  it.each([{ status: "WEIRD" }, { status: "active" }, {}])("rejects unexpected status payload %j", async (extra) => {
    queue(tokenResponse(), json({ id: "I-ABCDEF123", ...extra }));
    const err = await getSubscription("I-ABCDEF123").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.paypalName).toBe("UNEXPECTED_STATUS");
  });

  it.each(["", "i-abcdef123", "I-ABC", "I-ABCDEF123/../x", "I-ABCDEF123?x=1", `I-${"A".repeat(33)}`])(
    "rejects invalid id %j without fetching",
    async (id) => {
      await expect(getSubscription(id)).rejects.toThrow(/invalid PayPal subscription id/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("throws PayPalApiError with only status, name and debug_id", async () => {
    queue(tokenResponse(), json({ name: "RESOURCE_NOT_FOUND", debug_id: "dbg-9", message: "private detail" }, 404));
    const err = await getSubscription("I-ABCDEF123").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(404);
    expect(err.paypalName).toBe("RESOURCE_NOT_FOUND");
    expect(err.debugId).toBe("dbg-9");
    expect(err.message).not.toContain("private detail");
  });
});

describe("cancelSubscription", () => {
  it("returns ok on 204 and trims/limits the reason", async () => {
    queue(tokenResponse(), new Response(null, { status: 204 }));
    expect(await cancelSubscription("I-ABCDEF123", `  ${"r".repeat(200)}  `)).toEqual({ ok: true });
    const { url, init } = callAt(1);
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-ABCDEF123/cancel");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "r".repeat(127) });
  });

  it("defaults an empty reason", async () => {
    queue(tokenResponse(), new Response(null, { status: 204 }));
    await cancelSubscription("I-ABCDEF123", "   ");
    expect(JSON.parse(callAt(1).init.body as string)).toEqual({ reason: "Cancelled by Compute Atlas" });
  });

  it("treats 422 SUBSCRIPTION_STATUS_INVALID as already inactive", async () => {
    queue(
      tokenResponse(),
      json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }] }, 422),
    );
    expect(await cancelSubscription("I-ABCDEF123", "buyer request")).toEqual({ ok: true, alreadyInactive: true });
  });

  it("throws on a 422 with a different issue", async () => {
    queue(tokenResponse(), json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "OTHER" }] }, 422));
    await expect(cancelSubscription("I-ABCDEF123", "x")).rejects.toBeInstanceOf(PayPalApiError);
  });

  it("throws on a 500", async () => {
    queue(tokenResponse(), json({ name: "INTERNAL_SERVER_ERROR" }, 500));
    await expect(cancelSubscription("I-ABCDEF123", "x")).rejects.toMatchObject({ status: 500 });
  });

  it("rejects an invalid id without fetching", async () => {
    await expect(cancelSubscription("nope", "x")).rejects.toThrow(/invalid PayPal subscription id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verifyWebhookSignature", () => {
  const CERT = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1";
  const goodHeaders = (overrides: Record<string, string> = {}) =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": CERT,
      "paypal-transmission-id": "tid-1",
      "paypal-transmission-sig": "sig-1",
      "paypal-transmission-time": "2026-11-11T00:00:00Z",
      ...overrides,
    });
  const event = { id: "WH-EVT-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-ABCDEF123" } };
  const body = JSON.stringify(event);

  it("returns verified with the same parsed event and posts the documented payload", async () => {
    queue(tokenResponse(), json({ verification_status: "SUCCESS" }));
    const result = await verifyWebhookSignature(goodHeaders(), body);
    expect(result).toEqual({ verified: true, event });
    const { url, init } = callAt(1);
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(JSON.parse(init.body as string)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: CERT,
      transmission_id: "tid-1",
      transmission_sig: "sig-1",
      transmission_time: "2026-11-11T00:00:00Z",
      webhook_id: "WH-123",
      webhook_event: event,
    });
  });

  it("is not verified on a FAILURE answer", async () => {
    queue(tokenResponse(), json({ verification_status: "FAILURE" }));
    expect(await verifyWebhookSignature(goodHeaders(), body)).toEqual({ verified: false });
  });

  it.each([
    ["an HTML body", new Response("<html>", { status: 200 })],
    ["an empty object", json({})],
    ["a non-string verification_status", json({ verification_status: 1 })],
  ])("throws on a 200 with %s", async (_n, res) => {
    queue(tokenResponse(), res);
    await expect(verifyWebhookSignature(goodHeaders(), body)).rejects.toMatchObject({
      status: 0,
      paypalName: "UNEXPECTED_RESPONSE",
    });
  });

  it.each([400, 422])("is not verified when PayPal answers %i", async (status) => {
    queue(tokenResponse(), json({ name: "INVALID_REQUEST" }, status));
    expect(await verifyWebhookSignature(goodHeaders(), body)).toEqual({ verified: false });
  });

  it.each([
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
  ])("is not verified, with no fetch, when %s is missing", async (name) => {
    const headers = goodHeaders();
    headers.delete(name);
    expect(await verifyWebhookSignature(headers, body)).toEqual({ verified: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong algo", { "paypal-auth-algo": "SHA1withRSA" }],
    ["suffix-spoofed cert host", { "paypal-cert-url": "https://api.paypal.com.evil.com/certs/1" }],
    ["prefix-spoofed cert host", { "paypal-cert-url": "https://evilapi.paypal.com/certs/1" }],
    ["userinfo-spoofed cert host", { "paypal-cert-url": "https://api.paypal.com@evil.com/certs/1" }],
    ["http cert url", { "paypal-cert-url": "http://api.paypal.com/certs/1" }],
    ["unparseable cert url", { "paypal-cert-url": "not a url" }],
    ["cert url with a port", { "paypal-cert-url": "https://api.paypal.com:8443/certs/1" }],
    ["cert url with userinfo", { "paypal-cert-url": "https://user:pw@api.paypal.com/certs/1" }],
  ])("is not verified, with no fetch: %s", async (_name, overrides) => {
    expect(await verifyWebhookSignature(goodHeaders(overrides), body)).toEqual({ verified: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["https://api.paypal.com/v1/x", "https://API-M.PayPal.com/v1/x", "https://api-m.sandbox.paypal.com/v1/x"])(
    "accepts cert host in %s",
    async (cert) => {
      queue(tokenResponse(), json({ verification_status: "SUCCESS" }));
      expect((await verifyWebhookSignature(goodHeaders({ "paypal-cert-url": cert }), body)).verified).toBe(true);
    },
  );

  it.each([
    ["invalid JSON", "{not json"],
    ["null", "null"],
    ["array", "[]"],
    ["primitive", "42"],
    ["missing id", JSON.stringify({ event_type: "X" })],
    ["empty id", JSON.stringify({ id: "", event_type: "X" })],
    ["missing event_type", JSON.stringify({ id: "WH-1" })],
    ["non-string event_type", JSON.stringify({ id: "WH-1", event_type: 5 })],
    ["null resource", JSON.stringify({ id: "WH-1", event_type: "X", resource: null })],
    ["array resource", JSON.stringify({ id: "WH-1", event_type: "X", resource: [] })],
    ["primitive resource", JSON.stringify({ id: "WH-1", event_type: "X", resource: "s" })],
    ["non-string resource_type", JSON.stringify({ id: "WH-1", event_type: "X", resource_type: 1 })],
    ["non-string create_time", JSON.stringify({ id: "WH-1", event_type: "X", create_time: {} })],
  ])("is not verified, with no fetch, for body: %s", async (_name, raw) => {
    expect(await verifyWebhookSignature(goodHeaders(), raw)).toEqual({ verified: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a 5xx so the route can answer 500", async () => {
    queue(tokenResponse(), json({ name: "INTERNAL_SERVER_ERROR" }, 500));
    await expect(verifyWebhookSignature(goodHeaders(), body)).rejects.toMatchObject({ status: 500 });
  });

  it("throws on a network failure", async () => {
    queue(tokenResponse());
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(verifyWebhookSignature(goodHeaders(), body)).rejects.toBeInstanceOf(PayPalApiError);
  });

  it("throws when a 200 response body cannot be read", async () => {
    queue(tokenResponse());
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.reject(new TypeError("terminated")) });
    await expect(verifyWebhookSignature(goodHeaders(), body)).rejects.toMatchObject({ status: 0, paypalName: "NETWORK_ERROR" });
  });

  it("forwards the parsed cert URL, not the raw header", async () => {
    queue(tokenResponse(), json({ verification_status: "SUCCESS" }));
    await verifyWebhookSignature(goodHeaders({ "paypal-cert-url": "https://API.paypal.com/v1/x y" }), body);
    expect(JSON.parse(callAt(1).init.body as string).cert_url).toBe("https://api.paypal.com/v1/x%20y");
  });

  it("fails closed with PayPalConfigError when PAYPAL_WEBHOOK_ID is missing", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const err = await verifyWebhookSignature(goodHeaders(), body).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalConfigError);
    expect(err.variable).toBe("PAYPAL_WEBHOOK_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("error labels and redaction", () => {
  it("drops labels that fail the allowlist", async () => {
    queue(tokenResponse(), json({ name: "lower case!", debug_id: "has spaces" }, 400));
    const err = await getSubscription("I-ABCDEF123").catch((e) => e);
    expect(err.paypalName).toBeUndefined();
    expect(err.debugId).toBeUndefined();
    expect(err.message).toBe("PayPal API error: HTTP 400");
  });

  it.each([
    ["80-char secret-shaped debug_id", "a".repeat(80)],
    ["97-char token-shaped debug_id", `A21-${"B".repeat(93)}`],
  ])("drops a %s by the allowlist alone", async (_n, id) => {
    queue(tokenResponse(), json({ name: "INVALID_REQUEST", debug_id: id }, 400));
    const err = await getSubscription("I-ABCDEF123").catch((e) => e);
    expect(err.debugId).toBeUndefined();
    expect(err.message).not.toContain(id);
  });

  it("never leaks the client secret or access token via errors or console output", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const hostile = { name: `${SECRET}_${TOKEN}`, debug_id: `${SECRET}-${TOKEN}`, message: `${SECRET} ${TOKEN}` };
    queue(tokenResponse(), json(hostile, 400));
    const apiErr = await getSubscription("I-ABCDEF123").catch((e) => e);

    resetPayPalTokenCacheForTests();
    queue(json({ ...hostile, error_description: SECRET }, 401));
    const tokenErr = await getSubscription("I-ABCDEF123").catch((e) => e);

    const basic = Buffer.from(`client-id-1:${SECRET}`).toString("base64");
    for (const err of [apiErr, tokenErr]) {
      expect(err).toBeInstanceOf(PayPalApiError);
      const own = Object.getOwnPropertyNames(err).map((k) => String((err as unknown as Record<string, unknown>)[k]));
      const dump = [String(err), err.message, JSON.stringify(err), ...own].join("\n");
      for (const secret of [SECRET, TOKEN, basic]) expect(dump).not.toContain(secret);
    }
    const logged = spies.flatMap((spy) => spy.mock.calls.map((c) => JSON.stringify(c))).join("\n");
    for (const secret of [SECRET, TOKEN, basic]) expect(logged).not.toContain(secret);
  });
});
