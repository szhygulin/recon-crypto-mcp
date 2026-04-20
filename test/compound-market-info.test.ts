/**
 * get_compound_market_info tool.
 *
 * Collapses what the 2026-04-20 session had to do manually: numAssets() +
 * 13 × getAssetInfo(uint8) + hand-rolled ABI decode loop, plus
 * totalsCollateral() per asset, plus pause flag reads. This test locks in the
 * structured response shape so future ABI drift in Comet doesn't silently
 * degrade the tool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("get_compound_market_info", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns base token, utilization, rates, pause flags, and collateral list", async () => {
    const baseAddr = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC

    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        const first = contracts[0] as { functionName: string };
        // Core reads: baseToken, numAssets, totalSupply, totalBorrow, getUtilization.
        if (first.functionName === "baseToken" && contracts.length === 5) {
          return [
            baseAddr,
            2,
            5_000_000_000_000n, // totalSupply
            3_500_000_000_000n, // totalBorrow (69% utilization-ish)
            690_000_000_000_000_000n, // utilization = 0.69 * 1e18
          ];
        }
        // Rate reads.
        if (first.functionName === "getSupplyRate") {
          return [
            634_000_000n, // per-second supply rate
            951_000_000n, // per-second borrow rate
          ];
        }
        // Base metadata: decimals + symbol.
        if (first.functionName === "decimals" && contracts.length === 2) {
          return [6, "USDC"];
        }
        // getAssetInfo per slot.
        if (first.functionName === "getAssetInfo") {
          return [
            {
              offset: 0,
              asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
              priceFeed: "0x0000000000000000000000000000000000000001",
              scale: 100_000_000n,
              borrowCollateralFactor: 700_000_000_000_000_000n, // 70%
              liquidateCollateralFactor: 770_000_000_000_000_000n,
              liquidationFactor: 930_000_000_000_000_000n,
              supplyCap: 3_500_00000000n, // 3500 WBTC
            },
            {
              offset: 1,
              asset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
              priceFeed: "0x0000000000000000000000000000000000000002",
              scale: 1_000_000_000_000_000_000n,
              borrowCollateralFactor: 825_000_000_000_000_000n,
              liquidateCollateralFactor: 895_000_000_000_000_000n,
              liquidationFactor: 950_000_000_000_000_000n,
              supplyCap: 350_000_000_000_000_000_000_000n,
            },
          ];
        }
        // Per-asset enrichment: totalsCollateral + decimals + symbol, per asset.
        // Mixed-ABI; the function identifies it by checking functionName on each.
        return contracts.map((c) => {
          const fn = (c as { functionName: string }).functionName;
          if (fn === "totalsCollateral") {
            return {
              status: "success",
              result: { totalSupplyAsset: 1n, _reserved: 0n },
            };
          }
          if (fn === "decimals") return { status: "success", result: 18 };
          if (fn === "symbol") return { status: "success", result: "X" };
          return { status: "success", result: 0n };
        });
      }),
      readContract: vi.fn(async (p: { functionName: string }) => {
        // Pause-flag reads (from readCometPausedActions).
        if (p.functionName === "isWithdrawPaused") return true; // Simulates cUSDCv3 on 2026-04-20.
        return false;
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    // readCometPausedActions uses multicall; redirect it too. We patched a
    // pause branch into multicall above if contracts are pause flags.
    const origMulticall = mockClient.multicall;
    mockClient.multicall = vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
      const first = contracts[0] as { functionName: string };
      if (first.functionName === "isSupplyPaused") {
        return [
          { status: "success", result: false },
          { status: "success", result: false },
          { status: "success", result: true }, // isWithdrawPaused
          { status: "success", result: false },
          { status: "success", result: false },
        ];
      }
      return origMulticall({ contracts });
    });

    const { getCompoundMarketInfo } = await import(
      "../src/modules/compound/market-info.js"
    );
    const info = await getCompoundMarketInfo({
      chain: "ethereum",
      market: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    });

    expect(info.baseToken.symbol).toBe("USDC");
    expect(info.baseToken.decimals).toBe(6);
    expect(info.totalSupply).toBe("5000000");
    expect(info.totalBorrow).toBe("3500000");
    expect(info.utilization).toBeCloseTo(0.69, 2);
    expect(info.pausedActions).toContain("withdraw");
    expect(info.collateralAssets).toHaveLength(2);
    expect(info.collateralAssets[0].asset.toLowerCase()).toBe(
      "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"
    );
    expect(info.collateralAssets[1].asset.toLowerCase()).toBe(
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
    );
  });
});
