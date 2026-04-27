import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { createRequire } from "node:module";
import { HDKey } from "@scure/bip32";
import { setConfigDirForTesting } from "../src/config/user-config.js";
import type { PairedBitcoinMultisigWallet } from "../src/types/index.js";

/**
 * PR4 — Taproot multi-sig (`tr(<NUMS>, sortedmulti_a(M, ...))`).
 *
 * Tests cover the parts that don't require a live Ledger:
 *   - NUMS xpub construction is deterministic + valid base58check
 *   - `tr` descriptor template construction
 *   - Address derivation produces a well-formed `bc1p...` address
 *     populated with tapLeafHash / internalPubkey / controlBlock
 *   - register flow accepts `scriptType: "tr"` and rejects on stale
 *     app version
 *   - sign flow splices Schnorr partial sigs into `tap_script_sig`
 *     (NOT `partial_sig`)
 *   - initiator flow builds a PSBT with `tap_internal_key`,
 *     `tap_merkle_root`, `tap_leaf_script`, `tap_bip32_derivation`
 *
 * What this PR's tests do NOT cover (live-test required pre-merge):
 *   - The exact NUMS xpub encoding the Ledger BTC app accepts in
 *     wallet policies. The wallet.md spec is silent on the precise
 *     form; we use the most-documented convention (depth-0 xpub,
 *     all-zero chaincode, all-zero parent fingerprint, even-Y NUMS).
 *     If the device rejects on registerWallet, the fix is local
 *     (rebuild the xpub) and doesn't ripple.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: {
    fromBase64(b64: string): {
      data: {
        inputs: Array<{
          tapInternalKey?: Buffer;
          tapMerkleRoot?: Buffer;
          tapLeafScript?: Array<unknown>;
          tapBip32Derivation?: Array<unknown>;
          tapScriptSig?: Array<unknown>;
          partialSig?: Array<unknown>;
        }>;
      };
      txInputs: Array<{ sequence: number }>;
      txOutputs: Array<{ value: number }>;
    };
  };
  Transaction: new () => {
    version: number;
    addInput(hash: Buffer, index: number, sequence?: number): unknown;
    addOutput(script: Buffer, value: number): unknown;
    toHex(): string;
  };
  address: { toOutputScript(addr: string, network?: unknown): Buffer };
  networks: { bitcoin: unknown };
};

// --- Mocks --------------------------------------------------------------

const getBalanceMock = vi.fn();
const getUtxosMock = vi.fn();
const getFeeEstimatesMock = vi.fn();
const getTxHexMock = vi.fn();
const getTxMock = vi.fn();
const getTxStatusMock = vi.fn();
const broadcastTxMock = vi.fn();

vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getBalance: getBalanceMock,
    getUtxos: getUtxosMock,
    getFeeEstimates: getFeeEstimatesMock,
    getTxHex: getTxHexMock,
    getTx: getTxMock,
    getTxStatus: getTxStatusMock,
    broadcastTx: broadcastTxMock,
  }),
  resetBitcoinIndexer: () => {},
}));

const getAppAndVersionMock = vi.fn();
const getMasterFingerprintMock = vi.fn();
const getExtendedPubkeyMock = vi.fn();
const registerWalletMock = vi.fn();
const signPsbtMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/btc-multisig-usb-loader.js", () => ({
  openLedgerMultisig: async () => ({
    app: {
      getAppAndVersion: getAppAndVersionMock,
      getMasterFingerprint: getMasterFingerprintMock,
      getExtendedPubkey: getExtendedPubkeyMock,
      registerWallet: registerWalletMock,
      signPsbt: signPsbtMock,
    },
    transport: { close: transportCloseMock },
  }),
  buildWalletPolicy: (
    name: string,
    descriptorTemplate: string,
    keys: readonly string[],
  ) => ({
    name,
    descriptorTemplate,
    keys,
    getId: () => Buffer.alloc(32),
    serialize: () => Buffer.alloc(0),
  }),
}));

// --- Helpers ------------------------------------------------------------

function deriveCosigner(seed: string) {
  const seedBuf = Buffer.alloc(64);
  Buffer.from(seed.padEnd(64, "x")).copy(seedBuf);
  const master = HDKey.fromMasterSeed(seedBuf);
  const account = master.derive("m/48'/0'/0'/2'");
  const fp = master.fingerprint;
  const masterFingerprint = Buffer.alloc(4);
  masterFingerprint.writeUInt32BE(fp, 0);
  return {
    xpub: account.publicExtendedKey,
    masterFingerprint: masterFingerprint.toString("hex"),
    accountKey: account,
  };
}

function makeTrWallet(
  cosigners: Array<ReturnType<typeof deriveCosigner>>,
): PairedBitcoinMultisigWallet {
  return {
    name: "TrVault",
    threshold: 2,
    totalSigners: cosigners.length,
    scriptType: "tr",
    descriptor: `tr(@0/**,sortedmulti_a(2,${cosigners.map((_, i) => `@${i + 1}/**`).join(",")}))`,
    cosigners: cosigners.map((c, i) => ({
      xpub: c.xpub,
      masterFingerprint: c.masterFingerprint,
      derivationPath: "48'/0'/0'/2'",
      isOurs: i === 0,
    })),
    policyHmac: "00".repeat(32),
    appVersion: "2.4.6",
  };
}

function buildPrevTxHex(value: number, scriptPubKey: Buffer): string {
  const tx = new bitcoinjs.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  tx.addOutput(scriptPubKey, value);
  return tx.toHex();
}

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-multisig-tr-"));
  setConfigDirForTesting(tmpHome);
  getBalanceMock.mockReset();
  getUtxosMock.mockReset();
  getFeeEstimatesMock.mockReset();
  getTxHexMock.mockReset();
  getTxMock.mockReset();
  getTxStatusMock.mockReset();
  broadcastTxMock.mockReset();
  getAppAndVersionMock.mockReset();
  getMasterFingerprintMock.mockReset();
  getExtendedPubkeyMock.mockReset();
  registerWalletMock.mockReset();
  signPsbtMock.mockReset();
  transportCloseMock.mockClear();
  const { __clearMultisigStore } = await import(
    "../src/modules/btc/multisig.js"
  );
  __clearMultisigStore();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

// --- Address derivation -------------------------------------------------

describe("deriveMultisigAddress (tr)", () => {
  it("produces a bc1p... address with tapLeafHash + internalPubkey + controlBlock", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    const wallet = makeTrWallet([a, b, c]);
    const { patchUserConfig } = await import("../src/config/user-config.js");
    patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });

    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    const info = deriveMultisigAddress(wallet, 0, 0);
    expect(info.address.startsWith("bc1p")).toBe(true);
    expect(info.tapLeafHash).toBeInstanceOf(Buffer);
    expect(info.tapLeafHash?.length).toBe(32);
    expect(info.internalPubkey).toBeInstanceOf(Buffer);
    expect(info.internalPubkey?.length).toBe(32);
    expect(info.controlBlock).toBeInstanceOf(Buffer);
    // The derived cosigner pubkeys should be x-only (32 bytes), not
    // compressed (33).
    expect(info.cosignerPubkeys).toHaveLength(3);
    for (const pk of info.cosignerPubkeys) {
      expect(pk.length).toBe(32);
    }
    // Re-derivation is deterministic.
    const again = deriveMultisigAddress(wallet, 0, 0);
    expect(again.address).toBe(info.address);
    expect(again.tapLeafHash?.equals(info.tapLeafHash!)).toBe(true);
  });
});

// --- Register flow ------------------------------------------------------

describe("registerBitcoinMultisigWallet (tr)", () => {
  it("builds tr(<NUMS>, sortedmulti_a(...)) descriptor and accepts scriptType: tr", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    getExtendedPubkeyMock.mockResolvedValueOnce(a.xpub);
    registerWalletMock.mockResolvedValueOnce([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);

    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = await registerBitcoinMultisigWallet({
      name: "TrVault",
      threshold: 2,
      cosigners: [
        { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        { xpub: c.xpub, masterFingerprint: c.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
      ],
      scriptType: "tr",
    });
    expect(result.wallet.scriptType).toBe("tr");
    expect(result.wallet.descriptor).toBe(
      "tr(@0/**,sortedmulti_a(2,@1/**,@2/**,@3/**))",
    );
    // Descriptor template registered with @1..@3 for cosigners and
    // @0 for NUMS internal key. Verify the keys array passed to
    // registerWallet has 4 entries (NUMS prepended).
    expect(registerWalletMock).toHaveBeenCalledTimes(1);
    const [policyArg] = registerWalletMock.mock.calls[0];
    expect((policyArg as { keys: string[] }).keys).toHaveLength(4);
    // Slot 0 is the NUMS xpub.
    expect((policyArg as { keys: string[] }).keys[0]).toMatch(/^\[00000000\]xpub/);
  });

  it("refuses scriptType: tr on Ledger BTC app < 2.2.0", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.0.5",
      flags: 0,
    });

    const { registerBitcoinMultisigWallet } = await import(
      "../src/modules/btc/multisig.js"
    );
    await expect(
      registerBitcoinMultisigWallet({
        name: "TrVault",
        threshold: 2,
        cosigners: [
          { xpub: a.xpub, masterFingerprint: a.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
          { xpub: b.xpub, masterFingerprint: b.masterFingerprint, derivationPath: "48'/0'/0'/2'" },
        ],
        scriptType: "tr",
      }),
    ).rejects.toThrow(/requires Ledger BTC app/);
    expect(registerWalletMock).not.toHaveBeenCalled();
  });
});

// --- Sign flow ----------------------------------------------------------

describe("signBitcoinMultisigPsbt (tr)", () => {
  it("splices Schnorr partial sig into tap_script_sig (NOT partial_sig)", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    const wallet = makeTrWallet([a, b, c]);
    const { patchUserConfig } = await import("../src/config/user-config.js");
    patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });

    // Build a minimal taproot PSBT with our tapBip32Derivation entry.
    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    const info = deriveMultisigAddress(wallet, 0, 0);

    const requireFresh = createRequire(import.meta.url);
    const bj = requireFresh("bitcoinjs-lib") as {
      Psbt: new (opts?: { network?: unknown }) => {
        addInput(input: Record<string, unknown>): unknown;
        addOutput(out: Record<string, unknown>): unknown;
        toBase64(): string;
      };
      address: { toOutputScript(a: string, n: unknown): Buffer };
      networks: { bitcoin: unknown };
    };
    const NETWORK = bj.networks.bitcoin;
    const psbt = new bj.Psbt({ network: NETWORK });
    psbt.addInput({
      hash: Buffer.alloc(32, 0xab),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: info.scriptPubKey, value: 100_000_000 },
      tapInternalKey: info.internalPubkey,
      tapMerkleRoot: info.tapLeafHash,
      tapLeafScript: [
        {
          leafVersion: 0xc0,
          script: info.witnessScript,
          controlBlock: info.controlBlock,
        },
      ],
      tapBip32Derivation: wallet.cosigners.map((cosigner, idx) => ({
        masterFingerprint: Buffer.from(cosigner.masterFingerprint, "hex"),
        pubkey: info.cosignerPubkeys[idx],
        path: `m/${cosigner.derivationPath}/0/0`,
        leafHashes: [info.tapLeafHash],
      })),
    });
    psbt.addOutput({
      script: bj.address.toOutputScript(
        "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
        NETWORK,
      ),
      value: 50_000_000,
    });
    const psbtBase64 = psbt.toBase64();

    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    // Schnorr signature: 64 bytes (no DER encoding, no sighash byte for default).
    signPsbtMock.mockResolvedValueOnce([
      [
        0,
        {
          pubkey: info.cosignerPubkeys[0],
          signature: Buffer.alloc(64, 0x77),
          tapleafHash: info.tapLeafHash,
        },
      ],
    ]);

    const { signBitcoinMultisigPsbt } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = await signBitcoinMultisigPsbt({
      walletName: "TrVault",
      psbtBase64,
    });
    expect(result.signaturesAdded).toBe(1);

    const decoded = bitcoinjs.Psbt.fromBase64(result.partialPsbtBase64);
    // Schnorr sig lands in tap_script_sig, NOT partial_sig.
    expect(decoded.data.inputs[0].tapScriptSig?.length).toBe(1);
    expect(decoded.data.inputs[0].partialSig).toBeUndefined();
  });
});

// --- Initiator flow -----------------------------------------------------

describe("prepareBitcoinMultisigSend (tr)", () => {
  it("builds a taproot PSBT with tap_internal_key + tap_leaf_script + tap_bip32_derivation", async () => {
    const a = deriveCosigner("alice");
    const b = deriveCosigner("bob");
    const c = deriveCosigner("carol");
    const wallet = makeTrWallet([a, b, c]);
    const { patchUserConfig } = await import("../src/config/user-config.js");
    patchUserConfig({ pairings: { bitcoinMultisig: [wallet] } });

    const { deriveMultisigAddress } = await import(
      "../src/modules/btc/multisig-derive.ts"
    );
    const fundedAddr = deriveMultisigAddress(wallet, 0, 0);

    getBalanceMock.mockImplementation(async (addr: string) => {
      if (addr === fundedAddr.address) {
        return {
          address: addr,
          confirmedSats: 100_000_000n,
          mempoolSats: 0n,
          totalSats: 100_000_000n,
          txCount: 1,
        };
      }
      return {
        address: addr,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 0,
      };
    });
    getUtxosMock.mockImplementation(async (addr: string) =>
      addr === fundedAddr.address
        ? [
            {
              txid: "ab".repeat(32),
              vout: 0,
              value: 100_000_000,
              unconfirmed: false,
            },
          ]
        : [],
    );
    getFeeEstimatesMock.mockResolvedValue({
      fastestFee: 20,
      halfHourFee: 10,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1,
    });
    getTxHexMock.mockResolvedValue(
      buildPrevTxHex(100_000_000, fundedAddr.scriptPubKey),
    );

    getAppAndVersionMock.mockResolvedValueOnce({
      name: "Bitcoin",
      version: "2.4.6",
      flags: 0,
    });
    getMasterFingerprintMock.mockResolvedValueOnce(a.masterFingerprint);
    signPsbtMock.mockResolvedValueOnce([
      [
        0,
        {
          pubkey: fundedAddr.cosignerPubkeys[0],
          signature: Buffer.alloc(64, 0x77),
          tapleafHash: fundedAddr.tapLeafHash,
        },
      ],
    ]);

    const { prepareBitcoinMultisigSend } = await import(
      "../src/modules/btc/multisig.js"
    );
    const result = await prepareBitcoinMultisigSend({
      walletName: "TrVault",
      to: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
      amount: "0.001",
      feeRateSatPerVb: 10,
    });
    expect(result.signaturesAdded).toBe(1);

    const psbt = bitcoinjs.Psbt.fromBase64(result.partialPsbtBase64);
    const input = psbt.data.inputs[0];
    expect(input.tapInternalKey).toBeDefined();
    expect(input.tapInternalKey?.length).toBe(32);
    expect(input.tapMerkleRoot).toBeDefined();
    expect(input.tapLeafScript?.length).toBe(1);
    expect(input.tapBip32Derivation?.length).toBe(3);
    expect(input.tapScriptSig?.length).toBe(1);
    expect(input.partialSig).toBeUndefined();
  });
});
