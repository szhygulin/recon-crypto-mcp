/**
 * Swap routing policy in `prepareSwap`: chooses direct Uniswap V3 vs LiFi
 * based on quote parity (1.0% L1 / 0.5% L2). Cross-chain always goes via
 * LiFi and gets stamped `blind-sign-unavoidable`. Same-chain direct wins if
 * its minOut is within the threshold of LiFi's; otherwise LiFi wins and the
 * gap is surfaced via `rejectedAlternative`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UnsignedTx } from "../src/types/index.js";

const WALLET = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075" as `0x${string}`;
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`;
const USDC_POLY = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as `0x${string}`;
const SWAP_ROUTER_ETH = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as `0x${string}`;
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as `0x${string}`;

function makeLifiQuote({
  toAmount,
  toAmountMin,
  approvalAddress = LIFI_DIAMOND,
  toToken = { symbol: "USDC", decimals: 6, address: USDC_ETH, priceUSD: "1" },
  fromToken = { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000", priceUSD: "3000" },
  fromAmount = "1000000000000000000",
}: {
  toAmount: string;
  toAmountMin: string;
  approvalAddress?: string;
  toToken?: Record<string, unknown>;
  fromToken?: Record<string, unknown>;
  fromAmount?: string;
}) {
  return {
    tool: "lifi-test-tool",
    action: { fromToken, toToken, fromAmount },
    estimate: {
      fromAmount,
      toAmount,
      toAmountMin,
      executionDuration: 30,
      approvalAddress,
      feeCosts: [],
      gasCosts: [],
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: "0xdeadbeef",
      value: "1000000000000000000",
      gasLimit: "300000",
    },
  };
}

function makeDirectResult({
  expectedOut,
  minOut,
}: {
  expectedOut: bigint;
  minOut: bigint;
}) {
  const tx: UnsignedTx = {
    chain: "ethereum",
    to: SWAP_ROUTER_ETH,
    data: "0xabcdef00",
    value: "1000000000000000000",
    from: WALLET,
    description: "direct swap",
    decoded: {
      functionName: "multicall",
      args: { route: "Uniswap V3 direct (0.05% fee)", expectedOut: expectedOut.toString(), minOut: minOut.toString() },
    },
  };
  return { tx, expectedOut, minOut, routeDescription: "Uniswap V3 direct (0.05% fee)" };
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock("../src/config/user-config.js", () => ({
    readUserConfig: () => null,
    resolveOneInchApiKey: () => undefined,
  }));
  // Native fromToken so prepareSwap skips the ERC-20 approval branch that
  // would otherwise call readContract for allowance. readOnchainDecimals on
  // toToken still calls readContract; mock returns 6 (matches USDC).
  vi.doMock("../src/data/rpc.js", () => ({
    getClient: () => ({
      readContract: async () => 6,
    }),
    verifyChainId: vi.fn().mockResolvedValue(undefined),
    resetClients: vi.fn(),
  }));
});

afterEach(() => vi.restoreAllMocks());

describe("prepareSwap routing — cross-chain", () => {
  it("always picks LiFi and stamps blind-sign-unavoidable for cross-chain", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () =>
        makeLifiQuote({
          toAmount: "3000000000",
          toAmountMin: "2985000000",
          toToken: { symbol: "USDC", decimals: 6, address: USDC_POLY, priceUSD: "1" },
        }),
      fetchStatus: async () => ({}),
    }));
    // Direct shouldn't even be called for cross-chain — assert it stays unmocked.
    vi.doMock("../src/modules/swap/uniswap-v3-direct.js", () => ({
      buildUniswapV3DirectSwap: async () => {
        throw new Error("direct should not be called for cross-chain swaps");
      },
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: WALLET,
      fromChain: "ethereum",
      toChain: "polygon",
      fromToken: "native",
      toToken: USDC_POLY,
      amount: "1",
      slippageBps: 50,
    });
    expect(tx.trustMode).toBe("blind-sign-unavoidable");
    expect(tx.trustDetails?.reason).toMatch(/cross-chain|bridge|irreversible/i);
    expect(tx.decoded?.args?.routingDecision).toBe("lifi-bridge");
  });
});

describe("prepareSwap routing — same-chain", () => {
  it("picks direct-V3 when its minOut beats LiFi within threshold", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () =>
        makeLifiQuote({ toAmount: "3000000000", toAmountMin: "2985000000" }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/uniswap-v3-direct.js", () => ({
      // direct minOut 3,000,000,000 — better than LiFi's 2,985,000,000.
      buildUniswapV3DirectSwap: async () =>
        makeDirectResult({ expectedOut: 3_010_000_000n, minOut: 3_000_000_000n }),
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
      slippageBps: 50,
    });
    expect(tx.to.toLowerCase()).toBe(SWAP_ROUTER_ETH.toLowerCase());
    expect(tx.decoded?.args?.routingDecision).toBe("direct-v3");
    // direct path is targeted by issueHandles classifier — but prepareSwap
    // doesn't go through issueHandles in this isolated test, so trustMode
    // is undefined. We're asserting on routingDecision instead, which is
    // stamped synchronously inside prepareSwap.
  });

  it("falls back to LiFi when direct is worse than the threshold and surfaces the gap", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () =>
        makeLifiQuote({ toAmount: "3000000000", toAmountMin: "3000000000" }),
      fetchStatus: async () => ({}),
    }));
    // Direct's minOut is 2,000,000,000 — that's a 33% gap, way over L1's 1% bound.
    vi.doMock("../src/modules/swap/uniswap-v3-direct.js", () => ({
      buildUniswapV3DirectSwap: async () =>
        makeDirectResult({ expectedOut: 2_010_000_000n, minOut: 2_000_000_000n }),
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
      slippageBps: 50,
    });
    expect(tx.to.toLowerCase()).toBe(LIFI_DIAMOND.toLowerCase());
    expect(tx.decoded?.args?.routingDecision).toBe("lifi");
    const rejected = JSON.parse(tx.decoded?.args?.rejectedAlternative as string);
    expect(rejected.route).toBe("direct-v3");
    expect(rejected.gapBps).toBeGreaterThan(100); // beyond L1's 100 bps threshold
  });

  it("falls back to LiFi when direct returns null (no route)", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () =>
        makeLifiQuote({ toAmount: "3000000000", toAmountMin: "2985000000" }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/uniswap-v3-direct.js", () => ({
      buildUniswapV3DirectSwap: async () => null,
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
      slippageBps: 50,
    });
    expect(tx.to.toLowerCase()).toBe(LIFI_DIAMOND.toLowerCase());
    expect(tx.decoded?.args?.routingDecision).toBe("lifi");
    expect(tx.decoded?.args?.rejectedAlternative).toBeUndefined();
  });

  it("uses L1 1.0% threshold — direct shortfall of 90 bps is accepted", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () =>
        makeLifiQuote({ toAmount: "10000", toAmountMin: "10000" }),
      fetchStatus: async () => ({}),
    }));
    // 10000 * 0.991 = 9910 — within 1% threshold (which permits 9900).
    vi.doMock("../src/modules/swap/uniswap-v3-direct.js", () => ({
      buildUniswapV3DirectSwap: async () =>
        makeDirectResult({ expectedOut: 9910n, minOut: 9910n }),
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
      slippageBps: 50,
    });
    expect(tx.decoded?.args?.routingDecision).toBe("direct-v3");
  });
});
