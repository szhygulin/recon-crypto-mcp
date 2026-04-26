/**
 * Demo-mode unit tests. Covers:
 *
 *   - `isDemoMode()` reads VAULTPILOT_DEMO at call time (not module load),
 *     so a single process can flip behavior between calls;
 *   - `isSigningTool()` pattern-matches the prepare_, pair_ledger_,
 *     sign_message_ prefixes and the explicit signing-tool list;
 *   - `getDemoFixture()` returns a deterministic, non-empty payload for
 *     every fixtured tool, and the structured `not-implemented` echo for
 *     anything else;
 *   - `demoSigningRefusalMessage()` is stable for agents that pattern-
 *     match the prefix;
 *   - `assertNotDemoForSetup()` throws when demo is on, no-ops otherwise.
 *
 * The end-to-end behavior of the registerTool wrapper (signing tools
 * actually refused, read tools actually return fixtures through the
 * MCP content shape) is exercised indirectly: spinning up the full
 * server in a unit test is heavy; the wrapper is a thin composition
 * over already-tested primitives (`handler` + `getDemoFixture` +
 * `isSigningTool`), so we check those primitives directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

describe("isDemoMode — reads env at call time", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("returns true only when VAULTPILOT_DEMO is exactly 'true'", async () => {
    const { isDemoMode } = await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    expect(isDemoMode()).toBe(false);
    process.env[ENV_KEY] = "true";
    expect(isDemoMode()).toBe(true);
    process.env[ENV_KEY] = "TRUE"; // strictly case-sensitive — opt-in must be exact
    expect(isDemoMode()).toBe(false);
    process.env[ENV_KEY] = "1";
    expect(isDemoMode()).toBe(false);
    process.env[ENV_KEY] = "yes";
    expect(isDemoMode()).toBe(false);
  });
});

describe("isSigningTool — pattern + explicit-list classification", () => {
  it("classifies prepare_, pair_ledger_, sign_message_ prefixes as signing", async () => {
    const { isSigningTool } = await import("../src/demo/index.js");
    expect(isSigningTool("prepare_native_send")).toBe(true);
    expect(isSigningTool("prepare_aave_supply")).toBe(true);
    expect(isSigningTool("prepare_swap")).toBe(true);
    expect(isSigningTool("prepare_btc_send")).toBe(true);
    expect(isSigningTool("pair_ledger_live")).toBe(true);
    expect(isSigningTool("pair_ledger_btc")).toBe(true);
    expect(isSigningTool("pair_ledger_solana")).toBe(true);
    expect(isSigningTool("pair_ledger_tron")).toBe(true);
    expect(isSigningTool("sign_message_btc")).toBe(true);
  });

  it("classifies the explicit-list tools as signing", async () => {
    const { isSigningTool } = await import("../src/demo/index.js");
    expect(isSigningTool("send_transaction")).toBe(true);
    expect(isSigningTool("preview_send")).toBe(true);
    expect(isSigningTool("preview_solana_send")).toBe(true);
    expect(isSigningTool("verify_tx_decode")).toBe(true);
    expect(isSigningTool("get_verification_artifact")).toBe(true);
    expect(isSigningTool("request_capability")).toBe(true);
  });

  it("classifies read tools as non-signing", async () => {
    const { isSigningTool } = await import("../src/demo/index.js");
    expect(isSigningTool("get_token_balance")).toBe(false);
    expect(isSigningTool("get_portfolio_summary")).toBe(false);
    expect(isSigningTool("get_lending_positions")).toBe(false);
    expect(isSigningTool("get_btc_balance")).toBe(false);
    expect(isSigningTool("get_ledger_status")).toBe(false);
    expect(isSigningTool("get_marginfi_positions")).toBe(false);
    expect(isSigningTool("get_swap_quote")).toBe(false);
  });
});

describe("getDemoFixture — deterministic, non-empty for fixtured tools", () => {
  it("returns the same payload twice for the same args", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const a = getDemoFixture("get_ledger_status", undefined);
    const b = getDemoFixture("get_ledger_status", undefined);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns the demo wallet identity from get_ledger_status", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const result = getDemoFixture("get_ledger_status", undefined) as {
      paired: boolean;
      accounts: string[];
      bitcoin: { address: string }[];
    };
    expect(result.paired).toBe(true);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.bitcoin[0].address).toMatch(/^bc1q/);
  });

  it("returns realistic balance + USD value for get_token_balance", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const ethMainnet = getDemoFixture("get_token_balance", {
      chain: "ethereum",
      token: "native",
    }) as { symbol: string; valueUsd: number };
    expect(ethMainnet.symbol).toBe("ETH");
    expect(ethMainnet.valueUsd).toBeGreaterThan(0);

    // Per-(chain, token) variation: USDC on Arbitrum should differ from
    // ETH on Ethereum — tests that the lookup key is composite.
    const usdcArb = getDemoFixture("get_token_balance", {
      chain: "arbitrum",
      token: "0xaf88d065e77C8CC2239327C5EDb3A432268e5831",
    }) as { symbol: string; valueUsd: number };
    expect(usdcArb.symbol).toBe("USDC");
    expect(usdcArb.valueUsd).toBeGreaterThan(0);
  });

  it("returns the not-implemented payload for tools without a fixture", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const result = getDemoFixture("get_definitely_not_a_real_tool", { foo: 1 }) as {
      _demoFixture: string;
      _toolName: string;
      _message: string;
    };
    expect(result._demoFixture).toBe("not-implemented");
    expect(result._toolName).toBe("get_definitely_not_a_real_tool");
    expect(result._message).toContain("Demo mode is active");
    // Args must be echoed so the user knows what hit the tool.
    expect(result._message).toContain('"foo":1');
    // List of implemented fixtures is surfaced — helps the user discover
    // what's covered without grepping the source.
    expect(result._message).toContain("get_ledger_status");
    expect(result._message).toContain("get_portfolio_summary");
  });

  it("covers the priority tools the demo-mode plan calls out by name", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    // The plan names these as the headline fixtures for v1 — locking
    // them so a future fixture-table refactor can't silently drop one.
    for (const tool of [
      "get_ledger_status",
      "get_token_balance",
      "get_portfolio_summary",
      "get_lending_positions",
      "get_lp_positions",
      "get_staking_positions",
      "get_solana_staking_positions",
      "get_marginfi_positions",
      "get_tron_staking",
      "get_btc_balance",
      "get_btc_balances",
      "get_btc_account_balance",
      "get_transaction_history",
    ]) {
      const result = getDemoFixture(tool, undefined) as Record<string, unknown>;
      expect(result, `expected fixture for ${tool}`).toBeDefined();
      // A real fixture, not the not-implemented echo:
      expect(result._demoFixture, `${tool} fell through to not-implemented`).toBeUndefined();
    }
  });
});

describe("demoSigningRefusalMessage — stable for pattern-matching agents", () => {
  it("starts with [VAULTPILOT_DEMO] and names the blocked tool", async () => {
    const { demoSigningRefusalMessage } = await import("../src/demo/index.js");
    const msg = demoSigningRefusalMessage("prepare_swap");
    expect(msg.startsWith("[VAULTPILOT_DEMO]")).toBe(true);
    expect(msg).toContain("'prepare_swap'");
    expect(msg).toContain("disabled in demo mode");
    expect(msg).toContain("vaultpilot-mcp-setup");
  });
});

describe("assertNotDemoForSetup — refuses to write real config in demo mode", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("throws when demo is active", async () => {
    const { assertNotDemoForSetup } = await import("../src/demo/index.js");
    process.env[ENV_KEY] = "true";
    expect(() => assertNotDemoForSetup()).toThrow(/disabled in demo mode/);
  });

  it("no-ops when demo is off", async () => {
    const { assertNotDemoForSetup } = await import("../src/demo/index.js");
    delete process.env[ENV_KEY];
    expect(() => assertNotDemoForSetup()).not.toThrow();
  });
});
