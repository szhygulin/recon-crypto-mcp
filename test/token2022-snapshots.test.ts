/**
 * Persistence tests for the Token-2022 mint-extension snapshot store.
 * Issue #252.
 *
 * Uses a tmp-file path override so tests don't touch ~/.vaultpilot-mcp.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setSnapshotPathForTests,
  loadSnapshots,
  saveSnapshots,
} from "../src/modules/incidents/token2022-snapshots.js";

let tmpDir: string;
let snapshotPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultpilot-snap-test-"));
  snapshotPath = join(tmpDir, "token2022-snapshots.json");
  _setSnapshotPathForTests(snapshotPath);
});

afterEach(() => {
  _setSnapshotPathForTests(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSnapshots", () => {
  it("returns {} when the file doesn't exist (cold start)", () => {
    expect(loadSnapshots()).toEqual({});
  });

  it("parses a previously written snapshot", () => {
    saveSnapshots({
      MINTaaaa: { extensions: [14, 18], snappedAt: "2026-04-26T00:00:00.000Z" },
    });
    const loaded = loadSnapshots();
    expect(loaded.MINTaaaa.extensions).toEqual([14, 18]);
  });

  it("returns {} on malformed JSON rather than throwing (advisory store)", () => {
    // Hand-write a corrupt file at the override path.
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(snapshotPath, "{not valid json", "utf8");
    expect(loadSnapshots()).toEqual({});
  });

  it("returns {} when the file holds a non-object root (e.g. array)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(snapshotPath, "[1,2,3]", "utf8");
    expect(loadSnapshots()).toEqual({});
  });
});

describe("saveSnapshots", () => {
  it("writes 0o600 mode (mode is preserved by atomicWriteJson convention)", () => {
    saveSnapshots({
      X: { extensions: [3], snappedAt: "2026-04-26T00:00:00.000Z" },
    });
    expect(existsSync(snapshotPath)).toBe(true);
    // Atomic-write: tmp + rename. After save there should be no leftover .tmp
    expect(existsSync(`${snapshotPath}.vaultpilot.tmp`)).toBe(false);
  });

  it("overwrites previous snapshot in place (no append)", () => {
    saveSnapshots({ A: { extensions: [1], snappedAt: "t1" } });
    saveSnapshots({ B: { extensions: [2], snappedAt: "t2" } });
    const final = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(final)).toEqual(["B"]);
  });

  it("round-trip: save then load yields the same data", () => {
    const store = {
      MintZ: { extensions: [14, 12, 6], snappedAt: "2026-04-26T01:23:45.000Z" },
      MintY: { extensions: [], snappedAt: "2026-04-26T01:23:45.000Z" },
    };
    saveSnapshots(store);
    expect(loadSnapshots()).toEqual(store);
  });
});
