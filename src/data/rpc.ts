import { createPublicClient, http, type PublicClient } from "viem";
import { resolveRpcUrl, VIEM_CHAINS } from "../config/chains.js";
import { readUserConfig, onRpcConfigChange } from "../config/user-config.js";
import { CHAIN_IDS, type SupportedChain } from "../types/index.js";

const clients = new Map<SupportedChain, PublicClient>();
const verifiedChains = new Set<SupportedChain>();

// Invalidate cached clients + the verified-chains memo whenever the user
// rewrites their rpc config, so the next call re-resolves URLs and re-runs
// chain-id verification. `onRpcConfigChange` accepts a single hook; rpc.ts
// owns it because it owns the cache.
onRpcConfigChange(() => {
  clients.clear();
  verifiedChains.clear();
});

/**
 * Get (or lazily create) a viem PublicClient for the given chain.
 * Throws RpcConfigError if the chain has no RPC configured.
 */
export function getClient(chain: SupportedChain): PublicClient {
  const cached = clients.get(chain);
  if (cached) return cached;

  const userConfig = readUserConfig();
  const url = resolveRpcUrl(chain, userConfig);
  // Do NOT set `batch: true` by default. JSON-RPC batching works on Infura/Alchemy but is
  // silently mis-handled by many public endpoints — we saw calls like getUserAccountData,
  // NPM.balanceOf, Multicall3.aggregate3 return 0x under load, purely because they were
  // coalesced into a batched POST the provider couldn't fulfill. Individual eth_call
  // requests are slower but never ghost-fail. Users on premium endpoints can opt back in
  // via RPC_BATCH=1. Multicall3 still batches at the contract layer regardless.
  const batchEnabled = process.env.RPC_BATCH === "1";
  // retryCount/retryDelay: viem's http transport retries on 429 (and other
  // transient 4xx/5xx) by default using exponential backoff with
  // `retryDelay * 2^attempt` per retry. The previous `3 / 500ms` setting
  // gave a worst-case of ~3.5s (500, 1000, 2000) which wasn't enough to
  // ride out sustained Infura rate-limit windows — issue #88 trace showed
  // Morpho + Lido + cross-chain Compound all collateral-damaged during
  // portfolio fan-outs. Bumping to `5 / 600ms` gives 600/1200/2400/4800/
  // 9600ms (~18.6s worst-case) which covers most free-tier burst windows
  // without blocking user-visible calls absurdly long. 429-aware retry is
  // universal here (applies to every chain + tool), complementing the
  // per-tool caching (e.g. Morpho discovery) that cuts the pressure at
  // its source.
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: http(url, {
      batch: batchEnabled,
      retryCount: 5,
      retryDelay: 600,
    }),
  });
  clients.set(chain, client);
  return client;
}

/**
 * Verify the RPC endpoint actually speaks the chain we think it does. A wrong-
 * chain RPC would happily sign "ETH" txs against (say) a fork or BSC — values
 * and addresses overlap but token semantics don't, and the user would end up
 * sending real ETH against what they thought was a testnet. We do this on the
 * first live call per chain, memoize it, and throw loud if it mismatches.
 */
export async function verifyChainId(chain: SupportedChain): Promise<void> {
  if (verifiedChains.has(chain)) return;
  const client = getClient(chain);
  const actual = await client.getChainId();
  const expected = CHAIN_IDS[chain];
  if (actual !== expected) {
    throw new Error(
      `RPC for ${chain} returned chainId ${actual}, expected ${expected}. ` +
        `The configured endpoint does NOT point at ${chain} — refusing to proceed. ` +
        `Fix via \`vaultpilot-mcp-setup\` or the relevant env var.`
    );
  }
  verifiedChains.add(chain);
}

/** Invalidate the cached clients — useful after the user re-runs setup. */
export function resetClients(): void {
  clients.clear();
  verifiedChains.clear();
}
