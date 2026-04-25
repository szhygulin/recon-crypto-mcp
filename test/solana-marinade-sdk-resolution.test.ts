import { describe, it, expect } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Marinade,
  MarinadeConfig,
} from "@marinade.finance/marinade-ts-sdk";

/**
 * Regression guard for the marinade-ts-sdk ↔ @coral-xyz/anchor version
 * coupling. The SDK pins `^0.28.0`, but our top-level dep tree needs
 * `^0.30.x` for marginfi/swb-crank — without a scoped npm `overrides`
 * entry, the marinade subtree resolves the wrong anchor and the
 * `Program` constructor crashes with
 * `Cannot read properties of undefined (reading '_bn')` because
 * anchor 0.30 reads the program id from `idl.address` (absent in the
 * SDK's pre-0.30 IDL).
 *
 * Unlike the other marinade tests (which mock the SDK to keep the
 * unit suite hermetic), this test deliberately imports the REAL SDK
 * to exercise the version-resolution invariant. Synchronous, no RPC.
 */
describe("marinade-ts-sdk anchor resolution", () => {
  it("instantiates the real Marinade Program without the `_bn` crash", () => {
    const connection = new Connection(
      "https://example.invalid",
      "confirmed",
    );
    const config = new MarinadeConfig({
      connection,
      publicKey: new PublicKey("11111111111111111111111111111111"),
    });
    const marinade = new Marinade(config);

    // Triggers MarinadeState's `program` getter →
    // `new Program(idl, programId, provider)`. Crashes synchronously
    // if the marinade subtree resolves anchor 0.30+.
    const program = marinade.marinadeFinanceProgram.program;
    expect(program.programId.toBase58()).toBe(
      "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
    );
  });
});
