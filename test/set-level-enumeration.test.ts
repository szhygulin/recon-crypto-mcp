import { describe, it, expect } from "vitest";
import { renderSetLevelEnumeration } from "../src/security/set-level-enumeration.js";
import type { GetTokenAllowancesResult } from "../src/modules/allowances/schemas.js";

/**
 * Pin the `[SET-LEVEL ENUMERATION]` block contract — skill v8's
 * Invariant #14 expects this exact header on every
 * `get_token_allowances` response.
 */

describe("[SET-LEVEL ENUMERATION] block — Inv #14 mandatory shape", () => {
  it("renders the canonical header line + per-row markdown table", () => {
    const payload: GetTokenAllowancesResult = {
      wallet: "0x1111111111111111111111111111111111111111",
      chain: "ethereum",
      token: {
        address: "0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        decimals: 6,
      },
      allowances: [
        {
          spender: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
          spenderLabel: "Aave V3 Pool",
          currentAllowance: "1000000000",
          currentAllowanceFormatted: "1000.00 USDC",
          isUnlimited: false,
          lastApprovedBlock: "12345678",
          lastApprovedTxHash: `0x${"ab".repeat(32)}`,
          lastApprovedAt: "2026-04-25T12:00:00Z",
        },
        {
          spender: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          currentAllowance: String(2n ** 256n - 1n),
          currentAllowanceFormatted: "unlimited",
          isUnlimited: true,
          lastApprovedBlock: "12000000",
          lastApprovedTxHash: `0x${"cd".repeat(32)}`,
        },
      ],
      totalScanned: 5,
      unlimitedCount: 1,
      truncated: false,
      notes: [],
    };
    const out = renderSetLevelEnumeration(payload);
    expect(out.startsWith("[SET-LEVEL ENUMERATION]")).toBe(true);
    expect(out).toContain("**Wallet:**");
    expect(out).toContain("USDC");
    expect(out).toContain("ethereum");
    expect(out).toContain("Aave V3 Pool");
    expect(out).toContain("**YES**");
    expect(out).toContain("Invariant #14");
    expect(out).toContain("| # | Spender | Label |");
  });

  it("renders the empty-list path without the table", () => {
    const payload: GetTokenAllowancesResult = {
      wallet: "0x1111111111111111111111111111111111111111",
      chain: "arbitrum",
      token: {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        symbol: "USDC",
        decimals: 6,
      },
      allowances: [],
      totalScanned: 0,
      unlimitedCount: 0,
      truncated: false,
      notes: [],
    };
    const out = renderSetLevelEnumeration(payload);
    expect(out).toContain("[SET-LEVEL ENUMERATION]");
    expect(out).toContain("No active allowances");
    expect(out).not.toContain("| # | Spender |");
  });

  it("surfaces the truncation warning when the indexer hit its row cap", () => {
    const payload: GetTokenAllowancesResult = {
      wallet: "0x1111111111111111111111111111111111111111",
      chain: "ethereum",
      token: {
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        decimals: 6,
      },
      allowances: [],
      totalScanned: 1000,
      unlimitedCount: 0,
      truncated: true,
      notes: ["Etherscan row cap reached."],
    };
    const out = renderSetLevelEnumeration(payload);
    expect(out).toContain("Indexer truncation flag set");
  });
});
