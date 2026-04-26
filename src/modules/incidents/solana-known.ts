/**
 * Vendored static lists for the Solana program-layer incident scan.
 * Issue #242 v1 — option (a) "vendored JSON in repo" baseline. Runtime
 * feed augmentation (option (c) hybrid via SOLANA_INCIDENT_FEED_URL) is
 * deferred to v2.
 *
 * Editing policy: every entry should reference a verifiable source
 * (DeFiLlama, rekt.news, Sec3 advisory, official program announcement)
 * in `source`. PRs that add entries without source are not merged.
 *
 * The scan uses these as the **default-known program set** when no
 * `wallet` arg is provided. With a wallet, v2 will scope the scan to
 * programs the user actually has exposure to via SPL holdings.
 */

export interface SolanaKnownProgram {
  programId: string;
  name: string;
  protocol: string;
}

export interface SolanaKnownPythFeed {
  feedAddress: string;
  symbol: string;
  source: string;
  /**
   * Anomaly threshold for the `oracle_price_anomaly` signal (#255).
   * If the current Pyth price deviates from the rolling 24h median
   * by more than this fraction (0.05 = 5%), the feed is flagged.
   *
   * Calibration rationale:
   *   - Stables (USDC/USD, USDT/USD): 0.01 (1%). A real depeg is
   *     rare-but-historic (USDC March 2023 depegged to $0.88 = 12%);
   *     1% is comfortably below the depeg signal AND well above
   *     normal stable-price noise (intra-day vol on healthy stables
   *     is ≤0.1%).
   *   - Volatile assets (SOL/USD, ETH/USD, BTC/USD): 0.05 (5%) per
   *     the issue's default. A 5% move in <30s is unusual enough to
   *     be worth surfacing; smaller moves are routine intra-day vol.
   *
   * Override path: per-feed value here. Future v2 can add a runtime
   * override via env var or user-config.
   */
  anomalyThresholdPct: number;
}

export interface SolanaIncidentRecord {
  programId: string;
  protocol: string;
  incidentDate: string; // ISO date
  severity: "critical" | "high" | "medium" | "low";
  status: "active" | "under_investigation" | "resolved";
  summary: string;
  source: string;
}

/**
 * Programs we scan for `recent_program_upgrade` and against which we
 * cross-check the vendored incident list. Conservative starter set —
 * the major Solana DeFi protocols this MCP already integrates with.
 */
export const KNOWN_PROGRAM_IDS: readonly SolanaKnownProgram[] = [
  // MarginFi v2
  {
    programId: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    name: "MarginFi v2",
    protocol: "marginfi",
  },
  // Marinade
  {
    programId: "MarBmsSgKXdrN1egZf5sqe1TMThczhMLJhJEAnCpyqr",
    name: "Marinade Staking",
    protocol: "marinade",
  },
  // Jito stake-pool
  {
    programId: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
    name: "SPL Stake Pool (Jito uses this program)",
    protocol: "jito",
  },
  // Kamino Lend
  {
    programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    name: "Kamino Lend",
    protocol: "kamino",
  },
  // Jupiter v6 (swaps)
  {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    name: "Jupiter Aggregator v6",
    protocol: "jupiter",
  },
  // Raydium AMM v4
  {
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    name: "Raydium AMM v4",
    protocol: "raydium",
  },
] as const;

/**
 * Pyth price feed accounts the scan checks for staleness. Subset chosen
 * to cover the assets the protocols above price (SOL, USDC, USDT, ETH,
 * BTC, JitoSOL). Full Pyth feed list is at https://pyth.network/price-feeds —
 * use that to add more.
 */
export const KNOWN_PYTH_FEEDS: readonly SolanaKnownPythFeed[] = [
  {
    feedAddress: "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG",
    symbol: "SOL/USD",
    source: "https://pyth.network/price-feeds/crypto-sol-usd",
    anomalyThresholdPct: 0.05,
  },
  {
    feedAddress: "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD",
    symbol: "USDC/USD",
    source: "https://pyth.network/price-feeds/crypto-usdc-usd",
    anomalyThresholdPct: 0.01,
  },
  {
    feedAddress: "3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL",
    symbol: "USDT/USD",
    source: "https://pyth.network/price-feeds/crypto-usdt-usd",
    anomalyThresholdPct: 0.01,
  },
] as const;

/**
 * Vendored historic-incident list. Each entry is a documented exploit /
 * compromise of a Solana program. The scan flags `known_exploit` only
 * when status is `active` or `under_investigation`. Resolved incidents
 * are returned in the response under `historicalIncidents` so the agent
 * can surface "Marinade had a critical incident in 2023, since resolved"
 * context — but they don't trip the `flagged: true` rollup.
 *
 * Empty by default in v1: this is the baseline for the curation workflow
 * to extend over time. PRs adding entries should cite a source per the
 * policy above. The Mango / Wormhole / Cashio / Nirvana cases listed in
 * the issue body are intentionally NOT pre-populated here so the
 * vendored list doesn't fossilize attribution claims (program IDs of
 * exploited entities have shifted since 2022; getting one wrong creates
 * a false-positive that a user has to manually rule out).
 */
export const KNOWN_SOLANA_INCIDENTS: readonly SolanaIncidentRecord[] = [
] as const;

/**
 * Squads V4 multisig program — the on-chain governance program many Solana
 * protocols use for upgrade-authority custody. Verified against the SDK's
 * generated types: `@sqds/multisig` v2.1.4 ships
 * `lib/generated/index.d.ts` with `export declare const PROGRAM_ADDRESS = "SQDS4ep65T..."`.
 *
 * NOT to be confused with the older `SMPLecH...` address some external
 * docs reference — the `rnd` scope-probe before the `pending_squads_upgrade`
 * implementation found that address was wrong (issue #251 comment).
 */
export const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/**
 * Solana's BPF Loader Upgradeable program — the loader responsible for
 * `Upgrade`, `SetAuthority`, `Close`, `ExtendProgram`, etc. instructions
 * against any upgradeable program. Cross-checked against
 * `@kamino-finance/klend-sdk`'s `utils/seeds.ts` which interacts with this
 * loader for protocol-program-derived addresses.
 *
 * The `1e` (one + e) at index 17 is intentional Solana convention for
 * loader-style program IDs ending in all-1 padding.
 */
export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID =
  "BPFLoaderUpgradeab1e11111111111111111111111";

/**
 * Programs known to be governed by a Squads V4 multisig, with the
 * specific multisig PDA that holds upgrade authority.
 *
 * Empty by default — populating this map requires per-protocol governance
 * verification (does Marinade actually use Squads V4? Jito? Kamino?
 * MarginFi? Drift?). The `@sqds/multisig` SDK does NOT expose a
 * `programId → multisigPda` map; that information lives in protocol
 * documentation and on-chain state. The `pending_squads_upgrade` signal
 * relies on this list — when it's empty, the signal returns
 * `available: true` with `scannedMultisigs: 0` and a `note` explaining
 * that the vendor list is empty pending curation.
 *
 * Editing policy: every entry must cite the source for the multisig PDA
 * (protocol blog post, on-chain `getProgramAccount(programDataAddress)`
 * showing `upgradeAuthority` matches a Squads vault PDA, governance
 * forum vote, etc.). Mirrors `KNOWN_SOLANA_INCIDENTS` policy —
 * source-or-no-merge.
 */
export interface SquadsGovernedProgram {
  programId: string;
  protocol: string;
  multisigPda: string;
  source: string;
}

export const KNOWN_SQUADS_GOVERNED_PROGRAMS: readonly SquadsGovernedProgram[] = [
] as const;
