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
