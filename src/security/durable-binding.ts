/**
 * Invariant #14 — durable-binding source-of-truth verification (issue
 * #460). For any op that binds funds to a durable on-chain object
 * selected from a multi-candidate set (validator pubkey, TRON Super
 * Representative, Compound Comet, Morpho marketId, MarginFi bank, LP
 * tokenId, BTC multisig xpub, allowance spender), the agent MUST
 * source the candidate from an authority outside the MCP, surface it
 * verbatim with provenance, and byte-equality-check the prepared
 * bytes before signing.
 *
 * The MCP-side contribution to that defense: every prepare_* tool in
 * an Inv #14 op class emits a structured `durableBindings: DurableBinding[]`
 * field on its response. The skill consumes it as the assertion target —
 * unambiguous, no parsing of the human-readable `decoded.args` text.
 *
 * Tools intentionally NOT covered:
 *   - Plain native-coin sends — recipient is the durable object, but
 *     it's already covered by Invariant #1 (recipient cross-check).
 *   - Token sends — same; the recipient + the token contract are
 *     covered by Inv #1 + Inv #11 today.
 *   - Read-only tools — no bytes prepared, no Inv #14 surface.
 */

/**
 * Closed enum of the durable-object kinds Invariant #14 covers. Add a
 * new kind here only after wiring the corresponding prepare_* tool to
 * emit it; the skill's match logic is keyed on these strings.
 */
export type DurableBindingKind =
  | "solana-validator-vote-pubkey"
  | "tron-super-representative-address"
  | "compound-comet-address"
  | "morpho-blue-market-id"
  | "marginfi-bank-pubkey"
  | "uniswap-v3-lp-token-id"
  | "btc-multisig-cosigner-xpub"
  | "approval-spender-address";

export interface DurableBinding {
  /** Stable kind discriminator the skill matches against. */
  kind: DurableBindingKind;
  /**
   * Full identifier verbatim, no truncation. Format depends on the
   * kind: base58 for Solana / TRON pubkeys, 0x-prefixed checksum hex
   * for EVM addresses, decimal string for tokenIds, raw xpub string
   * for BTC multisig cosigners, lowercase hex for Morpho marketIds.
   */
  identifier: string;
  /**
   * Free-form text suggesting where the user should re-verify
   * externally. Per Inv #14, the user MUST source the candidate from
   * an authority outside the MCP's enumeration; this hint nudges them
   * at the right URL / app. Phrased as a recommendation, not a hard
   * statement of trust — the agent renders it verbatim in the
   * verification block.
   */
  provenanceHint: string;
}

/**
 * Canonical provenance hints per kind. Centralized so every prepare
 * tool emitting a given kind sends the user to the same external
 * authority — surface drift between tools would erode the user's
 * mental model of "for this kind, I look here".
 */
const PROVENANCE_HINTS: Record<DurableBindingKind, string> = {
  "solana-validator-vote-pubkey":
    "Re-verify on stakewiz.com or validators.app — confirm commission, delinquent flag, and that the vote pubkey matches the validator the user actually intends to delegate to.",
  "tron-super-representative-address":
    "Re-verify on tronscan.org/#/sr — confirm SR identity, ranking, and that the base58 address is the validator the user means (brand-name spoof / base58 confusable swap is the b044 attack class).",
  "compound-comet-address":
    "Re-verify on v3.compound.finance/markets — confirm the Comet address matches the (chain, base-asset) the user actually intends to interact with (wrong-Comet routing on the wrong asset is the b053 attack class).",
  "morpho-blue-market-id":
    "Re-verify on app.morpho.org/market/{id} — confirm collateral / loan-token / oracle / IRM / LLTV match the market the user means (b055 attack class: permissionless-market injection with adversarial parameters).",
  "marginfi-bank-pubkey":
    "Re-verify on app.marginfi.com — confirm bank is operational (not paused / killed-by-bankruptcy), oracle setup is healthy, and the asset matches the user's intent (b059 attack class: lookalike-bank injection).",
  "uniswap-v3-lp-token-id":
    "Re-verify on app.uniswap.org/positions/v3/<chain>/<tokenId> — confirm the position owner is your wallet, not an attacker-injected LP NFT enumerated into your portfolio (b063 attack class).",
  "btc-multisig-cosigner-xpub":
    "Re-verify each cosigner xpub against the origin device's backup card / set-up record — never trust an xpub passed to this tool through a third-party communication channel (b098 attack class: attacker xpub embedded as 'co-signer').",
  "approval-spender-address":
    "Re-verify on etherscan.io/address/<spender> — confirm the spender contract identity matches the protocol the user intends to grant allowance to (a086 / b118 attack class: reverse-revoke distraction).",
};

/**
 * Build a `DurableBinding` with the canonical provenance hint for the
 * given kind. Prepare tools call this rather than constructing the
 * object literal so all kind ↔ hint pairings live in one place.
 */
export function makeDurableBinding(
  kind: DurableBindingKind,
  identifier: string,
): DurableBinding {
  const provenanceHint = PROVENANCE_HINTS[kind];
  return { kind, identifier, provenanceHint };
}
