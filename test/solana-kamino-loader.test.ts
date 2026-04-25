import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Smoke test for the Kamino market loader. The interesting plumbing here:
 *   1. We construct a kit Rpc from `getSolanaRpcUrl()` (NOT the existing
 *      web3.js `Connection` — different runtime).
 *   2. We pass the kit Rpc + mainnet market address + slot duration to the
 *      SDK's `KaminoMarket.load`.
 * Both are mocked at module boundary; no live network. The point of this
 * test is to pin the loader's call-shape so a future SDK upgrade that
 * changes the load signature trips a clear failure.
 */

const createSolanaRpcMock = vi.fn();
const KaminoMarketLoadMock = vi.fn();

vi.mock("@solana/kit", () => ({
  createSolanaRpc: (...args: unknown[]) => createSolanaRpcMock(...args),
  // AccountRole + Address types aren't reached at runtime in this test,
  // but kit-bridge imports them; pass-through stub keeps tsc + vitest happy.
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
}));

vi.mock("@kamino-finance/klend-sdk", () => ({
  KaminoMarket: {
    load: (...args: unknown[]) => KaminoMarketLoadMock(...args),
  },
}));

const getSolanaRpcUrlMock = vi.fn();
vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => ({}),
  resetSolanaConnection: () => {},
  getSolanaRpcUrl: (...args: unknown[]) => getSolanaRpcUrlMock(...args),
}));

beforeEach(() => {
  createSolanaRpcMock.mockReset();
  KaminoMarketLoadMock.mockReset();
  getSolanaRpcUrlMock.mockReset();
  getSolanaRpcUrlMock.mockReturnValue("https://mainnet.helius-rpc.com/?api-key=test");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadKaminoMainMarket", () => {
  it("constructs a kit Rpc from getSolanaRpcUrl + calls KaminoMarket.load with the mainnet market + slot duration", async () => {
    const fakeRpc = { __isFakeKitRpc: true };
    createSolanaRpcMock.mockReturnValue(fakeRpc);
    const fakeMarket = { __isFakeMarket: true };
    KaminoMarketLoadMock.mockResolvedValue(fakeMarket);

    const { loadKaminoMainMarket, KAMINO_MAIN_MARKET, RECENT_SLOT_DURATION_MS } =
      await import("../src/modules/solana/kamino.js");

    const market = await loadKaminoMainMarket();

    expect(getSolanaRpcUrlMock).toHaveBeenCalledTimes(1);
    expect(createSolanaRpcMock).toHaveBeenCalledWith(
      "https://mainnet.helius-rpc.com/?api-key=test",
    );
    expect(KaminoMarketLoadMock).toHaveBeenCalledTimes(1);
    const [rpcArg, addrArg, slotDurArg] = KaminoMarketLoadMock.mock.calls[0];
    expect(rpcArg).toBe(fakeRpc);
    expect(addrArg).toBe(KAMINO_MAIN_MARKET);
    expect(slotDurArg).toBe(RECENT_SLOT_DURATION_MS);
    expect(market).toBe(fakeMarket);
  });

  it("returns null when the SDK reports no market account on-chain", async () => {
    createSolanaRpcMock.mockReturnValue({});
    KaminoMarketLoadMock.mockResolvedValue(null);

    const { loadKaminoMainMarket } = await import(
      "../src/modules/solana/kamino.js"
    );
    const market = await loadKaminoMainMarket();
    expect(market).toBeNull();
  });

  it("KAMINO_MAIN_MARKET pins the canonical mainnet address", async () => {
    const { KAMINO_MAIN_MARKET } = await import(
      "../src/modules/solana/kamino.js"
    );
    expect(KAMINO_MAIN_MARKET).toBe(
      "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
    );
  });
});
