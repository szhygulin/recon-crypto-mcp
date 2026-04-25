import { createSolanaRpc, type Address } from "@solana/kit";
import { getSolanaRpcUrl } from "./rpc.js";
import type { KaminoMarket } from "@kamino-finance/klend-sdk";

/**
 * Kamino lending — read-only foundation. PR1 of the Kamino sequence: type
 * bridge + market loader. Subsequent PRs (PR2: prepare_kamino_init_user +
 * prepare_kamino_supply; PR3: borrow / withdraw / repay + position reader;
 * PR4: portfolio integration) consume this module.
 *
 * Why a separate `Rpc<KaminoMarketRpcApi>` (kit-shaped) alongside our
 * existing web3.js v1 `Connection`: the Kamino SDK is built on `@solana/kit`
 * v2 and its `KaminoMarket.load` requires a kit-shaped RPC client. Both can
 * target the same Helius URL — kit's `createSolanaRpc` is a thin JSON-RPC
 * shim that doesn't share state with web3.js's `Connection`. ~no overhead.
 */

/**
 * Kamino main market on Solana mainnet — single market for the bulk of TVL
 * (USDC / USDT / SOL / mSOL / jitoSOL / JUP / wBTC / etc.). Other Kamino
 * markets (JLP, Altcoins, etc.) exist but aren't shipped in PR1; adding
 * them is a `loadKaminoMarket(addr)` extension when needed.
 *
 * Authoritative address per Kamino docs / explorer.
 */
export const KAMINO_MAIN_MARKET =
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF" as Address;

/**
 * Mainnet recent slot duration (ms) the SDK uses for interest accrual + price-
 * staleness checks. ~410ms is the live value as of 2026-04 (Solana block time
 * has been trending below 500ms since Agave 1.18). Stable enough that
 * hardcoding the canonical value beats fetching it on every market load —
 * this also matches the SDK's own example code, which hardcodes the same
 * value.
 */
export const RECENT_SLOT_DURATION_MS = 410;

/**
 * Construct a kit-style Solana RPC client targeting our usual mainnet URL.
 * Lazily imports kit so the cold-start cost is paid only by paths that
 * actually consume the Kamino SDK.
 */
export function createKaminoRpc() {
  const url = getSolanaRpcUrl();
  return createSolanaRpc(url);
}

/**
 * Load Kamino's main market with full reserve state (one fetch for the
 * `LendingMarket` account, then `getReservesForMarket` enumerates every
 * reserve under the market via `getProgramAccounts`).
 *
 * Returns null when the market account isn't found on-chain — extremely
 * unlikely on mainnet (the main market has been live since 2023), but the
 * SDK's contract is `Promise<KaminoMarket | null>` and we surface it
 * faithfully.
 *
 * Pure read path: no signer needed, no tx building. PR2/3 callers pass the
 * returned `KaminoMarket` to `KaminoAction.buildXxxTxns`.
 */
export async function loadKaminoMainMarket(): Promise<KaminoMarket | null> {
  const { KaminoMarket } = await import("@kamino-finance/klend-sdk");
  const rpc = createKaminoRpc();
  return KaminoMarket.load(rpc, KAMINO_MAIN_MARKET, RECENT_SLOT_DURATION_MS);
}
