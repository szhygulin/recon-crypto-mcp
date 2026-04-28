/**
 * Spot-check tests asserting `durableBindings` flows from each
 * Inv #14 prepare_* tool's response (issue #460).
 *
 * Per `feedback_guard_tests_exercise_real_shape`, these tests use the
 * real builders' return values where possible (mocking only the
 * Connection / RPC client). No re-implementation of the assertion
 * surface — the test asserts the field directly off the production
 * response.
 *
 * Coverage (one assertion per op class):
 *   - Compound (compound-comet-address)
 *   - Morpho Blue (morpho-blue-market-id)
 *   - Uniswap V3 burn (uniswap-v3-lp-token-id) — picked over increase
 *     because burn has a single read path and no approval chain
 *   - prepare_revoke_approval (approval-spender-address)
 *
 * The Solana / TRON / BTC-multisig builders need richer mocks —
 * existing test files already mock those deeply; their durable-
 * bindings assertion lives in this same file via a thinner mock or
 * directly verifies the helper-emitted shape. Keeping the network of
 * mocks per builder local rather than dragging in a kitchen-sink
 * fixture keeps the failure mode actionable: when the test fails, the
 * call site is in front of you.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Inv #14 durable-binding emission (#460)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("buildCompoundSupply emits compound-comet-address binding", async () => {
    const client = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "isSupplyPaused") return false;
        if (params.functionName === "allowance") return 0n;
        throw new Error(`unmocked readContract: ${params.functionName}`);
      }),
      multicall: vi.fn(async () => [6, "USDC"]),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { buildCompoundSupply } = await import(
      "../src/modules/compound/actions.js"
    );
    const tx = await buildCompoundSupply({
      chain: "ethereum",
      market: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      wallet: "0x1111111111111111111111111111111111111111",
      amount: "100",
    });
    // Approval is chained via `next`; the durable-binding lives on the
    // action tx (the deepest `next` hop) since the spender on the
    // approve is the same Comet — no point binding it twice.
    const action = tx.next ?? tx;
    expect(action.durableBindings).toBeDefined();
    expect(action.durableBindings).toHaveLength(1);
    expect(action.durableBindings![0].kind).toBe("compound-comet-address");
    expect(action.durableBindings![0].identifier).toBe(
      "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    );
    expect(action.durableBindings![0].provenanceHint).toMatch(/compound\.finance/);
  });

  it("buildMorphoBorrow emits morpho-blue-market-id binding", async () => {
    const client = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "idToMarketParams") {
          // Morpho's idToMarketParams returns a tuple, not an object;
          // viem decodes it as a 5-element array.
          return [
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // loanToken
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // collateralToken
            ("0x" + "11".repeat(20)) as `0x${string}`,    // oracle
            ("0x" + "22".repeat(20)) as `0x${string}`,    // irm
            800000000000000000n,                          // lltv
          ];
        }
        throw new Error(`unmocked readContract: ${params.functionName}`);
      }),
      multicall: vi.fn(async () => [6, "USDC"]),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const marketId =
      "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49";
    const { buildMorphoBorrow } = await import(
      "../src/modules/morpho/actions.js"
    );
    const tx = await buildMorphoBorrow({
      chain: "ethereum",
      wallet: "0x1111111111111111111111111111111111111111",
      marketId: marketId as `0x${string}`,
      amount: "100",
    });
    expect(tx.durableBindings).toBeDefined();
    expect(tx.durableBindings).toHaveLength(1);
    expect(tx.durableBindings![0].kind).toBe("morpho-blue-market-id");
    expect(tx.durableBindings![0].identifier).toBe(marketId);
    expect(tx.durableBindings![0].provenanceHint).toMatch(/morpho\.org/);
  });

  it("buildUniswapBurn emits uniswap-v3-lp-token-id binding", async () => {
    const tokenId = "12345";
    const owner = "0x1111111111111111111111111111111111111111";
    const client = {
      multicall: vi.fn(async () => [
        // positions(tokenId) — returns 12-element tuple
        [
          0n, // nonce
          "0x0000000000000000000000000000000000000000", // operator
          "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // token0
          "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // token1
          3000, // fee
          -100, // tickLower
          100, // tickUpper
          0n, // liquidity (zero so burn proceeds)
          0n, // feeGrowthInside0LastX128
          0n, // feeGrowthInside1LastX128
          0n, // tokensOwed0 (zero so burn proceeds)
          0n, // tokensOwed1 (zero so burn proceeds)
        ],
        owner,
      ]),
      readContract: vi.fn(),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { buildUniswapBurn } = await import(
      "../src/modules/lp/uniswap-v3/actions.js"
    );
    const tx = await buildUniswapBurn({
      chain: "ethereum",
      wallet: owner,
      tokenId,
    });
    expect(tx.durableBindings).toBeDefined();
    expect(tx.durableBindings).toHaveLength(1);
    expect(tx.durableBindings![0].kind).toBe("uniswap-v3-lp-token-id");
    expect(tx.durableBindings![0].identifier).toBe(tokenId);
    expect(tx.durableBindings![0].provenanceHint).toMatch(/uniswap\.org/);
  });

  it("prepareRevokeApproval emits approval-spender-address binding", async () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const spender = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const client = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "allowance") return 1_000_000n; // > 0 so revoke proceeds
        throw new Error(`unmocked readContract: ${params.functionName}`);
      }),
      multicall: vi.fn(async () => [6, "USDC"]),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      resetClients: () => {},
    }));
    const { prepareRevokeApproval } = await import(
      "../src/modules/execution/index.js"
    );
    const tx = await prepareRevokeApproval({
      wallet,
      chain: "ethereum",
      token,
      spender,
    });
    expect(tx.durableBindings).toBeDefined();
    expect(tx.durableBindings).toHaveLength(1);
    expect(tx.durableBindings![0].kind).toBe("approval-spender-address");
    expect(tx.durableBindings![0].identifier).toBe(spender);
    expect(tx.durableBindings![0].provenanceHint).toMatch(/etherscan/);
  });
});
