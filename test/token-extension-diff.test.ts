/**
 * Tests for Token-2022 extension diff + severity classification.
 * Issue #252 / #242 v2.
 *
 * Pure-function suite: no RPC, no filesystem. Storage tests cover the
 * snapshot helpers separately.
 */
import { ExtensionType } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import {
  classifySeverity,
  diffExtensions,
  extensionLabel,
  rollupDiffs,
} from "../src/modules/incidents/token-extension-diff.js";

const MINT_A = "So11111111111111111111111111111111111111112";

describe("classifySeverity", () => {
  it("flags TransferHook + PermanentDelegate as critical", () => {
    expect(classifySeverity(ExtensionType.TransferHook)).toBe("critical");
    expect(classifySeverity(ExtensionType.PermanentDelegate)).toBe("critical");
  });

  it("flags DefaultAccountState / PausableConfig / ConfidentialTransferMint as high", () => {
    expect(classifySeverity(ExtensionType.DefaultAccountState)).toBe("high");
    expect(classifySeverity(ExtensionType.PausableConfig)).toBe("high");
    expect(classifySeverity(ExtensionType.ConfidentialTransferMint)).toBe("high");
  });

  it("flags MintCloseAuthority + NonTransferable as medium", () => {
    expect(classifySeverity(ExtensionType.MintCloseAuthority)).toBe("medium");
    expect(classifySeverity(ExtensionType.NonTransferable)).toBe("medium");
  });

  it("falls back to low for everything else (e.g. ImmutableOwner, MetadataPointer)", () => {
    expect(classifySeverity(ExtensionType.ImmutableOwner)).toBe("low");
    expect(classifySeverity(ExtensionType.MetadataPointer)).toBe("low");
    expect(classifySeverity(ExtensionType.TokenMetadata)).toBe("low");
  });
});

describe("extensionLabel", () => {
  it("returns the human-readable enum name for known types", () => {
    expect(extensionLabel(ExtensionType.TransferHook)).toBe("TransferHook");
    expect(extensionLabel(ExtensionType.MintCloseAuthority)).toBe("MintCloseAuthority");
  });
});

describe("diffExtensions — first observation", () => {
  it("returns firstObservation:true with all current as added when no snapshot exists", () => {
    const diff = diffExtensions(
      MINT_A,
      [ExtensionType.TransferHook, ExtensionType.MetadataPointer],
      undefined,
    );
    expect(diff.firstObservation).toBe(true);
    expect(diff.added.map((a) => a.type)).toEqual([
      ExtensionType.TransferHook,
      ExtensionType.MetadataPointer,
    ]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("populates severity on first-observation added entries (caller decides not to flag)", () => {
    const diff = diffExtensions(
      MINT_A,
      [ExtensionType.PermanentDelegate],
      undefined,
    );
    expect(diff.added[0].severity).toBe("critical");
  });
});

describe("diffExtensions — subsequent observations", () => {
  it("classifies unchanged-vs-added correctly", () => {
    const diff = diffExtensions(
      MINT_A,
      [ExtensionType.MetadataPointer, ExtensionType.TransferHook],
      [ExtensionType.MetadataPointer],
    );
    expect(diff.firstObservation).toBe(false);
    expect(diff.unchanged.map((u) => u.type)).toEqual([ExtensionType.MetadataPointer]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].type).toBe(ExtensionType.TransferHook);
    expect(diff.added[0].severity).toBe("critical");
  });

  it("captures removed extensions (informational, unflagged)", () => {
    const diff = diffExtensions(
      MINT_A,
      [ExtensionType.MetadataPointer],
      [ExtensionType.MetadataPointer, ExtensionType.TransferHook],
    );
    expect(diff.removed.map((r) => r.type)).toEqual([ExtensionType.TransferHook]);
    expect(diff.added).toEqual([]);
  });

  it("returns nothing-changed when current matches snapshot", () => {
    const diff = diffExtensions(
      MINT_A,
      [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata],
      [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata],
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });
});

describe("rollupDiffs", () => {
  it("flags only when a non-firstObservation diff added a critical/high/medium ext", () => {
    const baseline = diffExtensions(MINT_A, [ExtensionType.TransferHook], undefined);
    const trivial = diffExtensions(
      "Mint2",
      [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata],
      [ExtensionType.MetadataPointer],
    );
    const rollup = rollupDiffs([baseline, trivial]);
    // baseline is firstObservation → not flagged.
    // trivial added a `low` (TokenMetadata) → still not flagged.
    expect(rollup.flagged).toBe(false);
    expect(rollup.firstObservationCount).toBe(1);
    // changedMints is the post-baseline subset only.
    expect(rollup.changedMints).toHaveLength(1);
    expect(rollup.baselinedMints).toHaveLength(1);
  });

  it("flags when a critical ext is newly added on a non-firstObservation mint", () => {
    const flagging = diffExtensions(
      "Mint2",
      [ExtensionType.MetadataPointer, ExtensionType.TransferHook],
      [ExtensionType.MetadataPointer],
    );
    const rollup = rollupDiffs([flagging]);
    expect(rollup.flagged).toBe(true);
  });

  it("flags when a high (DefaultAccountState) is added", () => {
    const flagging = diffExtensions(
      "Mint3",
      [ExtensionType.DefaultAccountState],
      [],
    );
    const rollup = rollupDiffs([flagging]);
    expect(rollup.flagged).toBe(true);
  });

  it("does NOT flag when only a low-severity ext is added on a snapshot-known mint", () => {
    const lowAdd = diffExtensions(
      "Mint4",
      [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata],
      [ExtensionType.MetadataPointer],
    );
    const rollup = rollupDiffs([lowAdd]);
    expect(rollup.flagged).toBe(false);
  });

  it("does NOT flag a removed-only diff (extensions are forward-only in practice)", () => {
    const removed = diffExtensions(
      "Mint5",
      [],
      [ExtensionType.TransferHook],
    );
    const rollup = rollupDiffs([removed]);
    expect(rollup.flagged).toBe(false);
  });
});
