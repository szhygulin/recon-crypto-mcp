/**
 * Lido yields adapter — calls the existing `getLidoApr()` helper which
 * pulls the current stETH APR from DefiLlama yields (10-min cache via
 * the existing `cache` module). Lido is Ethereum-mainnet-only for the
 * canonical stETH product; wstETH is bridged to L2s but accrues yield
 * via redemption rate, not via supply-side lending — out of v1 scope.
 *
 * Lido offers ETH staking yield only — there's no USDC/USDT/BTC market.
 * The adapter short-circuits when the requested asset isn't ETH.
 */
import { getLidoApr } from "../../staking/lido.js";
import type { YieldRow, UnavailableProtocolEntry } from "../types.js";
import type { SupportedAsset } from "../asset-map.js";
import { aprToApy } from "../types.js";

export async function readLidoYields(
  asset: SupportedAsset,
): Promise<{ rows: YieldRow[]; unavailable: UnavailableProtocolEntry[] }> {
  if (asset !== "ETH") {
    // Lido has no market for this asset — silently skip rather than
    // emit `available: false` (the protocol legitimately doesn't
    // support stables / BTC / SOL, so it's not a coverage gap).
    return { rows: [], unavailable: [] };
  }

  const apr = await getLidoApr();
  if (apr === undefined) {
    return {
      rows: [],
      unavailable: [
        {
          protocol: "lido",
          chain: "ethereum",
          available: false,
          reason: "DefiLlama yields endpoint did not return a Lido stETH pool — try again or check connectivity",
        },
      ],
    };
  }

  return {
    rows: [
      {
        protocol: "lido",
        chain: "ethereum",
        market: "stETH",
        supplyApr: apr,
        supplyApy: aprToApy(apr),
        tvl: null, // available from DefiLlama if needed; deferred to v2
        riskScore: null, // enriched by composer
      },
    ],
    unavailable: [],
  };
}
