import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as format from "../src/signing/render/format.js";
import * as common from "../src/signing/render/common.js";
import * as bitcoin from "../src/signing/render/bitcoin.js";
import * as litecoin from "../src/signing/render/litecoin.js";
import * as tron from "../src/signing/render/tron.js";
import * as evm from "../src/signing/render/evm.js";
import * as solana from "../src/signing/render/solana.js";
import * as notices from "../src/signing/render/notices.js";

/**
 * Structural falsifier for the render-verification.ts decomposition
 * (ARCHITECTURE §5.3, issue #718). Three things are asserted:
 *
 *  1. PURE BARREL: src/signing/render-verification.ts contains only
 *     re-export lines — no function, const, or interface declarations. If a
 *     render function drifts back into this file, this check breaks.
 *
 *  2. EXPORT-ALLOWLIST + RESOLUTION: each per-chain `src/signing/render/*.ts`
 *     module exists and exports EXACTLY its allowlisted entry points, per
 *     the split plan's inventory (issue #718 comment). This is the §5
 *     preamble's per-module allowlist that keeps the one-time split from
 *     silently un-happening.
 *
 *  3. NO BACK-IMPORT: no module under src/signing/render/ imports from
 *     render-verification.ts. The barrel depends on the chain modules, never
 *     the reverse — a back-import would reintroduce a cycle. This is a
 *     source-grep of actual import/require statements, not a plain
 *     substring search: src/signing/render/solana.ts:932 contains the
 *     literal string "…render-verification.ts" inside a rendered
 *     Markdown link (pinned byte-identical by
 *     test/solana-ledger-hash.test.ts), which is prose, not an import, and
 *     must not trip this check.
 */

const RENDER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/signing/render",
);
const BARREL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/signing/render-verification.ts",
);

// Per-module export allowlist, transcribed from the #718 split-plan
// comment's per-chain inventory. Interfaces (e.g. `AutoInstallContext`,
// `RenderableSolanaPrepareResult`) are TS-only and erased at compile time,
// so they never appear as runtime module exports and are intentionally
// absent from these lists — only function entry points are checked.
const MODULE_ALLOWLISTS: Record<string, { ns: Record<string, unknown>; allow: string[] }> = {
  "format.ts": {
    ns: format as unknown as Record<string, unknown>,
    allow: [
      "formatNativeShort",
      "renderCostPreviewBlock",
      "formatNonEvmCostPreview",
      "truncateHex",
      "formatArgs",
      "formatRecipientSuffix",
      "renderPrepareReceiptBlock",
    ],
  },
  "common.ts": {
    ns: common as unknown as Record<string, unknown>,
    allow: ["renderPostBroadcastBlock", "renderPostSendPollBlock"],
  },
  "bitcoin.ts": {
    ns: bitcoin as unknown as Record<string, unknown>,
    allow: ["renderBitcoinCostPreviewBlock", "renderBitcoinVerificationBlock"],
  },
  "litecoin.ts": {
    ns: litecoin as unknown as Record<string, unknown>,
    allow: [
      "renderLitecoinCostPreviewBlock",
      "renderLitecoinVerificationBlock",
    ],
  },
  "tron.ts": {
    ns: tron as unknown as Record<string, unknown>,
    allow: ["renderTronVerificationBlock", "renderTronAgentTaskBlock"],
  },
  "evm.ts": {
    ns: evm as unknown as Record<string, unknown>,
    allow: [
      "shouldRenderVerificationBlock",
      "isClearSignOnlyTx",
      "renderPreviewCostBlock",
      "renderVerificationBlock",
      "renderAgentTaskBlock",
      "renderLedgerHashBlock",
      "renderPreviewVerifyAgentTaskBlock",
    ],
  },
  "solana.ts": {
    ns: solana as unknown as Record<string, unknown>,
    allow: [
      "renderSolanaCostPreviewBlock",
      "renderSolanaPrepareSummaryBlock",
      "renderSolanaPrepareAgentTaskBlock",
      "renderSolanaVerificationBlock",
      "renderSolanaAgentTaskBlock",
    ],
  },
  "notices.ts": {
    ns: notices as unknown as Record<string, unknown>,
    allow: [
      "renderMissingSkillWarning",
      "renderMissingSetupSkillWarning",
      "renderPreflightSkillPinBlock",
      "renderMissingDemoWalletWarning",
      "renderUpdateAvailableNotice",
    ],
  },
};

function exportedFunctionNames(ns: Record<string, unknown>): string[] {
  return Object.keys(ns)
    .filter((k) => typeof ns[k] === "function")
    .sort();
}

// Matches an actual import/require of render-verification (any relative
// depth, with or without a .js/.ts extension) — never a substring inside a
// string literal, comment, or Markdown link. Anchored to statement-leading
// `import` / dynamic `import(` / `require(` so a docstring URL mentioning
// the file path in prose cannot match.
const BACK_IMPORT_RE =
  /^\s*(import\b[^;]*from\s+["'][^"']*render-verification(?:\.[jt]s)?["']|import\(\s*["'][^"']*render-verification(?:\.[jt]s)?["']\s*\)|(?:const|let|var)\s+.*require\(\s*["'][^"']*render-verification(?:\.[jt]s)?["']\s*\))/m;

describe("render-verification.ts decomposition (#718, ARCHITECTURE §5.3)", () => {
  it("render-verification.ts is a pure barrel: only re-export lines, no declarations", () => {
    const src = readFileSync(BARREL_PATH, "utf8");
    const lines = src.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(
        /^export (\*|type \{[^}]*\}) from ["'][^"']+\.js["'];$/,
      );
    }
    // Belt-and-suspenders: no `function`, `const`, `class`, or bare
    // `interface` keyword anywhere in the file (re-export syntax never
    // contains any of these tokens).
    expect(src).not.toMatch(/\b(function|class|interface)\b/);
    expect(src).not.toMatch(/^\s*const\s/m);
  });

  for (const [file, { ns, allow }] of Object.entries(MODULE_ALLOWLISTS)) {
    it(`render/${file} exists and exports EXACTLY its allowlisted entry points`, () => {
      expect(existsSync(path.join(RENDER_DIR, file))).toBe(true);
      expect(exportedFunctionNames(ns)).toEqual([...allow].sort());
    });
  }

  it("all render/*.ts modules are covered by an allowlist (no untracked module)", () => {
    const actualFiles = readdirSync(RENDER_DIR).filter((f) => f.endsWith(".ts"));
    expect(actualFiles.sort()).toEqual(Object.keys(MODULE_ALLOWLISTS).sort());
  });

  it("no module under src/signing/render/ imports render-verification.ts", () => {
    const files = readdirSync(RENDER_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(path.join(RENDER_DIR, file), "utf8");
      for (const line of src.split("\n")) {
        if (BACK_IMPORT_RE.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("control: the back-import check actually fires on a real import statement", () => {
    // Proves the regex isn't vacuously passing — a known-bad line trips it.
    expect(BACK_IMPORT_RE.test('import { x } from "../render-verification.js";')).toBe(true);
    // And the pinned Markdown-link prose in solana.ts (same substring,
    // no import keyword) must NOT trip it.
    expect(
      BACK_IMPORT_RE.test(
        '    "  > [Verifier source](https://github.com/szhygulin/vaultpilot-mcp/blob/main/src/signing/render-verification.ts).",',
      ),
    ).toBe(false);
  });
});
