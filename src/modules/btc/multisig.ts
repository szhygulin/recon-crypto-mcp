import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { HDKey } from "@scure/bip32";
import {
  patchUserConfig,
  readUserConfig,
  getConfigPath,
} from "../../config/user-config.js";
import {
  buildWalletPolicy,
  openLedgerMultisig,
  type BtcMultisigAppClient,
  type BtcMultisigPartialSignature,
  type BtcMultisigWalletPolicy,
} from "../../signing/btc-multisig-usb-loader.js";
import type {
  PairedBitcoinMultisigCosigner,
  PairedBitcoinMultisigWallet,
} from "../../types/index.js";
import { BTC_DECIMALS, SATS_PER_BTC } from "../../config/btc.js";
import { getBitcoinIndexer, type BitcoinUtxo } from "./indexer.js";
import { deriveMultisigAddress } from "./multisig-derive.js";
import {
  getMultisigUtxos,
  type MultisigUtxo,
} from "./multisig-balance.js";

/**
 * Bitcoin multi-sig co-signer flow. Phase 2 PR2 of the BTC Ledger
 * roadmap. We act as ONE of N signers in a multi-sig wallet — the
 * initiator (Sparrow / Specter / Caravan / a peer running this same
 * server) builds the tx and produces a PSBT; the user passes the PSBT
 * here, this module signs with the Ledger key, returns the partial PSBT
 * for the user to share back. Combination + finalization + broadcast
 * happens externally (deferred to a future PR — PSBT-combine is what
 * external coordinators already do well).
 *
 * Two tools are exposed via this module:
 *   - `register_btc_multisig_wallet` — one-time per setup. Builds a
 *     `wsh(sortedmulti(M, @0/**, @1/**, ...))` descriptor, calls Ledger's
 *     `registerWallet` (the device walks every cosigner xpub fingerprint
 *     on-screen for verification), persists the descriptor + 32-byte
 *     policy HMAC. The HMAC is reused on every subsequent signature
 *     call so the user only walks the descriptor approval flow once
 *     per setup.
 *   - `sign_btc_multisig_psbt` — adds our signature to a multi-sig PSBT.
 *     Looks up the registered wallet by name, decodes the PSBT,
 *     validates inputs/outputs against the policy, calls the device
 *     (the device walks every output address + amount on-screen),
 *     splices our partial signature into the PSBT, returns it.
 *
 * Phase 2 scope: P2WSH (`wsh(sortedmulti(...))`) only. Taproot multi-sig
 * (`tr(multi_a(...))`) and `sh(wsh(...))` wrapped multi-sig are
 * deferred — small audience, distinct script types.
 */

// --- bitcoinjs-lib loader (CommonJS-only) ---------------------------------

const requireCjs = createRequire(import.meta.url);
interface PsbtInputDataShape {
  witnessScript?: Buffer;
  bip32Derivation?: Array<{
    masterFingerprint: Buffer;
    pubkey: Buffer;
    path: string;
  }>;
  partialSig?: Array<{ pubkey: Buffer; signature: Buffer }>;
  witnessUtxo?: { script: Buffer; value: number };
  nonWitnessUtxo?: Buffer;
  tapInternalKey?: Buffer;
  tapMerkleRoot?: Buffer;
  tapLeafScript?: Array<{
    leafVersion: number;
    script: Buffer;
    controlBlock: Buffer;
  }>;
  tapBip32Derivation?: Array<{
    masterFingerprint: Buffer;
    pubkey: Buffer;
    path: string;
    leafHashes: Buffer[];
  }>;
  tapScriptSig?: Array<{
    pubkey: Buffer;
    signature: Buffer;
    leafHash: Buffer;
  }>;
}

interface PsbtInstance {
  data: { inputs: PsbtInputDataShape[]; outputs: Array<unknown> };
  txInputs: Array<{ hash: Buffer; index: number; sequence: number }>;
  txOutputs: Array<{ address?: string; value: number }>;
  addInput(input: {
    hash: string | Buffer;
    index: number;
    sequence?: number;
    witnessUtxo?: { script: Buffer; value: number };
    witnessScript?: Buffer;
    nonWitnessUtxo?: Buffer;
    bip32Derivation?: Array<{
      masterFingerprint: Buffer;
      pubkey: Buffer;
      path: string;
    }>;
    tapInternalKey?: Buffer;
    tapMerkleRoot?: Buffer;
    tapLeafScript?: Array<{
      leafVersion: number;
      script: Buffer;
      controlBlock: Buffer;
    }>;
    tapBip32Derivation?: Array<{
      masterFingerprint: Buffer;
      pubkey: Buffer;
      path: string;
      leafHashes: Buffer[];
    }>;
  }): unknown;
  addOutput(output: { address?: string; script?: Buffer; value: number }): unknown;
  updateInput(
    i: number,
    update: { partialSig: Array<{ pubkey: Buffer; signature: Buffer }> },
  ): unknown;
  toBase64(): string;
}

const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    new (opts?: { network?: unknown }): PsbtInstance;
    fromBase64(b64: string): PsbtInstance;
  };
  address: { toOutputScript(addr: string, network?: unknown): Buffer };
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjs.networks.bitcoin;

// --- Constants ------------------------------------------------------------

/** Ledger BTC app caps wallet-policy names at 16 ASCII bytes. */
const MULTISIG_NAME_MAX_BYTES = 16;
/** Ledger BTC app supports up to 15 cosigners in a wallet policy. */
const MAX_COSIGNERS = 15;
/** Sortedmulti needs at least 1-of-2 (1-of-1 is single-sig with extra steps). */
const MIN_COSIGNERS = 2;

// --- In-memory store + persistence ----------------------------------------

const multisigByName = new Map<string, PairedBitcoinMultisigWallet>();
let multisigHydrated = false;

function ensureMultisigHydrated(): void {
  if (multisigHydrated) return;
  multisigHydrated = true;
  const persisted = readUserConfig()?.pairings?.bitcoinMultisig ?? [];
  for (const entry of persisted) {
    multisigByName.set(entry.name, entry);
  }
}

function persistMultisig(): void {
  patchUserConfig({
    pairings: { bitcoinMultisig: Array.from(multisigByName.values()) },
  });
}

export function getPairedMultisigWallets(): PairedBitcoinMultisigWallet[] {
  ensureMultisigHydrated();
  return Array.from(multisigByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getPairedMultisigByName(
  name: string,
): PairedBitcoinMultisigWallet | null {
  ensureMultisigHydrated();
  return multisigByName.get(name) ?? null;
}

/** Test-only — drops every cached entry. */
export function __clearMultisigStore(): void {
  multisigByName.clear();
  multisigHydrated = false;
  if (existsSync(getConfigPath())) {
    patchUserConfig({ pairings: { bitcoinMultisig: [] } });
  }
}

// --- Validation helpers ---------------------------------------------------

/**
 * Validate a hex-encoded master fingerprint. Ledger surfaces it as 8
 * lowercase hex chars (4 bytes); we accept upper/lower and normalize.
 */
function normalizeMasterFingerprint(raw: string, ctx: string): string {
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{8}$/.test(trimmed)) {
    throw new Error(
      `${ctx}: masterFingerprint "${raw}" is not 8 hex characters (4 bytes).`,
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Validate a BIP-32 derivation path with no leading `m/`. Hardened
 * markers must be `'` (apostrophe), each segment ≤ 2^31 - 1.
 */
function validateDerivationPath(raw: string, ctx: string): void {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${ctx}: derivationPath must be a non-empty string.`);
  }
  if (raw.startsWith("m/") || raw.startsWith("/")) {
    throw new Error(
      `${ctx}: derivationPath must not start with "m/" or "/" — got "${raw}".`,
    );
  }
  for (const seg of raw.split("/")) {
    const stripped = seg.endsWith("'") ? seg.slice(0, -1) : seg;
    if (!/^\d+$/.test(stripped)) {
      throw new Error(
        `${ctx}: derivationPath segment "${seg}" is not a non-negative integer.`,
      );
    }
    const n = Number(stripped);
    if (n < 0 || n >= 0x80000000) {
      throw new Error(
        `${ctx}: derivationPath segment ${seg} is out of range (0..2^31-1).`,
      );
    }
  }
}

/**
 * Round-trip an xpub through `@scure/bip32` to weed out checksum errors.
 * Memory: a typo silently registers a wrong wallet that can never sign,
 * so we want HARD validation here.
 */
function validateXpub(xpub: string, ctx: string): void {
  if (typeof xpub !== "string" || xpub.length === 0) {
    throw new Error(`${ctx}: xpub must be a non-empty string.`);
  }
  try {
    HDKey.fromExtendedKey(xpub);
  } catch (err) {
    throw new Error(
      `${ctx}: xpub failed checksum validation — likely a typo. ` +
        `Original error: ${(err as Error).message}`,
    );
  }
}

/**
 * Format one cosigner's key string for the Ledger BTC app's wallet
 * policy: `[<masterFingerprint>/<derivationPath>]<xpub>`.
 */
function formatPolicyKey(c: PairedBitcoinMultisigCosigner): string {
  return `[${c.masterFingerprint}/${c.derivationPath}]${c.xpub}`;
}

/**
 * Build the descriptor template string for a P2WSH sortedmulti policy:
 * `wsh(sortedmulti(<M>,@0/**,@1/**,...,@{N-1}/**))`.
 */
function buildWshSortedmultiDescriptor(
  threshold: number,
  cosignerCount: number,
): string {
  const slots = Array.from({ length: cosignerCount }, (_, i) => `@${i}/**`).join(",");
  return `wsh(sortedmulti(${threshold},${slots}))`;
}

/**
 * BIP-341 NUMS x-only public key. Defined as `lift_x(SHA256(G))` where
 * G is the secp256k1 generator. Provably has no known private key —
 * used as the taproot internal key when the wallet is script-path-only
 * (no key-path spend allowed).
 *
 * Hex from BIP-341 specification; same point Sparrow / Specter /
 * miniscript.fyi all use for "no key-path" taproot multi-sig.
 */
const NUMS_XONLY_HEX =
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

/**
 * Construct a BIP-32 xpub-form serialization of the NUMS point. The
 * Ledger wallet-policy parser only accepts xpubs in key info (raw
 * x-only points are not in the documented grammar), so we wrap NUMS
 * as a depth-0 xpub with a deterministic chaincode (all zeros) and
 * even-Y compressed form (0x02 prefix).
 *
 * NOTE: this NUMS encoding is NOT verified against a live Ledger BTC
 * app at the time of this PR — the documentation is silent on the
 * precise NUMS form expected. Live testing is required before merging.
 * If this encoding is rejected, the fix is local (rebuild the xpub
 * with a different chaincode / parent fingerprint convention) and
 * doesn't ripple through the rest of the multi-sig code.
 */
function buildNumsXpub(): string {
  const xonly = Buffer.from(NUMS_XONLY_HEX, "hex");
  // BIP-340 x-only points are conventionally even-Y; prefix with 0x02.
  const compressedPubkey = Buffer.concat([Buffer.from([0x02]), xonly]);
  // BIP-32 serialized public key: 78 bytes.
  const buf = Buffer.alloc(78);
  // Mainnet xpub version (0x0488B21E).
  buf.writeUInt32BE(0x0488b21e, 0);
  // Depth = 0 (master).
  buf.writeUInt8(0, 4);
  // Parent fingerprint = 0x00000000 (master has no parent).
  buf.writeUInt32BE(0, 5);
  // Child number = 0.
  buf.writeUInt32BE(0, 9);
  // Chain code: all zeros (no known precedent for non-zero NUMS chaincode).
  // (offsets 13..44 already zeroed by Buffer.alloc)
  // Public key at offset 45 (33 bytes).
  compressedPubkey.copy(buf, 45);
  // base58check encode.
  return base58CheckEncode(buf);
}

const NUMS_XPUB = buildNumsXpub();

/**
 * Build the descriptor template string for a taproot sortedmulti_a
 * policy: `tr(@0/**, sortedmulti_a(<M>, @1/**, @2/**, ..., @N/**))`.
 *
 * Slot @0 is the NUMS internal key (provably unspendable key-path).
 * Slots @1..@N are the user cosigners. The Ledger BTC app's wallet
 * policy parser accepts `tr(KP, TREE)` with `multi_a` / `sortedmulti_a`
 * fragments inside `TREE` (verified against app-bitcoin-new/doc/wallet.md).
 */
function buildTrSortedmultiADescriptor(
  threshold: number,
  cosignerCount: number,
): string {
  const slots = Array.from(
    { length: cosignerCount },
    (_, i) => `@${i + 1}/**`,
  ).join(",");
  return `tr(@0/**,sortedmulti_a(${threshold},${slots}))`;
}

/** Build the per-cosigner key info string for the wallet policy. */
function buildPolicyKeysForWallet(
  scriptType: "wsh" | "tr",
  cosigners: PairedBitcoinMultisigCosigner[],
): string[] {
  const cosignerKeys = cosigners.map(formatPolicyKey);
  if (scriptType === "wsh") return cosignerKeys;
  // tr: prepend NUMS as slot @0, cosigners shift to @1..@N.
  return [`[00000000]${NUMS_XPUB}`, ...cosignerKeys];
}

/** Pick the descriptor builder for a given script type. */
function buildDescriptorTemplate(
  scriptType: "wsh" | "tr",
  threshold: number,
  cosignerCount: number,
): string {
  if (scriptType === "wsh") {
    return buildWshSortedmultiDescriptor(threshold, cosignerCount);
  }
  return buildTrSortedmultiADescriptor(threshold, cosignerCount);
}

/** base58check encoder (BIP-32 xpub serialization). */
function base58CheckEncode(payload: Buffer): string {
  const crypto = requireCjs("node:crypto") as {
    createHash(alg: string): { update(b: Buffer): { digest(): Buffer } };
  };
  const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest();
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  const full = Buffer.concat([payload, checksum]);
  return base58Encode(full);
}

/** Minimal base58 encoder (avoids pulling in another dep). */
function base58Encode(buffer: Buffer): string {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let intVal = 0n;
  for (const byte of buffer) intVal = (intVal << 8n) + BigInt(byte);
  let out = "";
  while (intVal > 0n) {
    const rem = intVal % 58n;
    intVal /= 58n;
    out = ALPHABET[Number(rem)] + out;
  }
  // Leading zero bytes → leading '1's.
  for (const byte of buffer) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out;
}

/**
 * Min Ledger BTC app version that supports `sortedmulti_a` in wallet
 * policies. Per LedgerHQ release notes, taproot policies landed in
 * v2.1.0 and `sortedmulti_a` shortly after; v2.2.0 is the safe lower
 * bound for the taproot multi-sig flows in this PR.
 *
 * NOT verified against a live device at this PR's time of writing —
 * if the live app rejects on a 2.2.x version, raise this constant
 * accordingly.
 */
const MIN_TR_APP_VERSION = "2.2.0";

/** Compare app versions as `major.minor.patch` triples. Returns -1/0/1. */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.split(".").map((n) => parseInt(n, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// --- register_btc_multisig_wallet ----------------------------------------

export interface RegisterBitcoinMultisigWalletArgs {
  name: string;
  threshold: number;
  cosigners: Array<{
    xpub: string;
    masterFingerprint: string;
    derivationPath: string;
  }>;
  scriptType: "wsh" | "tr";
}

export interface RegisterBitcoinMultisigWalletResult {
  wallet: PairedBitcoinMultisigWallet;
  /** Ledger app version observed at registration time. */
  appVersion: string;
  /** Index of the user's slot in `cosigners` (0-indexed). */
  ourKeyIndex: number;
}

export async function registerBitcoinMultisigWallet(
  args: RegisterBitcoinMultisigWalletArgs,
): Promise<RegisterBitcoinMultisigWalletResult> {
  // 1. Argument validation — every refusal here is BEFORE we touch the device.
  if (typeof args.name !== "string" || args.name.length === 0) {
    throw new Error("`name` must be a non-empty ASCII string.");
  }
  // ASCII only; the Ledger device limits the on-screen label to 16 BYTES.
  if (!/^[\x20-\x7e]+$/.test(args.name)) {
    throw new Error(
      `\`name\` must be printable ASCII only (got "${args.name}").`,
    );
  }
  if (Buffer.byteLength(args.name, "utf-8") > MULTISIG_NAME_MAX_BYTES) {
    throw new Error(
      `\`name\` is ${Buffer.byteLength(args.name, "utf-8")} bytes — Ledger BTC app caps ` +
        `wallet-policy names at ${MULTISIG_NAME_MAX_BYTES} bytes. Shorten it.`,
    );
  }
  if (args.scriptType !== "wsh" && args.scriptType !== "tr") {
    throw new Error(
      `\`scriptType\` "${args.scriptType}" is not supported — accepted: "wsh" (P2WSH) ` +
        `or "tr" (taproot script-path with NUMS internal key). P2SH-wrapped multi-sig ` +
        `is out of scope.`,
    );
  }
  if (
    !Number.isInteger(args.threshold) ||
    args.threshold < 1 ||
    args.threshold > MAX_COSIGNERS
  ) {
    throw new Error(
      `\`threshold\` must be an integer between 1 and ${MAX_COSIGNERS} — got ${args.threshold}.`,
    );
  }
  if (!Array.isArray(args.cosigners)) {
    throw new Error("`cosigners` must be an array.");
  }
  if (args.cosigners.length < MIN_COSIGNERS) {
    throw new Error(
      `\`cosigners\` must have at least ${MIN_COSIGNERS} entries (got ${args.cosigners.length}). ` +
        `1-of-1 multi-sig is single-sig with extra steps; use \`prepare_btc_send\` instead.`,
    );
  }
  if (args.cosigners.length > MAX_COSIGNERS) {
    throw new Error(
      `\`cosigners\` has ${args.cosigners.length} entries — Ledger BTC app caps wallet ` +
        `policies at ${MAX_COSIGNERS} keys.`,
    );
  }
  if (args.threshold > args.cosigners.length) {
    throw new Error(
      `\`threshold\` ${args.threshold} exceeds cosigner count ${args.cosigners.length}.`,
    );
  }

  // 2. Validate every cosigner entry; weed out duplicate xpubs (the
  //    Ledger app doesn't allow the same key twice in a policy).
  const seenXpubs = new Set<string>();
  const validatedCosigners: PairedBitcoinMultisigCosigner[] = args.cosigners.map(
    (c, i) => {
      const ctx = `cosigners[${i}]`;
      const masterFingerprint = normalizeMasterFingerprint(c.masterFingerprint, ctx);
      validateDerivationPath(c.derivationPath, ctx);
      validateXpub(c.xpub, ctx);
      if (seenXpubs.has(c.xpub)) {
        throw new Error(
          `${ctx}: xpub appears more than once in \`cosigners\`. Each slot must be a ` +
            `distinct key.`,
        );
      }
      seenXpubs.add(c.xpub);
      return {
        xpub: c.xpub,
        masterFingerprint,
        derivationPath: c.derivationPath,
        isOurs: false, // patched after device probe.
      };
    },
  );

  // 3. Reject duplicate name (would silently overwrite the existing entry).
  ensureMultisigHydrated();
  if (multisigByName.has(args.name)) {
    throw new Error(
      `Multi-sig wallet "${args.name}" is already registered. Pick a different name, ` +
        `or call a (future) \`unregister_btc_multisig_wallet\` first.`,
    );
  }

  // 4. Open the device, identify which cosigner slot is ours, register
  //    the policy. Every device touch lives inside try/finally so we
  //    never leak the HID descriptor on error.
  const { app, transport } = await openLedgerMultisig();
  let result: RegisterBitcoinMultisigWalletResult;
  try {
    const appInfo = await app.getAppAndVersion();
    if (appInfo.name !== "Bitcoin") {
      throw new Error(
        `The wrong Ledger app is open (got "${appInfo.name}"). Open the Bitcoin app ` +
          `on the device and retry.`,
      );
    }
    if (
      args.scriptType === "tr" &&
      compareSemver(appInfo.version, MIN_TR_APP_VERSION) < 0
    ) {
      throw new Error(
        `Taproot multi-sig (\`scriptType: "tr"\`) requires Ledger BTC app ` +
          `≥ ${MIN_TR_APP_VERSION}; the connected device has ${appInfo.version}. ` +
          `Update the BTC app via Ledger Live before retrying.`,
      );
    }
    const ourFingerprint = (await app.getMasterFingerprint()).toLowerCase();
    const candidates = validatedCosigners.filter(
      (c) => c.masterFingerprint === ourFingerprint,
    );
    if (candidates.length === 0) {
      throw new Error(
        `The connected Ledger's master fingerprint ${ourFingerprint} does not appear in ` +
          `\`cosigners\`. This Ledger is NOT a signer in the proposed wallet — refusing ` +
          `to register a policy we can never sign with.`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `Master fingerprint ${ourFingerprint} appears in multiple \`cosigners\` entries ` +
          `— ambiguous. Each Ledger fingerprint must occupy at most one slot.`,
      );
    }
    const ourEntry = candidates[0];
    // Verify the xpub at the user-supplied derivation path matches the
    // device-derived xpub. Catches typos in the cosigner's xpub field
    // even when fingerprints happen to match (extremely unlikely
    // collision, but cheap to check).
    const deviceXpub = await app.getExtendedPubkey(ourEntry.derivationPath, false);
    if (deviceXpub !== ourEntry.xpub) {
      throw new Error(
        `Cosigner xpub for fingerprint ${ourFingerprint} (path ${ourEntry.derivationPath}) ` +
          `does not match the Ledger-derived xpub. Expected ${deviceXpub}, got ${ourEntry.xpub}. ` +
          `Likely a copy-paste error in the cosigner's xpub field.`,
      );
    }
    const ourKeyIndex = validatedCosigners.indexOf(ourEntry);
    validatedCosigners[ourKeyIndex].isOurs = true;

    // 5. Construct + register the wallet policy.
    const descriptorTemplate = buildDescriptorTemplate(
      args.scriptType,
      args.threshold,
      validatedCosigners.length,
    );
    const policyKeys = buildPolicyKeysForWallet(args.scriptType, validatedCosigners);
    const walletPolicy = buildWalletPolicy(args.name, descriptorTemplate, policyKeys);
    // The device walks every cosigner xpub fingerprint on-screen. The
    // user MUST verify each fingerprint matches what they expect (this
    // is the moment that anchors the policy — a malicious server could
    // otherwise swap an xpub for one whose private key it controls).
    const [, hmacBuf] = await app.registerWallet(walletPolicy);

    const wallet: PairedBitcoinMultisigWallet = {
      name: args.name,
      threshold: args.threshold,
      totalSigners: validatedCosigners.length,
      scriptType: args.scriptType,
      descriptor: descriptorTemplate,
      cosigners: validatedCosigners,
      policyHmac: hmacBuf.toString("hex"),
      appVersion: appInfo.version,
    };
    multisigByName.set(args.name, wallet);
    persistMultisig();

    result = { wallet, appVersion: appInfo.version, ourKeyIndex };
  } finally {
    await transport.close().catch(() => {});
  }
  return result;
}

// --- sign_btc_multisig_psbt ----------------------------------------------

export interface SignBitcoinMultisigPsbtArgs {
  walletName: string;
  psbtBase64: string;
}

export interface SignBitcoinMultisigPsbtResult {
  partialPsbtBase64: string;
  /** Number of signatures we added (always 1 in this flow). */
  signaturesAdded: number;
  /** Total signatures present after our addition. */
  signaturesPresent: number;
  /** Threshold M from the registered policy. */
  signaturesNeeded: number;
  /** True iff `signaturesPresent >= signaturesNeeded` on every input. */
  fullySigned: boolean;
}

/**
 * Validate that every PSBT input carries a `bip32Derivation` entry
 * matching our master fingerprint. This is the chat-side defense against
 * being tricked into signing for a foreign tx — the device does its own
 * deeper validation against the registered policy, but a mismatch we
 * catch here saves a USB round-trip.
 *
 * NOT a replacement for the device-side check: the user is the final
 * authority via the on-device output walkthrough.
 */
function ensurePsbtMatchesOurKey(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
  ourFingerprint: string,
): void {
  const ourFpBuf = Buffer.from(ourFingerprint, "hex");
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const input = psbt.data.inputs[i];
    // P2WSH inputs carry derivations in `bip32Derivation`; taproot
    // script-path inputs carry them in `tapBip32Derivation`. Either is
    // sufficient evidence that our key is among the signers.
    const ecdsaDerivations = input.bip32Derivation ?? [];
    const tapDerivations = input.tapBip32Derivation ?? [];
    const hasOurs =
      ecdsaDerivations.some((d) => d.masterFingerprint.equals(ourFpBuf)) ||
      tapDerivations.some((d) => d.masterFingerprint.equals(ourFpBuf));
    if (!hasOurs) {
      throw new Error(
        `PSBT input ${i} has no bip32_derivation (ECDSA or taproot) entry for our ` +
          `master fingerprint ${ourFingerprint}. Either this PSBT belongs to a ` +
          `different wallet (refusing to forward to the device) or the initiator ` +
          `built it without our xpub. Verify the PSBT comes from a coordinator ` +
          `that knows about this Ledger.`,
      );
    }
  }
}

/**
 * Splice ledger-bitcoin's PartialSignature output into the PSBT.
 *
 * Two paths:
 *  - **P2WSH multi-sig** (no tapleafHash): standard ECDSA signature →
 *    PSBT input's `partialSig` field.
 *  - **Taproot script-path multi-sig** (tapleafHash present): Schnorr
 *    signature → PSBT input's `tapScriptSig` field (BIP-371).
 *
 * Both update via bitcoinjs-lib's `psbt.updateInput`. The tap path
 * uses the field name `tapScriptSig`, which bip174's converter accepts
 * as `{pubkey, signature, leafHash}` triples.
 */
function applyPartialSignatures(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
  sigs: Array<[number, BtcMultisigPartialSignature]>,
): number {
  let added = 0;
  for (const [inputIdx, partial] of sigs) {
    if (partial.tapleafHash !== undefined) {
      // Taproot script-path: splice into tapScriptSig.
      (psbt as unknown as {
        updateInput(
          i: number,
          update: {
            tapScriptSig: Array<{
              pubkey: Buffer;
              signature: Buffer;
              leafHash: Buffer;
            }>;
          },
        ): unknown;
      }).updateInput(inputIdx, {
        tapScriptSig: [
          {
            pubkey: partial.pubkey,
            signature: partial.signature,
            leafHash: partial.tapleafHash,
          },
        ],
      });
    } else {
      // P2WSH: standard ECDSA partialSig.
      psbt.updateInput(inputIdx, {
        partialSig: [{ pubkey: partial.pubkey, signature: partial.signature }],
      });
    }
    added += 1;
  }
  return added;
}

/**
 * For each input, count how many distinct signatures are present (post-
 * splice). Used to derive `signaturesPresent` and `fullySigned`.
 * Counts both ECDSA `partialSig` (P2WSH path) and Schnorr `tapScriptSig`
 * (taproot script-path) entries.
 */
function minSignatureCount(
  psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const input of psbt.data.inputs) {
    const inputWithTap = input as {
      partialSig?: Array<unknown>;
      tapScriptSig?: Array<unknown>;
    };
    const ecdsaCount = inputWithTap.partialSig?.length ?? 0;
    const schnorrCount = inputWithTap.tapScriptSig?.length ?? 0;
    const count = ecdsaCount + schnorrCount;
    if (count < min) min = count;
  }
  return Number.isFinite(min) ? min : 0;
}

export async function signBitcoinMultisigPsbt(
  args: SignBitcoinMultisigPsbtArgs,
): Promise<SignBitcoinMultisigPsbtResult> {
  if (typeof args.walletName !== "string" || args.walletName.length === 0) {
    throw new Error("`walletName` must be a non-empty string.");
  }
  if (typeof args.psbtBase64 !== "string" || args.psbtBase64.length === 0) {
    throw new Error("`psbtBase64` must be a non-empty base64 string.");
  }

  // 1. Look up the registered wallet.
  ensureMultisigHydrated();
  const wallet = multisigByName.get(args.walletName);
  if (!wallet) {
    const available = Array.from(multisigByName.keys());
    throw new Error(
      `No multi-sig wallet registered under name "${args.walletName}". ` +
        (available.length > 0
          ? `Registered names: ${available.join(", ")}.`
          : `No multi-sig wallets registered yet — call \`register_btc_multisig_wallet\` first.`),
    );
  }

  // 2. Decode the PSBT (validates structure).
  let psbt: ReturnType<typeof bitcoinjs.Psbt.fromBase64>;
  try {
    psbt = bitcoinjs.Psbt.fromBase64(args.psbtBase64);
  } catch (err) {
    throw new Error(
      `Failed to decode PSBT: ${(err as Error).message}. The input must be a valid ` +
        `base64-encoded PSBT v0.`,
    );
  }
  if (psbt.data.inputs.length === 0) {
    throw new Error("PSBT has no inputs — refusing to sign.");
  }

  // 3. Re-build the wallet policy from the persisted descriptor + keys.
  //    For taproot wallets, the policy keys array prepends the NUMS
  //    internal key — must match what was passed to registerWallet so
  //    the device's HMAC verifies.
  const policyKeys = buildPolicyKeysForWallet(wallet.scriptType, wallet.cosigners);
  const walletPolicy = buildWalletPolicy(
    wallet.name,
    wallet.descriptor,
    policyKeys,
  );
  const policyHmac = Buffer.from(wallet.policyHmac, "hex");

  // 4. Open device, validate PSBT shape against our key, sign.
  const { app, transport } = await openLedgerMultisig();
  let result: SignBitcoinMultisigPsbtResult;
  try {
    const appInfo = await app.getAppAndVersion();
    if (appInfo.name !== "Bitcoin") {
      throw new Error(
        `The wrong Ledger app is open (got "${appInfo.name}"). Open the Bitcoin app ` +
          `on the device and retry.`,
      );
    }
    const deviceFingerprint = (await app.getMasterFingerprint()).toLowerCase();
    const ourCosigner = wallet.cosigners.find((c) => c.isOurs);
    if (!ourCosigner) {
      throw new Error(
        `Internal error: registered wallet "${wallet.name}" has no cosigner flagged ` +
          `\`isOurs\`. Re-register via \`register_btc_multisig_wallet\`.`,
      );
    }
    if (deviceFingerprint !== ourCosigner.masterFingerprint) {
      throw new Error(
        `Connected Ledger's master fingerprint ${deviceFingerprint} does not match the ` +
          `fingerprint stored for "${wallet.name}" (${ourCosigner.masterFingerprint}). ` +
          `Either the wrong Ledger is plugged in, or the registered wallet was created ` +
          `with a different device — refusing to forward the PSBT.`,
      );
    }
    ensurePsbtMatchesOurKey(psbt, deviceFingerprint);

    // The device walks every output address + amount on-screen. The
    // user MUST verify each output matches the rendered verification
    // block before approving.
    const partialSigs = await app.signPsbt(args.psbtBase64, walletPolicy, policyHmac);
    if (partialSigs.length === 0) {
      throw new Error(
        `Ledger returned zero partial signatures for "${wallet.name}". The device may ` +
          `have been unable to find a derivation path matching our key on any input.`,
      );
    }
    const added = applyPartialSignatures(psbt, partialSigs);
    const signaturesPresent = minSignatureCount(psbt);
    result = {
      partialPsbtBase64: psbt.toBase64(),
      signaturesAdded: added,
      signaturesPresent,
      signaturesNeeded: wallet.threshold,
      fullySigned: signaturesPresent >= wallet.threshold,
    };
  } finally {
    await transport.close().catch(() => {});
  }
  return result;
}

// --- unregister_btc_multisig_wallet --------------------------------------

export interface UnregisterBitcoinMultisigWalletArgs {
  walletName: string;
}

export interface UnregisterBitcoinMultisigWalletResult {
  removed: boolean;
  walletName: string;
}

/**
 * Drop a registered wallet from the local cache. The Ledger device
 * retains the policy HMAC indefinitely (no on-device unregister API),
 * so re-registering with the same descriptor + cosigners returns the
 * same HMAC the device already has — `register_btc_multisig_wallet` is
 * idempotent for the device but re-creates the local cache entry.
 */
export function unregisterBitcoinMultisigWallet(
  args: UnregisterBitcoinMultisigWalletArgs,
): UnregisterBitcoinMultisigWalletResult {
  ensureMultisigHydrated();
  const removed = multisigByName.delete(args.walletName);
  if (removed) persistMultisig();
  return { removed, walletName: args.walletName };
}

// --- prepare_btc_multisig_send (initiator flow) --------------------------

/**
 * Helpers borrowed from src/modules/btc/actions.ts. Duplicated here
 * rather than re-exported to avoid creating a dependency on the
 * single-sig action module.
 */
function satsToBtcString(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = abs - whole * SATS_PER_BTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function parseBtcAmountToSats(amount: string): bigint | null {
  if (amount === "max") return null;
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(
      `Invalid BTC amount "${amount}" — expected a decimal with up to 8 fractional ` +
        `digits (e.g. "0.001", "0.5") or "max" for the full balance minus fees.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(BTC_DECIMALS, "0");
  return BigInt(whole) * SATS_PER_BTC + BigInt(padded);
}

/** Dust threshold (sats) — same constant as the RBF builder. */
const DUST_THRESHOLD_SATS = 546;

/**
 * Per-input vbyte estimate for a P2WSH `sortedmulti(M, ..., N)` spend.
 *
 * Witness stack: empty (CHECKMULTISIG off-by-one) + M sigs (~73B each)
 * + the witness script (3 + 34*N bytes for sortedmulti). Witness data
 * counts at 1/4 weight; non-witness is the standard 41 bytes (outpoint
 * + sequence + empty scriptSig).
 *
 * vsize ≈ ceil((4 * 41 + (1 + 1 + M*(73+1) + 1 + (3 + 34*N)) ) / 4)
 *      ≈ 41 + ceil((6 + 74*M + 34*N) / 4)
 *
 * Conservative-tight: rounds slightly up so the fee-cap stays
 * conservative even when actual sigs are 71-72 bytes (typical) instead
 * of 73 (worst case).
 */
function p2wshMultisigInputVbytes(threshold: number, totalSigners: number): number {
  return 41 + Math.ceil((6 + 74 * threshold + 34 * totalSigners) / 4);
}

/**
 * Taproot script-path multisig (`tr(<NUMS>, sortedmulti_a(M, ..., N))`)
 * input vbytes:
 *   non-witness: 41 (outpoint + sequence + empty scriptSig)
 *   witness:
 *     - count byte (1)
 *     - M Schnorr sigs (65 bytes each: 1 length + 64 sig)
 *       (assumes all M signers signed; non-signers contribute 0x00 byte
 *        empty placeholder — bitcoinjs-lib's finalizer fills both)
 *     - N - M empty placeholders × ~1 byte each (CHECKSIGADD requires
 *       a stack item per pubkey; non-signers push empty)
 *     - script: 1 + 1 + N × (32 + 1) + 1 + 1 + 1 = 4 + 33*N bytes
 *     - control block: 1 + (1 + 32 + 32 × tree_depth) — single-leaf, depth=0,
 *       so 1 + 33 = 34 bytes
 * vsize ≈ 41 + ceil((1 + 65*M + (N - M) + 4 + 33*N + 34) / 4)
 *      = 41 + ceil((40 + 64*M + 34*N) / 4)
 */
function trMultisigInputVbytes(threshold: number, totalSigners: number): number {
  return 41 + Math.ceil((40 + 64 * threshold + 34 * totalSigners) / 4);
}

function multisigInputVbytes(wallet: PairedBitcoinMultisigWallet): number {
  return wallet.scriptType === "tr"
    ? trMultisigInputVbytes(wallet.threshold, wallet.totalSigners)
    : p2wshMultisigInputVbytes(wallet.threshold, wallet.totalSigners);
}

/** Mainnet recipient output: covers P2WPKH (31) / P2WSH (43) / P2TR (43). Conservative pick. */
const STANDARD_OUTPUT_VBYTES = 43;

/** Tx overhead: 4 version + 4 locktime + 1 input-count + 1 output-count + 2 segwit marker/flag (×0.25 weight). */
const TX_OVERHEAD_VBYTES = 11;

function estimateMultisigTxVbytes(
  inputCount: number,
  outputCount: number,
  wallet: PairedBitcoinMultisigWallet,
): number {
  return (
    TX_OVERHEAD_VBYTES +
    inputCount * multisigInputVbytes(wallet) +
    outputCount * STANDARD_OUTPUT_VBYTES
  );
}

/**
 * Greedy largest-first coin selection over multi-sig UTXOs. Returns
 * the selected inputs + computed fee + change value. Refuses with a
 * clear "insufficient funds" error when no subset covers
 * `amountSats + fee`.
 *
 * We do NOT use the `coinselect` library here because its vbyte
 * estimator is hardcoded for P2WPKH (~68 vbytes per input) and
 * underestimates multi-sig by 2-3×. A custom estimator is small enough
 * that re-implementing accumulative selection is simpler than trying
 * to convince `coinselect` of the right per-input weight.
 */
function selectMultisigInputs(
  utxos: MultisigUtxo[],
  wallet: PairedBitcoinMultisigWallet,
  recipientAmountSats: bigint,
  feeRateSatPerVb: number,
  hasChange: boolean,
): {
  selected: MultisigUtxo[];
  feeSats: bigint;
  changeSats: bigint;
  vsize: number;
} {
  // Largest-first to minimize input count.
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  let totalIn = 0n;
  const selected: MultisigUtxo[] = [];
  for (const u of sorted) {
    selected.push(u);
    totalIn += BigInt(u.value);
    const outputCount = hasChange ? 2 : 1;
    const vsize = estimateMultisigTxVbytes(
      selected.length,
      outputCount,
      wallet,
    );
    const feeSats = BigInt(Math.ceil(feeRateSatPerVb * vsize));
    const need = recipientAmountSats + feeSats;
    if (totalIn >= need) {
      const changeSats = totalIn - need;
      // If we asked for change but it would be dust, retry without change
      // (the dust value is then added to the fee).
      if (hasChange && changeSats < BigInt(DUST_THRESHOLD_SATS)) {
        const noChangeVsize = estimateMultisigTxVbytes(
          selected.length,
          1,
          wallet,
        );
        const noChangeFee = BigInt(Math.ceil(feeRateSatPerVb * noChangeVsize));
        if (totalIn >= recipientAmountSats + noChangeFee) {
          return {
            selected,
            feeSats: totalIn - recipientAmountSats,
            changeSats: 0n,
            vsize: noChangeVsize,
          };
        }
        // Couldn't even afford no-change layout — keep accumulating.
        continue;
      }
      return {
        selected,
        feeSats,
        changeSats: hasChange ? changeSats : 0n,
        vsize,
      };
    }
  }
  throw new Error(
    `Insufficient funds: total UTXO value across all walked addresses cannot cover ` +
      `${recipientAmountSats} sats + estimated fee at ${feeRateSatPerVb} sat/vB. ` +
      `Add funds to the wallet or wait for more confirmations.`,
  );
}

/**
 * Find the lowest chain=1 (change) addressIndex that has NO on-chain
 * history. Used as the change destination for a new send. We re-derive
 * locally and call `getBalance` for each — same gap-limit walk as the
 * balance reader, just stopping at the first empty.
 */
async function findUnusedChangeIndex(
  wallet: PairedBitcoinMultisigWallet,
): Promise<{ address: string; addressIndex: number }> {
  const indexer = getBitcoinIndexer();
  // Hard cap: don't walk past 1000 indices. If you have 1000 used
  // change addresses on a multi-sig wallet, something pathological is
  // going on.
  for (let i = 0; i < 1000; i++) {
    const info = deriveMultisigAddress(wallet, 1, i);
    const bal = await indexer.getBalance(info.address);
    if (
      bal.txCount === 0 &&
      bal.confirmedSats === 0n &&
      bal.mempoolSats === 0n
    ) {
      return { address: info.address, addressIndex: i };
    }
  }
  throw new Error(
    `Could not find an unused chain=1 (change) address within the first 1000 indices ` +
      `of "${wallet.name}". The wallet's change-chain history is implausibly long.`,
  );
}

export interface PrepareBitcoinMultisigSendArgs {
  walletName: string;
  to: string;
  amount: string; // decimal-BTC string ("0.001") or "max"
  feeRateSatPerVb?: number;
  allowHighFee?: boolean;
}

export interface PrepareBitcoinMultisigSendResult {
  /** PSBT carrying our Ledger signature on every input. Share with cosigners → combine → finalize. */
  partialPsbtBase64: string;
  /** Number of signatures we just added (typically `inputCount × 1`). */
  signaturesAdded: number;
  /** Min signatures present across inputs after our addition. */
  signaturesPresent: number;
  /** Threshold M from the policy. */
  signaturesNeeded: number;
  /** True iff our sig completed the threshold on every input. */
  fullySigned: boolean;
  walletName: string;
  /** Resolved recipient address (post address-book / ENS). */
  to: string;
  /** Total recipient value, sats. */
  recipientSats: string;
  /** Total recipient value, decimal-BTC string for display. */
  recipientBtc: string;
  /** Computed absolute fee, sats. */
  feeSats: string;
  /** Same fee as decimal-BTC string. */
  feeBtc: string;
  /** Fee rate used (sat/vB). */
  feeRateSatPerVb: number;
  /** Estimated tx vsize (vbytes). */
  vsize: number;
  /** Change address selected (chain=1, unused). Undefined when there's no change output. */
  changeAddress?: string;
  /** Change value (sats). 0 when there's no change output (dust-absorbed by fee). */
  changeSats: string;
  /** Rendered description for the verification block. */
  description: string;
}

export async function prepareBitcoinMultisigSend(
  args: PrepareBitcoinMultisigSendArgs,
): Promise<PrepareBitcoinMultisigSendResult> {
  // 1. Look up registered wallet.
  const wallet = getPairedMultisigByName(args.walletName);
  if (!wallet) {
    const available = Array.from(multisigByName.keys());
    throw new Error(
      `No multi-sig wallet registered under name "${args.walletName}". ` +
        (available.length > 0
          ? `Registered: ${available.join(", ")}.`
          : `Call \`register_btc_multisig_wallet\` first.`),
    );
  }
  if (wallet.scriptType !== "wsh" && wallet.scriptType !== "tr") {
    throw new Error(
      `prepare_btc_multisig_send: scriptType "${wallet.scriptType}" not supported.`,
    );
  }

  // 2. Resolve recipient (address-book + ENS shim).
  const { resolveRecipient } = await import("../../contacts/resolver.js");
  const resolved = await resolveRecipient(args.to, "bitcoin");
  const resolvedTo = resolved.address;

  // 3. Resolve fee rate (default to indexer's halfHourFee, ~3-block target).
  const indexer = getBitcoinIndexer();
  let feeRate: number;
  if (args.feeRateSatPerVb !== undefined) {
    feeRate = args.feeRateSatPerVb;
  } else {
    const fees = await indexer.getFeeEstimates();
    feeRate = fees.halfHourFee;
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0 || feeRate > 10_000) {
    throw new Error(
      `Resolved fee rate ${feeRate} sat/vB is invalid (expected positive ≤ 10000).`,
    );
  }

  // 4. Fetch UTXOs across the multi-sig wallet's gap-limit window.
  const { utxos } = await getMultisigUtxos({ walletName: args.walletName });
  if (utxos.length === 0) {
    throw new Error(
      `No UTXOs found in "${args.walletName}". Verify with \`get_btc_multisig_balance\` ` +
        `and confirm at least one tx has confirmed.`,
    );
  }

  // 5. Resolve "max" → fee-aware amount, else parse decimal-BTC → sats.
  let amountSats: bigint;
  if (args.amount === "max") {
    const totalUtxoValue = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    const maxVsize = estimateMultisigTxVbytes(utxos.length, 1, wallet);
    const maxFee = BigInt(Math.ceil(feeRate * maxVsize));
    if (totalUtxoValue <= maxFee) {
      throw new Error(
        `Cannot "max": total UTXO value ${satsToBtcString(totalUtxoValue)} BTC is at or ` +
          `below the estimated fee ${satsToBtcString(maxFee)} BTC at ${feeRate} sat/vB. ` +
          `Lower the feeRate or wait for more confirmations.`,
      );
    }
    amountSats = totalUtxoValue - maxFee;
  } else {
    const parsed = parseBtcAmountToSats(args.amount);
    if (parsed === null) {
      throw new Error(`Internal: parseBtcAmountToSats null for ${args.amount}`);
    }
    amountSats = parsed;
  }
  if (amountSats <= 0n) {
    throw new Error(`Resolved amount ${amountSats} sats is not positive.`);
  }

  // 6. Resolve unused change address (chain=1).
  const change = await findUnusedChangeIndex(wallet);

  // 7. Coin-select.
  const isMax = args.amount === "max";
  const selection = selectMultisigInputs(
    utxos,
    wallet,
    amountSats,
    feeRate,
    !isMax, // "max" sweeps everything → no change.
  );

  // 8. Fee-cap guard — same shape as `selectInputs`'s cap.
  if (!args.allowHighFee) {
    const vbyteCap = Math.ceil(feeRate * 10 * selection.vsize);
    const percentCap = Math.ceil(Number(amountSats) * 0.02);
    const cap = Math.max(vbyteCap, percentCap);
    if (selection.feeSats > BigInt(cap)) {
      throw new Error(
        `Fee ${selection.feeSats} sats exceeds safety cap ${cap} sats ` +
          `(max of 10× feeRate-based ${vbyteCap} and 2%-of-output ${percentCap}). ` +
          `If intentional (priority send through congestion), retry with allowHighFee: true.`,
      );
    }
  }

  // 9. Fetch prev-tx hex for every UNIQUE input txid (Ledger app 2.x
  //    requirement — issue #213).
  const uniqueTxids = [...new Set(selection.selected.map((u) => u.txid))];
  const prevTxHexEntries = await Promise.all(
    uniqueTxids.map(async (txid) => [txid, await indexer.getTxHex(txid)] as const),
  );
  const prevTxHexByTxid = new Map(prevTxHexEntries);

  // 10. Build PSBT. Each input carries witnessUtxo + nonWitnessUtxo +
  //     witnessScript + bip32_derivation for ALL cosigners (so each
  //     cosigner's wallet can find its own derivation path on signing).
  const psbt = new bitcoinjs.Psbt({ network: NETWORK });
  for (const utxo of selection.selected) {
    const prevTxHex = prevTxHexByTxid.get(utxo.txid);
    if (!prevTxHex) {
      throw new Error(
        `Internal: prev-tx hex missing for ${utxo.txid} after fan-out fetch.`,
      );
    }
    if (wallet.scriptType === "tr") {
      // Taproot script-path input: tap_bip32_derivation (with leaf
      // hashes), tap_internal_key, tap_merkle_root, tap_leaf_script.
      // No `bip32Derivation` / `witnessScript` (those are P2WSH-side).
      // No `nonWitnessUtxo` — taproot sighashes commit to input amount,
      // so the device verifies amounts from `witnessUtxo` directly.
      if (
        !utxo.tapLeafHash ||
        !utxo.internalPubkey ||
        !utxo.controlBlock
      ) {
        throw new Error(
          `Internal: taproot UTXO at ${utxo.txid}:${utxo.vout} is missing tapLeafHash / ` +
            `internalPubkey / controlBlock. The derivation path may not have populated them.`,
        );
      }
      const leafHash = utxo.tapLeafHash;
      const tapBip32Derivation = wallet.cosigners.map((c, idx) => ({
        masterFingerprint: Buffer.from(c.masterFingerprint, "hex"),
        pubkey: utxo.cosignerPubkeys[idx], // x-only (32 bytes) for taproot
        path: `m/${c.derivationPath}/${utxo.chain}/${utxo.addressIndex}`,
        leafHashes: [leafHash],
      }));
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { script: utxo.scriptPubKey, value: utxo.value },
        tapInternalKey: utxo.internalPubkey,
        tapMerkleRoot: utxo.tapLeafHash,
        tapLeafScript: [
          {
            leafVersion: 0xc0, // BIP-342 leaf version.
            script: utxo.witnessScript,
            controlBlock: utxo.controlBlock,
          },
        ],
        tapBip32Derivation,
      });
    } else {
      // P2WSH multi-sig input.
      const bip32Derivation = wallet.cosigners.map((c, idx) => ({
        masterFingerprint: Buffer.from(c.masterFingerprint, "hex"),
        pubkey: utxo.cosignerPubkeys[idx],
        // Full path including the leaf — the Ledger app requires the
        // leading `m/` and the per-cosigner derivationPath, then the
        // /<chain>/<index> tail at this UTXO's leaf.
        path: `m/${c.derivationPath}/${utxo.chain}/${utxo.addressIndex}`,
      }));
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        sequence: 0xfffffffd, // RBF-eligible.
        witnessUtxo: { script: utxo.scriptPubKey, value: utxo.value },
        nonWitnessUtxo: Buffer.from(prevTxHex, "hex"),
        witnessScript: utxo.witnessScript,
        bip32Derivation,
      });
    }
  }
  // Recipient output.
  psbt.addOutput({
    script: bitcoinjs.address.toOutputScript(resolvedTo, NETWORK),
    value: Number(amountSats),
  });
  // Change output (when present).
  if (selection.changeSats > 0n) {
    psbt.addOutput({
      script: bitcoinjs.address.toOutputScript(change.address, NETWORK),
      value: Number(selection.changeSats),
    });
  }
  const psbtBase64 = psbt.toBase64();

  // 11. Sign with our Ledger via the existing co-signer flow. This
  //     does the device touch + splice in one place.
  const signed = await signBitcoinMultisigPsbt({
    walletName: args.walletName,
    psbtBase64,
  });

  const recipientDisplay = resolved.label
    ? `${resolved.label} (${resolvedTo})`
    : resolvedTo;
  const description =
    `Multi-sig send from "${args.walletName}" (${wallet.threshold}-of-${wallet.totalSigners} ` +
    `${wallet.scriptType}): ${satsToBtcString(amountSats)} BTC → ${recipientDisplay}. ` +
    `Our signature added: ${signed.signaturesPresent}/${signed.signaturesNeeded} present.`;

  return {
    partialPsbtBase64: signed.partialPsbtBase64,
    signaturesAdded: signed.signaturesAdded,
    signaturesPresent: signed.signaturesPresent,
    signaturesNeeded: signed.signaturesNeeded,
    fullySigned: signed.fullySigned,
    walletName: args.walletName,
    to: resolvedTo,
    recipientSats: amountSats.toString(),
    recipientBtc: satsToBtcString(amountSats),
    feeSats: selection.feeSats.toString(),
    feeBtc: satsToBtcString(selection.feeSats),
    feeRateSatPerVb: feeRate,
    vsize: selection.vsize,
    ...(selection.changeSats > 0n ? { changeAddress: change.address } : {}),
    changeSats: selection.changeSats.toString(),
    description,
  };
}
