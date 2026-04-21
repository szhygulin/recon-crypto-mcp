/**
 * Tests for prepare_uniswap_swap — the direct-DEX Uniswap V3 tool that bypasses
 * LiFi when the user explicitly names Uniswap as the venue.
 *
 * What we're actually checking:
 *  1. Schema — native/ERC-20 inputs parse; slippage caps enforced.
 *  2. Best-tier selection — QuoterV2 is queried across 100/500/3000/10000 and
 *     the highest-output tier wins for exact-in (lowest-input for exact-out).
 *     A tier that reverts (no pool) must not disqualify the swap if another
 *     tier has liquidity.
 *  3. Calldata shape — the right router function is called (exactInputSingle /
 *     exactOutputSingle / multicall) and pinned fields (recipient, fee,
 *     amountOutMinimum / amountInMaximum, msg.value) are correct for each
 *     native/ERC-20 combination.
 *  4. Approval chain — ERC-20 input with 0 allowance emits approve → swap;
 *     with nonzero allowance emits reset → approve → swap (USDT-style).
 *     Native input emits no approval.
 *  5. Refusals — native↔native; unsupported chains; no pool across any tier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, getAddress, parseUnits } from "viem";
import { swapRouter02Abi } from "../src/abis/uniswap-swap-router-02.js";
import { erc20Abi } from "../src/abis/erc20.js";

const { readContractMock, simulateContractMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
  simulateContractMock: vi.fn(),
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    simulateContract: simulateContractMock,
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const USDC_ETH = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const WETH_ETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
// SwapRouter02 on Ethereum (from src/config/contracts.ts).
const SWAP_ROUTER_02 = getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45");

beforeEach(() => {
  readContractMock.mockReset();
  simulateContractMock.mockReset();
});

/**
 * Default decimals-read for both tokens, plus a permissive symbol-read so the
 * description helper doesn't throw. Individual tests override `readContract`
 * for the allowance branch they care about.
 */
function stubTokenMetadata() {
  readContractMock.mockImplementation((req: {
    address: `0x${string}`;
    functionName: string;
  }) => {
    if (req.functionName === "decimals") {
      return Promise.resolve(req.address.toLowerCase() === USDC_ETH.toLowerCase() ? 6 : 18);
    }
    if (req.functionName === "symbol") {
      return Promise.resolve(req.address.toLowerCase() === USDC_ETH.toLowerCase() ? "USDC" : "WETH");
    }
    if (req.functionName === "allowance") {
      return Promise.resolve(0n);
    }
    throw new Error(`unexpected readContract: ${req.functionName}`);
  });
}

describe("prepare_uniswap_swap — schema", () => {
  it("rejects slippageBps > 100 without acknowledgeHighSlippage", async () => {
    stubTokenMetadata();
    simulateContractMock.mockResolvedValue({ result: [1_000_000n, 0n, 0, 0n] });
    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    await expect(
      prepareUniswapSwap({
        wallet: WALLET,
        chain: "ethereum",
        fromToken: WETH_ETH,
        toToken: USDC_ETH,
        amount: "1",
        slippageBps: 200,
      }),
    ).rejects.toThrow(/sandwich/);
  });
});

describe("prepare_uniswap_swap — fee-tier auto-selection", () => {
  it("picks the tier with the highest amountOut (exact-in) and skips reverting tiers", async () => {
    stubTokenMetadata();
    // QuoterV2 returns decide the winner. Make tier 500 the best and tier 100 revert.
    simulateContractMock.mockImplementation((req: {
      args: [{ fee: number }];
      functionName: string;
    }) => {
      const fee = req.args[0].fee;
      if (fee === 100) throw new Error("no pool");
      // amountOut for 1 WETH → USDC at different tiers (6 decimals).
      const quote =
        fee === 500 ? 3_500_000_000n : fee === 3000 ? 3_490_000_000n : 3_200_000_000n;
      return Promise.resolve({ result: [quote, 0n, 0, 0n] });
    });

    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    const tx = await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
      slippageBps: 50,
    });

    // Native-in + ERC-20-out + exact-in → single exactInputSingle, msg.value = 1 ether.
    expect(tx.to).toBe(SWAP_ROUTER_02);
    expect(tx.value).toBe(parseUnits("1", 18).toString());

    const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: tx.data });
    expect(decoded.functionName).toBe("exactInputSingle");
    const params = (decoded.args as [Record<string, unknown>])[0];
    expect(params.fee).toBe(500);
    expect(params.tokenIn).toBe(WETH_ETH);
    expect(params.tokenOut).toBe(USDC_ETH);
    expect(params.recipient).toBe(WALLET);
    // amountOutMinimum = 3_500_000_000 * (10000-50)/10000 = 3_482_500_000
    expect(params.amountOutMinimum).toBe(3_482_500_000n);
  });

  it("respects a user-supplied feeTier override (skips auto-selection)", async () => {
    stubTokenMetadata();
    simulateContractMock.mockResolvedValue({ result: [3_000_000_000n, 0n, 0, 0n] });
    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
      feeTier: 3000,
    });
    // Only one quote call — the user pinned the tier.
    expect(simulateContractMock).toHaveBeenCalledTimes(1);
    expect(simulateContractMock.mock.calls[0]?.[0]?.args[0].fee).toBe(3000);
  });

  it("refuses when all tiers revert (no pool / no liquidity)", async () => {
    stubTokenMetadata();
    simulateContractMock.mockRejectedValue(new Error("no pool"));
    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    await expect(
      prepareUniswapSwap({
        wallet: WALLET,
        chain: "ethereum",
        fromToken: "native",
        toToken: USDC_ETH,
        amount: "1",
      }),
    ).rejects.toThrow(/No Uniswap V3 pool/);
  });
});

describe("prepare_uniswap_swap — calldata shape", () => {
  it("exact-out with ERC-20 in + native out uses multicall([exactOutputSingle, unwrapWETH9])", async () => {
    stubTokenMetadata();
    // QuoterV2 for exactOutputSingle returns amountIn required.
    simulateContractMock.mockResolvedValue({ result: [3_000_000_000n, 0n, 0, 0n] });

    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    const tx = await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: USDC_ETH,
      toToken: "native",
      amount: "1", // want exactly 1 ETH out
      amountSide: "to",
      slippageBps: 50,
    });

    // ERC-20 input with 0 allowance → first tx is the approve.
    expect(tx.next).toBeDefined();
    const swap = tx.next!;
    expect(swap.to).toBe(SWAP_ROUTER_02);
    expect(swap.value).toBe("0");

    const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: swap.data });
    expect(decoded.functionName).toBe("multicall");
    const inner = (decoded.args as [readonly `0x${string}`[]])[0];
    expect(inner.length).toBe(2);

    const swapInner = decodeFunctionData({ abi: swapRouter02Abi, data: inner[0]! });
    expect(swapInner.functionName).toBe("exactOutputSingle");
    const params = (swapInner.args as [Record<string, unknown>])[0];
    // Recipient is the router itself (so unwrap can forward native ETH).
    expect(params.recipient).toBe(SWAP_ROUTER_02);
    expect(params.amountOut).toBe(parseUnits("1", 18));
    // amountInMaximum = 3_000_000_000 * (10000+50)/10000 rounded up = 3_015_000_000
    expect(params.amountInMaximum).toBe(3_015_000_000n);

    const unwrapInner = decodeFunctionData({ abi: swapRouter02Abi, data: inner[1]! });
    expect(unwrapInner.functionName).toBe("unwrapWETH9");
    const unwrapArgs = unwrapInner.args as [bigint, `0x${string}`];
    // amountMinimum on unwrap = the target amountOut (we insist on the full target).
    expect(unwrapArgs[0]).toBe(parseUnits("1", 18));
    expect(unwrapArgs[1]).toBe(WALLET);
  });

  it("exact-out with native in + ERC-20 out uses multicall([exactOutputSingle, refundETH]) and sets msg.value", async () => {
    stubTokenMetadata();
    // Quoter returns 1 WETH required for 3000 USDC out.
    simulateContractMock.mockResolvedValue({ result: [parseUnits("1", 18), 0n, 0, 0n] });

    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    const tx = await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "3000", // exact-out 3000 USDC
      amountSide: "to",
      slippageBps: 50,
    });

    expect(tx.to).toBe(SWAP_ROUTER_02);
    // msg.value = amountInMaximum = 1 ETH * 1.005 rounded up.
    const expectedMax = (parseUnits("1", 18) * 10_050n + 9_999n) / 10_000n;
    expect(tx.value).toBe(expectedMax.toString());

    const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: tx.data });
    expect(decoded.functionName).toBe("multicall");
    const inner = (decoded.args as [readonly `0x${string}`[]])[0];
    expect(inner.length).toBe(2);

    const refundInner = decodeFunctionData({ abi: swapRouter02Abi, data: inner[1]! });
    expect(refundInner.functionName).toBe("refundETH");
  });
});

describe("prepare_uniswap_swap — approval chain", () => {
  it("ERC-20 input with zero allowance → approve then swap", async () => {
    readContractMock.mockImplementation((req: { functionName: string; address: `0x${string}` }) => {
      if (req.functionName === "decimals")
        return Promise.resolve(req.address.toLowerCase() === USDC_ETH.toLowerCase() ? 6 : 18);
      if (req.functionName === "symbol")
        return Promise.resolve(req.address.toLowerCase() === USDC_ETH.toLowerCase() ? "USDC" : "WETH");
      if (req.functionName === "allowance") return Promise.resolve(0n);
      throw new Error(`unexpected: ${req.functionName}`);
    });
    simulateContractMock.mockResolvedValue({ result: [parseUnits("0.5", 18), 0n, 0, 0n] });

    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    const tx = await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: USDC_ETH,
      toToken: WETH_ETH,
      amount: "1000",
    });

    // First tx: approve. Second tx: swap.
    const firstDecoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(firstDecoded.functionName).toBe("approve");
    const approveArgs = firstDecoded.args as [`0x${string}`, bigint];
    expect(approveArgs[0]).toBe(SWAP_ROUTER_02);
    expect(approveArgs[1]).toBe(parseUnits("1000", 6));

    expect(tx.next).toBeDefined();
    expect(tx.next?.next).toBeUndefined(); // No reset, allowance was already 0.
  });

  it("ERC-20 input with nonzero allowance → reset then approve then swap (USDT-style)", async () => {
    readContractMock.mockImplementation((req: { functionName: string; address: `0x${string}` }) => {
      if (req.functionName === "decimals")
        return Promise.resolve(req.address.toLowerCase() === USDC_ETH.toLowerCase() ? 6 : 18);
      if (req.functionName === "symbol")
        return Promise.resolve(req.address.toLowerCase() === USDC_ETH.toLowerCase() ? "USDC" : "WETH");
      if (req.functionName === "allowance") return Promise.resolve(parseUnits("50", 6)); // not enough
      throw new Error(`unexpected: ${req.functionName}`);
    });
    simulateContractMock.mockResolvedValue({ result: [parseUnits("0.5", 18), 0n, 0, 0n] });

    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    const tx = await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: USDC_ETH,
      toToken: WETH_ETH,
      amount: "1000",
    });

    // reset → approve → swap
    const reset = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(reset.functionName).toBe("approve");
    expect((reset.args as [`0x${string}`, bigint])[1]).toBe(0n);

    const approve = decodeFunctionData({ abi: erc20Abi, data: tx.next!.data });
    expect(approve.functionName).toBe("approve");
    expect((approve.args as [`0x${string}`, bigint])[1]).toBe(parseUnits("1000", 6));

    expect(tx.next?.next).toBeDefined(); // the swap itself
    expect(tx.next?.next?.to).toBe(SWAP_ROUTER_02);
  });

  it("native input emits NO approval chain", async () => {
    stubTokenMetadata();
    simulateContractMock.mockResolvedValue({ result: [3_500_000_000n, 0n, 0, 0n] });

    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    const tx = await prepareUniswapSwap({
      wallet: WALLET,
      chain: "ethereum",
      fromToken: "native",
      toToken: USDC_ETH,
      amount: "1",
    });

    expect(tx.to).toBe(SWAP_ROUTER_02);
    expect(tx.next).toBeUndefined();
    // allowance should never have been read for a native-input swap.
    const allowanceCalls = readContractMock.mock.calls.filter(
      (c) => (c[0] as { functionName: string }).functionName === "allowance",
    );
    expect(allowanceCalls).toHaveLength(0);
  });
});

describe("prepare_uniswap_swap — refusals", () => {
  it("native-to-native is rejected (not a swap)", async () => {
    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    await expect(
      prepareUniswapSwap({
        wallet: WALLET,
        chain: "ethereum",
        fromToken: "native",
        toToken: "native",
        amount: "1",
      }),
    ).rejects.toThrow(/Native-to-native/);
  });

  it("same-token swap is rejected (ERC-20 → WETH when input is already WETH)", async () => {
    const { prepareUniswapSwap } = await import("../src/modules/uniswap-swap/index.js");
    await expect(
      prepareUniswapSwap({
        wallet: WALLET,
        chain: "ethereum",
        fromToken: WETH_ETH,
        toToken: WETH_ETH,
        amount: "1",
        fromTokenDecimals: 18,
        toTokenDecimals: 18,
      }),
    ).rejects.toThrow(/same asset/);
  });
});
