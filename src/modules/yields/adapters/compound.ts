/**
 * Compound V3 yields adapter — calls the existing wallet-less reader
 * `getCompoundMarketInfo` once per (chain, comet-market) pair that
 * matches the requested asset.
 */
import { getCompoundMarketInfo } from "../../compound/market-info.js";
import { CONTRACTS } from "../../../config/contracts.js";
import type { SupportedChain } from "../../../types/index.js";
import type { YieldRow, UnavailableProtocolEntry } from "../types.js";
import type { SupportedAsset } from "../asset-map.js";
import { aprToApy } from "../types.js";

/**
 * Map (asset, chain) → list of Comet market identifiers from CONTRACTS.
 * Compound names markets by base asset (`cUSDCv3`, `cWETHv3`, ...). On
 * chains where a bridged variant exists (Arbitrum's `cUSDC.ev3`) we
 * include it as a separate market — the agent can show both rows and
 * the user picks based on which token they actually hold.
 */
function compoundMarketsForAsset(
  asset: SupportedAsset,
  chain: SupportedChain,
): Array<{ market: `0x${string}`; label: string }> {
  const compound = (CONTRACTS[chain] as { compound?: Record<string, string> }).compound;
  if (!compound) return [];
  const out: Array<{ market: `0x${string}`; label: string }> = [];
  const candidates: Record<SupportedAsset, string[]> = {
    USDC: ["cUSDCv3", "cUSDC.ev3", "cUSDbCv3"],
    USDT: ["cUSDTv3", "cUSDT.ev3"],
    ETH: ["cWETHv3"],
    BTC: [],
    SOL: [],
    stables: [],
  };
  for (const key of candidates[asset]) {
    const addr = compound[key];
    if (addr) out.push({ market: addr as `0x${string}`, label: key });
  }
  return out;
}

export async function readCompoundYields(
  asset: SupportedAsset,
  chains: ReadonlyArray<SupportedChain>,
): Promise<{ rows: YieldRow[]; unavailable: UnavailableProtocolEntry[] }> {
  const rows: YieldRow[] = [];
  const unavailable: UnavailableProtocolEntry[] = [];

  for (const chain of chains) {
    const markets = compoundMarketsForAsset(asset, chain);
    if (markets.length === 0) continue;

    const settled = await Promise.allSettled(
      markets.map((m) =>
        getCompoundMarketInfo({ chain, market: m.market }).then((info) => ({
          info,
          label: m.label,
        })),
      ),
    );

    for (const r of settled) {
      if (r.status === "rejected") {
        unavailable.push({
          protocol: "compound-v3",
          chain,
          available: false,
          reason: `Compound V3 read failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        });
        continue;
      }
      const { info, label } = r.value;
      const notes: string[] = [];
      if (info.pausedActions.length > 0) {
        notes.push(`paused actions: ${info.pausedActions.join(", ")}`);
      }
      if (info.pausedActionsUnknown) {
        notes.push("pause-flag read indeterminate — treat pause status as unknown");
      }
      // Compound's totalSupply is in the base asset's decimals; getCompoundMarketInfo
      // surfaces it as a decimal-string. Convert to USD-ish via 1:1 stable approximation
      // for stables; for ETH/WETH the response doesn't carry a price, so leave tvl null
      // and let the agent surface protocol risk score + notes instead.
      const isStable = label.includes("USDC") || label.includes("USDT") || label.includes("USDbC");
      const tvl = isStable ? Number(info.totalSupply) : null;
      rows.push({
        protocol: "compound-v3",
        chain,
        market: label,
        supplyApr: info.supplyApr,
        supplyApy: aprToApy(info.supplyApr),
        tvl,
        riskScore: null, // enriched by composer
        ...(notes.length > 0 ? { notes } : {}),
      });
    }
  }
  return { rows, unavailable };
}
