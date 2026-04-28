/**
 * MarginFi yields adapter — wallet-less reader. Issue #288.
 *
 * MarginFi borrow-lend isn't on DefiLlama (only `marginfi-lst` is), so
 * we read the bank state directly via the existing hardened MarginFi
 * client (the one already shared with `getMarginfiPositions`). For the
 * supply APR we ask the SDK's `bank.computeInterestRates()` —
 * mathematically `baseInterestRate * utilizationRate`. For TVL we ask
 * `bank.computeTvl(oraclePrice)`.
 *
 * The hardened client survives per-bank decode failures (the
 * `OracleSetup` variants 15/16 drift the SDK IDL is blind to —
 * `project_marginfi_oracle_setup_drift` memory). Banks that fail to
 * hydrate simply don't appear in `client.banks`, so the adapter just
 * doesn't emit them; the row is silently absent rather than blowing up
 * the whole `compare_yields` response.
 *
 * Stub authority: the MarginFi client constructor needs an authority
 * pubkey to derive the wallet payload, even on read-only paths.
 * `PublicKey.default` (the all-zeros key) is the conventional
 * placeholder — no signing happens here.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { getHardenedMarginfiClient } from "../../solana/marginfi.js";
import { getSolanaConnection } from "../../solana/rpc.js";
import { SOLANA_TOKENS, WSOL_MINT } from "../../../config/solana.js";
import type { AnyChain } from "../../../types/index.js";
import type { YieldRow, UnavailableProtocolEntry } from "../types.js";
import type { SupportedAsset } from "../asset-map.js";
import { aprToApy } from "../types.js";

interface MinimalBankInterestRates {
  lendingRate: BigNumber;
  borrowingRate: BigNumber;
}

interface MinimalBankConfig {
  operationalState: string;
}

interface MinimalBankForYields {
  address: PublicKey;
  mint: PublicKey;
  config: MinimalBankConfig;
  computeInterestRates(): MinimalBankInterestRates;
  computeTvl(oraclePrice: unknown): BigNumber;
}

interface MinimalClientForYields {
  banks: Map<string, MinimalBankForYields>;
  getBankByMint(mint: PublicKey): MinimalBankForYields | null;
  getOraclePriceByBank?(addr: PublicKey): unknown;
  oraclePrices?: Map<string, unknown>;
}

/** Resolve the SPL mint string for a `SupportedAsset` we'd surface a
 * MarginFi row for. Returns null for everything outside MarginFi's
 * borrow-lend coverage. */
function marginfiMintFor(asset: SupportedAsset): {
  mint: string;
  market: string;
} | null {
  switch (asset) {
    case "USDC":
      return { mint: SOLANA_TOKENS.USDC, market: "USDC" };
    case "USDT":
      return { mint: SOLANA_TOKENS.USDT, market: "USDT" };
    case "SOL":
      return { mint: WSOL_MINT, market: "SOL" };
    default:
      return null;
  }
}

/**
 * Read MarginFi bank deposit APRs for the requested asset. Only emits
 * when Solana is in the requested chain set.
 */
export async function readMarginfiYields(
  asset: SupportedAsset,
  requestedChains: ReadonlyArray<AnyChain>,
): Promise<{ rows: YieldRow[]; unavailable: UnavailableProtocolEntry[] }> {
  if (!requestedChains.includes("solana")) {
    return { rows: [], unavailable: [] };
  }

  const target = marginfiMintFor(asset);
  if (!target) return { rows: [], unavailable: [] };

  let client: MinimalClientForYields;
  try {
    const conn: Connection = getSolanaConnection();
    client = (await getHardenedMarginfiClient(
      conn,
      PublicKey.default,
    )) as MinimalClientForYields;
  } catch (err) {
    return {
      rows: [],
      unavailable: [
        {
          protocol: "marginfi",
          chain: "solana",
          available: false,
          reason: `MarginFi client load failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const bank = client.getBankByMint(new PublicKey(target.mint));
  if (!bank) {
    // Bank either isn't listed on MarginFi or got skipped during the
    // hardened load (oracle-setup / IDL drift). Surface as
    // `unavailable` so the user sees the gap rather than silent
    // absence.
    return {
      rows: [],
      unavailable: [
        {
          protocol: "marginfi",
          chain: "solana",
          available: false,
          reason: `No live MarginFi bank for ${target.market} — either de-listed or hardened-decode skipped (oracle-setup drift).`,
        },
      ],
    };
  }

  const notes: string[] = [];
  const opState = bank.config?.operationalState;
  if (opState === "Paused" || opState === "KilledByBankruptcy") {
    notes.push(`bank operationalState=${opState} — supply blocked`);
  } else if (opState === "ReduceOnly") {
    notes.push("bank operationalState=ReduceOnly — no new supplies; existing positions can withdraw");
  }

  let aprFraction: number | null = null;
  try {
    const rates = bank.computeInterestRates();
    aprFraction = rates.lendingRate.toNumber();
  } catch {
    // Some malformed banks throw inside `computeInterestRates` —
    // emit the row with a null rate so the user sees the listing but
    // not a fabricated number.
    aprFraction = null;
  }

  let tvlUsd: number | null = null;
  try {
    const oraclePrice =
      client.getOraclePriceByBank?.(bank.address) ??
      client.oraclePrices?.get(bank.address.toBase58()) ??
      null;
    if (oraclePrice) {
      tvlUsd = bank.computeTvl(oraclePrice).toNumber();
      if (!Number.isFinite(tvlUsd)) tvlUsd = null;
    }
  } catch {
    tvlUsd = null;
  }

  const row: YieldRow = {
    protocol: "marginfi",
    chain: "solana",
    market: `MarginFi · ${target.market}`,
    supplyApr: aprFraction,
    supplyApy: aprFraction !== null ? aprToApy(aprFraction) : null,
    tvl: tvlUsd,
    riskScore: null,
    ...(notes.length > 0 ? { notes } : {}),
  };

  return { rows: [row], unavailable: [] };
}
