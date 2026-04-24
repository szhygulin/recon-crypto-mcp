/**
 * Issue #93 core fix: getStakingPositions used to wrap Lido + EigenLayer
 * fetches in `Promise.all`, so either source rejecting caused the whole
 * function to throw. The portfolio aggregator's `.catch` then dropped BOTH
 * sources' positions and set `coverage.staking.errored: true` with no way
 * to tell WHICH source was broken. This test pins the allSettled refactor —
 * one source failing must no longer zero the other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("getStakingPositions — per-source failure isolation (#93)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const WALLET = "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361";

  it("returns EigenLayer positions even when Lido throws", async () => {
    vi.doMock("../src/modules/staking/lido.js", async () => ({
      getLidoPositions: vi.fn().mockRejectedValue(new Error("stETH RPC down")),
      getLidoApr: vi.fn(),
      estimateLidoRewards: vi.fn(),
    }));
    vi.doMock("../src/modules/staking/eigenlayer.js", async () => ({
      getEigenLayerPositions: vi.fn().mockResolvedValue([
        {
          protocol: "eigenlayer" as const,
          chain: "ethereum" as const,
          strategy: "0xDEADBEEFdeadbeefdeadbeefdeadbeefdeadbeef",
          token: {
            token: "0xAE7ab96520DE3A18E5e111B5EaAb095312D7fE84",
            symbol: "stETH",
            decimals: 18,
            amount: "1000000000000000000",
            formatted: "1.0",
          },
          stakedAmount: {
            token: "0xAE7ab96520DE3A18E5e111B5EaAb095312D7fE84",
            symbol: "stETH",
            decimals: 18,
            amount: "1000000000000000000",
            formatted: "1.0",
            valueUsd: 2500,
          },
          operator: null,
        },
      ]),
    }));
    const { getStakingPositions } = await import(
      "../src/modules/staking/index.js"
    );
    const r = await getStakingPositions({ wallet: WALLET });
    // EigenLayer position survives despite Lido's failure — the whole point
    // of the allSettled refactor.
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].protocol).toBe("eigenlayer");
    // But the response clearly flags that Lido was unavailable.
    expect(r.errored).toBe(true);
    expect(r.erroredSources).toHaveLength(1);
    expect(r.erroredSources![0].source).toBe("lido");
    expect(r.erroredSources![0].error).toMatch(/stETH RPC down/);
  });

  it("returns Lido positions even when EigenLayer throws", async () => {
    vi.doMock("../src/modules/staking/lido.js", async () => ({
      getLidoPositions: vi.fn().mockResolvedValue([
        {
          protocol: "lido" as const,
          chain: "ethereum" as const,
          token: "stETH",
          stakedAmount: {
            token: "0xAE7ab96520DE3A18E5e111B5EaAb095312D7fE84",
            symbol: "stETH",
            decimals: 18,
            amount: "2000000000000000000",
            formatted: "2.0",
            valueUsd: 5000,
          },
        },
      ]),
      getLidoApr: vi.fn(),
      estimateLidoRewards: vi.fn(),
    }));
    vi.doMock("../src/modules/staking/eigenlayer.js", async () => ({
      getEigenLayerPositions: vi
        .fn()
        .mockRejectedValue(new Error("strategyList() revert")),
    }));
    const { getStakingPositions } = await import(
      "../src/modules/staking/index.js"
    );
    const r = await getStakingPositions({ wallet: WALLET });
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].protocol).toBe("lido");
    expect(r.errored).toBe(true);
    expect(r.erroredSources![0].source).toBe("eigenlayer");
    expect(r.erroredSources![0].error).toMatch(/strategyList/);
  });

  it("returns no errored flag when both sources succeed (happy path unchanged)", async () => {
    vi.doMock("../src/modules/staking/lido.js", async () => ({
      getLidoPositions: vi.fn().mockResolvedValue([]),
      getLidoApr: vi.fn(),
      estimateLidoRewards: vi.fn(),
    }));
    vi.doMock("../src/modules/staking/eigenlayer.js", async () => ({
      getEigenLayerPositions: vi.fn().mockResolvedValue([]),
    }));
    const { getStakingPositions } = await import(
      "../src/modules/staking/index.js"
    );
    const r = await getStakingPositions({ wallet: WALLET });
    expect(r.positions).toEqual([]);
    expect(r.errored).toBeUndefined();
    expect(r.erroredSources).toBeUndefined();
  });

  it("captures both-source failures in one response (no short-circuit)", async () => {
    vi.doMock("../src/modules/staking/lido.js", async () => ({
      getLidoPositions: vi.fn().mockRejectedValue(new Error("lido err")),
      getLidoApr: vi.fn(),
      estimateLidoRewards: vi.fn(),
    }));
    vi.doMock("../src/modules/staking/eigenlayer.js", async () => ({
      getEigenLayerPositions: vi
        .fn()
        .mockRejectedValue(new Error("eigen err")),
    }));
    const { getStakingPositions } = await import(
      "../src/modules/staking/index.js"
    );
    const r = await getStakingPositions({ wallet: WALLET });
    expect(r.positions).toEqual([]);
    expect(r.errored).toBe(true);
    expect(r.erroredSources).toHaveLength(2);
    const sources = r.erroredSources!.map((e) => e.source).sort();
    expect(sources).toEqual(["eigenlayer", "lido"]);
  });
});
