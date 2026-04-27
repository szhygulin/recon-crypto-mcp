/**
 * Regression test for issue #395.
 *
 * Repro from the issue: VAULTPILOT_DEMO=1, no WALLETCONNECT_PROJECT_ID, run
 * set_demo_wallet → prepare_aave_withdraw → preview_send. The preview path
 * threw "No WalletConnect project ID configured" because runEvmPreSignGuards
 * called getConnectedAccounts() unconditionally, which initializes the WC
 * SignClient and reads the project ID before any account lookup happens.
 *
 * Fix: skip the WC account-match check (and the connected-accounts fallback
 * for tx.from) when isDemoMode() is true. send_transaction already returns
 * a sim envelope in demo mode, so the WC transport is never actually used —
 * the project-ID check is dead weight on the demo flow.
 *
 * The test deliberately does NOT mock src/signing/walletconnect.js so that
 * any accidental call into that module (which is what the bug was) would
 * still throw the real "No WalletConnect project ID configured" error and
 * fail the test. The RPC + pre-sign-check mocks mirror preview-token-gate's
 * setup so we only test the demo-mode branch in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function mockEvmRpcOnly() {
  vi.doMock("../src/data/rpc.js", () => ({
    getClient: () => ({
      call: vi.fn().mockResolvedValue({ data: "0x" }),
      getTransactionCount: vi.fn().mockResolvedValue(7),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(2_000_000_000n),
      estimateGas: vi.fn().mockResolvedValue(21_000n),
    }),
    verifyChainId: vi.fn().mockResolvedValue(undefined),
    resetClients: () => {},
  }));
  vi.doMock("../src/signing/pre-sign-check.js", () => ({
    assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
  }));
}

function makeDemoEvmTx() {
  return {
    chain: "ethereum" as const,
    to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
    data: "0x" as `0x${string}`,
    value: "1",
    from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361" as `0x${string}`,
    description: "demo aave withdraw",
  };
}

describe("preview_send in demo mode (issue #395)", () => {
  const originalDemo = process.env.VAULTPILOT_DEMO;
  const originalWcId = process.env.WALLETCONNECT_PROJECT_ID;

  beforeEach(() => {
    vi.resetModules();
    process.env.VAULTPILOT_DEMO = "true";
    delete process.env.WALLETCONNECT_PROJECT_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDemo === undefined) delete process.env.VAULTPILOT_DEMO;
    else process.env.VAULTPILOT_DEMO = originalDemo;
    if (originalWcId === undefined) delete process.env.WALLETCONNECT_PROJECT_ID;
    else process.env.WALLETCONNECT_PROJECT_ID = originalWcId;
  });

  it("does not throw 'No WalletConnect project ID configured' — runs the integrity-check path through to a pinned hash", async () => {
    mockEvmRpcOnly();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(makeDemoEvmTx());
    const { previewSend } = await import("../src/modules/execution/index.js");

    const preview = await previewSend({ handle: stamped.handle! });

    expect(preview.previewToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.preSignHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(preview.pinned.nonce).toBe(7);
    expect(preview.from ?? stamped.from).toBeDefined();
  });

  it("still throws when tx.from is unset in demo mode — caller must pre-set it via prepare_*", async () => {
    mockEvmRpcOnly();
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const txWithoutFrom = { ...makeDemoEvmTx(), from: undefined };
    const stamped = issueHandles(txWithoutFrom as ReturnType<typeof makeDemoEvmTx>);
    const { previewSend } = await import("../src/modules/execution/index.js");

    await expect(previewSend({ handle: stamped.handle! })).rejects.toThrow(
      /demo mode/i,
    );
  });
});
