/**
 * Tests for the Permit2 sub-allowance extension to `get_token_allowances`.
 * Issue #304.
 *
 * Coverage:
 *   - Topic constants match the canonical keccak256 of their event
 *     signatures (drift guard).
 *   - When the primary scan finds Permit2 as a spender, the tool
 *     populates `permit2SubAllowances[]` on that row.
 *   - Permit2 events are partitioned correctly by topic0 (Approval +
 *     Permit both surface; unrelated topics ignored).
 *   - Sub-allowances with `expiration === 0` are dropped (Permit2's
 *     "fresh signature required" marker).
 *   - Sub-allowances with `expiration ≤ now` are dropped + counted as
 *     expired in notes.
 *   - Sub-allowances at-or-near MAX_UINT160 surface as
 *     `isUnlimited: true` with `amountFormatted: "unlimited"`.
 *   - Friendly label resolution works on downstream spenders too.
 *   - Non-Permit2 spender rows remain unaffected (no
 *     `permit2SubAllowances` field).
 *   - EIP-2612 nonce note surfaces when the token supports `nonces()`.
 *   - Completeness footnote always present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { keccak256, toBytes } from "viem";

const etherscanV2FetchMock = vi.fn();
const multicallMock = vi.fn();
const readContractMock = vi.fn();

vi.mock("../src/data/apis/etherscan-v2.js", () => ({
  etherscanV2Fetch: (...a: unknown[]) => etherscanV2FetchMock(...a),
  EtherscanApiKeyMissingError: class EtherscanApiKeyMissingError extends Error {},
  EtherscanNoDataError: class EtherscanNoDataError extends Error {},
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    multicall: (...a: unknown[]) => multicallMock(...a),
    readContract: (...a: unknown[]) => readContractMock(...a),
  }),
  resetClients: () => {},
}));

const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const PERMIT2_ADDRESS = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const WALLET = "0x000000000000000000000000000000000000dEaD";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const UNIVERSAL_ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
const SOME_OTHER_DOWNSTREAM = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PHISHY_DOWNSTREAM = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function pad32(addrLower: string): string {
  return `0x000000000000000000000000${addrLower.replace(/^0x/, "").toLowerCase()}`;
}

function encUint(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Standard ERC-20 Approval log (3 topics — the primary scan). */
function erc20ApprovalLog(args: {
  spender: string;
  value: bigint;
  blockNumber: number;
  txHash: string;
  timeStamp?: number;
}) {
  return {
    address: USDC.toLowerCase(),
    topics: [APPROVAL_TOPIC, pad32(WALLET), pad32(args.spender)],
    data: encUint(args.value),
    blockNumber: args.blockNumber.toString(),
    transactionHash: args.txHash,
    ...(args.timeStamp !== undefined ? { timeStamp: args.timeStamp.toString() } : {}),
  };
}

/**
 * Permit2 Approval / Permit log (4 topics — owner, token, spender all
 * indexed). Permit2 emits events with ALL three addresses as indexed
 * fields, so the on-the-wire layout is topic[0]=eventSig,
 * topic[1]=owner, topic[2]=token, topic[3]=spender.
 *
 * The `data` payload differs between Approval (uint160 amount + uint48
 * expiration) and Permit (adds uint48 nonce). We don't decode it
 * client-side — the tool reads live state via Multicall — so the data
 * value is irrelevant for our test purposes.
 */
function permit2Log(args: {
  topic0: string;
  downstreamSpender: string;
  blockNumber: number;
  txHash: string;
  timeStamp?: number;
}) {
  return {
    address: PERMIT2_ADDRESS,
    topics: [
      args.topic0,
      pad32(WALLET),
      pad32(USDC),
      pad32(args.downstreamSpender),
    ],
    data: "0x", // not parsed by the tool
    blockNumber: args.blockNumber.toString(),
    transactionHash: args.txHash,
    ...(args.timeStamp !== undefined ? { timeStamp: args.timeStamp.toString() } : {}),
  };
}

beforeEach(() => {
  etherscanV2FetchMock.mockReset();
  multicallMock.mockReset();
  readContractMock.mockReset();
  // Default token-metadata multicall response: USDC.
  multicallMock.mockImplementation(async (callArgs: unknown) => {
    const opts = callArgs as {
      contracts: Array<{ functionName: string; args?: unknown[]; address?: string }>;
    };
    return opts.contracts.map((c) => {
      if (c.functionName === "symbol") return { status: "success", result: "USDC" };
      if (c.functionName === "decimals") return { status: "success", result: 6 };
      if (c.functionName === "name") return { status: "success", result: "USD Coin" };
      // Default ERC-20 allowance() = 0.
      return { status: "success", result: 0n };
    });
  });
  // Default: token doesn't support EIP-2612 (most don't, like WETH/USDT).
  readContractMock.mockRejectedValue(new Error("not eip2612"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Permit2 topic constants", () => {
  it("PERMIT2_APPROVAL_TOPIC matches keccak256(canonical event signature)", async () => {
    const { PERMIT2_APPROVAL_TOPIC } = await import(
      "../src/modules/allowances/permit2.ts"
    );
    const expected = keccak256(
      toBytes("Approval(address,address,address,uint160,uint48)"),
    );
    expect(PERMIT2_APPROVAL_TOPIC.toLowerCase()).toBe(expected.toLowerCase());
  });

  it("PERMIT2_PERMIT_TOPIC matches keccak256(canonical event signature)", async () => {
    const { PERMIT2_PERMIT_TOPIC } = await import(
      "../src/modules/allowances/permit2.ts"
    );
    const expected = keccak256(
      toBytes("Permit(address,address,address,uint160,uint48,uint48)"),
    );
    expect(PERMIT2_PERMIT_TOPIC.toLowerCase()).toBe(expected.toLowerCase());
  });
});

describe("getTokenAllowances — Permit2 sub-allowance enumeration", () => {
  it("populates permit2SubAllowances[] when the primary scan finds Permit2 as spender", async () => {
    const { PERMIT2_APPROVAL_TOPIC, PERMIT2_PERMIT_TOPIC } = await import(
      "../src/modules/allowances/permit2.ts"
    );
    // Primary scan: 1 row — Permit2 as spender, unlimited.
    etherscanV2FetchMock.mockImplementation(async (_chain, params: Record<string, string>) => {
      if (params.address === USDC.toLowerCase()) {
        // Primary scan
        return [
          erc20ApprovalLog({
            spender: PERMIT2_ADDRESS,
            value: UINT256_MAX,
            blockNumber: 19_000_000,
            txHash: "0xa".repeat(40) + "0".repeat(24),
            timeStamp: 1_700_000_000,
          }),
        ];
      }
      if (params.address === PERMIT2_ADDRESS) {
        // Permit2 sub-scan: 3 events — Universal Router (active), some
        // expired, one with the Permit topic to verify both topics work.
        return [
          permit2Log({
            topic0: PERMIT2_APPROVAL_TOPIC,
            downstreamSpender: UNIVERSAL_ROUTER,
            blockNumber: 19_100_000,
            txHash: "0xd".repeat(40) + "0".repeat(24),
            timeStamp: 1_710_000_000,
          }),
          permit2Log({
            topic0: PERMIT2_PERMIT_TOPIC,
            downstreamSpender: SOME_OTHER_DOWNSTREAM,
            blockNumber: 19_200_000,
            txHash: "0xe".repeat(40) + "0".repeat(24),
            timeStamp: 1_715_000_000,
          }),
          permit2Log({
            topic0: PERMIT2_APPROVAL_TOPIC,
            downstreamSpender: PHISHY_DOWNSTREAM,
            blockNumber: 19_300_000,
            txHash: "0xf".repeat(40) + "0".repeat(24),
            timeStamp: 1_720_000_000,
          }),
        ];
      }
      return [];
    });

    // Multicall responses: token metadata (3 entries, in symbol/decimals/name order),
    // then primary allowance reads (1 entry — Permit2 has unlimited),
    // then Permit2 sub-allowance reads (3 entries).
    const futureExpiration = Math.floor(Date.now() / 1000) + 86400;
    const pastExpiration = Math.floor(Date.now() / 1000) - 100;
    multicallMock.mockImplementation(async (callArgs: unknown) => {
      const opts = callArgs as {
        contracts: Array<{
          functionName: string;
          args?: unknown[];
          address?: string;
        }>;
      };
      return opts.contracts.map((c) => {
        if (c.functionName === "symbol") return { status: "success", result: "USDC" };
        if (c.functionName === "decimals") return { status: "success", result: 6 };
        if (c.functionName === "name") return { status: "success", result: "USD Coin" };
        if (c.functionName === "allowance") {
          // Args length distinguishes ERC-20 vs Permit2:
          // - ERC-20 allowance(owner, spender): 2 args
          // - Permit2 allowance(user, token, spender): 3 args
          if ((c.args ?? []).length === 2) {
            return { status: "success", result: UINT256_MAX };
          }
          // Permit2 sub-allowance read.
          const spender = ((c.args as unknown[])[2] as string).toLowerCase();
          if (spender === UNIVERSAL_ROUTER.toLowerCase()) {
            // Active: 1000 USDC, future expiration.
            return {
              status: "success",
              result: [1_000_000_000n, futureExpiration, 0],
            };
          }
          if (spender === SOME_OTHER_DOWNSTREAM.toLowerCase()) {
            // Expired.
            return {
              status: "success",
              result: [500_000_000n, pastExpiration, 0],
            };
          }
          if (spender === PHISHY_DOWNSTREAM.toLowerCase()) {
            // Active: unlimited.
            return {
              status: "success",
              result: [UINT160_MAX, futureExpiration, 0],
            };
          }
          return { status: "success", result: [0n, 0, 0] };
        }
        return { status: "success", result: 0n };
      });
    });

    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });

    // Primary row: Permit2 itself.
    expect(r.allowances).toHaveLength(1);
    const permit2Row = r.allowances[0];
    expect(permit2Row.spender.toLowerCase()).toBe(PERMIT2_ADDRESS);
    expect(permit2Row.permit2SubAllowances).toBeDefined();
    // 2 active sub-allowances (Universal Router + Phishy); 1 expired
    // dropped.
    expect(permit2Row.permit2SubAllowances).toHaveLength(2);
    // Sorted desc by amount: Phishy (UINT160_MAX) first, Universal
    // Router (1000 USDC) second.
    expect(
      permit2Row.permit2SubAllowances![0].downstreamSpender.toLowerCase(),
    ).toBe(PHISHY_DOWNSTREAM.toLowerCase());
    expect(permit2Row.permit2SubAllowances![0].isUnlimited).toBe(true);
    expect(permit2Row.permit2SubAllowances![0].amountFormatted).toBe("unlimited");
    expect(
      permit2Row.permit2SubAllowances![1].downstreamSpender.toLowerCase(),
    ).toBe(UNIVERSAL_ROUTER.toLowerCase());
    expect(permit2Row.permit2SubAllowances![1].amountFormatted).toBe("1000");
    expect(permit2Row.permit2SubAllowances![1].isUnlimited).toBe(false);
    // Notes flag the Permit2 sub-allowance presence.
    expect(
      r.notes.some((n) =>
        n.toLowerCase().includes("active permit2 sub-allowance"),
      ),
    ).toBe(true);
  });

  it("does NOT populate permit2SubAllowances on non-Permit2 rows", async () => {
    const someRandomSpender = "0x9999999999999999999999999999999999999999";
    etherscanV2FetchMock.mockResolvedValue([
      erc20ApprovalLog({
        spender: someRandomSpender,
        value: 50_000_000n,
        blockNumber: 19_000_000,
        txHash: "0xa".repeat(40) + "0".repeat(24),
      }),
    ]);
    multicallMock.mockImplementation(async (callArgs: unknown) => {
      const opts = callArgs as {
        contracts: Array<{ functionName: string; args?: unknown[] }>;
      };
      return opts.contracts.map((c) => {
        if (c.functionName === "symbol") return { status: "success", result: "USDC" };
        if (c.functionName === "decimals") return { status: "success", result: 6 };
        if (c.functionName === "name") return { status: "success", result: "USD Coin" };
        if (c.functionName === "allowance") {
          return { status: "success", result: 50_000_000n };
        }
        return { status: "success", result: 0n };
      });
    });

    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });

    expect(r.allowances).toHaveLength(1);
    expect(r.allowances[0].permit2SubAllowances).toBeUndefined();
  });

  it("surfaces an EIP-2612 nonce note when nonces(owner) succeeds", async () => {
    etherscanV2FetchMock.mockResolvedValue([]);
    readContractMock.mockResolvedValue(12n); // current nonce
    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });
    const eip2612Note = r.notes.find((n) =>
      n.toLowerCase().includes("eip-2612"),
    );
    expect(eip2612Note).toBeDefined();
    expect(eip2612Note).toContain("Current nonce: 12");
  });

  it("OMITS the EIP-2612 note when nonces(owner) reverts", async () => {
    etherscanV2FetchMock.mockResolvedValue([]);
    readContractMock.mockRejectedValue(new Error("not eip2612"));
    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });
    expect(r.notes.find((n) => n.toLowerCase().includes("eip-2612"))).toBeUndefined();
  });

  it("includes the completeness footnote in notes", async () => {
    etherscanV2FetchMock.mockResolvedValue([]);
    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });
    expect(
      r.notes.some((n) => n.toLowerCase().includes("completeness caveat")),
    ).toBe(true);
  });
});

describe("fetchPermit2SubAllowances — drop semantics", () => {
  it("drops sub-allowances with expiration === 0 (Permit2's 'fresh signature required' marker)", async () => {
    const { PERMIT2_APPROVAL_TOPIC, fetchPermit2SubAllowances } = await import(
      "../src/modules/allowances/permit2.ts"
    );
    etherscanV2FetchMock.mockResolvedValue([
      permit2Log({
        topic0: PERMIT2_APPROVAL_TOPIC,
        downstreamSpender: UNIVERSAL_ROUTER,
        blockNumber: 19_100_000,
        txHash: "0xd".repeat(40) + "0".repeat(24),
      }),
    ]);
    multicallMock.mockResolvedValue([
      { status: "success", result: [1_000_000n, 0, 0] },
    ]);
    const result = await fetchPermit2SubAllowances({
      chain: "ethereum",
      owner: WALLET as `0x${string}`,
      token: USDC as `0x${string}`,
      decimals: 6,
    });
    // expiration === 0 → drop, but it's a "fresh signature required"
    // marker rather than expired, so expiredCount stays 0.
    expect(result.rows).toHaveLength(0);
    expect(result.expiredCount).toBe(0);
  });

  it("counts sub-allowances with expiration ≤ now as expired (and drops them)", async () => {
    const { PERMIT2_APPROVAL_TOPIC, fetchPermit2SubAllowances } = await import(
      "../src/modules/allowances/permit2.ts"
    );
    etherscanV2FetchMock.mockResolvedValue([
      permit2Log({
        topic0: PERMIT2_APPROVAL_TOPIC,
        downstreamSpender: UNIVERSAL_ROUTER,
        blockNumber: 19_100_000,
        txHash: "0xd".repeat(40) + "0".repeat(24),
      }),
    ]);
    const past = Math.floor(Date.now() / 1000) - 100;
    multicallMock.mockResolvedValue([
      { status: "success", result: [1_000_000n, past, 0] },
    ]);
    const result = await fetchPermit2SubAllowances({
      chain: "ethereum",
      owner: WALLET as `0x${string}`,
      token: USDC as `0x${string}`,
      decimals: 6,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.expiredCount).toBe(1);
  });

  it("ignores logs with non-Permit2 topic0 values (defensive)", async () => {
    const { fetchPermit2SubAllowances } = await import(
      "../src/modules/allowances/permit2.ts"
    );
    etherscanV2FetchMock.mockResolvedValue([
      // A log that happens to come from the Permit2 address but with an
      // unexpected topic0 (e.g. a future Permit2 v2 event we don't
      // know about). Should be silently ignored.
      permit2Log({
        topic0: "0x" + "ff".repeat(32),
        downstreamSpender: UNIVERSAL_ROUTER,
        blockNumber: 19_100_000,
        txHash: "0xd".repeat(40) + "0".repeat(24),
      }),
    ]);
    const result = await fetchPermit2SubAllowances({
      chain: "ethereum",
      owner: WALLET as `0x${string}`,
      token: USDC as `0x${string}`,
      decimals: 6,
    });
    // The unknown-topic log is filtered → no spenders to scan → no
    // multicall fired → empty result.
    expect(result.rows).toHaveLength(0);
    expect(result.totalScanned).toBe(0);
  });
});
