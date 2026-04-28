/**
 * Tests for the npm-registry update-available check.
 *
 * Locks:
 *   - compareSemver covers the spec corners (major/minor/patch ladder,
 *     prerelease ordering, malformed input → 0).
 *   - isUpdateAvailable refuses to nag on prereleases (either side).
 *   - kickoffUpdateCheck + consumeUpdateNotice surface the notice exactly
 *     once across the success path.
 *   - Network error / non-200 / malformed body / equal version → no notice.
 *   - VAULTPILOT_DISABLE_UPDATE_CHECK suppresses the fetch entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareSemver, isUpdateAvailable } from "../src/shared/semver.js";
import {
  consumeUpdateNotice,
  kickoffUpdateCheck,
  _resetUpdateCheckForTests,
  _setFetchForTests,
} from "../src/shared/version-check.js";

describe("compareSemver", () => {
  it("orders major.minor.patch correctly", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("0.10.0", "0.10.0")).toBe(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.10.1", "0.10.0")).toBe(1);
    expect(compareSemver("0.10.0", "0.10.1")).toBe(-1);
  });

  it("treats prerelease as less than the corresponding stable", () => {
    expect(compareSemver("0.11.0-rc.1", "0.11.0")).toBe(-1);
    expect(compareSemver("0.11.0", "0.11.0-rc.1")).toBe(1);
  });

  it("orders prerelease identifiers per semver spec", () => {
    expect(compareSemver("0.11.0-alpha", "0.11.0-beta")).toBe(-1);
    expect(compareSemver("0.11.0-rc.1", "0.11.0-rc.2")).toBe(-1);
    // Numeric < non-numeric per §11.4.3.
    expect(compareSemver("0.11.0-1", "0.11.0-alpha")).toBe(-1);
    // Longer prerelease > shorter when shorter is a prefix.
    expect(compareSemver("0.11.0-rc.1", "0.11.0-rc.1.0")).toBe(-1);
  });

  it("returns 0 on malformed input rather than throwing", () => {
    expect(compareSemver("not-a-version", "0.10.0")).toBe(0);
    expect(compareSemver("0.10.0", "")).toBe(0);
    expect(compareSemver("0.10", "0.10.0")).toBe(0);
  });

  it("strips +build suffix before compare", () => {
    expect(compareSemver("0.11.0+abc", "0.11.0+def")).toBe(0);
    expect(compareSemver("0.11.0+abc", "0.11.1")).toBe(-1);
  });
});

describe("isUpdateAvailable", () => {
  it("true only when both sides are stable and latest > current", () => {
    expect(isUpdateAvailable("0.10.0", "0.11.0")).toBe(true);
    expect(isUpdateAvailable("0.10.0", "0.10.0")).toBe(false);
    expect(isUpdateAvailable("0.11.0", "0.10.0")).toBe(false);
  });

  it("false when either side is a prerelease", () => {
    expect(isUpdateAvailable("0.10.0", "0.11.0-rc.1")).toBe(false);
    expect(isUpdateAvailable("0.10.0-rc.1", "0.11.0")).toBe(false);
  });

  it("false on malformed input rather than throwing", () => {
    expect(isUpdateAvailable("garbage", "0.11.0")).toBe(false);
    expect(isUpdateAvailable("0.10.0", "garbage")).toBe(false);
  });
});

describe("kickoffUpdateCheck + consumeUpdateNotice", () => {
  beforeEach(() => {
    _resetUpdateCheckForTests();
    delete process.env.VAULTPILOT_DISABLE_UPDATE_CHECK;
  });
  afterEach(() => {
    _setFetchForTests(null);
    _resetUpdateCheckForTests();
    delete process.env.VAULTPILOT_DISABLE_UPDATE_CHECK;
  });

  function makeFetch(version: string | null, opts?: { ok?: boolean; throwErr?: boolean }) {
    return vi.fn(async () => {
      if (opts?.throwErr) throw new Error("network down");
      const ok = opts?.ok ?? true;
      return {
        ok,
        json: async () => (version === null ? {} : { version }),
      } as Response;
    });
  }

  it("emits the notice once on a newer-version response, then returns null", async () => {
    // The version we ship in package.json is real (currently 0.11.1). Using
    // 999.0.0 forces "latest > current" no matter how the package version
    // changes underneath this test.
    _setFetchForTests(makeFetch("999.0.0"));
    kickoffUpdateCheck();
    // Yield to the microtask queue so the fetch promise settles.
    await new Promise((r) => setTimeout(r, 0));
    const first = consumeUpdateNotice();
    expect(first).toMatch(/^VAULTPILOT NOTICE — Update available/);
    expect(first).toMatch(/999\.0\.0/);
    expect(consumeUpdateNotice()).toBeNull();
  });

  it("emits no notice when the registry version equals or is older than current", async () => {
    _setFetchForTests(makeFetch("0.0.0"));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(consumeUpdateNotice()).toBeNull();
  });

  it("emits no notice on a network error", async () => {
    _setFetchForTests(makeFetch(null, { throwErr: true }));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(consumeUpdateNotice()).toBeNull();
  });

  it("emits no notice on a non-200 response", async () => {
    _setFetchForTests(makeFetch("999.0.0", { ok: false }));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(consumeUpdateNotice()).toBeNull();
  });

  it("emits no notice when the response body lacks a .version field", async () => {
    _setFetchForTests(makeFetch(null));
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(consumeUpdateNotice()).toBeNull();
  });

  it("never makes the fetch call when VAULTPILOT_DISABLE_UPDATE_CHECK=1", async () => {
    process.env.VAULTPILOT_DISABLE_UPDATE_CHECK = "1";
    const f = makeFetch("999.0.0");
    _setFetchForTests(f);
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(f).not.toHaveBeenCalled();
    expect(consumeUpdateNotice()).toBeNull();
  });

  it("kickoffUpdateCheck is idempotent — second call is a no-op", async () => {
    const f = makeFetch("999.0.0");
    _setFetchForTests(f);
    kickoffUpdateCheck();
    kickoffUpdateCheck();
    kickoffUpdateCheck();
    await new Promise((r) => setTimeout(r, 0));
    expect(f).toHaveBeenCalledTimes(1);
  });
});
