import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { bitcoinAddressSchema } from "../bitcoin/schemas.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

/**
 * Raw shape — MCP requires a bare ZodObject (no .refine) so it can expose `.shape`
 * to build the JSON schema. Cross-field validation is enforced in the handler.
 *
 * Bitcoin addresses live in a separate field because they aren't EVM and don't
 * belong in `wallets` — the address format, balance source, and tool coverage
 * are all distinct.
 */
export const getPortfolioSummaryInput = z.object({
  /** Single wallet — kept for backward compatibility. Use `wallets` for multi-wallet reports. */
  wallet: walletSchema.optional(),
  wallets: z.array(walletSchema).min(1).optional(),
  chains: z.array(chainEnum).optional(),
  /** Optional Bitcoin mainnet addresses — added to the total USD and surfaced in a `bitcoin` section. */
  bitcoinAddresses: z.array(bitcoinAddressSchema).max(20).optional(),
});

export type GetPortfolioSummaryArgs = z.infer<typeof getPortfolioSummaryInput>;
