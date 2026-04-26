/**
 * Token-2022 mint-extension diff + severity classification.
 * Issue #252 / #242 v2 (token_extension_change signal).
 *
 * Compare current `getExtensionTypes(mint.tlvData)` output against the
 * cached snapshot. Newly-observed extensions are flagged with a severity
 * tier driven by the per-extension risk-class table below.
 *
 * Severity rationale:
 *   - critical: TransferHook, PermanentDelegate. Issuer can run arbitrary
 *     code on every transfer, or move user funds without consent.
 *   - high: DefaultAccountState, PausableConfig, ConfidentialTransferMint.
 *     Frozen-by-default accounts; pause-all kill switch; privacy mode
 *     toggle (the latter changes how balances are observable).
 *   - medium: MintCloseAuthority, NonTransferable. Mint can be closed
 *     (rugging the supply); non-transferable bit toggles user mobility.
 *   - low: anything else newly-enabled — surfaced for completeness, never
 *     a hard flag.
 *
 * Source: `@solana/spl-token` v0.4.14 ExtensionType enum, file
 * `node_modules/@solana/spl-token/lib/types/extensions/extensionType.d.ts`.
 * Empirically verified during the rnd scope-probe (issue #251 comment).
 */
import { ExtensionType } from "@solana/spl-token";

export type Severity = "critical" | "high" | "medium" | "low";

const CRITICAL_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.TransferHook,
  ExtensionType.PermanentDelegate,
]);

const HIGH_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.DefaultAccountState,
  ExtensionType.PausableConfig,
  ExtensionType.ConfidentialTransferMint,
]);

const MEDIUM_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.MintCloseAuthority,
  ExtensionType.NonTransferable,
]);

export function classifySeverity(extType: ExtensionType): Severity {
  if (CRITICAL_EXTENSIONS.has(extType)) return "critical";
  if (HIGH_EXTENSIONS.has(extType)) return "high";
  if (MEDIUM_EXTENSIONS.has(extType)) return "medium";
  return "low";
}

/** Human-readable label for telemetry / agent display. Falls back to the
 * raw enum index for extensions we don't know by name (forward-compat
 * with future Token-2022 extensions added in newer spl-token releases). */
export function extensionLabel(extType: ExtensionType): string {
  return ExtensionType[extType] ?? `Unknown(${extType})`;
}

export interface ExtensionDiff {
  mint: string;
  /** Extensions present now AND in the cached snapshot. Background. */
  unchanged: ReadonlyArray<{ type: ExtensionType; label: string }>;
  /** Extensions present now but NOT in the cached snapshot. Flagged. */
  added: ReadonlyArray<{
    type: ExtensionType;
    label: string;
    severity: Severity;
  }>;
  /** Extensions in cached snapshot but no longer present. Surfaced for
   * completeness — issuer disabled/closed something — never a hard flag.
   * Token-2022 extensions are typically forward-only (you can enable but
   * not disable most), so this is mostly informational. */
  removed: ReadonlyArray<{ type: ExtensionType; label: string }>;
  /** When true, no prior snapshot existed — the `added` list is from a
   * cold start and must NOT be flagged (it's just the current state).
   * Caller should still persist the snapshot so the next call can diff. */
  firstObservation: boolean;
}

export function diffExtensions(
  mint: string,
  current: ReadonlyArray<ExtensionType>,
  snapshotExtensions: ReadonlyArray<number> | undefined,
): ExtensionDiff {
  if (snapshotExtensions === undefined) {
    return {
      mint,
      unchanged: [],
      added: current.map((type) => ({
        type,
        label: extensionLabel(type),
        severity: classifySeverity(type),
      })),
      removed: [],
      firstObservation: true,
    };
  }
  const cached = new Set<number>(snapshotExtensions);
  const currentSet = new Set<number>(current);
  const unchanged: Array<{ type: ExtensionType; label: string }> = [];
  const added: Array<{ type: ExtensionType; label: string; severity: Severity }> = [];
  const removed: Array<{ type: ExtensionType; label: string }> = [];
  for (const type of current) {
    if (cached.has(type)) {
      unchanged.push({ type, label: extensionLabel(type) });
    } else {
      added.push({ type, label: extensionLabel(type), severity: classifySeverity(type) });
    }
  }
  for (const cachedType of snapshotExtensions) {
    if (!currentSet.has(cachedType)) {
      removed.push({ type: cachedType, label: extensionLabel(cachedType) });
    }
  }
  return { mint, unchanged, added, removed, firstObservation: false };
}

/** Aggregate the per-mint diff list into the rollup the
 * `token_extension_change` signal needs:
 *   - `flagged`: any non-firstObservation diff added a critical/high/medium ext.
 *   - `firstObservationCount`: how many mints we just baselined.
 *   - per-mint findings for the agent to surface.
 */
export function rollupDiffs(diffs: ReadonlyArray<ExtensionDiff>): {
  flagged: boolean;
  firstObservationCount: number;
  changedMints: ReadonlyArray<ExtensionDiff>;
  baselinedMints: ReadonlyArray<ExtensionDiff>;
} {
  const baselined = diffs.filter((d) => d.firstObservation);
  const changed = diffs.filter(
    (d) => !d.firstObservation && (d.added.length > 0 || d.removed.length > 0),
  );
  const flagged = changed.some((d) =>
    d.added.some((a) => a.severity !== "low"),
  );
  return {
    flagged,
    firstObservationCount: baselined.length,
    changedMints: changed,
    baselinedMints: baselined,
  };
}
