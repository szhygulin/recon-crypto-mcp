/**
 * Unit tests for the MarginFi on-chain yields adapter (issue #288).
 *
 * The adapter at `src/modules/yields/adapters/marginfi.ts` reads bank
 * state via the existing hardened MarginFi client + `bank.computeInterestRates()`
 * + `bank.computeTvl(oraclePrice)`. We stub the client behind the
 * `getHardenedMarginfiClient` boundary so we can assert per-bank
 * behavior without standing up live RPC.
 *
 * Per `feedback_guard_tests_exercise_real_shape` memory, the regression
 * test must use the same shape the adapter call site sees. The fake
 * client below mirrors the `MinimalClientForYields` interface in the
 * adapter, including `getBankByMint` returning a `Bank`-shaped object
 * with `computeInterestRates()` + `computeTvl(...)`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { SOLANA_TOKENS, WSOL_MINT } from "../src/config/solana.js";

interface FakeBank {
  address: PublicKey;
  mint: PublicKey;
  config: { operationalState: string };
  computeInterestRates(): { lendingRate: BigNumber; borrowingRate: BigNumber };
  computeTvl(price: unknown): BigNumber;
}

function makeFakeBank(opts: {
  mint: string;
  lendingRate: number;
  borrowingRate?: number;
  tvl?: number;
  operationalState?: string;
  computeInterestRatesThrows?: boolean;
}): FakeBank {
  const addr = PublicKey.unique();
  return {
    address: addr,
    mint: new PublicKey(opts.mint),
    config: { operationalState: opts.operationalState ?? "Operational" },
    computeInterestRates() {
      if (opts.computeInterestRatesThrows) throw new Error("bank decode failed");
      return {
        lendingRate: new BigNumber(opts.lendingRate),
        borrowingRate: new BigNumber(opts.borrowingRate ?? opts.lendingRate * 1.5),
      };
    },
    computeTvl(_price: unknown) {
      return new BigNumber(opts.tvl ?? 0);
    },
  };
}

async function setup(opts: {
  banks?: Record<string, FakeBank>;
  clientLoadThrows?: boolean;
} = {}) {
  vi.resetModules();
  const banksByMint = opts.banks ?? {};
  vi.doMock("../src/modules/solana/marginfi.js", () => ({
    getHardenedMarginfiClient: vi.fn(async () => {
      if (opts.clientLoadThrows) throw new Error("rpc unreachable");
      return {
        banks: new Map<string, FakeBank>(),
        getBankByMint(mint: PublicKey) {
          return banksByMint[mint.toBase58()] ?? null;
        },
        getOraclePriceByBank(_addr: PublicKey) {
          // Non-null sentinel — the adapter only checks truthiness
          // before calling computeTvl.
          return { ok: true };
        },
      };
    }),
  }));
  vi.doMock("../src/modules/solana/rpc.js", () => ({
    getSolanaConnection: vi.fn(() => ({}) as never),
  }));
  return import("../src/modules/yields/adapters/marginfi.js");
}

describe("readMarginfiYields", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("emits a USDC row when MarginFi has a USDC bank live", async () => {
    const { readMarginfiYields } = await setup({
      banks: {
        [SOLANA_TOKENS.USDC]: makeFakeBank({
          mint: SOLANA_TOKENS.USDC,
          lendingRate: 0.0418,
          tvl: 12_500_000,
        }),
      },
    });
    const { rows } = await readMarginfiYields("USDC", ["solana"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.protocol).toBe("marginfi");
    expect(rows[0]?.chain).toBe("solana");
    expect(rows[0]?.market).toBe("MarginFi · USDC");
    expect(rows[0]?.supplyApr).toBeCloseTo(0.0418, 4);
    expect(rows[0]?.tvl).toBe(12_500_000);
  });

  it("emits a SOL row using the WSOL mint", async () => {
    const { readMarginfiYields } = await setup({
      banks: {
        [WSOL_MINT]: makeFakeBank({
          mint: WSOL_MINT,
          lendingRate: 0.038,
          tvl: 50_000_000,
        }),
      },
    });
    const { rows } = await readMarginfiYields("SOL", ["solana"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.market).toBe("MarginFi · SOL");
  });

  it("emits no rows when chain set excludes solana", async () => {
    const { readMarginfiYields } = await setup({
      banks: {
        [SOLANA_TOKENS.USDC]: makeFakeBank({
          mint: SOLANA_TOKENS.USDC,
          lendingRate: 0.05,
          tvl: 1_000_000,
        }),
      },
    });
    const { rows, unavailable } = await readMarginfiYields("USDC", [
      "ethereum",
      "base",
    ]);
    expect(rows).toHaveLength(0);
    expect(unavailable).toHaveLength(0);
  });

  it("surfaces unavailable when bank is absent (delisted or hardened-decode skipped)", async () => {
    const { readMarginfiYields } = await setup({ banks: {} });
    const { rows, unavailable } = await readMarginfiYields("USDC", ["solana"]);
    expect(rows).toHaveLength(0);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.protocol).toBe("marginfi");
    expect(unavailable[0]?.reason).toMatch(/de-listed|hardened-decode/);
  });

  it("surfaces unavailable when client load throws", async () => {
    const { readMarginfiYields } = await setup({ clientLoadThrows: true });
    const { rows, unavailable } = await readMarginfiYields("USDC", ["solana"]);
    expect(rows).toHaveLength(0);
    expect(unavailable[0]?.reason).toContain("client load failed");
  });

  it("annotates Paused banks with a supply-blocked note", async () => {
    const { readMarginfiYields } = await setup({
      banks: {
        [SOLANA_TOKENS.USDT]: makeFakeBank({
          mint: SOLANA_TOKENS.USDT,
          lendingRate: 0.04,
          tvl: 1_000_000,
          operationalState: "Paused",
        }),
      },
    });
    const { rows } = await readMarginfiYields("USDT", ["solana"]);
    expect(rows[0]?.notes?.[0]).toMatch(/Paused/);
  });

  it("annotates ReduceOnly banks with a no-new-supplies note", async () => {
    const { readMarginfiYields } = await setup({
      banks: {
        [SOLANA_TOKENS.USDC]: makeFakeBank({
          mint: SOLANA_TOKENS.USDC,
          lendingRate: 0.04,
          tvl: 1_000_000,
          operationalState: "ReduceOnly",
        }),
      },
    });
    const { rows } = await readMarginfiYields("USDC", ["solana"]);
    expect(rows[0]?.notes?.[0]).toMatch(/ReduceOnly/);
  });

  it("emits the row with null APR when computeInterestRates throws", async () => {
    const { readMarginfiYields } = await setup({
      banks: {
        [SOLANA_TOKENS.USDC]: makeFakeBank({
          mint: SOLANA_TOKENS.USDC,
          lendingRate: 0,
          tvl: 1_000_000,
          computeInterestRatesThrows: true,
        }),
      },
    });
    const { rows } = await readMarginfiYields("USDC", ["solana"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supplyApr).toBeNull();
    expect(rows[0]?.supplyApy).toBeNull();
  });

  it("emits no rows for non-supported assets (ETH, BTC)", async () => {
    const { readMarginfiYields } = await setup({});
    const eth = await readMarginfiYields("ETH", ["solana"]);
    const btc = await readMarginfiYields("BTC", ["solana"]);
    expect(eth.rows).toHaveLength(0);
    expect(eth.unavailable).toHaveLength(0);
    expect(btc.rows).toHaveLength(0);
    expect(btc.unavailable).toHaveLength(0);
  });
});
