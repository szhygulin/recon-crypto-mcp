import { describe, it, expect } from "vitest";
import {
  assertCanonicalDispatchTarget,
  _enumerateAllowlistForTests,
} from "../src/security/canonical-dispatch.js";
import { CONTRACTS } from "../src/config/contracts.js";

/**
 * These tests pin the MCP-side mirror of skill v8's Invariant #1.a.
 * Two contracts are guarded:
 *
 *   1. Every entry in EXPECTED_TARGETS resolves to a real CONTRACTS
 *      address — i.e. the allowlist cannot silently fall out of sync
 *      with the source-of-truth file.
 *   2. The asserter throws on mismatch (with the canonical
 *      `[INV_1A]` / `✗ DISPATCH-TARGET MISMATCH` prose) and is a
 *      no-op for tools outside the allowlist (sends, etc.).
 */

describe("canonical-dispatch — Invariant #1.a MCP-side mirror", () => {
  it("every allowlist address resolves to a real CONTRACTS entry", () => {
    const enumerated = _enumerateAllowlistForTests();
    expect(enumerated.length).toBeGreaterThan(0);

    // Build the inverse: every lower-cased CONTRACTS address that
    // appears anywhere under any chain.
    const knownAddresses = new Set<string>();
    for (const chain of Object.values(CONTRACTS) as Array<Record<string, unknown>>) {
      walkValues(chain, (v) => {
        if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) {
          knownAddresses.add(v.toLowerCase());
        }
      });
    }

    for (const { family, chain, addresses } of enumerated) {
      for (const addr of addresses) {
        expect(
          knownAddresses.has(addr),
          `${family} on ${chain}: ${addr} is not in CONTRACTS — drift detected`,
        ).toBe(true);
      }
    }
  });

  it("throws on mismatch for a guarded tool family with the canonical prose", () => {
    // Aave Pool on Ethereum is 0x87870Bca... — feed a bogus address.
    const bogus = "0x000000000000000000000000000000000000dead";
    expect(() =>
      assertCanonicalDispatchTarget("prepare_aave_supply", "ethereum", bogus),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
    expect(() =>
      assertCanonicalDispatchTarget("prepare_aave_supply", "ethereum", bogus),
    ).toThrow(/INV_1A/);
  });

  it("passes when `to` is the canonical Aave Pool (case-insensitive)", () => {
    const pool = CONTRACTS.ethereum.aave.pool;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_aave_supply", "ethereum", pool),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget(
        "prepare_aave_supply",
        "ethereum",
        pool.toLowerCase(),
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget(
        "prepare_aave_supply",
        "ethereum",
        pool.toUpperCase().replace("0X", "0x"),
      ),
    ).not.toThrow();
  });

  it("matches by tool-family prefix — covers prepare_aave_borrow / _withdraw / _repay", () => {
    const pool = CONTRACTS.ethereum.aave.pool;
    for (const tool of [
      "prepare_aave_supply",
      "prepare_aave_withdraw",
      "prepare_aave_borrow",
      "prepare_aave_repay",
    ]) {
      expect(() =>
        assertCanonicalDispatchTarget(tool, "ethereum", pool),
      ).not.toThrow();
    }
  });

  it("Compound family accepts any of the chain's canonical Comets", () => {
    const cUSDC = CONTRACTS.ethereum.compound.cUSDCv3;
    const cUSDT = CONTRACTS.ethereum.compound.cUSDTv3;
    const cWETH = CONTRACTS.ethereum.compound.cWETHv3;
    for (const comet of [cUSDC, cUSDT, cWETH]) {
      expect(() =>
        assertCanonicalDispatchTarget("prepare_compound_supply", "ethereum", comet),
      ).not.toThrow();
    }
  });

  it("Lido stake/unstake are Ethereum-only — throws on other chains", () => {
    const stETH = CONTRACTS.ethereum.lido.stETH;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_lido_stake", "ethereum", stETH),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget(
        "prepare_lido_stake",
        "arbitrum",
        "0x0000000000000000000000000000000000000001",
      ),
    ).toThrow(/INV_1A/);
  });

  it("most-specific tool match wins — prepare_lido_unstake doesn't pick prepare_lido_*", () => {
    // prepare_lido_stake's allowlist is just stETH; prepare_lido_unstake
    // includes stETH AND withdrawalQueue. Asserting withdrawalQueue against
    // unstake should pass; against stake should fail.
    const queue = CONTRACTS.ethereum.lido.withdrawalQueue;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_lido_unstake", "ethereum", queue),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_lido_stake", "ethereum", queue),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
  });

  it("Uniswap swap targets SwapRouter02; v3 mint/collect/burn target NPM", () => {
    const router = CONTRACTS.ethereum.uniswap.swapRouter02;
    const npm = CONTRACTS.ethereum.uniswap.positionManager;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_swap", "ethereum", router),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_v3_mint", "ethereum", npm),
    ).not.toThrow();
    // Cross-fail: swap to NPM, or v3_mint to router
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_swap", "ethereum", npm),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
    expect(() =>
      assertCanonicalDispatchTarget("prepare_uniswap_v3_mint", "ethereum", router),
    ).toThrow(/DISPATCH-TARGET MISMATCH/);
  });

  it("EigenLayer deposit is Ethereum-only", () => {
    const sm = CONTRACTS.ethereum.eigenlayer.strategyManager;
    expect(() =>
      assertCanonicalDispatchTarget("prepare_eigenlayer_deposit", "ethereum", sm),
    ).not.toThrow();
  });

  it("is a no-op for tools without a canonical target (sends, swaps to user-supplied tokens)", () => {
    // prepare_native_send / prepare_token_send target user-supplied
    // addresses; not guarded.
    const arbitrary = "0x000000000000000000000000000000000000beef";
    expect(() =>
      assertCanonicalDispatchTarget("prepare_native_send", "ethereum", arbitrary),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_token_send", "ethereum", arbitrary),
    ).not.toThrow();
    expect(() =>
      assertCanonicalDispatchTarget("prepare_solana_native_send", "ethereum", arbitrary),
    ).not.toThrow();
  });
});

function walkValues(obj: unknown, fn: (v: unknown) => void): void {
  if (obj === null || obj === undefined) return;
  fn(obj);
  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) walkValues(v, fn);
  } else if (Array.isArray(obj)) {
    for (const v of obj) walkValues(v, fn);
  }
}
