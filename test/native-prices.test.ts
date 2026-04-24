/**
 * Issue #94: Polygon native was renamed MATIC → POL in Sept 2024. CoinGecko
 * renamed the coin `matic-network` → `polygon-ecosystem-token`; DefiLlama's
 * coins endpoint started returning `{"coins":{}}` for the old key. The
 * portfolio summary's native-balance USD valuation silently dropped to
 * `priceMissing: true` for polygon, excluding the balance from totals.
 *
 * This test pins the key DefiLlama expects today. We don't hit the network
 * — a live-network test would be flaky against external infra — instead we
 * mock the fetch and assert the queryToLlamaKey path emits the current key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("native-token price lookup (#94)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("queries DefiLlama with `coingecko:polygon-ecosystem-token` for polygon native, NOT the deprecated `matic-network` key", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // `getTokenPrices` runs the key list through `encodeURIComponent`,
      // so `:` becomes `%3A` in the URL. Decode before substring-matching.
      const decoded = decodeURIComponent(url);
      if (decoded.includes("coingecko:polygon-ecosystem-token")) {
        return new Response(
          JSON.stringify({
            coins: {
              "coingecko:polygon-ecosystem-token": {
                price: 0.094,
                symbol: "POL",
                timestamp: Date.now() / 1000,
              },
            },
          }),
        );
      }
      if (decoded.includes("coingecko:matic-network")) {
        // Old key — DefiLlama started returning empty after the rebrand.
        return new Response(JSON.stringify({ coins: {} }));
      }
      return new Response(JSON.stringify({ coins: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTokenPrice } = await import("../src/data/prices.js");
    const price = await getTokenPrice("polygon", "native");
    expect(price).toBeCloseTo(0.094);

    // Also verify the URL we actually hit — catches a regression where the
    // key is right but some other rewrite strips the coingecko prefix.
    const urlsCalled = fetchMock.mock.calls.map(
      ([u]) => decodeURIComponent(u as string),
    );
    expect(
      urlsCalled.some((u) => u.includes("coingecko:polygon-ecosystem-token")),
    ).toBe(true);
    // Regression guard: the old key must not be what we send anymore.
    expect(urlsCalled.some((u) => u.includes("coingecko:matic-network"))).toBe(
      false,
    );
  });
});
