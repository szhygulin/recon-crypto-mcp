/**
 * Canonical address-format RegExps for the three chains we support.
 *
 * Single source of truth so Zod schemas, runtime validators, and config
 * parsers share one pattern per chain. Before this existed, the same three
 * literals were duplicated across ~35 Zod schemas — any tightening meant
 * a find-and-replace sweep, and subtle drift (e.g. a schema accepting 20
 * chars where another required 33) would have been invisible.
 *
 * Patterns match what the target chain considers a well-formed address
 * string for CLIENT-SIDE format validation only. They do NOT verify
 * checksums (EVM EIP-55), base58 decode cleanliness beyond alphabet, or
 * on-chain existence — those are separate, heavier checks done closer to
 * RPC-facing code.
 */

/** EVM address: 0x-prefixed 20-byte hex. Does not check checksum casing. */
export const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** TRON base58-check address: T-prefix, 34 chars total (T + 33 base58). */
export const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** Solana ed25519 pubkey: 43-44 char base58. No prefix. */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
