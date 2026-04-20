import { getClient } from "../../data/rpc.js";
import type { SupportedChain } from "../../types/index.js";
import type { SimulateTransactionArgs } from "./schemas.js";
import { enrichRevertReason, type DecodedRevert } from "./revert-decode.js";

export interface SimulationResult {
  chain: SupportedChain;
  ok: boolean;
  returnData?: `0x${string}`;
  /** Human-readable revert summary; populated when ok === false. */
  revertReason?: string;
  /**
   * Structured revert details (errorName, args, data, source). Populated when
   * ok === false and we managed to decode anything beyond a bare "execution reverted".
   * Callers that need more than the human string should prefer this.
   */
  revert?: DecodedRevert;
}

/**
 * Run an eth_call against the chain's RPC. Does NOT change state — this is the
 * same primitive wallets use for contract reads, extended here to catch reverts
 * that a blind signature would otherwise waste gas on. Used in two places:
 *   1. The standalone `simulate_transaction` MCP tool (agent-facing).
 *   2. `sendTransaction` just before forwarding to Ledger — a second-line
 *      safety net that refuses to sign a tx that will definitely revert.
 */
export async function simulateTx(args: {
  chain: SupportedChain;
  from?: `0x${string}`;
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: string;
}): Promise<SimulationResult> {
  const client = getClient(args.chain);
  try {
    const result = await client.call({
      // viem's `call` requires an `account` when we want to reflect msg.sender
      // state (balance, nonce). Falling back to a placeholder still catches most
      // reverts; the sign-time caller always passes `from`.
      account: args.from,
      to: args.to,
      data: args.data ?? "0x",
      value: args.value ? BigInt(args.value) : 0n,
    });
    return {
      chain: args.chain,
      ok: true,
      returnData: (result.data ?? "0x") as `0x${string}`,
    };
  } catch (err) {
    const revert = await enrichRevertReason(err);
    return {
      chain: args.chain,
      ok: false,
      revertReason: revert.message,
      revert,
    };
  }
}

export async function simulateTransaction(
  args: SimulateTransactionArgs
): Promise<SimulationResult> {
  return simulateTx({
    chain: args.chain as SupportedChain,
    from: args.from as `0x${string}` | undefined,
    to: args.to as `0x${string}`,
    data: args.data as `0x${string}` | undefined,
    value: args.value,
  });
}
