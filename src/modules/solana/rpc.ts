import { Connection } from "@solana/web3.js";
import { resolveSolanaRpcUrl } from "../../config/chains.js";
import { readUserConfig } from "../../config/user-config.js";

/**
 * Cached `Connection` for Solana mainnet. Lazy-initialized on first use.
 * Mirrors the EVM `getClient(chain)` pattern in src/data/rpc.ts — one client
 * per process, reused across calls. Reset on config change (future hook
 * alongside the EVM `resetClients` listener).
 */
let cachedConnection: Connection | undefined;

export function getSolanaConnection(): Connection {
  if (cachedConnection) return cachedConnection;
  const url = resolveSolanaRpcUrl(readUserConfig());
  // `confirmed` is the sweet spot for read-only portfolio/history queries —
  // `processed` is racy (may return state rolled back a slot later) and
  // `finalized` adds ~13s of latency for no meaningful safety win on reads.
  cachedConnection = new Connection(url, "confirmed");
  return cachedConnection;
}

/** Test-only: drop the cached connection so a mocked `@solana/web3.js` is picked up on next call. */
export function resetSolanaConnection(): void {
  cachedConnection = undefined;
}

/**
 * Resolve the mainnet RPC URL string. Same source-of-truth as
 * `getSolanaConnection`, but exposes the URL to callers that need to
 * construct a non-web3.js RPC client (e.g. `@solana/kit`'s `createSolanaRpc`
 * for the Kamino SDK).
 */
export function getSolanaRpcUrl(): string {
  return resolveSolanaRpcUrl(readUserConfig());
}
