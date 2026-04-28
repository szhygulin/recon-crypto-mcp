/**
 * Unit tests for the drainer-pattern detector (issue #454).
 *
 * Pure function — no I/O, no async. Asserts the marker / template
 * lists exactly so a future addition or removal is visible in the
 * test suite.
 */
import { describe, it, expect } from "vitest";
import {
  assertNoDrainerPattern,
  detectDrainerPattern,
} from "../src/security/drainer-pattern.js";

describe("detectDrainerPattern", () => {
  it("returns null for legitimate Sign-In-with-Bitcoin messages", () => {
    expect(
      detectDrainerPattern(
        "example.com wants you to sign in with your Bitcoin account.\nNonce: abc123\n",
      ),
    ).toBeNull();
    expect(
      detectDrainerPattern("Verify ownership of bc1q… for exchange Foo"),
    ).toBeNull();
    expect(detectDrainerPattern("Proof of funds for Q4 audit")).toBeNull();
  });

  it("returns null for plain non-drainer text", () => {
    expect(detectDrainerPattern("hello world")).toBeNull();
    expect(detectDrainerPattern("")).toBeNull();
  });

  describe("single-word semantic markers", () => {
    const cases = [
      ["transfer", "Please transfer 1 BTC"],
      ["authorize", "I will authorize the move later"],
      ["grant", "Hereby grant access"],
      ["custody", "Custody change confirmed"],
      ["release", "Release funds to Alice"],
      ["consent", "Consent given for the operation"],
    ] as const;

    for (const [marker, text] of cases) {
      it(`flags "${marker}" inside "${text}"`, () => {
        const hit = detectDrainerPattern(text);
        expect(hit).not.toBeNull();
        expect(hit!.kind).toBe("marker");
        expect(hit!.pattern).toBe(marker);
      });
    }

    it("is case-insensitive", () => {
      expect(detectDrainerPattern("AUTHORIZE this")?.pattern).toBe("authorize");
      expect(detectDrainerPattern("AuThOrIzE this")?.pattern).toBe("authorize");
    });

    it("matches as substring (catches embedded markers)", () => {
      expect(detectDrainerPattern("pretransferofficial")?.pattern).toBe("transfer");
    });
  });

  describe("multi-word drainer templates take precedence over markers", () => {
    it('"I authorize" surfaces as template, not as the bare "authorize" marker', () => {
      const hit = detectDrainerPattern("I authorize Acme Corp to act");
      expect(hit?.kind).toBe("template");
      expect(hit?.pattern).toBe("i authorize");
    });

    it('"granting full custody" surfaces as template', () => {
      const hit = detectDrainerPattern(
        "I am granting full custody to the operator",
      );
      expect(hit?.kind).toBe("template");
      expect(hit?.pattern).toBe("granting full custody");
    });

    it('"I consent to" surfaces as template', () => {
      const hit = detectDrainerPattern("I consent to the share");
      expect(hit?.kind).toBe("template");
      expect(hit?.pattern).toBe("i consent to");
    });

    it('"I hereby transfer" surfaces as template', () => {
      const hit = detectDrainerPattern("I hereby transfer ownership");
      expect(hit?.kind).toBe("template");
      expect(hit?.pattern).toBe("i hereby transfer");
    });

    it('"release my" surfaces as template', () => {
      const hit = detectDrainerPattern("Please release my deposit");
      expect(hit?.kind).toBe("template");
      expect(hit?.pattern).toBe("release my");
    });
  });
});

describe("assertNoDrainerPattern", () => {
  it("returns silently when no pattern present", () => {
    expect(() =>
      assertNoDrainerPattern("Verify ownership of address X for exchange Y"),
    ).not.toThrow();
  });

  it("throws on a single-word marker with the marker name in the message", () => {
    expect(() => assertNoDrainerPattern("Please transfer to me")).toThrow(
      /MESSAGE-SIGN REFUSED.*marker.*transfer/,
    );
  });

  it("throws on a multi-word template with the template phrase in the message", () => {
    expect(() => assertNoDrainerPattern("I authorize the move")).toThrow(
      /MESSAGE-SIGN REFUSED.*template.*"i authorize"/,
    );
  });

  it("error message includes recovery hint", () => {
    let err: Error | undefined;
    try {
      assertNoDrainerPattern("Please grant me access");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/Reword the message|non-vaultpilot signing tool/);
  });
});
