import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  selectUtxos,
  detectScriptType,
  dustThreshold,
  VBYTES,
  SEGWIT_OVERHEAD_VBYTES,
  type Utxo,
} from "../src/modules/bitcoin/utxo.js";
import { prepareBitcoinSendInput } from "../src/modules/bitcoin/schemas.js";

describe("Bitcoin UTXO selection: fee-minimizing (greedy largest-first)", () => {
  const base = {
    feeRateSatVb: 10,
    inputVbytes: VBYTES.p2wpkh.input, // 68
    outputVbytesRecipient: VBYTES.p2wpkh.output, // 31
    outputVbytesChange: VBYTES.p2wpkh.output, // 31
    overheadVbytes: SEGWIT_OVERHEAD_VBYTES, // 11
    dustSats: dustThreshold("p2wpkh"), // 294
  };

  function u(value: number, confirmed = true): Utxo {
    return { txid: `mock-${value}`, vout: 0, value, confirmed };
  }

  it("picks the single smallest sufficient UTXO when possible (fewest inputs = smallest fee)", () => {
    const result = selectUtxos({
      ...base,
      // Both UTXOs could fund 50k sats. Largest-first picks the 200k one.
      // That's fine — it's still 1 input. We're minimizing *input count*, not
      // leftover-in-wallet. 1 input beats 2 inputs on fee regardless of size.
      utxos: [u(200_000), u(100_000)],
      targetSats: 50_000n,
    });
    expect(result.chosen).toHaveLength(1);
    expect(result.chosen[0].value).toBe(200_000);
    // vsize = 11 + 68 + 31 + 31 = 141 (with change output)
    expect(result.vbytes).toBe(141);
    // fee = ceil(141 * 10) = 1410 sats
    expect(result.feeSats).toBe(1410n);
    // change = 200_000 − 50_000 − 1410 = 148_590
    expect(result.changeSats).toBe(148_590n);
  });

  it("adds UTXOs in descending order until the target is covered", () => {
    const result = selectUtxos({
      ...base,
      utxos: [u(30_000), u(20_000), u(15_000), u(5_000)],
      // Target + fee > 30k, forces adding a second UTXO
      targetSats: 35_000n,
    });
    expect(result.chosen).toHaveLength(2);
    expect(result.chosen[0].value).toBe(30_000);
    expect(result.chosen[1].value).toBe(20_000);
    expect(result.totalInSats).toBe(50_000n);
    // vsize with 2 inputs + change = 11 + 2*68 + 31 + 31 = 209; fee = 2090
    expect(result.vbytes).toBe(209);
    expect(result.feeSats).toBe(2090n);
    expect(result.changeSats).toBe(50_000n - 35_000n - 2090n);
  });

  it("absorbs dust-sized change into fee (no output below threshold)", () => {
    // Contrive values so that change after fee is well below the 294-sat dust limit.
    // Target 29_500, single UTXO 30_000. With change: vsize=141, fee=1410 → change=−910 (insufficient).
    // Single UTXO 31_000. With change: fee=1410, change=31_000 − 29_500 − 1410 = 90. 90 < 294 → absorb.
    const result = selectUtxos({
      ...base,
      utxos: [u(31_000)],
      targetSats: 29_500n,
    });
    expect(result.chosen).toHaveLength(1);
    expect(result.changeSats).toBe(0n);
    // vsize without change = 11 + 68 + 31 = 110
    expect(result.vbytes).toBe(110);
    // fee absorbs the full 1500 sats leftover
    expect(result.feeSats).toBe(1500n);
    // Effective feerate is higher than target because we over-paid (the tradeoff).
    expect(result.effectiveFeeRateSatVb).toBeGreaterThan(base.feeRateSatVb);
  });

  it("throws when total UTXO value cannot cover target + fee", () => {
    expect(() =>
      selectUtxos({
        ...base,
        utxos: [u(10_000), u(5_000)],
        targetSats: 20_000n,
      })
    ).toThrow(/Insufficient funds/);
  });

  it("excludes unconfirmed UTXOs by default", () => {
    const result = selectUtxos({
      ...base,
      utxos: [u(100_000, false), u(60_000, true)],
      targetSats: 40_000n,
    });
    expect(result.chosen).toHaveLength(1);
    expect(result.chosen[0].value).toBe(60_000);
  });

  it("includes unconfirmed UTXOs when the caller opts in", () => {
    const result = selectUtxos({
      ...base,
      utxos: [u(100_000, false), u(60_000, true)],
      targetSats: 40_000n,
      includeUnconfirmed: true,
    });
    expect(result.chosen).toHaveLength(1);
    expect(result.chosen[0].value).toBe(100_000);
  });

  it("throws on an empty UTXO pool", () => {
    expect(() =>
      selectUtxos({ ...base, utxos: [], targetSats: 1000n })
    ).toThrow(/No spendable UTXOs/);
  });
});

describe("Bitcoin address script-type detection", () => {
  it("identifies each supported mainnet script type by prefix", () => {
    expect(detectScriptType("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe("p2pkh");
    expect(detectScriptType("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe("p2sh");
    expect(detectScriptType("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe("p2wpkh");
    expect(
      detectScriptType(
        "bc1pxwww0ct9ue7e8tdnlmug5m2tamfn7q06sahstg39ys4c9f3340qqxrdu9k"
      )
    ).toBe("p2tr");
    // P2WSH: 62 chars total, starts with "bc1q".
    expect(
      detectScriptType(
        "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"
      )
    ).toBe("p2wsh");
  });
});

describe("prepareBitcoinSendInput schema validation", () => {
  it("accepts a well-formed request with a named fee tier", () => {
    expect(() =>
      prepareBitcoinSendInput.parse({
        from: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        to: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        amountSats: "50000",
        feeRate: "halfhour",
      })
    ).not.toThrow();
  });

  it("accepts a numeric sat/vB fee rate", () => {
    expect(() =>
      prepareBitcoinSendInput.parse({
        from: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        to: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        amountSats: "50000",
        feeRate: 25,
      })
    ).not.toThrow();
  });

  it("rejects a non-integer amountSats (prevents float precision bugs for large values)", () => {
    expect(() =>
      prepareBitcoinSendInput.parse({
        from: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        to: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        amountSats: "50000.5",
      })
    ).toThrow();
  });
});

describe("prepareBitcoinSend end-to-end (fetch mocked)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("fetches UTXOs + fee recs, selects inputs, and returns a coherent plan", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/fees/recommended")) {
        return new Response(
          JSON.stringify({
            fastestFee: 50,
            halfHourFee: 30,
            hourFee: 15,
            economyFee: 8,
            minimumFee: 1,
          }),
          { status: 200 }
        );
      }
      if (url.includes("/address/") && url.endsWith("/utxo")) {
        return new Response(
          JSON.stringify([
            {
              txid: "a".repeat(64),
              vout: 0,
              value: 500_000,
              status: { confirmed: true, block_height: 800_000 },
            },
            {
              txid: "b".repeat(64),
              vout: 1,
              value: 200_000,
              status: { confirmed: true, block_height: 800_001 },
            },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { prepareBitcoinSend } = await import("../src/modules/bitcoin/send.js");
    const plan = await prepareBitcoinSend({
      from: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      to: "bc1pxwww0ct9ue7e8tdnlmug5m2tamfn7q06sahstg39ys4c9f3340qqxrdu9k",
      amountSats: "100000",
    });

    expect(plan.chain).toBe("bitcoin");
    expect(plan.sourceScriptType).toBe("p2wpkh");
    expect(plan.inputs).toHaveLength(1);
    expect(plan.inputs[0].txid).toBe("a".repeat(64));
    expect(plan.inputs[0].valueSats).toBe("500000");
    // Recipient first, then change.
    expect(plan.outputs[0].role).toBe("recipient");
    expect(plan.outputs[0].valueSats).toBe("100000");
    expect(plan.outputs[1]?.role).toBe("change");
    // Fee rate defaulted to "hour" (15 sat/vB).
    expect(plan.fee.rateSatVb).toBe(15);
    expect(plan.fee.rateSource).toMatch(/hour/);
    // Recipient is P2TR (43 vB output), source is P2WPKH (68 vB input, 31 vB change).
    // vsize with change = 11 + 68 + 43 + 31 = 153
    expect(plan.fee.vsize).toBe(153);
    expect(plan.fee.sats).toBe("2295"); // 153 * 15
    // change = 500_000 − 100_000 − 2295
    expect(plan.outputs[1]?.valueSats).toBe("397705");
    expect(plan.description).toContain("Send");
    expect(plan.description).toContain("2295 sats");
  });

  it("rejects a zero amount", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { prepareBitcoinSend } = await import("../src/modules/bitcoin/send.js");
    await expect(
      prepareBitcoinSend({
        from: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        to: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        amountSats: "0",
      })
    ).rejects.toThrow(/positive integer/);
  });

  it("errors cleanly when the source address has no UTXOs", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/fees/recommended")) {
        return new Response(
          JSON.stringify({
            fastestFee: 50,
            halfHourFee: 30,
            hourFee: 15,
            economyFee: 8,
            minimumFee: 1,
          }),
          { status: 200 }
        );
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { prepareBitcoinSend } = await import("../src/modules/bitcoin/send.js");
    await expect(
      prepareBitcoinSend({
        from: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        to: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        amountSats: "1000",
      })
    ).rejects.toThrow(/no UTXOs/);
  });
});

describe("broadcastBitcoinTx", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the signed hex and returns the txid returned by mempool.space", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/mempool\.space\/api\/tx$/);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("deadbeefcafe");
      return new Response(
        "b5f4e6a3c2d1f0e9c8b7a6d5e4f3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5",
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { broadcastBitcoinTx } = await import("../src/modules/bitcoin/send.js");
    const out = await broadcastBitcoinTx({ hex: "deadbeefcafe" });
    expect(out.chain).toBe("bitcoin");
    expect(out.txid).toBe(
      "b5f4e6a3c2d1f0e9c8b7a6d5e4f3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5"
    );
  });

  it("surfaces mempool.space's rejection message on a non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("sendrawtransaction RPC error: bad-txns-inputs-missingorspent", {
        status: 400,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { broadcastBitcoinTx } = await import("../src/modules/bitcoin/send.js");
    await expect(broadcastBitcoinTx({ hex: "ff" })).rejects.toThrow(
      /Broadcast failed \(400\).*missingorspent/
    );
  });
});
