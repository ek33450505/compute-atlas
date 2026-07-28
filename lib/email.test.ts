import { describe, it, expect } from "vitest";
import { generateToken } from "./email";

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------
// The Resend send path (sendConfirmEmail / sendChangeNotification) needs a
// mocked client and is deferred to the security/test unit (Wave C, unit 6).
describe("generateToken", () => {
  it("returns a base64url string of the expected length for a 256-bit token", () => {
    const token = generateToken();
    // 32 bytes base64url-encoded, no padding, is 43 characters.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns a different token on each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});
