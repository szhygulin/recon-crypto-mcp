/**
 * Unit tests for the Inv #14 durable-binding helper module (issue
 * #460). Pure function — asserts the kind ↔ provenance-hint mapping
 * exactly so a future addition / removal is visible.
 */
import { describe, it, expect } from "vitest";
import {
  makeDurableBinding,
  type DurableBindingKind,
} from "../src/security/durable-binding.js";

const ALL_KINDS: DurableBindingKind[] = [
  "solana-validator-vote-pubkey",
  "tron-super-representative-address",
  "compound-comet-address",
  "morpho-blue-market-id",
  "marginfi-bank-pubkey",
  "uniswap-v3-lp-token-id",
  "btc-multisig-cosigner-xpub",
  "approval-spender-address",
];

describe("makeDurableBinding", () => {
  it("assembles {kind, identifier, provenanceHint} for every kind", () => {
    for (const kind of ALL_KINDS) {
      const b = makeDurableBinding(kind, "ANY-IDENTIFIER");
      expect(b.kind).toBe(kind);
      expect(b.identifier).toBe("ANY-IDENTIFIER");
      expect(typeof b.provenanceHint).toBe("string");
      expect(b.provenanceHint.length).toBeGreaterThan(20);
    }
  });

  it("preserves the identifier verbatim (no normalization, no truncation)", () => {
    const long = "0x".padEnd(66, "a");
    const b = makeDurableBinding("morpho-blue-market-id", long);
    expect(b.identifier).toBe(long);
  });

  it("each kind's provenance hint mentions an external authority by URL or app name", () => {
    const externalAuthorityRegex =
      /(stakewiz|validators\.app|tronscan|compound\.finance|morpho\.org|marginfi\.com|uniswap\.org|etherscan|backup card)/i;
    for (const kind of ALL_KINDS) {
      const b = makeDurableBinding(kind, "x");
      expect(b.provenanceHint).toMatch(externalAuthorityRegex);
    }
  });

  it("hints reference the corresponding adversarial smoke-test attack class", () => {
    const cases: Array<[DurableBindingKind, RegExp]> = [
      ["tron-super-representative-address", /b044/],
      ["compound-comet-address", /b053/],
      ["morpho-blue-market-id", /b055/],
      ["marginfi-bank-pubkey", /b059/],
      ["uniswap-v3-lp-token-id", /b063/],
      ["btc-multisig-cosigner-xpub", /b098/],
      ["approval-spender-address", /a086|b118/],
    ];
    for (const [kind, re] of cases) {
      const b = makeDurableBinding(kind, "x");
      expect(b.provenanceHint).toMatch(re);
    }
  });
});
