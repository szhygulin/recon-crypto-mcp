import { createRequire } from "node:module";

/**
 * Loader for the `ledger-bitcoin` multi-sig client (BIP-388 wallet
 * policies). This is a SEPARATE package from `@ledgerhq/hw-app-btc` —
 * single-sig flows use the legacy SDK because that's what `pair_ledger_btc`
 * + `prepare_btc_send` already speak; multi-sig needs the newer
 * `AppClient` because only it exposes `registerWallet` + `signPsbt`
 * with a `WalletPolicy` argument.
 *
 * Both clients share `@ledgerhq/hw-transport-node-hid`. We open a
 * dedicated transport for each multi-sig call; HID transports are
 * exclusive (one process can hold one device descriptor at a time), so
 * the legacy single-sig path and this multi-sig path can't be
 * concurrent — they're not in this server's flow anyway (each tool call
 * opens, talks, closes).
 *
 * Isolating the `require()` here lets tests
 * `vi.mock("../signing/btc-multisig-usb-loader.js")` with a fake
 * `openLedgerMultisig()` and avoid touching the SDK entirely.
 */

export interface BtcMultisigPartialSignature {
  pubkey: Buffer;
  signature: Buffer;
  tapleafHash?: Buffer;
}

export interface BtcMultisigWalletPolicy {
  readonly name: string;
  readonly descriptorTemplate: string;
  readonly keys: readonly string[];
  getId(): Buffer;
  serialize(): Buffer;
}

export interface BtcMultisigAppClient {
  /**
   * Standard Ledger app-info call. Used to confirm the user has the
   * Bitcoin app (not Ethereum / Litecoin / dashboard) open before
   * issuing wallet-policy commands.
   */
  getAppAndVersion(): Promise<{ name: string; version: string; flags: number | Buffer }>;
  /**
   * 4-byte master fingerprint, returned as 8 lowercase hex chars.
   * Used by registration to match the user's slot among the cosigners.
   */
  getMasterFingerprint(): Promise<string>;
  /**
   * Derive an xpub at the given BIP-32 path. `display: false` for
   * standard paths (silent); `true` shows the path on-device for
   * verification (we use `false` — the device already verifies the
   * descriptor on registerWallet).
   */
  getExtendedPubkey(path: string, display?: boolean): Promise<string>;
  /**
   * Register a wallet policy with the device. The user walks every
   * cosigner xpub fingerprint on-device. Returns `[id, hmac]`; the
   * hmac is the per-setup token every subsequent `signPsbt` requires.
   */
  registerWallet(walletPolicy: BtcMultisigWalletPolicy): Promise<readonly [Buffer, Buffer]>;
  /**
   * Sign a PSBT with a registered wallet policy. The device walks
   * every output (address + amount) on-screen and asks for confirmation
   * (the policy was already approved at registration; only outputs are
   * re-verified per signature). Returns the partial signatures keyed
   * by input index — caller splices them into the PSBT and re-serializes.
   */
  signPsbt(
    psbt: string | Buffer,
    walletPolicy: BtcMultisigWalletPolicy,
    walletHMAC: Buffer | null,
    progressCallback?: () => void,
  ): Promise<Array<[number, BtcMultisigPartialSignature]>>;
}

export interface BtcMultisigTransport {
  close(): Promise<void>;
}

/**
 * Construction shape from `ledger-bitcoin`. We keep this typed locally
 * so tests don't have to model the full library surface.
 */
interface AppClientCtor {
  new (transport: unknown): BtcMultisigAppClient;
}
interface WalletPolicyCtor {
  new (
    name: string,
    descriptorTemplate: string,
    keys: readonly string[],
  ): BtcMultisigWalletPolicy;
}

const requireCjs = createRequire(import.meta.url);

/**
 * Construct a `WalletPolicy` for the multi-sig descriptor. Returns the
 * `ledger-bitcoin` instance the AppClient methods accept.
 *
 * `keys` follow the `[<masterFingerprint>/<derivationPath>]<xpub>` shape
 * the Ledger BTC app requires (one entry per cosigner, in slot order).
 * `descriptorTemplate` references the keys by `@N` (0-indexed).
 */
export function buildWalletPolicy(
  name: string,
  descriptorTemplate: string,
  keys: readonly string[],
): BtcMultisigWalletPolicy {
  const { WalletPolicy } = requireCjs("ledger-bitcoin") as {
    WalletPolicy: WalletPolicyCtor;
  };
  return new WalletPolicy(name, descriptorTemplate, keys);
}

/**
 * Open a USB connection to the Ledger BTC app and return an `AppClient`
 * instance plus its underlying transport. Caller MUST close the
 * transport in a `finally` block — HID descriptors are exclusive and
 * leaving one open blocks every subsequent device operation.
 */
export async function openLedgerMultisig(): Promise<{
  app: BtcMultisigAppClient;
  transport: BtcMultisigTransport;
}> {
  const TransportNodeHid = requireCjs("@ledgerhq/hw-transport-node-hid").default;
  const { AppClient } = requireCjs("ledger-bitcoin") as {
    AppClient: AppClientCtor;
  };
  const transport = (await TransportNodeHid.open("")) as BtcMultisigTransport;
  const app = new AppClient(transport);
  return { app, transport };
}
