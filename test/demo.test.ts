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

  it("covers all priority tools the demo-mode plan calls out by name (v1 + v2 + v3)", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    // v1 (24) + v2 (19) + v3 (18) = 61 fixtured read tools. Locking them
    // so a future fixture-table refactor can't silently drop one. If a
    // tool here falls through to the `not-implemented` echo, the test
    // fails with the offending tool name in the message.
    const fixturedTools = [
      // v1
      "get_ledger_status",
      "get_ledger_device_info",
      "get_token_balance",
      "get_token_metadata",
      "get_token_price",
      "get_portfolio_summary",
      "get_transaction_history",
      "get_lending_positions",
      "get_compound_positions",
      "get_morpho_positions",
      "get_lp_positions",
      "get_staking_positions",
      "get_solana_staking_positions",
      "get_marginfi_positions",
      "get_kamino_positions",
      "get_tron_staking",
      "get_btc_balance",
      "get_btc_balances",
      "get_btc_account_balance",
      "get_btc_block_tip",
      "get_btc_fee_estimates",
      "get_btc_tx_history",
      "get_market_incident_status",
      "get_health_alerts",
      // v2
      "get_swap_quote",
      "get_solana_swap_quote",
      "simulate_transaction",
      "get_transaction_status",
      "get_vaultpilot_config_status",
      "get_marginfi_diagnostics",
      "get_solana_setup_status",
      "rescan_btc_account",
      "get_compound_market_info",
      "simulate_position_change",
      "get_staking_rewards",
      "estimate_staking_yield",
      "check_contract_security",
      "check_permission_risks",
      "get_protocol_risk_score",
      "resolve_ens_name",
      "reverse_resolve_ens",
      "get_portfolio_diff",
      "list_tron_witnesses",
      // v3 (issue #371 follow-up — fixture refresh for tools shipped after demo v2)
      "get_ltc_balance",
      "get_ltc_block_tip",
      "get_ltc_chain_tips",
      "get_ltc_mempool_summary",
      "get_ltc_block_stats",
      "get_ltc_blocks_recent",
      "rescan_ltc_account",
      "get_curve_positions",
      "get_safe_positions",
      "get_nft_portfolio",
      "get_nft_collection",
      "get_nft_history",
      "get_daily_briefing",
      "get_pnl_summary",
      "compare_yields",
      "get_token_allowances",
      "get_coin_price",
      "explain_tx",
    ];
    expect(fixturedTools.length).toBe(61);
    for (const tool of fixturedTools) {
      const result = getDemoFixture(tool, undefined) as Record<string, unknown>;
      expect(result, `expected fixture for ${tool}`).toBeDefined();
      expect(result._demoFixture, `${tool} fell through to not-implemented`).toBeUndefined();
    }
  });
});

// v2 narrative-consistency tests. Fixtures are richer when they cite
// each other — a follow-up "did the swap from history confirm?" should
// return success because get_transaction_status recognizes the history
// fixture's hashes; a position-change simulation should project from
// the same Aave numbers get_lending_positions returned; etc. Lock these
// links so a future fixture refactor can't silently break the demo
// narrative.
describe("v2 fixtures — cross-fixture narrative consistency", () => {
  it("ENS round-trip: resolve(demo.eth) → DEMO_WALLET.evm; reverse(...) → demo.eth", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const { DEMO_WALLET } = await import("../src/demo/fixtures.js");
    const forward = getDemoFixture("resolve_ens_name", { name: "demo.eth" }) as {
      address: string | null;
    };
    expect(forward.address).toBe(DEMO_WALLET.evm);
    // vaultpilot.eth also resolves to the same wallet
    const alt = getDemoFixture("resolve_ens_name", { name: "vaultpilot.eth" }) as {
      address: string | null;
    };
    expect(alt.address).toBe(DEMO_WALLET.evm);
    const reverse = getDemoFixture("reverse_resolve_ens", {
      address: DEMO_WALLET.evm,
    }) as { name: string | null };
    expect(reverse.name).toBe("demo.eth");
    // Unknown names / addresses return null
    const unknownFwd = getDemoFixture("resolve_ens_name", { name: "vitalik.eth" }) as {
      address: string | null;
    };
    expect(unknownFwd.address).toBeNull();
    const unknownRev = getDemoFixture("reverse_resolve_ens", {
      address: "0x0000000000000000000000000000000000000001",
    }) as { name: string | null };
    expect(unknownRev.name).toBeNull();
  });

  it("get_transaction_status recognizes hashes from get_transaction_history", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const history = getDemoFixture("get_transaction_history", undefined) as {
      txs: { hash: string }[];
    };
    expect(history.txs.length).toBeGreaterThan(0);
    for (const tx of history.txs) {
      const status = getDemoFixture("get_transaction_status", {
        chain: "ethereum",
        txHash: tx.hash,
      }) as { status: string; confirmations: number };
      expect(status.status, `${tx.hash} should resolve as success`).toBe("success");
      expect(status.confirmations).toBeGreaterThan(0);
    }
    // Any other hash → pending
    const unknown = getDemoFixture("get_transaction_status", {
      chain: "ethereum",
      txHash: "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    }) as { status: string };
    expect(unknown.status).toBe("pending");
  });

  it("simulate_position_change projects from the v1 Aave numbers", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const aave = getDemoFixture("get_lending_positions", undefined) as {
      positions: { collateralUsd: number; debtUsd: number; healthFactor: number }[];
    };
    expect(aave.positions[0].collateralUsd).toBe(4_000);
    expect(aave.positions[0].debtUsd).toBe(800);
    // Borrow another 500 USDC against the same position → debt becomes
    // 1300, HF should be (4000 × 0.83) / 1300 ≈ 2.55.
    const sim = getDemoFixture("simulate_position_change", {
      protocol: "aave-v3",
      action: "borrow",
      asset: "USDC",
      amount: "500",
    }) as { projected: { collateralUsd: number; debtUsd: number; healthFactor: number } };
    expect(sim.projected.collateralUsd).toBe(4_000);
    expect(sim.projected.debtUsd).toBe(1_300);
    expect(sim.projected.healthFactor).toBeCloseTo(2.55, 1);
    // Repay 300 USDC → debt becomes 500, HF should be (4000 × 0.83) / 500 ≈ 6.64.
    const repay = getDemoFixture("simulate_position_change", {
      protocol: "aave-v3",
      action: "repay",
      asset: "USDC",
      amount: "300",
    }) as { projected: { healthFactor: number } };
    expect(repay.projected.healthFactor).toBeCloseTo(6.64, 1);
  });
});

describe("v2 fixtures — args-aware branching", () => {
  it("check_contract_security: known DeFi → verified; unknown → cautionary", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    // Aave V3 Pool — known
    const aave = getDemoFixture("check_contract_security", {
      address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
      chain: "ethereum",
    }) as {
      isVerified: boolean;
      dangerousFunctions: string[];
      notes: string[];
    };
    expect(aave.isVerified).toBe(true);
    expect(aave.dangerousFunctions).toEqual([]);
    expect(aave.notes.some((n) => n.includes("Aave V3 Pool"))).toBe(true);
    // Random address — unknown
    const unknown = getDemoFixture("check_contract_security", {
      address: "0xCafeBabe000000000000000000000000DeadBeef",
      chain: "ethereum",
    }) as { isVerified: boolean; dangerousFunctions: string[] };
    expect(unknown.isVerified).toBe(false);
    expect(unknown.dangerousFunctions.length).toBeGreaterThan(0);
  });

  it("check_permission_risks: same known-vs-unknown branching as security check", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const aave = getDemoFixture("check_permission_risks", {
      address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
      chain: "ethereum",
    }) as { roles: { holderType: string }[] };
    expect(aave.roles.every((r) => r.holderType === "TimelockController")).toBe(true);
    const unknown = getDemoFixture("check_permission_risks", {
      address: "0xCafeBabe000000000000000000000000DeadBeef",
      chain: "ethereum",
    }) as { roles: { holderType: string }[] };
    expect(unknown.roles.some((r) => r.holderType === "EOA")).toBe(true);
  });

  it("get_swap_quote: stable→stable on mainnet returns SushiSwap-routed exact-out shape", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    // Live exact-out shape from this session: 6000 USDT for USDC →
    // SushiSwap routing, fromAmount > 6000.
    const quote = getDemoFixture("get_swap_quote", {
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "6000",
      amountSide: "to",
    }) as {
      tool: string;
      crossChain: boolean;
      fromAmount: string;
      toAmountMin: string;
    };
    expect(quote.tool).toBe("sushiswap");
    expect(quote.crossChain).toBe(false);
    expect(parseFloat(quote.fromAmount)).toBeGreaterThan(6_000);
    expect(parseFloat(quote.toAmountMin)).toBeGreaterThanOrEqual(6_000);
  });

  it("get_swap_quote: cross-chain bridges go through `across`, not sushiswap", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const quote = getDemoFixture("get_swap_quote", {
      fromChain: "ethereum",
      toChain: "base",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
    }) as { tool: string; crossChain: boolean };
    expect(quote.tool).toBe("across");
    expect(quote.crossChain).toBe(true);
  });

  it("rescan_btc_account: only accountIndex 0 has data; others return empty + note", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const idx0 = getDemoFixture("rescan_btc_account", { accountIndex: 0 }) as {
      totalConfirmedBtc: string;
      note?: string;
    };
    expect(parseFloat(idx0.totalConfirmedBtc)).toBeGreaterThan(0);
    const idx5 = getDemoFixture("rescan_btc_account", { accountIndex: 5 }) as {
      totalConfirmedSats: string;
      note?: string;
    };
    expect(idx5.totalConfirmedSats).toBe("0");
    expect(idx5.note).toContain("only accountIndex 0 has data");
  });

  it("get_protocol_risk_score: known DeFi protocols score 70+; unknown defaults to 35", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    for (const protocol of ["aave-v3", "compound-v3", "lido", "uniswap-v3", "lifi"]) {
      const r = getDemoFixture("get_protocol_risk_score", { protocol }) as {
        score: number;
      };
      expect(r.score, `${protocol} should score 70+`).toBeGreaterThanOrEqual(70);
    }
    const unknown = getDemoFixture("get_protocol_risk_score", { protocol: "rugpull-v1" }) as {
      score: number;
    };
    expect(unknown.score).toBe(35);
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

describe("v3 fixtures — shape sanity for the post-v2 tool refresh (issue #371)", () => {
  it("get_vaultpilot_config_status fixture is now structurally aligned with the real return shape", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const status = getDemoFixture("get_vaultpilot_config_status", undefined) as Record<string, unknown>;
    // Real shape uses configFileExists + serverVersion + pairings (not configExists, version, pairedLedger).
    expect(status.configFileExists).toBe(true);
    expect(typeof status.serverVersion).toBe("string");
    expect(status.pairings).toBeDefined();
    expect((status.pairings as Record<string, unknown>).walletConnect).toBeDefined();
    // Old field names must NOT appear — would mean the fixture rotted again.
    expect(status.configExists).toBeUndefined();
    expect(status.version).toBeUndefined();
    expect(status.pairedLedger).toBeUndefined();
    expect(status.wcTopic).toBeUndefined();
    // Real-shape fields preflightSkill + setupHints + apiKey field name.
    expect(status.preflightSkill).toBeDefined();
    expect(Array.isArray(status.setupHints)).toBe(true);
    const apiKeys = status.apiKeys as Record<string, { set: boolean }>;
    expect(apiKeys.etherscan.set).toBe(true);
    expect(apiKeys.walletConnectProjectId).toBeDefined();
    expect((apiKeys as Record<string, unknown>).walletConnect).toBeUndefined();
    // demoMode sub-object preserved from PR 1.
    const demoMode = status.demoMode as { active: boolean; envVar: string };
    expect(demoMode.active).toBe(true);
    expect(demoMode.envVar).toBe("VAULTPILOT_DEMO");
  });

  it("LTC reads return realistic litecoin data with the demo wallet's LTC address", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const { DEMO_WALLET } = await import("../src/demo/fixtures.js");
    const balance = getDemoFixture("get_ltc_balance", undefined) as {
      address: string;
      confirmedLtc: string;
    };
    expect(balance.address).toBe(DEMO_WALLET.litecoin);
    expect(parseFloat(balance.confirmedLtc)).toBeGreaterThan(0);

    const tip = getDemoFixture("get_ltc_block_tip", undefined) as {
      height: number;
      hash: string;
    };
    expect(tip.height).toBeGreaterThan(2_000_000);
    expect(tip.hash.length).toBeGreaterThan(40);

    // get_ltc_blocks_recent honors the count arg (capped at 200).
    const recent = getDemoFixture("get_ltc_blocks_recent", { count: 10 }) as { length: number };
    expect((recent as unknown as Array<unknown>).length).toBe(10);
    const capped = getDemoFixture("get_ltc_blocks_recent", { count: 999 }) as Array<unknown>;
    expect(capped.length).toBe(200);
  });

  it("compare_yields returns rows sorted by APR descending and lists unavailable protocols", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const yields = getDemoFixture("compare_yields", { asset: "USDC" }) as {
      asset: string;
      rows: { protocol: string; supplyApr: number }[];
      unavailable: { protocol: string; reason: string }[];
    };
    expect(yields.asset).toBe("USDC");
    expect(yields.rows.length).toBeGreaterThan(0);
    // Sorted descending.
    for (let i = 0; i < yields.rows.length - 1; i++) {
      expect(yields.rows[i].supplyApr).toBeGreaterThanOrEqual(yields.rows[i + 1].supplyApr);
    }
    expect(yields.unavailable.length).toBeGreaterThan(0);
  });

  it("get_token_allowances flags the unlimited-approval count and labels known spenders", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    const allowances = getDemoFixture("get_token_allowances", undefined) as {
      unlimitedCount: number;
      rows: { spenderLabel?: string; isUnlimited: boolean }[];
      notes: string[];
    };
    expect(allowances.unlimitedCount).toBeGreaterThanOrEqual(1);
    const labeled = allowances.rows.find((r) => r.spenderLabel?.includes("Aave"));
    expect(labeled?.isUnlimited).toBe(true);
    expect(allowances.notes.join(" ")).toContain("unlimited");
  });

  it("get_coin_price returns table-backed prices for major non-EVM natives", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    for (const symbol of ["BTC", "LTC", "SOL", "TRX"]) {
      const r = getDemoFixture("get_coin_price", { symbol }) as {
        symbol: string;
        priceUsd: number;
        confidence: number;
      };
      expect(r.symbol).toBe(symbol);
      expect(r.priceUsd).toBeGreaterThan(0);
      expect(r.confidence).toBeGreaterThan(0.9);
    }
  });

  it("explain_tx + get_daily_briefing + get_pnl_summary honor the format arg (structured | markdown | both)", async () => {
    const { getDemoFixture } = await import("../src/demo/index.js");
    // explain_tx — both is the default
    const both = getDemoFixture("explain_tx", { txHash: "0xabc" }) as {
      markdown?: string;
      method?: string;
    };
    expect(both.markdown).toBeDefined();
    expect(both.method).toBeDefined();
    const onlyStruct = getDemoFixture("explain_tx", { txHash: "0xabc", format: "structured" }) as {
      markdown?: string;
      method?: string;
    };
    expect(onlyStruct.markdown).toBeUndefined();
    expect(onlyStruct.method).toBeDefined();
    const onlyMd = getDemoFixture("explain_tx", { txHash: "0xabc", format: "markdown" }) as {
      markdown?: string;
      method?: string;
    };
    expect(onlyMd.markdown).toBeDefined();
    expect(onlyMd.method).toBeUndefined();

    // daily_briefing same pattern
    const dbStruct = getDemoFixture("get_daily_briefing", { format: "structured" }) as {
      markdown?: string;
      portfolioTotal?: unknown;
    };
    expect(dbStruct.markdown).toBeUndefined();
    expect(dbStruct.portfolioTotal).toBeDefined();
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
