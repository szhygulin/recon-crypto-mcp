import {
  Connection,
  PublicKey,
  StakeProgram,
  type ParsedAccountData,
} from "@solana/web3.js";
import { getStakePoolAccount } from "@solana/spl-stake-pool";
import { assertSolanaAddress } from "../solana/address.js";
import { SOLANA_TOKENS } from "../../config/solana.js";

/**
 * Read-only position readers for Solana staking — parallels the EVM
 * Lido/EigenLayer readers. Three separable surfaces the user typically
 * asks about together:
 *
 *   1. Marinade (mSOL, LST) — SOL-backed liquid-staking token. Exchange
 *      rate comes from Marinade's on-chain state's mSolPrice field.
 *   2. Jito (jitoSOL, LST) — same shape but via the generic SPL
 *      stake-pool program; exchange rate = totalLamports / poolTokenSupply.
 *   3. Native stake accounts — SPL stake-program accounts delegated to
 *      a validator vote account. Unlike LSTs, these have activation state
 *      (activating / active / deactivating / inactive) and a lockup.
 *
 * All three read-only; no write path. The consolidated
 * `getSolanaStakingPositions` tool returns all three sections so the user
 * sees a single "my Solana staking" view.
 */

/**
 * Jito's stake pool address — mints jitoSOL. Well-known constant
 * mirroring `src/modules/solana/program-ids.ts:KNOWN_STAKE_POOLS`.
 */
const JITO_STAKE_POOL = new PublicKey(
  "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
);

const M_SOL_MINT = new PublicKey(SOLANA_TOKENS.mSOL);
const JITO_SOL_MINT = new PublicKey(SOLANA_TOKENS.jitoSOL);

const LAMPORTS_PER_SOL = 1_000_000_000;

function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Read the user's SPL token balance for a given mint as a decimal-applied
 * amount. Returns 0 when the user has no ATA or a 0-balance ATA. Uses
 * `getParsedTokenAccountsByOwner` scoped to the specific mint so we only
 * decode the relevant accounts (cheap vs. walking every ATA the user has).
 */
async function readSplBalance(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<number> {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { mint });
  let sum = 0;
  for (const { account } of res.value) {
    const parsed = account.data as ParsedAccountData;
    const amount = parsed.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof amount === "number") sum += amount;
  }
  return sum;
}

export interface MarinadeStakingPosition {
  protocol: "marinade";
  chain: "solana";
  wallet: string;
  mSolBalance: number;
  /** mSOL balance × current exchange rate, in SOL. */
  solEquivalent: number;
  /** mSOL → SOL exchange rate (SOL per 1 mSOL). */
  exchangeRate: number;
}

export async function getMarinadeStakingPosition(
  conn: Connection,
  wallet: string,
): Promise<MarinadeStakingPosition> {
  const owner = assertSolanaAddress(wallet);
  const [mSolBalance, mSolPrice] = await Promise.all([
    readSplBalance(conn, owner, M_SOL_MINT),
    readMarinadeMSolPrice(conn),
  ]);
  return {
    protocol: "marinade",
    chain: "solana",
    wallet,
    mSolBalance,
    solEquivalent: mSolBalance * mSolPrice,
    exchangeRate: mSolPrice,
  };
}

/**
 * Read `mSolPrice` from Marinade's on-chain State account via the SDK.
 *
 * The SDK's `MarinadeState` class reads the State account, decodes the
 * borsh-serialized fields, and computes `mSolPrice = total_virtual_staked_
 * lamports / msol_supply` (falling back to 1.0 when supply is 0 — fresh
 * state). We use the read path only; pass `publicKey: null` in the config
 * so the write-path machinery never fires.
 *
 * Decoding the state account by hand was considered — would save the
 * ~6MB SDK dep. Rejected because the State layout has 10+ optional
 * variable-length fields before the two u64s we care about; a manual
 * walker adds fragility the SDK already handles.
 */
async function readMarinadeMSolPrice(conn: Connection): Promise<number> {
  const { Marinade, MarinadeConfig } = await import(
    "@marinade.finance/marinade-ts-sdk"
  );
  const config = new MarinadeConfig({
    connection: conn,
    publicKey: null,
  });
  const marinade = new Marinade(config);
  const state = await marinade.getMarinadeState();
  return state.mSolPrice;
}

export interface JitoStakingPosition {
  protocol: "jito";
  chain: "solana";
  wallet: string;
  jitoSolBalance: number;
  /** jitoSOL balance × current exchange rate, in SOL. */
  solEquivalent: number;
  /** jitoSOL → SOL exchange rate (SOL per 1 jitoSOL). */
  exchangeRate: number;
}

export async function getJitoStakingPosition(
  conn: Connection,
  wallet: string,
): Promise<JitoStakingPosition> {
  const owner = assertSolanaAddress(wallet);
  const [jitoSolBalance, exchangeRate] = await Promise.all([
    readSplBalance(conn, owner, JITO_SOL_MINT),
    readJitoExchangeRate(conn),
  ]);
  return {
    protocol: "jito",
    chain: "solana",
    wallet,
    jitoSolBalance,
    solEquivalent: jitoSolBalance * exchangeRate,
    exchangeRate,
  };
}

/**
 * Jito's exchange rate = totalLamports / poolTokenSupply, read from the
 * `StakePool` account. `@solana/spl-stake-pool`'s `getStakePoolAccount`
 * decodes the pool account directly — no Anchor / provider needed.
 */
async function readJitoExchangeRate(conn: Connection): Promise<number> {
  const pool = await getStakePoolAccount(conn, JITO_STAKE_POOL);
  const totalLamports = Number(pool.account.data.totalLamports.toString());
  const poolTokenSupply = Number(pool.account.data.poolTokenSupply.toString());
  if (poolTokenSupply === 0) return 1;
  // jitoSOL has 9 decimals, same as SOL — the ratio is already the
  // SOL-per-jitoSOL price (both sides of the division are in base units
  // of the same cardinality).
  return totalLamports / poolTokenSupply;
}

export type NativeStakeStatus =
  | "activating"
  | "active"
  | "deactivating"
  | "inactive";

export interface NativeStakePosition {
  protocol: "native";
  chain: "solana";
  /** Stake account pubkey (base58). */
  stakePubkey: string;
  /** Validator vote account this stake is delegated to, when `status != "inactive"`. */
  validator?: string;
  /** Stake + rent-exempt reserve, in SOL. */
  stakeSol: number;
  status: NativeStakeStatus;
  /** Epoch the delegation activates (null for undelegated stakes). */
  activationEpoch?: number;
  /** Epoch the delegation deactivates (null for active-only delegations). */
  deactivationEpoch?: number;
}

/**
 * Enumerate every native stake account this wallet has withdrawer authority
 * over. Uses `getParsedProgramAccounts` on the StakeProgram with a memcmp
 * filter at offset 44 — the authorized-withdrawer byte range inside the
 * `Meta` struct.
 *
 * Stake Account layout (Initialized / Delegated variants, both share Meta
 * prefix):
 *   [0..4]    state discriminator (u32 LE)
 *   [4..12]   meta.rent_exempt_reserve (u64)
 *   [12..44]  meta.authorized.staker (Pubkey, 32 bytes)
 *   [44..76]  meta.authorized.withdrawer (Pubkey, 32 bytes)
 *   [76..]    lockup + stake data (varies)
 *
 * Filtering on withdrawer (not staker) because withdrawer is the terminal
 * authority — it can reassign staker but not vice versa. "Owns this stake"
 * means "can withdraw the lamports".
 */
export async function getNativeStakePositions(
  conn: Connection,
  wallet: string,
): Promise<NativeStakePosition[]> {
  const owner = assertSolanaAddress(wallet);
  const accounts = await conn.getParsedProgramAccounts(StakeProgram.programId, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 44,
          bytes: owner.toBase58(),
        },
      },
    ],
  });

  const epochInfo = await conn.getEpochInfo();
  const currentEpoch = epochInfo.epoch;

  const positions: NativeStakePosition[] = [];
  for (const entry of accounts) {
    const data = entry.account.data;
    if (!("parsed" in data)) continue; // not JSON-parsed — skip
    const parsed = (data as ParsedAccountData).parsed;
    const stakePubkey = entry.pubkey.toBase58();
    const stakeSol = lamportsToSol(entry.account.lamports);

    if (parsed.type === "initialized") {
      // No delegation yet (or fully deactivated with lockup drained). Treat
      // as inactive — the stake account exists but no validator bond.
      positions.push({
        protocol: "native",
        chain: "solana",
        stakePubkey,
        stakeSol,
        status: "inactive",
      });
      continue;
    }

    if (parsed.type !== "delegated") continue;
    const delegation = parsed.info?.stake?.delegation;
    if (!delegation) continue;

    const activationEpoch = Number(delegation.activationEpoch);
    const deactivationEpoch = Number(delegation.deactivationEpoch);
    // Sentinel: u64::MAX in the parsed output means "not set". Both parsed
    // forms RPC returns are strings; compare loosely.
    const deactivationSet =
      !isNaN(deactivationEpoch) &&
      String(delegation.deactivationEpoch) !== "18446744073709551615";

    let status: NativeStakeStatus;
    if (!deactivationSet) {
      // No deactivation scheduled — activating or active.
      status = currentEpoch < activationEpoch ? "activating" : "active";
    } else if (currentEpoch < deactivationEpoch) {
      status = "deactivating";
    } else {
      status = "inactive";
    }

    positions.push({
      protocol: "native",
      chain: "solana",
      stakePubkey,
      validator: delegation.voter,
      stakeSol,
      status,
      activationEpoch,
      ...(deactivationSet ? { deactivationEpoch } : {}),
    });
  }

  return positions;
}

export interface SolanaStakingPositions {
  chain: "solana";
  wallet: string;
  marinade: MarinadeStakingPosition;
  jito: JitoStakingPosition;
  nativeStakes: NativeStakePosition[];
  /**
   * Sum of SOL-equivalent values across LSTs + native stakes. Useful for
   * the portfolio summary's staked-SOL subtotal.
   */
  totalSolEquivalent: number;
}

/**
 * Consolidated reader — one tool call, three sections. Matches the user
 * mental model ("show me my Solana staking"); separate sub-functions
 * stay exported for portfolio-integration paths that only want one slice.
 */
export async function getSolanaStakingPositions(
  conn: Connection,
  wallet: string,
): Promise<SolanaStakingPositions> {
  const [marinade, jito, nativeStakes] = await Promise.all([
    getMarinadeStakingPosition(conn, wallet),
    getJitoStakingPosition(conn, wallet),
    getNativeStakePositions(conn, wallet),
  ]);
  const nativeSol = nativeStakes.reduce((sum, s) => sum + s.stakeSol, 0);
  return {
    chain: "solana",
    wallet,
    marinade,
    jito,
    nativeStakes,
    totalSolEquivalent:
      marinade.solEquivalent + jito.solEquivalent + nativeSol,
  };
}
