/**
 * Regression tests for issue #75 — `send_transaction` hanging indefinitely
 * when the WalletConnect session is dead. The fix adds a 5s ping-probe
 * before publishing and a 120s hard timeout on the request itself; both
 * paths now throw structured errors the agent can surface instead of
 * blocking the chat.
 */
import { describe, it, expect } from "vitest";
import { probeSessionLiveness } from "../src/signing/walletconnect.js";
import type { SignClient } from "@walletconnect/sign-client";

describe("probeSessionLiveness", () => {
  it("returns 'alive' when ping resolves promptly", async () => {
    const fakeClient = {
      ping: async () => {},
    } as unknown as InstanceType<typeof SignClient>;
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    expect(result).toBe("alive");
  });

  it("returns 'dead' when ping rejects immediately (explicit peer rejection)", async () => {
    const fakeClient = {
      ping: async () => {
        throw new Error("no matching session");
      },
    } as unknown as InstanceType<typeof SignClient>;
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    expect(result).toBe("dead");
  });

  it("returns 'unknown' when ping hangs past the 5s timeout", async () => {
    // Never resolves → forced timeout path. Real-world: peer is offline or
    // the relay can't deliver.
    const fakeClient = {
      ping: () => new Promise(() => {}),
    } as unknown as InstanceType<typeof SignClient>;
    const start = Date.now();
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    const elapsed = Date.now() - start;
    expect(result).toBe("unknown");
    // The probe must return in ~5s, not block indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);
});

describe("WalletConnectSessionUnavailableError", () => {
  it("exports a stable error name so agents can branch on it", async () => {
    const { WalletConnectSessionUnavailableError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectSessionUnavailableError("test");
    expect(e.name).toBe("WalletConnectSessionUnavailableError");
    expect(e instanceof Error).toBe(true);
  });
});

describe("WalletConnectRequestTimeoutError", () => {
  it("exports a stable error name so agents can branch on it", async () => {
    const { WalletConnectRequestTimeoutError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectRequestTimeoutError("test");
    expect(e.name).toBe("WalletConnectRequestTimeoutError");
    expect(e instanceof Error).toBe(true);
  });
});

// Issue #219 regression: when the dead-session error fires from the
// requestSendTransaction path, the user-facing message must NOT advise
// "Settings → Connected Apps → reconnect" (Ledger Live's UI is stale on
// relay-side ends — there is no reconnect affordance on the stale entry).
// Lead with `pair_ledger_live` and explicitly call out the stale-UI case.
describe("deadSessionMessage — issue #219 wording lock", () => {
  it("leads with pair_ledger_live as the recovery, not reconnect-in-settings", async () => {
    const { deadSessionMessage } = await import(
      "../src/signing/walletconnect.js"
    );
    const msg = deadSessionMessage();
    expect(msg).toContain("`pair_ledger_live`");
    expect(msg).toContain("local session record has been cleared");
    // Stale-UI heads-up — the whole point of #219.
    expect(msg).toContain("Ledger Live's UI may still list");
    expect(msg).toContain("listing is stale");
    expect(msg).toContain('no "reconnect" affordance');
    // Old wording must NOT survive — it sent users on a wild-goose chase.
    expect(msg).not.toContain("and reconnect, or run");
  });

  it("clears local session state in the dead branch (no stale record on disk)", async () => {
    // The compiled error message + the cleanup sequence are the contract.
    // Source-scrape the dead branch to confirm the cleanup ordering.
    // Anchor on the unique `deadTopic` local — the startup branch in
    // getSignClient does similar cleanup but uses currentSession.topic
    // directly, and we don't want this assertion to accidentally catch it.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    const deadBranch = src.match(
      /const deadTopic = currentSession\.topic;[\s\S]*?deadSessionMessage\(\)/,
    );
    expect(deadBranch, "requestSendTransaction dead branch not found").toBeTruthy();
    const code = deadBranch![0];
    expect(code).toMatch(/c\.session\.delete\(deadTopic/);
    expect(code).toMatch(/currentSession = null/);
    expect(code).toMatch(/sessionTopic: undefined,\s+pairingTopic: undefined/);
  });
});

// Issue #218 regression: the 120s timeout error must NOT advise "the
// handle is still valid for retry" without qualification — that wording
// invites a double-broadcast attempt. The new wording warns about the
// late-broadcast race and surfaces the pinned (from, nonce, chainId) so
// the agent can suggest concrete on-chain checks before any retry.
describe("timeoutMessage — issue #218 wording lock", () => {
  it("warns about async late broadcast and forbids blind retry; embeds pinned (from, nonce, chainId)", async () => {
    const { timeoutMessage } = await import(
      "../src/signing/walletconnect.js"
    );
    const msg = timeoutMessage({
      timeoutSeconds: 120,
      from: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      nonce: 272,
      chainId: 1,
    });
    expect(msg).toContain("may still broadcast the tx asynchronously");
    expect(msg).toContain("DO NOT retry blindly");
    expect(msg).toContain("double-broadcast");
    expect(msg).toContain("get_transaction_status");
    // Pinned fields surfaced verbatim so the agent can act on them.
    expect(msg).toContain("0xC0f5b7f7703BA95dC7C09D4eF50A830622234075");
    expect(msg).toContain("nonce `272`");
    expect(msg).toContain("chain id `1`");
    // Old wording must NOT survive — it implied retry was safe.
    expect(msg).not.toContain("handle is still valid for retry (15-minute TTL");
  });

  it("falls back to a clear placeholder when nonce wasn't pinned", async () => {
    const { timeoutMessage } = await import(
      "../src/signing/walletconnect.js"
    );
    const msg = timeoutMessage({
      timeoutSeconds: 120,
      from: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      nonce: "<unpinned — check pending nonce on chain>",
      chainId: 1,
    });
    expect(msg).toContain("<unpinned — check pending nonce on chain>");
  });
});
