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
const WETH_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
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

  it("accepts approve(Uniswap SwapRouter02, amount) — prepare_uniswap_swap's approve step", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER_02 as `0x${string}`, 100_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve USDC for Uniswap SwapRouter02",
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

  it("ACCEPTS approve(non-allowlisted-spender, 0) — the revoke pattern (issue #305)", async () => {
    // prepare_revoke_approval emits approve(spender, 0) targeting whatever
    // spender the user wants to revoke — Permit2, dead routers, deprecated
    // contracts. Those spenders are NOT on the protocol allowlist (the user
    // is revoking precisely because they want them off), so the allowlist
    // check would block the cleanup. amount=0 cannot grant any authority,
    // so the canonical phishing pattern doesn't apply — short-circuit.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2 as `0x${string}`, 0n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Revoke USDC allowance for Permit2",
      })
    ).resolves.toBeUndefined();
  });

  it("ACCEPTS approve(arbitrary-attacker-address, 0) — even maximally suspicious revokes are safe", async () => {
    // Defensive: revoke to a literally-attacker-controlled address still
    // grants no authority (amount=0). The allowlist is for grants of
    // authority; revokes are the inverse operation and have no analogous
    // attack surface.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, 0n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Revoke USDC allowance for ATTACKER (cleanup)",
      })
    ).resolves.toBeUndefined();
  });

  it("STILL REJECTS approve(non-allowlisted-spender, 1) — only the exact-zero amount short-circuits", async () => {
    // Belt-and-suspenders: confirm the carve-out is keyed on amount === 0n
    // exactly, not on "amount that looks small". A 1-wei approval to an
    // attacker still grants authority over 1 wei (and the attack surface
    // typically isn't the size of the grant — it's that the grant exists
    // at all, since wormholes / delegatecall paths can amplify it).
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, 1n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "[malicious] dust approval",
      })
    ).rejects.toThrow(/spender is not in the protocol allowlist|phishing|prompt-injection/);
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

  it("accepts a multicall() to Uniswap SwapRouter02 — prepare_uniswap_swap's swap step", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const { swapRouter02Abi } = await import("../src/abis/uniswap-swap-router-02.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    // multicall is one of the SwapRouter02 functions; the selector must pass
    // the per-ABI gate.
    const data = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [["0xdeadbeef" as `0x${string}`]],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SWAP_ROUTER_02 as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Uniswap V3 swap",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a random selector aimed at Uniswap SwapRouter02", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const data = "0xdeadbeef" + "00".repeat(32);
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SWAP_ROUTER_02 as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "bogus call on SwapRouter02",
      })
    ).rejects.toThrow(/not a known function on uniswap-v3-swap-router/);
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

describe("Pre-sign check: WETH9-specific selectors", () => {
  it("accepts WETH.withdraw(uint256) — the prepare_weth_unwrap path", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const { wethAbi } = await import("../src/abis/weth.js");
    const data = encodeFunctionData({
      abi: wethAbi,
      functionName: "withdraw",
      args: [500_000_100_000_000_000n], // 0.5000001 WETH
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Unwrap WETH",
      })
    ).resolves.toBeUndefined();
  });

  it("accepts WETH.deposit()", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const { wethAbi } = await import("../src/abis/weth.js");
    const data = encodeFunctionData({ abi: wethAbi, functionName: "deposit", args: [] });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "1000000000000000000",
        from: WALLET,
        description: "Wrap ETH",
      })
    ).resolves.toBeUndefined();
  });

  it("still accepts approve(WETH, SwapRouter02) — ERC-20 approvals on WETH must keep working", async () => {
    // Uniswap V3 swaps with WETH as the input token need this approval; a naive
    // fix that made WETH reject ERC-20 selectors would break prepare_uniswap_swap.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER_02 as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve WETH for Uniswap",
      })
    ).resolves.toBeUndefined();
  });

  it("still accepts transfer(WETH, recipient)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "transfer WETH",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a random selector aimed at WETH9", async () => {
    // The per-selector gate is the reason we don't just classify WETH as
    // some catch-all kind. An arbitrary selector on WETH must still refuse.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = "0xdeadbeef" + "00".repeat(32);
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "bogus call on WETH",
      })
    ).rejects.toThrow(/not a known function on weth9/);
  });
});
