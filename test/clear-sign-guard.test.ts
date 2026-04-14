/**
 * Clear-signing classifier — decides whether a prepared EVM tx will be
 * decoded on-device by the Ledger (clear-signable) or shown as raw calldata
 * (blind-sign / blind-sign-unavoidable). Also the payload-fingerprint and
 * decoder-URL helpers that back the user-facing verification flow.
 */
import { describe, it, expect, vi } from "vitest";
import { encodeFunctionData, zeroAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { aavePoolAbi } from "../src/abis/aave-pool.js";
import { cometAbi } from "../src/abis/compound-comet.js";
import { uniswapSwapRouterAbi } from "../src/abis/uniswap-swap-router.js";
import { CONTRACTS } from "../src/config/contracts.js";
import type { UnsignedTx } from "../src/types/index.js";

// Pre-sign-check imports CONTRACTS and doesn't hit RPC in the classifier path,
// so we don't need to mock rpc.js here — classifyEvmTrust is pure.

const WALLET = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const USDC_ETH = CONTRACTS.ethereum.tokens.USDC as `0x${string}`;
const AAVE_POOL_ETH = CONTRACTS.ethereum.aave.pool as `0x${string}`;
const COMPOUND_USDC_ETH = CONTRACTS.ethereum.compound.cUSDCv3 as `0x${string}`;
const SWAP_ROUTER_ETH = CONTRACTS.ethereum.uniswap.swapRouter02 as `0x${string}`;
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as `0x${string}`;
const UNKNOWN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;

function baseTx(overrides: Partial<UnsignedTx>): UnsignedTx {
  return {
    chain: "ethereum",
    to: UNKNOWN,
    data: "0x",
    value: "0",
    from: WALLET,
    description: "test",
    ...overrides,
  };
}

describe("classifyEvmTrust — clear-signable", () => {
  it("native value transfer with empty data is clear-sign", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const tx = baseTx({ to: UNKNOWN, value: "1000000000000000000", data: "0x" });
    const { mode, details } = classifyEvmTrust(tx);
    expect(mode).toBe("clear-signable");
    expect(details.ledgerPlugin).toBe("Ethereum");
    expect(details.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(details.payloadHashShort).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("ERC-20 transfer() on a known token is clear-sign", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [UNKNOWN, 1_000_000n],
    });
    const { mode, details } = classifyEvmTrust(baseTx({ to: USDC_ETH, data }));
    expect(mode).toBe("clear-signable");
    expect(details.ledgerPlugin).toContain("ERC-20");
  });

  it("ERC-20 approve() on a known token is clear-sign", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER_ETH, 1_000_000n],
    });
    const { mode } = classifyEvmTrust(baseTx({ to: USDC_ETH, data }));
    expect(mode).toBe("clear-signable");
  });

  it("Aave V3 supply() is clear-sign", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [USDC_ETH, 1_000_000n, WALLET, 0],
    });
    const { mode, details } = classifyEvmTrust(baseTx({ to: AAVE_POOL_ETH, data }));
    expect(mode).toBe("clear-signable");
    expect(details.ledgerPlugin).toContain("Aave");
  });

  it("Compound V3 supply() is clear-sign", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: cometAbi,
      functionName: "supply",
      args: [USDC_ETH, 1_000_000n],
    });
    const { mode } = classifyEvmTrust(baseTx({ to: COMPOUND_USDC_ETH, data }));
    expect(mode).toBe("clear-signable");
  });

  it("Uniswap V3 SwapRouter multicall is clear-sign", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const innerData = encodeFunctionData({
      abi: uniswapSwapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: USDC_ETH,
          tokenOut: CONTRACTS.ethereum.tokens.WETH as `0x${string}`,
          fee: 500,
          recipient: WALLET,
          amountIn: 1_000_000n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const data = encodeFunctionData({
      abi: uniswapSwapRouterAbi,
      functionName: "multicall",
      args: [[innerData]],
    });
    const { mode, details } = classifyEvmTrust(baseTx({ to: SWAP_ROUTER_ETH, data }));
    expect(mode).toBe("clear-signable");
    expect(details.ledgerPlugin).toContain("Uniswap");
  });
});

describe("classifyEvmTrust — blind-sign", () => {
  it("LiFi Diamond calls are blind-sign with decoder URL", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    // Arbitrary selector on the Diamond — LiFi's ABI is huge, we gate it.
    const data = "0xdeadbeef00000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    const { mode, details } = classifyEvmTrust(baseTx({ to: LIFI_DIAMOND, data }));
    expect(mode).toBe("blind-sign");
    expect(details.decoderUrl).toContain("calldata.swiss-knife.xyz");
    expect(details.decoderUrl).toContain("chainId=1");
  });
});

describe("classifyEvmTrust — blind-sign-unavoidable", () => {
  it("unrecognized destination is blind-sign-unavoidable", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const data = "0x12345678" as `0x${string}`;
    const { mode, details } = classifyEvmTrust(baseTx({ to: UNKNOWN, data }));
    expect(mode).toBe("blind-sign-unavoidable");
    expect(details.reason).toMatch(/Unrecognized|strongly|reject/i);
  });
});

describe("payloadFingerprint", () => {
  it("is deterministic for the same tx", async () => {
    const { payloadFingerprint } = await import("../src/signing/pre-sign-check.js");
    const tx = { chain: "ethereum" as const, to: USDC_ETH, value: "0", data: "0x12345678" as `0x${string}` };
    expect(payloadFingerprint(tx)).toBe(payloadFingerprint(tx));
  });

  it("differs across chains even with identical calldata (chainId in preimage)", async () => {
    const { payloadFingerprint } = await import("../src/signing/pre-sign-check.js");
    const onEth = payloadFingerprint({
      chain: "ethereum",
      to: USDC_ETH,
      value: "0",
      data: "0x12345678" as `0x${string}`,
    });
    const onArb = payloadFingerprint({
      chain: "arbitrum",
      to: USDC_ETH,
      value: "0",
      data: "0x12345678" as `0x${string}`,
    });
    expect(onEth).not.toBe(onArb);
  });

  it("differs when value differs", async () => {
    const { payloadFingerprint } = await import("../src/signing/pre-sign-check.js");
    const a = payloadFingerprint({ chain: "ethereum", to: USDC_ETH, value: "0", data: "0x" });
    const b = payloadFingerprint({ chain: "ethereum", to: USDC_ETH, value: "1", data: "0x" });
    expect(a).not.toBe(b);
  });
});

describe("swiss-knife decoder URL", () => {
  it("produces a URL for short calldata", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    const { details } = classifyEvmTrust(
      baseTx({ to: LIFI_DIAMOND, data: "0xabcdef0100000000" as `0x${string}` })
    );
    expect(details.decoderUrl).toMatch(/^https:\/\/calldata\.swiss-knife\.xyz\/decoder\?/);
    expect(details.decoderUrl).toContain("calldata=0xabcdef0100000000");
    expect(details.decoderUrl).toContain(`address=${LIFI_DIAMOND}`);
    expect(details.decoderPasteInstructions).toBeUndefined();
  });

  it("falls back to paste instructions for oversized calldata", async () => {
    const { classifyEvmTrust } = await import("../src/signing/pre-sign-check.js");
    // ~4.5 KB of hex payload — comfortably over the 8000-char URL budget.
    const big = ("0x" + "ab".repeat(4500)) as `0x${string}`;
    const { details } = classifyEvmTrust(baseTx({ to: LIFI_DIAMOND, data: big }));
    expect(details.decoderUrl).toBeUndefined();
    expect(details.decoderPasteInstructions).toContain("calldata.swiss-knife.xyz");
    expect(details.decoderPasteInstructions).toContain(big);
  });
});

describe("TRON fingerprint", () => {
  it("tron variant is domain-separated from EVM", async () => {
    const { tronPayloadFingerprint, payloadFingerprint } = await import(
      "../src/signing/pre-sign-check.js"
    );
    const hex = "0xabcdef";
    const tronFp = tronPayloadFingerprint(hex);
    // An EVM tx with the same bytes as `data` won't collide — the EVM tag differs.
    const evmFp = payloadFingerprint({
      chain: "ethereum",
      to: zeroAddress,
      value: "0",
      data: hex as `0x${string}`,
    });
    expect(tronFp).not.toBe(evmFp);
  });

  it("is deterministic regardless of 0x prefix", async () => {
    const { tronPayloadFingerprint } = await import("../src/signing/pre-sign-check.js");
    expect(tronPayloadFingerprint("abcd1234")).toBe(tronPayloadFingerprint("0xabcd1234"));
  });
});
