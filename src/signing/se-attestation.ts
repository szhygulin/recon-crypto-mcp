/**
 * Secure Element attestation framework (issue #325 P1).
 *
 * The full P1 design — issue a fresh nonce APDU, receive an SE
 * signature, verify against Ledger's published attestation root CA —
 * requires live-device research that hasn't happened yet:
 *   1. The exact APDU sequence (`CLA=0xE0 INS=?? P1=?? P2=??`) is
 *      not in any installed `@ledgerhq/*` typed surface this server
 *      depends on. Ledger's older docs reference an attestation
 *      scheme (`getDeviceAuth` / `provisionPath`) but the canonical
 *      command for current firmware needs verification against a
 *      real Nano S Plus / Nano X / Stax / Flex.
 *   2. Ledger's published attestation root CA certificate (PEM/DER)
 *      needs to be located + pinned in this repo. Public sources
 *      reference the existence of such a certificate but a stable
 *      publication URL hasn't been verified.
 *   3. The verification algorithm — likely ECDSA over the device's
 *      attestation key with the certificate chain rooted at Ledger's
 *      provisioning CA — needs to be confirmed before we can
 *      meaningfully assert "matches Ledger's root."
 *
 * Per the project's "Verify external-system facts before coding on
 * them" rule (memory feedback), shipping plausible-but-unverified
 * crypto here would be worse than shipping nothing — incorrect
 * attestation logic creates a false sense of security and is harder
 * to spot than an explicit gap.
 *
 * What this module DOES ship:
 *   - The tool surface (`verifyLedgerAttestation`) so future research
 *     fills in the APDU + cert + verification logic without a redesign
 *   - A structured `not-implemented` verdict with a clear, agent-relayable
 *     explanation of what's missing
 *   - Type stability: the `LedgerAttestationResult` shape will not
 *     change when the actual implementation lands, only the `status`
 *     range expands and additional fields populate
 *
 * Sibling defenses already in place:
 *   - P2 (app-version pinning, #350)
 *   - P3 (firmware-version pinning, #354)
 *   - P4 (Ledger Live binary codesign, #360)
 *   - P5 (WC peer pinning, #356)
 *   - Existing per-chain device identity pinning at signing time —
 *     each USB signer asserts the device-derived address matches the
 *     address paired at first connect, catching device-swap attacks
 *     within the same seed (the attestation challenge would catch
 *     swap to a different physical SE entirely)
 */

export type AttestationStatus =
  | "verified"
  | "mismatch"
  | "no-device"
  | "wrong-mode"
  | "not-implemented"
  | "error";

export interface LedgerAttestationResult {
  status: AttestationStatus;
  /** SE serial / attestation key fingerprint when status === "verified". */
  serial?: string;
  /** Human-readable verdict line for the agent to relay to the user. */
  message: string;
  /** Set on `not-implemented` and `error` paths. */
  reason?: string;
}

const NOT_IMPLEMENTED_REASON =
  "SE attestation challenge is scaffolded but not yet wired to a live Ledger " +
  "attestation flow. Three pieces are pending live-device verification before " +
  "the actual cryptographic check can ship: (1) the canonical attestation APDU " +
  "for current Ledger firmware (Nano S Plus / Nano X / Stax / Flex), (2) the " +
  "PEM/DER of Ledger's published attestation root CA + a stable publication " +
  "URL, (3) the signature-verification algorithm + cert chain. Tracked under " +
  "issue #325 P1. Until those land, sibling defenses cover the threat surface: " +
  "app-version pinning (#350), firmware pinning (#354 — verify_ledger_firmware " +
  "tool), Ledger Live codesign (#360), WC peer pinning (#356), and per-chain " +
  "device identity binding at signing time.";

/**
 * Run the SE attestation challenge against the connected Ledger.
 *
 * **Currently returns `not-implemented`** (see module docstring for
 * why). The function exists so the tool surface is stable for a
 * future completion PR.
 */
export async function verifyLedgerAttestation(): Promise<LedgerAttestationResult> {
  return {
    status: "not-implemented",
    message:
      "SE attestation check is not yet implemented — see the tool's docstring + " +
      "issue #325 P1 for the live-device research required before this can ship. " +
      "Sibling checks (verify_ledger_firmware, verify_ledger_live_codesign, " +
      "and the WC peer pin) cover most of the threat surface in the meantime.",
    reason: NOT_IMPLEMENTED_REASON,
  };
}
