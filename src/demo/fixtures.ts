/**
 * Deterministic fixture data for VAULTPILOT_DEMO=true. Same args → same
 * response on every call so demo screenshots / videos / tutorials
 * reproduce identically. Fixtures here mirror the *shape* of the real
 * tool outputs but use values designed to look realistic at a glance to
 * a prospective user — not to pass strict cross-tool consistency checks
 * (the agent narrates each tool independently).
 *
 * Coverage policy:
 *   - The handful of tools the demo-mode plan calls out by name (the
 *     ones a user is most likely to hit in a 30-second walkthrough)
 *     get explicit fixtures.
 *   - Every other tool falls through to `getDemoFixture`'s
 *     `not-implemented` payload, which echoes the tool name + args so
 *     the user can see what's covered and what isn't.
 *
 * Demo-wallet choice: ONE EVM address, ONE TRON address, ONE Solana
 * address, ONE Bitcoin address. A single self-consistent identity makes
 * the demo narrative simpler ("this is your wallet across four chains")
 * and avoids the multi-account UX complexity that would distract from
 * the core read-only walkthrough.
 */

export const DEMO_WALLET = {
  evm: "0xDeFa1212121212121212121212121212121212De" as const,
  tron: "TDemoVAULTpilotxxxxxxxxxxxxxxxxxxxxx" as const,
  solana: "DEMo1111111111111111111111111111111111111111" as const,
  bitcoin: "bc1qdemo7xpyrkfsm7dl5kfjxgvm8azwj9c4yefzx0" as const,
  litecoin: "ltc1qdemo7xpyrkfsm7dl5kfjxgvm8azwj9c4ydemo0" as const,
};

/**
 * Known DeFi contract addresses, recognized by `check_contract_security`,
 * `check_permission_risks`, and `get_protocol_risk_score` so the same
 * contract gets a consistent risk verdict across all three tools (and
 * users see "Aave V3 Pool — verified, timelock-governed" rather than
 * generic "established protocol" hand-waving). Real mainnet addresses
 * — keys are lowercase for case-insensitive lookup, since the wire
 * format varies (EIP-55 in user input, lowercase in some indexers).
 */
const KNOWN_DEFI_ADDRESSES: Record<
  string,
  { name: string; protocol: string; kind: string; chain: string; isProxy: boolean }
> = {
  // Aave V3 Pool (mainnet)
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": {
    name: "Aave V3 Pool",
    protocol: "aave-v3",
    kind: "lending-pool",
    chain: "ethereum",
    isProxy: true,
  },
  // Compound V3 USDC Comet (Base)
  "0xb125e6687d4313864e53df431d5425969c15eb2f": {
    name: "Compound V3 USDC (Base)",
    protocol: "compound-v3",
    kind: "comet",
    chain: "base",
    isProxy: true,
  },
  // Lido stETH (mainnet)
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": {
    name: "Lido stETH",
    protocol: "lido",
    kind: "liquid-staking-token",
    chain: "ethereum",
    isProxy: true,
  },
  // Uniswap V3 NonfungiblePositionManager (mainnet)
  "0xc36442b4a4522e871399cd717abdd847ab11fe88": {
    name: "Uniswap V3 NonfungiblePositionManager",
    protocol: "uniswap-v3",
    kind: "lp-nft",
    chain: "ethereum",
    isProxy: false,
  },
  // LiFi diamond (multichain)
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": {
    name: "LiFi Diamond",
    protocol: "lifi",
    kind: "swap-bridge-aggregator",
    chain: "ethereum",
    isProxy: false,
  },
};

function lookupKnownDefi(addr: string | undefined) {
  if (!addr || typeof addr !== "string") return undefined;
  return KNOWN_DEFI_ADDRESSES[addr.toLowerCase()];
}

/**
 * The four `0xdemo*` tx hashes from `get_transaction_history`'s v1
 * fixture. `get_transaction_status` recognizes these and reports them
 * as confirmed (so the agent's narrative — "you swapped, supplied,
 * staked, bridged last month" — survives a follow-up "did the swap
 * confirm?" probe). Any other hash returns `pending`.
 */
const KNOWN_TX_HASHES: Set<string> = new Set([
  "0xdemo1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xdemo2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xdemo3ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdemo4dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
]);

/**
 * Each fixture function takes the (already-validated by the wrapper at
 * call time) tool args and returns a canned response. Args may be
 * undefined for argless tools (e.g. `get_ledger_status`).
 */
type FixtureFn = (args: unknown) => unknown;

export const DEMO_FIXTURES: Record<string, FixtureFn> = {
  // -------- Identity / pairing -------------------------------------------------
  get_ledger_status: () => ({
    paired: true,
    accounts: [DEMO_WALLET.evm],
    accountDetails: [
      {
        address: DEMO_WALLET.evm,
        chainIds: [1, 42161, 137, 8453],
        chains: ["ethereum", "arbitrum", "polygon", "base"],
      },
    ],
    topic: "demo0000000000000000000000000000000000000000000000000000000000",
    expiresAt: 9_999_999_999_000,
    wallet: "VaultPilot Demo Wallet",
    peerUrl: "https://demo.vaultpilot.example/",
    peerDescription: "Demo session — VAULTPILOT_DEMO=true (no real Ledger paired)",
    tron: [
      {
        address: DEMO_WALLET.tron,
        path: "44'/195'/0'/0/0",
        appVersion: "0.7.4",
        accountIndex: 0,
      },
    ],
    solana: [
      {
        address: DEMO_WALLET.solana,
        path: "44'/501'/0'",
        appVersion: "1.12.1",
        accountIndex: 0,
      },
    ],
    bitcoin: [
      {
        address: DEMO_WALLET.bitcoin,
        path: "84'/0'/0'/0/0",
        appVersion: "2.4.6",
        addressType: "segwit",
        accountIndex: 0,
        chain: 0,
        addressIndex: 0,
      },
    ],
  }),

  get_ledger_device_info: () => ({
    productName: "Nano X (demo)",
    seVersion: "2.2.3",
    mcuVersion: "2.30",
    serialNumber: "DEMO-XXXX-XXXX",
    isOnboarded: true,
    flags: { isInRecoveryMode: false },
  }),

  // -------- Token balances -----------------------------------------------------
  get_token_balance: (args) => {
    const a = (args ?? {}) as { chain?: string; token?: string };
    const chain = a.chain ?? "ethereum";
    const token = (a.token ?? "native").toLowerCase();
    const isNative = token === "native";
    const lookupKey = `${chain}:${isNative ? "native" : token}`;
    const slice = DEMO_TOKEN_BALANCES[lookupKey] ?? DEMO_TOKEN_BALANCES[`${chain}:native`];
    if (!slice) {
      return {
        token: a.token ?? "native",
        symbol: "DEMO",
        decimals: 18,
        amount: "0",
        formatted: "0",
        priceUsd: 0,
        valueUsd: 0,
      };
    }
    return slice;
  },

  // -------- Portfolio summary --------------------------------------------------
  get_portfolio_summary: () => DEMO_PORTFOLIO_SUMMARY,

  // -------- Lending / staking / LP --------------------------------------------
  get_lending_positions: () => DEMO_AAVE_POSITIONS,
  get_compound_positions: () => DEMO_COMPOUND_POSITIONS,
  get_morpho_positions: () => DEMO_MORPHO_POSITIONS,
  get_lp_positions: () => DEMO_UNIV3_POSITIONS,
  get_staking_positions: () => DEMO_LIDO_POSITIONS,
  get_solana_staking_positions: () => DEMO_SOLANA_STAKING,
  get_marginfi_positions: () => DEMO_MARGINFI_POSITIONS,
  get_kamino_positions: () => DEMO_KAMINO_POSITIONS,
  get_tron_staking: () => DEMO_TRON_STAKING,

  // -------- Bitcoin reads ------------------------------------------------------
  get_btc_balance: () => DEMO_BTC_SINGLE_BALANCE,
  get_btc_balances: () => ({
    addresses: [DEMO_BTC_SINGLE_BALANCE],
  }),
  get_btc_account_balance: () => DEMO_BTC_ACCOUNT_BALANCE,
  get_btc_block_tip: () => ({
    height: 946_598,
    hash: "0000000000000000000000000000000000000000000000000000demoabcdef1234",
    timestamp: 1_745_625_600,
    ageSeconds: 240,
  }),
  get_btc_fee_estimates: () => ({
    fastestFee: 18,
    halfHourFee: 9,
    hourFee: 5,
    economyFee: 2,
    minimumFee: 1,
  }),
  get_btc_tx_history: () => ({
    address: DEMO_WALLET.bitcoin,
    txs: [
      {
        txid: "demo1111111111111111111111111111111111111111111111111111111111",
        receivedSats: "7500000",
        sentSats: "0",
        feeSats: "0",
        blockHeight: 946_500,
        blockTime: 1_745_022_400,
        rbfEligible: false,
      },
    ],
  }),

  // -------- Tx history ---------------------------------------------------------
  get_transaction_history: () => DEMO_TX_HISTORY,

  // -------- Read-only helpers (cheap to fixture) -------------------------------
  get_token_metadata: (args) => {
    const a = (args ?? {}) as { token?: string };
    return {
      address: a.token ?? "native",
      symbol: "DEMO-TOKEN",
      decimals: 18,
      name: "Demo Token",
      priceUsd: 1,
    };
  },
  get_token_price: (args) => {
    const a = (args ?? {}) as { token?: string };
    return {
      token: a.token ?? "native",
      priceUsd: 1,
      source: "demo-fixture",
    };
  },
  get_market_incident_status: () => ({
    overallStatus: "operational",
    incidents: [],
    lastChecked: "2026-04-26T00:00:00Z",
  }),
  get_health_alerts: () => ({
    wallet: DEMO_WALLET.evm,
    alerts: [],
    summary: "All lending positions in the demo wallet are well above the liquidation threshold.",
  }),

  // -------- v2: swap & quote ---------------------------------------------------
  get_swap_quote: (args) => {
    const a = (args ?? {}) as {
      fromChain?: string;
      toChain?: string;
      fromToken?: string;
      toToken?: string;
      amount?: string;
      amountSide?: "from" | "to";
    };
    const fromChain = a.fromChain ?? "ethereum";
    const toChain = a.toChain ?? "ethereum";
    const amountIn = parseFloat(a.amount ?? "0") || 0;
    const exactOut = a.amountSide === "to";
    // Stable→stable on mainnet matches the live exact-out shape from
    // the session: SushiSwap routing, ~0.28% effective haircut.
    const isStablePair =
      isStableMint(a.fromToken) && isStableMint(a.toToken) && fromChain === toChain;
    if (isStablePair) {
      const expected = exactOut ? amountIn * 1.001 : amountIn * 0.999;
      const fromAmount = exactOut ? amountIn * 1.0039 : amountIn;
      const toAmount = exactOut ? amountIn : amountIn * 0.9971;
      return {
        fromChain,
        toChain,
        fromToken: { address: a.fromToken, symbol: "USDC", decimals: 6, priceUSD: "1.0" },
        toToken: { address: a.toToken, symbol: "USDT", decimals: 6, priceUSD: "1.0" },
        fromAmount: fromAmount.toFixed(6),
        toAmountMin: toAmount.toFixed(6),
        toAmountExpected: expected.toFixed(6),
        fromAmountUsd: fromAmount,
        toAmountUsd: toAmount,
        tool: "sushiswap",
        executionDurationSeconds: 0,
        feeCostsUsd: amountIn * 0.0025,
        gasCostsUsd: 0.21,
        crossChain: false,
      };
    }
    const isCrossChain = fromChain !== toChain;
    const out = exactOut ? amountIn : amountIn * 0.997;
    return {
      fromChain,
      toChain,
      fromToken: { address: a.fromToken, symbol: "DEMO-IN", decimals: 18 },
      toToken: { address: a.toToken, symbol: "DEMO-OUT", decimals: 18 },
      fromAmount: (exactOut ? amountIn * 1.003 : amountIn).toString(),
      toAmountMin: (out * 0.995).toString(),
      toAmountExpected: out.toString(),
      tool: isCrossChain ? "across" : "1inch",
      executionDurationSeconds: isCrossChain ? 480 : 0,
      feeCostsUsd: isCrossChain ? 4.5 : 0.6,
      gasCostsUsd: 0.18,
      crossChain: isCrossChain,
    };
  },

  get_solana_swap_quote: (args) => {
    const a = (args ?? {}) as { inputMint?: string; outputMint?: string; amount?: string };
    const amount = parseFloat(a.amount ?? "0") || 0;
    return {
      inputMint: a.inputMint ?? "So11111111111111111111111111111111111111112",
      outputMint: a.outputMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: amount.toString(),
      outAmount: (amount * 0.995).toString(),
      otherAmountThreshold: (amount * 0.99).toString(),
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: 0.0012,
      platformFee: null,
      routePlan: [
        {
          swapInfo: {
            ammKey: "DemoOrcaWhirlpoolxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            label: "Orca (Whirlpool)",
            inputMint: a.inputMint ?? "So11111111111111111111111111111111111111112",
            outputMint: a.outputMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            inAmount: amount.toString(),
            outAmount: (amount * 0.995).toString(),
            feeAmount: (amount * 0.0025).toString(),
            feeMint: a.inputMint ?? "So11111111111111111111111111111111111111112",
          },
          percent: 100,
        },
      ],
      contextSlot: 287_654_321,
      timeTaken: 0.082,
    };
  },

  simulate_transaction: (args) => {
    const a = (args ?? {}) as { data?: string };
    const data = a.data ?? "0x";
    // A specific marker calldata triggers the synthetic-revert demo so
    // the security narrative ("simulate said REVERT — don't sign") shows
    // up in the demo walkthrough; everything else returns ok.
    if (typeof data === "string" && data.toLowerCase().includes("dead")) {
      return {
        chain: "ethereum",
        ok: false,
        revertReason: "transfer amount exceeds balance",
        revert: {
          errorName: "ERC20InsufficientBalance",
          args: ["sender", "0", "1000000"],
          data: "0xfb8f41b2",
          source: "demo-fixture",
        },
      };
    }
    return { chain: "ethereum", ok: true, returnData: "0x" };
  },

  // -------- v2: status & diagnostics ------------------------------------------
  get_transaction_status: (args) => {
    const a = (args ?? {}) as { txHash?: string; chain?: string };
    const hash = (a.txHash ?? "").toLowerCase();
    if (KNOWN_TX_HASHES.has(hash)) {
      return {
        chain: a.chain ?? "ethereum",
        txHash: a.txHash,
        status: "success",
        confirmations: 142,
        blockHeight: 19_843_002,
        gasUsed: "73214",
      };
    }
    return {
      chain: a.chain ?? "ethereum",
      txHash: a.txHash,
      status: "pending",
      confirmations: 0,
      note: "demo fixture — only the four `0xdemo*` hashes from get_transaction_history are recognized as confirmed",
    };
  },

  get_vaultpilot_config_status: () => ({
    configPath: "~/.vaultpilot-mcp/config.json",
    configFileExists: true,
    serverVersion: "demo",
    rpc: {
      ethereum: { source: "env-var" },
      arbitrum: { source: "env-var" },
      polygon: { source: "env-var" },
      base: { source: "env-var" },
      optimism: { source: "env-var" },
      solana: { source: "env-var" },
    },
    apiKeys: {
      etherscan: { set: true, source: "config" },
      oneInch: { set: true, source: "config" },
      tronGrid: { set: true, source: "config" },
      walletConnectProjectId: { set: true, source: "config" },
    },
    pairings: {
      walletConnect: { sessionTopicSuffix: "demo0000" },
      solana: { count: 1 },
      tron: { count: 1 },
    },
    preflightSkill: {
      expectedPath: "~/.claude/skills/vaultpilot-preflight/SKILL.md",
      installed: true,
    },
    setupHints: [],
    demoMode: {
      active: true,
      envVar: "VAULTPILOT_DEMO",
      howToEnable:
        "Demo mode is active — read tools return deterministic fixture data, signing tools refuse with a structured demo error. To exit, unset VAULTPILOT_DEMO and restart the MCP server.",
    },
  }),

  get_marginfi_diagnostics: () => ({
    totalBanks: 188,
    decoded: 188,
    skipped: [],
    note: "demo fixture — all banks hydrated cleanly (no SDK drift in demo mode)",
  }),

  get_solana_setup_status: () => ({
    durableNonce: {
      exists: true,
      address: "DEMo11111111111111111111111111111111nonce0",
      lamports: 1_500_000,
      currentNonce: "DEMo11111111111111111111111111111nonceVal0",
      authority: DEMO_WALLET.solana,
    },
    marginfiAccounts: [
      { accountIndex: 0, address: "DEMo111111111111111111111111111111111mfi0" },
    ],
    note: "demo fixture — both Solana setup steps already complete",
  }),

  rescan_btc_account: (args) => {
    const a = (args ?? {}) as { accountIndex?: number };
    const idx = a.accountIndex ?? 0;
    if (idx !== 0) {
      return {
        accountIndex: idx,
        addressesQueried: 0,
        addressesCached: 0,
        totalConfirmedSats: "0",
        totalConfirmedBtc: "0",
        totalMempoolSats: "0",
        totalSats: "0",
        breakdown: [],
        note: `demo fixture — only accountIndex 0 has data; got ${idx}`,
      };
    }
    return {
      ...DEMO_BTC_ACCOUNT_BALANCE,
      note: "demo fixture — rescanned at 2026-04-26T00:00:00Z (no on-chain delta vs cache)",
    };
  },

  // -------- v2: DeFi protocol reads -------------------------------------------
  get_compound_market_info: (args) => {
    const a = (args ?? {}) as { chain?: string; market?: string };
    return {
      chain: a.chain ?? "base",
      market: a.market ?? "0xb125E6687d4313864e53df431d5425969c15Eb2F",
      baseToken: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        decimals: 6,
      },
      totalSupply: "12450000.00",
      totalBorrow: "8230000.00",
      utilization: 0.661,
      supplyApr: 0.041,
      borrowApr: 0.063,
      pausedActions: [],
      collateralAssets: [
        { symbol: "WETH", liquidationFactor: 0.83, supplyCap: "10000" },
        { symbol: "cbETH", liquidationFactor: 0.83, supplyCap: "5000" },
      ],
    };
  },

  simulate_position_change: (args) => {
    const a = (args ?? {}) as {
      protocol?: string;
      action?: "borrow" | "repay" | "supply" | "withdraw";
      asset?: string;
      amount?: string;
    };
    const proto = a.protocol ?? "aave-v3";
    if (proto !== "aave-v3") {
      return {
        ok: false,
        note: "demo fixture only models the v1 Aave V3 demo position; got protocol=" + proto,
      };
    }
    // v1 demo Aave numbers: 4000 collateral (1.726 WETH), 800 USDC debt.
    // Aave HF formula approximated as collateral × liqThreshold (0.83) / debt.
    const liqThreshold = 0.83;
    const baseCollateralUsd = 4_000;
    const baseDebtUsd = 800;
    const amount = parseFloat(a.amount ?? "0") || 0;
    let collateralUsd = baseCollateralUsd;
    let debtUsd = baseDebtUsd;
    if (a.action === "borrow") debtUsd += amount;
    else if (a.action === "repay") debtUsd = Math.max(0, debtUsd - amount);
    else if (a.action === "supply") collateralUsd += amount;
    else if (a.action === "withdraw") collateralUsd = Math.max(0, collateralUsd - amount);
    const healthFactor = debtUsd > 0 ? (collateralUsd * liqThreshold) / debtUsd : Infinity;
    return {
      protocol: "aave-v3",
      chain: "ethereum",
      action: a.action,
      asset: a.asset,
      amount: a.amount,
      projected: {
        collateralUsd,
        debtUsd,
        healthFactor: isFinite(healthFactor) ? Number(healthFactor.toFixed(2)) : null,
        liquidationThreshold: liqThreshold,
      },
      baseline: {
        collateralUsd: baseCollateralUsd,
        debtUsd: baseDebtUsd,
        healthFactor: 4.15,
      },
    };
  },

  get_staking_rewards: () => ({
    wallet: DEMO_WALLET.evm,
    period: "30d",
    estimated: [
      {
        protocol: "lido",
        asset: "stETH",
        amount: "0.0030",
        valueUsd: 6.94,
        note: "1.2 stETH × ~3.12% APR × 30d",
      },
      {
        protocol: "marginfi",
        asset: "USDC",
        amount: "4.07",
        valueUsd: 4.07,
        note: "800 USDC supply × ~6.2% APY × 30d",
      },
    ],
    totalUsd: 11.01,
    disclaimer: "demo fixture — values are deterministic projections, not realized rewards",
  }),

  estimate_staking_yield: (args) => {
    const a = (args ?? {}) as { protocol?: string; amount?: string };
    const amount = parseFloat(a.amount ?? "1.0") || 1.0;
    const known: Record<string, number> = {
      lido: 0.0312,
      "rocket-pool": 0.0298,
      marinade: 0.072,
      "jito-stake-pool": 0.078,
      eigenlayer: 0.041,
    };
    const apr = known[a.protocol ?? "lido"] ?? 0.05;
    const annualValueUsd = amount * 2316.09 * apr;
    return {
      protocol: a.protocol ?? "lido",
      amount: a.amount ?? "1.0",
      apr,
      estimatedAnnualYield: (amount * apr).toFixed(4),
      valueUsd: Number(annualValueUsd.toFixed(2)),
      note: "demo fixture — APR is a 30-day rolling estimate",
    };
  },

  // -------- v2: security advisory ---------------------------------------------
  check_contract_security: (args) => {
    const a = (args ?? {}) as { address?: string; chain?: string };
    const known = lookupKnownDefi(a.address);
    if (known) {
      return {
        address: a.address,
        chain: a.chain ?? known.chain,
        isVerified: true,
        isProxy: known.isProxy,
        ...(known.isProxy
          ? {
              implementation: "0xDemoImpl000000000000000000000000000000000",
              admin: { type: "TimelockController", delay: 86_400 },
            }
          : {}),
        dangerousFunctions: [],
        notes: [
          `${known.name} — established protocol (${known.protocol}), audited multiple times.`,
          "demo fixture — recognized as a well-known DeFi contract.",
        ],
        proxyPattern: known.isProxy ? "transparent-proxy" : null,
      };
    }
    return {
      address: a.address,
      chain: a.chain ?? "ethereum",
      isVerified: false,
      isProxy: false,
      dangerousFunctions: ["selfdestruct", "delegatecall to unverified target"],
      notes: [
        "Unverified contract — proceed with caution.",
        "demo fixture — any address NOT in the known-DeFi table returns this cautionary verdict so the demo walkthrough shows both safe and risky outcomes.",
      ],
    };
  },

  check_permission_risks: (args) => {
    const a = (args ?? {}) as { address?: string; chain?: string };
    const known = lookupKnownDefi(a.address);
    if (known) {
      return {
        address: a.address,
        chain: a.chain ?? known.chain,
        roles: [
          {
            function: "pause",
            holder: "0xDemoTimelock0000000000000000000000000000",
            holderType: "TimelockController",
            note: "24h timelock — well-protected",
          },
          {
            function: "upgrade",
            holder: "0xDemoTimelock0000000000000000000000000000",
            holderType: "TimelockController",
            note: "Same timelock as pause — single governance path",
          },
        ],
        notes: [
          `${known.name} — governance is on-chain timelock.`,
          "demo fixture — known DeFi contract with mature governance.",
        ],
      };
    }
    return {
      address: a.address,
      chain: a.chain ?? "ethereum",
      roles: [
        {
          function: "owner",
          holder: "0xDemoUnknownEOA000000000000000000000000000",
          holderType: "EOA",
          note: "Single EOA owner — high admin risk; can pause/upgrade unilaterally.",
        },
      ],
      notes: [
        "Unknown contract with EOA admin.",
        "demo fixture — any address NOT in the known-DeFi table returns this high-risk verdict.",
      ],
    };
  },

  get_protocol_risk_score: (args) => {
    const a = (args ?? {}) as { protocol?: string };
    const protocol = (a.protocol ?? "aave-v3").toLowerCase();
    const known: Record<string, { score: number; tvlUsd: number; ageDays: number }> = {
      "aave-v3": { score: 92, tvlUsd: 11_000_000_000, ageDays: 1095 },
      "compound-v3": { score: 88, tvlUsd: 3_200_000_000, ageDays: 870 },
      lido: { score: 90, tvlUsd: 28_000_000_000, ageDays: 1450 },
      "uniswap-v3": { score: 95, tvlUsd: 4_500_000_000, ageDays: 1310 },
      lifi: { score: 80, tvlUsd: 350_000_000, ageDays: 600 },
      "morpho-blue": { score: 84, tvlUsd: 2_100_000_000, ageDays: 540 },
      marginfi: { score: 76, tvlUsd: 420_000_000, ageDays: 730 },
    };
    const k = known[protocol];
    if (k) {
      return {
        protocol: a.protocol,
        score: k.score,
        breakdown: {
          tvl: 18,
          trend30d: 16,
          contractAge: 20,
          audit: 22,
          bugBounty: 16,
        },
        raw: {
          tvlUsd: k.tvlUsd,
          tvlTrend30d: 0.04,
          contractAgeDays: k.ageDays,
          hasBugBounty: true,
        },
      };
    }
    return {
      protocol: a.protocol,
      score: 35,
      breakdown: {
        tvl: 5,
        trend30d: 5,
        contractAge: 5,
        audit: 10,
        bugBounty: 10,
      },
      raw: { hasBugBounty: false },
      notes: [
        "Unknown protocol — low confidence demo fallback.",
        "demo fixture — any protocol NOT in the known-DeFi table scores 35 by default.",
      ],
    };
  },

  // -------- v2: ENS resolution ------------------------------------------------
  resolve_ens_name: (args) => {
    const a = (args ?? {}) as { name?: string };
    const name = (a.name ?? "").toLowerCase();
    if (name === "demo.eth" || name === "vaultpilot.eth") {
      return { name: a.name, address: DEMO_WALLET.evm };
    }
    return {
      name: a.name,
      address: null,
      note: "demo fixture — only resolves `demo.eth` and `vaultpilot.eth`",
    };
  },

  reverse_resolve_ens: (args) => {
    const a = (args ?? {}) as { address?: string };
    if (a.address && a.address.toLowerCase() === DEMO_WALLET.evm.toLowerCase()) {
      return { address: a.address, name: "demo.eth" };
    }
    return { address: a.address, name: null };
  },

  // -------- v2: portfolio diff ------------------------------------------------
  get_portfolio_diff: () => ({
    wallet: DEMO_WALLET.evm,
    startIso: "2026-04-19T00:00:00Z",
    endIso: "2026-04-26T00:00:00Z",
    byChain: {
      ethereum: {
        diffs: {
          ETH: {
            delta: "0",
            deltaUsd: 0,
            price: ["2289.00", "2316.09"],
          },
          stETH: {
            delta: "+0.0030",
            deltaUsd: 6.95,
            price: ["2289.00", "2316.09"],
          },
        },
        totals: {
          netUsd: 12,
          balUsdStart: 12_753,
          balUsdEnd: 12_765,
        },
      },
      arbitrum: {
        diffs: {},
        totals: { netUsd: 0, balUsdStart: 1_732, balUsdEnd: 1_732 },
      },
    },
    notes: [
      "~$12 net change driven by stETH yield + ETH price drift; cross-references the v1 Lido stETH position.",
    ],
  }),

  // -------- v2: TRON witnesses ------------------------------------------------
  list_tron_witnesses: () => ({
    witnesses: Array.from({ length: 27 }, (_, i) => ({
      address: `TVoteDemoSR${(i + 1).toString().padStart(2, "0")}xxxxxxxxxxxxxxxxxxxx`,
      rank: i + 1,
      totalVotes: ((420_000_000 - i * 5_000_000)).toString(),
      isActive: true,
      estVoterApr: Number((0.058 - i * 0.0003).toFixed(4)),
    })),
    userVotes: {},
    totalTronPower: 0,
    totalVotesCast: 0,
    availableVotes: 0,
    note: "demo fixture — user has no votes cast (matches get_tron_staking which has votes: [])",
  }),

  // -------- v3: Litecoin reads (mirror BTC fixture shapes) ---------------------
  get_ltc_balance: () => ({
    address: DEMO_WALLET.litecoin,
    confirmedSats: "5000000000",
    unconfirmedSats: "0",
    confirmedLtc: "50.0",
    unconfirmedLtc: "0",
  }),
  get_ltc_block_tip: () => ({
    height: 2_842_500,
    hash: "demoltcblock0000000000000000000000000000000000000000000000000001",
    timestamp: 1_745_625_600,
    ageSeconds: 90,
  }),
  get_ltc_chain_tips: () => ({
    tips: [
      {
        height: 2_842_500,
        hash: "demoltcblock0000000000000000000000000000000000000000000000000001",
        branchlen: 0,
        status: "active",
      },
    ],
  }),
  get_ltc_mempool_summary: () => ({
    size: 142,
    bytes: 38_400,
    usage: 105_600,
    totalFee: "0.00012345",
    minFee: "0.00001",
  }),
  get_ltc_block_stats: () => ({
    height: 2_842_500,
    avgFee: 1_500,
    avgFeeRate: 5,
    feeRatePercentiles: [1, 2, 5, 10, 20],
    txs: 142,
    totalFee: 213_000,
    subsidy: 625_000_000,
  }),
  get_ltc_blocks_recent: (args) => {
    const a = (args ?? {}) as { count?: number };
    const count = Math.min(a.count ?? 144, 200);
    return Array.from({ length: count }, (_, i) => ({
      height: 2_842_500 - i,
      hash: `demoltcblock${i.toString().padStart(4, "0")}000000000000000000000000000000000000000000000000000`,
      timestamp: 1_745_625_600 - i * 150,
      txCount: 100 + (i % 80),
    }));
  },
  rescan_ltc_account: (args) => {
    const a = (args ?? {}) as { accountIndex?: number };
    return {
      accountIndex: a.accountIndex ?? 0,
      addressesScanned: 21,
      addressesWithHistory: 4,
      needsExtend: false,
      unverifiedChains: [],
      note: "demo fixture — cached txCount refreshed from indexer (no real RPC).",
    };
  },

  // -------- v3: Curve LP positions (Ethereum stable_ng plain pools) -----------
  get_curve_positions: () => ({
    positions: [
      {
        chain: "ethereum",
        pool: "0xDemoCurveStableNgPlainPoolUsdcUsdt00000",
        poolName: "USDC/USDT (stable_ng)",
        coins: ["USDC", "USDT"],
        lpBalance: "1500.000000000000000000",
        lpBalanceUsd: 1_502.34,
        gaugeBalance: "0",
        gaugeBalanceUsd: 0,
        claimableCrv: "12.45",
        claimableCrvUsd: 8.71,
      },
    ],
    notes: [
      "demo fixture — v0.1 scope is Ethereum stable_ng plain pools only; legacy pools and other chains land in follow-up PRs.",
    ],
  }),

  // -------- v3: Safe (Gnosis Safe) multisig positions -------------------------
  get_safe_positions: () => ({
    safes: [
      {
        chain: "ethereum",
        safeAddress: "0xDemoSafe0000000000000000000000000000Safe",
        threshold: 2,
        owners: [
          DEMO_WALLET.evm,
          "0xDemoCoSigner1111111111111111111111111111",
          "0xDemoCoSigner2222222222222222222222222222",
        ],
        version: "1.4.1",
        nativeBalance: "1.25",
        nativeBalanceUsd: 2_895.11,
        pendingTxCount: 1,
        recentExecutedCount: 4,
        modules: [],
        guard: null,
        risks: [],
      },
    ],
    notes: [
      "demo fixture — wallet is owner on one 2-of-3 Safe with $2.9k ETH balance and 1 pending tx awaiting a co-signer.",
    ],
  }),

  // -------- v3: NFT reads (Reservoir-backed) ----------------------------------
  get_nft_portfolio: () => ({
    wallet: DEMO_WALLET.evm,
    chains: ["ethereum"],
    collections: [
      {
        chain: "ethereum",
        contract: "0xDemoNftPudgyPenguins000000000000000000Pp",
        name: "Pudgy Penguins (demo)",
        tokenCount: 2,
        floorEth: "9.5",
        floorUsd: 22_002.86,
        totalFloorEth: "19.0",
        totalFloorUsd: 44_005.71,
      },
      {
        chain: "ethereum",
        contract: "0xDemoNftAzuki00000000000000000000000Azuki",
        name: "Azuki (demo)",
        tokenCount: 1,
        floorEth: "4.2",
        floorUsd: 9_727.58,
        totalFloorEth: "4.2",
        totalFloorUsd: 9_727.58,
      },
    ],
    totalFloorEth: "23.2",
    totalFloorUsd: 53_733.29,
    coverage: [{ chain: "ethereum", errored: false }],
    notes: [
      "Floor != liquidation. `totalFloorUsd` is an upper bound — what the wallet would net selling everything immediately is typically lower after marketplace fees + slippage.",
    ],
  }),
  get_nft_collection: (args) => {
    const a = (args ?? {}) as { contract?: string; chain?: string };
    return {
      chain: a.chain ?? "ethereum",
      contract: a.contract ?? "0xDemoNftPudgyPenguins000000000000000000Pp",
      name: "Pudgy Penguins (demo)",
      symbol: "PPG",
      image: "https://demo.vaultpilot.example/pudgy.png",
      description: "Deterministic demo collection metadata — not a real Reservoir lookup.",
      floorAskEth: "9.5",
      floorAskUsd: 22_002.86,
      topBidEth: "9.1",
      topBidUsd: 21_076.42,
      volume: { "1day": "82.4", "7day": "612.5", "30day": "2410.7", allTime: "412900" },
      ownerCount: 4_812,
      totalSupply: 8_888,
      royaltyBps: 500,
      royaltyRecipient: "0xDemoRoyaltyRecipient000000000000000000Royalty",
    };
  },
  get_nft_history: () => ({
    wallet: DEMO_WALLET.evm,
    activity: [
      {
        type: "sale",
        chain: "ethereum",
        contract: "0xDemoNftAzuki00000000000000000000000Azuki",
        tokenId: "4242",
        priceEth: "4.2",
        priceUsd: 9_727.58,
        timestamp: 1_745_022_400,
        txHash: "0xdemo1nftsale1111111111111111111111111111111111111111111111111111",
      },
      {
        type: "mint",
        chain: "ethereum",
        contract: "0xDemoNftPudgyPenguins000000000000000000Pp",
        tokenId: "1234",
        priceEth: "0.08",
        priceUsd: 185.29,
        timestamp: 1_744_500_000,
        txHash: "0xdemo2nftmint2222222222222222222222222222222222222222222222222222",
      },
    ],
    coverage: [{ chain: "ethereum", errored: false }],
  }),

  // -------- v3: Daily briefing + P&L summary (composed read tools) ------------
  get_daily_briefing: (args) => {
    const a = (args ?? {}) as { period?: "24h" | "7d" | "30d"; format?: "structured" | "markdown" | "both" };
    const period = a.period ?? "24h";
    const format = a.format ?? "both";
    const structured = {
      period,
      portfolioTotal: { usd: 14_062.85, deltaUsd: 142.07, deltaPct: 0.0102 },
      topMovers: [
        { chain: "ethereum", asset: "ETH", deltaUsd: 92.3, deltaPct: 0.016 },
        { chain: "solana", asset: "SOL", deltaUsd: 41.2, deltaPct: 0.022 },
        { chain: "ethereum", asset: "stETH", deltaUsd: 8.57, deltaPct: 0.005 },
      ],
      healthAlerts: [],
      activity: { received: 0, sent: 1, swapped: 1, supplied: 0, borrowed: 0, repaid: 0, withdrew: 0, other: 0 },
      bestStablecoinYield: { available: false, reason: "demo fixture — section coverage parity with v1." },
      liquidationCalendar: { available: false, reason: "demo fixture — section coverage parity with v1." },
    };
    const markdown =
      `**Demo portfolio briefing (${period})**\n\n` +
      `Total: $14,062.85 (+$142.07, +1.02% over the window). ETH up $92, SOL up $41, stETH yield +$8.57. ` +
      `No Aave health-factor alerts; demo wallet HF = 4.85, well above threshold. ` +
      `Activity: 1 swap, 1 send.`;
    if (format === "structured") return structured;
    if (format === "markdown") return { markdown };
    return { ...structured, markdown };
  },
  get_pnl_summary: (args) => {
    const a = (args ?? {}) as { period?: "24h" | "7d" | "30d" | "ytd" | "inception" };
    const period = a.period ?? "30d";
    return {
      period,
      pnlUsd: 412.55,
      pnlPct: 0.0301,
      perChain: {
        ethereum: { pnlUsd: 268.4, walletValueChange: 350.0, netFlowUsd: 81.6 },
        solana: { pnlUsd: 102.15, walletValueChange: 102.15, netFlowUsd: 0 },
        arbitrum: { pnlUsd: 42.0, walletValueChange: 42.0, netFlowUsd: 0 },
        tron: { pnlUsd: 0, walletValueChange: 0, netFlowUsd: 0 },
      },
      perAsset: [
        { chain: "ethereum", asset: "ETH", pnlUsd: 215.5 },
        { chain: "solana", asset: "SOL", pnlUsd: 102.15 },
        { chain: "ethereum", asset: "stETH", pnlUsd: 52.9 },
      ],
      caveats: [
        "demo fixture — wallet token balances only; gas costs not subtracted.",
        "Bitcoin intentionally excluded from v1 P&L (lacks in-window flow accounting).",
      ],
    };
  },

  // -------- v3: Yield comparison + token allowances + non-EVM coin price ------
  compare_yields: (args) => {
    const a = (args ?? {}) as { asset?: string };
    const asset = (a.asset ?? "USDC").toUpperCase();
    return {
      asset,
      rows: [
        { protocol: "compound-v3", chain: "ethereum", market: "cUSDCv3", supplyApr: 0.0541, supplyApy: 0.0556, tvl: 850_000_000, riskScore: 88, notes: [] },
        { protocol: "aave-v3", chain: "arbitrum", market: asset, supplyApr: 0.0492, supplyApy: 0.0504, tvl: 412_000_000, riskScore: 85, notes: [] },
        { protocol: "aave-v3", chain: "ethereum", market: asset, supplyApr: 0.0481, supplyApy: 0.0492, tvl: 1_280_000_000, riskScore: 90, notes: [] },
        { protocol: "compound-v3", chain: "base", market: "cUSDCv3", supplyApr: 0.0455, supplyApy: 0.0465, tvl: 220_000_000, riskScore: 86, notes: [] },
      ],
      unavailable: [
        { protocol: "morpho-blue", reason: "demo fixture — wallet-less market reader not yet split out." },
        { protocol: "marginfi", reason: "demo fixture — wallet-less market reader not yet split out." },
      ],
    };
  },
  get_token_allowances: (args) => {
    const a = (args ?? {}) as { token?: string; chain?: string };
    return {
      wallet: DEMO_WALLET.evm,
      chain: a.chain ?? "ethereum",
      token: a.token ?? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenSymbol: "USDC",
      rows: [
        {
          spender: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
          spenderLabel: "Aave V3 Pool",
          currentAllowance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
          currentAllowanceFormatted: "unlimited",
          isUnlimited: true,
          lastApprovedBlock: 21_500_000,
          lastApprovedTxHash: "0xdemoAllowance00000000000000000000000000000000000000000000000000aave",
          lastApprovedAt: 1_744_400_000,
        },
        {
          spender: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
          spenderLabel: "Uniswap V3 SwapRouter02",
          currentAllowance: "1000000000",
          currentAllowanceFormatted: "1000.0",
          isUnlimited: false,
          lastApprovedBlock: 21_530_000,
          lastApprovedTxHash: "0xdemoAllowance0000000000000000000000000000000000000000000000000uniswap",
          lastApprovedAt: 1_745_000_000,
        },
      ],
      unlimitedCount: 1,
      notes: [
        "demo fixture — 1 unlimited approval (Aave V3 Pool) can move the entire balance including future top-ups; revoke via approve(spender, 0) if unused.",
      ],
    };
  },
  get_coin_price: (args) => {
    const a = (args ?? {}) as { symbol?: string; coingeckoId?: string };
    const symbol = (a.symbol ?? a.coingeckoId ?? "BTC").toUpperCase();
    const priceTable: Record<string, number> = {
      BTC: 95_142.18,
      LTC: 92.45,
      SOL: 184.21,
      TRX: 0.241,
      DOGE: 0.165,
      XMR: 198.40,
      ETH: 2_316.09,
    };
    const priceUsd = priceTable[symbol] ?? 1;
    return {
      symbol,
      priceUsd,
      source: "demo-fixture",
      resolvedKey: a.coingeckoId ?? `coingecko:${symbol.toLowerCase()}`,
      asOf: "2026-04-26T00:00:00Z",
      confidence: 0.99,
    };
  },

  // -------- v3: explain_tx narrative analysis ---------------------------------
  explain_tx: (args) => {
    const a = (args ?? {}) as { txHash?: string; chain?: string; format?: "structured" | "markdown" | "both" };
    const txHash = a.txHash ?? "0xdemo1deadbeef000000000000000000000000000000000000000000000000demo";
    const format = a.format ?? "both";
    const structured = {
      txHash,
      chain: a.chain ?? "ethereum",
      status: "success",
      method: "swapExactTokensForTokens",
      decodedEvents: [
        { kind: "Transfer", token: "USDC", from: DEMO_WALLET.evm, to: "0xDemoUniswapPool0000000000000000000000Pool", amount: "1000.0" },
        { kind: "Transfer", token: "WETH", from: "0xDemoUniswapPool0000000000000000000000Pool", to: DEMO_WALLET.evm, amount: "0.4318" },
      ],
      walletBalanceChanges: [
        { token: "USDC", deltaFormatted: "-1000.0", deltaUsd: -1_000.0 },
        { token: "WETH", deltaFormatted: "+0.4318", deltaUsd: 1_000.09 },
      ],
      feePaidUsd: 1.42,
      heuristics: [],
    };
    const markdown =
      `**Demo tx walkthrough** — \`${txHash.slice(0, 10)}…\`\n\n` +
      `Method: \`swapExactTokensForTokens\` (Uniswap-style swap). Wallet sent 1,000 USDC and received 0.4318 WETH (~$1,000.09 net) for $1.42 in gas. No flagged heuristics — nothing surprising.`;
    if (format === "structured") return structured;
    if (format === "markdown") return { markdown };
    return { ...structured, markdown };
  },
};

/**
 * Stable-mint heuristic for `get_swap_quote`'s SushiSwap-routing branch.
 * Recognizes the most common stables across chains (USDC native +
 * bridged, USDT, DAI, USDS, FRAX) by lowercased address; anything else
 * falls through to the generic LiFi / 1inch branch.
 */
function isStableMint(addr: string | undefined): boolean {
  if (!addr || typeof addr !== "string") return false;
  return STABLE_MINTS.has(addr.toLowerCase());
}

const STABLE_MINTS = new Set([
  // USDC variants
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // mainnet USDC
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // arb USDC
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // base USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // polygon USDC
  // USDT variants
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // mainnet USDT
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // arb USDT
  // DAI / USDS / FRAX
  "0x6b175474e89094c44da98b954eedeac495271d0f", // mainnet DAI
  "0xdc035d45d973e3ec169d2276ddab16f1e407384f", // mainnet USDS
  "0x853d955acef822db058eb8505911ed77f175b99e", // mainnet FRAX
]);

// ============================================================================
// Demo-data tables
// ============================================================================

const DEMO_TOKEN_BALANCES: Record<string, unknown> = {
  "ethereum:native": {
    token: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    amount: "2500000000000000000",
    formatted: "2.5",
    priceUsd: 2316.09,
    valueUsd: 5790.23,
  },
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
    amount: "0",
    formatted: "0",
    priceUsd: 1,
    valueUsd: 0,
  },
  "arbitrum:native": {
    token: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    amount: "100000000000000000",
    formatted: "0.1",
    priceUsd: 2316.09,
    valueUsd: 231.61,
  },
  "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831": {
    token: "0xaf88d065e77C8CC2239327C5EDb3A432268e5831",
    symbol: "USDC",
    decimals: 6,
    amount: "1500000000",
    formatted: "1500",
    priceUsd: 1,
    valueUsd: 1500,
  },
};

const DEMO_AAVE_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [
    {
      chain: "ethereum",
      collateralUsd: 4_000,
      debtUsd: 800,
      healthFactor: 4.85,
      ltv: 0.20,
      liquidationThreshold: 0.83,
      collateral: [{ symbol: "WETH", amount: "1.726", valueUsd: 4_000 }],
      debt: [{ symbol: "USDC", amount: "800", valueUsd: 800 }],
    },
  ],
  totals: { collateralUsd: 4_000, debtUsd: 800, netUsd: 3_200 },
};

const DEMO_COMPOUND_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [],
  totals: { collateralUsd: 0, debtUsd: 0, netUsd: 0 },
};

const DEMO_MORPHO_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [],
  totals: { collateralUsd: 0, debtUsd: 0, netUsd: 0 },
};

const DEMO_UNIV3_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [
    {
      chain: "ethereum",
      tokenId: "847291",
      pair: "WETH/USDC",
      feeTier: 0.0005,
      inRange: true,
      token0: { symbol: "WETH", amount: "0.215", valueUsd: 498 },
      token1: { symbol: "USDC", amount: "498", valueUsd: 498 },
      uncollectedFees: { token0: "0.0012", token1: "2.71", valueUsd: 5.49 },
      approxImpermanentLossUsd: -3.2,
      totalValueUsd: 996,
    },
  ],
  totals: { positionValueUsd: 996, uncollectedFeesUsd: 5.49 },
};

const DEMO_LIDO_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [
    {
      protocol: "lido",
      chain: "ethereum",
      stakedAsset: "stETH",
      amount: "1.2",
      valueUsd: 2_779.31,
      currentApr: 0.0312,
    },
  ],
  totals: { stakedUsd: 2_779.31, weightedApr: 0.0312 },
};

const DEMO_SOLANA_STAKING = {
  wallet: DEMO_WALLET.solana,
  marinade: { positions: [], totalMSolBalance: "0" },
  jito: { positions: [], totalJitoSolBalance: "0" },
  native: [],
  summary: { totalStakedSol: "0", positionCount: 0 },
};

const DEMO_MARGINFI_POSITIONS = {
  wallet: DEMO_WALLET.solana,
  positions: [
    {
      bankAddress: "2s37akKDBoxKcvHm9DwWXGCHA6V3uPGrBiJP6gQAaEpD",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      depositedAmount: "800",
      depositedValueUsd: 800,
      borrowedAmount: "0",
      borrowedValueUsd: 0,
      currentApy: 0.062,
    },
  ],
  totals: { suppliedUsd: 800, borrowedUsd: 0, netUsd: 800 },
};

const DEMO_KAMINO_POSITIONS = {
  wallet: DEMO_WALLET.solana,
  positions: [],
  totals: { suppliedUsd: 0, borrowedUsd: 0, netUsd: 0 },
};

const DEMO_TRON_STAKING = {
  address: DEMO_WALLET.tron,
  trxBalance: "5000",
  frozenForEnergy: { amount: "1000", expiresIn: "in 14 days" },
  frozenForBandwidth: { amount: "0", expiresIn: null },
  votes: [],
  unclaimedRewards: { amount: "12.34", lastClaimedAt: "2026-04-19T10:00:00Z" },
  resources: { energy: { used: 0, total: 152_000 }, bandwidth: { used: 145, total: 1_200 } },
};

const DEMO_BTC_SINGLE_BALANCE = {
  address: DEMO_WALLET.bitcoin,
  confirmedSats: "7500000",
  mempoolSats: "0",
  totalSats: "7500000",
  txCount: 1,
};

const DEMO_BTC_ACCOUNT_BALANCE = {
  accountIndex: 0,
  addressesQueried: 1,
  addressesCached: 1,
  totalConfirmedSats: "7500000",
  totalConfirmedBtc: "0.075",
  totalMempoolSats: "0",
  totalSats: "7500000",
  breakdown: [
    {
      address: DEMO_WALLET.bitcoin,
      addressType: "segwit",
      chain: 0,
      addressIndex: 0,
      confirmedSats: "7500000",
      mempoolSats: "0",
      totalSats: "7500000",
    },
  ],
};

const DEMO_PORTFOLIO_SUMMARY = {
  wallet: DEMO_WALLET.evm,
  totalValueUsd: 14_098,
  byChain: {
    ethereum: {
      nativeValueUsd: 5_790,
      tokenValueUsd: 0,
      defi: { lending: 3_200, staking: 2_779, lpUsd: 996 },
      total: 12_765,
    },
    arbitrum: { nativeValueUsd: 232, tokenValueUsd: 1_500, total: 1_732 },
  },
  nonEvm: {
    bitcoin: [{ address: DEMO_WALLET.bitcoin, totalSats: "7500000", valueUsd: 7_125 }],
    solana: [
      {
        address: DEMO_WALLET.solana,
        nativeSol: "12",
        usdc: "800",
        marginfi: { suppliedUsd: 800 },
        valueUsd: 3_572,
      },
    ],
    tron: [
      {
        address: DEMO_WALLET.tron,
        trx: "5000",
        usdt: "2000",
        valueUsd: 2_675,
      },
    ],
  },
  generatedAt: "2026-04-26T00:00:00Z",
};

const DEMO_TX_HISTORY = {
  wallet: DEMO_WALLET.evm,
  txs: [
    {
      hash: "0xdemo1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chain: "ethereum",
      timestamp: "2026-04-22T11:42:11Z",
      type: "swap",
      summary: "Swapped 500 USDC → 0.215 WETH on Uniswap V3 (LP top-up)",
      valueUsd: 500,
      gasUsd: 1.21,
    },
    {
      hash: "0xdemo2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chain: "ethereum",
      timestamp: "2026-04-15T08:17:03Z",
      type: "supply",
      summary: "Supplied 1.726 WETH to Aave V3",
      valueUsd: 4_000,
      gasUsd: 2.04,
    },
    {
      hash: "0xdemo3ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      chain: "ethereum",
      timestamp: "2026-04-10T20:50:00Z",
      type: "stake",
      summary: "Staked 1.2 ETH → 1.2 stETH via Lido",
      valueUsd: 2_779,
      gasUsd: 1.62,
    },
    {
      hash: "0xdemo4dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      chain: "arbitrum",
      timestamp: "2026-04-02T15:33:21Z",
      type: "bridge",
      summary: "Bridged 1500 USDC from Ethereum → Arbitrum (LiFi)",
      valueUsd: 1_500,
      gasUsd: 0.42,
    },
  ],
  hasMore: false,
};
