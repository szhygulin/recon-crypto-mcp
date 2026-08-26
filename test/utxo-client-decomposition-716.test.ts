import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Structural falsifier for the BTC/LTC Esplora indexer decomposition
 * (ARCHITECTURE.md §5.1, issue #716). Both `src/modules/btc/indexer.ts`
 * and `src/modules/litecoin/indexer.ts` are now delegation-only barrels
 * over the parametrized client in `src/modules/utxo/esplora-client.ts` —
 * this pins that shape so neither barrel can silently re-accumulate a
 * local implementation or a local type block.
 *
 * Checked entirely via source text (no tsc / running build in this
 * environment): the barrels' own exports are TYPE aliases for the most
 * part, which are erased at runtime, so a plain `import *` + `Object.keys`
 * check (as `test/execution-decomposition.test.ts` uses for its
 * value-only exports) can't see the type-level surface. Regex extraction
 * over the source is the falsifiable substitute.
 *
 * Three things are asserted:
 *
 *  1. DELEGATION-ONLY: neither indexer file declares a `class`, and
 *     neither makes a `fetch(...)` call directly — all HTTP + retry
 *     logic lives once, in the shared client.
 *
 *  2. EXPORT-ALLOWLIST: each indexer file exports EXACTLY its permitted
 *     surface — no more, no fewer. A re-accumulated local type (or a
 *     dropped one) fails the set-equality check.
 *
 *  3. SINGLE-IMPLEMENTATION: `esplora-client.ts` is the only file under
 *     `src/modules/{btc,litecoin,utxo}` that defines an Esplora client
 *     class — i.e. no structural twin has grown back under either chain
 *     directory.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function readSrc(relPath: string): string {
  return readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
}

function listTsFiles(relDir: string): string[] {
  return readdirSync(`${REPO_ROOT}${relDir}`)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${relDir}/${f}`);
}

/**
 * Extract every top-level exported name from a TypeScript source file:
 * `export type X = ...`, `export function X`, `export const X`, and
 * `export type { A, B as C } from "..."` re-export lists (the alias
 * target name, matching what an importer actually sees).
 */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  const declRe =
    /^export\s+(?:type|interface|function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const m of source.matchAll(declRe)) names.add(m[1]);
  const reExportRe = /^export\s+(?:type\s+)?\{([^}]+)\}\s+from/gm;
  for (const m of source.matchAll(reExportRe)) {
    for (const part of m[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      names.add(asMatch ? asMatch[1] : trimmed.replace(/^type\s+/, ""));
    }
  }
  return [...names].sort();
}

const BTC_INDEXER_ALLOWLIST = [
  "BitcoinAddressBalance",
  "BitcoinBlockSummary",
  "BitcoinBlockTip",
  "BitcoinFeeEstimates",
  "BitcoinIndexer",
  "BitcoinTxHistoryEntry",
  "BitcoinUtxo",
  "EsploraTx",
  "EsploraVin",
  "EsploraVout",
  "getBitcoinIndexer",
  "resetBitcoinIndexer",
].sort();

const LTC_INDEXER_ALLOWLIST = [
  "LitecoinAddressBalance",
  "LitecoinBlockSummary",
  "LitecoinBlockTip",
  "LitecoinFeeEstimates",
  "LitecoinIndexer",
  "LitecoinTxHistoryEntry",
  "LitecoinUtxo",
  "getLitecoinIndexer",
  "resetLitecoinIndexer",
].sort();

const UTXO_MODULE_DIRS = ["src/modules/btc", "src/modules/litecoin", "src/modules/utxo"];

describe("BTC/LTC Esplora indexer decomposition (#716, ARCHITECTURE §5.1)", () => {
  it("btc/indexer.ts is a delegation-only barrel (no class, no direct fetch)", () => {
    const src = readSrc("src/modules/btc/indexer.ts");
    expect(src).not.toMatch(/\bclass\s+\w+/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("litecoin/indexer.ts is a delegation-only barrel (no class, no direct fetch)", () => {
    const src = readSrc("src/modules/litecoin/indexer.ts");
    expect(src).not.toMatch(/\bclass\s+\w+/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("btc/indexer.ts exports EXACTLY its allowlisted surface", () => {
    expect(exportedNames(readSrc("src/modules/btc/indexer.ts"))).toEqual(
      BTC_INDEXER_ALLOWLIST,
    );
  });

  it("litecoin/indexer.ts exports EXACTLY its allowlisted surface", () => {
    expect(exportedNames(readSrc("src/modules/litecoin/indexer.ts"))).toEqual(
      LTC_INDEXER_ALLOWLIST,
    );
  });

  it("esplora-client.ts is the only Esplora client class under btc/litecoin/utxo", () => {
    const classFiles: string[] = [];
    for (const dir of UTXO_MODULE_DIRS) {
      for (const rel of listTsFiles(dir)) {
        const src = readSrc(rel);
        if (/\bclass\s+\w*Esplora\w*/.test(src)) classFiles.push(rel);
      }
    }
    expect(classFiles).toEqual(["src/modules/utxo/esplora-client.ts"]);
  });
});
