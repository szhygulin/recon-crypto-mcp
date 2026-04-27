import { erc20Abi } from "../../abis/erc20.js";
import { getClient } from "../../data/rpc.js";
import { sanitizeContractName } from "../../data/apis/etherscan.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * Read an ERC-20's `decimals` and `symbol` in one multicall. Used by every
 * `prepare_*` handler that needs to convert a human amount → wei and stamp a
 * human-readable description. Kept in one place so the caching and error
 * semantics stay aligned across protocols.
 *
 * **Symbol is sanitized.** The token contract's owner controls what `symbol()`
 * returns — a malicious ERC-20 can return newlines + markdown + prompt-
 * injection prose. That string flows into UnsignedTx.description and into the
 * VERIFY-BEFORE-SIGNING block the agent renders for the user, so unsanitized
 * input is a narrow-injection surface. `sanitizeContractName` applies the
 * same strict allowlist we use for Etherscan-returned contract names
 * (alphanumeric + `._-`, capped at 64 chars). Rendering falls back to
 * `UNKNOWN` when nothing survives, which is both safe and actionable for the
 * user.
 */
export async function resolveTokenMeta(
  chain: SupportedChain,
  asset: `0x${string}`
): Promise<{ decimals: number; symbol: string }> {
  const client = getClient(chain);
  const [decimals, rawSymbol] = await client.multicall({
    contracts: [
      { address: asset, abi: erc20Abi, functionName: "decimals" },
      { address: asset, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });
  const symbol = sanitizeContractName(rawSymbol as string) ?? "UNKNOWN";
  return { decimals: Number(decimals), symbol };
}

/**
 * Batch variant of `resolveTokenMeta` — fetches `decimals` + `symbol` for
 * N tokens in a single multicall. LP pools involve 2-8 tokens (Uniswap V3
 * pairs, Curve pools up to 4 coins, Balancer composable-stable pools up
 * to 8); the per-token N round-trips this would otherwise require add up
 * fast. Returns one entry per input token in the same order. Symbol
 * sanitization carries the same threat model as the single-token reader:
 * a malicious ERC-20 owner can return prompt-injection prose from
 * `symbol()`, which flows into agent-rendered tx descriptions.
 *
 * Uses `allowFailure: false` because every LP encoder needs all the
 * decimals to convert human amounts → wei; one missing entry would
 * silently produce a wrong calldata. Callers who need a partial-failure
 * shape should layer it on top.
 */
export async function resolveTokenPairMeta(
  chain: SupportedChain,
  tokens: ReadonlyArray<`0x${string}`>
): Promise<Array<{ decimals: number; symbol: string }>> {
  if (tokens.length === 0) return [];
  const client = getClient(chain);
  const calls = tokens.flatMap((asset) => [
    { address: asset, abi: erc20Abi, functionName: "decimals" as const },
    { address: asset, abi: erc20Abi, functionName: "symbol" as const },
  ]);
  const results = await client.multicall({
    contracts: calls,
    allowFailure: false,
  });
  return tokens.map((_, i) => ({
    decimals: Number(results[i * 2]),
    symbol: sanitizeContractName(results[i * 2 + 1] as string) ?? "UNKNOWN",
  }));
}
