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
};

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
};

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
