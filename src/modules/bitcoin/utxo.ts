/**
 * Pure UTXO-selection logic, independent of any network I/O. Kept here so the
 * coin-selection algorithm can be unit-tested without mocking the HTTP client.
 *
 * Strategy: greedy largest-first. This minimizes the number of inputs in the
 * resulting transaction, which directly minimizes its vsize and therefore its
 * fee at any given feerate. More sophisticated strategies (Branch-and-Bound,
 * knapsack) can reduce change-output waste but not base fee — the user asked
 * for fee minimization, so largest-first is the right baseline.
 *
 * Dust handling: if the change amount is below the dust threshold, we absorb
 * change into fee rather than create an uneconomical output (which would cost
 * more to later spend than it's worth). That slightly over-pays miners — the
 * tradeoff is a smaller, valid transaction vs a spammy dust output.
 */

export interface Utxo {
  txid: string;
  vout: number;
  /** Output value in satoshis. */
  value: number;
  confirmed: boolean;
}

export interface SelectionInput {
  utxos: Utxo[];
  /** Amount the recipient should receive, in satoshis. */
  targetSats: bigint;
  /** Fee rate in sat/vB. */
  feeRateSatVb: number;
  /** vsize cost of each input (depends on script type of the source address). */
  inputVbytes: number;
  /** vsize cost of the recipient output. */
  outputVbytesRecipient: number;
  /** vsize cost of the change output (if any). */
  outputVbytesChange: number;
  /** Fixed overhead: version, locktime, witness marker/flag, input/output counts. */
  overheadVbytes: number;
  /** Outputs below this value are absorbed into fee instead of created. */
  dustSats: number;
  /** If true, include unconfirmed (mempool) UTXOs as spendable. */
  includeUnconfirmed?: boolean;
}

export interface SelectionResult {
  chosen: Utxo[];
  totalInSats: bigint;
  /** Fee that will actually be paid (totalIn − target − change). */
  feeSats: bigint;
  /** Change amount in sats (0 if absorbed). */
  changeSats: bigint;
  /** Estimated vsize of the final transaction. */
  vbytes: number;
  /** Effective fee rate actually paid (may exceed feeRateSatVb when change is absorbed). */
  effectiveFeeRateSatVb: number;
}

export function selectUtxos(input: SelectionInput): SelectionResult {
  const pool = input.utxos
    .filter((u) => input.includeUnconfirmed || u.confirmed)
    // Largest-first — fewest inputs for a given target.
    .slice()
    .sort((a, b) => b.value - a.value);

  if (pool.length === 0) {
    throw new Error("No spendable UTXOs available.");
  }

  const chosen: Utxo[] = [];
  let totalIn = 0n;

  for (const u of pool) {
    chosen.push(u);
    totalIn += BigInt(u.value);

    const vbytesWithChange =
      input.overheadVbytes +
      chosen.length * input.inputVbytes +
      input.outputVbytesRecipient +
      input.outputVbytesChange;
    const feeWithChange = BigInt(
      Math.ceil(vbytesWithChange * input.feeRateSatVb)
    );

    if (totalIn >= input.targetSats + feeWithChange) {
      const change = totalIn - input.targetSats - feeWithChange;
      if (change < BigInt(input.dustSats)) {
        // Absorb change into fee — drop the change output entirely.
        const vbytesNoChange =
          input.overheadVbytes +
          chosen.length * input.inputVbytes +
          input.outputVbytesRecipient;
        const actualFee = totalIn - input.targetSats;
        return {
          chosen,
          totalInSats: totalIn,
          feeSats: actualFee,
          changeSats: 0n,
          vbytes: vbytesNoChange,
          effectiveFeeRateSatVb: Number(actualFee) / vbytesNoChange,
        };
      }
      return {
        chosen,
        totalInSats: totalIn,
        feeSats: feeWithChange,
        changeSats: change,
        vbytes: vbytesWithChange,
        effectiveFeeRateSatVb: Number(feeWithChange) / vbytesWithChange,
      };
    }
  }

  throw new Error(
    `Insufficient funds: have ${totalIn} sats across ${chosen.length} UTXOs, need at least ${input.targetSats} + fee.`
  );
}

/**
 * vsize constants by Bitcoin script type. Numbers come from BIP-141/BIP-341
 * worst-case witness sizes; close enough for fee estimation.
 */
export const VBYTES = {
  p2pkh: { input: 148, output: 34 },
  p2sh: { input: 91, output: 32 }, // Assumes P2SH-P2WPKH wrap — the common case.
  p2wpkh: { input: 68, output: 31 },
  p2wsh: { input: 104, output: 43 },
  p2tr: { input: 58, output: 43 },
} as const;

export type BitcoinScriptType = keyof typeof VBYTES;

/** Detect script type from a mainnet address prefix. */
export function detectScriptType(address: string): BitcoinScriptType {
  if (address.startsWith("bc1p")) return "p2tr";
  if (address.startsWith("bc1q")) {
    // P2WPKH is 42 chars total ("bc1q" + 38); P2WSH is 62 chars total ("bc1q" + 58).
    return address.length >= 60 ? "p2wsh" : "p2wpkh";
  }
  if (address.startsWith("3")) return "p2sh";
  if (address.startsWith("1")) return "p2pkh";
  throw new Error(`Cannot detect script type for address: ${address}`);
}

/** Dust threshold per script type (sats). From Bitcoin Core policy. */
export function dustThreshold(scriptType: BitcoinScriptType): number {
  switch (scriptType) {
    case "p2pkh":
      return 546;
    case "p2sh":
      return 540;
    case "p2wpkh":
      return 294;
    case "p2wsh":
      return 330;
    case "p2tr":
      return 330;
  }
}

/**
 * Overhead vbytes for a SegWit-eligible transaction (inputs-from-segwit-address
 * paths). For a pure-legacy spend this is slightly smaller (~10 vB), but
 * overestimating by a couple of bytes just overpays fee by pennies.
 */
export const SEGWIT_OVERHEAD_VBYTES = 11;
export const LEGACY_OVERHEAD_VBYTES = 10;
