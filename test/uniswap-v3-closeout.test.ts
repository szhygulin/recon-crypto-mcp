/**
 * Tests for the close-out lifecycle builders — M1c in
 * `claude-work/plan-dex-liquidity-provision.md`. Three tools:
 * `prepare_uniswap_v3_decrease_liquidity`, `_collect`, `_burn`.
 *
 * Mocks the RPC surface so positions(tokenId), ownerOf, slot0, etc.
 * return deterministic values. Asserts:
 *   - calldata for each tool decodes correctly
 *   - ownership check rejects mismatched wallets (all three tools)
 *   - decrease: liquidityPct vs liquidity mutual exclusion, range
 *     validation
 *   - collect: harvests with uint128.max caps
 *   - burn: refuses unless drained, names the right next step on
 *     refusal
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData } from "viem";
import { uniswapPositionManagerAbi } from "../src/abis/uniswap-position-manager.js";

const { readContractMock, multicallMock } = vi.hoisted(() => ({
  readContractMock: vi.fn(),
  multicallMock: vi.fn(),
}));

vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: readContractMock,
    multicall: multicallMock,
  }),
  verifyChainId: vi.fn().mockResolvedValue(undefined),
  resetClients: vi.fn(),
}));

const WALLET = "0x000000000000000000000000000000000000dEaD" as const;
const OTHER_WALLET = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;
const USDC_WETH_POOL = "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8" as const;

const TOKEN_ID = "12345";

const FAKE_CURRENT_TICK = -201_960;
const FAKE_SQRT_PRICE_X96 = 3_262_820_378_846_468_593_912_909n;
const FAKE_POOL_LIQUIDITY = 10_000_000_000_000_000_000n;

const POSITION_LIQUIDITY = 1_000_000n;

function positionTuple(opts: {
  liquidity?: bigint;
  tokensOwed0?: bigint;
  tokensOwed1?: bigint;
  tickLower?: number;
  tickUpper?: number;
} = {}) {
  return [
    0n, // nonce
    "0x0000000000000000000000000000000000000000" as `0x${string}`, // operator
    USDC,
    WETH,
    3_000, // fee
    opts.tickLower ?? -202_020,
    opts.tickUpper ?? -201_900,
    opts.liquidity ?? POSITION_LIQUIDITY,
    0n, // feeGrowthInside0LastX128
    0n, // feeGrowthInside1LastX128
    opts.tokensOwed0 ?? 0n,
    opts.tokensOwed1 ?? 0n,
  ] as const;
}

function mockPositionRead(opts: {
  owner?: `0x${string}`;
  position?: ReturnType<typeof positionTuple>;
  withSlot0?: boolean;
} = {}) {
  multicallMock.mockImplementation(
    async ({ contracts }: { contracts: Array<{ functionName: string }> }) => {
      if (contracts[0]?.functionName === "positions" && contracts[1]?.functionName === "ownerOf") {
        return [opts.position ?? positionTuple(), opts.owner ?? WALLET];
      }
      if (contracts[0]?.functionName === "decimals" && contracts[1]?.functionName === "symbol") {
        return [6, "USDC", 18, "WETH"];
      }
      if (contracts[0]?.functionName === "slot0") {
        return [
          [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true],
          FAKE_POOL_LIQUIDITY,
        ];
      }
      throw new Error(
        `unexpected multicall: ${JSON.stringify(contracts.map((c) => c.functionName))}`,
      );
    },
  );
  readContractMock.mockImplementation(
    async ({ functionName }: { functionName: string }) => {
      if (functionName === "getPool") return USDC_WETH_POOL;
      throw new Error(`unexpected readContract: ${functionName}`);
    },
  );
}

beforeEach(() => {
  readContractMock.mockReset();
  multicallMock.mockReset();
});

describe("buildUniswapDecrease", () => {
  it("happy path: 100% decrease produces decreaseLiquidity() calldata", async () => {
    mockPositionRead();
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapDecrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      liquidityPct: 100,
      slippageBps: 50,
    });
    expect(tx.to.toLowerCase()).toBe(NPM.toLowerCase());
    expect(tx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe("decreaseLiquidity");
    const params = (decoded.args as readonly [{
      tokenId: bigint;
      liquidity: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
      deadline: bigint;
    }])[0];
    expect(params.tokenId).toBe(12_345n);
    expect(params.liquidity).toBe(POSITION_LIQUIDITY); // full liquidity
    // amount0Min/amount1Min should be non-negative; with 50 bps slippage
    // they may both be 0 for a tiny position but that's fine.
    expect(params.amount0Min).toBeGreaterThanOrEqual(0n);
    expect(params.amount1Min).toBeGreaterThanOrEqual(0n);
    expect(tx.description).toContain("Decrease Uniswap V3 LP position");
    expect(tx.description).toContain("100%");
  });

  it("partial decrease: liquidityPct=50 burns half the position liquidity", async () => {
    mockPositionRead();
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapDecrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      liquidityPct: 50,
    });
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: tx.data,
    });
    const params = (decoded.args as readonly [{ liquidity: bigint }])[0];
    expect(params.liquidity).toBe(POSITION_LIQUIDITY / 2n);
  });

  it("raw liquidity arg overrides liquidityPct calculation", async () => {
    mockPositionRead();
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapDecrease({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      liquidity: "12345",
    });
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: tx.data,
    });
    const params = (decoded.args as readonly [{ liquidity: bigint }])[0];
    expect(params.liquidity).toBe(12_345n);
  });

  it("rejects passing both liquidityPct and liquidity", async () => {
    mockPositionRead();
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapDecrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        liquidityPct: 50,
        liquidity: "100",
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects passing neither liquidityPct nor liquidity", async () => {
    mockPositionRead();
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapDecrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects raw liquidity exceeding the position's liquidity", async () => {
    mockPositionRead();
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapDecrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        liquidity: (POSITION_LIQUIDITY + 1n).toString(),
      }),
    ).rejects.toThrow(/exceeds position liquidity/);
  });

  it("rejects when position has zero liquidity (nothing to decrease)", async () => {
    mockPositionRead({ position: positionTuple({ liquidity: 0n }) });
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapDecrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        liquidityPct: 100,
      }),
    ).rejects.toThrow(/zero liquidity already/);
  });

  it("hard-refuses on owner mismatch", async () => {
    mockPositionRead({ owner: OTHER_WALLET });
    const { buildUniswapDecrease } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapDecrease({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
        liquidityPct: 100,
      }),
    ).rejects.toThrow(/is owned by/);
  });
});

describe("buildUniswapCollect", () => {
  it("happy path: encodes collect() with uint128.max caps", async () => {
    mockPositionRead();
    const { buildUniswapCollect } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapCollect({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
    });
    expect(tx.to.toLowerCase()).toBe(NPM.toLowerCase());
    expect(tx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe("collect");
    const params = (decoded.args as readonly [{
      tokenId: bigint;
      recipient: string;
      amount0Max: bigint;
      amount1Max: bigint;
    }])[0];
    expect(params.tokenId).toBe(12_345n);
    expect(params.recipient.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(params.amount0Max).toBe((1n << 128n) - 1n);
    expect(params.amount1Max).toBe((1n << 128n) - 1n);
  });

  it("custom recipient routes the harvest elsewhere", async () => {
    mockPositionRead();
    const { buildUniswapCollect } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapCollect({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
      recipient: OTHER_WALLET,
    });
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: tx.data,
    });
    const params = (decoded.args as readonly [{ recipient: string }])[0];
    expect(params.recipient.toLowerCase()).toBe(OTHER_WALLET.toLowerCase());
  });

  it("hard-refuses on owner mismatch", async () => {
    mockPositionRead({ owner: OTHER_WALLET });
    const { buildUniswapCollect } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapCollect({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
      }),
    ).rejects.toThrow(/is owned by/);
  });

  it("succeeds even when tokensOwed=0 (fee growth still settles inside collect)", async () => {
    mockPositionRead({
      position: positionTuple({ tokensOwed0: 0n, tokensOwed1: 0n }),
    });
    const { buildUniswapCollect } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapCollect({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
    });
    expect(tx.description).toContain("Collect Uniswap V3 LP position");
  });
});

describe("buildUniswapBurn", () => {
  it("happy path: drained position → burn(tokenId) calldata", async () => {
    mockPositionRead({
      position: positionTuple({
        liquidity: 0n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
    });
    const { buildUniswapBurn } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapBurn({
      chain: "ethereum",
      wallet: WALLET,
      tokenId: TOKEN_ID,
    });
    expect(tx.to.toLowerCase()).toBe(NPM.toLowerCase());
    expect(tx.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: uniswapPositionManagerAbi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe("burn");
    expect(decoded.args).toEqual([12_345n]);
    expect(tx.description).toContain("Burn Uniswap V3 LP NFT");
    expect(tx.description).toContain("irreversible");
  });

  it("refuses when liquidity > 0 and names the right next step", async () => {
    mockPositionRead({ position: positionTuple({ liquidity: 1_000_000n }) });
    const { buildUniswapBurn } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapBurn({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
      }),
    ).rejects.toThrow(/decrease_liquidity.*liquidityPct: 100/);
  });

  it("refuses when tokensOwed > 0 and names the right next step", async () => {
    mockPositionRead({
      position: positionTuple({ liquidity: 0n, tokensOwed0: 100n, tokensOwed1: 0n }),
    });
    const { buildUniswapBurn } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapBurn({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
      }),
    ).rejects.toThrow(/prepare_uniswap_v3_collect/);
  });

  it("hard-refuses on owner mismatch", async () => {
    mockPositionRead({ owner: OTHER_WALLET });
    const { buildUniswapBurn } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    await expect(
      buildUniswapBurn({
        chain: "ethereum",
        wallet: WALLET,
        tokenId: TOKEN_ID,
      }),
    ).rejects.toThrow(/is owned by/);
  });
});

describe("burnAmounts + burnAmountsWithSlippage (port math)", () => {
  it("burnAmounts at current price round-trips with mintAmounts (round-down ≤ round-up)", async () => {
    const { burnAmounts, mintAmounts } = await import(
      "../src/modules/lp/uniswap-v3/position-math.js"
    );
    const { getSqrtRatioAtTick } = await import(
      "../src/modules/lp/uniswap-v3/tick-math.js"
    );
    const sqrtRatioX96 = getSqrtRatioAtTick(FAKE_CURRENT_TICK);
    const pool = {
      fee: 3_000,
      sqrtRatioX96,
      tickCurrent: FAKE_CURRENT_TICK,
      tickSpacing: 60,
    };
    const args = {
      pool,
      tickLower: -202_020,
      tickUpper: -201_900,
      liquidity: 1_000_000n,
    };
    const minted = mintAmounts(args);
    const burned = burnAmounts(args);
    // Round-down (burn) ≤ round-up (mint) by construction. The diff is
    // at most 1 wei per side from the rounding correction.
    expect(burned.amount0).toBeLessThanOrEqual(minted.amount0);
    expect(burned.amount1).toBeLessThanOrEqual(minted.amount1);
    expect(minted.amount0 - burned.amount0).toBeLessThanOrEqual(1n);
    expect(minted.amount1 - burned.amount1).toBeLessThanOrEqual(1n);
  });

  it("burnAmountsWithSlippage: higher slippage → looser (smaller) min amounts", async () => {
    const { burnAmountsWithSlippage } = await import(
      "../src/modules/lp/uniswap-v3/position-math.js"
    );
    const { getSqrtRatioAtTick } = await import(
      "../src/modules/lp/uniswap-v3/tick-math.js"
    );
    const sqrtRatioX96 = getSqrtRatioAtTick(FAKE_CURRENT_TICK);
    const args = {
      pool: {
        fee: 3_000,
        sqrtRatioX96,
        tickCurrent: FAKE_CURRENT_TICK,
        tickSpacing: 60,
      },
      tickLower: -202_020,
      tickUpper: -201_900,
      liquidity: 1_000_000n,
    };
    const tight = burnAmountsWithSlippage({ ...args, slippageBps: 50 });
    const loose = burnAmountsWithSlippage({ ...args, slippageBps: 500 });
    // Looser slippage → smaller floor on at least one side.
    expect(loose.amount0 + loose.amount1).toBeLessThanOrEqual(
      tight.amount0 + tight.amount1,
    );
  });
});
