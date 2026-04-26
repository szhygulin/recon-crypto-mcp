/**
 * `get_token_allowances` tests. Mocks both the Etherscan logs API and
 * the viem multicall (via `getClient`) so no live HTTP fires.
 *
 * Coverage:
 *   - Happy path: 3 historical approvals, 1 currently revoked, 1 unlimited.
 *     → 2 rows surface, sorted desc, unlimited heuristic + label resolved
 *     when the spender matches a CONTRACTS-table entry.
 *   - All-revoked: every spender currently 0 → empty `allowances`, note
 *     surfaces.
 *   - No approvals ever: empty logs → empty `allowances`, "no active
 *     approvals" note.
 *   - Truncated logs (1000 entries) → `truncated: true` + note.
 *   - Token metadata fetch fails (non-ERC-20 contract) → throws.
 *   - Spender label: known protocol address gets a friendly label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const etherscanV2FetchMock = vi.fn();
const multicallMock = vi.fn();

vi.mock("../src/data/apis/etherscan-v2.js", () => ({
  etherscanV2Fetch: (...a: unknown[]) => etherscanV2FetchMock(...a),
  // Real classes need pass-through for `instanceof` checks elsewhere.
  EtherscanApiKeyMissingError: class EtherscanApiKeyMissingError extends Error {},
  EtherscanNoDataError: class EtherscanNoDataError extends Error {},
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({ multicall: (...a: unknown[]) => multicallMock(...a) }),
  resetClients: () => {},
}));

const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const WALLET = "0x000000000000000000000000000000000000dEaD";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// Known: Aave V3 Pool on Ethereum — listed in src/config/contracts.ts.
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const RANDOM_SPENDER_1 = "0x1111111111111111111111111111111111111111";
const RANDOM_SPENDER_2 = "0x2222222222222222222222222222222222222222";
const MAX = (1n << 256n) - 1n;

function pad32(addrLower: string): string {
  return `0x000000000000000000000000${addrLower.replace(/^0x/, "").toLowerCase()}`;
}

function encUint(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function approvalLog(args: {
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

beforeEach(() => {
  etherscanV2FetchMock.mockReset();
  multicallMock.mockReset();
  // Default token-metadata multicall response: USDC.
  multicallMock.mockImplementation(async (callArgs: unknown) => {
    const opts = callArgs as { contracts: Array<{ functionName: string }> };
    return opts.contracts.map((c) => {
      if (c.functionName === "symbol") {
        return { status: "success", result: "USDC" };
      }
      if (c.functionName === "decimals") {
        return { status: "success", result: 6 };
      }
      if (c.functionName === "name") {
        return { status: "success", result: "USD Coin" };
      }
      // Any allowance() default = 0.
      return { status: "success", result: 0n };
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getTokenAllowances — happy path", () => {
  it("returns 2 active rows, sorted desc, unlimited flagged, known label resolved", async () => {
    // 3 historical approvals.
    etherscanV2FetchMock.mockResolvedValue([
      approvalLog({
        spender: AAVE_POOL,
        value: MAX,
        blockNumber: 19_000_000,
        txHash: "0xa".repeat(40) + "0".repeat(24),
        timeStamp: 1_700_000_000,
      }),
      approvalLog({
        spender: RANDOM_SPENDER_1,
        value: 1_000_000n, // 1 USDC
        blockNumber: 19_500_000,
        txHash: "0xb".repeat(40) + "0".repeat(24),
        timeStamp: 1_710_000_000,
      }),
      approvalLog({
        spender: RANDOM_SPENDER_2,
        value: 50_000_000n, // 50 USDC
        blockNumber: 19_900_000,
        txHash: "0xc".repeat(40) + "0".repeat(24),
        timeStamp: 1_715_000_000,
      }),
    ]);
    // Current allowances: AAVE_POOL still MAX (unlimited, alive),
    // RANDOM_SPENDER_1 fully consumed → 0 (drop), RANDOM_SPENDER_2 still 50 USDC.
    multicallMock.mockImplementation(async (callArgs: unknown) => {
      const opts = callArgs as { contracts: Array<{ functionName: string; args?: unknown[] }> };
      return opts.contracts.map((c) => {
        if (c.functionName === "symbol") return { status: "success", result: "USDC" };
        if (c.functionName === "decimals") return { status: "success", result: 6 };
        if (c.functionName === "name") return { status: "success", result: "USD Coin" };
        if (c.functionName === "allowance") {
          const spender = (c.args?.[1] as string).toLowerCase();
          if (spender === AAVE_POOL.toLowerCase()) return { status: "success", result: MAX };
          if (spender === RANDOM_SPENDER_1.toLowerCase()) return { status: "success", result: 0n };
          if (spender === RANDOM_SPENDER_2.toLowerCase()) return { status: "success", result: 50_000_000n };
        }
        return { status: "failure", error: new Error("unexpected") };
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

    expect(r.token.symbol).toBe("USDC");
    expect(r.token.decimals).toBe(6);
    expect(r.totalScanned).toBe(3);
    expect(r.allowances).toHaveLength(2);
    // Sorted desc: AAVE first (MAX) then RANDOM_SPENDER_2 (50 USDC).
    expect(r.allowances[0].spender.toLowerCase()).toBe(AAVE_POOL.toLowerCase());
    expect(r.allowances[0].isUnlimited).toBe(true);
    expect(r.allowances[0].currentAllowanceFormatted).toBe("unlimited");
    expect(r.allowances[0].spenderLabel).toContain("Aave V3 Pool");
    expect(r.allowances[1].spender.toLowerCase()).toBe(RANDOM_SPENDER_2.toLowerCase());
    expect(r.allowances[1].isUnlimited).toBe(false);
    expect(r.allowances[1].currentAllowanceFormatted).toBe("50");
    // RANDOM_SPENDER_1 dropped (allowance now 0).
    expect(r.allowances.find((a) => a.spender.toLowerCase() === RANDOM_SPENDER_1.toLowerCase())).toBeUndefined();
    expect(r.unlimitedCount).toBe(1);
    expect(r.notes.some((n) => n.toLowerCase().includes("unlimited"))).toBe(true);
  });
});

describe("getTokenAllowances — all revoked", () => {
  it("returns empty allowances + the 'no active approvals' note", async () => {
    etherscanV2FetchMock.mockResolvedValue([
      approvalLog({
        spender: RANDOM_SPENDER_1,
        value: 100n,
        blockNumber: 1,
        txHash: "0x" + "1".repeat(64),
      }),
    ]);
    // Current allowance is 0 (revoked).
    // Default multicall mock returns 0 for allowance — sufficient.

    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });

    expect(r.allowances).toHaveLength(0);
    expect(r.totalScanned).toBe(1);
    expect(r.unlimitedCount).toBe(0);
    expect(r.notes.some((n) => n.toLowerCase().includes("no active approvals"))).toBe(true);
  });
});

describe("getTokenAllowances — no approvals ever", () => {
  it("handles an empty logs response cleanly", async () => {
    etherscanV2FetchMock.mockResolvedValue([]);
    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });

    expect(r.allowances).toHaveLength(0);
    expect(r.totalScanned).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe("getTokenAllowances — truncation", () => {
  it("flags truncated:true when the logs response hits the cap", async () => {
    const logs = [];
    for (let i = 0; i < 1000; i++) {
      logs.push(
        approvalLog({
          spender: `0x${"a".repeat(39)}${(i % 16).toString(16)}`,
          value: 1n,
          blockNumber: 1 + i,
          txHash: "0x" + i.toString(16).padStart(64, "0"),
        }),
      );
    }
    etherscanV2FetchMock.mockResolvedValue(logs);
    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    const r = await getTokenAllowances({
      wallet: WALLET,
      token: USDC,
      chain: "ethereum",
    });
    expect(r.truncated).toBe(true);
    expect(r.notes.some((n) => n.includes("Etherscan logs API"))).toBe(true);
  });
});

describe("getTokenAllowances — non-ERC-20 contract", () => {
  it("throws when symbol+decimals reads fail", async () => {
    etherscanV2FetchMock.mockResolvedValue([]);
    multicallMock.mockResolvedValueOnce([
      { status: "failure", error: new Error("not erc20") },
      { status: "failure", error: new Error("not erc20") },
      { status: "failure", error: new Error("not erc20") },
    ]);
    // The implementation does Promise.all([metadata, currentAllowances]) —
    // currentAllowances on empty spender list returns [] without a multicall
    // call, so only one multicall (metadata) is pending. Simpler mock above
    // (mockResolvedValueOnce) covers it.
    const { getTokenAllowances } = await import(
      "../src/modules/allowances/index.ts"
    );
    await expect(
      getTokenAllowances({
        wallet: WALLET,
        token: USDC,
        chain: "ethereum",
      }),
    ).rejects.toThrow(/symbol\+decimals|ERC-20/);
  });
});

describe("getTokenAllowances — provenance fields", () => {
  it("surfaces lastApprovedBlock + lastApprovedTxHash + lastApprovedAt from the LATEST log", async () => {
    // Two approvals to the same spender; second overwrites the first in
    // the dedup pass.
    etherscanV2FetchMock.mockResolvedValue([
      approvalLog({
        spender: RANDOM_SPENDER_1,
        value: 100n,
        blockNumber: 100,
        txHash: "0x" + "1".repeat(64),
        timeStamp: 1_700_000_000,
      }),
      approvalLog({
        spender: RANDOM_SPENDER_1,
        value: 200n,
        blockNumber: 200,
        txHash: "0x" + "2".repeat(64),
        timeStamp: 1_710_000_000,
      }),
    ]);
    multicallMock.mockImplementation(async (callArgs: unknown) => {
      const opts = callArgs as { contracts: Array<{ functionName: string }> };
      return opts.contracts.map((c) => {
        if (c.functionName === "symbol") return { status: "success", result: "USDC" };
        if (c.functionName === "decimals") return { status: "success", result: 6 };
        if (c.functionName === "name") return { status: "success", result: "USD Coin" };
        if (c.functionName === "allowance") {
          // Live = the most recent value (200) — but the live read could
          // also differ; use 200 here to keep the row alive.
          return { status: "success", result: 200n };
        }
        return { status: "failure", error: new Error("unexpected") };
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
    const row = r.allowances[0];
    expect(row.lastApprovedBlock).toBe("200");
    expect(row.lastApprovedTxHash).toBe("0x" + "2".repeat(64));
    expect(row.lastApprovedAt).toBe(new Date(1_710_000_000 * 1000).toISOString());
  });
});
