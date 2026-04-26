import { z } from "zod";
import { ALL_CHAINS } from "../../types/index.js";

const assetEnum = z.enum(["USDC", "USDT", "ETH", "SOL", "BTC", "stables"]);

export const compareYieldsInput = z.object({
  asset: assetEnum.describe(
    "Asset to compare supply yields for. 'stables' is a meta-asset that expands to USDC + USDT (the two stables every adapter knows). 'ETH' resolves to WETH on EVM lending markets (the wrapped form). 'BTC' resolves to WBTC on EVM. 'SOL' is native on Solana protocols.",
  ),
  chains: z
    .array(z.enum(ALL_CHAINS as unknown as [string, ...string[]]))
    .optional()
    .describe(
      "Restrict to specific chains. Default: all integrated EVM chains + Solana. BTC / LTC have no integrated lending so they return empty — pass them only if you specifically want to confirm the empty result.",
    ),
  minTvlUsd: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Minimum supply-side TVL in USD; rows below the bar are filtered. Rows where TVL is unknown (the upstream didn't expose it) are NOT filtered — surfaced honestly with `tvl: null` so the agent can flag the gap.",
    ),
  riskCeiling: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Minimum protocol risk score (0-100; higher = safer per `get_protocol_risk_score`). Despite the name 'ceiling', the comparison is `score >= ceiling` — only show protocols at LEAST this safe. Rows where the score is unknown are NOT filtered (no data ≠ failed the bar).",
    ),
});

export type CompareYieldsArgs = z.infer<typeof compareYieldsInput>;
