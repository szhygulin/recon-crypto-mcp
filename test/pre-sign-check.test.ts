/**
 * Pre-sign safety check — the independent guard that runs in send_transaction
 * between consumeHandle and WalletConnect. It should accept every tx our
 * prepare_* tools legitimately emit and reject anything unknown, especially
 * approve() to a spender that isn't on our protocol allowlist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, maxUint256, zeroAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";

// Mock the RPC layer so classifyDestination's getAavePoolAddress read doesn't
// try to hit a real node. The mock returns whatever we put on readContractMock.
const { readContractMock } = vi.hoisted(() => ({ readContractMock: vi.fn() }));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: vi.fn(),
    getChainId: vi.fn(),
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

// Aave V3 Pool on Ethereum (canonical). We have classifyDestination compute
// this via readContract, so the mock just returns this every time — any tx
// whose `to` equals AAVE_POOL_ETH is treated as hitting the Pool.
const AAVE_POOL_ETH = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const WALLET = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  readContractMock.mockReset();
  readContractMock.mockResolvedValue(AAVE_POOL_ETH);
});

describe("Pre-sign check: native sends", () => {
  it("accepts a bare native transfer with empty calldata", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`, // arbitrary EOA is fine for a native send
        data: "0x",
        value: "1000000000000000000",
        from: WALLET,
        description: "native send",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a tx with sub-selector calldata", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data: "0xabcd" as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "malformed",
      })
    ).rejects.toThrow(/too short/);
  });
});

describe("Pre-sign check: approve() spender allowlist", () => {
  it("accepts approve(AavePool, amount) on a known ERC-20", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [AAVE_POOL_ETH as `0x${string}`, 1_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve USDC for Aave",
      })
    ).resolves.toBeUndefined();
  });

  it("accepts approve(LiFiDiamond, amount) on a known ERC-20", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [LIFI_DIAMOND as `0x${string}`, 1_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDT_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve USDT for LiFi swap",
      })
    ).resolves.toBeUndefined();
  });

  it("REJECTS approve(ATTACKER, max) — the classic prompt-injection attack", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "[malicious] drain approval",
      })
    ).rejects.toThrow(/spender is not in the protocol allowlist|phishing|prompt-injection/);
  });

  it("rejects approve() when the token itself is unknown", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [AAVE_POOL_ETH as `0x${string}`, 1_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`, // "token" is attacker-controlled
        data,
        value: "0",
        from: WALLET,
        description: "approve on fake token",
      })
    ).rejects.toThrow(/token is not in our recognized set/);
  });

  it("rejects approve() aimed at a protocol contract (Aave Pool)", async () => {
    // Nonsensical: approve() on a non-ERC-20. A real ERC-20 approval would
    // hit the token, not the Pool; an agent pointing `to` at the Pool is off-rails.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, 1_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "weird approve",
      })
    ).rejects.toThrow(/approvals should target ERC-20/);
  });
});

describe("Pre-sign check: transfer()", () => {
  it("accepts transfer() to an arbitrary recipient on a known ERC-20", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "transfer USDC",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects transfer() on a token we don't recognize", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "transfer unknown token",
      })
    ).rejects.toThrow(/token is not in our recognized set/);
  });
});

describe("Pre-sign check: protocol calls", () => {
  it("accepts Aave V3 Pool supply() (selector 0x617ba037)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    // Manually build a supply(address,uint256,address,uint16) calldata — we
    // trust the selector portion since the full abi is in assertTransactionSafe.
    const data =
      "0x617ba037" +
      USDC_ETH.slice(2).toLowerCase().padStart(64, "0") +
      (1_000_000n).toString(16).padStart(64, "0") +
      WALLET.slice(2).toLowerCase().padStart(64, "0") +
      (0).toString(16).padStart(64, "0");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "Aave supply",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a random selector aimed at the Aave Pool", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = "0xdeadbeef" + "00".repeat(32);
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "bogus call on Aave",
      })
    ).rejects.toThrow(/not a known function on aave-v3-pool/);
  });

  it("accepts a call to LiFi Diamond regardless of selector (no ABI gate)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: "0xdeadbeef" as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "LiFi swap",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a call to an unrelated contract with non-empty data", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`,
        data: "0xabcdef01" as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "unknown call",
      })
    ).rejects.toThrow(/refusing to sign against unknown contract/);
  });
});
