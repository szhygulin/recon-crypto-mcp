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

/**
 * Solana balance shape — a parallel to TronBalance for SOL + SPL tokens.
 * `token` is a base58 SPL mint address (~32-44 chars), or "native" for SOL.
 * SPL balances come from Associated Token Accounts but we surface them by
 * mint; the ATA is an implementation detail the caller shouldn't care about.
 */
export interface SolanaBalance {
  chain: "solana";
  /** Base58 SPL mint address, or "native" for SOL. */
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  priceMissing?: boolean;
}

/**
 * Solana slice of a portfolio summary. Parallel to TronPortfolioSlice.
 * Phase 1 did not enumerate native validator staking; Phase 3 adds
 * MarginFi lending.
 */
export interface SolanaPortfolioSlice {
  /** Base58 Solana address the balances were resolved for. */
  address: string;
  native: SolanaBalance[];
  spl: SolanaBalance[];
  walletBalancesUsd: number;
  /**
   * MarginFi lending positions (Phase 3). Present only when the wallet has
   * at least one MarginfiAccount with non-zero balances — probed via the
   * deterministic PDA at accountIndex 0..3. An empty/missing field means
   * no MarginFi position, not "reader errored" (errored case is surfaced
   * through PortfolioCoverage.marginfi).
   */
  marginfi?: SolanaMarginfiPositionSlice[];
  /** MarginFi aggregate net USD (sum of netValueUsd across positions). */
  marginfiNetUsd?: number;
  /**
   * Kamino lending positions on the main market. Present when the wallet
   * has Kamino userMetadata + obligation with non-zero deposits or borrows.
   * Empty/missing means no position; errored case surfaces through
   * PortfolioCoverage.kamino.
   */
  kamino?: SolanaKaminoPositionSlice[];
  /** Kamino aggregate net USD (sum of netValueUsd across positions). */
  kaminoNetUsd?: number;
  /**
   * Solana staking positions — Marinade mSOL, Jito jitoSOL, native stake
   * accounts. Present when any of the three sections is non-empty for
   * this wallet. Missing means nothing found (errored case surfaces
   * through PortfolioCoverage.solanaStaking).
   */
  staking?: SolanaStakingPositionSlice;
  /** Solana staking aggregate net USD (SOL-equivalent × SOL price). */
  stakingNetUsd?: number;
}

/**
 * Thin projection of the three staking readers' output
 * (`src/modules/positions/solana-staking.ts`). Kept in sync with
 * `SolanaStakingPositions` but stripped down — the portfolio JSON doesn't
 * need the per-reader wrapper metadata (wallet duplication, protocol
 * tags on subtotals).
 */
export interface SolanaStakingPositionSlice {
  chain: "solana";
  /** mSOL balance + SOL-equivalent via Marinade's on-chain mSolPrice. */
  marinade: {
    mSolBalance: number;
    solEquivalent: number;
    exchangeRate: number;
  };
  /** jitoSOL balance + SOL-equivalent via stake-pool's totalLamports/supply. */
  jito: {
    jitoSolBalance: number;
    solEquivalent: number;
    exchangeRate: number;
  };
  /** One entry per native stake account (SPL stake-program) with activation status. */
  nativeStakes: Array<{
    stakePubkey: string;
    validator?: string;
    stakeSol: number;
    status: "activating" | "active" | "deactivating" | "inactive";
    activationEpoch?: number;
    deactivationEpoch?: number;
  }>;
  /** Sum of SOL-equivalents across Marinade + Jito + native stakes. */
  totalSolEquivalent: number;
}

/**
 * Thin projection of the full `MarginfiPosition` type exposed by
 * `src/modules/positions/marginfi.ts`. Kept here so the portfolio types
 * module doesn't pull in the reader module's internals, matching how
 * CompoundLendingPosition / MorphoLendingPosition are projections of their
 * reader modules.
 */
export interface SolanaMarginfiPositionSlice {
  protocol: "marginfi";
  chain: "solana";
  marginfiAccount: string;
  supplied: Array<{ symbol: string; amount: string; valueUsd: number }>;
  borrowed: Array<{ symbol: string; amount: string; valueUsd: number }>;
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  netValueUsd: number;
  healthFactor: number;
  warnings: string[];
}

/**
 * Thin projection of the full `KaminoPosition` type exposed by
 * `src/modules/positions/kamino.ts`. Same shape as MarginFi's slice; the
 * `obligation` field is Kamino's per-(wallet, market, kind) state account
 * (analogous to `marginfiAccount`).
 */
export interface SolanaKaminoPositionSlice {
  protocol: "kamino";
  chain: "solana";
  obligation: string;
  supplied: Array<{ symbol: string; amount: string; valueUsd: number }>;
  borrowed: Array<{ symbol: string; amount: string; valueUsd: number }>;
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  netValueUsd: number;
  healthFactor: number;
  warnings: string[];
}
