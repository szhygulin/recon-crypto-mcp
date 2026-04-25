import {
  PublicKey,
  TransactionInstruction,
  type AccountMeta as Web3AccountMeta,
} from "@solana/web3.js";
import { AccountRole, type Instruction as KitInstruction } from "@solana/kit";

/**
 * Reverse direction of `@solana/compat` (which only goes
 * web3.js v1 → kit). Used to splice kit-shaped SDK output (Kamino's
 * `KaminoAction.actionToIxs(...)` returns `Array<Instruction>` from
 * `@solana/instructions`) into our web3.js v1 signing pipeline. We keep the
 * v1 pipeline because every other Solana flow in this server (nonce,
 * Marinade, MarginFi, Jupiter, native stake) builds web3.js v1
 * `TransactionInstruction[]` and pins through `MessageV0.compile`.
 *
 * AccountRole encoding (from `@solana/instructions/roles.d.ts`):
 *
 *   READONLY        = 0  → isSigner: false, isWritable: false
 *   WRITABLE        = 1  → isSigner: false, isWritable: true
 *   READONLY_SIGNER = 2  → isSigner: true,  isWritable: false
 *   WRITABLE_SIGNER = 3  → isSigner: true,  isWritable: true
 *
 * So: `isSigner = role >= 2`, `isWritable = (role & 1) === 1`.
 *
 * `AccountLookupMeta` (per-account ALT references) is REJECTED here. The
 * web3.js v1 `TransactionInstruction.keys` shape doesn't carry per-account
 * lookup metadata — ALT resolution happens at `MessageV0.compile` time
 * against the `addressLookupTableAccounts` argument. Kamino's
 * `actionToIxs(...)` returns all-static accounts (per scope-probe of
 * `src/classes/action.ts` — only setupIxs / lendingIxs / cleanupIxs are
 * appended, none synthesize an `AccountLookupMeta`), so this is dead code
 * unless we adopt an SDK that pre-resolves lookups.
 */
export function kitInstructionToLegacy(
  ix: KitInstruction,
): TransactionInstruction {
  const accounts = ix.accounts ?? [];
  const keys: Web3AccountMeta[] = accounts.map((acct) => {
    if ("addressIndex" in acct) {
      throw new Error(
        `kitInstructionToLegacy: AccountLookupMeta encountered for ix ` +
          `${ix.programAddress} account ${acct.address}. The web3.js v1 ` +
          `TransactionInstruction shape doesn't carry per-account lookup ` +
          `metadata; ALT resolution belongs at MessageV0.compile time. The ` +
          `Kamino SDK paths we wrap shouldn't emit this — confirm the call ` +
          `site or upgrade the bridge.`,
      );
    }
    return {
      pubkey: new PublicKey(acct.address),
      isSigner: acct.role >= AccountRole.READONLY_SIGNER,
      isWritable: (acct.role & 1) === 1,
    };
  });
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys,
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

export function kitInstructionsToLegacy(
  ixs: readonly KitInstruction[],
): TransactionInstruction[] {
  return ixs.map(kitInstructionToLegacy);
}
