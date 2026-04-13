import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import type {
  GetBitcoinBalanceArgs,
  GetBitcoinPortfolioArgs,
} from "./schemas.js";

/**
 * Bitcoin mainnet portfolio reads.
 *
 * Data source: mempool.space REST API (no key required, no rate-limit issues for
 * occasional lookups). We only fetch the address-summary endpoint — no block or
 * tx history, since portfolio integration only needs the confirmed balance.
 *
 * Scope is intentionally read-only. Tx construction (UTXO selection, fee-rate,
 * PSBT assembly) and signing via WalletConnect `bip122:` are phase-2 work — a
 * separate module when we wire Ledger Live's Bitcoin app.
 *
 * Prices come from DefiLlama's `coingecko:bitcoin` key to stay consistent with
 * the EVM pricing path; cached for the same TTL as ERC-20 prices.
 */

const MEMPOOL_API = "https://mempool.space/api";
const SATS_PER_BTC = 100_000_000n;

interface MempoolAddressResponse {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

export interface BitcoinBalance {
  chain: "bitcoin";
  address: string;
  /** Confirmed balance in satoshis as a decimal string (JSON-safe). */
  amountSats: string;
  /** Unconfirmed (mempool-only) balance delta in satoshis. Can be negative for pending spends. */
  unconfirmedSats: string;
  /** Confirmed balance expressed in BTC (human-readable). */
  formattedBtc: string;
  symbol: "BTC";
  decimals: 8;
  priceUsd?: number;
  valueUsd?: number;
}

function satsToBtcString(sats: bigint): string {
  const whole = sats / SATS_PER_BTC;
  const frac = sats % SATS_PER_BTC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

async function fetchBitcoinPrice(): Promise<number | undefined> {
  const cacheKey = "price:coingecko:bitcoin";
  const hit = cache.get<number>(cacheKey);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(
      "https://coins.llama.fi/prices/current/coingecko:bitcoin"
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      coins: Record<string, { price?: number }>;
    };
    const price = body.coins["coingecko:bitcoin"]?.price;
    if (typeof price === "number") {
      cache.set(cacheKey, price, CACHE_TTL.PRICE);
      return price;
    }
  } catch {
    // Swallow — degrade to undefined USD so callers can still return sats.
  }
  return undefined;
}

async function fetchAddressSummary(address: string): Promise<MempoolAddressResponse> {
  const res = await fetch(`${MEMPOOL_API}/address/${encodeURIComponent(address)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`mempool.space ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as MempoolAddressResponse;
}

export async function getBitcoinBalance(
  args: GetBitcoinBalanceArgs
): Promise<BitcoinBalance> {
  const [summary, priceUsd] = await Promise.all([
    fetchAddressSummary(args.address),
    fetchBitcoinPrice(),
  ]);
  return toBalance(args.address, summary, priceUsd);
}

export interface BitcoinPortfolio {
  chain: "bitcoin";
  addresses: string[];
  balances: BitcoinBalance[];
  totalSats: string;
  totalBtc: string;
  totalUsd?: number;
  priceUsd?: number;
}

export async function getBitcoinPortfolio(
  args: GetBitcoinPortfolioArgs
): Promise<BitcoinPortfolio> {
  const priceUsd = await fetchBitcoinPrice();
  // Fetch each address in parallel; an individual failure shouldn't kill the whole report.
  const balances = await Promise.all(
    args.addresses.map(async (addr) => {
      try {
        const summary = await fetchAddressSummary(addr);
        return toBalance(addr, summary, priceUsd);
      } catch {
        return toBalance(addr, emptySummary(addr), priceUsd);
      }
    })
  );
  const totalSats = balances.reduce(
    (sum, b) => sum + BigInt(b.amountSats),
    0n
  );
  const totalBtc = satsToBtcString(totalSats);
  const totalUsd =
    priceUsd !== undefined
      ? Number(totalBtc) * priceUsd
      : undefined;
  return {
    chain: "bitcoin",
    addresses: args.addresses,
    balances,
    totalSats: totalSats.toString(),
    totalBtc,
    totalUsd,
    priceUsd,
  };
}

function toBalance(
  address: string,
  summary: MempoolAddressResponse,
  priceUsd: number | undefined
): BitcoinBalance {
  const confirmedSats =
    BigInt(summary.chain_stats.funded_txo_sum) -
    BigInt(summary.chain_stats.spent_txo_sum);
  const unconfirmedSats =
    BigInt(summary.mempool_stats.funded_txo_sum) -
    BigInt(summary.mempool_stats.spent_txo_sum);
  const formattedBtc = satsToBtcString(confirmedSats);
  const valueUsd =
    priceUsd !== undefined ? Number(formattedBtc) * priceUsd : undefined;
  return {
    chain: "bitcoin",
    address,
    amountSats: confirmedSats.toString(),
    unconfirmedSats: unconfirmedSats.toString(),
    formattedBtc,
    symbol: "BTC",
    decimals: 8,
    priceUsd,
    valueUsd,
  };
}

function emptySummary(address: string): MempoolAddressResponse {
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
