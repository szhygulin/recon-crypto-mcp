/**
 * Tests for the enriched revert decoder used by simulate_transaction.
 * The decoder must:
 *   - Decode well-known custom errors (Comet Paused(), OZ ERC-20, Morpho) from raw revert bytes.
 *   - Surface a specific hint for Paused() so the agent knows which pause flag to inspect.
 *   - Fall back to 4byte.directory for unknown selectors.
 *   - Extract plain-string reasons ("reverted with reason: …") from Aave-style numeric codes.
 *   - Degrade gracefully to viem's shortMessage when nothing decodes.
 */
import { describe, it, expect } from "vitest";
import { BaseError, encodeErrorResult, parseAbiItem, type AbiItem } from "viem";
import { enrichRevertReason } from "../src/modules/simulation/revert-decode.js";

function errWithData(data: `0x${string}`): BaseError {
  const err = new BaseError("Execution reverted");
  // Viem's own error classes attach the revert data on the cause; mimic that
  // shape so the extractor's walk(...) finds it.
  (err as unknown as { data?: string }).data = data;
  return err;
}

describe("enrichRevertReason", () => {
  it("decodes Comet Paused() from raw revert bytes and attaches the pause-flag hint", async () => {
    const data = encodeErrorResult({
      abi: [parseAbiItem("error Paused()")] as AbiItem[],
    });
    const result = await enrichRevertReason(errWithData(data));
    expect(result.source).toBe("local-abi");
    expect(result.errorName).toBe("Paused");
    expect(result.hint).toMatch(/isWithdrawPaused/);
    expect(result.message).toMatch(/Paused\(\)/);
    expect(result.message).toMatch(/isWithdrawPaused/);
  });

  it("decodes OZ ERC-20 InsufficientBalance with positional args", async () => {
    const data = encodeErrorResult({
      abi: [
        parseAbiItem(
          "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"
        ),
      ] as AbiItem[],
      args: ["0x000000000000000000000000000000000000dEaD", 5n, 100n],
    });
    const result = await enrichRevertReason(errWithData(data));
    expect(result.source).toBe("local-abi");
    expect(result.errorName).toBe("ERC20InsufficientBalance");
    expect(result.args).toEqual([
      "0x000000000000000000000000000000000000dEaD",
      "5",
      "100",
    ]);
  });

  it("falls back to 4byte.directory when the selector is unknown locally", async () => {
    // A fabricated selector that the local registry does not cover.
    const unknownSelector = "0xdeadbeef";
    const data = (unknownSelector + "00".repeat(32)) as `0x${string}`;
    const result = await enrichRevertReason(errWithData(data), async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ text_signature: "SomeObscureError(uint256)" }],
      }),
    }));
    expect(result.source).toBe("4byte");
    expect(result.errorName).toBe("SomeObscureError");
    expect(result.message).toMatch(/SomeObscureError/);
    expect(result.message).toMatch(/0xdeadbeef/);
  });

  it("surfaces a plain-string revert reason when no raw data is available", async () => {
    const err = new BaseError("Execution reverted");
    err.shortMessage = "Execution reverted with reason: 23";
    const result = await enrichRevertReason(err);
    expect(result.source).toBe("string-reason");
    expect(result.message).toBe("reverted with reason: 23");
  });

  it("degrades to viem shortMessage when nothing else is decodable", async () => {
    const err = new BaseError("Execution reverted");
    err.shortMessage = "rpc node choked";
    const result = await enrichRevertReason(err);
    expect(result.source).toBe("unknown");
    expect(result.message).toBe("rpc node choked");
  });
});
