/**
 * Drainer-string refusal for `sign_message_btc` / `sign_message_ltc`
 * (issue #454, adversarial smoke-test script a110).
 *
 * Invariant #8 (BIP-137 message signing) raises the bar with verbatim
 * UTF-8 rendering, hex preview, and U+2014 disambiguation, but the
 * defense ultimately terminates at the user's eyes on the Ledger Nano
 * OLED. Documented failure modes from a110: skim, line-1-only,
 * trust-the-agent, unicode-confusable substitution. For high-stakes
 * message classes (proof-of-funds, custody-transfer-shaped,
 * exchange-deposit-prove), this is a structural HIGH risk.
 *
 * The mechanical defense: refuse outright at MCP build time when the
 * message contains drainer-pattern markers. Fires regardless of agent
 * cooperation, so a compromised agent can't suppress it. The refusal
 * is intentionally over-broad — false positives are recoverable
 * (reword the message, or use a non-vaultpilot signing tool); a false
 * negative on a drainer-template message is potentially fund-loss.
 *
 * Scope: `sign_message_btc` / `sign_message_ltc` ONLY. Contacts-CRUD
 * signing is structurally fixed (`VaultPilot-contact-v1:` JSON
 * preimage on a controlled shape) and not affected — it goes through
 * a different path that never hits this check.
 */

/**
 * Single-word semantic markers. Match is case-insensitive substring
 * across the whole message. Each word represents an ownership /
 * value-transfer concept; legitimate Sign-In-with-Bitcoin / proof-of-
 * funds messages don't typically use these (they use "verify",
 * "ownership", "agree to authenticate", "deposit address for", etc.).
 */
const SEMANTIC_MARKERS: ReadonlyArray<string> = [
  "transfer",
  "authorize",
  "grant",
  "custody",
  "release",
  "consent",
];

/**
 * Multi-word drainer templates the corpus has surfaced. These overlap
 * with `SEMANTIC_MARKERS` (e.g. "I authorize" already trips
 * `authorize`) but are kept as explicit phrases so the refusal error
 * can quote the exact template the message contained — a more
 * actionable diagnostic for the user than a single-word match.
 */
const DRAINER_TEMPLATES: ReadonlyArray<string> = [
  "i authorize",
  "granting full custody",
  "i consent to",
  "i hereby transfer",
  "release my",
];

export interface DrainerPatternMatch {
  /** The pattern string that matched (canonicalized to lowercase). */
  pattern: string;
  /** "marker" for SEMANTIC_MARKERS, "template" for DRAINER_TEMPLATES — surfaced in the error so users see why it tripped. */
  kind: "marker" | "template";
}

/**
 * Scan a UTF-8 message for drainer patterns. Returns the first match
 * (templates take precedence over markers because they're more
 * specific) or null. Pure function — no I/O, no async.
 */
export function detectDrainerPattern(
  message: string,
): DrainerPatternMatch | null {
  const lower = message.toLowerCase();
  for (const tpl of DRAINER_TEMPLATES) {
    if (lower.includes(tpl)) {
      return { pattern: tpl, kind: "template" };
    }
  }
  for (const marker of SEMANTIC_MARKERS) {
    if (lower.includes(marker)) {
      return { pattern: marker, kind: "marker" };
    }
  }
  return null;
}

/**
 * Throw a refusal error if the message contains a drainer pattern.
 * Called at the top of `signBitcoinMessage` / `signLitecoinMessage`
 * before any device interaction.
 *
 * Error shape is intentionally informative: the user sees which
 * pattern tripped, why we refuse, and a concrete next step (reword,
 * or use another tool). False positives are recoverable; false
 * negatives are not.
 */
export function assertNoDrainerPattern(message: string): void {
  const hit = detectDrainerPattern(message);
  if (!hit) return;

  const examples =
    hit.kind === "marker"
      ? "transfer / authorize / grant / custody / release / consent"
      : '"I authorize" / "granting full custody" / "I consent to" / "I hereby transfer" / "release my"';

  throw new Error(
    `MESSAGE-SIGN REFUSED — drainer-pattern ${hit.kind} "${hit.pattern}" in message. ` +
      `These ${hit.kind === "marker" ? "single-word semantic markers" : "multi-word templates"} ` +
      `(${examples}) are common in fake "proof-of-ownership" prompts that are actually ` +
      `value-transfer authorizations the device's clear-sign of the message text alone can't ` +
      `meaningfully gate (a110 attack class — issue #454). ` +
      `Legitimate Sign-In-with-Bitcoin / proof-of-funds flows don't use these markers — ` +
      `they typically read "Verify ownership of <addr>" or "Sign in to <site>". ` +
      `Reword the message to remove the marker, or use a non-vaultpilot signing tool if you ` +
      `genuinely intend to sign a transfer/authorization message.`,
  );
}
