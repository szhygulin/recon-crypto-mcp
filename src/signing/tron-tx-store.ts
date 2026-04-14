import { randomUUID } from "node:crypto";
import { hexToBytes, toHex } from "viem";
import type { TrustDetails, UnsignedTronTx } from "../types/index.js";
import { tronPayloadFingerprint } from "./pre-sign-check.js";

/**
 * In-memory registry of prepared TRON transactions. Parallel to
 * signing/tx-store.ts but stores `UnsignedTronTx` rather than EVM
 * `UnsignedTx`. Separated deliberately: the EVM send flow runs an
 * eth_call re-simulation, chain-id check, and spender allowlist that are
 * all meaningless on TRON. `send_transaction` routes by which store owns
 * the handle — TRON handles go to the USB HID signer in
 * tron-usb-signer.ts, EVM handles stay on the WalletConnect path.
 *
 * Lifetime matches the EVM store (15 min from issue).
 */
const TX_TTL_MS = 15 * 60_000;

interface StoredTx {
  tx: UnsignedTronTx;
  expiresAt: number;
}

const store = new Map<string, StoredTx>();

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

export function issueTronHandle(tx: UnsignedTronTx): UnsignedTronTx {
  prune();
  // Every action we build for TRON is first verified byte-for-byte against
  // the local protobuf decoder (`assertTronRawDataMatches`), and the TRON
  // Ledger app natively decodes TransferContract / TriggerSmartContract /
  // VoteWitnessContract / FreezeBalanceV2 / UnfreezeBalanceV2 /
  // WithdrawBalance / WithdrawExpireUnfreeze on-device. So the trust
  // classification is unconditional: clear-signable.
  //
  // Caveat documented in README: this assumes the user has the TRON Ledger
  // app loaded, not Ethereum. Wrong app is a connection-layer failure, not
  // a classification failure — the device will refuse to sign.
  const payloadHash = tronPayloadFingerprint(tx.rawDataHex);
  const payloadHashShort = toHex(hexToBytes(payloadHash).subarray(0, 4));
  const trustDetails: TrustDetails = tx.trustDetails ?? {
    reason: `TRON ${tx.action} — on-device decode via TRON Ledger app; protobuf verified locally`,
    ledgerPlugin: "TRON",
    payloadHash,
    payloadHashShort,
  };
  const classified: UnsignedTronTx = {
    ...tx,
    trustMode: tx.trustMode ?? "clear-signable",
    trustDetails,
  };
  const handle = randomUUID();
  const withHandle: UnsignedTronTx = { ...classified, handle };
  const { handle: _h, ...stored } = withHandle;
  store.set(handle, { tx: stored as UnsignedTronTx, expiresAt: Date.now() + TX_TTL_MS });
  return withHandle;
}

export function consumeTronHandle(handle: string): UnsignedTronTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired TRON tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run the prepare_tron_* tool for a fresh handle.`
    );
  }
  return entry.tx;
}

export function retireTronHandle(handle: string): void {
  store.delete(handle);
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasTronHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}
