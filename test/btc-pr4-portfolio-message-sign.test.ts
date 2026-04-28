import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * BTC PR4 — portfolio integration (`bitcoinAddress` / `bitcoinAddresses`
 * args fold BTC into `breakdown.bitcoin` + `bitcoinUsd`) + `sign_message_btc`
 * (BIP-137 compact signature).
 *
 * mempool.space + DefiLlama price are mocked at the indexer +
 * `fetchBitcoinPrice` boundaries. Ledger BTC SDK is mocked through the
 * loader (mirrors `btc-pr3-send.test.ts`).
 * bump
 */

const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SEGWIT_PUBKEY = "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";
const LEGACY_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

const getWalletPublicKeyMock = vi.fn();
const signMessageMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});
const getAppAndVersionMock = vi.fn();

vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signMessage: signMessageMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
}));

const getBalanceMock = vi.fn();

vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({ getBalance: getBalanceMock }),
  resetBitcoinIndexer: () => {},
}));

const fetchBitcoinPriceMock = vi.fn();

vi.mock("../src/modules/btc/price.ts", () => ({
  fetchBitcoinPrice: fetchBitcoinPriceMock,
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-pr4-"));
  setConfigDirForTesting(tmpHome);
  getWalletPublicKeyMock.mockReset();
  signMessageMock.mockReset();
  transportCloseMock.mockClear();
  getAppAndVersionMock.mockReset();
  getBalanceMock.mockReset();
  fetchBitcoinPriceMock.mockReset();
  const { clearPairedBtcAddresses, setPairedBtcAddress } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  clearPairedBtcAddresses();
  setPairedBtcAddress({
    address: SEGWIT_ADDR,
    publicKey: SEGWIT_PUBKEY,
    path: "84'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
  });
  setPairedBtcAddress({
    address: TAPROOT_ADDR,
    publicKey: SEGWIT_PUBKEY,
    path: "86'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "taproot",
    accountIndex: 0,
  });
  setPairedBtcAddress({
    address: LEGACY_ADDR,
    publicKey: SEGWIT_PUBKEY,
    path: "44'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "legacy",
    accountIndex: 0,
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("portfolio BTC integration", () => {
  it("folds BTC balance × price into breakdown.bitcoin + bitcoinUsd", async () => {
    // mockResolvedValue (not Once) — issue #274 moved BTC pricing into
    // getBitcoinBalance (the per-address reader), so a multi-address call
    // hits fetchBitcoinPrice once per address rather than once per slice.
    fetchBitcoinPriceMock.mockResolvedValue(50_000);
    getBalanceMock.mockResolvedValueOnce({
      address: SEGWIT_ADDR,
      confirmedSats: 200_000n, // 0.002 BTC
      mempoolSats: 0n,
      totalSats: 200_000n,
      txCount: 1,
    });

    // Mock the EVM/TRON/Solana fan-out by intercepting at higher-level
    // helpers — the cleanest hook is to mock the underlying balance
    // readers since portfolio/index.ts imports them at module load.
    vi.resetModules();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBalance: async () => 0n,
        multicall: async () => [],
        getEnsAddress: async () => null,
        getEnsName: async () => null,
      }),
      verifyChainId: async () => undefined,
    }));
    vi.doMock("../src/data/prices.ts", () => ({
      getTokenPrice: async () => undefined,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/modules/positions/index.ts", () => ({
      getLendingPositions: async () => ({ wallet: "", positions: [] }),
      getLpPositions: async () => ({ wallet: "", positions: [] }),
    }));
    vi.doMock("../src/modules/staking/index.ts", () => ({
      getStakingPositions: async () => ({ wallet: "", positions: [] }),
    }));
    vi.doMock("../src/modules/compound/index.ts", () => ({
      getCompoundPositions: async () => ({ wallet: "", positions: [] }),
      prefetchCompoundProbes: async () => undefined,
    }));
    vi.doMock("../src/modules/positions/aave.ts", () => ({
      prefetchAaveAccountData: async () => undefined,
    }));
    vi.doMock("../src/modules/staking/lido.ts", () => ({
      prefetchLidoMainnet: async () => undefined,
    }));
    vi.doMock("../src/modules/morpho/index.ts", () => ({
      getMorphoPositions: async () => ({
        wallet: "",
        positions: [],
        discoverySkipped: false,
      }),
    }));

    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.ts"
    );
    const result = await getPortfolioSummary({
      wallet: "0x1111111111111111111111111111111111111111",
      bitcoinAddress: SEGWIT_ADDR,
    });
    if ("perWallet" in result) throw new Error("expected single-wallet summary");
    // 0.002 BTC × $50,000 = $100
    expect(result.bitcoinUsd).toBe(100);
    expect(result.breakdown.bitcoin).toBeDefined();
    expect(result.breakdown.bitcoin?.addresses).toEqual([SEGWIT_ADDR]);
    expect(result.breakdown.bitcoin?.balances[0].confirmedBtc).toBe("0.002");
    expect(result.breakdown.bitcoin?.balances[0].valueUsd).toBe(100);
    expect(result.coverage.bitcoin).toEqual({ covered: true });
    expect(result.walletBalancesUsd).toBe(100);
    // BTC contributes to totalUsd via walletBalancesUsd.
    expect(result.totalUsd).toBe(100);
  });

  it("supports multiple BTC addresses (legacy + segwit + taproot)", async () => {
    // mockResolvedValue (not Once) — issue #274 moved BTC pricing into
    // getBitcoinBalance (the per-address reader), so a multi-address call
    // hits fetchBitcoinPrice once per address rather than once per slice.
    fetchBitcoinPriceMock.mockResolvedValue(50_000);
    getBalanceMock
      .mockResolvedValueOnce({
        address: SEGWIT_ADDR,
        confirmedSats: 100_000n,
        mempoolSats: 0n,
        totalSats: 100_000n,
        txCount: 1,
      })
      .mockResolvedValueOnce({
        address: TAPROOT_ADDR,
        confirmedSats: 50_000n,
        mempoolSats: 0n,
        totalSats: 50_000n,
        txCount: 1,
      });

    vi.resetModules();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBalance: async () => 0n,
        multicall: async () => [],
      }),
      verifyChainId: async () => undefined,
    }));
    vi.doMock("../src/data/prices.ts", () => ({
      getTokenPrice: async () => undefined,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/modules/positions/index.ts", () => ({
      getLendingPositions: async () => ({ wallet: "", positions: [] }),
      getLpPositions: async () => ({ wallet: "", positions: [] }),
    }));
    vi.doMock("../src/modules/staking/index.ts", () => ({
      getStakingPositions: async () => ({ wallet: "", positions: [] }),
    }));
    vi.doMock("../src/modules/compound/index.ts", () => ({
      getCompoundPositions: async () => ({ wallet: "", positions: [] }),
      prefetchCompoundProbes: async () => undefined,
    }));
    vi.doMock("../src/modules/positions/aave.ts", () => ({
      prefetchAaveAccountData: async () => undefined,
    }));
    vi.doMock("../src/modules/staking/lido.ts", () => ({
      prefetchLidoMainnet: async () => undefined,
    }));
    vi.doMock("../src/modules/morpho/index.ts", () => ({
      getMorphoPositions: async () => ({
        wallet: "",
        positions: [],
        discoverySkipped: false,
      }),
    }));

    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.ts"
    );
    const result = await getPortfolioSummary({
      wallet: "0x1111111111111111111111111111111111111111",
      bitcoinAddresses: [SEGWIT_ADDR, TAPROOT_ADDR],
    });
    if ("perWallet" in result) throw new Error("expected single-wallet summary");
    // (100k + 50k) sats × $50,000 / 1e8 = $75.00
    expect(result.bitcoinUsd).toBe(75);
    expect(result.breakdown.bitcoin?.balances.length).toBe(2);
  });

  it("rejects bitcoinAddress + bitcoinAddresses together", async () => {
    vi.resetModules();
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.ts"
    );
    await expect(
      getPortfolioSummary({
        wallet: "0x1111111111111111111111111111111111111111",
        bitcoinAddress: SEGWIT_ADDR,
        bitcoinAddresses: [TAPROOT_ADDR],
      }),
    ).rejects.toThrow(/single.*OR.*array/i);
  });

  it("multi-wallet + bitcoinAddress: BTC surfaces as a sibling slice (issue #201)", async () => {
    fetchBitcoinPriceMock.mockResolvedValue(50_000);
    getBalanceMock.mockResolvedValue({
      address: SEGWIT_ADDR,
      confirmedSats: 200_000n, // 0.002 BTC
      mempoolSats: 0n,
      totalSats: 200_000n,
      txCount: 1,
    });
    vi.resetModules();
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBalance: async () => 0n,
        multicall: async () => [],
      }),
      verifyChainId: async () => undefined,
    }));
    vi.doMock("../src/data/prices.ts", () => ({
      getTokenPrice: async () => undefined,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/modules/positions/index.ts", () => ({
      getLendingPositions: async () => ({ wallet: "", positions: [] }),
      getLpPositions: async () => ({ wallet: "", positions: [] }),
    }));
    vi.doMock("../src/modules/staking/index.ts", () => ({
      getStakingPositions: async () => ({ wallet: "", positions: [] }),
    }));
    vi.doMock("../src/modules/compound/index.ts", () => ({
      getCompoundPositions: async () => ({ wallet: "", positions: [] }),
      prefetchCompoundProbes: async () => undefined,
    }));
    vi.doMock("../src/modules/positions/aave.ts", () => ({
      prefetchAaveAccountData: async () => undefined,
    }));
    vi.doMock("../src/modules/staking/lido.ts", () => ({
      prefetchLidoMainnet: async () => undefined,
    }));
    vi.doMock("../src/modules/morpho/index.ts", () => ({
      getMorphoPositions: async () => ({
        wallet: "",
        positions: [],
        discoverySkipped: false,
      }),
    }));
    const { getPortfolioSummary } = await import(
      "../src/modules/portfolio/index.ts"
    );
    const result = await getPortfolioSummary({
      wallets: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      bitcoinAddress: SEGWIT_ADDR,
    });
    if (!("perWallet" in result)) {
      throw new Error("expected multi-wallet summary");
    }
    // BTC must NOT be folded into either per-wallet entry.
    expect(result.perWallet[0].bitcoinUsd).toBeUndefined();
    expect(result.perWallet[1].bitcoinUsd).toBeUndefined();
    // Instead it lives at the top-level nonEvm block.
    expect(result.nonEvm?.bitcoin).toBeDefined();
    expect(result.nonEvm?.bitcoin?.addresses).toEqual([SEGWIT_ADDR]);
    expect(result.bitcoinUsd).toBe(100); // 0.002 BTC × $50,000
    // And rolls into totalUsd at the top level.
    expect(result.totalUsd).toBe(100);
  });
});

describe("signBitcoinMessage", () => {
  beforeEach(() => {
    getAppAndVersionMock.mockResolvedValue({
      name: "Bitcoin",
      version: "2.4.6",
    });
  });

  it("signs a message with a paired segwit address (BIP-137 header 39..42)", async () => {
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: SEGWIT_ADDR,
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
    signMessageMock.mockResolvedValueOnce({
      v: 1,
      r: "11".repeat(32),
      s: "22".repeat(32),
    });
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    const result = await signBitcoinMessage({
      wallet: SEGWIT_ADDR,
      message: "Sign in to my dapp",
    });
    expect(result.format).toBe("BIP-137");
    expect(result.address).toBe(SEGWIT_ADDR);
    expect(result.addressType).toBe("segwit");
    // Header byte = 39 + 1 = 40 = 0x28; signature length = 1 + 32 + 32 = 65 bytes.
    const sigBytes = Buffer.from(result.signature, "base64");
    expect(sigBytes.length).toBe(65);
    expect(sigBytes[0]).toBe(40);
  });

  it("signs with a legacy address (header 31..34)", async () => {
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: LEGACY_ADDR,
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
    signMessageMock.mockResolvedValueOnce({
      v: 0,
      r: "33".repeat(32),
      s: "44".repeat(32),
    });
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    const result = await signBitcoinMessage({
      wallet: LEGACY_ADDR,
      message: "test",
    });
    expect(result.addressType).toBe("legacy");
    const sigBytes = Buffer.from(result.signature, "base64");
    // Header = 31 + 0 = 31.
    expect(sigBytes[0]).toBe(31);
  });

  it("refuses to sign with a taproot address (BIP-322 not supported)", async () => {
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      signBitcoinMessage({
        wallet: TAPROOT_ADDR,
        message: "test",
      }),
    ).rejects.toThrow(/BIP-322/);
  });

  it("refuses unpaired addresses", async () => {
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      signBitcoinMessage({
        wallet: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
        message: "test",
      }),
    ).rejects.toThrow(/not paired/);
  });

  it("refuses oversized messages", async () => {
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      signBitcoinMessage({
        wallet: SEGWIT_ADDR,
        message: "x".repeat(10_001),
      }),
    ).rejects.toThrow(/exceeds the 10000-char ceiling/);
  });

  it("refuses to sign when the device derives a different address", async () => {
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: LEGACY_ADDR, // different from the requested SEGWIT_ADDR
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      signBitcoinMessage({
        wallet: SEGWIT_ADDR,
        message: "test",
      }),
    ).rejects.toThrow(/derived .* but the request asks/);
  });

  // --- Issue #454: Inv #8 hardening — byte-fingerprint + drainer-string refusal ---

  it("returns lowercase hex SHA-256 of the exact UTF-8 message bytes (issue #454)", async () => {
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: SEGWIT_ADDR,
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
    signMessageMock.mockResolvedValueOnce({
      v: 1,
      r: "11".repeat(32),
      s: "22".repeat(32),
    });
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    const message = "Sign in to my dapp";
    const result = await signBitcoinMessage({
      wallet: SEGWIT_ADDR,
      message,
    });
    const expected = (await import("node:crypto"))
      .createHash("sha256")
      .update(Buffer.from(message, "utf-8"))
      .digest("hex");
    expect(result.messageSha256).toBe(expected);
    expect(result.messageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes UTF-8 bytes (multi-byte chars eat more bytes than chars)", async () => {
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: SEGWIT_ADDR,
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
    signMessageMock.mockResolvedValueOnce({
      v: 1,
      r: "11".repeat(32),
      s: "22".repeat(32),
    });
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    const result = await signBitcoinMessage({
      wallet: SEGWIT_ADDR,
      message: "Verify ownership — café 你好",
    });
    const expected = (await import("node:crypto"))
      .createHash("sha256")
      .update(Buffer.from("Verify ownership — café 你好", "utf-8"))
      .digest("hex");
    expect(result.messageSha256).toBe(expected);
  });

  it("refuses messages containing single-word semantic markers (#454 case-insensitive)", async () => {
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    for (const marker of [
      "transfer",
      "Authorize",
      "GRANT",
      "custody",
      "release",
      "consent",
    ]) {
      await expect(
        signBitcoinMessage({
          wallet: SEGWIT_ADDR,
          message: `Please ${marker} this for me`,
        }),
      ).rejects.toThrow(/MESSAGE-SIGN REFUSED — drainer-pattern marker/);
    }
  });

  it("refuses messages containing multi-word drainer templates (#454)", async () => {
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    await expect(
      signBitcoinMessage({
        wallet: SEGWIT_ADDR,
        message: "I authorize Acme Corp to move my funds",
      }),
    ).rejects.toThrow(/drainer-pattern template "i authorize"/);
    await expect(
      signBitcoinMessage({
        wallet: SEGWIT_ADDR,
        message: "I hereby transfer ownership to Bob",
      }),
    ).rejects.toThrow(/drainer-pattern (?:template "i hereby transfer"|marker "transfer")/);
  });

  it("refusal fires BEFORE pairing lookup (no device interaction needed)", async () => {
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    // Use an unpaired address — if the drainer check ran AFTER pairing,
    // we'd see "not paired" instead of the drainer refusal.
    await expect(
      signBitcoinMessage({
        wallet: "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu",
        message: "I consent to transfer my BTC to Alice",
      }),
    ).rejects.toThrow(/MESSAGE-SIGN REFUSED/);
  });

  it("legitimate Sign-In-with-Bitcoin messages don't trip the drainer guard (#454 false-positive control)", async () => {
    getWalletPublicKeyMock.mockResolvedValueOnce({
      bitcoinAddress: SEGWIT_ADDR,
      publicKey: SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
    signMessageMock.mockResolvedValueOnce({
      v: 1,
      r: "11".repeat(32),
      s: "22".repeat(32),
    });
    const { signBitcoinMessage } = await import(
      "../src/modules/btc/actions.ts"
    );
    // Realistic SIWB-shaped messages: no drainer markers.
    const result = await signBitcoinMessage({
      wallet: SEGWIT_ADDR,
      message:
        "example.com wants you to sign in with your Bitcoin account:\n" +
        SEGWIT_ADDR +
        "\n\nVerify ownership for proof-of-funds.\n\nNonce: 12345",
    });
    expect(result.format).toBe("BIP-137");
  });
});

