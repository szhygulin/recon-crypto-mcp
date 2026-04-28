/**
 * Read this server's currently-running version from the bundled
 * `package.json`. Resolved relative to this module's URL so it works under
 * `node dist/index.js`, `npx`, the bundled binary, and tests.
 *
 * Memoized — `package.json` doesn't change while the process is running.
 * On a read failure (deleted, malformed, missing `version`) returns
 * `"0.0.0"` so the update check degrades silently rather than throwing
 * out of a tool handler.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function getServerVersion(): string {
  if (cached !== null) return cached;
  cached = readVersionUncached();
  return cached;
}

/** For tests — clears the memoized read so test fixtures can swap files. */
export function _resetServerVersionCacheForTests(): void {
  cached = null;
}

function readVersionUncached(): string {
  // From `dist/shared/version.js` or `src/shared/version.ts`, walk up to
  // the package root. `package.json` is two levels up at runtime
  // (`dist/shared/version.js` → `dist/` → root), and two levels up under
  // ts-node from source as well (`src/shared/version.ts` → `src/` → root).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "..", "..", "package.json"),
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (
          parsed &&
          parsed.name === "vaultpilot-mcp" &&
          typeof parsed.version === "string"
        ) {
          return parsed.version;
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}
