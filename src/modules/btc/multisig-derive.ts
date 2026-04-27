import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import type { PairedBitcoinMultisigWallet } from "../../types/index.js";

/**
 * Address derivation for registered multi-sig wallets. Pure crypto —
 * no device touch, no indexer call. Used by PR2's balance/UTXO readers
 * and (when those land) PR3's initiator flow.
 *
 * For a `wsh(sortedmulti(M, @0/**, @1/**, ..., @N/**))` descriptor:
 *   1. Derive each cosigner's compressed pubkey at the (chain, index) leaf
 *      from their stored xpub via `@scure/bip32`.
 *   2. Sort lexicographically (sortedmulti requirement).
 *   3. Build the witnessScript:
 *        OP_M <pubkey1> <pubkey2> ... <pubkeyN> OP_N OP_CHECKMULTISIG
 *   4. Wrap in P2WSH (sha256 of the script + bech32 encoding).
 *
 * Phase 3 PR2 supports `wsh` only. PR4 adds `tr` (taproot script-path).
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  payments: {
    p2wsh(opts: {
      redeem: { output: Buffer };
      network?: unknown;
    }): { output?: Buffer; address?: string };
    p2tr(opts: {
      internalPubkey?: Buffer;
      scriptTree?: { output: Buffer };
      redeem?: { output: Buffer; redeemVersion?: number };
      network?: unknown;
    }): {
      output?: Buffer;
      address?: string;
      witness?: Buffer[];
      hash?: Buffer;
    };
  };
  initEccLib(eccLib: unknown): void;
  script: { compile(chunks: Array<number | Buffer>): Buffer };
  opcodes: Record<string, number>;
  networks: { bitcoin: unknown };
};

/**
 * Initialize bitcoinjs-lib's ECC library so taproot constructions
 * (`p2tr`, BIP-341 tweak math) work. Without this, the `p2tr` payment
 * builder throws "No ECC Library provided" — taproot needs a
 * `xOnlyPointAddTweak` implementation that's not bundled with
 * bitcoinjs-lib by default.
 *
 * `@bitcoinerlab/secp256k1` is a pure-JS, tiny-secp256k1-compatible
 * ECC backend already present in the dep tree (transitive via
 * `ledger-bitcoin`). One-time init at module load is the standard
 * pattern.
 */
let eccInitialized = false;
function ensureEccInitialized(): void {
  if (eccInitialized) return;
  const ecc = requireCjs("@bitcoinerlab/secp256k1");
  bitcoinjs.initEccLib(ecc);
  eccInitialized = true;
}

const NETWORK = bitcoinjs.networks.bitcoin;

/** Look up an OP_n opcode (1..16). Throws on out-of-range. */
function opN(n: number): number {
  if (n < 1 || n > 16 || !Number.isInteger(n)) {
    throw new Error(`OP_n out of range: ${n} (must be integer 1..16).`);
  }
  // OP_1 = 0x51, OP_2 = 0x52, ..., OP_16 = 0x60.
  return 0x50 + n;
}

/**
 * Derive one cosigner's compressed (33-byte) pubkey at the given
 * (chain, index) leaf from their stored xpub. Throws on derivation
 * failure (corrupt xpub or xpub not at the expected level).
 */
export function deriveCosignerPubkey(
  xpub: string,
  change: number,
  addressIndex: number,
): Buffer {
  let hd: HDKey;
  try {
    hd = HDKey.fromExtendedKey(xpub);
  } catch (err) {
    throw new Error(
      `Cosigner xpub failed to parse: ${(err as Error).message}. The descriptor ` +
        `may have been corrupted in storage.`,
    );
  }
  const child = hd.derive(`m/${change}/${addressIndex}`);
  if (!child.publicKey) {
    throw new Error(
      `Cosigner xpub derivation produced no pubkey at /${change}/${addressIndex}.`,
    );
  }
  // @scure/bip32's publicKey is already the 33-byte compressed form
  // for non-taproot keys — what bitcoinjs-lib expects.
  return Buffer.from(child.publicKey);
}

export interface MultisigAddressInfo {
  /** The bech32(m) address (`bc1q...` for P2WSH, `bc1p...` for taproot). */
  address: string;
  /** scriptPubKey bytes (witness program). */
  scriptPubKey: Buffer;
  /** Script bytes — `OP_M <p1>...<pN> OP_N OP_CHECKMULTISIG` (P2WSH) or
   * the leaf script `<p1> CHECKSIG <p2> CHECKSIGADD ... <M> EQUAL` (P2TR). */
  witnessScript: Buffer;
  /** Compressed (P2WSH) or x-only (P2TR) cosigner pubkeys at this leaf, in slot order (NOT sorted). */
  cosignerPubkeys: Buffer[];
  /** Taproot-only: tapleaf hash for the script-path branch. Undefined for P2WSH. */
  tapLeafHash?: Buffer;
  /** Taproot-only: x-only NUMS internal key. Undefined for P2WSH. */
  internalPubkey?: Buffer;
  /** Taproot-only: control block witness for spending the script-path. Undefined for P2WSH. */
  controlBlock?: Buffer;
}

/** BIP-341 NUMS x-only public key (lift_x(SHA256(G))). */
const NUMS_XONLY = Buffer.from(
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
  "hex",
);

/** Convert a 33-byte compressed pubkey to its 32-byte x-only form. */
function toXOnly(pubkey: Buffer): Buffer {
  if (pubkey.length === 33) return pubkey.subarray(1);
  if (pubkey.length === 32) return pubkey;
  throw new Error(`Unexpected pubkey length ${pubkey.length} (want 32 or 33).`);
}

/**
 * Build the BIP-342 leaf script for a taproot `sortedmulti_a` policy:
 *   <p1_xonly> OP_CHECKSIG <p2_xonly> OP_CHECKSIGADD ... <pN_xonly> OP_CHECKSIGADD <M> OP_NUMEQUAL
 *
 * Pubkeys must be supplied lex-sorted (the `sortedmulti_a` invariant).
 */
function buildSortedmultiALeafScript(
  threshold: number,
  sortedXOnlyPubkeys: Buffer[],
): Buffer {
  const chunks: Array<number | Buffer> = [];
  for (let i = 0; i < sortedXOnlyPubkeys.length; i++) {
    chunks.push(sortedXOnlyPubkeys[i]);
    chunks.push(i === 0 ? bitcoinjs.opcodes.OP_CHECKSIG : bitcoinjs.opcodes.OP_CHECKSIGADD);
  }
  // OP_M for threshold (1..16 → 0x51..0x60).
  chunks.push(opN(threshold));
  chunks.push(bitcoinjs.opcodes.OP_NUMEQUAL);
  return bitcoinjs.script.compile(chunks);
}

/**
 * Derive the multi-sig address at the given (change, addressIndex) leaf
 * for a registered wallet. Pure crypto.
 *
 * Phase 3 PR2 supports `scriptType === "wsh"` only. Adding `tr` is the
 * job of PR4.
 */
export function deriveMultisigAddress(
  wallet: PairedBitcoinMultisigWallet,
  change: 0 | 1,
  addressIndex: number,
): MultisigAddressInfo {
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error(
      `addressIndex must be a non-negative integer, got ${addressIndex}.`,
    );
  }
  if (wallet.scriptType === "tr") {
    return deriveTaprootMultisigAddress(wallet, change, addressIndex);
  }
  // 1. Derive each cosigner's pubkey at the leaf.
  const cosignerPubkeys = wallet.cosigners.map((c) =>
    deriveCosignerPubkey(c.xpub, change, addressIndex),
  );
  // 2. sortedmulti = lexicographic sort of pubkeys.
  const sorted = [...cosignerPubkeys].sort(Buffer.compare);
  // 3. Build witnessScript.
  const witnessScript = bitcoinjs.script.compile([
    opN(wallet.threshold),
    ...sorted,
    opN(wallet.totalSigners),
    bitcoinjs.opcodes.OP_CHECKMULTISIG,
  ]);
  // 4. Wrap in P2WSH.
  const p2wsh = bitcoinjs.payments.p2wsh({
    redeem: { output: witnessScript },
    network: NETWORK,
  });
  if (!p2wsh.output || !p2wsh.address) {
    throw new Error(
      `Internal error: bitcoinjs.payments.p2wsh returned undefined output/address ` +
        `for wallet "${wallet.name}" at leaf ${change}/${addressIndex}.`,
    );
  }
  return {
    address: p2wsh.address,
    scriptPubKey: p2wsh.output,
    witnessScript,
    cosignerPubkeys,
  };
}

/**
 * Taproot script-path multisig address derivation:
 *   `tr(<NUMS>, sortedmulti_a(M, @1/**, ..., @N/**))`.
 *
 * NUMS internal key has no known private key, so the only spend path
 * is via the leaf script (M-of-N CHECKSIGADD). The leaf script uses
 * x-only pubkeys (32 bytes), sorted lexicographically.
 *
 * Returns the bech32m address (`bc1p...`), the leaf script bytes,
 * x-only cosigner pubkeys (slot order), the tapleaf hash, the
 * internal pubkey (NUMS), and the control block needed to spend.
 */
function deriveTaprootMultisigAddress(
  wallet: PairedBitcoinMultisigWallet,
  change: 0 | 1,
  addressIndex: number,
): MultisigAddressInfo {
  ensureEccInitialized();
  // 1. Derive cosigner compressed pubkeys, then convert to x-only.
  const compressedPubkeys = wallet.cosigners.map((c) =>
    deriveCosignerPubkey(c.xpub, change, addressIndex),
  );
  const xOnlyPubkeys = compressedPubkeys.map(toXOnly);
  // 2. sortedmulti_a = lex sort of x-only pubkeys.
  const sorted = [...xOnlyPubkeys].sort(Buffer.compare);
  // 3. Build the leaf script.
  const leafScript = buildSortedmultiALeafScript(wallet.threshold, sorted);
  // 4. Construct P2TR with NUMS internal key + script tree.
  const p2tr = bitcoinjs.payments.p2tr({
    internalPubkey: NUMS_XONLY,
    scriptTree: { output: leafScript },
    redeem: { output: leafScript, redeemVersion: 0xc0 },
    network: NETWORK,
  });
  if (!p2tr.output || !p2tr.address) {
    throw new Error(
      `Internal error: bitcoinjs.payments.p2tr returned undefined output/address ` +
        `for wallet "${wallet.name}" at leaf ${change}/${addressIndex}.`,
    );
  }
  // The control block is the last witness element bitcoinjs assembled
  // for the script-path spend (witness = [...script_args, leafScript, controlBlock]).
  // Tests + finalize don't strictly need it on the address itself, but
  // we surface it for the initiator flow's PSBT field population.
  const controlBlock =
    p2tr.witness && p2tr.witness.length > 0
      ? p2tr.witness[p2tr.witness.length - 1]
      : undefined;
  return {
    address: p2tr.address,
    scriptPubKey: p2tr.output,
    witnessScript: leafScript,
    // For taproot, surface the x-only forms (matches what
    // sortedmulti_a uses on-chain). Keep slot order, not sorted.
    cosignerPubkeys: xOnlyPubkeys,
    tapLeafHash: p2tr.hash,
    internalPubkey: NUMS_XONLY,
    ...(controlBlock !== undefined ? { controlBlock } : {}),
  };
}
