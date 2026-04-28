/**
 * Unit tests for the DefiLlama-backed yields adapter (PR #431-bundle).
 *
 * The adapter lives in `src/modules/yields/adapters/defillama.ts` and
 * covers four protocols (Marinade, Jito, Kamino-lend, Morpho-Blue) by
 * filtering a single `https://yields.llama.fi/pools` payload.
 *
 * Tests stub `fetchWithTimeout` with a controlled fixture so we can
 * assert filter / threshold / per-asset behavior deterministically
 * without depending on live DefiLlama state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FixturePool {
  project: string;
  chain: string;
  symbol: string;
  apy: number | null;
  apyBase: number | null;
  tvlUsd: number | null;
  poolMeta: string | null;
}

function fixture(): FixturePool[] {
  return [
    // Marinade — only emits for SOL.
    {
      project: "marinade-liquid-staking",
      chain: "Solana",
      symbol: "MSOL",
      apy: 7.42,
      apyBase: 7.42,
      tvlUsd: 1_000_000_000,
      poolMeta: null,
    },
    // Jito — only emits for SOL.
    {
      project: "jito-liquid-staking",
      chain: "Solana",
      symbol: "JITOSOL",
      apy: 7.95,
      apyBase: 7.95,
      tvlUsd: 1_500_000_000,
      poolMeta: null,
    },
    // Kamino lending — exact symbol match.
    {
      project: "kamino-lend",
      chain: "Solana",
      symbol: "USDC",
      apy: 4.22,
      apyBase: 4.22,
      tvlUsd: 8_184_000,
      poolMeta: null,
    },
    {
      project: "kamino-lend",
      chain: "Solana",
      symbol: "USDC",
      apy: 6.5,
      apyBase: 6.5,
      tvlUsd: 1_500_000,
      poolMeta: "JLP",
    },
    {
      project: "kamino-lend",
      chain: "Solana",
      symbol: "SOL",
      apy: 4.28,
      apyBase: 4.28,
      tvlUsd: 31_000_000,
      poolMeta: null,
    },
    // Morpho Blue — top vaults above TVL floor (5M).
    {
      project: "morpho-blue",
      chain: "Ethereum",
      symbol: "STEAKUSDC",
      apy: 4.24,
      apyBase: 3.92,
      tvlUsd: 118_000_000,
      poolMeta: null,
    },
    {
      project: "morpho-blue",
      chain: "Base",
      symbol: "STEAKUSDC",
      apy: 4.07,
      apyBase: 4.07,
      tvlUsd: 471_000_000,
      poolMeta: null,
    },
    {
      project: "morpho-blue",
      chain: "Ethereum",
      symbol: "GTUSDC",
      apy: 4.18,
      apyBase: 3.86,
      tvlUsd: 160_000_000,
      poolMeta: null,
    },
    {
      project: "morpho-blue",
      chain: "Ethereum",
      symbol: "GTUSDCP",
      apy: 4.34,
      apyBase: 4.02,
      tvlUsd: 111_000_000,
      poolMeta: null,
    },
    // Below TVL floor — should NOT appear.
    {
      project: "morpho-blue",
      chain: "Ethereum",
      symbol: "AUSDC",
      apy: 5.1,
      apyBase: 5.1,
      tvlUsd: 100_000,
      poolMeta: null,
    },
    // APY=0 — should NOT appear.
    {
      project: "morpho-blue",
      chain: "Polygon",
      symbol: "USDC",
      apy: 0,
      apyBase: null,
      tvlUsd: 6_000_000,
      poolMeta: null,
    },
    // ETH-flavored vault — only emits for asset=ETH.
    {
      project: "morpho-blue",
      chain: "Ethereum",
      symbol: "GTWETH",
      apy: 2.1,
      apyBase: 2.1,
      tvlUsd: 50_000_000,
      poolMeta: null,
    },
    // Hyperliquid L1 isn't in our SupportedChain union — should be dropped.
    {
      project: "morpho-blue",
      chain: "Hyperliquid L1",
      symbol: "GTUSDC-HL",
      apy: 9.99,
      apyBase: 9.99,
      tvlUsd: 50_000_000,
      poolMeta: null,
    },
  ];
}

async function setup(opts: { fetchOk?: boolean; pools?: FixturePool[] } = {}) {
  vi.resetModules();
  const fetchOk = opts.fetchOk ?? true;
  const pools = opts.pools ?? fixture();
  vi.doMock("../src/data/http.js", () => ({
    fetchWithTimeout: vi.fn(async () => ({
      ok: fetchOk,
      json: async () => ({ data: pools }),
    })),
  }));
  // Cache wrap is bypassed so each test runs the real adapter logic.
  vi.doMock("../src/data/cache.js", () => ({
    cache: {
      remember: async (_k: string, _t: number, fn: () => Promise<unknown>) =>
        fn(),
      get: () => undefined,
      set: () => {},
    },
  }));
  return import("../src/modules/yields/adapters/defillama.js");
}

describe("readDefiLlamaYields — bundled adapter", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("emits Marinade + Jito + Kamino rows when asset=SOL and chain includes solana", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("SOL", ["solana"]);
    const protocols = rows.map((r) => r.protocol).sort();
    expect(protocols).toContain("marinade");
    expect(protocols).toContain("jito");
    expect(protocols).toContain("kamino");
  });

  it("Kamino emits multiple rows for USDC across markets, distinguished by poolMeta", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("USDC", ["solana"]);
    const kaminoRows = rows.filter((r) => r.protocol === "kamino");
    expect(kaminoRows.length).toBe(2);
    const markets = kaminoRows.map((r) => r.market).sort();
    expect(markets[0]).toMatch(/Kamino/);
    expect(markets.find((m) => /JLP/.test(m))).toBeTruthy();
  });

  it("Morpho emits top-N curated vaults per (asset, chain), filtered by TVL floor and APY>0", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("USDC", ["ethereum", "base", "polygon"]);
    const morpho = rows.filter((r) => r.protocol === "morpho-blue");
    // Ethereum: 3 vaults above floor (STEAKUSDC, GTUSDC, GTUSDCP). Base: 1.
    // Polygon: only an apy=0 row, dropped. AUSDC dropped (TVL 100k below 5M).
    const chains = morpho.map((r) => r.chain).sort();
    expect(chains).toEqual(["base", "ethereum", "ethereum", "ethereum"]);
    expect(morpho.every((r) => /Morpho/.test(r.market))).toBe(true);
  });

  it("Morpho ETH asset matches WETH-flavored vault names only", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("ETH", ["ethereum"]);
    const morpho = rows.filter((r) => r.protocol === "morpho-blue");
    expect(morpho.length).toBe(1);
    expect(morpho[0]?.market).toBe("Morpho · GTWETH");
  });

  it("respects requested chain filter — empty when chain not asked for", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows: solOnly } = await readDefiLlamaYields("USDC", ["solana"]);
    expect(solOnly.every((r) => r.chain === "solana")).toBe(true);
    expect(solOnly.find((r) => r.protocol === "morpho-blue")).toBeUndefined();
  });

  it("converts apy → fraction (DefiLlama publishes percentage)", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("SOL", ["solana"]);
    const marinade = rows.find((r) => r.protocol === "marinade");
    expect(marinade).toBeDefined();
    expect(marinade!.supplyApr).toBeCloseTo(0.0742, 4);
    expect(marinade!.supplyApy).toBeGreaterThan(marinade!.supplyApr!);
  });

  it("populates tvl when DefiLlama provides it", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("SOL", ["solana"]);
    const jito = rows.find((r) => r.protocol === "jito");
    expect(jito?.tvl).toBe(1_500_000_000);
  });

  it("returns unavailable rows when DefiLlama fetch fails (per requested chain)", async () => {
    const { readDefiLlamaYields } = await setup({ fetchOk: false });
    const { rows, unavailable } = await readDefiLlamaYields("USDC", [
      "solana",
      "ethereum",
    ]);
    expect(rows).toHaveLength(0);
    const unprotocols = new Set(unavailable.map((u) => u.protocol));
    expect(unprotocols.has("marinade")).toBe(true);
    expect(unprotocols.has("jito")).toBe(true);
    expect(unprotocols.has("kamino")).toBe(true);
    expect(unprotocols.has("morpho-blue")).toBe(true);
  });

  it("emits no Solana-only protocols when only EVM chains are requested", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("USDC", ["ethereum"]);
    expect(rows.find((r) => r.protocol === "marinade")).toBeUndefined();
    expect(rows.find((r) => r.protocol === "jito")).toBeUndefined();
    expect(rows.find((r) => r.protocol === "kamino")).toBeUndefined();
  });

  it("drops Morpho rows on chains outside our SupportedChain union (e.g. Hyperliquid L1)", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("USDC", [
      "ethereum",
      "base",
      "arbitrum",
      "polygon",
      "optimism",
    ]);
    expect(rows.find((r) => /HL/.test(r.market))).toBeUndefined();
  });

  it("emits no rows for asset=BTC (no DefiLlama-tracked protocol carries WBTC for our four)", async () => {
    const { readDefiLlamaYields } = await setup();
    const { rows } = await readDefiLlamaYields("BTC", ["ethereum", "solana"]);
    expect(rows).toHaveLength(0);
  });
});
