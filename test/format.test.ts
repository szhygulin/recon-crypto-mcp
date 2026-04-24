import { describe, it, expect } from "vitest";
import {
  formatUnits,
  formatUnitsFromDecimalString,
  round,
} from "../src/data/format.js";

describe("formatUnits(bigint, decimals)", () => {
  it("returns the bigint as-is when decimals is 0", () => {
    expect(formatUnits(0n, 0)).toBe("0");
    expect(formatUnits(42n, 0)).toBe("42");
    expect(formatUnits(-7n, 0)).toBe("-7");
  });

  it("formats sub-unit amounts with leading-zero fraction", () => {
    // 1 wei at 18 decimals = 0.000000000000000001
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    // 1 lamport at 9 decimals = 0.000000001
    expect(formatUnits(1n, 9)).toBe("0.000000001");
    // 1 sun at 6 decimals = 0.000001
    expect(formatUnits(1n, 6)).toBe("0.000001");
  });

  it("trims trailing zeros in the fractional part", () => {
    // 1 SOL = 1_000_000_000 lamports at 9 decimals → "1", not "1.000000000"
    expect(formatUnits(1_000_000_000n, 9)).toBe("1");
    // 1.5 SOL = 1_500_000_000 lamports → "1.5", not "1.500000000"
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    // 1.25 USDC = 1_250_000 at 6 decimals → "1.25"
    expect(formatUnits(1_250_000n, 6)).toBe("1.25");
  });

  it("handles whole-number amounts at EVM 18-decimal scale", () => {
    expect(formatUnits(10n ** 18n, 18)).toBe("1");
    expect(formatUnits(5n * 10n ** 18n, 18)).toBe("5");
    // 0.5 ETH = 5e17 wei
    expect(formatUnits(5n * 10n ** 17n, 18)).toBe("0.5");
  });

  it("preserves sign for negative amounts (balance deltas)", () => {
    expect(formatUnits(-1_000_000_000n, 9)).toBe("-1");
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
    expect(formatUnits(-1n, 18)).toBe("-0.000000000000000001");
  });

  it("handles zero at any decimal scale", () => {
    expect(formatUnits(0n, 1)).toBe("0");
    expect(formatUnits(0n, 18)).toBe("0");
  });

  it("handles amounts larger than the decimal scale cleanly", () => {
    // 123.456 at 3 decimals = 123456
    expect(formatUnits(123_456n, 3)).toBe("123.456");
    // 1_000_000 USDC = 1_000_000_000_000 at 6 decimals
    expect(formatUnits(1_000_000_000_000n, 6)).toBe("1000000");
  });
});

describe("formatUnitsFromDecimalString(raw, decimals)", () => {
  it("delegates to formatUnits after BigInt parsing when raw is pure digits", () => {
    expect(formatUnitsFromDecimalString("1000000000", 9)).toBe("1");
    expect(formatUnitsFromDecimalString("1500000000", 9)).toBe("1.5");
    expect(formatUnitsFromDecimalString("0", 18)).toBe("0");
  });

  it("returns '0' for non-digit input rather than throwing", () => {
    // Explorer APIs occasionally return these shapes — history modules
    // relied on the fallback instead of crashing.
    expect(formatUnitsFromDecimalString("", 18)).toBe("0");
    expect(formatUnitsFromDecimalString("0x1234", 18)).toBe("0");
    expect(formatUnitsFromDecimalString("not-a-number", 18)).toBe("0");
    expect(formatUnitsFromDecimalString("-123", 18)).toBe("0"); // leading minus not a pure digit run
    expect(formatUnitsFromDecimalString("1.5", 18)).toBe("0"); // dot not a digit
  });

  it("handles a wide range of amounts at realistic decimal scales", () => {
    // 1 ETH (18 decimals) from an Etherscan value string
    expect(formatUnitsFromDecimalString("1000000000000000000", 18)).toBe("1");
    // 1 TRX (6 decimals) from TronGrid
    expect(formatUnitsFromDecimalString("1000000", 6)).toBe("1");
  });
});

describe("round", () => {
  it("rounds to the specified decimal places and drops trailing zeros", () => {
    expect(round(1.23456789, 2)).toBe(1.23);
    expect(round(1.23456789, 4)).toBe(1.2346);
    expect(round(1.5, 0)).toBe(2);
  });

  it("defaults to 6 places", () => {
    expect(round(1.23456789)).toBe(1.234568);
  });
});
