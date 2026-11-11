export type CommercialPlan = "monthly" | "annual";

const SUBSCRIPTION_STATUSES = ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"] as const;

export type PayPalSubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The single object parsed from a webhook body and verified by PayPal; routes must act only on this. */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
  create_time?: string;
}

export interface PayPalSubscription {
  id: string;
  status: PayPalSubscriptionStatus;
  planId: string | null;
  customId: string | null;
  payerId: string | null;
  payerEmail: string | null;
  startTime: string | null;
  nextBillingTime: string | null;
  /** `amount` is PayPal's decimal string, never a float. */
  lastPayment: { amount: string; currency: string; time: string } | null;
}

export interface PayPalTransaction {
  id: string;
  status: string;
  gross: string | null;
  currency: string | null;
  time: string | null;
}

/** Missing or invalid PayPal configuration. Callers map it to 503; nothing falls back. */
export class PayPalConfigError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing or invalid PayPal configuration: ${variable}`);
    this.name = "PayPalConfigError";
    this.variable = variable;
  }
}

/** A failed PayPal call. Carries the status, PayPal's `name` and `debug_id` only; never the body, token or secret. */
export class PayPalApiError extends Error {
  readonly status: number;
  readonly paypalName: string | undefined;
  readonly debugId: string | undefined;
  constructor(status: number, paypalName: string | undefined, debugId: string | undefined) {
    super(
      `PayPal API error: HTTP ${status}${paypalName ? ` ${paypalName}` : ""}${
        debugId ? ` (debug_id ${debugId})` : ""
      }`,
    );
    this.name = "PayPalApiError";
    this.status = status;
    this.paypalName = paypalName;
    this.debugId = debugId;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const SUBSCRIPTION_ID = /^I-[A-Z0-9]{6,32}$/;
const DEFAULT_CANCEL_REASON = "Cancelled by Compute Atlas";
const CHECKOUT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SALE_ID = /^[A-Z0-9]{10,32}$/;

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

const APPROVE_ORIGINS = {
  sandbox: "https://www.sandbox.paypal.com",
  live: "https://www.paypal.com",
} as const;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new PayPalConfigError(name);
  return value;
}

function paypalEnv(): "sandbox" | "live" {
  const value = process.env.PAYPAL_ENV?.trim();
  if (value === "sandbox" || value === "live") return value;
  throw new PayPalConfigError("PAYPAL_ENV");
}

export function planIdFor(plan: CommercialPlan): string {
  switch (plan) {
    case "monthly":
      return requireEnv("PAYPAL_PLAN_COMMERCIAL_MONTHLY");
    case "annual":
      return requireEnv("PAYPAL_PLAN_COMMERCIAL_ANNUAL");
    default:
      // An unvalidated string must never silently map to a plan.
      throw new Error("unknown commercial plan");
  }
}

export function planForPlanId(id: string): CommercialPlan | null {
  if (id === planIdFor("monthly")) return "monthly";
  if (id === planIdFor("annual")) return "annual";
  return null;
}

/** Both configured commercial plan ids; the webhook accepts a subscription only if its plan is in here. */
export function allowedCommercialPlanIds(): Set<string> {
  return new Set([planIdFor("monthly"), planIdFor("annual")]);
}

// --- OAuth token cache ---------------------------------------------------

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;
// One token request at a time per cache key, so concurrent cold-cache calls share it.
let inflightToken: { key: string; promise: Promise<string> } | null = null;

/** Test-only: forget the cached access token. */
export function resetPayPalTokenCacheForTests(): void {
  cachedToken = null;
  inflightToken = null;
}

type Json = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Allowlists, not sanitizers: PayPal-controlled text must not reach an error message or log.
// A value that embeds the client secret is dropped even if it fits the pattern; the length caps keep tokens out.
function label(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string" || !pattern.test(value)) return undefined;
  const secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (secret && value.includes(secret)) return undefined;
  return value;
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

async function readJson(res: Response): Promise<Json> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    // A body cut off mid-read is a network failure, not an empty answer: callers must see it throw.
    throw new PayPalApiError(0, "NETWORK_ERROR", undefined);
  }
  try {
    return asObject(JSON.parse(text));
  } catch {
    return {};
  }
}

function toApiError(status: number, data: Json): PayPalApiError {
  return new PayPalApiError(status, label(data.name, /^[A-Z_]{1,64}$/), label(data.debug_id, /^[A-Za-z0-9-]{1,64}$/));
}

async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    // The underlying error is dropped on purpose: it is not ours to forward into logs.
    throw new PayPalApiError(0, "NETWORK_ERROR", undefined);
  }
}

async function getAccessToken(): Promise<string> {
  const env = paypalEnv();
  const clientId = requireEnv("PAYPAL_CLIENT_ID");
  const clientSecret = requireEnv("PAYPAL_CLIENT_SECRET");
  const key = `${env}:${clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }
  if (inflightToken && inflightToken.key === key) return inflightToken.promise;
  const entry = { key, promise: requestToken(env, clientId, clientSecret, key) };
  inflightToken = entry;
  try {
    return await entry.promise;
  } finally {
    if (inflightToken === entry) inflightToken = null;
  }
}

async function requestToken(env: "sandbox" | "live", clientId: string, clientSecret: string, key: string): Promise<string> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await rawFetch(`${BASE_URLS[env]}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const data = await readJson(res);
  const token = str(data.access_token);
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
  if (!res.ok || !token) throw toApiError(res.status, data);
  cachedToken = { key, token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

interface SendOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

/** Authenticated call. Returns non-2xx results to the caller; retries once on 401 with a fresh token. */
async function send(
  method: "GET" | "POST",
  path: string,
  options: SendOptions = {},
): Promise<{ status: number; ok: boolean; data: Json }> {
  const attempt = async () => {
    const token = await getAccessToken();
    const res = await rawFetch(`${BASE_URLS[paypalEnv()]}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return { status: res.status, ok: res.ok, data: await readJson(res) };
  };
  let result = await attempt();
  if (result.status === 401) {
    cachedToken = null;
    result = await attempt();
  }
  return result;
}

async function call(method: "GET" | "POST", path: string, options?: SendOptions): Promise<Json> {
  const { status, ok, data } = await send(method, path, options);
  if (!ok) throw toApiError(status, data);
  return data;
}

// --- Subscriptions -------------------------------------------------------

export async function createSubscription({
  plan,
  checkoutId,
  returnUrl,
  cancelUrl,
}: {
  plan: CommercialPlan;
  checkoutId: string;
  returnUrl: string;
  cancelUrl: string;
}): Promise<{ subscriptionId: string; approveUrl: string }> {
  if (!CHECKOUT_ID.test(checkoutId)) throw new Error("invalid checkout id");
  const planId = planIdFor(plan);
  const data = await call("POST", "/v1/billing/subscriptions", {
    headers: { "PayPal-Request-Id": `ca-sub-${checkoutId}` },
    body: {
      plan_id: planId,
      custom_id: checkoutId,
      application_context: {
        brand_name: "Compute Atlas",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  });
  const subscriptionId = str(data.id);
  const links = Array.isArray(data.links) ? data.links.map(asObject) : [];
  const href = str(links.find((l) => l.rel === "approve")?.href);
  if (!subscriptionId || !href) {
    throw new Error("PayPal returned a subscription without an id or approve link");
  }
  let approve: URL;
  try {
    approve = new URL(href);
  } catch {
    throw new Error("PayPal returned an unparseable approve link");
  }
  if (approve.origin !== APPROVE_ORIGINS[paypalEnv()]) {
    throw new Error("PayPal returned an approve link with an unexpected origin");
  }
  return { subscriptionId, approveUrl: approve.href };
}

function assertSubscriptionId(id: string): void {
  if (!SUBSCRIPTION_ID.test(id)) throw new Error("invalid PayPal subscription id");
}

/** Only `status === "ACTIVE"` may grant access; every other status, known or not, must not. */
export async function getSubscription(id: string): Promise<PayPalSubscription> {
  assertSubscriptionId(id);
  const data = await call("GET", `/v1/billing/subscriptions/${id}`);
  const status = SUBSCRIPTION_STATUSES.find((known) => known === data.status);
  if (!status) throw new PayPalApiError(0, "UNEXPECTED_STATUS", undefined);
  const subscriber = asObject(data.subscriber);
  const billing = asObject(data.billing_info);
  const last = asObject(billing.last_payment);
  const lastAmount = asObject(last.amount);
  const amount = str(lastAmount.value);
  const currency = str(lastAmount.currency_code);
  const time = str(last.time);
  return {
    id: str(data.id) ?? id,
    status,
    planId: str(data.plan_id),
    customId: str(data.custom_id),
    payerId: str(subscriber.payer_id),
    payerEmail: str(subscriber.email_address),
    startTime: str(data.start_time),
    nextBillingTime: str(billing.next_billing_time),
    lastPayment: amount && currency && time ? { amount, currency, time } : null,
  };
}

/**
 * Sandbox measured 2026-11-11: cancelling an APPROVAL_PENDING (never-approved) subscription returns
 * 404 RESOURCE_NOT_FOUND. That still throws PayPalApiError(404); callers decide what it means.
 */
export async function cancelSubscription(
  id: string,
  reason: string,
): Promise<{ ok: true; alreadyInactive?: true }> {
  assertSubscriptionId(id);
  const { status, ok, data } = await send("POST", `/v1/billing/subscriptions/${id}/cancel`, {
    body: { reason: reason.trim().slice(0, 127) || DEFAULT_CANCEL_REASON },
  });
  if (ok) return { ok: true };
  const details = Array.isArray(data.details) ? data.details.map(asObject) : [];
  if (status === 422 && details.some((d) => d.issue === "SUBSCRIPTION_STATUS_INVALID")) {
    return { ok: true, alreadyInactive: true };
  }
  throw toApiError(status, data);
}

// Reads one page only: enough to locate a subscription's first payment, not a full history.
export async function listSubscriptionTransactions(
  id: string,
  startTime: string,
  endTime: string,
): Promise<PayPalTransaction[]> {
  assertSubscriptionId(id);
  const query = new URLSearchParams({ start_time: startTime, end_time: endTime });
  const data = await call("GET", `/v1/billing/subscriptions/${id}/transactions?${query}`);
  const rows = Array.isArray(data.transactions) ? data.transactions.map(asObject) : [];
  return rows.map((row) => {
    const gross = asObject(asObject(row.amount_with_breakdown).gross_amount);
    return {
      id: str(row.id) ?? "",
      status: str(row.status) ?? "",
      gross: str(gross.value),
      currency: str(gross.currency_code),
      time: str(row.time),
    };
  });
}

export async function refundSale(saleId: string): Promise<{ refundId: string; status: string }> {
  if (!SALE_ID.test(saleId)) throw new Error("invalid PayPal sale id");
  const data = await call("POST", `/v1/payments/sale/${saleId}/refund`, {
    headers: { "PayPal-Request-Id": `ca-refund-${saleId}` },
    body: {},
  });
  const refundId = str(data.id);
  if (!refundId) throw new Error("PayPal returned a refund without an id");
  return { refundId, status: str(data.state) ?? str(data.status) ?? "" };
}

// --- Webhooks ------------------------------------------------------------

const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

const CERT_HOSTS = new Set(["api.paypal.com", "api-m.paypal.com", "api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);

/** The parsed cert URL when it is plain https on a known PayPal host (default port, no userinfo), else null. */
function payPalCertUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const ok =
      url.protocol === "https:" &&
      CERT_HOSTS.has(url.hostname.toLowerCase()) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "";
    return ok ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Verified only when PayPal itself reports SUCCESS, and then returns the one event object that was sent to
 * PayPal; routes must act only on it. Missing or malformed headers, a bad cert host, a wrong algorithm or an
 * unusable body are `{ verified: false }` with no network call, as is a 400/422 or non-SUCCESS answer from
 * PayPal. A missing webhook id throws (fail closed); network and 5xx errors throw so the route answers 500 and
 * PayPal retries.
 */
export async function verifyWebhookSignature(
  headers: Headers,
  rawBody: string,
): Promise<{ verified: true; event: PayPalWebhookEvent } | { verified: false }> {
  const webhookId = requireEnv("PAYPAL_WEBHOOK_ID");
  const [authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime] = SIGNATURE_HEADERS.map(
    (name) => headers.get(name)?.trim() ?? "",
  );
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return { verified: false };
  const certHref = payPalCertUrl(certUrl);
  if (authAlgo !== "SHA256withRSA" || !certHref) return { verified: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { verified: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { verified: false };
  const event = parsed as Json;
  if (!str(event.id) || !str(event.event_type)) return { verified: false };
  const optionalString = (v: unknown) => v === undefined || typeof v === "string";
  const resource = event.resource;
  if (
    !optionalString(event.resource_type) ||
    !optionalString(event.create_time) ||
    (resource !== undefined && (!resource || typeof resource !== "object" || Array.isArray(resource)))
  ) {
    return { verified: false };
  }
  const { status, ok, data } = await send("POST", "/v1/notifications/verify-webhook-signature", {
    body: {
      auth_algo: authAlgo,
      cert_url: certHref,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  if (!ok) {
    if (status === 400 || status === 422) return { verified: false };
    throw toApiError(status, data);
  }
  // A 2xx we cannot read as a verdict must throw (route answers 500, PayPal retries), not read as "not verified".
  if (typeof data.verification_status !== "string") throw new PayPalApiError(0, "UNEXPECTED_RESPONSE", undefined);
  if (data.verification_status !== "SUCCESS") return { verified: false };
  return { verified: true, event: event as unknown as PayPalWebhookEvent };
}
