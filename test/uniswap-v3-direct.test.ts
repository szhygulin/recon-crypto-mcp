/**
 * Direct Uniswap V3 swap builder — selects single-hop vs multi-hop, encodes
 * calldata targeting SwapRouter02, and handles native ETH in/out via wrap/
 * unwrap inside `multicall`. The QuoterV2 calls are mocked, so tests verify
 * the selection + encoding logic without hitting a real RPC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData } from "viem";
import { uniswapSwapRouterAbi } from "../src/abis/uniswap-swap-router.js";
import { CONTRACTS } from "../src/config/contracts.js";

const { simulateContractMock } = vi.hoisted(() => ({
  simulateContractMock: vi.fn(),
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    simulateContract: simulateContractMock,
    readContract: vi.fn(),
    multicall: vi.fn(),
    getChainId: vi.fn(),
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const USDC = CONTRACTS.ethereum.tokens.USDC as `0x${string}`;
const WETH = CONTRACTS.ethereum.uniswap.weth9 as `0x${string}`;
const ARB = "0x912CE59144191C1204E64559FE8253a0e49E6548" as `0x${string}`; // placeholder long-tail
const SWAP_ROUTER = CONTRACTS.ethereum.uniswap.swapRouter02 as `0x${string}`;

beforeEach(() => {
  simulateContractMock.mockReset();
});

/**
 * Build a mock that resolves quoteExactInputSingle with the given amountOut
 * only for the matching fee tier (others throw — simulating no pool liquidity
 * at those tiers).
 */
function singleHopQuoter(feeToSupport: number, amountOut: bigint) {
  simulateContractMock.mockImplementation(async ({ functionName, args }) => {
    if (functionName === "quoteExactInputSingle") {
      const params = args[0] as { fee: number };
      if (params.fee === feeToSupport) {
        return { result: [amountOut, 0n, 0, 0n] };
      }
      throw new Error(`No pool for fee ${params.fee}`);
    }
    // quoteExactInput (multi-hop) — reject all so the caller stays on single-hop.
    throw new Error("No route");
  });
}

describe("buildUniswapV3DirectSwap — single hop", () => {
  it("picks the fee tier with the best quote", async () => {
    // All tiers succeed; 500 gives a better quote than 3000.
    simulateContractMock.mockImplementation(async ({ functionName, args }) => {
      if (functionName === "quoteExactInputSingle") {
        const { fee } = args[0] as { fee: number };
        const map: Record<number, bigint> = {
          500: 1_200_000_000_000_000_000n, // 1.20 WETH — winner
          3000: 1_000_000_000_000_000_000n,
          100: 900_000_000_000_000_000n,
          10000: 500_000_000_000_000_000n,
        };
        return { result: [map[fee] ?? 0n, 0n, 0, 0n] };
      }
      throw new Error("unused");
    });

    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: USDC,
      toToken: WETH,
      amountIn: 1_000_000_000n, // 1000 USDC
      slippageBps: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.expectedOut).toBe(1_200_000_000_000_000_000n);
    // 0.5% slippage → 1.194
    expect(result!.minOut).toBe(1_194_000_000_000_000_000n);
    expect(result!.routeDescription).toContain("0.05%");
    expect(result!.tx.to.toLowerCase()).toBe(SWAP_ROUTER.toLowerCase());
  });

  it("encodes exactInputSingle inside a multicall", async () => {
    singleHopQuoter(500, 2_000_000_000_000_000_000n);
    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: USDC,
      toToken: WETH,
      amountIn: 1_000_000_000n,
      slippageBps: 50,
    });
    expect(result).not.toBeNull();
    const decoded = decodeFunctionData({
      abi: uniswapSwapRouterAbi,
      data: result!.tx.data,
    });
    expect(decoded.functionName).toBe("multicall");
    // Inner call is the exactInputSingle.
    const inner = (decoded.args?.[0] as readonly `0x${string}`[])[0];
    const innerDecoded = decodeFunctionData({
      abi: uniswapSwapRouterAbi,
      data: inner,
    });
    expect(innerDecoded.functionName).toBe("exactInputSingle");
  });
});

describe("buildUniswapV3DirectSwap — multi-hop fallback", () => {
  it("falls back to exactInput via WETH when no single-hop route exists", async () => {
    simulateContractMock.mockImplementation(async ({ functionName }) => {
      if (functionName === "quoteExactInputSingle") {
        throw new Error("No direct pool");
      }
      if (functionName === "quoteExactInput") {
        // Return a workable multi-hop quote.
        return { result: [500_000_000_000_000_000n, [], [], 0n] };
      }
      throw new Error(`unexpected ${functionName}`);
    });

    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: USDC,
      toToken: ARB,
      amountIn: 1_000_000_000n,
      slippageBps: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.routeDescription).toContain("via WETH");
    const decoded = decodeFunctionData({
      abi: uniswapSwapRouterAbi,
      data: result!.tx.data,
    });
    expect(decoded.functionName).toBe("multicall");
    const inner = (decoded.args?.[0] as readonly `0x${string}`[])[0];
    const innerDecoded = decodeFunctionData({
      abi: uniswapSwapRouterAbi,
      data: inner,
    });
    expect(innerDecoded.functionName).toBe("exactInput");
  });
});

describe("buildUniswapV3DirectSwap — no route", () => {
  it("returns null when neither single nor multi-hop have liquidity", async () => {
    simulateContractMock.mockRejectedValue(new Error("No pool"));
    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: USDC,
      toToken: ARB,
      amountIn: 1_000_000_000n,
      slippageBps: 50,
    });
    expect(result).toBeNull();
  });

  it("returns null when fromToken and toToken are the same (wrap is not a swap)", async () => {
    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: "native",
      toToken: WETH,
      amountIn: 1_000_000_000_000_000_000n,
      slippageBps: 50,
    });
    expect(result).toBeNull();
  });
});

describe("buildUniswapV3DirectSwap — native ETH handling", () => {
  it("sets tx.value for native-in swaps (router auto-wraps)", async () => {
    singleHopQuoter(500, 1_000_000_000n);
    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: "native",
      toToken: USDC,
      amountIn: 1_000_000_000_000_000_000n, // 1 ETH
      slippageBps: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.tx.value).toBe("1000000000000000000");
  });

  it("adds unwrapWETH9 step for native-out swaps", async () => {
    singleHopQuoter(500, 1_000_000_000_000_000_000n);
    const { buildUniswapV3DirectSwap } = await import(
      "../src/modules/swap/uniswap-v3-direct.js"
    );
    const result = await buildUniswapV3DirectSwap({
      chain: "ethereum",
      from: WALLET,
      fromToken: USDC,
      toToken: "native",
      amountIn: 1_000_000_000n,
      slippageBps: 50,
    });
    expect(result).not.toBeNull();
    expect(result!.tx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: uniswapSwapRouterAbi,
      data: result!.tx.data,
    });
    expect(decoded.functionName).toBe("multicall");
    const calls = decoded.args?.[0] as readonly `0x${string}`[];
    expect(calls.length).toBe(2);
    const unwrapDecoded = decodeFunctionData({
      abi: uniswapSwapRouterAbi,
      data: calls[1],
    });
    expect(unwrapDecoded.functionName).toBe("unwrapWETH9");
  });
});
