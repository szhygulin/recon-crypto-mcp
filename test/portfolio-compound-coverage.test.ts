/**
 * Issues #88 (Compound V3), #92 (Morpho Blue), #93 (Lido / EigenLayer) —
 * coverage notes used to be generic "X fetch failed" strings leaving the
 * agent unable to tell the user which subsystem/source/chain was broken
 * or whether the failure was worth retrying. Each coverage bucket now
 * carries per-failure detail (chain + market + raw error; chain + raw
 * error; source + raw error), formatted into the `note` field via
 * dedicated helpers.
 */
import { describe, it, expect } from "vitest";
import {
  formatCompoundErrorNote,
  formatMorphoErrorNote,
  formatStakingErrorNote,
} from "../src/modules/portfolio/index.js";

describe("formatCompoundErrorNote (#88)", () => {
  it("falls back to the generic message when no per-market detail is available", () => {
    const note = formatCompoundErrorNote(undefined);
    expect(note).toMatch(/fetch failed on at least one market/);
    // No "Failures:" suffix when we have nothing concrete to attach.
    expect(note).not.toMatch(/Failures:/);
  });

  it("appends per-chain + per-market + raw error text when details are present", () => {
    const note = formatCompoundErrorNote([
      {
        chain: "ethereum",
        market: "cUSDCv3",
        error: "multicall3 returned 0x for balanceOf",
      },
      {
        chain: "base",
        market: "cUSDCv3",
        error: "connection reset by peer",
      },
    ]);
    expect(note).toMatch(
      /ethereum\/cUSDCv3: multicall3 returned 0x for balanceOf/,
    );
    expect(note).toMatch(/base\/cUSDCv3: connection reset by peer/);
    // Pointer to the deeper tool so the agent knows where to dig on the
    // user's behalf; generic hint is preserved.
    expect(note).toContain("get_compound_positions");
    expect(note).toMatch(/fetch failed on at least one market/);
  });

  it("truncates very long error strings so the note stays readable (get_compound_positions has the full detail)", () => {
    const giant = "x".repeat(500);
    const note = formatCompoundErrorNote([
      { chain: "arbitrum", market: "cUSDCv3", error: giant },
    ]);
    // Truncation cap ~120 chars + ellipsis; the full 500-char string must
    // not appear intact.
    expect(note).not.toContain(giant);
    expect(note).toMatch(/…/);
    expect(note).toContain("arbitrum/cUSDCv3:");
  });

  it("joins multiple market failures with a readable separator", () => {
    const note = formatCompoundErrorNote([
      { chain: "ethereum", market: "cUSDCv3", error: "rpc timeout" },
      { chain: "ethereum", market: "cWETHv3", error: "rpc timeout" },
      { chain: "polygon", market: "cUSDCv3", error: "chain not deployed" },
    ]);
    // Each failure is its own delimited entry; the agent can mentally parse
    // three concerns rather than one indistinct blob.
    const failureSegment = note.match(/Failures: (.+?)\. Call/);
    expect(failureSegment).not.toBeNull();
    const parts = failureSegment![1].split("; ");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("ethereum/cUSDCv3");
    expect(parts[1]).toContain("ethereum/cWETHv3");
    expect(parts[2]).toContain("polygon/cUSDCv3");
  });
});

describe("formatMorphoErrorNote (#92)", () => {
  it("falls back to the generic message when no per-chain detail is available", () => {
    const note = formatMorphoErrorNote(undefined);
    expect(note).toMatch(/event-log discovery failed on at least one chain/);
    expect(note).not.toMatch(/Failures:/);
  });

  it("appends per-chain + raw error text when details are present", () => {
    const note = formatMorphoErrorNote([
      { chain: "ethereum", error: "archive node returned 503" },
      { chain: "base", error: "rate limit exceeded" },
    ]);
    expect(note).toMatch(/ethereum: archive node returned 503/);
    expect(note).toMatch(/base: rate limit exceeded/);
    // Pointer to the narrower fast-path tool — same pattern as compound.
    expect(note).toContain("get_morpho_positions");
  });

  it("truncates very long error strings so the note stays readable", () => {
    const giant = "x".repeat(500);
    const note = formatMorphoErrorNote([
      { chain: "arbitrum", error: giant },
    ]);
    expect(note).not.toContain(giant);
    expect(note).toMatch(/…/);
    expect(note).toContain("arbitrum:");
  });
});

describe("formatStakingErrorNote (#93)", () => {
  it("falls back to the generic Lido+EigenLayer wording when no per-source detail is available", () => {
    // Preserves the pre-fix string so callers hitting the empty-array
    // branch (top-level promise reject with no erroredSources payload)
    // still get a readable note. Split-by-source messaging only fires
    // when we have structured detail.
    const note = formatStakingErrorNote(undefined);
    expect(note).toMatch(/Lido\/EigenLayer/);
  });

  it("names the specific failing source(s) when per-source detail is present", () => {
    const note = formatStakingErrorNote([
      { source: "lido", error: "stETH balanceOf reverted" },
    ]);
    expect(note).toMatch(/lido: stETH balanceOf reverted/);
    // Must NOT claim EigenLayer failed when it didn't — the whole point of
    // the allSettled refactor is that EigenLayer's positions still flow
    // through when Lido is down.
    expect(note).not.toMatch(/eigenlayer:/);
    expect(note).toMatch(/other staking source/i);
  });

  it("handles the both-sources-errored case cleanly", () => {
    const note = formatStakingErrorNote([
      { source: "lido", error: "stETH balanceOf reverted" },
      { source: "eigenlayer", error: "strategyList() out of gas" },
    ]);
    expect(note).toMatch(/lido:/);
    expect(note).toMatch(/eigenlayer:/);
  });
});
