import { describe, it, expect } from "vitest";
import { annotateSuspectedPoisoning } from "../src/modules/history/poisoning.js";
import type { HistoryItem } from "../src/modules/history/schemas.js";

const WALLET = "0xC0F5111111111111111111111111111111114075";
const WALLET_LOWER = WALLET.toLowerCase();

function tokenTransfer(over: Partial<Extract<HistoryItem, { type: "token_transfer" }>>): HistoryItem {
  return {
    type: "token_transfer",
    hash: "0x" + "a".repeat(64),
    timestamp: 1700000000,
    from: "0x1111111111111111111111111111111111111111",
    to: WALLET,
    status: "success",
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    amount: "1000000",
    amountFormatted: "1",
    ...over,
  };
}

function externalTx(over: Partial<Extract<HistoryItem, { type: "external" }>>): HistoryItem {
  return {
    type: "external",
    hash: "0x" + "b".repeat(64),
    timestamp: 1700000000,
    from: "0x2222222222222222222222222222222222222222",
    to: WALLET,
    status: "success",
    valueNative: "0",
    valueNativeFormatted: "0",
    ...over,
  };
}

describe("annotateSuspectedPoisoning", () => {
  it("flags zero-amount token_transfer as zero_amount_transfer", () => {
    const items: HistoryItem[] = [
      tokenTransfer({
        from: "0x9999999999999999999999999999999999999999",
        to: WALLET,
        amount: "0",
        amountFormatted: "0",
      }),
    ];
    annotateSuspectedPoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toEqual({
      reasons: ["zero_amount_transfer"],
    });
  });

  it("flags vanity-suffix lookalike with mimics pointing at the legit counterparty", () => {
    const legit = "0xAAAA00000000000000000000000000000000BBBB";
    const lookalike = "0xAAAA99999999999999999999999999999999BBBB";
    const items: HistoryItem[] = [
      externalTx({
        hash: "0x" + "1".repeat(64),
        from: WALLET,
        to: legit,
        valueNative: "1000000000000000000",
        valueNativeFormatted: "1",
        valueUsd: 2000,
      }),
      externalTx({
        hash: "0x" + "2".repeat(64),
        from: lookalike,
        to: WALLET,
        valueNative: "1",
        valueNativeFormatted: "0.000000000000000001",
      }),
    ];
    annotateSuspectedPoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
    expect(items[1].suspectedPoisoning).toEqual({
      reasons: ["vanity_suffix_lookalike"],
      mimics: legit.toLowerCase(),
    });
  });

  it("flags self-suffix lookalike with mimics pointing at the wallet", () => {
    const lookalike = "0xC0F5999999999999999999999999999999994075";
    const items: HistoryItem[] = [
      externalTx({
        from: lookalike,
        to: WALLET,
        valueNative: "1",
        valueNativeFormatted: "0.000000000000000001",
      }),
    ];
    annotateSuspectedPoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toEqual({
      reasons: ["self_suffix_lookalike"],
      mimics: WALLET_LOWER,
    });
  });

  it("does not flag legit dust without a vanity match", () => {
    const items: HistoryItem[] = [
      externalTx({
        from: "0x3333333333333333333333333333333333333333",
        to: WALLET,
        valueNative: "5",
        valueNativeFormatted: "0.000000000000000005",
      }),
    ];
    annotateSuspectedPoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });

  it("does not flag airdrop spam tokens with non-zero amount", () => {
    const items: HistoryItem[] = [
      tokenTransfer({
        from: "0x4444444444444444444444444444444444444444",
        to: WALLET,
        tokenAddress: "0x5555555555555555555555555555555555555555",
        tokenSymbol: "SCAM",
        amount: "1000000000000",
        amountFormatted: "1000000",
      }),
    ];
    annotateSuspectedPoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });

  it("does not flag a vanity-suffix collision when the tx is not dust", () => {
    const legit = "0xAAAA00000000000000000000000000000000BBBB";
    const lookalike = "0xAAAA99999999999999999999999999999999BBBB";
    const items: HistoryItem[] = [
      externalTx({
        hash: "0x" + "1".repeat(64),
        from: WALLET,
        to: legit,
        valueNative: "500000000000000000",
        valueNativeFormatted: "0.5",
        valueUsd: 1000,
      }),
      externalTx({
        hash: "0x" + "2".repeat(64),
        from: lookalike,
        to: WALLET,
        valueNative: "100000000000000000",
        valueNativeFormatted: "0.1",
        valueUsd: 200,
      }),
    ];
    annotateSuspectedPoisoning(items, WALLET);
    expect(items[0].suspectedPoisoning).toBeUndefined();
    expect(items[1].suspectedPoisoning).toBeUndefined();
  });

  it("early-returns for non-EVM (Solana/TRON) wallet shapes", () => {
    const solanaWallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const items: HistoryItem[] = [
      tokenTransfer({
        from: "0x1111111111111111111111111111111111111111",
        to: solanaWallet,
        amount: "0",
        amountFormatted: "0",
      }),
    ];
    annotateSuspectedPoisoning(items, solanaWallet);
    expect(items[0].suspectedPoisoning).toBeUndefined();
  });
});
