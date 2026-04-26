/**
 * EVM contacts signer — uses WalletConnect's `personal_sign` (EIP-191)
 * with the hardwired `VaultPilot-contact-v1:` domain prefix.
 *
 * Architectural trade-off (path C from the planning conversation):
 * `personal_sign` is now in `REQUIRED_NAMESPACES.eip155.methods`
 * (`src/signing/walletconnect.ts:79-89`). Once it's in the session
 * scope, ANY caller with access to the live `c.request(...)` can
 * issue a `personal_sign` — not just this file. The mitigation is at
 * the device boundary: the Ledger BTC/Eth app shows the message text
 * on-screen, and the `VaultPilot-contact-v1:` prefix is unique enough
 * that a phishing payload would have to either masquerade as a
 * contacts blob (visible to the user) or ride on a different prefix
 * (also visible). See `SECURITY.md` for the full trade-off.
 *
 * The EVM anchor is the first paired EVM address from the active WC
 * session. We don't restrict by `chain=0` / `addressIndex=0` the way
 * BTC does because Ledger Live exposes only one EVM address per
 * pairing — the user's primary account. If a user has multiple EVM
 * accounts paired in Ledger Live, the first one in the WC session
 * accountsList wins; on read-time verification we re-check that the
 * anchor matches the current session's first account, so a
 * Ledger-Live-account-rotate event would fail re-verification (which
 * is the correct UX — re-add contacts after rotating).
 */
import { getAddress } from "viem";
import {
  getConnectedAccountsDetailed,
  requestPersonalSign,
} from "../../signing/walletconnect.js";
import { ContactsError } from "../../contacts/schemas.js";

export const CONTACTS_DOMAIN_PREFIX_EVM = "VaultPilot-contact-v1:";

export interface EvmAnchor {
  /** Checksum-cased EVM address. */
  address: `0x${string}`;
  /** Synthetic path label — Ledger Live's WC session doesn't expose
   * BIP-32 paths directly. We store the standard HD shape for display
   * only; verification doesn't depend on it. */
  path: string;
}

/**
 * Resolve the active WC session's first EVM account. Throws
 * CONTACTS_LEDGER_NOT_PAIRED when no session is up.
 */
export async function pickEvmAnchor(): Promise<EvmAnchor> {
  const detailed = await getConnectedAccountsDetailed().catch(() => []);
  const first = detailed[0];
  if (!first) {
    throw new Error(
      `${ContactsError.LedgerNotPaired}: no active WalletConnect session. ` +
        `Pair Ledger Live via \`pair_ledger_live\` first.`,
    );
  }
  return {
    address: getAddress(first.address) as `0x${string}`,
    path: "m/44'/60'/0'/0/0",
  };
}

/**
 * Sign the contacts blob preimage on the EVM anchor via WC
 * `personal_sign`. Returns the 0x-prefixed 65-byte hex sig.
 */
export async function signContactsBlobEvm(args: {
  preimage: string;
  anchor: EvmAnchor;
}): Promise<{ signature: `0x${string}` }> {
  const message = `${CONTACTS_DOMAIN_PREFIX_EVM}${args.preimage}`;
  const sig = await requestPersonalSign({
    message,
    from: args.anchor.address,
  });
  return { signature: sig };
}
