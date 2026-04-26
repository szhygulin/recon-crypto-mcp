/**
 * Common shape returned by every per-protocol yields adapter. The
 * composer in `index.ts` fans out across adapters, normalizes, filters,
 * and ranks by `supplyApr`.
 */
import type { AnyChain } from "../../types/index.js";

export interface YieldRow {
  protocol:
    | "aave-v3"
    | "compound-v3"
    | "morpho-blue"
    | "marginfi"
    | "kamino"
    | "lido"
    | "eigenlayer"
    | "marinade"
    | "jito"
    | "native-stake";
  chain: AnyChain;
  /**
   * Human-readable market identifier — e.g. for Aave it's the asset symbol
   * ("USDC"), for Compound it's the comet name ("cUSDCv3"), for Lido it's
   * "stETH". Free-form; agents render verbatim.
   */
  market: string;
  /** Current supply APR as a fraction (0.0481 = 4.81%). May be null if the protocol's underlying source returned no rate. */
  supplyApr: number | null;
  /** Continuously-compounded APY, derived from APR. Same null semantics. */
  supplyApy: number | null;
  /** USD TVL on the supply side. May be null when the upstream doesn't expose it cheaply. */
  tvl: number | null;
  /** 0-100 risk score from `get_protocol_risk_score`. May be null when DefiLlama has no slug for the protocol. */
  riskScore: number | null;
  /**
   * Free-form notes — pause flags, withdrawal queue length, supply-cap
   * warnings, "borrow side disabled", etc. Agent surfaces verbatim.
   */
  notes?: string[];
}

/**
 * `available: false` envelope for protocols whose wallet-less reader
 * isn't yet implemented. The composer surfaces these alongside the
 * available rows so the user sees the coverage gap rather than a
 * silently-incomplete table.
 */
export interface UnavailableProtocolEntry {
  protocol: YieldRow["protocol"];
  chain: AnyChain;
  available: false;
  reason: string;
}

export interface CompareYieldsResult {
  asset: string;
  expandedAssets?: string[]; // present when input was "stables"
  rows: YieldRow[];
  unavailable: UnavailableProtocolEntry[];
  /** Top-level note when no rows survived filters (e.g. all riskScore < ceiling, all TVL < min). */
  emptyResultReason?: string;
  fetchedAt: string; // ISO
}

/**
 * Convert APR (simple) to APY (continuously compounded). Most lending
 * protocols quote APR; APY is what the user actually realizes when
 * interest compounds per-block. Continuous compounding is the standard
 * upper bound — per-block compounding gives essentially the same number
 * for the rates we encounter (single-digit APRs).
 */
export function aprToApy(apr: number): number {
  return Math.expm1(apr);
}
