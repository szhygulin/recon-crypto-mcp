import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
]);

const baseSwapSchema = z.object({
  wallet: walletSchema,
  fromChain: chainEnum,
  toChain: chainEnum,
  fromToken: tokenSchema,
  toToken: tokenSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount of fromToken, NOT raw wei/base units. ' +
        'Example: "1.5" for 1.5 USDC, "0.01" for 0.01 ETH. The tool resolves ' +
        'decimals on-chain and converts internally.'
    ),
  fromTokenDecimals: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe(
      "Optional decimals hint for fromToken if on-chain lookup fails (rare). Native is 18."
    ),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%, 100 = 1%). Default ~50. " +
        "Hard-capped at 500 (5%) — anything higher is almost always a sandwich-bait " +
        "misconfiguration. If a legitimate thin-liquidity route genuinely needs >1%, " +
        "also pass `acknowledgeHighSlippage: true`."
    ),
  acknowledgeHighSlippage: z
    .boolean()
    .optional()
    .describe(
      "Opt-in flag required when slippageBps > 100 (1%). Forces the caller to state " +
        "that an unusually-high slippage is intentional — the default rejects the tx " +
        "to protect the user from MEV sandwich attacks."
    ),
});

export const getSwapQuoteInput = baseSwapSchema;
export const prepareSwapInput = baseSwapSchema;

export type GetSwapQuoteArgs = z.infer<typeof getSwapQuoteInput>;
export type PrepareSwapArgs = z.infer<typeof prepareSwapInput>;
