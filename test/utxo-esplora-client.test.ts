import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import {
  setConfigDirForTesting,
  writeUserConfig,
} from "../src/config/user-config.js";
import type { UserConfig } from "../src/types/index.js";
import {
  getEsploraClient,
  resetEsploraClient,
} from "../src/modules/utxo/esplora-client.js";
import type { EsploraChain } from "../src/modules/utxo/esplora-client.js";

/**
 * Pin test for the new parametrized Esplora client (issue #716 split
 * plan, PR 3/N). Table-driven over both chains.
 *
 * Everything here is currently UNPINNED: LTC has no dedicated indexer
 * test file mirroring `btc-pr1.test.ts` / `btc-indexer-retry.test.ts`'s
 * URL-resolution and retry coverage, and the chain-specific error label
 * is unpinned for both chains everywhere. Exercises ONLY the new
 * `esplora-client.ts` module — `btc/indexer.ts` and `litecoin/indexer.ts`
 * are untouched in this leg, so nothing here can affect their suites.
 *
 * The literal expectations below (error-label prefix, env var, config
 * field, default URL) are transcribed independently from the two
 * existing indexer files rather than re-read off the module's own
 * `ESPLORA_CHAIN_PROFILES` — the point of the pin is to catch a
 * regression in that table, not restate it.
 */

interface ChainCase {
  chain: EsploraChain;
  errorLabel: string;
  envVar: string;
  configField: "bitcoinIndexerUrl" | "litecoinIndexerUrl";
  defaultUrl: string;
}

const CASES: ChainCase[] = [
  {
    chain: "btc",
    errorLabel: "Bitcoin indexer",
    envVar: "BITCOIN_INDEXER_URL",
    configField: "bitcoinIndexerUrl",
    defaultUrl: "https://mempool.space/api",
  },
  {
    chain: "ltc",
    errorLabel: "Litecoin indexer",
    envVar: "LITECOIN_INDEXER_URL",
    configField: "litecoinIndexerUrl",
    defaultUrl: "https://litecoinspace.org/api",
  },
];

const ADDR = "test-address";

function emptyStats(address: string) {
  return {
    address,
    chain_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
    mempool_stats: {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    },
  };
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-esplora-test-"));
  setConfigDirForTesting(pjoin(tmpHome, ".vaultpilot-mcp"));
  for (const c of CASES) resetEsploraClient(c.chain);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const c of CASES) {
    resetEsploraClient(c.chain);
    delete process.env[c.envVar];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe.each(CASES)("esplora client — $chain", (c) => {
  describe("chain-specific error label", () => {
    it("prefixes a generic getJson failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })),
      );
      await expect(getEsploraClient(c.chain).getBalance(ADDR)).rejects.toThrow(
        new RegExp(`^${c.errorLabel} /address/${ADDR} returned 500`),
      );
    });

    it("prefixes a broadcastTx failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("rejected", { status: 400, statusText: "Bad Request" })),
      );
      await expect(getEsploraClient(c.chain).broadcastTx("deadbeef")).rejects.toThrow(
        new RegExp(`^${c.errorLabel} /tx broadcast returned 400`),
      );
    });

    it("prefixes a getTxHex failure", async () => {
      const txid = "aa".repeat(32);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })),
      );
      await expect(getEsploraClient(c.chain).getTxHex(txid)).rejects.toThrow(
        new RegExp(`^${c.errorLabel} /tx/${txid}/hex returned 404`),
      );
    });

    it("prefixes a getBlockTip tip-hash failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("down", { status: 503, statusText: "Service Unavailable" })),
      );
      await expect(getEsploraClient(c.chain).getBlockTip()).rejects.toThrow(
        new RegExp(`^${c.errorLabel} /blocks/tip/hash returned 503`),
      );
    });
  });

  describe("URL resolution", () => {
    it("falls back to the chain default when nothing is configured", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(url.startsWith(`${c.defaultUrl}/`)).toBe(true);
        return new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await getEsploraClient(c.chain).getBalance(ADDR);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("prefers the env var over the config field and default", async () => {
      process.env[c.envVar] = "https://env.example/api";
      writeUserConfig({ [c.configField]: "https://config.example/api" } as UserConfig);
      const fetchMock = vi.fn(async (url: string) => {
        expect(url.startsWith("https://env.example/api/")).toBe(true);
        return new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await getEsploraClient(c.chain).getBalance(ADDR);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("falls back to the config field when the env var is unset", async () => {
      writeUserConfig({ [c.configField]: "https://config.example/api" } as UserConfig);
      const fetchMock = vi.fn(async (url: string) => {
        expect(url.startsWith("https://config.example/api/")).toBe(true);
        return new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await getEsploraClient(c.chain).getBalance(ADDR);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("treats a whitespace-only env var as unset (falls through to default)", async () => {
      process.env[c.envVar] = "   ";
      const fetchMock = vi.fn(async (url: string) => {
        expect(url.startsWith(`${c.defaultUrl}/`)).toBe(true);
        return new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await getEsploraClient(c.chain).getBalance(ADDR);
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("retry shape (issue #199)", () => {
    it("retries once on 429, only after the documented base delay elapses", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const promise = getEsploraClient(c.chain).getBalance(ADDR);
      // ESPLORA_RETRY_BASE_MS is 400 — the retry must not have fired yet.
      await vi.advanceTimersByTimeAsync(399);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toMatchObject({ txCount: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honors Retry-After (seconds → ms), capped at 5000ms", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("rate limited", { status: 429, headers: { "Retry-After": "10" } }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const promise = getEsploraClient(c.chain).getBalance(ADDR);
      // ESPLORA_MAX_RETRY_AFTER_MS caps the 10s header down to 5000ms.
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      await expect(promise).resolves.toMatchObject({ txCount: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries once on a network error, only after the documented base delay elapses", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(new Response(JSON.stringify(emptyStats(ADDR)), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const promise = getEsploraClient(c.chain).getBalance(ADDR);
      await vi.advanceTimersByTimeAsync(399);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toMatchObject({ txCount: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on a 4xx other than 429", async () => {
      const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(getEsploraClient(c.chain).getBalance(ADDR)).rejects.toThrow(/returned 400/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 5xx", async () => {
      const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(getEsploraClient(c.chain).getBalance(ADDR)).rejects.toThrow(/returned 503/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fee-estimate fallback constants", () => {
    it("falls back to the documented per-target-map defaults, verbatim", async () => {
      let call = 0;
      const fetchMock = vi.fn(async () => {
        call++;
        if (call === 1) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({}), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const fees = await getEsploraClient(c.chain).getFeeEstimates();
      expect(fees).toEqual({
        fastestFee: 20,
        halfHourFee: 10,
        hourFee: 5,
        economyFee: 2,
        minimumFee: 1,
      });
    });
  });
});

describe("getTx — BTC-only surface (RBF fee-bump builder dependency)", () => {
  it("exists on the BTC client, statically and at runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ txid: "aa".repeat(32), vin: [], vout: [] }), {
            status: 200,
          }),
      ),
    );
    const btc = getEsploraClient("btc");
    expect(typeof btc.getTx).toBe("function");
    const tx = await btc.getTx("aa".repeat(32));
    expect(tx.txid).toBe("aa".repeat(32));
  });

  it("does not exist on the LTC client, statically or at runtime", () => {
    const ltc = getEsploraClient("ltc");
    // @ts-expect-error — getTx is BTC-only; must not type-check on the LTC client.
    expect(ltc.getTx).toBeUndefined();
  });
});
