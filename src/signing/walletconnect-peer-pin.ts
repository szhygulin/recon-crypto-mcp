import type { SessionTypes } from "@walletconnect/types";

/**
 * WalletConnect peer pinning (issue #325 P5).
 *
 * The MCP's WalletConnect role is "dApp"; it proposes a session and
 * the wallet (Ledger Live) approves. Once approved, every signing
 * request flows over a relayed encrypted channel between the two —
 * the MCP submits txs/messages, the wallet signs.
 *
 * Today's trust assumption: "the WC peer that approved our session is
 * Ledger Live, because the user scanned the QR with Ledger Live and
 * approved on the Ledger device." The MCP can't verify the wallet
 * binary itself (P4 covers that), but it CAN verify the WC peer's
 * advertised identity matches what Ledger Live publishes — name,
 * canonical URL, icons hosted on `*.ledger.com`. A different wallet
 * (Sparrow, MetaMask, an attacker's wallet) advertises different
 * metadata, and the user would notice the prompt on the wrong app
 * — but only if they look. This pin makes the discrepancy
 * machine-checkable.
 *
 * What this catches:
 *   - Another wallet impersonating Ledger Live at the WC peer level
 *     (i.e., the user accidentally scanned the QR with the wrong app
 *     and approved without noticing)
 *   - A malicious WC relay swapping the peer metadata (the relay sees
 *     metadata in the session_propose payload; if compromised it
 *     could rewrite — but the MCP would notice the mismatch)
 *
 * What this misses (covered by other layers):
 *   - A real-Ledger-Live version that's been tampered with (P4)
 *   - A WC peer that lies about its name/url AND happens to spoof
 *     Ledger Live's exact metadata (impossible to detect at this
 *     layer alone; user's eyes on the device are the trust root)
 *
 * Pinning policy:
 *   - `name === "Ledger Live"` exact match (Ledger publishes this
 *     name; case-sensitive)
 *   - `url` matches `https://*.ledger.com/...` OR is empty (Ledger
 *     Live mobile sometimes omits the URL field)
 *   - At least one icon URL hostname matches `*.ledger.com` (defense
 *     against a peer that copies name+url but forgets the icon CDN)
 *
 * On mismatch we WARN-LOUDLY rather than refuse. Refusal would brick
 * legitimate users running self-built Ledger Live or development
 * builds where metadata sometimes differs. The verdict is surfaced to
 * the agent so it can flag to the user; the user retains the on-device
 * approval as the actual trust root.
 */

export type LedgerLivePinVerdict = "match" | "mismatch" | "missing-metadata";

export interface PeerPinResult {
  verdict: LedgerLivePinVerdict;
  /** Peer's reported name. Empty string if missing. */
  reportedName: string;
  /** Peer's reported URL. Empty string if missing. */
  reportedUrl: string;
  /** Peer's reported icon hostnames (parsed from URLs). */
  reportedIconHosts: string[];
  /** Human-readable line for the agent to surface on `mismatch`. */
  message: string;
}

const LEDGER_LIVE_NAME_EXACT = "Ledger Live";
/** Hostname suffixes Ledger publishes from. */
const LEDGER_HOST_SUFFIXES: ReadonlyArray<string> = [".ledger.com"];

function hostMatchesLedger(host: string): boolean {
  const lc = host.toLowerCase();
  // Exact match for the bare apex (defensive — Ledger doesn't currently
  // serve from the bare apex, but accepting it future-proofs).
  if (lc === "ledger.com") return true;
  return LEDGER_HOST_SUFFIXES.some((suffix) => lc.endsWith(suffix));
}

function safeUrlHostname(raw: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * Validate a WC session's peer metadata against the Ledger Live
 * pin. Returns a structured verdict; does NOT throw.
 */
export function pinLedgerLivePeer(session: SessionTypes.Struct): PeerPinResult {
  // SessionTypes.Struct.peer.metadata.{name, url, icons} are the
  // standard WC v2 fields the wallet advertises.
  const metadata = session.peer?.metadata;
  const reportedName = metadata?.name ?? "";
  const reportedUrl = metadata?.url ?? "";
  const reportedIcons = Array.isArray(metadata?.icons) ? metadata.icons : [];
  const reportedIconHosts = reportedIcons
    .map((u) => safeUrlHostname(u))
    .filter((h): h is string => h !== null);

  if (!reportedName && !reportedUrl && reportedIconHosts.length === 0) {
    return {
      verdict: "missing-metadata",
      reportedName,
      reportedUrl,
      reportedIconHosts,
      message:
        `WalletConnect peer reported no metadata (name + url + icons all empty). ` +
        `This is unusual; legitimate Ledger Live always advertises name and url. ` +
        `Verify the connection on-device before approving signing prompts — the ` +
        `MCP cannot identify the peer.`,
    };
  }

  // Name check: exact match. Ledger Live publishes "Ledger Live"
  // verbatim; alternates ("Ledger Live Mobile", "Ledger Live Desktop")
  // are NOT in current production metadata, so any deviation is a
  // pinning failure.
  const nameOk = reportedName === LEDGER_LIVE_NAME_EXACT;

  // URL check: scheme can be omitted; hostname must match a Ledger
  // suffix. Empty url is acceptable (some clients omit it on mobile).
  const urlHost = safeUrlHostname(reportedUrl);
  const urlOk = !reportedUrl || (urlHost !== null && hostMatchesLedger(urlHost));

  // Icon check: at least one icon URL must point at a Ledger-hosted
  // CDN. Acceptable to omit icons entirely — but if icons ARE present,
  // at least one should be Ledger-hosted (catches peers that
  // copy-paste name+url but forget the icon CDN).
  const iconsOk =
    reportedIconHosts.length === 0 ||
    reportedIconHosts.some((h) => hostMatchesLedger(h));

  if (nameOk && urlOk && iconsOk) {
    return {
      verdict: "match",
      reportedName,
      reportedUrl,
      reportedIconHosts,
      message: `WalletConnect peer matches Ledger Live pin.`,
    };
  }

  const reasons: string[] = [];
  if (!nameOk) {
    reasons.push(
      `name "${reportedName}" ≠ expected "${LEDGER_LIVE_NAME_EXACT}"`,
    );
  }
  if (!urlOk) {
    reasons.push(
      `url "${reportedUrl}" doesn't match a *.ledger.com hostname`,
    );
  }
  if (!iconsOk) {
    reasons.push(
      `none of the icon hosts (${reportedIconHosts.join(", ")}) match *.ledger.com`,
    );
  }

  return {
    verdict: "mismatch",
    reportedName,
    reportedUrl,
    reportedIconHosts,
    message:
      `WalletConnect peer does NOT match the Ledger Live pin: ${reasons.join("; ")}. ` +
      `If you intentionally connected via a non-Ledger-Live wallet (development ` +
      `build, Sparrow, etc.), this is expected — but if you scanned the QR with ` +
      `Ledger Live and see this warning, the peer may not be what it claims to be. ` +
      `Verify on-device before approving any signing prompts.`,
  };
}
