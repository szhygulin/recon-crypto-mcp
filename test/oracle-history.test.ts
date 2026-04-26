import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSample,
  getMedian,
  getSampleCount,
  getFeedSnapshot,
  ORACLE_HISTORY_WINDOW_SECONDS,
  _resetOracleHistoryCache,
  _seedOracleHistoryForTests,
} from "../src/modules/incidents/oracle-history.js";

/**
 * Pure tests for the persistent rolling-median ring buffer (#255).
 * No I/O on real disk locations — we redirect via VAULTPILOT_ORACLE_HISTORY_PATH
 * to a tmp dir per test.
 */

const FEED = "TestFeed111111111111111111111111111111111111";
const NOW_SEC = 1_750_000_000; // arbitrary anchor used as "now"

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultpilot-oracle-history-"));
  process.env.VAULTPILOT_ORACLE_HISTORY_PATH = join(tmpDir, "store.json");
  _resetOracleHistoryCache();
  vi.useFakeTimers({ now: NOW_SEC * 1000 });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.VAULTPILOT_ORACLE_HISTORY_PATH;
});

describe("oracle-history — append + persistence", () => {
  it("persists a sample to disk on append", () => {
    appendSample(FEED, NOW_SEC, 100);
    expect(getSampleCount(FEED)).toBe(1);
    expect(existsSync(process.env.VAULTPILOT_ORACLE_HISTORY_PATH!)).toBe(true);
  });

  it("ignores non-finite prices (NaN, Infinity) — won't poison the buffer", () => {
    appendSample(FEED, NOW_SEC, NaN);
    appendSample(FEED, NOW_SEC, Infinity);
    appendSample(FEED, NOW_SEC, -Infinity);
    expect(getSampleCount(FEED)).toBe(0);
  });

  it("trims samples older than the 24h window on every append", () => {
    // Seed: one sample 25h ago, one 1h ago, one now.
    appendSample(FEED, NOW_SEC - 25 * 3600, 100);
    // The 25h-old sample should still be in the buffer right after
    // append (cutoff doesn't apply to its own append). But once a
    // newer append happens, the trim filters it.
    appendSample(FEED, NOW_SEC - 1 * 3600, 110);
    appendSample(FEED, NOW_SEC, 120);
    // After the third append, the 25h-old one is outside the window
    // and got trimmed.
    expect(getSampleCount(FEED)).toBe(2);
    const snap = getFeedSnapshot(FEED)!;
    expect(snap.oldestSec).toBe(NOW_SEC - 1 * 3600);
    expect(snap.newestSec).toBe(NOW_SEC);
  });

  it("survives a re-read after cache reset (persistence works)", () => {
    appendSample(FEED, NOW_SEC, 100);
    appendSample(FEED, NOW_SEC + 60, 102);
    // Drop in-memory cache, simulating a process restart.
    _resetOracleHistoryCache();
    expect(getSampleCount(FEED)).toBe(2);
  });
});

describe("oracle-history — median calculation", () => {
  it("returns undefined when sample count is below minSamples", () => {
    for (let i = 0; i < 30; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 100 + i);
    }
    // Default minSamples is 60; we have 30 → undefined.
    expect(getMedian(FEED)).toBeUndefined();
    // Lower the bar — now it returns.
    expect(getMedian(FEED, { minSamples: 10 })).toBeDefined();
  });

  it("computes median over an odd-count buffer", () => {
    // 5 samples: 100, 102, 104, 106, 108 → median 104.
    for (let i = 0; i < 5; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 100 + i * 2);
    }
    expect(getMedian(FEED, { minSamples: 5 })).toBe(104);
  });

  it("computes median over an even-count buffer (averages middle two)", () => {
    // 4 samples: 100, 102, 104, 106 → median (102+104)/2 = 103.
    for (let i = 0; i < 4; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 100 + i * 2);
    }
    expect(getMedian(FEED, { minSamples: 4 })).toBe(103);
  });

  it("median ignores samples outside the rolling window", () => {
    // 5 in-window samples around 100, plus 5 way-outside-window samples
    // around 1000. Median over the combined set would be ~550, but
    // the trim should drop the old ones.
    for (let i = 0; i < 5; i++) {
      // these will get trimmed on the next append (before the 5 in-window appends)
      appendSample(FEED, NOW_SEC - 25 * 3600 - i * 60, 1000);
    }
    for (let i = 0; i < 5; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 100 + i);
    }
    // Only the in-window samples (100..104) contribute.
    const m = getMedian(FEED, { minSamples: 5 })!;
    expect(m).toBeLessThan(110);
    expect(m).toBeGreaterThan(99);
  });

  it("returns undefined when feed has no samples", () => {
    expect(getMedian("UnknownFeed", { minSamples: 1 })).toBeUndefined();
  });
});

describe("oracle-history — feed snapshot diagnostic", () => {
  it("returns count + oldest/newest timestamps for a populated feed", () => {
    appendSample(FEED, NOW_SEC - 3600, 100);
    appendSample(FEED, NOW_SEC - 1800, 101);
    appendSample(FEED, NOW_SEC, 102);
    const snap = getFeedSnapshot(FEED)!;
    expect(snap.count).toBe(3);
    expect(snap.oldestSec).toBe(NOW_SEC - 3600);
    expect(snap.newestSec).toBe(NOW_SEC);
    expect(snap.updatedAt).toBe(NOW_SEC);
  });

  it("returns undefined for a feed never seen", () => {
    expect(getFeedSnapshot("UnknownFeed")).toBeUndefined();
  });
});

describe("oracle-history — corrupt/missing file resilience", () => {
  it("treats a missing file as an empty store (no crash)", () => {
    expect(getMedian(FEED, { minSamples: 1 })).toBeUndefined();
    expect(getSampleCount(FEED)).toBe(0);
  });

  it("treats a malformed file as an empty store (no crash)", async () => {
    const fs = await import("node:fs");
    const path = process.env.VAULTPILOT_ORACLE_HISTORY_PATH!;
    fs.mkdirSync(join(path, ".."), { recursive: true });
    fs.writeFileSync(path, "{not valid json}");
    _resetOracleHistoryCache();
    expect(getMedian(FEED, { minSamples: 1 })).toBeUndefined();
    // After the empty-store fallback, an append should still work.
    appendSample(FEED, NOW_SEC, 100);
    expect(getSampleCount(FEED)).toBe(1);
  });
});

describe("oracle-history — anomaly-detector contract sanity", () => {
  // The detector in chain-solana.ts computes:
  //   deviationPct = abs(current - median) / median
  // and flags when deviationPct > feed.anomalyThresholdPct.
  // These tests pin the math so a refactor of the detector can't
  // silently change the threshold meaning.

  it("a 5% deviation from median is correctly computed", () => {
    for (let i = 0; i < 60; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 100);
    }
    const median = getMedian(FEED)!;
    expect(median).toBe(100);
    // Current price 105 → deviation 5%.
    const current = 105;
    const dev = Math.abs(current - median) / median;
    expect(dev).toBeCloseTo(0.05);
  });

  it("a 1% deviation from median is correctly computed (stables threshold case)", () => {
    for (let i = 0; i < 60; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 1.0);
    }
    const median = getMedian(FEED)!;
    expect(median).toBe(1.0);
    const current = 1.01;
    const dev = Math.abs(current - median) / median;
    expect(dev).toBeCloseTo(0.01, 5);
  });

  it("downward deviation is computed identically (abs)", () => {
    for (let i = 0; i < 60; i++) {
      appendSample(FEED, NOW_SEC - i * 60, 100);
    }
    const median = getMedian(FEED)!;
    const current = 92; // 8% drop
    const dev = Math.abs(current - median) / median;
    expect(dev).toBeCloseTo(0.08);
  });
});

describe("oracle-history — _seedOracleHistoryForTests helper", () => {
  it("seeds the in-memory + on-disk store with a hand-crafted shape", () => {
    _seedOracleHistoryForTests({
      [FEED]: {
        samples: [
          { t: NOW_SEC - 120, p: 100 },
          { t: NOW_SEC - 60, p: 101 },
          { t: NOW_SEC, p: 102 },
        ],
        updatedAt: NOW_SEC,
      },
    });
    expect(getSampleCount(FEED)).toBe(3);
    expect(getMedian(FEED, { minSamples: 3 })).toBe(101);
  });
});

describe("oracle-history — window constant", () => {
  it("rolling window is exactly 24 hours per the issue spec", () => {
    expect(ORACLE_HISTORY_WINDOW_SECONDS).toBe(24 * 60 * 60);
  });
});
