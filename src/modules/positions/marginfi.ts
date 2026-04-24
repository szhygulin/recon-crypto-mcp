import type { Connection, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { assertSolanaAddress } from "../solana/address.js";
import { __internals, deriveMarginfiAccountPda } from "../solana/marginfi.js";

/**
 * Read-only MarginFi position reader. Parallels `getAaveLendingPosition` —
 * enumerates one wallet's MarginfiAccount balances across all banks,
 * computes the (USD-denominated) supplied + borrowed totals, and derives a
 * health factor.
 *
 * Health factor convention: MarginFi's on-chain health components are
 * `{assets, liabilities}` in USD. We publish `assets / liabilities` as the
 * health factor (Infinity when liabilities === 0), same convention as Aave
 * — user-facing semantics: >1 safe, <1 liquidatable.
 */

export interface MarginfiBalanceEntry {
  bank: string;
  mint: string;
  symbol: string;
  /** Human-readable decimal balance (already-decimals-applied). */
  amount: string;
  valueUsd: number;
}

export interface MarginfiPosition {
  protocol: "marginfi";
  chain: "solana";
  wallet: string;
  /** Base58 PDA of the MarginfiAccount this reader surfaced. */
  marginfiAccount: string;
  supplied: MarginfiBalanceEntry[];
  borrowed: MarginfiBalanceEntry[];
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  netValueUsd: number;
  /** assets/liabilities from `computeHealthComponents`. Infinity when no debt. */
  healthFactor: number;
  /** Optional bank-level pause flags — empty array when all banks healthy. */
  warnings: string[];
}

interface MinimalBalance {
  active: boolean;
  bankPk: PublicKey;
  computeQuantityUi(bank: unknown): { assets: BigNumber; liabilities: BigNumber };
  computeUsdValue(
    bank: unknown,
    price: unknown,
  ): { assets: BigNumber; liabilities: BigNumber };
}

interface MinimalWrapper {
  address: PublicKey;
  activeBalances: MinimalBalance[];
  computeHealthComponents(req: unknown): {
    assets: BigNumber;
    liabilities: BigNumber;
  };
}

interface MinimalBank {
  address: PublicKey;
  mint: PublicKey;
  tokenSymbol?: string;
  isPaused?: boolean;
}

interface MinimalClient {
  banks: Map<string, MinimalBank>;
  oraclePrices: Map<string, unknown>;
  getOraclePriceByBank?(bankAddr: PublicKey): unknown;
}

/**
 * Resolve the first `limit` MarginfiAccounts for a wallet. Most users have
 * exactly one (accountIndex=0); we read up to 4 slots before giving up. The
 * aggregate position is surfaced as PER-ACCOUNT entries — MarginFi treats
 * separate MarginfiAccounts as independent borrowing containers, so mixing
 * their totals would mask a per-account liquidation risk.
 */
export async function getMarginfiPositions(
  conn: Connection,
  wallet: string,
): Promise<MarginfiPosition[]> {
  const authority = assertSolanaAddress(wallet);

  // The client fetch is idempotent & cached at the `solana/marginfi.ts`
  // layer; calling its getter here rides the same cache.
  const { MarginfiClient, getConfig, MarginfiAccountWrapper } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );
  const stubWallet = {
    publicKey: authority,
    signTransaction: async <T,>(_tx: T): Promise<T> => {
      throw new Error("read-only path must not sign");
    },
    signAllTransactions: async <T,>(_txs: T[]): Promise<T[]> => {
      throw new Error("read-only path must not sign");
    },
  };
  const client = await MarginfiClient.fetch(getConfig("production"), stubWallet, conn, {
    readOnly: true,
  });

  // Probe the first 4 account slots. The PDA is deterministic, so we can
  // batch-fetch without scanning getProgramAccounts.
  const results: MarginfiPosition[] = [];
  const MAX_SLOTS = 4;
  for (let idx = 0; idx < MAX_SLOTS; idx++) {
    const pda = deriveMarginfiAccountPda(authority, idx);
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) {
      // Once we hit a gap, subsequent slots are almost certainly also
      // empty (users don't skip slots). Early-break keeps the common case
      // (one account at slot 0) fast — 1 RPC lookup, not 4.
      if (idx === 0) return []; // common: user has no MarginfiAccount at all
      break;
    }
    let wrapper: MinimalWrapper;
    try {
      wrapper = (await MarginfiAccountWrapper.fetch(
        pda,
        client,
      )) as unknown as MinimalWrapper;
    } catch {
      // Hydration failure on one slot shouldn't kill the whole enumeration.
      continue;
    }
    results.push(buildPositionFromWrapper(client as unknown as MinimalClient, wrapper, wallet));
  }
  return results;
}

function buildPositionFromWrapper(
  client: MinimalClient,
  wrapper: MinimalWrapper,
  wallet: string,
): MarginfiPosition {
  const supplied: MarginfiBalanceEntry[] = [];
  const borrowed: MarginfiBalanceEntry[] = [];
  const warnings: string[] = [];

  let totalSuppliedUsd = 0;
  let totalBorrowedUsd = 0;

  for (const balance of wrapper.activeBalances) {
    const bank = client.banks.get(balance.bankPk.toBase58());
    if (!bank) continue;
    const price = resolveOraclePrice(client, bank.address);
    if (!price) continue;

    const { assets: assetsUi, liabilities: liabilitiesUi } = balance.computeQuantityUi(
      bank as unknown,
    );
    const usd = balance.computeUsdValue(bank as unknown, price);
    const mint = bank.mint.toBase58();
    const symbol = bank.tokenSymbol ?? __internals.resolveMintSymbol(mint);

    if (assetsUi.gt(0)) {
      const usdValue = usd.assets.toNumber();
      supplied.push({
        bank: bank.address.toBase58(),
        mint,
        symbol,
        amount: assetsUi.toFixed(6).replace(/\.?0+$/, ""),
        valueUsd: round2(usdValue),
      });
      totalSuppliedUsd += usdValue;
    }
    if (liabilitiesUi.gt(0)) {
      const usdValue = usd.liabilities.toNumber();
      borrowed.push({
        bank: bank.address.toBase58(),
        mint,
        symbol,
        amount: liabilitiesUi.toFixed(6).replace(/\.?0+$/, ""),
        valueUsd: round2(usdValue),
      });
      totalBorrowedUsd += usdValue;
    }
    if (bank.isPaused) {
      warnings.push(`${symbol} bank is governance-paused (all actions blocked).`);
    }
  }

  // Maintenance margin type is the one users map to "can I be liquidated right now?".
  // MarginRequirementType.Maintenance === 1 in the SDK's enum; we use the numeric
  // literal to avoid importing the enum just for the one call.
  const health = wrapper.computeHealthComponents(1);
  const assetsUsd = health.assets.toNumber();
  const liabsUsd = health.liabilities.toNumber();
  const healthFactor =
    liabsUsd <= 0 ? Number.POSITIVE_INFINITY : assetsUsd / liabsUsd;

  return {
    protocol: "marginfi",
    chain: "solana",
    wallet,
    marginfiAccount: wrapper.address.toBase58(),
    supplied,
    borrowed,
    totalSuppliedUsd: round2(totalSuppliedUsd),
    totalBorrowedUsd: round2(totalBorrowedUsd),
    netValueUsd: round2(totalSuppliedUsd - totalBorrowedUsd),
    healthFactor,
    warnings,
  };
}

/**
 * Resolve a bank's oracle price from the MarginFi client's `oraclePrices`
 * map. The SDK exposes both a getter (when available) and a raw Map; we
 * prefer the getter so per-bank price-age handling stays with the SDK.
 */
function resolveOraclePrice(client: MinimalClient, bank: PublicKey): unknown {
  if (typeof client.getOraclePriceByBank === "function") {
    return client.getOraclePriceByBank(bank);
  }
  return client.oraclePrices.get(bank.toBase58());
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
