// Shared domain types used across all modules.

import type { SupportedChain } from "./chains.js";
import type {
  LendingPositionUnion,
  LPPosition,
  StakingPosition,
  TokenAmount,
} from "./positions.js";
import type {
  PortfolioCoverage,
  SolanaPortfolioSlice,
  TronPortfolioSlice,
} from "./portfolio.js";

export * from "./chains.js";

export * from "./positions.js";

export * from "./portfolio.js";

export * from "./security.js";

/**
 * Bitcoin slice of a portfolio summary. Parallel to `TronPortfolioSlice`
 * + `SolanaPortfolioSlice`. Bitcoin has no fungible token model in
 * Phase 1 (BRC-20 / Runes / Ordinals deferred), so the slice carries
 * only per-address native balances + the rolled-up USD totals.
 *
 * Multi-address: every BTC address the caller passed via
 * `bitcoinAddress` (single) or `bitcoinAddresses` (array) is surfaced
 * here. This mirrors `get_btc_balances` shape so callers who already
 * use that tool see the same per-address projection inside the
 * portfolio response.
 */
export interface BitcoinPortfolioSlice {
  /** All addresses queried for this slice — at least one. */
  addresses: string[];
  /**
   * Per-address breakdown. Each entry carries confirmed + mempool +
   * total sats, the BTC-decimal projection, the address type, and the
   * USD valuation. Identical shape to `BitcoinBalance` from the
   * `btc/balances.ts` reader.
   */
  balances: Array<{
    address: string;
    addressType: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
    confirmedSats: string;
    mempoolSats: string;
    totalSats: string;
    confirmedBtc: string;
    totalBtc: string;
    symbol: "BTC";
    decimals: 8;
    txCount: number;
    valueUsd?: number;
    /** True when DefiLlama returned no price; balance is excluded from totals. */
    priceMissing?: boolean;
  }>;
  /** Rolled-up USD value across all addresses (uses confirmed balance). */
  walletBalancesUsd: number;
}

/**
 * Litecoin slice of a portfolio summary. Mirror of `BitcoinPortfolioSlice`.
 * Same UTXO model, same balance projection, different symbol/HRP.
 */
export interface LitecoinPortfolioSlice {
  addresses: string[];
  balances: Array<{
    address: string;
    addressType: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
    confirmedSats: string;
    mempoolSats: string;
    totalSats: string;
    confirmedLtc: string;
    totalLtc: string;
    symbol: "LTC";
    decimals: 8;
    txCount: number;
    valueUsd?: number;
    priceMissing?: boolean;
  }>;
  walletBalancesUsd: number;
}

/** Per-wallet slice of a multi-wallet portfolio, or a stand-alone single-wallet summary. */
export interface PortfolioSummary {
  wallet: `0x${string}`;
  chains: SupportedChain[];
  walletBalancesUsd: number;
  lendingNetUsd: number;
  lpUsd: number;
  stakingUsd: number;
  totalUsd: number;
  perChain: Record<SupportedChain, number>;
  /**
   * TRON totals folded into the same number as EVM. Present when the caller
   * passed a `tronAddress` (or TRON is in the default chain set and an
   * address was resolvable).
   */
  tronUsd?: number;
  /**
   * TRON staking USD (frozen + pending-unfreeze + claimable). Already included
   * in `tronUsd` — this field surfaces it separately for UI. Present only when
   * staking was fetched successfully.
   */
  tronStakingUsd?: number;
  /**
   * Solana totals folded into the same aggregate as EVM/TRON. Present when
   * the caller passed a `solanaAddress`. Phase 1 covers balances; Phase 3
   * adds MarginFi lending (surfaced separately via `solanaLendingUsd`).
   */
  solanaUsd?: number;
  /**
   * Solana lending net USD — MarginFi (Phase 3). Parallels `tronStakingUsd`
   * as a carve-out that's separately surfaced in UIs but also folded into
   * `totalUsd`. Present only when at least one MarginfiAccount was found
   * for the wallet.
   */
  solanaLendingUsd?: number;
  /**
   * Solana staking net USD — Marinade mSOL + Jito jitoSOL + native stake
   * accounts (roadmap #2). Computed as `totalSolEquivalent * SOL price`
   * using the same SOL price that valued the native-SOL balance line.
   * Folded into `totalUsd`; carve-out here for UIs. Present only when the
   * wallet holds at least some Solana staking.
   */
  solanaStakingUsd?: number;
  /**
   * Bitcoin totals (sum across every address passed via `bitcoinAddress` /
   * `bitcoinAddresses`). Present only when the caller supplied at least
   * one BTC address. Folded into `totalUsd`.
   */
  bitcoinUsd?: number;
  /**
   * Litecoin totals (sum across every address passed via `litecoinAddress` /
   * `litecoinAddresses`). Present only when the caller supplied at least
   * one LTC address. Folded into `totalUsd`.
   */
  litecoinUsd?: number;
  breakdown: {
    native: TokenAmount[];
    erc20: TokenAmount[];
    lending: LendingPositionUnion[];
    lp: LPPosition[];
    staking: StakingPosition[];
    /** TRON slice — absent when no TRON address was queried. */
    tron?: TronPortfolioSlice;
    /** Solana slice — absent when no Solana address was queried. */
    solana?: SolanaPortfolioSlice;
    /** Bitcoin slice — absent when no BTC address(es) were queried. */
    bitcoin?: BitcoinPortfolioSlice;
    /** Litecoin slice — absent when no LTC address(es) were queried. */
    litecoin?: LitecoinPortfolioSlice;
  };
  coverage: PortfolioCoverage;
}

/** Multi-wallet portfolio aggregation. */
export interface MultiWalletPortfolioSummary {
  wallets: `0x${string}`[];
  chains: SupportedChain[];
  totalUsd: number;
  walletBalancesUsd: number;
  lendingNetUsd: number;
  lpUsd: number;
  stakingUsd: number;
  perChain: Record<SupportedChain, number>;
  perWallet: PortfolioSummary[];
  /**
   * Non-EVM holdings surfaced as PARALLEL siblings of the EVM wallets,
   * NOT folded into any specific `perWallet[i]`. Issue #201 — TRON / BTC /
   * Solana addresses on a Ledger are independent identities (different
   * BIP-44 derivation paths), so attributing them to "the first EVM
   * wallet" produced misleading per-wallet rollups.
   *
   * Each chain's slice is surfaced when the corresponding address arg
   * (`tronAddress`/`tronAddresses`, `solanaAddress`/`solanaAddresses`,
   * `bitcoinAddress`/`bitcoinAddresses`) was passed to
   * `getPortfolioSummary`. The USD rollups below sum across whichever
   * slices were fetched.
   */
  nonEvm?: {
    /** Per-address TRON slice; one entry per requested tronAddress. */
    tron?: TronPortfolioSlice[];
    /** Per-address Solana slice; one entry per requested solanaAddress. */
    solana?: SolanaPortfolioSlice[];
    /** Multi-address Bitcoin slice; aggregates every requested btc address. */
    bitcoin?: BitcoinPortfolioSlice;
    /** Multi-address Litecoin slice; aggregates every requested ltc address. */
    litecoin?: LitecoinPortfolioSlice;
  };
  /** Sum of all TRON wallet balances (TRX + TRC-20) across the queried addresses. */
  tronUsd?: number;
  /** Sum of TRON staking (frozen TRX + claimable rewards). */
  tronStakingUsd?: number;
  /** Sum of all Solana wallet balances (SOL + SPL) across queried addresses. */
  solanaUsd?: number;
  /** Sum of MarginFi + Kamino netValueUsd across queried Solana addresses. */
  solanaLendingUsd?: number;
  /** Sum of Marinade + Jito + native-stake totals across queried Solana addresses. */
  solanaStakingUsd?: number;
  /** Sum of BTC × USD-price across queried Bitcoin addresses. */
  bitcoinUsd?: number;
  /** Sum of LTC × USD-price across queried Litecoin addresses. */
  litecoinUsd?: number;
  coverage: PortfolioCoverage;
}

export * from "./tx.js";

export * from "./devices.js";

export * from "./config.js";
