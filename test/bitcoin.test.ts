import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bitcoinAddressSchema,
  getBitcoinBalanceInput,
  getBitcoinPortfolioInput,
} from "../src/modules/bitcoin/schemas.js";

describe("Bitcoin address validation", () => {
  it("accepts legacy (P2PKH), P2SH, SegWit, and Taproot mainnet addresses", () => {
    const addrs = [
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // genesis
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // P2SH
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", // P2WPKH
      "bc1pxwww0ct9ue7e8tdnlmug5m2tamfn7q06sahstg39ys4c9f3340qqxrdu9k", // P2TR
    ];
    for (const a of addrs) {
      expect(() => bitcoinAddressSchema.parse(a)).not.toThrow();
    }
  });

  it("rejects Ethereum addresses, testnet addresses, and obvious garbage", () => {
    const bad = [
      "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", // testnet
      "bc1", // too short
      "",
      "not-an-address",
    ];
    for (const a of bad) {
      expect(() => bitcoinAddressSchema.parse(a)).toThrow();
    }
  });

  it("getBitcoinBalanceInput requires an address", () => {
    expect(() => getBitcoinBalanceInput.parse({})).toThrow();
  });

  it("getBitcoinPortfolioInput enforces non-empty addresses up to 20", () => {
    expect(() => getBitcoinPortfolioInput.parse({ addresses: [] })).toThrow();
    const twentyOne = new Array(21).fill("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(() =>
      getBitcoinPortfolioInput.parse({ addresses: twentyOne })
    ).toThrow();
    expect(() =>
      getBitcoinPortfolioInput.parse({
        addresses: ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"],
      })
    ).not.toThrow();
  });
});

describe("Bitcoin balance reader", () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear the in-memory price cache so stale entries don't leak across tests.
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives confirmed BTC balance from mempool.space chain_stats", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response(
          JSON.stringify({ coins: { "coingecko:bitcoin": { price: 80000 } } }),
          { status: 200 }
        );
      }
      if (url.includes("mempool.space/api/address")) {
        return new Response(
          JSON.stringify({
            address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            chain_stats: {
              funded_txo_count: 3,
              funded_txo_sum: 250_000_000, // 2.5 BTC funded
              spent_txo_count: 1,
              spent_txo_sum: 50_000_000, // 0.5 BTC spent → 2.0 BTC confirmed
              tx_count: 4,
            },
            mempool_stats: {
              funded_txo_count: 0,
              funded_txo_sum: 0,
              spent_txo_count: 0,
              spent_txo_sum: 0,
              tx_count: 0,
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinBalance } = await import("../src/modules/bitcoin/index.js");
    const balance = await getBitcoinBalance({
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });

    expect(balance.chain).toBe("bitcoin");
    expect(balance.amountSats).toBe("200000000"); // 2 BTC in sats
    expect(balance.formattedBtc).toBe("2");
    expect(balance.unconfirmedSats).toBe("0");
    expect(balance.priceUsd).toBe(80000);
    expect(balance.valueUsd).toBeCloseTo(2 * 80000, 2);
    expect(balance.symbol).toBe("BTC");
    expect(balance.decimals).toBe(8);
  });

  it("returns valueUsd=undefined when the price endpoint fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response("nope", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
          chain_stats: {
            funded_txo_count: 1,
            funded_txo_sum: 100_000_000,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 1,
          },
          mempool_stats: {
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
            tx_count: 0,
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinBalance } = await import("../src/modules/bitcoin/index.js");
    const balance = await getBitcoinBalance({
      address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    });
    expect(balance.formattedBtc).toBe("1");
    expect(balance.priceUsd).toBeUndefined();
    expect(balance.valueUsd).toBeUndefined();
  });

  it("throws a readable error when mempool.space returns a non-2xx", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response(
          JSON.stringify({ coins: { "coingecko:bitcoin": { price: 80000 } } }),
          { status: 200 }
        );
      }
      return new Response("Rate limited", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinBalance } = await import("../src/modules/bitcoin/index.js");
    await expect(
      getBitcoinBalance({ address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" })
    ).rejects.toThrow(/mempool\.space 429/);
  });
});

describe("Bitcoin portfolio aggregation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("sums balances across addresses and tolerates per-address failures", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response(
          JSON.stringify({ coins: { "coingecko:bitcoin": { price: 50000 } } }),
          { status: 200 }
        );
      }
      if (url.endsWith("/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")) {
        return new Response(
          JSON.stringify({
            address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            chain_stats: {
              funded_txo_count: 1,
              funded_txo_sum: 150_000_000, // 1.5 BTC
              spent_txo_count: 0,
              spent_txo_sum: 0,
              tx_count: 1,
            },
            mempool_stats: {
              funded_txo_count: 0,
              funded_txo_sum: 0,
              spent_txo_count: 0,
              spent_txo_sum: 0,
              tx_count: 0,
            },
          }),
          { status: 200 }
        );
      }
      // Second address fails — whole report must still succeed with a zero slice for it.
      return new Response("bad request", { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBitcoinPortfolio } = await import("../src/modules/bitcoin/index.js");
    const out = await getBitcoinPortfolio({
      addresses: [
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      ],
    });

    expect(out.balances).toHaveLength(2);
    expect(out.balances[0].amountSats).toBe("150000000");
    expect(out.balances[1].amountSats).toBe("0");
    expect(out.totalSats).toBe("150000000");
    expect(out.totalBtc).toBe("1.5");
    expect(out.totalUsd).toBeCloseTo(1.5 * 50000, 2);
  });
});

describe("Portfolio summary includes Bitcoin when bitcoinAddresses is supplied", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("adds bitcoinUsd to totalUsd and exposes a bitcoin slice", async () => {
    // Stub the bitcoin module directly rather than the fetch transport, so this test
    // doesn't also exercise the live mempool.space HTTP path (that's covered above).
    vi.doMock("../src/modules/bitcoin/index.js", () => ({
      getBitcoinPortfolio: async () => ({
        chain: "bitcoin",
        addresses: ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
        balances: [
          {
            chain: "bitcoin",
            address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            amountSats: "50000000",
            unconfirmedSats: "0",
            formattedBtc: "0.5",
            symbol: "BTC",
            decimals: 8,
            priceUsd: 90000,
            valueUsd: 45000,
          },
        ],
        totalSats: "50000000",
        totalBtc: "0.5",
        totalUsd: 45000,
        priceUsd: 90000,
      }),
      getBitcoinBalance: async () => {
        throw new Error("unused in this test");
      },
    }));

    // Zero out the EVM side — just verify the BTC integration arithmetic.
    const mockClient = {
      getBalance: vi.fn(async () => 0n),
      multicall: vi.fn(async () => []),
      readContract: vi.fn(async () => {
        throw new Error("unused");
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => 0,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/modules/positions/index.js", () => ({
      getLendingPositions: async () => ({ wallet: "0x0", positions: [] }),
      getLpPositions: async () => ({ wallet: "0x0", positions: [] }),
    }));
    vi.doMock("../src/modules/staking/index.js", () => ({
      getStakingPositions: async () => ({ wallet: "0x0", positions: [] }),
    }));
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: async () => ({ wallet: "0x0", positions: [] }),
    }));

    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    const summary = (await getPortfolioSummary({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
      bitcoinAddresses: ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>> & {
      bitcoinUsd: number;
      bitcoin?: { totalBtc: string; totalUsd: number };
    };

    expect(summary.bitcoinUsd).toBe(45000);
    expect(summary.totalUsd).toBe(45000); // EVM=0, BTC=45000
    expect(summary.bitcoin).toBeDefined();
    expect(summary.bitcoin!.totalBtc).toBe("0.5");
    expect(summary.bitcoin!.totalUsd).toBe(45000);
  });

  it("supports bitcoin-only portfolio (no EVM wallet provided)", async () => {
    vi.doMock("../src/modules/bitcoin/index.js", () => ({
      getBitcoinPortfolio: async () => ({
        chain: "bitcoin",
        addresses: ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"],
        balances: [
          {
            chain: "bitcoin",
            address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            amountSats: "100000000",
            unconfirmedSats: "0",
            formattedBtc: "1",
            symbol: "BTC",
            decimals: 8,
            priceUsd: 90000,
            valueUsd: 90000,
          },
        ],
        totalSats: "100000000",
        totalBtc: "1",
        totalUsd: 90000,
        priceUsd: 90000,
      }),
      getBitcoinBalance: async () => {
        throw new Error("unused");
      },
    }));

    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    const summary = (await getPortfolioSummary({
      bitcoinAddresses: ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>> & {
      bitcoinUsd: number;
      bitcoin?: { totalUsd: number };
    };

    expect(summary.totalUsd).toBe(90000);
    expect(summary.bitcoinUsd).toBe(90000);
    expect(summary.walletBalancesUsd).toBe(0);
    expect(summary.bitcoin!.totalUsd).toBe(90000);
  });

  it("rejects a request with neither wallet, wallets, nor bitcoinAddresses", async () => {
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.js"
    );
    await expect(getPortfolioSummary({})).rejects.toThrow(
      /wallet.*wallets.*bitcoinAddresses/i
    );
  });
});
