import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { AccountRole, type Instruction as KitInstruction } from "@solana/kit";
import {
  kitInstructionToLegacy,
  kitInstructionsToLegacy,
} from "../src/modules/solana/kit-bridge.js";

/**
 * kit `Instruction` → web3.js v1 `TransactionInstruction` reverse bridge.
 * Pure type-conversion logic, no RPC, no signing. We hand-construct kit
 * instructions for each role variant and assert the resulting v1 ix has
 * matching `programId` / `keys[].{pubkey, isSigner, isWritable}` / `data`.
 *
 * No live SDK call here — that's covered by the Kamino market loader test
 * (which hits a mocked Rpc).
 */

const ADDR1 = Keypair.generate().publicKey.toBase58();
const ADDR2 = Keypair.generate().publicKey.toBase58();
const ADDR3 = Keypair.generate().publicKey.toBase58();
const PROGRAM = Keypair.generate().publicKey.toBase58();

describe("kitInstructionToLegacy", () => {
  it("decodes all four AccountRole variants", () => {
    const ix: KitInstruction = {
      programAddress: PROGRAM as `${string}`,
      accounts: [
        { address: ADDR1 as `${string}`, role: AccountRole.READONLY },
        { address: ADDR2 as `${string}`, role: AccountRole.WRITABLE },
        { address: ADDR3 as `${string}`, role: AccountRole.READONLY_SIGNER },
        { address: ADDR1 as `${string}`, role: AccountRole.WRITABLE_SIGNER },
      ],
      data: new Uint8Array([0x01, 0x02, 0x03]),
    };
    const out = kitInstructionToLegacy(ix);
    expect(out.programId.toBase58()).toBe(PROGRAM);
    expect(out.keys).toHaveLength(4);
    expect(out.keys[0]).toMatchObject({ isSigner: false, isWritable: false });
    expect(out.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect(out.keys[2]).toMatchObject({ isSigner: true, isWritable: false });
    expect(out.keys[3]).toMatchObject({ isSigner: true, isWritable: true });
    expect(out.keys[0].pubkey.toBase58()).toBe(ADDR1);
    expect(out.keys[1].pubkey.toBase58()).toBe(ADDR2);
    expect(out.keys[2].pubkey.toBase58()).toBe(ADDR3);
    expect(out.keys[3].pubkey.toBase58()).toBe(ADDR1);
    expect(out.data.toString("hex")).toBe("010203");
  });

  it("handles missing accounts (no-account ix) and missing data (zero-byte data)", () => {
    const ix: KitInstruction = {
      programAddress: PROGRAM as `${string}`,
    };
    const out = kitInstructionToLegacy(ix);
    expect(out.programId.toBase58()).toBe(PROGRAM);
    expect(out.keys).toHaveLength(0);
    expect(out.data.length).toBe(0);
  });

  it("throws a clear error when an AccountLookupMeta is encountered", () => {
    const ix = {
      programAddress: PROGRAM as `${string}`,
      accounts: [
        {
          address: ADDR1 as `${string}`,
          role: AccountRole.READONLY,
          addressIndex: 0,
          lookupTableAddress: ADDR2 as `${string}`,
        },
      ],
      data: new Uint8Array([0xff]),
    } as unknown as KitInstruction;
    expect(() => kitInstructionToLegacy(ix)).toThrow(
      /AccountLookupMeta encountered/,
    );
  });

  it("preserves data bytes verbatim (Uint8Array → Buffer round-trip)", () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const ix: KitInstruction = {
      programAddress: PROGRAM as `${string}`,
      data,
    };
    const out = kitInstructionToLegacy(ix);
    expect(Array.from(out.data)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
  });
});

describe("kitInstructionsToLegacy", () => {
  it("converts an array of ixs in order, preserving relative position", () => {
    const ixs: KitInstruction[] = [
      {
        programAddress: PROGRAM as `${string}`,
        accounts: [{ address: ADDR1 as `${string}`, role: AccountRole.READONLY }],
        data: new Uint8Array([0x01]),
      },
      {
        programAddress: PROGRAM as `${string}`,
        accounts: [{ address: ADDR2 as `${string}`, role: AccountRole.WRITABLE_SIGNER }],
        data: new Uint8Array([0x02]),
      },
    ];
    const out = kitInstructionsToLegacy(ixs);
    expect(out).toHaveLength(2);
    expect(out[0].data.toString("hex")).toBe("01");
    expect(out[1].data.toString("hex")).toBe("02");
    expect(out[0].keys[0].isSigner).toBe(false);
    expect(out[1].keys[0].isSigner).toBe(true);
    expect(out[1].keys[0].isWritable).toBe(true);
  });
});
