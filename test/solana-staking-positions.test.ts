import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, StakeProgram } from "@solana/web3.js";

/**
 * Position-reader tests for `src/modules/positions/solana-staking.ts`.
 *
 * Strategy mirrors `test/solana-marginfi.test.ts`: mock the RPC at the
 * `Connection` boundary — no live network, no Marinade/stake-pool SDK
 * network calls. Each test asserts the return shape given well-defined
 * RPC responses.
 *
 * Three readers × multiple branches each:
 *   - Marinade: reads SPL balance + MarinadeState.mSolPrice
 *   - Jito: reads SPL balance + StakePool totalLamports/poolTokenSupply
 *   - Native stakes: enumerate via getParsedProgramAccounts; classify
 *     status from activation/deactivation epochs + current epoch
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();

const connectionStub = {
  getParsedTokenAccountsByOwner: vi.fn(),
  getAccountInfo: vi.fn(),
  getParsedProgramAccounts: vi.fn(),
  getEpochInfo: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// Mock the Marinade SDK's Marinade + MarinadeConfig constructors so we
// don't instantiate the full Anchor provider for a read. The reader calls
// `new Marinade(...)` → `.getMarinadeState()` → `.mSolPrice`; stub that chain.
const marinadeStateStub = { mSolPrice: 0 };
const getMarinadeStateMock = vi.fn(async () => marinadeStateStub);

vi.mock("@marinade.finance/marinade-ts-sdk", () => {
  class MarinadeConfig {}
  class Marinade {
    async getMarinadeState() {
      return getMarinadeStateMock();
    }
  }
  return { MarinadeConfig, Marinade };
});

// Mock the spl-stake-pool's getStakePoolAccount — that's the only function
// the reader calls from the library.
const getStakePoolAccountMock = vi.fn();

vi.mock("@solana/spl-stake-pool", () => ({
  getStakePoolAccount: getStakePoolAccountMock,
}));

beforeEach(() => {
  connectionStub.getParsedTokenAccountsByOwner.mockReset();
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getParsedProgramAccounts.mockReset();
  connectionStub.getEpochInfo.mockReset();
  getMarinadeStateMock.mockClear();
  getStakePoolAccountMock.mockReset();
  marinadeStateStub.mSolPrice = 1.1234;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeTokenAccountsResponse(uiAmount: number) {
  // Shape Solana RPC returns from getParsedTokenAccountsByOwner.
  return {
    value: [
      {
        pubkey: new PublicKey("11111111111111111111111111111111"),
        account: {
          lamports: 2_039_280,
          owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          executable: false,
          rentEpoch: 0,
          data: {
            program: "spl-token",
            parsed: {
              info: { tokenAmount: { uiAmount } },
              type: "account",
            },
            space: 165,
          },
        },
      },
    ],
  };
}

describe("getMarinadeStakingPosition", () => {
  it("multiplies mSOL balance by on-chain mSolPrice to produce SOL-equivalent", async () => {
    connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue(
      makeTokenAccountsResponse(100.0),
    );
    marinadeStateStub.mSolPrice = 1.1234;

    const { getMarinadeStakingPosition } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const pos = await getMarinadeStakingPosition(
      connectionStub as never,
      WALLET,
    );
    expect(pos.protocol).toBe("marinade");
    expect(pos.mSolBalance).toBe(100);
    expect(pos.exchangeRate).toBeCloseTo(1.1234);
    expect(pos.solEquivalent).toBeCloseTo(112.34);
  });

  it("reports zero balance + zero SOL equivalent when wallet holds no mSOL", async () => {
    connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue({ value: [] });
    const { getMarinadeStakingPosition } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const pos = await getMarinadeStakingPosition(
      connectionStub as never,
      WALLET,
    );
    expect(pos.mSolBalance).toBe(0);
    expect(pos.solEquivalent).toBe(0);
  });
});

describe("getJitoStakingPosition", () => {
  it("computes SOL-equivalent from stake pool's totalLamports/poolTokenSupply ratio", async () => {
    connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue(
      makeTokenAccountsResponse(50.0),
    );
    getStakePoolAccountMock.mockResolvedValue({
      account: {
        data: {
          // Exchange rate 1.08 SOL / jitoSOL — 108 lamports per 100 pool tokens,
          // scaled up to realistic order of magnitude.
          totalLamports: { toString: () => "108000000000000" },
          poolTokenSupply: { toString: () => "100000000000000" },
        },
      },
    });

    const { getJitoStakingPosition } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const pos = await getJitoStakingPosition(connectionStub as never, WALLET);
    expect(pos.protocol).toBe("jito");
    expect(pos.jitoSolBalance).toBe(50);
    expect(pos.exchangeRate).toBeCloseTo(1.08);
    expect(pos.solEquivalent).toBeCloseTo(54);
  });

  it("falls back to rate=1 when pool token supply is zero (bootstrapping edge)", async () => {
    connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue(
      makeTokenAccountsResponse(0),
    );
    getStakePoolAccountMock.mockResolvedValue({
      account: {
        data: {
          totalLamports: { toString: () => "0" },
          poolTokenSupply: { toString: () => "0" },
        },
      },
    });

    const { getJitoStakingPosition } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const pos = await getJitoStakingPosition(connectionStub as never, WALLET);
    expect(pos.exchangeRate).toBe(1);
    expect(pos.solEquivalent).toBe(0);
  });
});

describe("getNativeStakePositions", () => {
  function makeStakeAccount(params: {
    pubkey: string;
    lamports: number;
    type: "initialized" | "delegated";
    voter?: string;
    activationEpoch?: string;
    deactivationEpoch?: string;
  }) {
    const base = {
      pubkey: new PublicKey(params.pubkey),
      account: {
        lamports: params.lamports,
        owner: StakeProgram.programId,
        executable: false,
        rentEpoch: 0,
        data: {
          program: "stake",
          parsed:
            params.type === "initialized"
              ? { type: "initialized", info: {} }
              : {
                  type: "delegated",
                  info: {
                    stake: {
                      delegation: {
                        voter: params.voter!,
                        activationEpoch: params.activationEpoch!,
                        deactivationEpoch: params.deactivationEpoch!,
                      },
                    },
                  },
                },
          space: 200,
        },
      },
    };
    return base;
  }

  beforeEach(() => {
    connectionStub.getEpochInfo.mockResolvedValue({ epoch: 500 });
  });

  it("classifies stake statuses from activation/deactivation epochs", async () => {
    const VALIDATOR_A = new PublicKey(Keypair.generate().publicKey).toBase58();
    const VALIDATOR_B = new PublicKey(Keypair.generate().publicKey).toBase58();
    const VALIDATOR_C = new PublicKey(Keypair.generate().publicKey).toBase58();

    connectionStub.getParsedProgramAccounts.mockResolvedValue([
      // Activating — activation at future epoch 510, no deactivation.
      makeStakeAccount({
        pubkey: new PublicKey(Keypair.generate().publicKey).toBase58(),
        lamports: 1_000_000_000,
        type: "delegated",
        voter: VALIDATOR_A,
        activationEpoch: "510",
        deactivationEpoch: "18446744073709551615",
      }),
      // Active — activation at past epoch 400, no deactivation.
      makeStakeAccount({
        pubkey: new PublicKey(Keypair.generate().publicKey).toBase58(),
        lamports: 2_000_000_000,
        type: "delegated",
        voter: VALIDATOR_B,
        activationEpoch: "400",
        deactivationEpoch: "18446744073709551615",
      }),
      // Deactivating — deactivation at future epoch 520.
      makeStakeAccount({
        pubkey: new PublicKey(Keypair.generate().publicKey).toBase58(),
        lamports: 3_000_000_000,
        type: "delegated",
        voter: VALIDATOR_C,
        activationEpoch: "400",
        deactivationEpoch: "520",
      }),
      // Inactive — deactivation at past epoch 450.
      makeStakeAccount({
        pubkey: new PublicKey(Keypair.generate().publicKey).toBase58(),
        lamports: 4_000_000_000,
        type: "delegated",
        voter: VALIDATOR_A,
        activationEpoch: "400",
        deactivationEpoch: "450",
      }),
    ]);

    const { getNativeStakePositions } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const positions = await getNativeStakePositions(
      connectionStub as never,
      WALLET,
    );
    expect(positions).toHaveLength(4);
    const statuses = positions.map((p) => p.status);
    expect(statuses).toEqual([
      "activating",
      "active",
      "deactivating",
      "inactive",
    ]);
    expect(positions[0]!.validator).toBe(VALIDATOR_A);
    expect(positions[0]!.stakeSol).toBe(1);
    expect(positions[3]!.deactivationEpoch).toBe(450);
  });

  it("reports 'inactive' for undelegated (initialized-only) stake accounts", async () => {
    connectionStub.getParsedProgramAccounts.mockResolvedValue([
      makeStakeAccount({
        pubkey: new PublicKey(Keypair.generate().publicKey).toBase58(),
        lamports: 500_000_000,
        type: "initialized",
      }),
    ]);

    const { getNativeStakePositions } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const positions = await getNativeStakePositions(
      connectionStub as never,
      WALLET,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0]!.status).toBe("inactive");
    expect(positions[0]!.validator).toBeUndefined();
    expect(positions[0]!.stakeSol).toBe(0.5);
  });

  it("filters on withdrawer authority at offset 44 (via memcmp)", async () => {
    connectionStub.getParsedProgramAccounts.mockResolvedValue([]);
    const { getNativeStakePositions } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    await getNativeStakePositions(connectionStub as never, WALLET);
    const callArgs = connectionStub.getParsedProgramAccounts.mock.calls[0];
    expect(callArgs).toBeDefined();
    const [programId, config] = callArgs as unknown as [
      PublicKey,
      { filters: { memcmp: { offset: number; bytes: string } }[] },
    ];
    expect(programId.equals(StakeProgram.programId)).toBe(true);
    expect(config.filters[0]!.memcmp.offset).toBe(44);
    expect(config.filters[0]!.memcmp.bytes).toBe(WALLET);
  });
});

describe("getSolanaStakingPositions — consolidated reader", () => {
  it("returns all three sections with a totalSolEquivalent subtotal", async () => {
    connectionStub.getParsedTokenAccountsByOwner.mockResolvedValue(
      makeTokenAccountsResponse(10),
    );
    marinadeStateStub.mSolPrice = 1.2;
    getStakePoolAccountMock.mockResolvedValue({
      account: {
        data: {
          totalLamports: { toString: () => "110000000000" },
          poolTokenSupply: { toString: () => "100000000000" },
        },
      },
    });
    connectionStub.getParsedProgramAccounts.mockResolvedValue([]);
    connectionStub.getEpochInfo.mockResolvedValue({ epoch: 500 });

    const { getSolanaStakingPositions } = await import(
      "../src/modules/positions/solana-staking.js"
    );
    const result = await getSolanaStakingPositions(
      connectionStub as never,
      WALLET,
    );
    expect(result.marinade.solEquivalent).toBeCloseTo(12); // 10 mSOL × 1.2
    expect(result.jito.solEquivalent).toBeCloseTo(11); // 10 jitoSOL × 1.1
    expect(result.nativeStakes).toHaveLength(0);
    expect(result.totalSolEquivalent).toBeCloseTo(23);
  });
});
