import {
  getEsploraClient,
  resetEsploraClient,
} from "../utxo/esplora-client.js";

/**
 * Bitcoin indexer abstraction. Single interface, mempool.space (default)
 * + any Esplora-compatible endpoint as the impl. Self-hosted Esplora /
 * Electrs all expose the same REST surface — mempool.space's API is a
 * fork of Blockstream Esplora's, with a few additions (fee
 * recommendations, mempool stats) that we use.
 *
 * URL resolution priority (highest first):
 *   1. `BITCOIN_INDEXER_URL` env var
 *   2. `userConfig.bitcoinIndexerUrl`
 *   3. `BITCOIN_DEFAULT_INDEXER_URL` (mempool.space)
 *
 * Phase 1 scope: read-only. PR3 adds `getUtxos` + `getRawTx` for
 * coin-selection and PSBT input population, plus `broadcastTx` for the
 * send path.
 */

/**
 * Esplora address-stats payload. Both confirmed and mempool stats are
 * present; we sum them to surface a "total balance" alongside the
 * confirmed-only number. mempool.space prefers `chain_stats` /
 * `mempool_stats` field naming (forked from Blockstream).
 */
interface EsploraAddressStats {
  /** Address — echoed back. */
  address: string;
  /** Confirmed: funds that have at least 1 confirmation. */
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  /** Unconfirmed: funds in mempool, not yet mined. */
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

/**
 * Bitcoin balance for a single address. Confirmed + unconfirmed reported
 * separately so the caller can decide UX (typically: show confirmed as
 * the headline, surface unconfirmed only when non-zero).
 */
export interface BitcoinAddressBalance {
  address: string;
  /** Confirmed funded - confirmed spent, in sats. Always ≥ 0. */
  confirmedSats: bigint;
  /** Mempool funded - mempool spent, in sats. Can be negative when funds are in-flight as spent. */
  mempoolSats: bigint;
  /** Confirmed + mempool. Convenience field. */
  totalSats: bigint;
  /** Total tx count this address has been involved in (confirmed + mempool). */
  txCount: number;
}

/**
 * Fee-rate estimates in sat/vB. Returned by mempool.space's
 * `/v1/fees/recommended` endpoint — these match the labels the mempool.space
 * UI shows ("High Priority" / "Medium Priority" / etc.) so users see
 * familiar terminology.
 */
export interface BitcoinFeeEstimates {
  /** ~next-block target. */
  fastestFee: number;
  /** ~3 blocks (~30 min). */
  halfHourFee: number;
  /** ~6 blocks (~1 hour). */
  hourFee: number;
  /** Lowest fee miners are still including. */
  economyFee: number;
  /** Floor below which a tx is unlikely to ever confirm. */
  minimumFee: number;
}

/**
 * Tx history entry. Subset of the Esplora `/address/<addr>/txs` payload
 * we surface — enough for portfolio history rendering without forcing
 * callers to learn the full SAT/RBF/witness shape.
 */
export interface BitcoinTxHistoryEntry {
  txid: string;
  /** Sum of vouts that pay this address (the funding side). Sats. */
  receivedSats: bigint;
  /** Sum of vins that come from this address (the spending side). Sats. */
  sentSats: bigint;
  /** Tx fee from the Esplora payload (sats). Useful UX context. */
  feeSats: bigint;
  /** Block height — undefined when still in mempool. */
  blockHeight?: number;
  /** Unix timestamp of the block — undefined for mempool. */
  blockTime?: number;
  /** True when sequence < 0xFFFFFFFE on at least one input (BIP-125). */
  rbfEligible: boolean;
}

/**
 * Esplora vin/vout shapes we destructure. Trimmed to fields we read.
 */
export interface EsploraVin {
  txid: string;
  vout: number;
  prevout?: { scriptpubkey_address?: string; value?: number };
  sequence?: number;
}

export interface EsploraVout {
  scriptpubkey_address?: string;
  value?: number;
}

export interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
}

/**
 * UTXO entry. Esplora returns these from `/address/<addr>/utxo`.
 * `scriptPubKey` is NOT in the Esplora payload directly — we derive it
 * from the address at PSBT-build time (cheaper than a per-UTXO lookup
 * since all UTXOs for one address share the same scriptPubKey).
 */
export interface BitcoinUtxo {
  txid: string;
  vout: number;
  /** UTXO value in sats. */
  value: number;
  /** Block height of the funding tx. Undefined for mempool UTXOs. */
  blockHeight?: number;
  /** True when the UTXO is in mempool (not yet confirmed). */
  unconfirmed: boolean;
}

export interface BitcoinIndexer {
  getBalance(address: string): Promise<BitcoinAddressBalance>;
  getFeeEstimates(): Promise<BitcoinFeeEstimates>;
  /**
   * Fetch the tx history for an address. `limit` clamps how many entries
   * to walk (we paginate via the Esplora `/txs/chain/<last_seen>` cursor
   * pattern; mempool.space honors the same convention). Returns only
   * confirmed + mempool txs, oldest-first within each segment.
   */
  getAddressTxs(
    address: string,
    opts?: { limit?: number },
  ): Promise<BitcoinTxHistoryEntry[]>;
  /**
   * Fetch the UTXO set for an address. Returned newest-first (block
   * height descending). Used as the input set for coin-selection on
   * `prepare_btc_send`.
   */
  getUtxos(address: string): Promise<BitcoinUtxo[]>;
  /**
   * Broadcast a fully-signed tx hex via the indexer's `/tx` endpoint.
   * Returns the on-chain txid on success. Throws with the indexer's
   * error body on failures (most commonly: "min relay fee not met"
   * when feeRate is below the mempool floor, or "txn-already-known"
   * when re-broadcasting a tx that's already in the mempool).
   */
  broadcastTx(rawTxHex: string): Promise<string>;
  /**
   * Fetch confirmation status for a txid. Used by
   * `get_transaction_status` BTC branch — returns the confirmation
   * count at current tip when the tx is mined; returns `confirmed: false`
   * for in-mempool txs; null when the tx isn't found at all (dropped
   * or never broadcast).
   */
  getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null>;
  /**
   * Fetch the current Bitcoin chain tip — height, block hash, header
   * timestamp, etc. Two HTTP calls under the hood: `/blocks/tip/hash`
   * for the latest hash, then `/block/<hash>` for the full header
   * details. Both endpoints are aggressively cached at the indexer
   * (mempool.space + standard Esplora share the same shape).
   */
  getBlockTip(): Promise<BitcoinBlockTip>;
  /**
   * Fetch the most recent N block headers, newest-first. Backbone for
   * chain-health signals (hash_cliff, empty_block_streak, miner_concentration).
   * Esplora's `/blocks` endpoint returns 10 blocks per call from the tip;
   * this helper paginates via `/blocks/<startHeight>` to assemble up to
   * `n` blocks (capped at 200 to bound HTTP load on free-tier indexers).
   * Issue #233 v1.
   */
  getRecentBlocks(n: number): Promise<BitcoinBlockSummary[]>;
  /**
   * Fetch the raw hex of a previous transaction by txid. Required for
   * `nonWitnessUtxo` population on PSBT inputs — Ledger BTC app 2.x
   * cryptographically verifies the input amount against this prev-tx
   * (BIP-143 sighash doesn't commit to input amount, so the prev-tx is
   * the only way the device can prove a malicious offline signer didn't
   * lie about the input value to inflate the fee). Without it the device
   * surfaces a "Security risk: unverified inputs" prompt and refuses to
   * sign cleanly. Issue #213.
   */
  getTxHex(txid: string): Promise<string>;
  /**
   * Fetch the full Esplora tx shape (vin/vout/fee/status) for a single
   * txid. Used by the RBF fee-bump builder, which needs to: (1) confirm
   * the tx is still in mempool (not already mined), (2) read original
   * inputs to rebuild the same input set, (3) read original outputs to
   * preserve recipients verbatim and identify the change output, (4)
   * verify at least one input has BIP-125-eligible sequence.
   */
  getTx(txid: string): Promise<EsploraTx>;
}

/**
 * Latest mainnet block as the indexer reports it. Carries the height,
 * the 64-hex block hash, the header timestamp (unix seconds), and a
 * server-computed `ageSeconds` for UX convenience (the agent doesn't
 * need to grab system time and subtract). `medianTimePast` and
 * `difficulty` are surfaced when the indexer exposes them — both are
 * standard Esplora fields but we tolerate their absence for self-
 * hosted forks that strip them.
 */
/**
 * Subset of Esplora's per-block JSON we surface for chain-health
 * signals. Standard fields available on every Esplora-compatible
 * indexer (mempool.space, Blockstream, self-hosted Esplora).
 *
 * `pool` is mempool.space-specific (`/v1/blocks/<height>` returns it
 * but standard `/blocks/<startHeight>` does not). Surfaced as optional
 * so the `miner_concentration` signal can degrade gracefully when the
 * indexer doesn't expose pool tags.
 */
export interface BitcoinBlockSummary {
  height: number;
  hash: string;
  timestamp: number;
  txCount: number;
  size: number;
  weight?: number;
  /** Mempool.space `extras.pool.name` (or similar) when the indexer surfaces it. Undefined on plain Esplora. */
  poolName?: string;
}

export interface BitcoinBlockTip {
  /** Block height — e.g. 946598. */
  height: number;
  /** 64-hex block hash. */
  hash: string;
  /** Block header timestamp, unix seconds. */
  timestamp: number;
  /** Server-computed `now - timestamp` at fetch time, in seconds. */
  ageSeconds: number;
  /** BIP-113 median time past, when the indexer exposes it. */
  medianTimePast?: number;
  /** Block difficulty, when the indexer exposes it. */
  difficulty?: number;
}

/**
 * Get the singleton indexer. Delegates to `getEsploraClient("btc")`
 * (issue #716 split-plan cutover — the URL-resolution / retry / HTTP
 * implementation this used to run locally now lives once, shared with
 * Litecoin, in `../utxo/esplora-client.js`). Same singleton instance,
 * same rebuild-on-URL-change behavior as before.
 */
export function getBitcoinIndexer(): BitcoinIndexer {
  return getEsploraClient("btc");
}

/** Test-only — drop the cached indexer so a fresh URL resolution runs. */
export function resetBitcoinIndexer(): void {
  resetEsploraClient("btc");
}
