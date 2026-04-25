/**
 * Bitcoin mainnet configuration.
 *
 * Bitcoin is UTXO-based (not account-based), addresses are base58/bech32
 * (no `0x` prefix), no smart contracts on L1. The server treats Bitcoin
 * as strictly additive — existing EVM modules never see Bitcoin, and the
 * Bitcoin code lives in `src/modules/btc/`.
 */

/**
 * Default indexer endpoint — mempool.space's free public API. No API key
 * needed for personal-volume usage. Per-IP soft rate limit, generous in
 * practice. Override via `BITCOIN_INDEXER_URL` env var or
 * `userConfig.bitcoinIndexerUrl` (set up in PR1; the env var is read at
 * indexer construction time).
 *
 * For self-hosted Esplora / Electrs the URL just needs to expose the same
 * REST surface — mempool.space's API is a fork of Blockstream Esplora's,
 * which is what the indexer abstraction is modeled on.
 */
export const BITCOIN_DEFAULT_INDEXER_URL = "https://mempool.space/api";

/** Native asset metadata. */
export const BTC_DECIMALS = 8; // 1 BTC = 100_000_000 satoshis
export const BTC_SYMBOL = "BTC";
export const SATS_PER_BTC = 100_000_000n;
