import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

/**
 * `get_token_allowances` — list every spender that holds a non-zero
 * allowance over `wallet`'s `token` balance on a given EVM chain.
 *
 * v1 EVM-only (Ethereum / Arbitrum / Polygon / Base / Optimism). TRON's
 * TRC-20 has the same Approval-event shape but the indexer surface is
 * different (TronGrid `events` endpoint) and the allowance read path
 * differs — defer to v2.
 *
 * Solana intentionally NOT in scope. The SPL Token "delegate" pattern
 * is per-token-account rather than per-mint-per-owner, which doesn't
 * map onto this tool's question. Solana delegation surfacing belongs in
 * a dedicated `get_spl_delegations` tool.
 */
export const getTokenAllowancesInput = z.object({
  wallet: z
    .string()
    .regex(EVM_ADDRESS)
    .describe(
      "EVM wallet address whose approvals you want to enumerate. The tool " +
        "scans Approval events emitted by `token` where this wallet is the " +
        "indexed `owner`, then re-reads the LIVE allowance for each spender."
    ),
  token: z
    .string()
    .regex(EVM_ADDRESS)
    .describe(
      "ERC-20 contract address. Must be the actual token contract, not a " +
        "wrapper or aToken. Native coins (ETH / MATIC) have no allowance " +
        "concept and are intentionally not supported here."
    ),
  chain: chainEnum
    .default("ethereum")
    .describe(
      "Which EVM chain to scan. Defaults to Ethereum. The same wallet may " +
        "have different approvals on different chains — you'll need one call " +
        "per chain to enumerate all of them."
    ),
});

export type GetTokenAllowancesArgs = z.infer<typeof getTokenAllowancesInput>;

/**
 * One row per spender that currently holds a non-zero allowance.
 * Spenders whose live `allowance(owner, spender)` reads as 0 (revoked
 * or fully consumed) are dropped — there's no remaining attack surface
 * to surface.
 */
export interface AllowanceRow {
  spender: `0x${string}`;
  /**
   * Friendly label resolved from the canonical CONTRACTS table when
   * the spender matches a known protocol address (Aave V3 Pool, Uniswap
   * SwapRouter02, etc.). Absent for arbitrary contracts.
   */
  spenderLabel?: string;
  /** Raw integer current allowance as a decimal string (preserves bigint precision). */
  currentAllowance: string;
  /** Same value formatted with the token's decimals — human-readable. */
  currentAllowanceFormatted: string;
  /**
   * True when the allowance is at-or-near MAX_UINT256 (within 0.01%).
   * Many wallets / DEX UIs cap at MAX_UINT256 - 1 or MAX_UINT256 / 2
   * etc. — anything in that ballpark is effectively unlimited.
   */
  isUnlimited: boolean;
  /** Block number where the most recent Approval event for this (token, owner, spender) landed. */
  lastApprovedBlock: string;
  /** Tx hash of that Approval. */
  lastApprovedTxHash: `0x${string}`;
  /** ISO-8601 timestamp from the indexer's `timeStamp` field, when available. */
  lastApprovedAt?: string;
}

export interface GetTokenAllowancesResult {
  wallet: `0x${string}`;
  chain: string;
  token: {
    address: `0x${string}`;
    symbol: string;
    decimals: number;
    name?: string;
  };
  /** Sorted by `currentAllowance` descending (largest exposures first). */
  allowances: AllowanceRow[];
  /** Total approvals scanned (including ones since revoked). */
  totalScanned: number;
  /** Number of allowances at-or-near MAX_UINT256. */
  unlimitedCount: number;
  /** Indexer truncation flag — true if the response hit Etherscan's row cap. */
  truncated: boolean;
  notes: string[];
}
