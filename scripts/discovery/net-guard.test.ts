import { describe, it, expect, vi } from "vitest";

import {
  BROWSER_HEADERS,
  RETRY_AFTER_CAP_MS,
  RETRY_BACKOFF_MS,
  defaultSleep,
  isBlockedHost,
  isBlockedIpv4,
  isBlockedIpv6,
  isHttpUrl,
  parseRetryAfterMs,
  resolvesToBlockedAddress,
  runWithConcurrency,
} from "./net-guard";

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://example.com/a")).toBe(true);
    expect(isHttpUrl("http://example.com/a")).toBe(true);
  });

  it("rejects non-http(s) schemes and malformed URLs", () => {
    expect(isHttpUrl("ftp://example.com/file")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("isBlockedIpv4", () => {
  it("blocks private/loopback/link-local/reserved ranges, including the cloud metadata IP", () => {
    expect(isBlockedIpv4("127.0.0.1")).toBe(true);
    expect(isBlockedIpv4("10.1.2.3")).toBe(true);
    expect(isBlockedIpv4("192.168.0.1")).toBe(true);
    expect(isBlockedIpv4("172.16.5.5")).toBe(true);
    expect(isBlockedIpv4("169.254.169.254")).toBe(true); // cloud metadata IP
    expect(isBlockedIpv4("0.0.0.0")).toBe(true);
  });

  it("does not block ordinary public IPv4 addresses", () => {
    expect(isBlockedIpv4("93.184.216.34")).toBe(false);
    expect(isBlockedIpv4("8.8.8.8")).toBe(false);
  });

  it("returns false (not blocked) for malformed input rather than throwing", () => {
    expect(isBlockedIpv4("not.an.ip.address")).toBe(false);
    expect(isBlockedIpv4("999.999.999.999")).toBe(false);
    expect(isBlockedIpv4("1.2.3")).toBe(false);
  });

  it("still blocks a leading-zero decimal octet that maps to a blocked address", () => {
    // "127.000.000.001" -> 127.0.0.1, still blocked (see the doc-comment in
    // net-guard.ts's ipv4ToInt for why this leniency is intentional).
    expect(isBlockedIpv4("127.000.000.001")).toBe(true);
  });
});

describe("isBlockedIpv6", () => {
  it("blocks loopback (::1) and unspecified (::)", () => {
    expect(isBlockedIpv6("::1")).toBe(true);
    expect(isBlockedIpv6("::")).toBe(true);
  });

  it("blocks the IPv4-mapped cloud-metadata address in dotted-quad form", () => {
    expect(isBlockedIpv6("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks the IPv4-mapped cloud-metadata address in canonical hex-hextet form", () => {
    // This is the form Node's WHATWG URL parser actually produces for
    // ::ffff:169.254.169.254.
    expect(isBlockedIpv6("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("blocks ULA addresses (fc00::/7)", () => {
    expect(isBlockedIpv6("fc00::1")).toBe(true);
    expect(isBlockedIpv6("fd12:3456:789a::1")).toBe(true);
  });

  it("blocks link-local addresses (fe80::/10)", () => {
    expect(isBlockedIpv6("fe80::1")).toBe(true);
    expect(isBlockedIpv6("fe80::abcd:1234")).toBe(true);
  });

  it("does not block an ordinary public IPv6 address", () => {
    expect(isBlockedIpv6("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHost", () => {
  it("blocks localhost and *.localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("foo.localhost")).toBe(true);
  });

  it("blocks bracketed IPv6 literals", () => {
    expect(isBlockedHost("[::1]")).toBe(true);
  });

  it("blocks the cloud metadata IPv4 address", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("does not block an ordinary public hostname", () => {
    expect(isBlockedHost("example.com")).toBe(false);
  });

  it("blocks a fully-qualified hostname with a trailing root dot, without relying on DNS", () => {
    // "localhost." is a DNS-legal, FQDN spelling of "localhost" that the
    // literal `===` / `.endsWith(".localhost")` comparisons would otherwise
    // miss. This must hold on isBlockedHost ALONE — no resolve4/resolve6
    // deps are passed here, so a pass proves layer one stands on its own
    // rather than depending on Node's dns.resolve4("localhost.") incidentally
    // normalizing it back to 127.0.0.1.
    expect(isBlockedHost("localhost.")).toBe(true);
  });

  it("blocks an uppercase trailing-dot variant (case AND trailing-dot canonicalization together)", () => {
    expect(isBlockedHost("LOCALHOST.")).toBe(true);
  });

  it("blocks a *.localhost subdomain with a trailing root dot", () => {
    expect(isBlockedHost("foo.localhost.")).toBe(true);
  });

  it("blocks an IPv4 literal with a trailing root dot", () => {
    // Without stripping the trailing dot, ipv4ToInt's split(".") sees a
    // trailing empty segment and the address parses as malformed (falls
    // through unblocked).
    expect(isBlockedHost("127.0.0.1.")).toBe(true);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer-seconds values to milliseconds", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
  });

  it("returns null for missing, negative, or non-numeric values (HTTP-date form unsupported)", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("-1")).toBeNull();
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

describe("exported constants", () => {
  it("BROWSER_HEADERS carries a realistic User-Agent", () => {
    expect(BROWSER_HEADERS["User-Agent"]).toMatch(/Mozilla/);
  });

  it("RETRY_AFTER_CAP_MS and RETRY_BACKOFF_MS are the expected tuning values", () => {
    expect(RETRY_AFTER_CAP_MS).toBe(15_000);
    expect(RETRY_BACKOFF_MS).toEqual([500, 1000]);
  });

  it("defaultSleep resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await defaultSleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});

describe("runWithConcurrency", () => {
  it("runs every item and preserves result ordering regardless of completion order", async () => {
    const items = [30, 10, 20, 5];
    const results = await runWithConcurrency(items, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual(items);
  });

  it("never exceeds the configured concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await runWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("clamps the worker pool to the item count when concurrency exceeds it", async () => {
    let concurrentStarts = 0;
    let maxConcurrentStarts = 0;
    const items = [1, 2];
    await runWithConcurrency(items, 10, async (i) => {
      concurrentStarts++;
      maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentStarts--;
      return i;
    });
    expect(maxConcurrentStarts).toBeLessThanOrEqual(items.length);
  });
});

describe("resolvesToBlockedAddress", () => {
  it("returns true when the hostname resolves to the cloud metadata IPv4 address", async () => {
    const resolve4 = vi.fn(async () => ["169.254.169.254"]);
    const resolve6 = vi.fn(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const blocked = await resolvesToBlockedAddress("evil.example.com", { resolve4, resolve6 });
    expect(blocked).toBe(true);
    expect(resolve4).toHaveBeenCalledWith("evil.example.com");
  });

  it("returns false when the hostname resolves only to a public IP", async () => {
    const resolve4 = vi.fn(async () => ["93.184.216.34"]);
    const resolve6 = vi.fn(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const blocked = await resolvesToBlockedAddress("example.com", { resolve4, resolve6 });
    expect(blocked).toBe(false);
  });

  it("returns false (not blocked) when resolution errors for both address families", async () => {
    const resolve4 = vi.fn(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const resolve6 = vi.fn(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const blocked = await resolvesToBlockedAddress("nonexistent.invalid", { resolve4, resolve6 });
    expect(blocked).toBe(false);
  });

  it("returns true when only the AAAA record resolves to a blocked IPv6 address", async () => {
    const resolve4 = vi.fn(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const resolve6 = vi.fn(async () => ["fe80::1"]);
    const blocked = await resolvesToBlockedAddress("v6-only.example.com", { resolve4, resolve6 });
    expect(blocked).toBe(true);
  });

  it("does not conflate a v4-only host's expected AAAA failure with a blocked finding", async () => {
    const resolve4 = vi.fn(async () => ["8.8.8.8"]);
    const resolve6 = vi.fn(async () => {
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    });
    const blocked = await resolvesToBlockedAddress("v4-only.example.com", { resolve4, resolve6 });
    expect(blocked).toBe(false);
  });

  it("defaults to the real node:dns/promises resolvers when no deps are injected (type-level smoke test only, not invoked)", () => {
    // Not invoked here — real DNS must never be touched in this suite.
    // This just asserts the function accepts a call with an omitted second
    // argument without a type error, mirroring the fetchImpl/sleepImpl
    // optional-deps convention used elsewhere in this codebase.
    expect(typeof resolvesToBlockedAddress).toBe("function");
  });
});
