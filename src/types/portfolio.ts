import type { SupportedChain } from "./chains.js";

/**
 * Per-subsystem status reported alongside a portfolio summary, so callers can
 * distinguish "no Aave position" (covered:true, positions empty) from "Aave
 * fetch failed" (covered:false, errored:true) from "not attempted" (covered:
 * false, errored:false — e.g. Morpho Blue, which requires caller-supplied
 * market ids and so has no on-chain enumeration path from a wallet).
 */
export interface CoverageStatus {
  covered: boolean;
  errored?: boolean;
  /** Free-form message explaining why `covered` is false when it is. */
  note?: string;
}

export interface PortfolioCoverage {
  aave: CoverageStatus;
  compound: CoverageStatus;
  morpho: CoverageStatus;
  uniswapV3: CoverageStatus;
  staking: CoverageStatus;
  /**
   * TRON balance fetch coverage. `covered:false, errored:false` means no TRON
   * address was queried (treated like Morpho's "not attempted"); errored:true
   * means a TronGrid call failed and TRX/TRC-20 are missing from totals.
   */
  tron?: CoverageStatus;
  /**
   * TRON staking fetch coverage — independent of the balance fetch so a
   * getReward/account outage doesn't mask that balances loaded fine.
   */
  tronStaking?: CoverageStatus;
  /**
   * Solana balance fetch coverage (SOL + SPL). `covered:false, errored:false`
   * means no Solana address was queried; errored:true means the Solana RPC
   * call failed and SOL/SPL are missing from totals.
   */
  solana?: CoverageStatus;
  /**
   * MarginFi position fetch coverage. Tracked separately from `solana` so a
   * MarginFi-reader failure doesn't mask a successful balance read (mirror of
   * `tronStaking` / `tron` split). Absent when no Solana address was queried.
   */
  marginfi?: CoverageStatus;
  /**
   * Kamino position fetch coverage. Same separation rationale as `marginfi` —
   * a Kamino-reader failure shouldn't mask a successful balance read. Absent
   * when no Solana address was queried.
   */
  kamino?: CoverageStatus;
  /**
   * Solana staking position fetch coverage (Marinade mSOL, Jito jitoSOL,
   * native stake accounts). Mirrors the `marginfi` split so a staking-
   * reader failure doesn't mask a successful balance read. Absent when no
   * Solana address was queried.
   */
  solanaStaking?: CoverageStatus;
  /**
   * Bitcoin balance fetch coverage. `covered:false, errored:false` means
   * no Bitcoin address(es) were queried (treated like the TRON / Solana
   * "not attempted" semantics); errored:true means the indexer call
   * failed and BTC totals are missing.
   */
  bitcoin?: CoverageStatus;
  /**
   * Litecoin balance fetch coverage. Mirrors `bitcoin` — covered:false +
   * errored:false means no LTC address was queried; errored:true means
   * the indexer call failed and LTC totals are missing. Issue #274.
   */
  litecoin?: CoverageStatus;
  /** Number of token balances whose USD valuation could not be resolved. */
  unpricedAssets: number;
  /**
   * Structured list of which specific tokens couldn't be priced — one entry
   * per affected balance. Previously only `unpricedAssets: N` (a count) was
   * surfaced, which left the agent unable to tell the user WHICH balance
   * was dropped from USD totals. With this list the agent can produce a
   * concrete warning like "705 MATIC on polygon couldn't be priced and isn't
   * included in the total" instead of a bare integer. Absent when
   * `unpricedAssets === 0` to keep happy-path responses lean (issue #94).
   */
  unpricedAssetsDetail?: UnpricedAsset[];
}

/**
 * A single unpriced balance the portfolio couldn't value in USD. The chain
 * is a string union spanning EVM + TRON + Solana so one array describes the
 * cross-chain set without needing per-chain buckets.
 */
export interface UnpricedAsset {
  chain: SupportedChain | "tron" | "solana" | "bitcoin" | "litecoin";
  symbol: string;
  /** Human-readable balance (already-decimals-applied), e.g. "705.141". */
  amount: string;
}
