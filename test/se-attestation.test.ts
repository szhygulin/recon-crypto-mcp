import { describe, it, expect } from "vitest";
import { verifyLedgerAttestation } from "../src/signing/se-attestation.ts";

/**
 * SE attestation framework tests (issue #325 P1). The actual crypto
 * check isn't implemented yet — these tests pin the framework's
 * `not-implemented` contract so future PRs that fill in the live-
 * device research don't accidentally regress the surface shape.
 */

describe("verifyLedgerAttestation (framework PR)", () => {
  it("returns status 'not-implemented' with a clear reason", async () => {
    const result = await verifyLedgerAttestation();
    expect(result.status).toBe("not-implemented");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/live-device|attestation root|APDU/i);
  });

  it("references the sibling defenses in its message so users know what IS in place", async () => {
    const result = await verifyLedgerAttestation();
    const ref = result.reason ?? "";
    // The reason should call out at least one sibling check by name —
    // belt-and-suspenders against a "this tool does nothing" reading.
    expect(
      /verify_ledger_firmware|verify_ledger_live_codesign|peer pin|firmware pinning|codesign/i.test(
        ref + " " + result.message,
      ),
    ).toBe(true);
  });

  it("never throws", async () => {
    // Pure function today; the contract is "no exceptions, structured
    // verdict only." Future implementations should preserve this.
    await expect(verifyLedgerAttestation()).resolves.toBeDefined();
  });
});
