/**
 * get_market_incident_status — "is anything on fire right now".
 *
 * Scenario mirrored from 2026-04-20: cUSDCv3 has isWithdrawPaused=true AND
 * cWETHv3 is at 95%+ utilization. The tool should flag both and return
 * incident=true at the top level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("get_market_incident_status (compound-v3)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("flags a paused market and a high-utilization market", async () => {
    // cUSDCv3 and cUSDTv3 addresses are taken from the actual registry so the
    // module's listMarkets returns them. The cWETHv3 and cwstETHv3 addresses
    // are also real; we only care about the shape of the reads here.
    const cUSDCv3 = "0xc3d688B66703497DAA19211EEdff47f25384cdc3".toLowerCase();
    const cUSDTv3 = "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840".toLowerCase();
    const cWETHv3 = "0xA17581A9E3356d9A858b789D68B4d866e593aE94".toLowerCase();

    const mockClient = {
      getBlockNumber: vi.fn(async () => 19_800_000n),
      multicall: vi.fn(
        async ({ contracts }: { contracts: { address: string; functionName: string }[] }) => {
          const first = contracts[0];
          const target = first.address.toLowerCase();
          // Pause-flag multicall (5 calls, all to the same comet).
          if (first.functionName === "isSupplyPaused") {
            // cUSDCv3 → withdraw paused. others clean.
            if (target === cUSDCv3) {
              return [
                { status: "success", result: false },
                { status: "success", result: false },
                { status: "success", result: true }, // isWithdrawPaused
                { status: "success", result: false },
                { status: "success", result: false },
              ];
            }
            return Array.from({ length: 5 }, () => ({
              status: "success",
              result: false,
            }));
          }
          // Core reads: baseToken, getUtilization, totalSupply, totalBorrow.
          if (first.functionName === "baseToken") {
            if (target === cUSDCv3) {
              return [
                "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
                600_000_000_000_000_000n, // 0.6 utilization
                1_000_000_000_000n,
                600_000_000_000n,
              ];
            }
            if (target === cUSDTv3) {
              return [
                "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
                700_000_000_000_000_000n,
                500_000_000_000n,
                350_000_000_000n,
              ];
            }
            if (target === cWETHv3) {
              return [
                "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
                960_000_000_000_000_000n, // 96% utilization → flagged
                100_000_000_000_000_000_000_000n,
                96_000_000_000_000_000_000_000n,
              ];
            }
            // cwstETHv3 default
            return [
              "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
              500_000_000_000_000_000n,
              1_000_000_000_000_000_000_000n,
              500_000_000_000_000_000_000n,
            ];
          }
          // Base-token metadata multicall: decimals + symbol.
          if (first.functionName === "decimals") {
            const addr = first.address.toLowerCase();
            if (addr === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return [6, "USDC"];
            if (addr === "0xdac17f958d2ee523a2206206994597c13d831ec7") return [6, "USDT"];
            if (addr === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2") return [18, "WETH"];
            return [18, "wstETH"];
          }
          return [];
        }
      ),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    const result = await getMarketIncidentStatus({
      protocol: "compound-v3",
      chain: "ethereum",
    });

    expect(result.incident).toBe(true);
    expect(result.markets.length).toBeGreaterThanOrEqual(3);

    const cusdc = result.markets.find(
      (m) => m.address.toLowerCase() === cUSDCv3
    )!;
    expect(cusdc.pausedActions).toContain("withdraw");
    expect(cusdc.flagged).toBe(true);

    const cweth = result.markets.find(
      (m) => m.address.toLowerCase() === cWETHv3
    )!;
    expect(cweth.utilization).toBeGreaterThanOrEqual(0.95);
    expect(cweth.flagged).toBe(true);

    const cusdt = result.markets.find(
      (m) => m.address.toLowerCase() === cUSDTv3
    )!;
    expect(cusdt.flagged).toBe(false);
  });

  it("flags a paused Aave reserve and a high-utilization reserve", async () => {
    // Three reserves: WETH (paused, low utilization), USDC (clean, 99% utilization),
    // DAI (clean, normal utilization). Expect incident=true with two flagged entries.
    const reserves = [
      {
        underlyingAsset: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        name: "Wrapped Ether",
        symbol: "WETH",
        decimals: 18n,
        isActive: true,
        isFrozen: false,
        isPaused: true, // flagged: paused
        variableBorrowIndex: 10n ** 27n,
        availableLiquidity: 1000n * 10n ** 18n,
        totalScaledVariableDebt: 100n * 10n ** 18n,
      },
      {
        underlyingAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6n,
        isActive: true,
        isFrozen: false,
        isPaused: false,
        variableBorrowIndex: 10n ** 27n,
        // 1 unit liquid, 99 units borrowed → 99% util → flagged.
        availableLiquidity: 1_000_000n,
        totalScaledVariableDebt: 99_000_000n,
      },
      {
        underlyingAsset: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        name: "Dai Stablecoin",
        symbol: "DAI",
        decimals: 18n,
        isActive: true,
        isFrozen: false,
        isPaused: false,
        variableBorrowIndex: 10n ** 27n,
        availableLiquidity: 500n * 10n ** 18n,
        totalScaledVariableDebt: 500n * 10n ** 18n, // 50% util, not flagged
      },
    ];

    const mockClient = {
      getBlockNumber: vi.fn(async () => 19_800_000n),
      readContract: vi.fn(
        async ({ functionName }: { functionName: string }) => {
          if (functionName === "getReservesData") {
            return [
              reserves,
              {
                marketReferenceCurrencyUnit: 10n ** 8n,
                marketReferenceCurrencyPriceInUsd: 10n ** 8n,
                networkBaseTokenPriceInUsd: 0n,
                networkBaseTokenPriceDecimals: 8,
              },
            ];
          }
          throw new Error(`unexpected readContract ${functionName}`);
        }
      ),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    const result = await getMarketIncidentStatus({
      protocol: "aave-v3",
      chain: "ethereum",
    });

    expect(result.protocol).toBe("aave-v3");
    expect(result.incident).toBe(true);
    expect(result.markets).toHaveLength(3);

    const weth = result.markets.find((m) => m.symbol === "WETH")!;
    expect(weth.isPaused).toBe(true);
    expect(weth.flagged).toBe(true);

    const usdc = result.markets.find((m) => m.symbol === "USDC")!;
    expect(usdc.utilization).toBeGreaterThanOrEqual(0.95);
    expect(usdc.flagged).toBe(true);

    const dai = result.markets.find((m) => m.symbol === "DAI")!;
    expect(dai.flagged).toBe(false);
  });

  it("refuses unsupported protocols", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ getBlockNumber: async () => 0n, multicall: async () => [] }),
      resetClients: () => {},
    }));
    const { getMarketIncidentStatus } = await import(
      "../src/modules/incidents/index.js"
    );
    await expect(
      getMarketIncidentStatus({
        protocol: "morpho-blue" as unknown as "compound-v3",
        chain: "ethereum",
      })
    ).rejects.toThrow(/compound-v3|aave-v3/);
  });
});
