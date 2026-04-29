import type { Abi } from "viem";
import { getContractInfo } from "../data/apis/etherscan.js";
import type { SupportedChain } from "../types/index.js";

/**
 * Resolve the ABI for an EVM contract. Caller-supplied `abi` wins; otherwise
 * fetch via Etherscan V2 (`getsourcecode`, already wrapped + cached). Refuses
 * on unverified contracts, on parse failures, and on proxies whose
 * implementation ABI can't be reached — the caller can always pass `abi`
 * inline to bypass any of those refusals when they have a trusted ABI source.
 *
 * Why we never fall back to raw-bytecode encoding/decoding: the verified-ABI
 * gate is the agent-side anchor that the function selector + args/returndata
 * actually correspond to a real, source-published function rather than
 * arbitrary bytes the caller hopes will work.
 *
 * Shared by `prepare_custom_call` (write side) and `read_contract` (read side).
 */
export async function resolveContractAbi(
  contract: `0x${string}`,
  chain: SupportedChain,
): Promise<{ abi: Abi; isProxy: boolean; implementation?: `0x${string}` }> {
  const info = await getContractInfo(contract, chain);
  if (!info.isVerified) {
    throw new Error(
      `Contract ${contract} on ${chain} is not Etherscan-verified — refusing to use unverified bytecode. Pass the ABI inline via the \`abi\` arg if you have it from another trusted source (e.g. the project's published artifacts).`,
    );
  }
  if (info.isProxy && info.implementation) {
    const impl = await getContractInfo(info.implementation, chain);
    if (impl.isVerified && impl.abi && impl.abi.length > 0) {
      return {
        abi: impl.abi as Abi,
        isProxy: true,
        implementation: info.implementation,
      };
    }
    throw new Error(
      `Contract ${contract} on ${chain} is a proxy whose implementation ${info.implementation} couldn't be ABI-fetched (unverified or parse failure). Pass the ABI inline via the \`abi\` arg.`,
    );
  }
  if (!info.abi || info.abi.length === 0) {
    throw new Error(
      `Etherscan returned no parseable ABI for ${contract} on ${chain} (verified, but ABI was empty or invalid). Pass the ABI inline via the \`abi\` arg.`,
    );
  }
  return { abi: info.abi as Abi, isProxy: false };
}
