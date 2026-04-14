import { describe, it, expect } from "vitest";
import { assertTronRawDataMatches } from "../src/modules/tron/verify-raw-data.js";
import {
  encodeTransferRawData,
  encodeTriggerSmartContractRawData,
  encodeVoteWitnessRawData,
  encodeFreezeV2RawData,
  encodeUnfreezeV2RawData,
  encodeOwnerOnlyRawData,
} from "./helpers/tron-raw-data-encode.js";

/**
 * Tamper-detection tests for the TRON rawData verifier. Each case encodes a
 * protobuf that does NOT match the expectation and asserts the verifier
 * throws — this is the defence against a MITM'd/malicious TronGrid swapping
 * destination/amount/contract between the JSON preview and the signed hex.
 */

const A = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const B = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";
const C = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe("assertTronRawDataMatches — happy path", () => {
  it("accepts a matching TransferContract", () => {
    const hex = encodeTransferRawData({ from: A, to: B, amountSun: 1_500_000n });
    expect(() =>
      assertTronRawDataMatches(hex, {
        kind: "native_send",
        from: A,
        to: B,
        amountSun: 1_500_000n,
      })
    ).not.toThrow();
  });

  it("accepts a matching TriggerSmartContract (TRC-20 transfer)", () => {
    // transfer(recipient, amount) calldata: selector a9059cbb + param
    const param = "0".repeat(24) +
      // recipient 20-byte form (strip 0x41 prefix). For this test just reuse
      // a fixed hex; verifier only compares full data byte-for-byte.
      "ffffffffffffffffffffffffffffffffffffffff" +
      (1_000_000n).toString(16).padStart(64, "0");
    const hex = encodeTriggerSmartContractRawData({
      from: A,
      contract: USDT,
      dataHex: "a9059cbb" + param,
      feeLimitSun: 100_000_000n,
    });
    expect(() =>
      assertTronRawDataMatches(hex, {
        kind: "trc20_send",
        from: A,
        contract: USDT,
        parameterHex: param,
        feeLimitSun: 100_000_000n,
      })
    ).not.toThrow();
  });

  it("accepts a matching VoteWitnessContract", () => {
    const votes = [
      { address: B, count: 10 },
      { address: C, count: 5 },
    ];
    const hex = encodeVoteWitnessRawData({ from: A, votes });
    expect(() =>
      assertTronRawDataMatches(hex, { kind: "vote", from: A, votes })
    ).not.toThrow();
  });

  it("accepts matching Freeze/Unfreeze V2", () => {
    const freezeHex = encodeFreezeV2RawData({
      from: A,
      frozenBalanceSun: 100_000_000n,
      resource: "energy",
    });
    expect(() =>
      assertTronRawDataMatches(freezeHex, {
        kind: "freeze",
        from: A,
        frozenBalanceSun: 100_000_000n,
        resource: "energy",
      })
    ).not.toThrow();

    const unfreezeHex = encodeUnfreezeV2RawData({
      from: A,
      unfreezeBalanceSun: 50_000_000n,
      resource: "bandwidth",
    });
    expect(() =>
      assertTronRawDataMatches(unfreezeHex, {
        kind: "unfreeze",
        from: A,
        unfreezeBalanceSun: 50_000_000n,
        resource: "bandwidth",
      })
    ).not.toThrow();
  });

  it("accepts matching WithdrawExpireUnfreeze / WithdrawBalance", () => {
    expect(() =>
      assertTronRawDataMatches(
        encodeOwnerOnlyRawData({ kind: "withdraw_expire_unfreeze", from: A }),
        { kind: "withdraw_expire_unfreeze", from: A }
      )
    ).not.toThrow();
    expect(() =>
      assertTronRawDataMatches(
        encodeOwnerOnlyRawData({ kind: "claim_rewards", from: A }),
        { kind: "claim_rewards", from: A }
      )
    ).not.toThrow();
  });
});

describe("assertTronRawDataMatches — tamper detection", () => {
  it("rejects a swapped to_address (canonical MITM pattern)", () => {
    const tampered = encodeTransferRawData({ from: A, to: C, amountSun: 1_500_000n });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "native_send",
        from: A,
        to: B,
        amountSun: 1_500_000n,
      })
    ).toThrow(/to_address mismatch/);
  });

  it("rejects a swapped amount", () => {
    const tampered = encodeTransferRawData({ from: A, to: B, amountSun: 9_000_000n });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "native_send",
        from: A,
        to: B,
        amountSun: 1_500_000n,
      })
    ).toThrow(/amount mismatch/);
  });

  it("rejects a swapped owner_address", () => {
    const tampered = encodeTransferRawData({ from: C, to: B, amountSun: 1_500_000n });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "native_send",
        from: A,
        to: B,
        amountSun: 1_500_000n,
      })
    ).toThrow(/owner_address mismatch/);
  });

  it("rejects a contract-type swap (TriggerSmartContract where TransferContract expected)", () => {
    const tampered = encodeTriggerSmartContractRawData({
      from: A,
      contract: USDT,
      dataHex: "a9059cbb" + "0".repeat(128),
    });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "native_send",
        from: A,
        to: B,
        amountSun: 1_500_000n,
      })
    ).toThrow(/contract type mismatch/);
  });

  it("rejects a swapped TRC-20 contract_address", () => {
    const param = "0".repeat(24) + "ff".repeat(20) + (1n).toString(16).padStart(64, "0");
    // TronGrid claims we're transferring to USDT, but the hex encodes a
    // different TRC-20 contract.
    const tampered = encodeTriggerSmartContractRawData({
      from: A,
      contract: B, // NOT USDT
      dataHex: "a9059cbb" + param,
    });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "trc20_send",
        from: A,
        contract: USDT,
        parameterHex: param,
      })
    ).toThrow(/contract_address mismatch/);
  });

  it("rejects a tampered TRC-20 parameter (amount or recipient inside calldata)", () => {
    const goodParam = "0".repeat(24) + "ff".repeat(20) + (1n).toString(16).padStart(64, "0");
    const tamperedParam = "0".repeat(24) + "aa".repeat(20) + (999n).toString(16).padStart(64, "0");
    const tampered = encodeTriggerSmartContractRawData({
      from: A,
      contract: USDT,
      dataHex: "a9059cbb" + tamperedParam,
    });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "trc20_send",
        from: A,
        contract: USDT,
        parameterHex: goodParam,
      })
    ).toThrow(/TriggerSmartContract\.data mismatch/);
  });

  it("rejects a vote-count tamper", () => {
    const tampered = encodeVoteWitnessRawData({
      from: A,
      votes: [{ address: B, count: 999 }],
    });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "vote",
        from: A,
        votes: [{ address: B, count: 10 }],
      })
    ).toThrow(/vote_count mismatch/);
  });

  it("rejects a resource-type swap (bandwidth vs energy)", () => {
    const tampered = encodeFreezeV2RawData({
      from: A,
      frozenBalanceSun: 100_000_000n,
      resource: "bandwidth",
    });
    expect(() =>
      assertTronRawDataMatches(tampered, {
        kind: "freeze",
        from: A,
        frozenBalanceSun: 100_000_000n,
        resource: "energy",
      })
    ).toThrow(/resource mismatch/);
  });

  it("rejects hex that isn't valid hex at all", () => {
    expect(() =>
      assertTronRawDataMatches("zzzz", {
        kind: "withdraw_expire_unfreeze",
        from: A,
      })
    ).toThrow(/valid hex/);
  });

  it("rejects a truncated protobuf", () => {
    const good = encodeTransferRawData({ from: A, to: B, amountSun: 1_500_000n });
    const truncated = good.slice(0, good.length - 20);
    expect(() =>
      assertTronRawDataMatches(truncated, {
        kind: "native_send",
        from: A,
        to: B,
        amountSun: 1_500_000n,
      })
    ).toThrow();
  });
});
