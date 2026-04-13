import { z } from "zod";

/**
 * Mainnet-only. Covers:
 *   - P2PKH (legacy, starts with "1")
 *   - P2SH (starts with "3")
 *   - P2WPKH / P2WSH (bech32, starts with "bc1q" / "bc1Q")
 *   - P2TR (taproot, bech32m, starts with "bc1p")
 *
 * Testnet ("tb1…") and regtest are intentionally excluded — this is a portfolio tool.
 */
const BITCOIN_ADDRESS_REGEX =
  /^(bc1[a-zA-HJ-NP-Z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

export const bitcoinAddressSchema = z
  .string()
  .regex(BITCOIN_ADDRESS_REGEX, "Not a valid Bitcoin mainnet address");

export const getBitcoinBalanceInput = z.object({
  address: bitcoinAddressSchema,
});

export const getBitcoinPortfolioInput = z.object({
  addresses: z.array(bitcoinAddressSchema).min(1).max(20),
});

export type GetBitcoinBalanceArgs = z.infer<typeof getBitcoinBalanceInput>;
export type GetBitcoinPortfolioArgs = z.infer<typeof getBitcoinPortfolioInput>;

/**
 * Fee rate hint. Either a specific sat/vB number, or a named tier that maps to
 * mempool.space's recommended-fees endpoint. Default is "hour" (conservative).
 */
const feeRateSchema = z.union([
  z.literal("fastest"),
  z.literal("halfhour"),
  z.literal("hour"),
  z.literal("economy"),
  z.literal("minimum"),
  z.number().positive().max(1000),
]);

export const prepareBitcoinSendInput = z.object({
  from: bitcoinAddressSchema,
  to: bitcoinAddressSchema,
  /** Amount to send to the recipient, in satoshis. Use a string to avoid JS precision issues for > 2^53. */
  amountSats: z
    .string()
    .regex(/^\d+$/, "amountSats must be a positive integer string"),
  feeRate: feeRateSchema.optional(),
  /** Include unconfirmed (mempool) UTXOs as spendable. Default false. */
  includeUnconfirmed: z.boolean().optional(),
});

export const broadcastBitcoinTxInput = z.object({
  /** Fully signed raw Bitcoin transaction as lowercase hex (no 0x prefix). */
  hex: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, "hex must contain only hex characters")
    .min(20),
});

export type PrepareBitcoinSendArgs = z.infer<typeof prepareBitcoinSendInput>;
export type BroadcastBitcoinTxArgs = z.infer<typeof broadcastBitcoinTxInput>;
